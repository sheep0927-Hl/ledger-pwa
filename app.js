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

/* ---------- 2. 工资计算参数（镜像 macOS Store 默认值） ----------
 * 若 macOS 端修改了单价/底薪规则，请同步修改此处常量。 */
const CONFIG = {
  price: 4,            // 出单单价（xhs / dy / refund 共用）
  notePrice: 4,        // 图文单价
  materialPrice: 4,    // 素材单价
  videoPrice: 30,      // 视频单价
  salaryThreshold: 20000, // 底薪达标线
  salaryHigh: 2000,    // 达标底薪（收入 > 达标线）
  salaryLow: 3000      // 未达标底薪
};

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
  await loadRecords();
  startAutoPull();   // 登录成功后启动自动拉取（每 30 秒刷新）
  updateSyncStatus();
  if (navigator.onLine) flushPending();   // 启动即补推（fire-and-forget）
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
  autoPullTimer = setInterval(() => {
    console.log('[TEMP-DEBUG] AUTOPULL', todayDirty);   // 探针6：30s 自动拉取时 dirty 状态
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
  console.log('[TEMP-DEBUG] SAVE RECORD', rec);   // 探针5：saveRecord 是否收到数据
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
    showBanner('已保存到本地（离线或同步失败），联网后将自动同步', 'warn');
    renderHistory();
    updateSyncStatus();
    return;
  }
  // 成功：清除该日期可能残留的待同步项
  try { await LocalDB.deletePendingByDate(rec.date); } catch (_) {}
  await loadRecords();
  updateSyncStatus();
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
    const pending = await LocalDB.getAllPending();
    if (!pending.length) return;
    for (const entry of pending) {
      let err = null;
      try { err = await replayPending(entry); } catch (e) { err = e; }
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
function computeSalary(recs) {
  const sum = (k) => recs.reduce((a, r) => a + num(r[k]), 0);
  const sumXHS = sum('xhs'), sumDY = sum('dy'), sumRef = sum('refund');
  const sumNote = sum('note_qty'), sumMat = sum('material_qty'), sumVid = sum('video_qty');
  const sumAssist = recs.reduce((a, r) => a + (isAssistVisible(r.date) ? num(r.assist) : 0), 0); // V2.6.1：仅计入 <2026-08-01 的助播（展示层）

  const refundCut = sumRef * CONFIG.price;
  const xhsAmt = sumXHS * CONFIG.price;
  const dyAmt = sumDY * CONFIG.price;
  const liveIncome = xhsAmt + dyAmt - refundCut;          // 直播出单收入

  const noteIncome = sumNote * CONFIG.notePrice;          // 图片收入
  const matIncome = sumMat * CONFIG.materialPrice;        // 素材收入
  const vidIncome = sumVid * CONFIG.videoPrice;           // 视频收入
  const accIncome = noteIncome + matIncome + vidIncome;   // 账号笔记视频收入

  const base = (liveIncome + accIncome) > CONFIG.salaryThreshold ? CONFIG.salaryHigh : CONFIG.salaryLow;
  const total = liveIncome + accIncome + base;            // 应发总额（助播不计入，与 macOS 一致）

  return {
    sumXHS, sumDY, sumRef, sumNote, sumMat, sumVid, sumAssist,
    xhsAmt, dyAmt, refundCut, liveIncome,
    noteIncome, matIncome, vidIncome, accIncome,
    base, total
  };
}

/* ---------- 8. 视图切换 ---------- */
const TAB_TITLE = { today: '今日', history: '历史', income: '收入记录', salary: '工资' };
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
  const out = net * CONFIG.price;
  const pub = r.note_qty * CONFIG.notePrice + r.material_qty * CONFIG.materialPrice + r.video_qty * CONFIG.videoPrice;
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
  if (rfMoney) rfMoney.textContent = (r.refund > 0 ? '-' : '') + fmtMoney(r.refund * CONFIG.price);
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
  console.log('[TEMP-DEBUG] SAVE START', rec.date, rec);   // 探针4：handleTodaySave 是否执行
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
    await saveRecord(rec, revive);
    todayDirty = false;   // 仅在保存链路正常返回后清除
    $('t-status').textContent = revive ? '✅ 已恢复并保存，已同步到云端' : '✅ 已保存并同步到云端';
  } catch (err) {
    $('t-status').textContent = '保存失败：' + (err.message || err);
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
    const net = r.xhs + r.dy - r.refund;
    const total = (net * CONFIG.price) + r.assist +
      (r.note_qty * CONFIG.notePrice + r.material_qty * CONFIG.materialPrice + r.video_qty * CONFIG.videoPrice);
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
      const net = r.xhs + r.dy - r.refund;
      const total = (net * CONFIG.price) + r.assist +
        (r.note_qty * CONFIG.notePrice + r.material_qty * CONFIG.materialPrice + r.video_qty * CONFIG.videoPrice);
      sum += total;
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
    await saveRecord(rec, revive);
    closeEdit();
    // 若编辑的是今日，刷新今日页输入
    if (rec.date === $('t-date').value) loadTodayInputs(rec.date);
  } catch (err) {
    $('e-status').textContent = '保存失败：' + (err.message || err);
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
    <div class="sal-row"><div class="sal-l">底薪<em>${(s.liveIncome + s.accIncome) > CONFIG.salaryThreshold ? '已达标' : '未达标'}</em></div><b>${fmtMoney(s.base)}</b></div>
    ${s.sumAssist !== 0 ? `<div class="sal-row muted"><div class="sal-l">助播（不计入总额，仅参考）</div><b>${fmtMoney(s.sumAssist)}</b></div>` : ''}
    <div class="sal-total">
      <span>应发总额</span>
      <div class="sal-total-num">${fmtMoney(s.total)}</div>
    </div>`;
}

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
  }
  // 账号管理 / 设置为预留入口，当前无操作
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
    try { await navigator.serviceWorker.register('service-worker.js'); } catch (_) {}
  }
});
