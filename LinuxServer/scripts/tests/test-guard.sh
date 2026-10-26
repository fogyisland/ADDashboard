#!/usr/bin/env bash
# test-guard.sh —— 删除守卫 (assert_safe_install_root) 的自测
#
# 为什么要有这个测试:
#   Windows 版的同款守卫 (uninstall-agent.ps1) 是**死代码** —— 守卫写在那儿,
#   但实际执行路径绕过了它, 结果跑起来把整盘删光。守卫只有被实跑覆盖,
#   才敢说它是活的。
#
# 用法:
#   bash scripts/tests/test-guard.sh
#
# 退出码: 0 = 全部通过; 1 = 有用例失败。

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=../common.sh
. "$SCRIPT_DIR/../common.sh"

PASS_COUNT=0
FAIL_COUNT=0

expect_reject() {
    local input="$1" output
    if output="$(assert_safe_install_root "$input" 2>&1)"; then
        printf 'FAIL  期望拒绝, 实际放行: %s\n' "$input"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        printf 'PASS  已拒绝: %-46s | %s\n' "$input" "$(printf '%s' "$output" | tail -1)"
        PASS_COUNT=$((PASS_COUNT + 1))
    fi
}

expect_accept() {
    local input="$1" output
    if output="$(assert_safe_install_root "$input" 2>&1)"; then
        printf 'PASS  已放行: %-46s | -> %s\n' "$input" "$output"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        printf 'FAIL  期望放行, 实际拒绝: %s | %s\n' "$input" "$(printf '%s' "$output" | tail -1)"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

printf '=== 删除守卫自测 (%s) ===\n' "$(date '+%Y-%m-%d %H:%M:%S')"

# --- 危险路径: 必须全部被拒 -------------------------------------------------
expect_reject "/"
expect_reject "/root"
expect_reject "/home"
expect_reject "/usr"
expect_reject "/var"
expect_reject "/etc"
expect_reject "/opt"
expect_reject "/srv"
expect_reject "/www"
expect_reject "/tmp"
expect_reject "/bin"
expect_reject "/sbin"
expect_reject "/lib"
expect_reject "/lib64"
expect_reject "/boot"
expect_reject "/dev"
expect_reject "/proc"
expect_reject "/sys"
expect_reject "/mnt"
expect_reject "/media"
expect_reject "/run"

# HOME 本身 + HOME 的祖先
expect_reject "${HOME:-/root}"
expect_reject "$(dirname -- "${HOME:-/root}")"

# --- 形状不对的目录: 必须被拒 -----------------------------------------------
WORK_DIR="$(mktemp -d)"
trap 'rm -rf -- "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/random-dir"
expect_reject "$WORK_DIR/random-dir"

mkdir -p "$WORK_DIR/wrong-name/center"
printf '{"name":"some-other-package","version":"1.0.0"}\n' > "$WORK_DIR/wrong-name/center/package.json"
expect_reject "$WORK_DIR/wrong-name"

mkdir -p "$WORK_DIR/no-center"
expect_reject "$WORK_DIR/no-center"

# --- 真正的安装根: 必须放行 --------------------------------------------------
mkdir -p "$WORK_DIR/ADDashboard/center"
printf '{"name":"@ad-dashboard/center","version":"0.1.0"}\n' > "$WORK_DIR/ADDashboard/center/package.json"
expect_accept "$WORK_DIR/ADDashboard"

# 带符号链接指向真安装根 —— 必须解析后再判定 (不能靠符号链接绕过守卫)
# 注: 在 MSYS / Git Bash 下 ln -s 是"模拟符号链接"(普通文件), realpath 不会
#     跟着解析, 所以这里打印的路径是链接本身; 在真 Linux 上会解析成目标目录。
#     两种情况都必须放行 —— 用例只断言"结果", 不断言提示文案。
ln -s "$WORK_DIR/ADDashboard" "$WORK_DIR/link-to-install"
expect_accept "$WORK_DIR/link-to-install"

# 符号链接指向文件系统根 —— 解析后必须被拒
ln -s "/" "$WORK_DIR/link-to-root"
expect_reject "$WORK_DIR/link-to-root"

# 不存在的路径 —— 放行 (卸载时按"没东西可卸"处理), 但顶层系统目录仍要拒
expect_accept "$WORK_DIR/does-not-exist"

printf '=== 通过 %d / 失败 %d ===\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
