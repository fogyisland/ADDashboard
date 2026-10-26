#!/usr/bin/env bash
# verify.sh —— 中心端环境与运行状态自检
#
# 用法:
#   bash scripts/verify.sh            # 人读的检查报告
#   bash scripts/verify.sh --json     # 机器读的报告 (一行 JSON)
#
# 退出码: 0 = 没有 FAIL 项; 1 = 有 FAIL 项 (环境或服务有问题)。
#         WARN 项不影响退出码 (例如"还没初始化"属于正常状态)。
#
# 覆盖: Node 版本 / 目录结构 / 依赖 / lock 一致性 / 可写目录 / 初始化状态 /
#       PM2 进程 / 端口监听 / HTTP 健康检查 / 日志位置。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./common.sh
. "$SCRIPT_DIR/common.sh"

JSON_OUTPUT=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --json) JSON_OUTPUT=1; shift ;;
        -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
        *) die "未知参数: $1" ;;
    esac
done

FAIL_COUNT=0
WARN_COUNT=0
PASS_COUNT=0
REPORT_LINES=()

record() {
    local level="$1" name="$2" detail="${3:-}"
    case "$level" in
        PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
        WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
        FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    esac
    if [ "$JSON_OUTPUT" -eq 1 ]; then
        detail="${detail//\"/\'}"
        REPORT_LINES+=("$(printf '{"level":"%s","name":"%s","detail":"%s"}' "$level" "$name" "$detail")")
    else
        case "$level" in
            PASS) printf '%s[ OK ]%s %-22s %s\n' "$C_GRN" "$C_RST" "$name" "$detail" ;;
            WARN) printf '%s[WARN]%s %-22s %s\n' "$C_YEL" "$C_RST" "$name" "$detail" ;;
            FAIL) printf '%s[FAIL]%s %-22s %s\n' "$C_RED" "$C_RST" "$name" "$detail" ;;
        esac
    fi
}

# --- 1. Node ---------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
    node_version="$(node -p 'process.versions.node' 2>/dev/null || printf '?')"
    node_major="${node_version%%.*}"
    case "$node_major" in
        ''|*[!0-9]*) record WARN "node" "版本解析不了: $node_version" ;;
        *)
            if [ "$node_major" -ge 22 ]; then
                record PASS "node" "$node_version"
            else
                record FAIL "node" "版本 $node_version 过低, 需要 22+"
            fi
            ;;
    esac
else
    record FAIL "node" "没装 Node.js"
fi

# --- 2. 目录结构 -----------------------------------------------------------
structure_missing=0
for item in \
    "$INSTALL_ROOT/package.json" \
    "$INSTALL_ROOT/package-lock.json" \
    "$INSTALL_ROOT/ecosystem.config.cjs" \
    "$CENTER_DIR/server.js" \
    "$CENTER_DIR/package.json" \
    "$CENTER_DIR/dist/index.html" \
    "$INSTALL_ROOT/db/migrations/mysql/1.0.0-baseline.sql" \
    "$INSTALL_ROOT/db/migrations/mssql/1.0.0-baseline.sql"
do
    [ -f "$item" ] || { structure_missing=$((structure_missing + 1)); record FAIL "结构" "缺 ${item#"$INSTALL_ROOT"/}"; }
done
if [ "$structure_missing" -eq 0 ]; then
    record PASS "结构" "目录完整"
fi

# --- 3. 依赖 ---------------------------------------------------------------
if [ ! -d "$INSTALL_ROOT/node_modules" ]; then
    record FAIL "依赖" "node_modules 不存在 —— 跑 npm ci --omit=dev"
else
    dep_missing=0
    for dep in express mssql mysql2 @modelcontextprotocol/sdk zod pino pino-roll; do
        [ -d "$INSTALL_ROOT/node_modules/$dep" ] || { dep_missing=$((dep_missing + 1)); record FAIL "依赖" "缺 $dep"; }
    done
    [ "$dep_missing" -eq 0 ] && record PASS "依赖" "关键依赖齐全"
fi

# --- 4. lock 与 manifest 一致 ---------------------------------------------
# 只看 workspaces 是否对得上 —— 不一致时 npm ci 会报 EUSAGE 或者装错树。
if [ -f "$INSTALL_ROOT/package-lock.json" ] && command -v node >/dev/null 2>&1; then
    lock_check="$(node -e '
const fs = require("node:fs");
try {
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const lock = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const manifestWs = (pkg.workspaces || []).slice().sort().join(",");
    const lockWs = ((lock.packages && lock.packages[""] && lock.packages[""].workspaces) || []).slice().sort().join(",");
    process.stdout.write(manifestWs === lockWs ? "OK" : "MISMATCH:" + manifestWs + " vs " + lockWs);
} catch (e) {
    process.stdout.write("ERROR:" + e.message);
}
' "$INSTALL_ROOT/package.json" "$INSTALL_ROOT/package-lock.json" 2>/dev/null || printf 'ERROR')"
    case "$lock_check" in
        OK) record PASS "lock" "workspaces 与 manifest 一致" ;;
        MISMATCH*) record FAIL "lock" "workspaces 不一致 ($lock_check) —— 重跑 npm install --package-lock-only" ;;
        *) record WARN "lock" "检查不了: $lock_check" ;;
    esac
fi

# --- 5. 可写目录 -----------------------------------------------------------
writable_missing=0
while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    rel="${dir#"$INSTALL_ROOT"/}"
    if [ ! -d "$dir" ]; then
        record FAIL "可写目录" "$rel 不存在"
        writable_missing=$((writable_missing + 1))
    elif [ ! -w "$dir" ]; then
        record FAIL "可写目录" "$rel 不可写 (运行用户没权限)"
        writable_missing=$((writable_missing + 1))
    fi
done < <(writable_dirs)
[ "$writable_missing" -eq 0 ] && record PASS "可写目录" "全部就绪"

# --- 6. 初始化状态 ---------------------------------------------------------
if [ -f "$CENTER_DIR/appsettings.json" ]; then
    record PASS "配置" "appsettings.json 存在 (已初始化)"
else
    record WARN "配置" "还没有 appsettings.json —— 未初始化, 服务处于 init 模式, 访问 /init 走向导"
fi
if [ -f "$CENTER_DIR/.env" ]; then
    record PASS "初始化标记" "center/.env 存在"
else
    record WARN "初始化标记" "center/.env 不存在 —— 若是已初始化的库, 服务会拒绝启动 (init marker present but config missing)"
fi

# --- 7. PM2 进程 -----------------------------------------------------------
PORT="$(resolve_port)"
if ! pm2_available; then
    record WARN "PM2" "没装 PM2, 跳过进程检查"
elif [ -z "$(pm2_app_json)" ]; then
    record WARN "PM2" "名单里没有 '$APP_NAME' —— 服务没在跑"
else
    app_json="$(pm2_app_json)"
    pm2_status="$(pm2_app_status "$app_json")"
    pm2_pid="$(pm2_app_pid "$app_json")"
    pm2_restarts="$(pm2_app_restarts "$app_json")"
    if [ "$pm2_status" = "online" ] && pid_alive "$pm2_pid"; then
        record PASS "PM2" "status=$pm2_status pid=$pm2_pid 累计重启=$pm2_restarts"
        if [ -n "$pm2_restarts" ] && [ "$pm2_restarts" -ge 10 ]; then
            record WARN "PM2" "累计重启 $pm2_restarts 次 —— 频繁重启, 看 pm2 logs"
        fi
    else
        record FAIL "PM2" "status=$pm2_status pid=$pm2_pid —— 进程没活着"
    fi
fi

# --- 8. 端口 ---------------------------------------------------------------
if port_listening "$PORT"; then
    record PASS "端口" "$PORT 正在监听"
else
    record FAIL "端口" "$PORT 没有监听"
fi

# --- 9. HTTP 健康 ----------------------------------------------------------
health_code="$(http_status "http://127.0.0.1:$PORT/api/health")"
case "$health_code" in
    200) record PASS "健康检查" "/api/health = 200" ;;
    503) record WARN "健康检查" "/api/health = 503 —— 未初始化时属正常" ;;
    000) record WARN "健康检查" "连不上 (服务没起?)" ;;
    *)   record WARN "健康检查" "/api/health = $health_code" ;;
esac

# --- 10. 日志 --------------------------------------------------------------
latest_log="$(latest_center_log)"
if [ -n "$latest_log" ]; then
    record PASS "业务日志" "$latest_log"
else
    record WARN "业务日志" "还没有日志文件 (没起过, 或还没写第一行)"
fi

# --- 汇总 ------------------------------------------------------------------
if [ "$JSON_OUTPUT" -eq 1 ]; then
    printf '{"pass":%d,"warn":%d,"fail":%d,"checks":[%s]}\n' \
        "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$(IFS=,; echo "${REPORT_LINES[*]:-}")"
else
    hr
    printf '通过 %d / 警告 %d / 失败 %d\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
    hr
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
