#!/usr/bin/env python3
# ============================================================================
# 构建产物安全扫描：检查服务端秘密 / 测试残留 / 子路径与 SW 兼容性。
# 只输出 pass/fail 结论与计数字段，绝不输出任何疑似密钥原文。
# 用法: python3 scan_artifact.py <dist_dir>
# ============================================================================
import os
import re
import sys

base = sys.argv[1] if len(sys.argv) > 1 else '.'
if not os.path.isdir(base):
    print('[FATAL] 产物目录不存在', file=sys.stderr)
    sys.exit(2)

errors = []
warns = []

# 服务端秘密 / 测试残留形态（匹配即 fail，不回显命中内容）
SERVER_SECRET_PATTERNS = [
    re.compile(r'sb_secret_[A-Za-z0-9._-]{8,}'),
    re.compile(r'service_role', re.I),
    re.compile(r'"role"\s*:\s*"service_role"'),
]
# 注意：final_wage_ui.js 中原有注释含 __mock_guard / accountPrices 等"机制说明文字"
# （属活跃源码既有内容，非本次测试残留），故只检测"真实测试文件"与"实际测试数据行"，
# 用文件白名单 + 精确数据行模式，避免把注释误判为残留。
TEST_RESIDUE_FILENAMES = [
    '__mock_guard.js', '__screenshot_harness.html', '__iphone_harness.html', '__iphone_se_harness.html',
]
TEST_RESIDUE_PATTERNS = [
    # 实际 mock 数据行（候选里曾加入的 11-21/22 业务夹具），而非注释
    re.compile(r"\{\s*business_date:\s*'2026-11-2[12]',\s*account_code:"),
    re.compile(r"\{\s*date:\s*'2026-11-2[12]',\s*xhs:"),
    re.compile(r"STATE\.book\s*=\s*\["),
]

scanned = 0
for dp, dn, fn in os.walk(base):
    for f in fn:
        p = os.path.join(dp, f)
        rel = os.path.relpath(p, base)
        if f in TEST_RESIDUE_FILENAMES:
            errors.append('测试文件残留: ' + rel)
        try:
            s = open(p, encoding='utf-8', errors='ignore').read()
        except Exception:
            continue
        scanned += 1
        for pat in SERVER_SECRET_PATTERNS:
            if pat.search(s):
                errors.append('服务端秘密形态命中: ' + rel)
                break
        for pat in TEST_RESIDUE_PATTERNS:
            if pat.search(s):
                errors.append('测试残留命中: ' + rel)
                break

# --- 凭据存在性：产物应有且仅有 1 处 supabase URL、1 处公钥形态 ---
cfg = os.path.join(base, 'config.js')
if not os.path.isfile(cfg):
    errors.append('缺少 config.js')
else:
    s = open(cfg, encoding='utf-8').read()
    n_url = len(re.findall(r'https://[a-z0-9]{12,}\.supabase\.co', s))
    n_key = len(re.findall(r'(?:sb_publishable_|sb_anon_)[A-Za-z0-9._-]{8,}', s))
    if n_url != 1:
        errors.append('config.js supabase URL 形态数 != 1 (got %d)' % n_url)
    if n_key != 1:
        warns.append('config.js 公钥形态数=%d（JWT anon 可能为 0，需人工确认 key 类型）' % n_key)

# --- 子路径 / 相对资源路径 / SW 缓存兼容 ---
idx = os.path.join(base, 'index.html')
if os.path.isfile(idx):
    s = open(idx, encoding='utf-8').read()
    # 资源引用必须是相对路径（以 ./ 或无前导 / 的文件名），不得绝对路径
    for m in re.findall(r'(?:src|href)="([^"]+)"', s):
        if m.startswith('http') or m.startswith('/'):
            if 'manifest' not in m:  # manifest 允许相对
                errors.append('index.html 存在非相对资源引用')
                break
    if 'hw-list' not in s:
        errors.append('index.html 缺少 hw-list（手机卡片容器）')
sw = os.path.join(base, 'service-worker.js')
if os.path.isfile(sw):
    s = open(sw, encoding='utf-8').read()
    if "ledger-pwa-u4-readonly-v1" not in s:
        errors.append('service-worker.js 缓存版本不符合 u4-readonly-v1')
    if 'caches.delete' not in s:
        warns.append('service-worker.js 未发现旧缓存清理逻辑')

# --- 输出结论（无值）---
print('扫描文件数:', scanned)
for w in warns:
    print('[WARN]', w)
if errors:
    for e in errors:
        print('[FAIL]', e, file=sys.stderr)
    print('[FAIL-CLOSED] 产物扫描未通过：%d 项' % len(errors), file=sys.stderr)
    sys.exit(4)
print('[PASS] 产物安全扫描通过：无服务端秘密、无测试残留、子路径/相对路径/SW 兼容')
