#!/usr/bin/env python3
# ============================================================================
# 构建期 config.js 注入器 —— fail-closed，绝不输出/记录密钥值
# ----------------------------------------------------------------------------
# 从环境变量 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY 读取，严格校验后，
# 在【输出副本】的 config.js 中：
#   - 只替换 prod profile 的 url/key（dev/test 保持空）；
#   - 把 ACTIVE_ENV 默认从 'dev' 切到 'prod'。
# 绝不 print 密钥值；所有失败信息只描述"哪类校验失败"，不含原文。
# ============================================================================
import os
import re
import sys

TARGET = sys.argv[1] if len(sys.argv) > 1 else None
if not TARGET or not os.path.isfile(TARGET):
    print('[FATAL] 目标 config.js 不存在', file=sys.stderr)
    sys.exit(2)

url = os.environ.get('SUPABASE_URL', '')
key = os.environ.get('SUPABASE_PUBLISHABLE_KEY', '')


def die(msg):
    """只输出校验类别，绝不输出值本身。"""
    print('[FAIL-CLOSED] ' + msg, file=sys.stderr)
    sys.exit(3)


# ---- 1. 存在性 ----
if not url or not url.strip():
    die('SUPABASE_URL 缺失或为空')
if not key or not key.strip():
    die('SUPABASE_PUBLISHABLE_KEY 缺失或为空')

# ---- 2. 服务端秘密检测（最高优先级，先于格式）----
# 集合了常见服务端秘密形态：service_role / sb_secret / service-role / JWT role=service_role
key_l = key.lower()
if 'service_role' in key_l or 'service-role' in key_l or 'sb_secret' in key_l:
    die('检测到服务端秘密标识（service_role / sb_secret），拒绝注入')

url_l = url.lower()
if 'service_role' in url_l or 'sb_secret' in url_l:
    die('URL 中检测到服务端秘密标识，拒绝注入')

# ---- 3. URL 格式校验：https://<project-ref>.supabase.co ----
url_m = re.fullmatch(r'https://([a-z0-9]{12,})\.supabase\.co/?', url.strip())
if not url_m:
    die('SUPABASE_URL 格式不符合 https://<project-ref>.supabase.co')
project_ref = url_m.group(1)

# ---- 4. Key 格式校验：仅 publishable / anon ----
# 形态 A: sb_publishable_<base64url>  (新版 publishable key)
# 形态 B: sb_anon_<...>              (部分环境 anon key)
# 形态 C: eyJ... JWT（传统 anon key，需解 payload 确认 role=anon，排除 service_role）
key_s = key.strip()
key_kind = None
if re.fullmatch(r'sb_publishable_[A-Za-z0-9._-]{8,}', key_s):
    key_kind = 'publishable'
elif re.fullmatch(r'sb_anon_[A-Za-z0-9._-]{8,}', key_s):
    key_kind = 'anon'
elif re.fullmatch(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', key_s):
    # JWT：解 payload 判定 role
    import base64
    import json
    try:
        payload_b64 = key_s.split('.')[1]
        payload_b64 += '=' * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode('utf-8'))
    except Exception:
        die('KEY 为 JWT 但 payload 无法解析')
    role = str(payload.get('role', '')).lower()
    if role == 'service_role' or role == 'service-role':
        die('JWT role=service_role，拒绝注入')
    if role != 'anon':
        die('JWT role 非 anon，拒绝注入')
    key_kind = 'anon-jwt'
else:
    die('KEY 格式不符合 publishable / anon 公钥')

# ---- 5. 读取目标 config.js，校验锚点唯一性 ----
src = open(TARGET, encoding='utf-8').read()
prod_re = re.compile(r"(prod:\s*\{\s*url:\s*)'[^']*'(\s*,\s*key:\s*)'[^']*'")
if len(prod_re.findall(src)) != 1:
    die('config.js prod profile 锚点不唯一，拒绝注入')
env_re = re.compile(r"(ACTIVE_ENV:\s*\(W\.LEDGER_ENV\s*\|\|\s*)'dev'(\s*\))")
if len(env_re.findall(src)) != 1:
    die('config.js ACTIVE_ENV 锚点不唯一，拒绝注入')

# ---- 6. 注入（仅输出副本；用 json.dumps 安全转义，避免引号注入）----
import json
def repl(m):
    return m.group(1) + json.dumps(url.strip()) + m.group(2) + json.dumps(key.strip())
out = prod_re.sub(repl, src, count=1)
out = env_re.sub(lambda m: m.group(1) + "'prod'" + m.group(2), out, count=1)

# ---- 7. 注入后自检（不输出值）----
d = re.search(r"dev:\s*\{\s*url:\s*'([^']*)'\s*,\s*key:\s*'([^']*)'", out)
t = re.search(r"test:\s*\{\s*url:\s*'([^']*)'\s*,\s*key:\s*'([^']*)'", out)
if not d or not t or d.group(1) or d.group(2) or t.group(1) or t.group(2):
    die('注入后自检失败：dev/test 应为空')
if url.strip() not in out or key.strip() not in out:
    die('注入后自检失败：prod 值未写入')

open(TARGET, 'w', encoding='utf-8').write(out)

# ---- 8. 只输出非敏感元数据：project ref 已脱敏为长度、key 类型 ----
print('[PASS] 注入成功：url=<https://%s.supabase.co> key_type=%s （值不输出）'
      % ('*' * len(project_ref), key_kind))
