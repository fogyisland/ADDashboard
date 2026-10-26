#!/usr/bin/env bash
# uninstall.sh —— 卸载 Linux 中心端
#
# 用法:
#   bash scripts/uninstall.sh                    # 停服务 + 把安装根移到回收目录 (可恢复)
#   bash scripts/uninstall.sh --target /path     # 卸载别的安装根
#   bash scripts/uninstall.sh --purge            # 真删 (不可恢复) —— 仍受删除守卫约束
#   bash scripts/uninstall.sh --keep-pm2         # 不动 PM2 名单
#   bash scripts/uninstall.sh --yes              # 跳过交互确认 (给自动化用)
#
# 默认行为是**可恢复**的: 不直接 rm -rf, 而是把整个安装根移到同盘的一个
# 回收目录 (ADDashboard.uninstalled.<时间戳>), 操作员确认没问题后再手工删。
# 加了 --purge 才真删。
#
# ⚠️ 删除守卫 (assert_safe_install_root, 见 common.sh) 是**必经**的活代码:
#   目标必须同时满足 4 条: 不是 "/" / 不是系统顶层目录 / 不是 HOME 或其祖先 /
#   必须含 center/package.json 且 name == @ad-dashboard/center。
#   Windows 版同款守卫曾经是死代码 (跑起来会把整盘删光) —— 这里的实现有
#   scripts/tests/test-guard.sh 实跑覆盖。
#
# 退出码: 0 = 完成; 1 = 被守卫拒绝或出错。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./common.sh
. "$SCRIPT_DIR/common.sh"

TARGET=""
PURGE=0
KEEP_PM2=0
ASSUME_YES=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --target) [ "$#" -ge 2 ] || die "--target 需要一个参数 (目录)"; TARGET="$2"; shift 2 ;;
        --target=*) TARGET="${1#--target=}"; shift ;;
        --purge) PURGE=1; shift ;;
        --keep-pm2) KEEP_PM2=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) die "未知参数: $1" ;;
    esac
done

hr
info "卸载中心端"
hr

[ -n "$TARGET" ] || TARGET="$INSTALL_ROOT"

# --- 1. 删除守卫 (必须先过这一关) -----------------------------------------
info "删除守卫检查: $TARGET"
SAFE_TARGET="$(assert_safe_install_root "$TARGET")"
ok "守卫通过: $SAFE_TARGET"

if [ ! -d "$SAFE_TARGET" ]; then
    warn "目标目录不存在 —— 没什么可卸的"
    exit 0
fi

# --- 2. 停服务 -------------------------------------------------------------
if [ "$KEEP_PM2" -eq 0 ]; then
    if pm2_available; then
        if [ -n "$(pm2_app_json)" ]; then
            info "停服务并从 PM2 名单里删除"
            bash "$SCRIPT_DIR/stop.sh" --timeout 15 --purge || warn "停止流程有告警, 继续"
        else
            info "PM2 名单里没有 '$APP_NAME', 跳过"
        fi
    else
        warn "没装 PM2, 跳过停服务"
    fi
else
    info "--keep-pm2: 不动 PM2 名单"
fi

# --- 3. 确认 ---------------------------------------------------------------
if [ "$ASSUME_YES" -eq 0 ]; then
    log ""
    if [ "$PURGE" -eq 1 ]; then
        log "即将**永久删除**目录: $SAFE_TARGET"
    else
        log "即将把目录**移走** (可恢复): $SAFE_TARGET"
    fi
    log "包含: 中心程序 / node_modules / 业务日志 / data/packages / 审计数据"
    log ""
    printf '确认请输入 yes: '
    read -r answer
    if [ "$answer" != "yes" ]; then
        info "已取消, 什么都没动"
        exit 0
    fi
fi

# --- 4. 执行 ---------------------------------------------------------------
PARENT_DIR="$(dirname -- "$SAFE_TARGET")"
BASE_NAME="$(basename -- "$SAFE_TARGET")"
STAMP="$(date +%Y%m%d-%H%M%S)"

# 脚本自己就住在待删目录里 —— 先把 cwd 挪到父目录, 否则删除/改名会因为
# "进程正站在里面" 而失败 (Windows 上直接 Permission denied)。
cd -- "$PARENT_DIR" || die "进不去父目录 $PARENT_DIR"

if [ "$PURGE" -eq 1 ]; then
    info "永久删除: $SAFE_TARGET"
    rm -rf -- "$SAFE_TARGET"
    ok "已删除"
else
    TRASH_DIR="$PARENT_DIR/${BASE_NAME}.uninstalled.$STAMP"
    if [ -e "$TRASH_DIR" ]; then
        TRASH_DIR="$TRASH_DIR.$RANDOM"
    fi
    info "移到回收目录: $TRASH_DIR"
    if ! move_to_trash "$SAFE_TARGET" "$TRASH_DIR"; then
        err "移动失败: $SAFE_TARGET"
        err "若提示 'Permission denied', 说明目录里有文件正被占用 —— 改用 --purge, 或先停掉在跑的进程再试"
        exit 1
    fi
    ok "已移走 (要彻底删: rm -rf '$TRASH_DIR')"
fi

# --- 5. 收尾 ---------------------------------------------------------------
if [ "$KEEP_PM2" -eq 0 ] && pm2_available; then
    "$PM2_BIN" save >/dev/null 2>&1 || true
    info "已刷新 PM2 开机自启名单 (pm2 save)"
fi

hr
ok "卸载完成"
log ""
log "提醒: 中心端的数据在 MySQL / MSSQL 里, 本脚本**不碰数据库**。"
log "      要连数据一起清, 请手工处理目标库。"
