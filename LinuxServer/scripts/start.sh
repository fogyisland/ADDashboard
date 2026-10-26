#!/usr/bin/env bash
# start.sh —— 用 PM2 启动中心端
#
# 用法:
#   bash scripts/start.sh                # 启动 (已在跑则重启)
#   bash scripts/start.sh --wait 15      # 启动后等 15 秒再做存活检查 (默认 8)
#
# 幂等: 已在跑 → pm2 restart; 没在跑 → pm2 start。
#
# 关键: 启动后会**等一段时间再验活**, 而不是看 pm2 status 就报成功。
# R160 在 Windows/NSSM 上栽过这个坑: NSSM 的 AppExit=Restart 让
# Status='Running' 对"起来就崩"的进程结构性失明 —— 看着是 Running, 其实
# 一直在重启循环里。PM2 这边同理: 进程起来 1 秒内死掉, pm2 也会把
# status 标成 online (它还没观察到退出)。所以这里比对 PID + 累计重启次数。
#
# 退出码: 0 = 起来了且稳定; 1 = 失败 (含崩溃循环)。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./common.sh
. "$SCRIPT_DIR/common.sh"

WAIT_SECONDS=8
while [ "$#" -gt 0 ]; do
    case "$1" in
        --wait) [ "$#" -ge 2 ] || die "--wait 需要一个参数 (秒)"; WAIT_SECONDS="$2"; shift 2 ;;
        --wait=*) WAIT_SECONDS="${1#--wait=}"; shift ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) die "未知参数: $1" ;;
    esac
done

hr
info "启动中心端 (PM2: $APP_NAME)"
hr

require_node
require_pm2

if [ ! -d "$INSTALL_ROOT/node_modules" ]; then
    die "node_modules 不存在 —— 先跑 bash scripts/install.sh (或 npm ci --omit=dev)"
fi

# 用 cwd 指向 center/ 的那份 ecosystem 配置启动
cd "$INSTALL_ROOT"

app_json="$(pm2_app_json)"
if [ -n "$app_json" ]; then
    status="$(pm2_app_status "$app_json")"
    info "当前状态: $status (pid=$(pm2_app_pid "$app_json") 累计重启=$(pm2_app_restarts "$app_json")) —— 执行重启"
    "$PM2_BIN" restart "$APP_NAME" --update-env >/dev/null
else
    info "PM2 名单里没有 '$APP_NAME' —— 首次启动"
    "$PM2_BIN" start ecosystem.config.cjs >/dev/null
fi

# 启动后立刻取一次基线 (pid / 重启次数), 等待后再比对
app_json="$(pm2_app_json)"
pid_before="$(pm2_app_pid "$app_json")"
restarts_before="$(pm2_app_restarts "$app_json")"
info "启动后基线: pid=$pid_before 累计重启=$restarts_before"

hr
if ! assert_app_stable "$WAIT_SECONDS" "$pid_before" "$restarts_before"; then
    err "服务没能稳定运行 —— 崩溃循环或启动失败"
    log ""
    log "---- pm2 错误日志尾部 ----"
    "$PM2_BIN" logs "$APP_NAME" --err --lines 40 --nostream 2>/dev/null || true
    log "---- 业务日志尾部 (最新) ----"
    latest_log="$(latest_center_log)"
    if [ -n "$latest_log" ]; then
        log "文件: $latest_log"
        tail -n 40 "$latest_log" 2>/dev/null || true
    else
        log "(还没有业务日志 —— 说明进程在写日志之前就死了, 看上面的 pm2 错误日志)"
    fi
    exit 1
fi

hr
ok "服务已启动"
"$PM2_BIN" describe "$APP_NAME" 2>/dev/null | sed -n '1,20p' || true
log ""
log "  初始化向导: http://<服务器IP>:$(resolve_port)/init"
log "  管理后台:   http://<服务器IP>:$(resolve_port)/"
log "  业务日志:   $(latest_center_log)"
