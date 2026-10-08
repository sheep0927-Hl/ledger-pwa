/* ============================================================
 * 总账 Ledger — PWA 手机端
 * 后端：Supabase（沿用 macOS App 的同一项目与表 daily_records）
 * 工资逻辑：与 macOS LedgerApp 完全一致（助播不计入应发总额）
 * ============================================================ */

'use strict';

/* ---------- 1. Supabase 配置（与 macOS App SyncService 相同） ---------- */
const SUPABASE_URL = 'https://uvbspoyguzdhbthhhzxk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_TVpp4fWkDuzzsu4EZbBBvQ_ve5o1j_u';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ledger-pwa-auth' }
});

// ---- 方案A：会话镜像备份（绕过 iOS 偶发清空 Supabase 自带 storageKey）----
const SESSION_BACKUP_KEY = 'ledger-pwa-session-backup';
function saveSessionBackup(session) {
  if (!session || !session.access_token) return;
  try {
    const { access_token, refresh_token } = session;
    localStorage.setItem(SESSION_BACKUP_KEY, JSON.stringify({ access_token, refresh_token }));
  } catch (_) { /* 存储不可用时静默 */ }
}
function loadSessionBackup() {
  try {
    const raw = localStorage.getItem(SESSION_BACKUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function clearSessionBackup() {
  try { localStorage.removeItem(SESSION_BACKUP_KEY); } catch (_) {}
}
// 助播默认值规则（与 macOS LedgerApp addRecord 一致）
const ASSIST_CUTOFF = '2026-07-17';
function defaultAssist(dateStr) {
  return dateStr < ASSIST_CUTOFF ? 160 : 0;
}

// 助播可见性闸门（V2.5）：2026-08-01 起不再录入/显示助播输入项，但保存仍提交 assist=0
// 以保持字段级同步稳定、避免触发 DB 列 DEFAULT 160。历史记录（< 2026-08-01）原值不变。
const ASSIST_HIDE_FROM = '2026-08-01';
function isAssistVisible(dateStr) {
  return dateStr < ASSIST_HIDE_FROM;   // 2026-07-31 及以前显示；2026-08-01 起隐藏
}

/* ---------- 2. 工资计算参数（共享配置：Supabase public.profiles） ----------
 * 真值来源：Supabase public.profiles 的 7 个列。
 *          S1 第 4 步起为【Mac 端 ↔ 手机端 双向字段级写入】：
 *          两端都只 UPDATE 实际发生变化的列（partial update），不整份覆盖；
 *          同一字段冲突按 LWW（最后成功写入者生效），不同字段互不覆盖。
 * 加载优先级（见 initPriceConfig / refreshPriceConfig）：
 *   ① 本地缓存（IndexedDB meta.price_config）—— 先读，保证首屏即上次成功配置，离线也可用
 *   ② Supabase profiles                       —— 再拉，【逐字段】合并（本地脏字段保留并续推）
 *   ③ 下面这个 CONFIG 对象                     —— 仅当「本地无缓存 且 云端从未成功拉到」时的引导默认值
 * 铁律：网络失败【绝不】把价格回落到这里的硬编码值；失败时继续沿用上一次成功配置
 *      （有缓存用缓存，无缓存保持当前内存中的值）。只有「完全没有任何配置」才用本对象。
 * 调用点无需改动：仍是 CONFIG.price / CONFIG.notePrice / ...（对象属性可变，见 applyPriceConfig）。 */
const CONFIG = {
  price: 4,            // 出单单价（xhs / dy / refund 共用）
  notePrice: 4,        // 图文单价
  materialPrice: 4,    // 素材单价
  videoPrice: 30,      // 视频单价
  salaryThreshold: 20000, // 底薪达标线
  salaryHigh: 2000,    // 达标底薪（收入 > 达标线）
  salaryLow: 3000      // 未达标底薪
};

/* 共享配置：字段名 ↔ Supabase profiles 列名 映射
 * （必须与 macOS 端 Sources/PriceConfigService.swift 的 CloudPriceConfig.CodingKeys 一致） */
const PRICE_CONFIG_COLUMNS = {
  price: 'price',
  notePrice: 'note_price',
  materialPrice: 'material_price',
  videoPrice: 'video_price',
  salaryThreshold: 'salary_threshold',
  salaryHigh: 'salary_high',
  salaryLow: 'salary_low'
};
const PRICE_CONFIG_FIELDS = Object.keys(PRICE_CONFIG_COLUMNS);   // 7 个字段
const PRICE_CONFIG_CACHE_KEY = 'price_config';                   // IndexedDB meta 键名
const PRICE_CONFIG_SELECT = PRICE_CONFIG_FIELDS.map(function (k) { return PRICE_CONFIG_COLUMNS[k]; }).join(',');

/* S1 第 4 步（PWA 反向写）新增的 IndexedDB meta 键 —— 全部复用既有 meta store，不新建数据库 */
const CONFIG_PATCH_KEY = 'price_config_patch';                    // 待推送【字段级】patch（列名 → 正整数）
const CONFIG_BASELINE_KEY = 'price_config_baseline';              // 与云端一致时的基线（列名 → 正整数）
const CONFIG_PATCH_UID_KEY = 'price_config_patch_uid';            // patch 归属用户（防跨账号误推）

/* 当前配置来源：'default'（引导默认）| 'cache'（本地缓存）| 'cloud'（云端 profiles）。
 * 仅供诊断 / 自检展示，不参与任何计算。 */
let priceConfigSource = 'default';

/* ---------- 2b. 共享配置加载（缓存优先 → 云端覆盖；失败绝不回落硬编码） ---------- */

/**
 * 把 7 个参数写入 CONFIG。
 * 只接受「7 项齐全且均为正整数」的输入；任何一项缺失 / 非法都整组拒绝，
 * 避免出现半套配置（例如只有单价没有底薪）。返回是否应用成功。
 */
function applyPriceConfig(obj) {
  if (!obj) return false;
  const next = {};
  for (let i = 0; i < PRICE_CONFIG_FIELDS.length; i++) {
    const k = PRICE_CONFIG_FIELDS[i];
    const v = Number(obj[k]);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v <= 0) return false;
    next[k] = v;
  }
  Object.assign(CONFIG, next);
  return true;
}

/**
 * 从 Supabase profiles 拉取共享配置，并做【字段级合并】（S1 第 4 步）。
 *
 * 语义（必须与 Mac 端 PriceConfigService.pullAndApply 一致）：
 *   ① 逐字段处理：云端有值且本地【不脏】→ 接受云端；本地【脏】→ 保留本地并继续待推送；
 *      云端该列 NULL / 非法 → 不动本地（绝不把本地值当 0 或默认值覆盖）。
 *   ② 禁止「只要任意一个字段脏就整份配置不接受云端」的旧逻辑
 *      （Mac 端已在 S1 第 2 步废弃；PWA 本步同步废弃）。
 *   ③ 7 列全部无效 → 视为「云端尚未配置」：不改动 CONFIG / baseline，也不从 PWA 反向 bootstrap
 *      （PWA 不写云端初始配置，避免把本地缓存或硬编码默认值推成云端真值；bootstrap 由 Mac 端负责）。
 *   ④ 合并后若仍有待推送字段 → 立刻续推。
 * 失败时【不改动 CONFIG】，返回 false（沿用上一次成功配置，绝不回落硬编码）。
 */
async function refreshPriceConfig() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const uid = currentUser ? currentUser.id : null;
  if (!uid) return false;
  try {
    const { data, error } = await sb
      .from('profiles')
      .select(PRICE_CONFIG_SELECT)
      .eq('id', uid)
      .limit(1);
    if (error || !data || !data.length) return false;
    const cloud = data[0] || {};
    const merged = mergeCloudConfig(CONFIG, CONFIG_BASELINE, pendingConfigPatch, cloud);
    if (merged.unconfigured) return false;   // 云端尚未配置 → 不动（PWA 不 bootstrap）
    Object.assign(CONFIG, merged.config);
    CONFIG_BASELINE = merged.baseline;
    pendingConfigPatch = computeConfigPatch(CONFIG_BASELINE, CONFIG);   // 重新派生待推送集合
    priceConfigSource = 'cloud';
    await persistConfigState(uid);
    console.log('[PRICE_CONFIG] profiles 字段级合并: 接受=' + JSON.stringify(merged.accepted) +
                ' 保留本地=' + JSON.stringify(merged.kept) +
                ' 待推送=' + JSON.stringify(pendingConfigPatch));
    if (Object.keys(pendingConfigPatch).length) {
      try { await pushConfigPatch(); } catch (_) {}   // 本地脏字段续推
    }
    // S2c 第二阶段（方案 A）：安全状态下把最新云端价格被动回显到设置页输入框。
    // 纯展示层钩子，带三重守卫（非激活 / 有焦点 / 有暂存改动 → 全部跳过），默认 no-op，
    // 不改变本函数的合并 / dirty / patch 任何语义。
    syncSettingsPriceUI();
    return true;
  } catch (e) {
    console.warn('[PRICE_CONFIG] 拉取失败，沿用上一次成功配置: ' + (e && e.message));
    return false;
  }
}

/**
 * 启动（登录成功）时调用：
 *   ① 先读本地缓存 —— 保证首屏即上次成功配置，且离线可用；
 *   ② 再拉云端覆盖 —— 让「Mac 改价」无需重新部署 PWA 即可生效。
 * 两者都拿不到时才保持 CONFIG 的引导默认值（唯一的「完全没有任何配置」情形）。
 */
async function initPriceConfig() {
  let cache = null;
  try { cache = await LocalDB.getMeta(PRICE_CONFIG_CACHE_KEY); } catch (_) { cache = null; }
  if (applyPriceConfig(cache)) priceConfigSource = 'cache';
  // S2b：价格版本序列先读本地缓存（离线可用），再拉云端覆盖
  let vcache = null;
  try { vcache = await LocalDB.getMeta(PRICE_VERSIONS_CACHE_KEY); } catch (_) { vcache = null; }
  PRICE_VERSIONS = normalizeVersions(vcache);
  // S1 第 4 步：恢复【字段级 patch + baseline】—— 保证刷新/重启后待推送的改价不丢失
  await restoreConfigPatchState();
  await refreshPriceConfig();
  await refreshPriceVersions();
  console.log('[PRICE_CONFIG] source=' + priceConfigSource + ' ' + JSON.stringify(CONFIG));
}

/* ---------- 2d. 字段级双向同步（S1 第 4 步 · PWA 反向写） ----------
 * 目标：手机端也能改这 7 个参数并写回 Supabase，语义与 Mac 端
 *       Sources/PriceConfigService.swift 的「字段级 patch + dirty + baseline + LWW」完全一致。
 *
 * 关键不变量：
 *   pendingConfigPatch ≡ { 列名: 当前本地值 | baseline[列] ≠ 当前本地值 }
 *   —— 「dirty」就是「本地与上次已同步值不一致」的字段集合；
 *      baseline 前进一步，该字段自动脱离 dirty（= push 成功只清除成功字段）。
 *
 * 持久化（全部复用既有 IndexedDB meta store，不新建数据库）：
 *   price_config           —— 本地 7 参数快照（既有键，首屏 / 离线用）
 *   price_config_patch     —— 待推送字段级 patch（本步新增）
 *   price_config_baseline  —— 与云端一致时的基线（本步新增，判定「改了哪几字段」的参照物）
 *   price_config_patch_uid —— patch 归属用户（本步新增，防 A 账号待推送被 B 账号误推）
 *
 * 铁律：只 UPDATE 实际变化的列，绝不整份 7 字段覆盖；绝不写 updated_at；
 *      UI 只调 savePriceConfigPatch，不允许自己拼 payload / 操作 dirty / baseline。 */
let pendingConfigPatch = {};   // { 'video_price': 32, ... }（Supabase 列名 → 正整数）
let CONFIG_BASELINE = {};      // { 'video_price': 31, ... }（上次与云端一致的值）
let configPatchOwner = null;   // patch 归属的 uid
let isPushingConfig = false;   // pushConfigPatch 防重入

/* --- 纯函数（零 IO，可直接单测） --- */

/** Supabase 列名 → 本地 CONFIG 字段名；未知列名返回 null。 */
function configFieldOfColumn(col) {
  for (let i = 0; i < PRICE_CONFIG_FIELDS.length; i++) {
    const f = PRICE_CONFIG_FIELDS[i];
    if (PRICE_CONFIG_COLUMNS[f] === col) return f;
  }
  return null;
}

/**
 * 归一化 patch / 改动集合 → { 列名: 正整数 }。
 * 同时接受 'videoPrice'（字段名）与 'video_price'（列名）两种键；
 * 未知字段、非整数、≤0 一律【丢弃】（绝不当 0 / 默认值覆盖）。
 */
function normalizeConfigPatch(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    let col = null;
    if (configFieldOfColumn(key)) col = key;                     // 已是 Supabase 列名
    else if (PRICE_CONFIG_COLUMNS[key]) col = PRICE_CONFIG_COLUMNS[key];   // 本地字段名
    if (!col) continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) continue;
    out[col] = n;
  }
  return out;
}

/** 差分：本地与 baseline 不一致的字段 → patch（只含真正变化的字段）。纯函数。 */
function computeConfigPatch(baseline, config) {
  const patch = {};
  for (let i = 0; i < PRICE_CONFIG_FIELDS.length; i++) {
    const f = PRICE_CONFIG_FIELDS[i];
    const col = PRICE_CONFIG_COLUMNS[f];
    if (!baseline || baseline[col] !== config[f]) patch[col] = config[f];
  }
  return patch;
}

/** 同字段后者胜（LWW 纯函数基础）；不同字段互不覆盖。纯函数。 */
function mergeConfigPatch(a, b) {
  const out = Object.assign({}, a || {});
  const src = b || {};
  for (const k of Object.keys(src)) out[k] = src[k];
  return out;
}

/**
 * 【字段级合并】把云端 7 列合并进本地。纯函数（核心语义，可单测）。
 * @returns {{config, baseline, accepted, kept, unconfigured}}
 *   accepted     —— 本次接受云端的字段（本地不脏 且 与云端不同）
 *   kept         —— 保留本地、拒绝云端的字段（本地脏）
 *   unconfigured —— 7 列全部 NULL / 非法 → 云端尚未配置
 */
function mergeCloudConfig(config, baseline, pending, cloud) {
  const nextConfig = Object.assign({}, config);
  const nextBaseline = Object.assign({}, baseline || {});
  const accepted = {}, kept = {};
  let anyValid = false;
  for (let i = 0; i < PRICE_CONFIG_FIELDS.length; i++) {
    const f = PRICE_CONFIG_FIELDS[i];
    const col = PRICE_CONFIG_COLUMNS[f];
    const raw = cloud ? cloud[col] : null;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) continue;   // 云端 NULL/非法 → 不动本地
    anyValid = true;
    const dirty = !!(pending && Object.prototype.hasOwnProperty.call(pending, col));
    if (dirty) { kept[f] = nextConfig[f]; continue; }        // 本地脏 → 保留本地（baseline 不动）
    if (nextConfig[f] !== n) { accepted[f] = n; nextConfig[f] = n; }
    nextBaseline[col] = n;                                   // 该列与云端对齐
  }
  return { config: nextConfig, baseline: nextBaseline, accepted, kept, unconfigured: !anyValid };
}

/* --- 持久化（单一出口，避免漏存导致待推送丢失） --- */

async function persistConfigState(uid) {
  try { await LocalDB.setMeta(PRICE_CONFIG_CACHE_KEY, Object.assign({}, CONFIG)); } catch (_) {}
  try { await LocalDB.setMeta(CONFIG_PATCH_KEY, Object.assign({}, pendingConfigPatch)); } catch (_) {}
  try { await LocalDB.setMeta(CONFIG_BASELINE_KEY, Object.assign({}, CONFIG_BASELINE)); } catch (_) {}
  try { await LocalDB.setMeta(CONFIG_PATCH_UID_KEY, uid || (currentUser ? currentUser.id : null)); } catch (_) {}
}

/**
 * 启动 / 登录时恢复 patch + baseline。
 * 跨账号的 patch 不加载到内存（原样留在磁盘，等原账号回来再推），避免误推他人价格。
 */
async function restoreConfigPatchState() {
  let storedPatch = null, storedBase = null, owner = null;
  try { storedPatch = await LocalDB.getMeta(CONFIG_PATCH_KEY); } catch (_) {}
  try { storedBase = await LocalDB.getMeta(CONFIG_BASELINE_KEY); } catch (_) {}
  try { owner = await LocalDB.getMeta(CONFIG_PATCH_UID_KEY); } catch (_) {}
  const uid = currentUser ? currentUser.id : null;
  configPatchOwner = owner || null;
  pendingConfigPatch = (owner && uid && owner !== uid) ? {} : normalizeConfigPatch(storedPatch);
  CONFIG_BASELINE = (storedBase && typeof storedBase === 'object') ? Object.assign({}, storedBase) : {};
  // baseline 缺失（首次运行 / 旧版本升级）→ 以当前 CONFIG 作种子，
  // 保证「只改一个字段」只产出该字段的 patch（而非 7 个字段全被判为变化）。
  let seeded = false;
  for (let i = 0; i < PRICE_CONFIG_FIELDS.length; i++) {
    const f = PRICE_CONFIG_FIELDS[i];
    const col = PRICE_CONFIG_COLUMNS[f];
    if (typeof CONFIG_BASELINE[col] === 'undefined') { CONFIG_BASELINE[col] = CONFIG[f]; seeded = true; }
  }
  // patch 内的值一律以【当前本地值】为准（这样「改完又改回去」也能正确落库）
  const rebuilt = {};
  for (const col of Object.keys(pendingConfigPatch)) {
    const f = configFieldOfColumn(col);
    if (f) rebuilt[col] = CONFIG[f];
  }
  pendingConfigPatch = rebuilt;
  if (seeded || Object.keys(pendingConfigPatch).length) await persistConfigState(uid);
  console.log('[PRICE_CONFIG] 恢复字段级状态: patch=' + JSON.stringify(pendingConfigPatch) +
              ' baseline=' + JSON.stringify(CONFIG_BASELINE));
}

/* --- 写入：UI 唯一入口 --- */

/**
 * 【UI 唯一入口】修改本地 7 参数并反向写回云端（手机设置页只需调这一个函数）。
 *   ① 先改本地 CONFIG（立即生效，离线也生效）；
 *   ② 与 baseline 比较 → 只生成【真正变化】的字段；
 *   ③ 合并进已有 pendingConfigPatch 并持久化（离线也不丢）；
 *   ④ 尝试立即推送（离线 / 失败则保留 pending，等 online / autoPull 补推）。
 * UI 不允许自己拼 Supabase UPDATE payload，也不允许自己操作 dirty / baseline。
 * @param {object} changes {'video_price'|'videoPrice'|...: 正整数}（部分字段即可）
 * @returns {{ok:boolean, reason?:string, pushed?:boolean, pending:object}}
 */
async function savePriceConfigPatch(changes) {
  const fs = normalizeConfigPatch(changes);
  if (!Object.keys(fs).length) {
    return { ok: false, reason: 'no-valid-change', pending: Object.assign({}, pendingConfigPatch) };
  }
  const uid = currentUser ? currentUser.id : null;
  for (const col of Object.keys(fs)) {                 // ① 应用到本地
    const f = configFieldOfColumn(col);
    if (f) CONFIG[f] = fs[col];
  }
  configPatchOwner = uid;
  // ②③ 与 baseline 差分后并入 pending（同字段新值覆盖旧值，不同字段各自独立）
  pendingConfigPatch = mergeConfigPatch(pendingConfigPatch, computeConfigPatch(CONFIG_BASELINE, CONFIG));
  await persistConfigState(uid);
  console.log('[PRICE_CONFIG] 本地改价 ' + JSON.stringify(fs) + ' → pending=' + JSON.stringify(pendingConfigPatch));
  let pushed = false;                                  // ④ 尝试立即推送
  try { pushed = await pushConfigPatch(); } catch (_) { pushed = false; }
  return { ok: true, pushed, pending: Object.assign({}, pendingConfigPatch) };
}

/**
 * 把 pendingConfigPatch 写回 Supabase profiles —— 【字段级 UPDATE】。
 *   · 每个待推送字段单独一条 UPDATE，payload 只含该列 → 绝不顺带覆盖另外 6 个字段；
 *   · 不修改 updated_at；
 *   · 成功后：该列 baseline 前进到【本次推送的值】→ pending 自动剔除该列（只清除成功字段）；
 *   · 部分失败：失败字段继续留在 pendingConfigPatch，等 online / autoPull 补推；
 *   · 同字段并发修改 → 后成功写入者生效（LWW，由数据库写入顺序决定，本函数不另设冲突解决）。
 * @returns {boolean} 是否全部成功（无待推送时返回 true）
 */
async function pushConfigPatch() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (isPushingConfig) return false;                    // 防重入（autoPull / online / UI 并发）
  const uid = currentUser ? currentUser.id : null;
  if (!uid) return false;
  const snapshot = Object.assign({}, pendingConfigPatch);   // 本次要推的值（推送期间本地再改不影响判定）
  const cols = Object.keys(snapshot);
  if (!cols.length) return true;
  if (configPatchOwner && configPatchOwner !== uid) return false;   // 跨账号保护：不推他人 patch
  isPushingConfig = true;
  let allOk = true;
  try {
    try { await ensureSession(); } catch (_) {}   // 尽量刷新会话；失败也让写入自然失败并保留 pending
    const succeeded = [];
    for (const col of cols) {
      if (!configFieldOfColumn(col)) continue;    // 未知列名不推
      let err = null;
      try {
        const res = await sb.from('profiles').update({ [col]: snapshot[col] }).eq('id', uid);
        err = (res && res.error) ? res.error : null;
      } catch (e) { err = e; }
      if (err) { allOk = false; console.warn('[PRICE_CONFIG] 推送失败（字段保留待推送）' + col + ': ' + (err.message || err)); }
      else succeeded.push(col);
    }
    for (const col of succeeded) {                // 只清除【成功】字段
      const f = configFieldOfColumn(col);
      if (f) { CONFIG_BASELINE[col] = snapshot[col]; configPatchOwner = uid; }
    }
    pendingConfigPatch = computeConfigPatch(CONFIG_BASELINE, CONFIG);
    await persistConfigState(uid);
    console.log('[PRICE_CONFIG] 推送完成 成功=' + succeeded.length + '/' + cols.length +
                ' 剩余待推送=' + JSON.stringify(pendingConfigPatch));
    // S2c：价格字段【确实写进云端】之后，再单独记一个价格版本节点。
    // 要求全部列成功（部分失败时云端是「半更新」状态，等补推全部成功那次再记，避免留下错误快照）；
    // 版本写入失败只记待重试，绝不回滚 / 影响上面已成功的价格字段。
    if (allOk && succeeded.length === cols.length) {
      try { await recordPriceVersion(); } catch (_) {}
    }
    return allOk;
  } finally {
    isPushingConfig = false;
  }
}

/* 诊断入口（只读，供排查与自动化验证使用；不参与业务） */
window.__priceConfigPatch = function () {
  return {
    pending: Object.assign({}, pendingConfigPatch),
    baseline: Object.assign({}, CONFIG_BASELINE),
    owner: configPatchOwner,
    config: Object.assign({}, CONFIG),
    online: (typeof navigator !== 'undefined') ? (navigator.onLine !== false) : true
  };
};
// 手机设置页（后续阶段）接线的唯一入口 —— 显式挂到 window，契约明确
window.savePriceConfigPatch = savePriceConfigPatch;

/* 诊断入口（只读，供排查与自动化验证使用；不参与业务） */
window.__priceConfig = function () {
  return { source: priceConfigSource, config: Object.assign({}, CONFIG) };
};

/* ---------- 2c. 价格版本（历史账务价格锁定 · S2b） ----------
 * 目的：与 macOS 端 Sources/PriceVersion.swift 保持【完全相同的语义】——
 *      金额按【记录自己的日期】取当时生效的价格，而不是永远用当前 CONFIG。
 *      这样改价只影响改价之后的新记录，已发生的历史账务不被追改。
 * 真值来源：Supabase public.profiles.price_versions（JSONB 数组，见迁移 09）。
 * 语义契约（必须与 Mac 端一致）：
 *   1) 版本按 from 升序；取「from <= 目标日期」的最后一个。
 *   2) 目标日期早于最早版本 → 用最早版本（界点 2026-10-04 之前统一按首版假定）。
 *   3) 版本序列为空 / 全部非法 → 回退当前 CONFIG（与改造前行为完全一致）。
 *   4) 月份口径：用 "YYYY-MM-31" 作该月最后一天的字符串哨兵 → 该月最后生效的版本。
 *
 * 读 + 写（S2c 起本模块也可写）：
 *   · 读：refreshPriceVersions 拉云端并合并本地待重试版本（绝不抹掉尚未上云的节点）。
 *   · 写：recordPriceVersion —— 只有【用户主动改价 + 价格字段成功写云端】才追加一个节点，
 *        与价格字段【分离写】；迁移 09 未执行 / 网络失败 → 记待重试，绝不影响价格字段同步。
 *   · pull / bootstrap 一律【不】产生版本（只有用户主动改价才会）。 */
let PRICE_VERSIONS = [];                          // [{from:'2026-10-04', price, notePrice, ...}]
const PRICE_VERSIONS_CACHE_KEY = 'price_versions';
const PRICE_VERSIONS_PENDING_KEY = 'price_versions_pending';   // S2c：写云端失败 → 待重试的版本节点
const PRICE_VERSION_FROM_KEY = 'from';

/** 校验并归一化版本数组（剔除非法项、按 from 升序）。纯函数。 */
function normalizeVersions(raw) {
  if (!Array.isArray(raw)) return [];
  const ok = [];
  for (const v of raw) {
    if (!v || typeof v[PRICE_VERSION_FROM_KEY] !== 'string') continue;
    const item = { from: v[PRICE_VERSION_FROM_KEY] };
    let valid = true;
    for (const k of PRICE_CONFIG_FIELDS) {
      const n = Number(v[k]);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) { valid = false; break; }
      item[k] = n;
    }
    if (valid) ok.push(item);
  }
  return ok.sort((a, b) => a.from.localeCompare(b.from));
}

/**
 * 追加/合并一个版本节点：同一天只保留一条（同日旧条目被新值覆盖）。
 * 与 Mac 端 PriceHistory.upserting 语义完全一致。纯函数。
 * 非法节点（from 非字符串 / 任一值非正整数）→ 原样返回归一化序列（丢弃该节点）。
 */
function upsertVersion(v, seq) {
  const list = normalizeVersions(seq).filter((x) => x.from !== (v && v[PRICE_VERSION_FROM_KEY]));
  const one = normalizeVersions([v]);
  if (!one.length) return list;
  list.push(one[0]);
  return list.sort((a, b) => a.from.localeCompare(b.from));
}

/** 由当前 CONFIG 构造一个版本节点（from = 推送成功当天）。纯函数。 */
function buildVersionFromConfig(dateStr) {
  const v = { from: dateStr };
  for (const k of PRICE_CONFIG_FIELDS) v[k] = CONFIG[k];
  return v;
}

/** 取某日期生效的 7 参数；无版本序列时回退 CONFIG。纯函数。 */
function configAt(dateStr) {
  if (!PRICE_VERSIONS.length) return CONFIG;
  let picked = null;
  for (const v of PRICE_VERSIONS) {
    if (v.from <= dateStr) picked = v; else break;   // 已升序，遇到未来版本即可停
  }
  return picked || PRICE_VERSIONS[0];                // 早于最早版本 → 用最早版本
}

/** 取某月份生效的 7 参数（口径：该月最后一天生效的版本）。纯函数。 */
function configForMonth(ym) { return configAt(ym + '-31'); }

/** 一组记录的「最早月份」（与 Mac 端 rs.first?.month 的推导口径对齐）。 */
function earliestMonth(recs) {
  let min = '';
  for (const r of recs) { if (r && r.date && (!min || r.date < min)) min = r.date; }
  return min ? min.slice(0, 7) : '';
}

/** 单条记录金额（按其自身日期取价；与 Mac 端 store.outAmount/grossAmount/totalAmount 同口径）。 */
function recordOut(r) {
  return (num(r.xhs) + num(r.dy) - num(r.refund)) * configAt(r.date).price;
}
function recordGross(r) {
  const c = configAt(r.date);
  return num(r.note_qty) * c.notePrice + num(r.material_qty) * c.materialPrice + num(r.video_qty) * c.videoPrice;
}
function recordTotal(r) { return recordOut(r) + num(r.assist) + recordGross(r); }

/**
 * 【容错】拉取 profiles.price_versions。
 * 迁移 09 未执行（列不存在）/ 网络失败 / 空值 → 保留现有序列并返回 false，
 * 绝不回落、绝不打断调用方（序列为空时 configAt 自动回退 CONFIG）。
 */
async function refreshPriceVersions() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const uid = currentUser ? currentUser.id : null;
  if (!uid) return false;
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('price_versions')
      .eq('id', uid)
      .limit(1);
    if (error || !data || !data.length) return false;
    const cloud = normalizeVersions(data[0] && data[0].price_versions);
    // S2c：合并【本地待重试版本】—— 尚未成功上云的节点绝不能被云端序列抹掉
    const pending = await loadPendingVersions();
    let merged = cloud;
    for (const v of pending) merged = upsertVersion(v, merged);
    if (!merged.length) return false;
    // 仍有待重试版本 → 借这次拉取机会重试写入（成功即清空；失败保留，下次再试）
    if (pending.length && await pushVersionsToCloud(merged)) {
      await savePendingVersions([]);
    }
    PRICE_VERSIONS = merged;
    try { await LocalDB.setMeta(PRICE_VERSIONS_CACHE_KEY, merged); } catch (_) {}
    console.log('[PRICE_VERSIONS] 已应用 ' + merged.length + ' 版: ' + merged.map((v) => v.from).join(',') +
                (pending.length ? '（含待重试 ' + pending.length + ' 项）' : ''));
    return true;
  } catch (e) {
    console.warn('[PRICE_VERSIONS] 拉取跳过（列不存在或网络失败，保持现有序列）: ' + (e && e.message));
    return false;
  }
}

/* --- S2c：改价自动追加版本（写路径） ---------------------------------------
 *
 * 只有【用户主动改价 + 价格字段成功写云端】才产生版本节点：
 *   pushConfigPatch 全部列成功后 → recordPriceVersion()
 *   · 节点 = 完整 7 值快照（所以「一次改多个字段」只产生 1 个节点）；
 *   · from = 推送成功当天（todayStr()）；
 *   · 同日再次改价 → upsert 覆盖当天那条（与 Mac 端 PriceHistory.upserting 同语义）；
 *   · 与价格字段【分离写】：价格列先写成功，再单独写 price_versions。
 *     写入失败 → 记入 price_versions_pending 待重试，【绝不】回滚已成功的价格字段、绝不断链。
 *   · pull 接受云端值 / 本地 bootstrap 都【不】产生版本。
 */

/** 读本地待重试版本（IndexedDB meta）。读失败 → 空数组，不影响主流程。 */
async function loadPendingVersions() {
  try { return normalizeVersions(await LocalDB.getMeta(PRICE_VERSIONS_PENDING_KEY)); } catch (_) { return []; }
}

/** 覆盖写待重试版本；空 → 写入空数组清空（LocalDB 无 delMeta，setMeta(key,[]) 语义等价）。 */
async function savePendingVersions(list) {
  try { await LocalDB.setMeta(PRICE_VERSIONS_PENDING_KEY, normalizeVersions(list)); } catch (_) {}
}

/** 读云端版本序列；null = 读失败（列不存在 / 网络失败 / 无行）。 */
async function fetchCloudVersions(uid) {
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('price_versions')
      .eq('id', uid)
      .limit(1);
    if (error || !data || !data.length) return null;
    return normalizeVersions(data[0] && data[0].price_versions);
  } catch (_) { return null; }
}

/**
 * 把版本序列写进 profiles.price_versions。
 *   ① 先尽力读云端并合并（保留对端已写入、本地尚未拉到的其他日期版本）；
 *   ② 再让【本地序列】覆盖同日节点（本地这次写入在后 → LWW）；
 *   ③ 断言命中 1 行，绝不把「HTTP 200 但 0 行」当成写成功。
 * @returns {boolean} 是否确实写成功（列不存在 / 网络失败 / 无行 → false）
 */
async function pushVersionsToCloud(localSeq) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const uid = currentUser ? currentUser.id : null;
  if (!uid) return false;
  const cloud = await fetchCloudVersions(uid);
  let target = cloud || [];
  for (const v of normalizeVersions(localSeq)) target = upsertVersion(v, target);
  target = normalizeVersions(target);
  if (!target.length) return false;
  try {
    const res = await sb
      .from('profiles')
      .update({ price_versions: target })
      .eq('id', uid)
      .select('price_versions');
    if (res && res.error) throw res.error;
    const rows = (res && res.data) ? res.data : [];
    return rows.length === 1;
  } catch (e) {
    console.warn('[PRICE_VERSIONS] 写入跳过（列不存在或网络失败，价格字段同步不受影响）: ' + (e && e.message));
    return false;
  }
}

/**
 * 【改价后】记录一个价格版本节点（本地立即生效 + 尝试写云端）。
 * 由 pushConfigPatch 在【价格字段全部成功】后调用；不抛错、不阻断调用方。
 * @returns {boolean} 是否已成功写入云端（false = 已记待重试）
 */
async function recordPriceVersion() {
  const uid = currentUser ? currentUser.id : null;
  if (!uid) return false;
  const version = buildVersionFromConfig(todayStr());
  if (!normalizeVersions([version]).length) return false;     // 本地配置非法 → 不记
  // ① 本地立即 upsert（历史锁定即时生效；离线也可用）
  PRICE_VERSIONS = upsertVersion(version, PRICE_VERSIONS);
  try { await LocalDB.setMeta(PRICE_VERSIONS_CACHE_KEY, PRICE_VERSIONS); } catch (_) {}
  // ② 单独写云端；失败 → 记待重试（价格字段已成功，绝不回滚）
  if (await pushVersionsToCloud(PRICE_VERSIONS)) {
    await savePendingVersions([]);
    console.log('[PRICE_VERSIONS] 📌 已记录改价版本: ' + version.from + '（共 ' + PRICE_VERSIONS.length + ' 版）');
    return true;
  }
  await savePendingVersions(upsertVersion(version, await loadPendingVersions()));
  console.warn('[PRICE_VERSIONS] ⚠️ 版本写入失败（已记待重试，价格字段不受影响）: ' + version.from);
  return false;
}

/* 诊断入口（只读） */
window.__priceVersions = function () {
  return {
    count: PRICE_VERSIONS.length,
    versions: PRICE_VERSIONS.map((v) => Object.assign({}, v)),
    pending: null   // 由 __priceVersionsPending 异步读取（诊断用，不参与业务）
  };
};

/* 诊断入口：读取本地待重试版本（异步） */
window.__priceVersionsPending = function () { return loadPendingVersions(); };
/* 诊断入口：手动触发一次版本写入（仅自动化验证使用） */
window.__recordPriceVersion = recordPriceVersion;

/* ---------- 3. 全局状态 ---------- */
let records = [];              // 当前用户全部记录（date 倒序）
let tombstonedDates = new Set(); // 云端已知已删除（tombstone）日期集合（V2.3-E 显式恢复检测用）
let currentUser = null;
let hasMaterialColumn = true;  // 云端是否存在 material_qty 列（探测得出）
let hasFieldStamps = false;    // 云端是否存在 *_modified_at 字段级时间戳列（迁移05执行后为 true）
let hasDeletedColumn = true;   // 云端是否存在 deleted_at 软删除列（迁移06执行后为 true）
let autoPullTimer = null;      // 自动拉取定时器句柄（避免重复启动多个定时器）
let todayDirty = false;        // V3.0.1：今日表单存在未保存的手动输入（仅展示层守卫，不参与同步/合并）

const FIELDS = ['xhs', 'dy', 'refund', 'assist', 'note_qty', 'material_qty', 'video_qty'];

// 字段 → 云端字段级时间戳列名（与 supabase/05 迁移一致；需与 macOS SyncService.CloudRecord 对齐）
const STAMP_COL = {
  xhs: 'xhs_modified_at',
  refund: 'refund_modified_at',
  dy: 'dy_modified_at',
  assist: 'assist_modified_at',
  note_qty: 'note_qty_modified_at',
  video_qty: 'video_qty_modified_at',
  material_qty: 'material_qty_modified_at'
};
const STAMP_KEYS = Object.values(STAMP_COL);

/* ---------- 4. 工具函数 ---------- */
const $ = (id) => document.getElementById(id);
const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : Math.max(0, n); };

function todayStr() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

function firstDayOfMonth(dateStr) { return dateStr.slice(0, 7) + '-01'; }
function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.slice(0, 7).split('-').map(Number);
  const d = new Date(y, m, 0); // 下个月第0天=本月最后一天
  return `${y}-${String(m).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtMoney(n) { return '¥' + (n || 0).toLocaleString('zh-CN'); }

function nowISO() { return new Date().toISOString(); }

/**
 * 计算某字段上传时应携带的时间戳（字段级 LWW 用）：
 * - 该日期已有记录且字段值与本地镜像相同（用户未改该字段）→ 沿用已加载的真实时间戳，不抢写；
 * - 字段值被改动，或该日期为全新记录 → 打当前时间，宣称本端最新。
 */
function stampFor(existing, field, newValue, now) {
  if (existing && num(existing[field]) === num(newValue)) {
    return (existing.modifiedAt && existing.modifiedAt[field]) || now;
  }
  return now;
}

function showBanner(text, kind) {
  const b = $('global-banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.textContent = text;
  b.className = 'banner ' + (kind || 'warn');
}

/* ---------- 5. 认证 ---------- */
async function tryRestoreSession() {
  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    currentUser = data.session.user;
    saveSessionBackup(data.session);
    await onLoggedIn();
    return;
  }
  // 优先 getSession 丢失时，尝试用本地镜像恢复
  const backup = loadSessionBackup();
  if (backup && backup.access_token && backup.refresh_token) {
    try {
      const { data: restoredData, error } =
        await sb.auth.setSession({ access_token: backup.access_token, refresh_token: backup.refresh_token });
      if (restoredData && restoredData.session) {
        currentUser = restoredData.session.user;
        saveSessionBackup(restoredData.session);
        await onLoggedIn();
        return;
      }
      if (error) console.warn('setSession 恢复失败:', error.message);
    } catch (e) {
      console.warn('setSession 恢复异常:', e);
    }
  }
  showLogin();
}

sb.auth.onAuthStateChange((_event, session) => {
  if (session && session.user) {
    currentUser = session.user;
    saveSessionBackup(session);
  } else {
    currentUser = null;
    clearSessionBackup();
  }
});

async function handleLogin(e) {
  e.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  const msg = $('login-msg');
  const btn = $('login-btn');
  msg.textContent = '';
  if (!email || !password) { msg.textContent = '请输入邮箱和密码'; return; }
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    await onLoggedIn();
  } catch (err) {
    msg.textContent = '登录失败：' + (err.message || err);
  } finally {
    btn.disabled = false; btn.textContent = '登录';
  }
}

async function handleLogout() {
  await sb.auth.signOut();
  currentUser = null;
  records = [];
  stopAutoPull();     // 退出登录时停止自动拉取
  clearSessionBackup();
  showLogin();
}

function showLogin() {
  $('login-view').classList.remove('hidden');
  $('app').classList.add('hidden');
}

async function onLoggedIn() {
  $('login-view').classList.add('hidden');
  $('app').classList.remove('hidden');
  // 2026-10-04 共享配置：先对齐工资参数（本地缓存 → 云端 profiles），再加载/渲染记录。
  // 必须早于 loadRecords()/renderHistory()：历史页与工资页的金额直接依赖 CONFIG。
  // 失败时保留上一次成功配置（有缓存用缓存），绝不回落到硬编码 4/4/30。
  await initPriceConfig();
  await loadRecords();
  startAutoPull();   // 登录成功后启动自动拉取（每 30 秒刷新）
  updateSyncStatus();
  if (navigator.onLine) flushPending();   // 启动即补推（fire-and-forget）
  if (navigator.onLine) pushConfigPatch();   // S1 第 4 步：改价待推送也一并补推（fire-and-forget）
  initTodayForm();
  initSalaryDefaults();
  switchTab('today');
}

/* ---------- 6. 数据读写 ---------- */
async function loadRecords() {
  const uid = currentUser ? currentUser.id : null;
  // 1. 读取本地镜像（优先，保证离线/弱网也能展示）
  let localRows = [];
  try { if (uid) localRows = await LocalDB.getAllRecords(uid); } catch (_) { localRows = []; }

  // 2. 在线则尝试从云端拉取；成功则以云端为准写回 IDB（保留本地独有记录，避免覆盖丢失）
  let cloudOk = false;
  if (navigator.onLine) {
    try {
      const { data, error } = await sb
        .from('daily_records')
        .select('*')
        .order('date', { ascending: false });
      if (!error && data) {
        cloudOk = true;
        refreshTombstonedDates(data);   // 刷新"已删除日期"集合（过滤前、用原始云端数据）
        const cloudRows = (data || []).map(normalizeRecord).filter((r) => !r.deletedAt);
        // 合并：云端为准；本地独有（云端无同 date 且未删除）记录保留，防离线新增被回拉覆盖丢失
        const cloudDates = new Set((data || []).map((r) => r.date));
        const localOnly = localRows.filter((r) => !cloudDates.has(r.date) && !r.deletedAt);
        const merged = cloudRows.concat(localOnly);
        for (const r of merged) {
          try { await LocalDB.putRecord(Object.assign({}, r, { user_id: uid })); } catch (_) {}
        }
        // 探测列是否存在：仅云端成功时重新判定（兼容滚动升级）
        const hasAny = !!(data && data.length);
        hasMaterialColumn = hasAny && ('material_qty' in (data[0] || {}));
        hasFieldStamps = hasAny && ('xhs_modified_at' in (data[0] || {}));
        hasDeletedColumn = hasAny && ('deleted_at' in (data[0] || {}));
        try { await LocalDB.setMeta('lastSyncAt', new Date().toISOString()); } catch (_) {}
        localRows = merged;
      }
    } catch (_) { cloudOk = false; }
  }

  // 3. 离线或云端失败：使用本地镜像
  if (!cloudOk) {
    if (!navigator.onLine) {
      showBanner(localRows.length ? '离线模式：显示本地缓存记录' : '离线模式：暂无本地缓存记录', 'warn');
    } else {
      showBanner(localRows.length ? '云端读取失败，显示本地缓存记录' : '云端读取失败，无本地缓存', 'error');
    }
  }

  // 4. 软删除过滤（与旧逻辑一致），设置内存 records（数据结构不变）
  records = localRows.filter((r) => !r.deletedAt);
  renderHistory();
  renderToday();
}

/** 启动自动拉取：每 30 秒从云端重新读取 daily_records。
 *  重复调用安全——若已有定时器则直接跳过，避免叠加多个 setInterval。 */
function startAutoPull() {
  if (autoPullTimer !== null) return;
  autoPullTimer = setInterval(async () => {
    console.log('[TEMP-DEBUG] AUTOPULL', todayDirty);   // 探针6：30s 自动拉取时 dirty 状态
    // 2026-10-04 共享配置：先对齐工资参数，再 loadRecords（后者内部会重绘历史/今日）。
    // 这样 Mac 端改完价，已打开的 PWA 最多 30 秒后金额自动跟上，无需重新部署或手动刷新。
    try { await refreshPriceConfig(); } catch (_) {}
    try { await refreshPriceVersions(); } catch (_) {}   // S2b：历史价格版本同步跟上
    try { await pushConfigPatch(); } catch (_) {}        // S1 第 4 步：改价待推送补推（离线残留）
    loadRecords();                 // 双向同步（行为不变）
    updateSyncStatus();            // 刷新待同步计数显示
    if (navigator.onLine) flushPending();   // 定时补推（flushPending 自带防重入）
  }, 30000);
}

/** 停止自动拉取并清理定时器（退出登录时调用）。 */
function stopAutoPull() {
  if (autoPullTimer !== null) {
    clearInterval(autoPullTimer);
    autoPullTimer = null;
  }
}

function normalizeRecord(r) {
  return {
    id: r.id,
    date: r.date,
    xhs: num(r.xhs), dy: num(r.dy), refund: num(r.refund),
    assist: num(r.assist), note_qty: num(r.note_qty),
    material_qty: num(r.material_qty), video_qty: num(r.video_qty),
    updated_at: r.updated_at,
    deletedAt: r.deleted_at || null,   // 软删除时间戳（06 迁移未执行时为 null；非 null 即已删除）
    // 字段级时间戳（迁移05未执行时云端无这些列 → 全为 null，saveRecord 会自动降级为整条同步）
    modifiedAt: {
      xhs: r.xhs_modified_at || null,
      refund: r.refund_modified_at || null,
      dy: r.dy_modified_at || null,
      assist: r.assist_modified_at || null,
      note_qty: r.note_qty_modified_at || null,
      video_qty: r.video_qty_modified_at || null,
      material_qty: r.material_qty_modified_at || null
    }
  };
}

function findRecord(date) { return records.find((r) => r.date === date); }

/* ---------- 推送诊断日志（[PWA_PUSH]）+ 会话状态辅助 ---------- */
function sessState() {
  if (!currentUser) return 'none';
  try {
    const raw = localStorage.getItem('ledger-pwa-auth');
    if (raw) {
      const p = JSON.parse(raw);
      const exp = p && (p.expires_at || (p.session && p.session.expires_at));
      if (exp && Date.now() / 1000 > exp) return 'expired';
    }
  } catch (_) {}
  return 'authed';
}
function logPush({ date, assist, payload, session, result, error }) {
  const p = (typeof payload === 'string') ? payload : JSON.stringify(payload);
  console.log(
    `[PWA_PUSH]\n` +
    `date=${date}\n` +
    `assist=${assist ?? '-'}\n` +
    `payload=${p}\n` +
    `session=${session}\n` +
    `result=${result}\n` +
    `error=${error || '-'}`
  );
}
// 重放/补推前确认并刷新会话，避免 token 失效 → 持续 401 → outbox 永卡
async function ensureSession() {
  let s = null;
  try { const { data } = await sb.auth.getSession(); s = data && data.session; } catch (_) {}
  if (!s || (s.expires_at && Date.now() / 1000 > s.expires_at)) {
    const backup = loadSessionBackup();
    if (backup && backup.refresh_token) {
      try {
        const r = await sb.auth.setSession({ access_token: backup.access_token, refresh_token: backup.refresh_token });
        s = r.data && r.data.session;
      } catch (_) { s = null; }
    }
  }
  return !!s;
}

/**
 * 扫描云端原始行，刷新"已删除日期"集合（V2.3-E 显式恢复检测用）。
 * - 行 deleted_at 非空 → 记为已删除；
 * - 行 deleted_at 为空（含整条消失）→ 从集合中移除，避免陈旧 tombstone 误触发恢复确认。
 * 调用时机：loadRecords 拉到云端数据后、过滤 tombstone 之前。
 */
function refreshTombstonedDates(rawRows) {
  for (const r of (rawRows || [])) {
    if (r.deleted_at) tombstonedDates.add(r.date);
    else tombstonedDates.delete(r.date);
  }
}

/** 该日期云端是否存在 tombstone（供保存前判断是否需弹"恢复确认"）。 */
function isDateTombstoned(date) { return tombstonedDates.has(date); }

/* ---------- Supabase 上传共享函数（即时保存与离线补推复用，行为完全一致） ---------- */

// 保存：upsert + 列缺失降级重试（与 V2.1 同步逻辑一致）。返回 error（null=成功）。
async function upsertWithFallbacks(payload) {
  let { error } = await sb.from('daily_records').upsert(payload, { onConflict: 'user_id,date' });
  if (error && /material_qty/i.test(error.message || '')) {
    hasMaterialColumn = false;
    showBanner('云端尚未添加 material_qty 列，素材数量暂不会保存到云端。请在 Supabase SQL Editor 运行 04_add_material_qty.sql。', 'warn');
    delete payload.material_qty;
    ({ error } = await sb.from('daily_records').upsert(payload, { onConflict: 'user_id,date' }));
  }
  if (error && /modified_at|42703/i.test(error.message || '')) {
    hasFieldStamps = false;
    STAMP_KEYS.forEach((k) => delete payload[k]);
    showBanner('云端尚未添加字段级时间戳列，已降级为整条同步。请在 Supabase SQL Editor 运行 05_add_field_modified_at.sql。', 'warn');
    ({ error } = await sb.from('daily_records').upsert(payload, { onConflict: 'user_id,date' }));
  }
  if (error && /deleted_at/i.test(error.message || '')) {
    hasDeletedColumn = false;
    delete payload.deleted_at;
    showBanner('云端尚未添加 deleted_at 列，删除将退化为物理删除。请在 Supabase SQL Editor 运行 06_add_deleted_at.sql。', 'warn');
    ({ error } = await sb.from('daily_records').upsert(payload, { onConflict: 'user_id,date' }));
  }
  logPush({ date: payload.date, assist: payload.assist, payload: payload, session: sessState(), result: error ? 'failed' : 'success', error: (error && error.message) || '-' });
  return error || null;
}

// 删除：软删除 tombstone（deleted_at 优先规则不变）；列不存在则降级物理删除。返回 error。
async function cloudDelete(date, deletedAt) {
  let { error } = await sb.from('daily_records').upsert({ user_id: currentUser.id, date, deleted_at: deletedAt }, { onConflict: 'user_id,date' });
  if (error && /deleted_at/i.test(error.message || '')) {
    hasDeletedColumn = false;
    showBanner('云端尚未添加 deleted_at 列，删除将退化为物理删除。请在 Supabase SQL Editor 运行 06_add_deleted_at.sql。', 'warn');
    ({ error } = await sb.from('daily_records').delete().eq('user_id', currentUser.id).eq('date', date));
  }
  return error || null;
}

/**
 * upsert 一条记录（新增或修改）。onConflict user_id,date 与 macOS 一致。
 * 字段级同步：仅被改动的字段打当前时间戳，未改动的字段沿用云端已有时间戳，避免整条覆盖丢字段。
 * 若云端缺少 material_qty 或 *_modified_at 列，自动去掉对应字段重试，并提示用户执行迁移 SQL。
 */
async function saveRecord(rec, revive = false) {
  logPush({ date: rec.date, assist: rec.assist, payload: 'save-start', session: sessState(), result: 'start', error: '-' });
  if (!currentUser) throw new Error('未登录');
  const uid = currentUser.id;
  const existing = findRecord(rec.date);   // 改前镜像（含 modifiedAt），用于字段级 LWW，顺序不可变
  // 字段级 dirty payload（方案 C · V2.2.1 Phase A）：
  //  - 仅本端实际改动的字段进入上传负载（值比较 dirty 判定，与 macOS 对称）；
  //  - 未改动的字段与其时间戳一律省略 → 服务端整列保留（含对端离线写入的值），修复字段级 LWW 失效（Test 5）；
  //  - 新建记录（本端内存无镜像）→ 发全列，规避 PostgREST INSERT 路径未提供列被 NULL 化；
  //  - deleted_at 删除优先保护见下方（修复 Test 6 tombstone 复活）。
  // 说明：复用现有 findRecord 得到的「改前内存镜像」做值比较，不引入本地元数据、不改动 LocalDB / outbox。
  const payload = { user_id: uid, date: rec.date };
  const now = nowISO();
  const isNew = !existing;   // 本端内存无该 date 镜像 = 新建记录
  for (const field of FIELDS) {
    if (field === 'material_qty' && !hasMaterialColumn) continue;   // 列不存在则跳过
    const next = num(rec[field]);
    const prev = existing ? num(existing[field]) : undefined;
    if (isNew || prev !== next) {
      payload[field] = next;
      if (hasFieldStamps) payload[STAMP_COL[field]] = now;   // 改动或新建 → 打当前时间（字段级 LWW）
    }
    // 未改动字段：省略其值与时间戳，服务端保留对端值（关键修复点）
  }

  // 软删除保护 + 显式恢复（V2.3-A 删除优先 + V2.3-E 显式恢复）：
  //  - 普通 / 新建保存（revive=false）：省略 deleted_at，服务端保留其现有 tombstone（删除优先，保 Test 6/7）。
  //  - 用户显式确认恢复（revive=true）：发送 deleted_at = null，主动清除云端 tombstone。
  // 关键：deleted_at=null 仅在「人类确认恢复」这一出口出现，自动路径与 V2.3-A 字节一致，不破坏删除优先。
  if (hasDeletedColumn && revive) {
    payload.deleted_at = null;   // 仅在用户确认恢复时清除 tombstone
  }

  // 1. 更新内存 records（立即反映 UI；保留 modifiedAt 供后续 LWW 比较）
  const idx = records.findIndex((r) => r.date === rec.date);
  if (idx >= 0) {
    records[idx] = Object.assign({}, records[idx], rec);
  } else {
    records.push({
      date: rec.date,
      xhs: num(rec.xhs), dy: num(rec.dy), refund: num(rec.refund),
      assist: num(rec.assist), note_qty: num(rec.note_qty),
      material_qty: num(rec.material_qty), video_qty: num(rec.video_qty),
      updated_at: null, deletedAt: null,
      modifiedAt: { xhs: null, refund: null, dy: null, assist: null, note_qty: null, video_qty: null, material_qty: null }
    });
  }

  // 2. 写本地 IDB（立即持久化，离线也不丢）
  const localRec = Object.assign({}, idx >= 0 ? records[idx] : records[records.length - 1], { user_id: uid });
  try { await LocalDB.putRecord(localRec); } catch (_) { /* IDB 不可用则降级纯内存 */ }

  // 3. 尝试 Supabase（失败不致命，数据已留本地）
  let error = null;
  try { error = await upsertWithFallbacks(payload); } catch (e) { error = e; }

  if (error) {
    // 上传失败：写入 outbox 待同步队列（本地数据已落 LocalDB，绝不丢失）
    try {
      await LocalDB.putPending({ date: rec.date, action: 'save', payload: payload, createdAt: nowISO() });
    } catch (_) { /* IDB 不可用则仅保留内存提示 */ }
    logPush({ date: rec.date, assist: payload.assist ?? rec.assist, payload: 'outbox', session: sessState(), result: 'failed', error: (error && error.message) || String(error) });
    showBanner('已保存到本地（离线或同步失败），联网后将自动同步', 'warn');
    renderHistory();
    updateSyncStatus();
    return 'pending';
  }
  // 成功：清除该日期可能残留的待同步项
  try { await LocalDB.deletePendingByDate(rec.date); } catch (_) {}
  logPush({ date: rec.date, assist: payload.assist ?? rec.assist, payload: 'synced', session: sessState(), result: 'success', error: '-' });
  await loadRecords();
  updateSyncStatus();
  return 'synced';
}

async function deleteRecord(date) {
  if (!currentUser) return;
  const uid = currentUser.id;
  const deletedAt = nowISO();   // 统一 tombstone 时间戳（本地与云端一致）
  const idx = records.findIndex((r) => r.date === date);
  const base = idx >= 0 ? Object.assign({}, records[idx]) : { date, user_id: uid };

  // 1. 更新内存：标记删除并从列表移除
  if (idx >= 0) records[idx] = Object.assign({}, records[idx], { deletedAt: deletedAt });
  records = records.filter((r) => r.date !== date);

  // 2. 写本地 IDB：tombstone（非物理删除，保留其余字段，便于后续同步）
  try {
    await LocalDB.putRecord(Object.assign({}, base, { date, user_id: uid, deleted_at: deletedAt }));
  } catch (_) { /* IDB 不可用则降级纯内存 */ }

  // 3. 尝试 Supabase（软删除 tombstone，deleted_at 优先规则不变）
  let error = null;
  try { error = await cloudDelete(date, deletedAt); } catch (e) { error = e; }

  if (error) {
    // 上传失败：写入 outbox（tombstone 已落 LocalDB，绝不丢失）
    try {
      await LocalDB.putPending({ date: date, action: 'delete', payload: { user_id: uid, date: date, deleted_at: deletedAt }, createdAt: nowISO() });
    } catch (_) { /* IDB 不可用则仅保留内存提示 */ }
    showBanner('已标记为删除（离线或同步失败），联网后将自动同步', 'warn');
    renderHistory();
    renderToday();
    updateSyncStatus();
    return;
  }
  // 成功：清除该日期可能残留的待同步项
  try { await LocalDB.deletePendingByDate(date); } catch (_) {}
  await loadRecords();
  updateSyncStatus();
}

/* ---------- 6.1 离线待同步队列（outbox）补推与状态 ---------- */
let isSyncing = false;   // 是否正在补推
let isFlushing = false;  // 防止并发补推

// 补推单条 pending（复用即时保存/删除的同一上传函数，保证同步语义一致）
async function replayPending(entry) {
  if (!currentUser) throw new Error('未登录');
  if (entry.action === 'save') {
    return await upsertWithFallbacks(entry.payload);
  } else if (entry.action === 'delete') {
    return await cloudDelete(entry.payload.date, entry.payload.deleted_at);
  }
  return new Error('未知操作：' + entry.action);
}

// 网络恢复后补推：按 createdAt 顺序执行，成功一条删一条；失败则停止等待下次
async function flushPending() {
  if (isFlushing || !navigator.onLine) return;
  isFlushing = true;
  setSyncing(true);
  try {
    await ensureSession();   // 补推前确认/刷新会话，避免 token 失效导致 401 卡死
    const pending = await LocalDB.getAllPending();
    if (!pending.length) return;
    for (const entry of pending) {
      let err = null;
      try { err = await replayPending(entry); } catch (e) { err = e; }
      logPush({ date: entry.payload && entry.payload.date, assist: entry.payload && entry.payload.assist, payload: 'replay', session: sessState(), result: err ? 'failed' : 'success', error: (err && err.message) || (err ? String(err) : '-') });
      if (err) break;                       // 失败停止，保留队列等下次
      try { await LocalDB.deletePending(entry.id); } catch (_) {}
    }
    // 补推后刷新本地/云端镜像
    try { await loadRecords(); } catch (_) {}
  } finally {
    setSyncing(false);
    isFlushing = false;   // 必须复位，否则后续补推会被永久拦截
  }
}

// 同步状态显示：在线 / 离线 / 待同步 N 条 / 同步中… + 最后同步时间 + 点击手动同步
async function updateSyncStatus() {
  const el = $('sync-status');
  if (!el) return;

  // 首次绑定点击 / 键盘触发手动同步（仅在 UI 层调用既有同步函数，不改动同步逻辑）
  if (!el.dataset.bound) {
    el.dataset.bound = '1';
    const doRefresh = async () => {
      if (!navigator.onLine) { updateSyncStatus(); return; }
      setSyncing(true);
      try { await flushPending(); } catch (_) {}
      try { await loadRecords(); } catch (_) {}
      setSyncing(false);
      updateSyncStatus();
    };
    el.addEventListener('click', doRefresh);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doRefresh(); }
    });
    // 空闲时仅刷新显示（不动同步逻辑），保持「N 分钟前」新鲜
    setInterval(() => updateSyncStatus(), 30000);
  }

  let count = 0;
  try { count = (await LocalDB.getAllPending()).length; } catch (_) {}

  // 最后同步时间（loadRecords 成功写入 lastSyncAt）
  let lastSync = '';
  try {
    const t = await LocalDB.getMeta('lastSyncAt');
    if (t) {
      const mins = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
      lastSync = mins <= 0 ? '刚刚' : mins + ' 分钟前';
    }
  } catch (_) {}

  let text, cls;
  if (!navigator.onLine) { text = '离线'; cls = 'offline'; }
  else if (isSyncing) { text = '同步中…'; cls = 'syncing'; }
  else if (count > 0) { text = '待同步 ' + count + ' 条'; cls = 'pending'; }
  else { text = lastSync ? ('已同步 · ' + lastSync) : '在线'; cls = 'online'; }

  el.textContent = text;
  el.className = 'sync-status ' + cls;
}

function setSyncing(v) { isSyncing = v; updateSyncStatus(); }

/* ---------- 7. 工资计算（与 macOS calculateMonthlySalary 一致） ---------- */
/* S2b：金额逐条按【记录自身日期】取价（与历史页/今日页/Mac 端同口径）；
 *      底薪档是月度概念，按【该月生效的版本】判定。 */
function computeSalary(recs) {
  const sum = (k) => recs.reduce((a, r) => a + num(r[k]), 0);
  const sumXHS = sum('xhs'), sumDY = sum('dy'), sumRef = sum('refund');
  const sumNote = sum('note_qty'), sumMat = sum('material_qty'), sumVid = sum('video_qty');
  const sumAssist = recs.reduce((a, r) => a + (isAssistVisible(r.date) ? num(r.assist) : 0), 0); // V2.6.1：仅计入 <2026-08-01 的助播（展示层）

  let refundCut = 0, xhsAmt = 0, dyAmt = 0;
  let noteIncome = 0, matIncome = 0, vidIncome = 0;
  for (const r of recs) {
    const c = configAt(r.date);
    refundCut  += num(r.refund) * c.price;
    xhsAmt     += num(r.xhs) * c.price;
    dyAmt      += num(r.dy) * c.price;
    noteIncome += num(r.note_qty) * c.notePrice;          // 图片收入
    matIncome  += num(r.material_qty) * c.materialPrice;  // 素材收入
    vidIncome  += num(r.video_qty) * c.videoPrice;        // 视频收入
  }
  const liveIncome = xhsAmt + dyAmt - refundCut;          // 直播出单收入
  const accIncome = noteIncome + matIncome + vidIncome;   // 账号笔记视频收入

  const mc = configForMonth(earliestMonth(recs));         // 该月生效的底薪参数
  const base = (liveIncome + accIncome) > mc.salaryThreshold ? mc.salaryHigh : mc.salaryLow;
  const total = liveIncome + accIncome + base;            // 应发总额（助播不计入，与 macOS 一致）

  return {
    sumXHS, sumDY, sumRef, sumNote, sumMat, sumVid, sumAssist,
    xhsAmt, dyAmt, refundCut, liveIncome,
    noteIncome, matIncome, vidIncome, accIncome,
    base, total,
    threshold: mc.salaryThreshold                           // 本次判定所用的达标线（展示层）
  };
}

/* ---------- 8. 视图切换 ---------- */
const TAB_TITLE = { today: '今日', history: '历史', income: '收入记录', salary: '工资', settings: '设置' };
function switchTab(tab) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(tab + '-view').classList.add('active');
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === tab));
  // iOS 导航：今日页显示「日期切换簇」，历史/工资页显示标题（不改任何业务/同步逻辑）
  const isToday = tab === 'today';
  $('nav-datemode').classList.toggle('hidden', !isToday);
  $('nav-titlemode').classList.toggle('hidden', isToday);
  $('topbar-title').textContent = TAB_TITLE[tab] || '';
  if (isToday) updateNavDate();
  // 进入历史/工资页时主动刷新一次：历史页即时重渲染 + 拉取最新；
  // 工资页为按需计算，这里只刷新底层 records，确保点「计算」用的是最新数据。
  if (tab === 'history') { renderHistory(); loadRecords(); }
  else if (tab === 'salary') { loadRecords(); }
  else if (tab === 'today') { renderToday(); }
  else if (tab === 'income') { loadIncomeRecords(); renderIncomeRecords(); }
}

/* ---------- 8b. 顶部日期切换（iOS 风格，纯 UI 层） ---------- */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function parseDate(str) { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function shiftDate(str, delta) { const d = parseDate(str); d.setDate(d.getDate() + delta); return fmtDate(d); }
function updateNavDate() {
  const ds = $('t-date').value || todayStr();
  const d = parseDate(ds);
  const today = todayStr();
  let main;
  if (ds === today) main = '今天';
  else if (ds === shiftDate(today, -1)) main = '昨天';
  else if (ds === shiftDate(today, -2)) main = '前天';
  else main = `${d.getMonth() + 1}月${d.getDate()}日`;
  $('nav-date-main').textContent = main;
  $('nav-date-sub').textContent = `${WEEK[d.getDay()]}`;
}
// 切换日期：仅更新 t-date 状态源 + 触发既有 change 处理（todayDirty=false + loadTodayInputs）+ 刷新导航显示
function goToDate(dateStr, dir) {
  $('t-date').value = dateStr;
  $('t-date').dispatchEvent(new Event('change'));
  updateNavDate();
  const tv = $('today-view');
  if (tv && dir) {
    tv.classList.remove('anim-next', 'anim-prev');
    void tv.offsetWidth;                             // 重启动画
    tv.classList.add(dir > 0 ? 'anim-next' : 'anim-prev');
  }
}
function prevDay() { if (!$('nav-datemode').classList.contains('hidden')) goToDate(shiftDate($('t-date').value, -1), -1); }
function nextDay() { if (!$('nav-datemode').classList.contains('hidden')) goToDate(shiftDate($('t-date').value, 1), 1); }

/* 月历弹层 */
let calYear, calMonth;   // 当前展示的年/月（1-12）
function openCalendar() {
  const d = parseDate($('t-date').value || todayStr());
  calYear = d.getFullYear(); calMonth = d.getMonth() + 1;
  renderCalendar();
  $('calendar-sheet').classList.remove('hidden');
}
function closeCalendar() { $('calendar-sheet').classList.add('hidden'); }
// 月历月份切换（纯 UI 导航：仅调整 calYear/calMonth 并重渲染网格，不涉及任何日期/同步/DB 逻辑）
function prevMonth() { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } renderCalendar(); }
function nextMonth() { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } renderCalendar(); }
function renderCalendar() {
  const cur = $('t-date').value || todayStr();
  $('cal-title').textContent = `${calYear}年${calMonth}月`;
  const first = new Date(calYear, calMonth - 1, 1);
  const startPad = (first.getDay() + 6) % 7;        // 周一为首列（纯渲染偏移，不涉及业务/同步/DB）
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const today = todayStr();
  const dataDates = new Set((records || []).map((r) => r.date));   // 仅用于高亮，只读
  const grid = $('cal-grid'); grid.innerHTML = '';
  for (let i = 0; i < startPad; i++) {
    const e = document.createElement('div'); e.className = 'cal-cell empty'; grid.appendChild(e);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.textContent = day;
    if (ds === today) cell.classList.add('today-cell');
    if (ds === cur) cell.classList.add('selected');
    if (dataDates.has(ds)) cell.classList.add('has-data');
    cell.addEventListener('click', () => { goToDate(ds, null); closeCalendar(); });
    grid.appendChild(cell);
  }
}

/* ---------- 9. 今日页 ---------- */
function initTodayForm() {
  $('t-date').value = todayStr();
  loadTodayInputs(todayStr());
}

function loadTodayInputs(date) {
  const r = findRecord(date);
  $('t-xhs').value = r ? r.xhs : '';
  $('t-dy').value = r ? r.dy : '';
  $('t-refund').value = r ? r.refund : '';
  if (isAssistVisible(date)) {
    $('t-assist').value = r ? r.assist : defaultAssist(date);  // 2026-07-31 及以前：正常显示/编辑助播
    $('row-t-assist').classList.remove('hidden');
  } else {
    $('t-assist').value = 0;            // 2026-08-01 起隐藏录入，强制 0（避免触发 DB DEFAULT 160，保持同步稳定）
    $('row-t-assist').classList.add('hidden');
  }
  $('t-note').value = r ? r.note_qty : '';
  $('t-material').value = r ? r.material_qty : '';
  $('t-video').value = r ? r.video_qty : '';
  $('t-status').textContent = r ? '已存在该日期记录，保存将覆盖更新。' : '新记录';
  updateTodaySummary();
}

// 今日页统一刷新入口：从内存 records 重新填充「今日」输入框（与 renderHistory 对称）。
// 修复体验问题：删除/同步后 records 已更新，但今日输入框仅在 init / 改日期 / 编辑恰为今日时刷新，
// 导致历史页更新而今日页残留旧值。现在由 loadRecords() 与 switchTab(today) 统一调用。
function renderToday() {
  // V3.0.1：dirty 守卫——今日表单有未保存输入时跳过回填，
  // 防止 autoPull(30s) / switchTab / loadRecords 用内存 records 覆盖用户正在编辑的数据。
  if (todayDirty) return;
  loadTodayInputs($('t-date').value);
}

function readTodayInputs() {
  return {
    date: $('t-date').value,
    xhs: num($('t-xhs').value), dy: num($('t-dy').value), refund: num($('t-refund').value),
    assist: num($('t-assist').value), note_qty: num($('t-note').value),
    material_qty: num($('t-material').value), video_qty: num($('t-video').value)
  };
}

function updateTodaySummary() {
  const r = readTodayInputs();
  const net = r.xhs + r.dy - r.refund;
  const c = configAt(r.date);   // S2b：今日汇总按【这一天】生效的价格版本
  const out = net * c.price;
  const pub = r.note_qty * c.notePrice + r.material_qty * c.materialPrice + r.video_qty * c.videoPrice;
  $('s-net').textContent = net;
  $('s-out').textContent = fmtMoney(out);
  $('s-pub').textContent = fmtMoney(pub);
  $('s-assist').textContent = fmtMoney(r.assist);
  // V2.6.1：2026-08-01 起隐藏今日金额汇总中的「助播」行（仅展示层，不影响保存/同步/合并）
  $('row-s-assist').classList.toggle('hidden', !isAssistVisible(r.date));
  // [V3.0 Phase 3A] 仅新增 UI 状态绑定：净收入卡头条(出单+发布) 与 退款金额。
  // 不改动任何业务/保存/同步/合并逻辑，亦不影响 FIELDS / STAMP_COL / assist 数据字段。
  const heroMoney = document.getElementById('s-net-money');
  if (heroMoney) heroMoney.textContent = fmtMoney(out + pub);
  const rfMoney = document.getElementById('s-refund-money');
  if (rfMoney) rfMoney.textContent = (r.refund > 0 ? '-' : '') + fmtMoney(r.refund * c.price);
}

/**
 * 显式恢复确认框（自定义 Modal，非原生 confirm）。
 * 保存时检测到该日期云端已有 tombstone，弹出确认；resolve(true)=恢复并保存，resolve(false)=取消。
 * 依赖 index.html 中的 #revive-modal / #revive-date / #revive-confirm / #revive-cancel。
 */
function showReviveModal(rec) {
  return new Promise((resolve) => {
    const modal = $('revive-modal');
    if (!modal) { resolve(false); return; }   // 兜底：无弹层则不恢复
    $('revive-date').textContent = rec.date || '';
    modal.classList.remove('hidden');
    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    function cleanup() {
      $('revive-confirm').removeEventListener('click', onConfirm);
      $('revive-cancel').removeEventListener('click', onCancel);
      modal.classList.add('hidden');
    }
    $('revive-confirm').addEventListener('click', onConfirm);
    $('revive-cancel').addEventListener('click', onCancel);
  });
}

async function handleTodaySave() {
  const rec = readTodayInputs();
  if (!rec.date) { $('t-status').textContent = '请选择日期'; return; }
  const btn = $('t-save');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    let revive = false;
    if (isDateTombstoned(rec.date)) {
      const ok = await showReviveModal(rec);
      if (!ok) {
        $('t-status').textContent = '该日期已删除，未保存。如需恢复请点击「恢复并保存」。';
        return;
      }
      revive = true;
    }
    // V3.0.1a：快照已捕获（rec）。dirty 的清除移到 saveRecord 正常返回之后——
    // 若 saveRecord 抛异常（未登录/意外异常），不会执行到这里，todayDirty 保持 true，
    // 未保存的 DOM 输入继续受 renderToday 守卫保护，与下方 catch 的「保存失败」提示一致。
    // 说明：saveRecord 内部成功路径会 await loadRecords()→renderToday()，此刻 dirty 仍为 true
    // 故其回填被守卫跳过（DOM 已等于刚保存值，无副作用）；本函数末尾再清 dirty，恢复正常回填。
    const status = await saveRecord(rec, revive);
    todayDirty = false;   // 仅在保存链路正常返回后清除
    if (revive) {
      $('t-status').textContent = (status === 'synced')
        ? '✅ 已恢复并保存，已同步到云端'
        : '✅ 已恢复并保存，等待同步';
    } else {
      $('t-status').textContent = (status === 'synced')
        ? '✅ 已保存并同步到云端'
        : '⏳ 已保存，等待同步';
    }
  } catch (err) {
    $('t-status').textContent = (err && err.message === '未登录')
      ? '同步失败，请重新登录'
      : '保存失败：' + (err.message || err);
  } finally {
    btn.disabled = false; btn.textContent = '保存记录';
  }
}

/* ---------- 10. 历史页 ---------- */
function renderHistory() {
  const list = $('history-list');
  const empty = $('history-empty');
  if (!records.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // 按日期降序，便于「近月 / 近日」在前（仅重排，不改任何金额/同步逻辑）
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));
  const groups = {};
  for (const r of sorted) {
    const ym = r.date.slice(0, 7);              // YYYY-MM
    (groups[ym] = groups[ym] || []).push(r);
  }
  const ymKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  const monthLabel = (ym) => {
    const [y, m] = ym.split('-');
    return `${y}年${parseInt(m, 10)}月`;
  };
  const dayLabel = (date) => {
    return `${parseInt(date.slice(5, 7), 10)}月${parseInt(date.slice(8, 10), 10)}日`;
  };
  const rowHTML = (r) => {
    const total = recordTotal(r);   // S2b：按记录自身日期取价
    return `
        <div class="hrow" data-date="${r.date}">
          <div class="hrow-main">
            <div class="hrow-date">${dayLabel(r.date)}</div>
            <div class="hrow-tags">
              <span>小${r.xhs}</span><span>抖${r.dy}</span>
              <span class="neg">退${r.refund}</span>
              <span>图${r.note_qty}</span><span>素${r.material_qty}</span><span>视${r.video_qty}</span>
              ${(r.assist !== 0 && isAssistVisible(r.date)) ? `<span class="assist">助¥${r.assist}</span>` : ''}
            </div>
          </div>
          <div class="hrow-right">
            <div class="hrow-total">${fmtMoney(total)}</div>
            <div class="hrow-edit">编辑 ›</div>
          </div>
        </div>`;
  };

  list.innerHTML = ymKeys.map((ym) => {
    const rs = groups[ym];
    let sum = 0;
    const rows = rs.map((r) => {
      sum += recordTotal(r);   // S2b：按记录自身日期取价
      return rowHTML(r);
    }).join('');
    return `
      <div class="hgroup">
        <div class="hgroup-head">${monthLabel(ym)}</div>
        <div class="hgroup-body">${rows}</div>
        <div class="hgroup-foot">本月合计 ${fmtMoney(sum)} · ${rs.length} 笔</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.hrow').forEach((el) => {
    el.addEventListener('click', () => openEdit(el.dataset.date));
  });
}

/* ---------- 11. 编辑弹层 ---------- */
function openEdit(date) {
  const r = findRecord(date);
  if (!r) return;
  $('e-date').value = r.date;
  $('e-xhs').value = r.xhs;
  $('e-dy').value = r.dy;
  $('e-refund').value = r.refund;
  if (isAssistVisible(date)) {
    $('e-assist').value = r.assist;     // 历史记录（< 2026-08-01）仍显示原值
    $('row-e-assist').classList.remove('hidden');
  } else {
    $('e-assist').value = 0;            // 2026-08-01 起隐藏录入，强制 0
    $('row-e-assist').classList.add('hidden');
  }
  $('e-note').value = r.note_qty;
  $('e-material').value = r.material_qty;
  $('e-video').value = r.video_qty;
  $('e-status').textContent = '';
  $('edit-sheet').classList.remove('hidden');
}

function closeEdit() { $('edit-sheet').classList.add('hidden'); }

async function handleEditSave() {
  const rec = {
    date: $('e-date').value,
    xhs: num($('e-xhs').value), dy: num($('e-dy').value), refund: num($('e-refund').value),
    assist: num($('e-assist').value), note_qty: num($('e-note').value),
    material_qty: num($('e-material').value), video_qty: num($('e-video').value)
  };
  const btn = $('e-save');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    let revive = false;
    if (isDateTombstoned(rec.date)) {
      const ok = await showReviveModal(rec);
      if (!ok) {
        $('e-status').textContent = '该日期已删除，未保存。';
        closeEdit();
        return;
      }
      revive = true;
    }
    const status = await saveRecord(rec, revive);
    $('e-status').textContent = (status === 'synced')
      ? '✅ 已保存并同步到云端'
      : '⏳ 已保存，等待同步';
    closeEdit();
    // 若编辑的是今日，刷新今日页输入
    if (rec.date === $('t-date').value) loadTodayInputs(rec.date);
  } catch (err) {
    $('e-status').textContent = (err && err.message === '未登录')
      ? '同步失败，请重新登录'
      : '保存失败：' + (err.message || err);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

async function handleEditDelete() {
  const date = $('e-date').value;
  if (!confirm(`确定删除 ${date} 的记录？将标记删除（可恢复），并同步到所有设备。`)) return;
  const btn = $('e-delete');
  btn.disabled = true; btn.textContent = '删除中…';
  try {
    await deleteRecord(date);
    closeEdit();
  } catch (err) {
    $('e-status').textContent = '删除失败：' + (err.message || err);
  } finally {
    btn.disabled = false; btn.textContent = '删除';
  }
}

/* ---------- 12. 工资页 ---------- */
function initSalaryDefaults() {
  const t = todayStr();
  $('sal-start').value = firstDayOfMonth(t);
  $('sal-end').value = lastDayOfMonth(t);
}

function applyQuickRange(kind) {
  const t = todayStr();
  const [y, m] = t.slice(0, 7).split('-').map(Number);
  if (kind === 'thisMonth') {
    $('sal-start').value = firstDayOfMonth(t);
    $('sal-end').value = lastDayOfMonth(t);
  } else if (kind === 'lastMonth') {
    const d = new Date(y, m - 2, 1);
    const ms = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    $('sal-start').value = ms + '-01';
    $('sal-end').value = lastDayOfMonth(ms + '-01');
  } else if (kind === 'cycle') {
    // 常见发薪周期：上月16日 → 本月15日
    const prev = new Date(y, m - 2, 16);
    $('sal-start').value = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-16`;
    $('sal-end').value = `${y}-${String(m).padStart(2, '0')}-15`;
  }
  handleSalaryCalc();
}

function handleSalaryCalc() {
  const start = $('sal-start').value;
  const end = $('sal-end').value;
  const box = $('salary-result');
  const empty = $('salary-empty');
  if (!start || !end) { empty.textContent = '请选择开始和结束日期'; empty.classList.remove('hidden'); box.classList.add('hidden'); return; }
  const recs = records.filter((r) => r.date >= start && r.date <= end);
  if (!recs.length) {
    empty.textContent = '该时间段暂无记录';
    empty.classList.remove('hidden');
    box.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  const s = computeSalary(recs);
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="sal-head">工资报表 <span class="sal-range">${start} ~ ${end}</span></div>
    <div class="sal-row"><div class="sal-l">小红书出单<em>${s.sumXHS} 单</em></div><b>${fmtMoney(s.xhsAmt)}</b></div>
    <div class="sal-row"><div class="sal-l">抖音出单<em>${s.sumDY} 单</em></div><b>${fmtMoney(s.dyAmt)}</b></div>
    <div class="sal-row neg"><div class="sal-l">退款扣减<em>${s.sumRef} 单</em></div><b>-${fmtMoney(s.refundCut)}</b></div>
    <div class="sal-row strong"><div class="sal-l">直播出单收入</div><b>${fmtMoney(s.liveIncome)}</b></div>
    <div class="sal-div"></div>
    <div class="sal-row"><div class="sal-l">图文收入<em>${s.sumNote} 条</em></div><b>${fmtMoney(s.noteIncome)}</b></div>
    <div class="sal-row"><div class="sal-l">素材收入<em>${s.sumMat} 条</em></div><b>${fmtMoney(s.matIncome)}</b></div>
    <div class="sal-row"><div class="sal-l">视频收入<em>${s.sumVid} 条</em></div><b>${fmtMoney(s.vidIncome)}</b></div>
    <div class="sal-row strong"><div class="sal-l">账号笔记视频收入</div><b>${fmtMoney(s.accIncome)}</b></div>
    <div class="sal-div"></div>
    <div class="sal-row"><div class="sal-l">底薪<em>${(s.liveIncome + s.accIncome) > s.threshold ? '已达标' : '未达标'}</em></div><b>${fmtMoney(s.base)}</b></div>
    ${s.sumAssist !== 0 ? `<div class="sal-row muted"><div class="sal-l">助播（不计入总额，仅参考）</div><b>${fmtMoney(s.sumAssist)}</b></div>` : ''}
    <div class="sal-total">
      <span>应发总额</span>
      <div class="sal-total-num">${fmtMoney(s.total)}</div>
    </div>`;
}

/* ---------- 12. 设置页（账户菜单 →「设置」进入） ----------
   复用既有 switchTab 视图机制：settings-view 已在 index.html 中定义，
   switchTab('settings') 会自动隐藏日期簇、显示顶栏标题「设置」。
   不触碰登录 / Supabase / localdb / 同步逻辑 / 数据结构。
   S2c 第二阶段：进入/离开页面时渲染或回滚 7 项价格参数输入框（见下方 12b）。 */
let settingsReturnTab = 'today';
function openSettings() {
  // 记录来源视图，返回时回到原页面；已在设置页时不覆盖（避免来源被记成 settings）
  const active = document.querySelector('.view.active');
  if (active && active.id !== 'settings-view') settingsReturnTab = active.id.replace(/-view$/, '');
  switchTab('settings');
  // S2c 第二阶段：进入页面即以 CONFIG 为准渲染（丢弃上一次未保存的暂存）
  renderSettingsPriceInputs();
  setPriceUiStatus('');
  window.scrollTo({ top: 0 });
}
function closeSettings() {
  // S2c 第二阶段：离开设置页即丢弃未确认的暂存 + 关掉确认弹层（不写任何东西）
  pendingPriceConfirm = null;
  const m = $('price-confirm-modal'); if (m) m.classList.add('hidden');
  const b = $('price-confirm-body'); if (b) b.innerHTML = '';
  renderSettingsPriceInputs();
  switchTab(settingsReturnTab || 'today');
}

/* ---------- 12b. 设置页 · 价格参数 UI（S2c 第二阶段 · 纯展示层） ----------
 * 目标：手机端也能编辑 7 个价格参数，并只通过【唯一写入口】window.savePriceConfigPatch 提交。
 *
 * 铁律（与 S2c 第二阶段方案一致）：
 *   ① 输入框只是【暂存区】—— 确认前绝不触碰 CONFIG / pendingConfigPatch / baseline / Supabase；
 *      「取消」= 关弹层 + 从 CONFIG 重渲染 → 天然零 pending、零云端写入。
 *   ② confirmPriceSave 是【唯一】调用 window.savePriceConfigPatch 的地方，且只传真正变化的字段。
 *   ③ 本区块不复制字段↔列名映射表（直接复用 PRICE_CONFIG_COLUMNS），不操作 dirty / baseline。
 *   ④ 不改 savePriceConfigPatch / pushConfigPatch / mergeConfigPatch / computeConfigPatch /
 *      recordPriceVersion / pushVersionsToCloud / refreshPriceVersions 的任何逻辑。 */

/* 7 项的展示元数据：field 必须与 CONFIG 字段名一致；step 即分组步进幅度
 * （单价组 ±1 / 工资组 ±100 —— 按【字段分组】，不按控件位置）。 */
const PRICE_UI_ROWS = [
  { field: 'price',           label: '出单单价',   step: 1 },
  { field: 'notePrice',       label: '图文单价',   step: 1 },
  { field: 'materialPrice',   label: '素材单价',   step: 1 },
  { field: 'videoPrice',      label: '视频单价',   step: 1 },
  { field: 'salaryThreshold', label: '底薪达标线', step: 100 },
  { field: 'salaryHigh',      label: '达标底薪',   step: 100 },
  { field: 'salaryLow',       label: '未达标底薪', step: 100 }
];

/* 设置页当前待确认的修改（null = 无）。只在 requestPriceSave → confirmPriceSave 之间存活；取消即丢弃。 */
let pendingPriceConfirm = null;

/* 设置页【用户是否真的动过输入框】—— 与 todayDirty 同思路的显式脏标记。
 * 为什么不能直接拿「输入 ≠ CONFIG」当脏判定：CONFIG 会因云端拉取而变化，
 * 那时「输入(旧) ≠ CONFIG(新)」并不代表用户改过；若据此判定，被动刷新会被自己永久挡住，
 * 而且会把云端新值倒推回旧值写进云端。因此脏标记【只由用户交互置位】，
 * renderSettingsPriceInputs()（= 以 CONFIG 为准重建 DOM）负责清位。 */
let settingsPriceDirty = false;

function priceUiRow(field) {
  for (let i = 0; i < PRICE_UI_ROWS.length; i++) {
    if (PRICE_UI_ROWS[i].field === field) return PRICE_UI_ROWS[i];
  }
  return null;
}
function priceUiInput(field) { return $('ps-' + field); }

/**
 * 解析输入框文本：合法数值 → ≥1 的整数（0 / 负数 / 小数按 min=1 约束夹到 1）；
 * 空 / 非数值 → null（交由调用方回退，绝不臆造一个数字）。
 * 注意：<input type="number"> 对「非法文本」一律回传空串，所以 null 分支就等于「用户输入了非法内容」。
 */
function parsePriceValue(text) {
  const raw = (typeof text === 'string') ? text.trim() : '';
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.floor(n));
}

/**
 * 输入框的「当前意图值」：合法 → 该值（夹到 ≥1）；
 * 空 / 非法 → 回退到 CONFIG 里该字段上一次的确定值。
 * （不把非法输入悄悄变成 1 —— 那会让用户在无感知的情况下把 1 写进云端。与 applyPriceConfig 的 >0 约束一致。）
 */
function priceUiValue(field) {
  const el = priceUiInput(field);
  const n = parsePriceValue(el ? el.value : '');
  return (n === null) ? CONFIG[field] : n;
}
function setPriceUiStatus(text) { const el = $('settings-status'); if (el) el.textContent = text || ''; }

/** 从 CONFIG 渲染 7 个输入框（进入页面 / 取消回滚 / 保存后 / 被动刷新 都走这里）。
 *  渲染即「已与 CONFIG 对齐」→ 同时清除用户脏标记。 */
function renderSettingsPriceInputs() {
  for (const row of PRICE_UI_ROWS) {
    const el = priceUiInput(row.field);
    if (el) el.value = String(CONFIG[row.field]);
  }
  settingsPriceDirty = false;
}

/** 读取当前输入 → { 'snake_col': int }（键一律用 Supabase 列名，直接喂给 savePriceConfigPatch）。 */
function readSettingsPriceInputs() {
  const out = {};
  for (const row of PRICE_UI_ROWS) {
    const col = PRICE_CONFIG_COLUMNS[row.field];
    if (col) out[col] = priceUiValue(row.field);
  }
  return out;
}

/**
 * 与 CONFIG 差分 → { 'snake_col': 新值 }（只含真正变化的字段）。
 * 纯函数：不读 DOM，输入由参数给出，便于单测。
 */
function settingsPriceChangesFrom(current, config) {
  const base = config || CONFIG;
  const changed = {};
  for (const row of PRICE_UI_ROWS) {
    const col = PRICE_CONFIG_COLUMNS[row.field];
    if (!col) continue;
    const v = current[col];
    if (typeof v === 'number' && v !== base[row.field]) changed[col] = v;
  }
  return changed;
}
function settingsPriceChanges() {
  // 未动过输入框 ⇒ 一定没有需要保存的修改（杜绝「把云端新值倒推回旧值」这类误写）
  if (!settingsPriceDirty) return {};
  return settingsPriceChangesFrom(readSettingsPriceInputs(), CONFIG);
}

/** 步进：value ± (方向 × 该字段的分组步进)，夹到 ≥1。 */
function stepSettingsPrice(field, dir) {
  const row = priceUiRow(field), el = priceUiInput(field);
  if (!row || !el) return;
  el.value = String(Math.max(1, priceUiValue(field) + dir * row.step));
  settingsPriceDirty = true;
}

/** 点「保存」：无变化 → 只提示不开弹层；有变化 → 填充确认列表并打开二次确认。 */
function requestPriceSave() {
  const changes = settingsPriceChanges();
  const cols = Object.keys(changes);
  if (!cols.length) { settingsPriceDirty = false; setPriceUiStatus('没有需要保存的修改'); return; }
  pendingPriceConfirm = { changes };
  const body = $('price-confirm-body');
  if (body) {
    body.innerHTML = cols.map(function (col) {
      const row = PRICE_UI_ROWS.filter((r) => PRICE_CONFIG_COLUMNS[r.field] === col)[0];
      const label = row ? row.label : col;
      const before = row ? CONFIG[row.field] : 0;
      return '<div class="pc-item"><span>' + label + '</span>' +
             '<span class="pc-delta">' + fmtMoney(before) + ' → <b>' + fmtMoney(changes[col]) + '</b></span></div>';
    }).join('');
  }
  setPriceUiStatus('');
  const modal = $('price-confirm-modal');
  if (modal) modal.classList.remove('hidden');
}

/** 取消：关弹层 + 丢弃暂存 + 从 CONFIG 完全回滚。全程未调用任何写函数 → 零 pending、零云端写入。 */
function closePriceConfirm() {
  pendingPriceConfirm = null;
  const modal = $('price-confirm-modal');
  if (modal) modal.classList.add('hidden');
  const body = $('price-confirm-body');
  if (body) body.innerHTML = '';
  renderSettingsPriceInputs();
  setPriceUiStatus('');
}

/** 确认：【唯一】调用 window.savePriceConfigPatch 的地方（只传真正变化的字段）。 */
async function confirmPriceSave() {
  const pending = pendingPriceConfirm;
  pendingPriceConfirm = null;
  const modal = $('price-confirm-modal');
  if (modal) modal.classList.add('hidden');
  const body = $('price-confirm-body');
  if (body) body.innerHTML = '';
  if (!pending || !Object.keys(pending.changes).length) return;

  const btn = $('settings-save');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }   // 接住 .btn-primary:disabled 的原生 spinner
  let res = null;
  try {
    res = await window.savePriceConfigPatch(pending.changes);
  } catch (e) {
    res = { ok: false, reason: (e && e.message) || 'exception' };
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
  renderSettingsPriceInputs();   // 以 CONFIG 为准回显（savePriceConfigPatch 已把新值写进 CONFIG）
  if (res && res.ok) {
    setPriceUiStatus(res.pushed ? '已保存并同步' : '已保存到本机，联网后自动同步');
  } else {
    setPriceUiStatus(res && res.reason === 'no-valid-change' ? '没有需要保存的修改' : '保存失败，请重试');
  }
}

/**
 * 【方案 A】设置页被动刷新钩子：refreshPriceConfig 成功后调用。
 * 三重守卫 —— 任一命中就【完全不碰 DOM】（绝不覆盖用户正在编辑的内容）：
 *   ① 未登录 / 设置页未打开
 *   ② 二次确认弹层正开着
 *   ③ 某个价格输入框正在聚焦
 *   ④ 用户已动过输入框（settingsPriceDirty）
 * 只有全部安全时才把最新云端价格回显到输入框（回显后脏标记清零）。异常静默，绝不影响同步。
 */
function syncSettingsPriceUI() {
  try {
    if (!currentUser) return;
    const view = $('settings-view');
    if (!view || !view.classList.contains('active')) return;
    const modal = $('price-confirm-modal');
    if (modal && !modal.classList.contains('hidden')) return;
    if (settingsPriceDirty && Object.keys(settingsPriceChanges()).length) return;  // 有真实未保存改动 → 不覆盖
    for (const row of PRICE_UI_ROWS) {
      const el = priceUiInput(row.field);
      if (el && document.activeElement === el) return;       // 正在编辑 → 不覆盖
    }
    renderSettingsPriceInputs();
  } catch (_) { /* 纯展示层：任何异常都不影响价格同步 */ }
}

/* 诊断入口（只读，供排查与自动化验证使用；不参与业务） */
window.__settingsPriceUI = function () {
  const inputs = {};
  for (const row of PRICE_UI_ROWS) inputs[row.field] = priceUiValue(row.field);
  return {
    rows: PRICE_UI_ROWS.map((r) => Object.assign({}, r)),
    inputs: inputs,
    changes: settingsPriceChanges(),
    dirty: settingsPriceDirty,
    confirmOpen: !!pendingPriceConfirm
  };
};

/* ---------- 账户菜单（iOS 风格） ---------- */
function toggleAccountMenu() {
  const menu = $('account-menu');
  if (!menu) return;
  menu.classList.toggle('hidden');
}
function closeAccountMenu() {
  const menu = $('account-menu');
  if (menu) menu.classList.add('hidden');
}
function handleAccountAction(action) {
  closeAccountMenu();
  if (action === 'logout') {
    handleLogout();
  } else if (action === 'settings') {
    openSettings();
  }
  // 账号管理仍为预留入口，当前无操作
}

/* ---------- 12c. 收入记录（P1-1 · 独立命名空间，仅复用 income_records 现有字段） ---------- */
// 约束：不修改 Supabase schema / RLS / Realtime / 同步逻辑；仅新增对现有 income_records 表的读写。
// 写入遵循既有约定：id=客户端 crypto.randomUUID()、date=yyyy-MM-dd、modified_at=写时更新、删除=软删(deleted_at)。
let incomeRecords = [];
let editingIncomeId = null;

// 类型显示名（存储值 assist / other）
function incomeTypeLabel(type) {
  if (type === 'assist') return '助播';
  if (type === 'other') return '其他';
  return type || '其他';
}

// 简单 HTML 转义，防止备注 XSS
function incomeEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 读取：仅复用现有 income_records 表 + 字段 + 现有 RLS，不改任何 schema / 同步
async function loadIncomeRecords() {
  const uid = currentUser ? currentUser.id : null;
  if (!uid) { incomeRecords = []; return; }
  try {
    const { data, error } = await sb
      .from('income_records')
      .select('*')
      .eq('user_id', uid)
      .is('deleted_at', null)
      .order('date', { ascending: false });
    if (error) {
      showBanner('收入记录读取失败：' + (error.message || ''), 'error');
      incomeRecords = [];
    } else {
      incomeRecords = data || [];
    }
  } catch (_) {
    incomeRecords = [];
  }
}

function renderIncomeRecords() {
  const list = $('income-list');
  const empty = $('income-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!incomeRecords.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  for (const r of incomeRecords) {
    const row = document.createElement('div');
    row.className = 'hrow';
    row.dataset.id = r.id;
    const note = r.note ? incomeEscapeHtml(r.note) : '';
    const counts = r.counts_in_salary ? '<span class="assist">计入工资</span>' : '';
    row.innerHTML =
      '<div class="hrow-main">' +
        '<div class="hrow-date"><span class="type-badge">' + incomeTypeLabel(r.type) + '</span>' + (r.date || '') + '</div>' +
        '<div class="hrow-tags">' +
          (note ? '<span>' + note + '</span>' : '') +
          counts +
        '</div>' +
      '</div>' +
      '<div class="hrow-right">' +
        '<div class="hrow-total">¥' + num(r.amount) + '</div>' +
        '<div class="hrow-edit">编辑 ›</div>' +
      '</div>';
    list.appendChild(row);
  }
}

// 打开编辑弹层：recOrId 为记录 id（编辑）或 null（新增）
function openIncomeEditor(recOrId) {
  editingIncomeId = null;
  const isEdit = typeof recOrId === 'string';
  const rec = isEdit ? incomeRecords.find((r) => r.id === recOrId) : null;
  if (isEdit && rec) editingIncomeId = rec.id;

  const type = rec ? rec.type : 'assist';
  document.querySelectorAll('#income-type .seg-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === type));

  $('income-date').value = rec ? (rec.date || todayStr()) : todayStr();
  $('income-amount').value = rec ? num(rec.amount) : '';
  $('income-note').value = rec ? (rec.note || '') : '';
  $('income-counts').checked = rec ? (rec.counts_in_salary !== false) : true;
  $('income-sheet-title').textContent = rec ? '编辑收入' : '添加收入';
  $('income-delete').classList.toggle('hidden', !rec);
  $('income-status').textContent = '';
  $('income-sheet').classList.remove('hidden');
}

function closeIncomeEditor() {
  $('income-sheet').classList.add('hidden');
  editingIncomeId = null;
}

async function handleIncomeSave() {
  const uid = currentUser ? currentUser.id : null;
  if (!uid) { showBanner('未登录，无法保存', 'error'); return; }
  const activeTypeBtn = document.querySelector('#income-type .seg-item.active');
  const type = activeTypeBtn ? activeTypeBtn.dataset.type : 'assist';
  const date = $('income-date').value || todayStr();
  const amount = num($('income-amount').value);
  const note = ($('income-note').value || '').trim();
  const counts = $('income-counts').checked;

  const now = new Date().toISOString();
  const payload = {
    user_id: uid,
    type: type,
    date: date,
    amount: amount,
    note: note,
    counts_in_salary: counts,
    modified_at: now
  };
  if (editingIncomeId) {
    payload.id = editingIncomeId;   // 更新（LWW：id + modified_at）
  } else {
    // 客户端生成 UUID（与 macOS IncomeStore 一致），保证与现有同步层 LWW 合并兼容
    payload.id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : ('inc-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  }

  $('income-status').textContent = '保存中…';
  const { error } = await sb.from('income_records').upsert(payload, { onConflict: 'id' });
  if (error) {
    $('income-status').textContent = '';
    showBanner('收入保存失败：' + (error.message || ''), 'error');
    return;
  }
  await loadIncomeRecords();
  renderIncomeRecords();
  closeIncomeEditor();
}

async function handleIncomeDelete() {
  const uid = currentUser ? currentUser.id : null;
  if (!uid || !editingIncomeId) return;
  if (!window.confirm('确定删除这条收入记录吗？（软删除，可恢复）')) return;
  const now = new Date().toISOString();
  const { error } = await sb
    .from('income_records')
    .update({ deleted_at: now, modified_at: now })
    .eq('id', editingIncomeId)
    .eq('user_id', uid);
  if (error) {
    showBanner('收入删除失败：' + (error.message || ''), 'error');
    return;
  }
  await loadIncomeRecords();
  renderIncomeRecords();
  closeIncomeEditor();
}

/* ---------- 13. 事件绑定 ---------- */
function bindEvents() {
  $('login-form').addEventListener('submit', handleLogin);

  // 账户菜单入口：点击按钮切换，点击菜单项执行对应动作，点击外部关闭
  const accountBtn = $('account-btn');
  const accountMenu = $('account-menu');
  if (accountBtn) {
    accountBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAccountMenu();
    });
  }
  if (accountMenu) {
    accountMenu.addEventListener('click', (e) => e.stopPropagation());
    accountMenu.querySelectorAll('.account-menu-item').forEach((item) => {
      item.addEventListener('click', () => handleAccountAction(item.dataset.action));
    });
  }
  document.addEventListener('click', closeAccountMenu);

  // 设置页返回入口（账户菜单 →「设置」）
  const settingsBack = $('settings-back');
  if (settingsBack) settingsBack.addEventListener('click', closeSettings);

  // S2c 第二阶段：设置页价格参数（步进用事件委托 —— 1 个监听器覆盖 14 个步进按钮）
  const psCard = $('ps-card');
  if (psCard) {
    psCard.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.ps-step') : null;
      if (!btn) return;
      const row = btn.closest('.ps-row');
      if (!row) return;
      stepSettingsPrice(row.dataset.field, Number(btn.dataset.step));
      setPriceUiStatus('');
    });
    // input：一有键入选就置脏（让被动刷新守卫立刻生效，不必等 blur）
    psCard.addEventListener('input', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('.ps-input') : null;
      if (!el) return;
      settingsPriceDirty = true;
      setPriceUiStatus('');
    });
    psCard.addEventListener('change', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('.ps-input') : null;
      if (!el) return;
      const row = el.closest('.ps-row');
      const field = row ? row.dataset.field : String(el.id || '').replace(/^ps-/, '');
      // 合法数值 → 夹到 ≥1 回写；空 / 非法 → 回退到 CONFIG 的上一次确定值（不臆造数字）
      el.value = String(priceUiValue(field));
      settingsPriceDirty = true;
      setPriceUiStatus('');
    });
  }
  const settingsSave = $('settings-save');
  if (settingsSave) settingsSave.addEventListener('click', requestPriceSave);
  // 二次确认弹层：取消 = 完全回滚且零写入；确认 = 唯一入口 savePriceConfigPatch
  const pcOk = $('price-confirm-ok');
  if (pcOk) pcOk.addEventListener('click', confirmPriceSave);
  const pcCancel = $('price-confirm-cancel');
  if (pcCancel) pcCancel.addEventListener('click', closePriceConfirm);
  const pcBackdrop = $('price-confirm-backdrop');
  if (pcBackdrop) pcBackdrop.addEventListener('click', closePriceConfirm);

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 顶部日期切换簇（iOS 风）：左右箭头切天，点击日期展开月历。
  // prevDay/nextDay/openCalendar 已在上方定义，此处仅补 UI 事件绑定，不动任何业务/同步逻辑。
  const navPrev = $('nav-prev'), navNext = $('nav-next'), navDate = $('nav-date');
  if (navPrev) navPrev.addEventListener('click', prevDay);
  if (navNext) navNext.addEventListener('click', nextDay);
  if (navDate) navDate.addEventListener('click', openCalendar);

  // 月历 Sheet 交互（纯 UI：月份切换 / 关闭，不动日期/同步/DB/计算逻辑）
  const calPrev = $('cal-prev'), calNext = $('cal-next'), calDone = $('cal-done'), calToday = $('cal-today');
  if (calPrev) calPrev.addEventListener('click', prevMonth);
  if (calNext) calNext.addEventListener('click', nextMonth);
  if (calDone) calDone.addEventListener('click', closeCalendar);
  if (calToday) calToday.addEventListener('click', () => {
    const t = todayStr();
    calYear = +t.slice(0, 4); calMonth = +t.slice(5, 7);
    renderCalendar();
    $('t-date').value = t; $('t-date').dispatchEvent(new Event('change')); updateNavDate();
  });
  // 点击灰色遮罩关闭月历；白色面板内部点击不会触发（backdrop 与 panel 是并列元素，点击面板不会命中 backdrop）
  const calBackdrop = $('cal-backdrop');
  if (calBackdrop) calBackdrop.addEventListener('click', closeCalendar);

  // V3.0.1：显式切换日期 = 用户主动放弃当前未保存输入，先清 dirty 再回填
  $('t-date').addEventListener('change', () => { todayDirty = false; loadTodayInputs($('t-date').value); });
  ['t-xhs', 't-dy', 't-refund', 't-assist', 't-note', 't-material', 't-video']
    .forEach((id) => $(id).addEventListener('input', updateTodaySummary));
  // V3.0.1：手动输入任一字段即标记 dirty（独立监听器，不改动上面的汇总绑定；
  // 程序化 .value= 赋值不触发 input 事件，因此 loadTodayInputs 回填不会误置位）
  ['t-xhs', 't-dy', 't-refund', 't-assist', 't-note', 't-material', 't-video']
    .forEach((id) => $(id).addEventListener('input', () => {
      console.log('[TEMP-DEBUG] INPUT', id, $(id).value);   // 探针1：input 是否触发
      todayDirty = true;
      console.log('[TEMP-DEBUG] DIRTY', todayDirty);        // 探针2：dirty 是否置 true
    }));
  $('t-save').addEventListener('click', handleTodaySave);

  // V3.0.1：macOS Command+S（兼容 Ctrl+S）→ 调用现有保存函数，不新增任何保存逻辑。
  // 编辑弹层打开时保存弹层；否则今日页激活时保存今日。saveRecord 本身未改动。
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 's' && e.key !== 'S')) return;
    console.log('[TEMP-DEBUG] CMD+S');   // 探针3：⌘S/Ctrl+S 是否被捕获
    e.preventDefault();   // 拦截浏览器"存储网页"
    if (!currentUser || $('app').classList.contains('hidden')) return;
    if (!$('edit-sheet').classList.contains('hidden')) { handleEditSave(); return; }
    if ($('today-view').classList.contains('active')) handleTodaySave();
  });

  $('sal-calc').addEventListener('click', handleSalaryCalc);
  document.querySelectorAll('.quick-range .chip').forEach((c) =>
    c.addEventListener('click', () => applyQuickRange(c.dataset.range)));

  $('e-cancel').addEventListener('click', closeEdit);
  $('e-save').addEventListener('click', handleEditSave);
  $('e-delete').addEventListener('click', handleEditDelete);
  document.querySelector('#edit-sheet .sheet-backdrop').addEventListener('click', closeEdit);

  // P1-1 收入记录：独立命名空间，不复用历史 edit-sheet，不改任何同步逻辑
  $('income-add').addEventListener('click', () => openIncomeEditor(null));
  $('income-save').addEventListener('click', handleIncomeSave);
  $('income-cancel').addEventListener('click', closeIncomeEditor);
  $('income-delete').addEventListener('click', handleIncomeDelete);
  $('income-backdrop').addEventListener('click', closeIncomeEditor);
  document.querySelectorAll('#income-type .seg-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#income-type .seg-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  $('income-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) openIncomeEditor(row.dataset.id);
  });
}

/* ---------- 14. 启动 ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  // 网络状态监听：恢复网络自动补推，离线即时更新状态
  window.addEventListener('online', () => { updateSyncStatus(); flushPending(); });
  window.addEventListener('offline', () => { updateSyncStatus(); });
  await tryRestoreSession();
  updateSyncStatus();
  // 注册 Service Worker（PWA 离线壳）
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('service-worker.js');
      // 新 SW 接管后立即重载，确保拿到最新 app.js（避免长期使用旧缓存）
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    } catch (_) {}
  }
});
