#!/usr/bin/env bash
# install.sh —— Linux 中心端首次安装
#
# 用法:
#   bash scripts/install.sh                 # 装依赖 + 建可写目录
#   bash scripts/install.sh --pm2           # 顺便用 PM2 拉起服务 (等价于 start.sh)
#   bash scripts/install.sh --user www      # 把整个安装根 chown 给指定运行用户
#   bash scripts/install.sh --skip-deps     # 跳过 npm ci (依赖已装好时)
#
# 幂等: 重复执行安全。npm ci 会重建 node_modules, 其余步骤都是"存在即跳过"。
#
# 退出码: 0 = 成功; 1 = 失败 (任何一步失败都立即中止, 不留半装状态)。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./common.sh
. "$SCRIPT_DIR/common.sh"

WITH_PM2=0
SKIP_DEPS=0
RUN_USER=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --pm2) WITH_PM2=1; shift ;;
        --skip-deps) SKIP_DEPS=1; shift ;;
        --user) [ "$#" -ge 2 ] || die "--user 需要一个参数 (运行用户名)"; RUN_USER="$2"; shift 2 ;;
        --user=*) RUN_USER="${1#--user=}"; shift ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) die "未知参数: $1" ;;
    esac
done

hr
info "ADDashboard 中心端 —— Linux 安装"
info "安装根: $INSTALL_ROOT"
hr

# --- 1. 前置检查 -----------------------------------------------------------
require_node
require_cmd npm "安装依赖需要 npm (Node.js 自带)"

if ! check_tree_layout; then
    die "目录结构不完整 —— 请确认整个 LinuxServer/ 目录都传上来了"
fi

# --- 2. 装依赖 -------------------------------------------------------------
if [ "$SKIP_DEPS" -eq 1 ]; then
    warn "跳过 npm ci (--skip-deps)"
else
    info "装生产依赖: npm ci --omit=dev (在安装根, 不用 npm install)"
    info "  —— 根 package-lock.json 是 workspaces lock, 必须整棵树一起装"
    ( cd "$INSTALL_ROOT" && npm ci --omit=dev --no-audit --no-fund )
    ok "依赖装好"
fi

# 关键依赖抽查: 少了任何一个, 中心都起不来
missing_dep=0
for dep in express mssql mysql2 @modelcontextprotocol/sdk zod pino; do
    if [ ! -d "$INSTALL_ROOT/node_modules/$dep" ]; then
        err "依赖缺失: $dep"
        missing_dep=$((missing_dep + 1))
    fi
done
if [ "$missing_dep" -gt 0 ]; then
    die "缺 $missing_dep 个关键依赖 —— 请在安装根重跑 npm ci --omit=dev"
fi
ok "关键依赖齐全"

# --- 3. 可写目录 -----------------------------------------------------------
info "建运行期可写目录"
if ensure_writable_dirs; then
    ok "可写目录就绪"
else
    die "有目录建不出来或不可写 —— 检查权限 (第 4 节的 chown)"
fi

# --- 4. 权限 ---------------------------------------------------------------
if [ -n "$RUN_USER" ]; then
    if [ "$(id -u)" -ne 0 ]; then
        warn "当前不是 root, 跳过 chown $RUN_USER (请自行用 sudo 处理权限)"
    elif ! id -u "$RUN_USER" >/dev/null 2>&1; then
        die "系统里没有用户 '$RUN_USER'"
    else
        info "把安装根交给 $RUN_USER"
        chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_ROOT"
        ok "权限已设置 (属主 $RUN_USER)"
    fi
fi

# --- 5. 启动 (可选) --------------------------------------------------------
if [ "$WITH_PM2" -eq 1 ]; then
    hr
    info "拉起服务 (PM2)"
    if pm2_available; then
        bash "$SCRIPT_DIR/start.sh"
    else
        warn "没装 PM2, 跳过启动 —— 装 PM2: npm install -g pm2"
    fi
fi

# --- 6. 收尾 ---------------------------------------------------------------
hr
ok "安装完成"
log ""
log "下一步:"
log "  1) 启动服务:   bash scripts/start.sh        (或用宝塔面板的 Node 项目)"
log "  2) 初始化:     浏览器打开 http://<服务器IP>:$(resolve_port)/init 走向导"
log "  3) 自检:       bash scripts/verify.sh"
log ""
log "数据库口令 / JWT secret / agent token 在初始化向导里填, 由向导写进"
log "center/appsettings.json —— 本包不含任何凭据文件, 也**不需要**手工准备 .env。"
