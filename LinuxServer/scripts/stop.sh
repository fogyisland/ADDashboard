#!/usr/bin/env bash
# stop.sh —— 停止中心端
#
# 用法:
#   bash scripts/stop.sh                  # 停服务 (保留在 PM2 名单里, 状态 stopped)
#   bash scripts/stop.sh --timeout 30     # 等待进程退出的秒数 (默认 15)
#   bash scripts/stop.sh --force          # 停不下来的话强杀, 并从 PM2 名单里删除
#   bash scripts/stop.sh --purge          # 等价于 --force + pm2 delete (彻底摘掉)
#
# 幂等: 没在跑也不报错 (直接报 "本来就停着")。
#
# 关键: "停" 必须真的停。pm2 stop 之后还要确认 PID 没了; 崩溃循环留下的
# 僵尸进程 (pm2 名单里没有, 但端口还占着) 会被 --force 路径 kill 掉。
# R160 在 Windows 侧发现过 stop.ps1 的 -Force 是个空开关 —— 传了等于没传。
# 这里 --force 是有真实动作的。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./common.sh
. "$SCRIPT_DIR/common.sh"

TIMEOUT=15
FORCE=0
PURGE=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --timeout) [ "$#" -ge 2 ] || die "--timeout 需要一个参数 (秒)"; TIMEOUT="$2"; shift 2 ;;
        --timeout=*) TIMEOUT="${1#--timeout=}"; shift ;;
        --force) FORCE=1; shift ;;
        --purge) PURGE=1; FORCE=1; shift ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) die "未知参数: $1" ;;
    esac
done

hr
info "停止中心端 (PM2: $APP_NAME)"
hr

if ! pm2_available; then
    warn "没装 PM2, 无从停起 —— 若进程还在跑, 请手工 kill"
    exit 0
fi

app_json="$(pm2_app_json)"
if [ -z "$app_json" ]; then
    ok "PM2 名单里没有 '$APP_NAME' —— 本来就停着"
    exit 0
fi

status="$(pm2_app_status "$app_json")"
pid="$(pm2_app_pid "$app_json")"
info "当前状态: $status pid=$pid"

if [ "$status" = "stopped" ]; then
    ok "已经是 stopped 状态"
    if [ "$PURGE" -eq 1 ]; then
        info "--purge: 从 PM2 名单里删除"
        "$PM2_BIN" delete "$APP_NAME" >/dev/null
        ok "已从 PM2 名单删除"
    fi
    exit 0
fi

info "执行 pm2 stop (最多等 ${TIMEOUT}s)"
"$PM2_BIN" stop "$APP_NAME" >/dev/null 2>&1 || true

# 轮询等进程真的消失
waited=0
while [ "$waited" -lt "$TIMEOUT" ]; do
    app_json="$(pm2_app_json)"
    new_pid="$(pm2_app_pid "$app_json")"
    if [ -z "$new_pid" ] || ! pid_alive "$new_pid"; then
        break
    fi
    sleep 1
    waited=$((waited + 1))
done

app_json="$(pm2_app_json)"
new_pid="$(pm2_app_pid "$app_json")"

if [ -n "$new_pid" ] && pid_alive "$new_pid"; then
    warn "进程 $new_pid 还在 (等了 ${waited}s)"
    if [ "$FORCE" -eq 1 ]; then
        info "--force: kill -9 $new_pid"
        kill -9 "$new_pid" 2>/dev/null || true
        sleep 1
        if pid_alive "$new_pid"; then
            err "kill -9 之后 PID $new_pid 仍在 —— 可能有别的守护进程在拉起它"
        else
            ok "进程已强杀"
        fi
    else
        warn "要强杀请加 --force (会 kill -9 掉进程)"
    fi
else
    ok "进程已停止"
fi

if [ "$PURGE" -eq 1 ]; then
    info "--purge: pm2 delete (从 PM2 名单里彻底移除)"
    "$PM2_BIN" delete "$APP_NAME" >/dev/null 2>&1 || true
    ok "已从 PM2 名单删除"
fi

hr
ok "停止流程结束"
