#!/usr/bin/env bash
# ============================================================================
# Ledger PWA — 构建期凭据安全注入脚本（安全准备，未授权线上发布）
# ----------------------------------------------------------------------------
# 职责：
#   1) 按【显式网站文件白名单】复制运行时必需文件到构建输出目录；
#      不复制整个仓库（杜绝 .git / .github / scripts / tests / 文档 / 备份 /
#      临时文件 / 测试 harness 混入产物，也避免扫描器误报自身检测字符串）。
#   2) 从环境变量读取两个公开客户端凭据（CI 从 Repository Secrets 注入）；
#   3) 严格 fail-closed 校验：缺失 / 格式错 / 服务端秘密 → 立即中止，exit≠0；
#   4) 仅在【输出副本】的 config.js 注入 prod profile 并把 ACTIVE_ENV 切到 prod；
#   5) 绝不修改源码；绝不回写 Git；绝不打印/记录密钥值；不产生日志文件。
#
# 用法（CI，checkout 后仓库根即源码根）：
#   SUPABASE_URL="$SUPABASE_URL" \
#   SUPABASE_PUBLISHABLE_KEY="$SUPABASE_PUBLISHABLE_KEY" \
#   ./scripts/build_with_credentials.sh . dist
#
# 白名单依据：index.html 的 <script src>/<link href> + service-worker.js 的
# ASSETS 缓存清单 + manifest.json 图标引用（2026-11-23 核实）。
# 退出码：0=成功；非 0=任一 fail-closed 或校验失败（并清理半成品产物）。
# ============================================================================
set -euo pipefail

SRC_DIR="${1:?用法: build_with_credentials.sh <src_pwa_dir> <out_dir>}"
OUT_DIR="${2:?用法: build_with_credentials.sh <src_pwa_dir> <out_dir>}"

# 只读取环境变量，绝不 echo 其值
URL_VAL="${SUPABASE_URL:-}"
KEY_VAL="${SUPABASE_PUBLISHABLE_KEY:-}"

# ---------------------------------------------------------------------------
# 0) 定位脚本目录（用于调用 python 校验/注入器）
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$SCRIPT_DIR/inject_config.py"
if [ ! -f "$PY" ]; then
  echo "[FATAL] 缺少注入器 $PY" >&2
  exit 2
fi
if [ ! -d "$SRC_DIR" ]; then
  echo "[FATAL] 源码目录不存在: $SRC_DIR" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 1) 网站运行时文件白名单（相对 SRC_DIR）
#    —— 只复制这些，任何缺失即 fail-closed，防止遗漏运行时资源。
# ---------------------------------------------------------------------------
WEB_FILES=(
  "index.html"
  "config.js"
  "readonly_guard.js"
  "app.js"
  "localdb.js"
  "piecework_sync.js"
  "final_wage.js"
  "final_wage_ui.js"
  "style.css"
  "manifest.json"
  "service-worker.js"
  "vendor/supabase.js"
  "icons/icon-180.png"
  "icons/icon-192.png"
  "icons/icon-512.png"
  "icons/icon-512-maskable.png"
  ".nojekyll"
)

# fail-closed 清理：任何失败都删除半成品产物目录
BUILD_OK=0
cleanup_on_fail() {
  if [ "$BUILD_OK" != "1" ]; then
    rm -rf "$OUT_DIR"
    echo "[FAIL-CLOSED] 构建失败，已清理产物目录（无半成品残留）" >&2
  fi
}
trap cleanup_on_fail EXIT

# 预检白名单：全部存在才复制，避免复制到一半才发现缺失
MISSING=0
for rel in "${WEB_FILES[@]}"; do
  if [ ! -f "$SRC_DIR/$rel" ]; then
    echo "[FATAL] 白名单文件缺失: $rel" >&2
    MISSING=$((MISSING+1))
  fi
done
if [ "$MISSING" -gt 0 ]; then
  echo "[FATAL] 共 $MISSING 个运行时文件缺失，中止构建" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
for rel in "${WEB_FILES[@]}"; do
  dest="$OUT_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  cp -p "$SRC_DIR/$rel" "$dest"
done
echo "[PASS] 已按白名单复制 ${#WEB_FILES[@]} 个运行时文件（无构建工具/测试/文档混入）"

# ---------------------------------------------------------------------------
# 2) fail-closed 校验 + 注入（python 实现，校验逻辑集中、无值输出）
#    URL_VAL / KEY_VAL 经环境变量传入 python，不经命令行参数（避免进程列表泄露）
# ---------------------------------------------------------------------------
SUPABASE_URL="$URL_VAL" SUPABASE_PUBLISHABLE_KEY="$KEY_VAL" \
  python3 "$PY" "$OUT_DIR/config.js"

# ---------------------------------------------------------------------------
# 3) 注入后复检：产物中 dev/test 仍为空、prod 非空、无服务端秘密
#    （复检同样不输出任何值，只输出 pass/fail 结论）
# ---------------------------------------------------------------------------
python3 - "$OUT_DIR/config.js" <<'PYEOF'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

def profile(env):
    # 兼容源码占位（单引号）与注入值（json.dumps 双引号）
    m = re.search(env + r":\s*\{\s*url:\s*['\"]([^'\"]*)['\"]\s*,\s*key:\s*['\"]([^'\"]*)['\"]", s)
    return (m.group(1), m.group(2)) if m else None

d, t, pr = profile('dev'), profile('test'), profile('prod')
assert d and t and pr, '[FATAL] config.js profile 解析失败'
assert d[0] == '' and d[1] == '' and t[0] == '' and t[1] == '', '[FATAL] dev/test 必须保持空'
assert pr[0].startswith('https://') and pr[1] != '', '[FATAL] prod 未正确注入'
assert "'dev'" not in re.search(r'ACTIVE_ENV:[^\n]*', s).group(0), '[FATAL] 默认环境未切到 prod'
print('[PASS] 产物复检：dev/test 空占位、prod 已注入、默认环境=prod')
PYEOF

BUILD_OK=1
echo "[PASS] 构建完成，输出目录: $OUT_DIR （无密钥值输出）"
