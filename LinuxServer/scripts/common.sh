#!/usr/bin/env bash
# common.sh —— Linux 交付包公共函数库 (install/start/stop/verify/uninstall 共用)
#
# 契约 (所有脚本都必须遵守):
#   1. 任何未处理的失败都以非 0 退出码结束 —— 上层脚本 / CI 据此判断成败。
#   2. 所有路径都从脚本自身位置推导, 不依赖调用者的 cwd (可以在任意目录下调用)。
#   3. 幂等: 重复执行 install / start / stop 不产生副作用, 也不报错。
#   4. 任何删除类操作都必须先过 assert_safe_install_root 守卫 (见下)。
#
# R161 (2026-10-25) —— 参照 Windows 版 R160 审计的教训重写:
#   · uninstall 的"盘根删除守卫"必须是**活代码**: 危险输入必须真的被拒绝,
#     写完用 scripts/tests/test-guard.sh 实跑一遍 (不能只写不测)。
#     Windows 版的同款守卫是死代码, 跑起来会把整盘删光。
#   · 停止服务要真杀进程: pm2 stop 之后还要确认 PID 真的没了;
#     崩溃循环留下的僵尸进程必须 kill 掉, 不能只从 pm2 名单里摘掉。
#   · 判断"启动成功"不能只看 pm2 status 字段。R160 在 NSSM 上栽过:
#     AppExit Default Restart 让 Status='Running' 对秒崩进程结构性失明。
#     这里改成: 启动后等 N 秒, 看 PID 是否还是同一个 + 累计重启次数是否暴涨。

# ---------------------------------------------------------------------------
# 路径推导 (不依赖 cwd)
# ---------------------------------------------------------------------------
# shellcheck disable=SC2034
COMMON_SH_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC2034
INSTALL_ROOT="$(cd -- "$COMMON_SH_DIR/.." && pwd -P)"
# shellcheck disable=SC2034
CENTER_DIR="$INSTALL_ROOT/center"
# shellcheck disable=SC2034
APP_NAME="${PM2_APP_NAME:-ADDashboardCenter}"
# shellcheck disable=SC2034
PM2_BIN="${PM2_BIN:-pm2}"
# shellcheck disable=SC2034
DEFAULT_PORT="${AD_PORT:-8080}"

export AD_APP_NAME="$APP_NAME"

# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
    C_BLU=$'\033[34m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
    C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BLD=''; C_RST=''
fi

log()  { printf '%s\n' "$*"; }
info() { printf '%s[INFO]%s %s\n' "$C_BLU" "$C_RST" "$*"; }
ok()   { printf '%s[ OK ]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_YEL" "$C_RST" "$*" >&2; }
err()  { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RST" "$*" >&2; }
die()  { err "$*"; exit 1; }

hr() { printf '%s\n' "------------------------------------------------------------"; }

# ---------------------------------------------------------------------------
# 基础检查
# ---------------------------------------------------------------------------
require_cmd() {
    local cmd="$1" hint="${2:-}"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        if [ -n "$hint" ]; then
            die "找不到命令 '$cmd' —— $hint"
        fi
        die "找不到命令 '$cmd'"
    fi
}

# Node 版本硬门槛 22 (ldapts 的 engines.node >= 22; Node 20 装不上/跑不起来)
require_node() {
    require_cmd node "Node.js 22+ 是硬依赖 (ldapts 声明 engines.node >= 22)"
    local version major
    version="$(node -p 'process.versions.node' 2>/dev/null || printf '0')"
    major="${version%%.*}"
    case "$major" in
        ''|*[!0-9]*) die "无法解析 Node 版本: '$version'" ;;
    esac
    if [ "$major" -lt 22 ]; then
        die "Node.js 版本过低: $version —— 需要 22 或更高 (装依赖前先换版本, 否则 ldapts 装不上)"
    fi
    ok "Node.js $version"
}

pm2_available() {
    command -v "$PM2_BIN" >/dev/null 2>&1
}

require_pm2() {
    pm2_available || die "找不到 PM2 ($PM2_BIN) —— 装: npm install -g pm2 (或用 PM2_BIN=/path/to/pm2 指定路径)"
}

# ---------------------------------------------------------------------------
# PM2 状态读取
#
# pm2 jlist 吐的是 JSON 数组, 每项形如:
#   { name, pid, pm2_env: { status, restart_time, pm_uptime, exit_code, ... } }
# 统一在这里解析, 别处只消费 pm2_field 的结果。
# ---------------------------------------------------------------------------
pm2_app_json() {
    pm2_available || return 0
    "$PM2_BIN" jlist 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
    let list = [];
    try { list = JSON.parse(raw); } catch (e) { process.exit(0); }
    if (!Array.isArray(list)) process.exit(0);
    const wanted = process.env.AD_APP_NAME;
    const app = list.find((a) => a && a.name === wanted);
    if (app) process.stdout.write(JSON.stringify(app));
});
' 2>/dev/null || true
}

# 读 pm2 jlist 里的一个字段, 支持点号路径 (pm2_env.status / pm2_env.restart_time)
pm2_field() {
    local json="$1" path="$2"
    [ -n "$json" ] || return 0
    printf '%s' "$json" | AD_FIELD="$path" node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
    let value;
    try {
        value = JSON.parse(raw);
    } catch (e) { return; }
    for (const key of String(process.env.AD_FIELD).split(".")) {
        if (value === undefined || value === null) return;
        value = value[key];
    }
    if (value === undefined || value === null) return;
    process.stdout.write(String(value));
});
' 2>/dev/null || true
}

pm2_app_status()    { pm2_field "$1" 'pm2_env.status'; }
pm2_app_pid()       { pm2_field "$1" 'pid'; }
pm2_app_restarts()  { pm2_field "$1" 'pm2_env.restart_time'; }
pm2_app_uptime_ms() { pm2_field "$1" 'pm2_env.pm_uptime'; }
pm2_app_exit_code() { pm2_field "$1" 'pm2_env.exit_code'; }

# 进程是否真的活着 (PID 存在 + /proc/<pid> 存在)。比只看 pm2 状态可靠。
pid_alive() {
    local pid="$1"
    [ -n "$pid" ] || return 1
    [ "$pid" -gt 0 ] 2>/dev/null || return 1
    [ -d "/proc/$pid" ] && return 0
    kill -0 "$pid" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 端口
# ---------------------------------------------------------------------------
# 实际端口优先取 center/appsettings.json 的 listenPort (初始化向导写的),
# 取不到再退回 8080。
resolve_port() {
    local cfg="$CENTER_DIR/appsettings.json"
    if [ -f "$cfg" ] && command -v node >/dev/null 2>&1; then
        local port
        port="$(node -e '
try {
    const cfg = require(process.argv[1]);
    const value = Number(cfg.listenPort);
    if (Number.isFinite(value) && value > 0 && value < 65536) process.stdout.write(String(value));
} catch (e) { }
' "$cfg" 2>/dev/null || true)"
        if [ -n "$port" ]; then
            printf '%s' "$port"
            return 0
        fi
    fi
    printf '%s' "$DEFAULT_PORT"
}

port_listening() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" { found = 1 } END { exit(found ? 0 : 1) }' && return 0
        return 1
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" { found = 1 } END { exit(found ? 0 : 1) }' && return 0
        return 1
    fi
    # 两者都没有: 用 node 试着连一下
    node -e '
const net = require("node:net");
const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
socket.setTimeout(2000);
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("error", () => process.exit(1));
socket.on("timeout", () => { socket.destroy(); process.exit(1); });
' "$port" 2>/dev/null || return 1
}

http_status() {
    local url="$1" code=""
    if command -v curl >/dev/null 2>&1; then
        # curl 连不上时也会输出 %{http_code} (000) 但退出码非 0 ——
        # 所以用 `|| true` 吃掉退出码, 只取它打印的内容, 空了再兜底。
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
    elif command -v wget >/dev/null 2>&1; then
        code="$(wget -q -S -O /dev/null --timeout=5 "$url" 2>&1 \
            | awk '/^[[:space:]]*HTTP\//{ code = $2 } END { print (code ? code : "") }')"
    fi
    [ -n "$code" ] || code="000"
    printf '%s' "$code"
}

# ---------------------------------------------------------------------------
# 目录结构检查
# ---------------------------------------------------------------------------
check_tree_layout() {
    local missing=0
    local required=(
        "$INSTALL_ROOT/package.json"
        "$INSTALL_ROOT/package-lock.json"
        "$INSTALL_ROOT/ecosystem.config.cjs"
        "$CENTER_DIR/server.js"
        "$CENTER_DIR/package.json"
        "$INSTALL_ROOT/db/migrations/mysql/1.0.0-baseline.sql"
        "$INSTALL_ROOT/db/migrations/mssql/1.0.0-baseline.sql"
    )
    for item in "${required[@]}"; do
        if [ ! -f "$item" ]; then
            err "缺文件: ${item#"$INSTALL_ROOT"/}"
            missing=$((missing + 1))
        fi
    done
    if [ ! -f "$CENTER_DIR/dist/index.html" ]; then
        err "缺前端产物: center/dist/index.html —— 部署包不完整 (前端产物应随包交付, 服务器不需要 build)"
        missing=$((missing + 1))
    fi
    if [ "$missing" -gt 0 ]; then
        return 1
    fi
    ok "目录结构完整"
    return 0
}

# 运行期需要写权限的目录
writable_dirs() {
    printf '%s\n' \
        "$CENTER_DIR/logs" \
        "$CENTER_DIR/logs/APP" \
        "$CENTER_DIR/logs/FEATURE" \
        "$CENTER_DIR/data/packages" \
        "$CENTER_DIR/data/file-push" \
        "$CENTER_DIR/data/license-requests"
}

ensure_writable_dirs() {
    local dir missing=0
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        if [ ! -d "$dir" ]; then
            mkdir -p "$dir" || { err "建目录失败: $dir"; missing=$((missing + 1)); continue; }
        fi
        if [ ! -w "$dir" ]; then
            err "目录不可写: $dir"
            missing=$((missing + 1))
        fi
    done < <(writable_dirs)
    return "$missing"
}

# ---------------------------------------------------------------------------
# 删除守卫 (uninstall / --purge 必经)
#
# 目标: 让 "rm -rf 一个路径" 这件事**只可能**作用在真正的 ADDashboard 安装根上。
# 四层独立判据, 任何一层不过就拒绝:
#   L1 文件系统根      —— 拒绝 "/"
#   L2 顶层系统目录    —— 拒绝 /root /home /usr /var /etc /opt /srv /www /tmp 等
#   L3 HOME 及其祖先   —— 拒绝 /root、/home/x 的上级目录
#   L4 形状            —— 目标必须含 center/package.json 且 name == @ad-dashboard/center
#
# L4 是最强的一层: 就算 L1-L3 全被绕过, 只要目标不是本产品的安装根, 照样拒绝。
# ---------------------------------------------------------------------------
assert_safe_install_root() {
    local target="${1:-}"
    [ -n "$target" ] || die "install root 不能为空"

    local resolved
    # 目标存在时用 realpath (会解析符号链接, 防止 "链接 -> /" 这类绕过);
    # 目标不存在时用 realpath -m (只做词法归一, 不因路径不存在而失败)。
    if [ -e "$target" ]; then
        resolved="$(realpath -- "$target" 2>/dev/null || realpath -m -- "$target" 2>/dev/null || printf '%s' "$target")"
    else
        resolved="$(realpath -m -- "$target" 2>/dev/null || printf '%s' "$target")"
    fi

    # L1 —— 文件系统根
    if [ "$resolved" = "/" ]; then
        die "拒绝: '/' 是文件系统根"
    fi

    # L2 —— 顶层系统目录
    case "$resolved" in
        /root|/home|/usr|/var|/etc|/opt|/srv|/www|/bin|/sbin|/lib|/lib64|/boot|/dev|/proc|/sys|/tmp|/mnt|/media|/run)
            die "拒绝: '$resolved' 是系统顶层目录"
            ;;
    esac

    # L3 —— HOME 本身 / HOME 的祖先
    local home="${HOME:-}"
    if [ -n "$home" ]; then
        local home_resolved
        home_resolved="$(realpath -m -- "$home" 2>/dev/null || printf '%s' "$home")"
        if [ "$resolved" = "$home_resolved" ]; then
            die "拒绝: '$resolved' 是 HOME 目录"
        fi
        case "$home_resolved/" in
            "$resolved"/*) die "拒绝: '$resolved' 是 HOME ($home_resolved) 的上级目录" ;;
        esac
    fi

    # L4 —— 形状: 必须是 ADDashboard 安装根
    if [ -d "$resolved" ]; then
        if [ ! -f "$resolved/center/package.json" ]; then
            die "拒绝: '$resolved' 不含 center/package.json, 不是 ADDashboard 安装根"
        fi
        local pkg_name
        pkg_name="$(node -e '
try {
    const pkg = require(process.argv[1]);
    process.stdout.write(String(pkg.name || ""));
} catch (e) { }
' "$resolved/center/package.json" 2>/dev/null || printf '')"
        if [ "$pkg_name" != "@ad-dashboard/center" ]; then
            die "拒绝: '$resolved/center/package.json' 的 name 是 '$pkg_name', 不是 '@ad-dashboard/center'"
        fi
    fi

    printf '%s' "$resolved"
}

# ---------------------------------------------------------------------------
# PM2 启动后的存活检查 (防崩溃循环结构性失明)
#
# 返回 0 = 进程健在; 1 = 崩溃循环或已死。
# 参数: <等待秒数> <启动后立即取的 pid> <启动后立即取的 restart 次数>
# ---------------------------------------------------------------------------
assert_app_stable() {
    local wait_seconds="$1" pid_before="$2" restarts_before="$3"
    local threshold=3

    sleep "$wait_seconds"

    local app_json
    app_json="$(pm2_app_json)"
    if [ -z "$app_json" ]; then
        err "PM2 名单里已经没有 '$APP_NAME' —— 进程启动后彻底消失了"
        return 1
    fi

    local status pid_after restarts_after
    status="$(pm2_app_status "$app_json")"
    pid_after="$(pm2_app_pid "$app_json")"
    restarts_after="$(pm2_app_restarts "$app_json")"

    if [ "$status" != "online" ]; then
        err "PM2 状态是 '$status' (期望 'online') —— exit_code=$(pm2_app_exit_code "$app_json")"
        return 1
    fi

    if ! pid_alive "$pid_after"; then
        err "PM2 说 online, 但 PID $pid_after 不存在 —— 状态不可信"
        return 1
    fi

    if [ -n "$pid_before" ] && [ -n "$pid_after" ] && [ "$pid_before" != "$pid_after" ]; then
        err "PID 变了 ($pid_before -> $pid_after) —— 等待 ${wait_seconds}s 期间进程重启过"
        return 1
    fi

    if [ -n "$restarts_before" ] && [ -n "$restarts_after" ]; then
        local delta=$((restarts_after - restarts_before))
        if [ "$delta" -ge "$threshold" ]; then
            err "等待 ${wait_seconds}s 期间重启了 $delta 次 (>= $threshold) —— 崩溃循环"
            return 1
        fi
    fi

    ok "进程存活: pid=$pid_after status=$status 累计重启=$restarts_after"
    return 0
}

# ---------------------------------------------------------------------------
# 把目录移到别处 (uninstall 的"可恢复回收")
#
# 首选 rename (mv): 原子、瞬时、不占额外磁盘。
#
# 退化路径 (复制 + 删除): 有些平台**拒绝改名一个"内部有文件被打开"的目录**。
# 实测 (Windows / MSYS): 目录里有一个文件被进程持有句柄时, mv 直接报
# "Permission denied"; 而 rm -rf 同一个目录**是成功的** (rc=0) —— Windows
# 允许"带打开句柄"的文件被 unlink, 但不允许父目录被 rename。
# 最典型的触发场景: 脚本自己就住在这个目录里 —— bash 一直开着它, 于是
# "删掉自己所在的目录"在 Windows 上会失败。Linux 没有这个限制 (rename 允许
# 目录里有打开的文件), 所以正常情况下永远走不到退化路径。
#
# 返回 0 = 源目录已经不在原处, 目标目录就位; 1 = 失败 (两边都还在)。
# ---------------------------------------------------------------------------
move_to_trash() {
    local src="$1" dst="$2"
    [ -n "$src" ] && [ -n "$dst" ] || return 1
    [ -d "$src" ] || return 1
    [ -e "$dst" ] && return 1

    if mv -- "$src" "$dst" 2>/dev/null; then
        return 0
    fi

    warn "改名失败 (目录内有文件被占用?) —— 改用 复制+删除"
    cp -a -- "$src" "$dst" || return 1
    rm -rf -- "$src" || return 1
    return 0
}

# ---------------------------------------------------------------------------
# 其它
# ---------------------------------------------------------------------------
human_size() {
    local bytes="$1"
    if command -v numfmt >/dev/null 2>&1; then
        numfmt --to=iec --suffix=B "$bytes" 2>/dev/null || printf '%sB' "$bytes"
        return 0
    fi
    printf '%sB' "$bytes"
}

latest_center_log() {
    local dir="$CENTER_DIR/logs"
    [ -d "$dir" ] || return 0
    find "$dir" -maxdepth 1 -type f -name 'center.*.log' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2-
}
