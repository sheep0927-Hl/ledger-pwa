/* 总账 Ledger PWA — 离线本地数据层（IndexedDB 原生封装）
 *
 * 设计约束（V2.2 Phase 1 / Phase 2）：
 *  - 使用原生 IndexedDB，不引入任何第三方依赖。
 *  - 所有 IndexedDB 操作必须经由本模块；业务代码（app.js）禁止直接调用 indexedDB.open。
 *  - 仅个人使用：records 按 user_id 隔离（store 上建 user_id 索引）。
 *
 * 存储：
 *  - DB 名 ledger-offline，version 3
 *  - store "records"：keyPath = date，保存当前用户记录镜像（含 user_id / 业务字段 / modifiedAt / *_modified_at / deleted_at）
 *  - store "meta"：keyPath = key，保存 lastSyncAt、会话缓存、当前用户等元信息
 *  - store "pending"：keyPath = id，离线待同步队列（outbox，daily_records 用）
 *       字段：id / date / action('save'|'delete') / payload / createdAt
 *       - 不影响 records / meta；不删除任何现有数据；不改变读取逻辑。
 *       - 仅由 saveRecord / deleteRecord 在上传失败时写入、由网络恢复补推成功时删除。
 *  - store "piecework"：keyPath = pw_key，账号计件【已提交镜像】（断网时也保留，刷新/重开可恢复展示）
 *  - store "pending_pw"：keyPath = id，账号计件 / 计价【离线待同步队列】（outbox，独立于 daily_records）
 *       - 复用与 pending 完全相同的「失败入队、联网补推、成功出队」语义，但物理隔离，
 *         绝不混入 daily_records 的 pending，避免旧同步核心误处理新模块数据。
 *       - 字段：id / kind('piecework'|'price') / date / account / action / payload / createdAt
 */
var LocalDB = (function () {
  const DB_NAME = 'ledger-offline';
  const DB_VERSION = 3;
  const STORE_RECORDS = 'records';
  const STORE_META = 'meta';
  const STORE_PENDING = 'pending';
  const STORE_PIECEWORK = 'piecework';
  const STORE_PENDING_PW = 'pending_pw';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !('indexedDB' in window) || !window.indexedDB) {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const rs = db.createObjectStore(STORE_RECORDS, { keyPath: 'date' });
          rs.createIndex('user_id', 'user_id', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        // Phase 2：新增离线待同步队列（首次升级到 v2 时创建，已有库自动补齐）
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          const ps = db.createObjectStore(STORE_PENDING, { keyPath: 'id' });
          ps.createIndex('date', 'date', { unique: false });
        }
        // 账号计件：已提交镜像 + 离线待同步队列（升级到 v3 时创建，已有库自动补齐）
        if (!db.objectStoreNames.contains(STORE_PIECEWORK)) {
          const pw = db.createObjectStore(STORE_PIECEWORK, { keyPath: 'pw_key' });
          pw.createIndex('user_id', 'user_id', { unique: false });
          pw.createIndex('business_date', 'business_date', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PENDING_PW)) {
          const pp = db.createObjectStore(STORE_PENDING_PW, { keyPath: 'id' });
          pp.createIndex('kind', 'kind', { unique: false });
          pp.createIndex('date', 'date', { unique: false });
        }
      };
      // 多标签页/旧页面仍占用数据库时：升级会被阻塞。必须给出明确提示，
      // 不能静默挂起或清除数据库（upgradeneeded 只会新建 store，绝不删除旧数据）。
      req.onblocked = () => reject(new Error(
        '数据库升级被阻塞：检测到其他页面/标签页仍打开本应用。' +
        '请关闭所有本应用标签页后重试，升级期间不会清除任何本地数据。'));
      req.onsuccess = () => {
        // 当其他上下文请求更高版本时，主动关闭本连接，避免反过来阻塞对方升级。
        req.result.onversionchange = () => { try { req.result.close(); } catch (_) {} };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // 获取一个 objectStore（自动等待 DB 就绪）
  function store(name, mode) {
    return openDB().then((db) => db.transaction(name, mode).objectStore(name));
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function genId() {
    try {
      if (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
      }
    } catch (_) { /* 忽略，走降级 */ }
    return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // 单调序号：保证 createdAt 在同一毫秒内的多次写入也能严格有序（补推按创建顺序执行）
  let _seq = 0;

  /* ---------- records ---------- */

  // 写入（upsert）一条记录镜像。record 必须含 date 与 user_id。
  async function putRecord(record) {
    const s = await store(STORE_RECORDS, 'readwrite');
    return reqToPromise(s.put(record));
  }

  // 读取某用户全部记录（按 date 倒序），仅当前用户。userId 为空返回 []。
  async function getAllRecords(userId) {
    if (userId == null) return [];
    const s = await store(STORE_RECORDS, 'readonly');
    const all = await reqToPromise(s.getAll());
    const rows = (all || []).filter((r) => r.user_id === userId);
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return rows;
  }

  // 按 date 读取单条记录。
  async function getRecord(date) {
    const s = await store(STORE_RECORDS, 'readonly');
    const row = await reqToPromise(s.get(date));
    return row || null;
  }

  // 离线删除：写入 deleted_at tombstone，不做物理删除（与 Supabase 软删除语义一致）。
  // 保留该行的其余字段，便于后续同步为 tombstone 时云端其余列不丢失。
  async function deleteRecord(date) {
    const existing = await getRecord(date);
    const tomb = Object.assign({}, existing || {}, { date, deleted_at: new Date().toISOString() });
    if (existing && existing.user_id) tomb.user_id = existing.user_id;
    return putRecord(tomb);
  }

  /* ---------- meta ---------- */

  async function getMeta(key) {
    const s = await store(STORE_META, 'readonly');
    const row = await reqToPromise(s.get(key));
    return row ? row.value : null;
  }

  async function setMeta(key, value) {
    const s = await store(STORE_META, 'readwrite');
    return reqToPromise(s.put({ key, value }));
  }

  /* ---------- U4：旧 outbox 隔离标记（持久化在 meta） ----------
   * 隔离后 getAllPending / getAllPieceworkPending 仍可【只读返回数量】，
   * 但任何补推路径都不重放（由 app.js 的 assertReadOnly 保证）；不删除旧 outbox 数据。 */
  const OUTBOX_QUARANTINE_KEY = 'outbox_quarantined';
  async function setOutboxQuarantined(flag) {
    return setMeta(OUTBOX_QUARANTINE_KEY, !!flag);
  }
  async function isOutboxQuarantined() {
    try { return (await getMeta(OUTBOX_QUARANTINE_KEY)) === true; } catch (_) { return false; }
  }

  /* ---------- pending（离线待同步队列 / outbox） ---------- */

  /**
   * 写入一条待同步项。
   *  - action: 'save' | 'delete'
   *  - payload: 上传时应提交给 Supabase 的对象（save=整条 upsert；delete={user_id,date,deleted_at}）
   *  - createdAt: 排序用，补推按创建顺序执行
   * 不直接删除现有数据，不影响 records / meta。
   */
  async function putPending(entry) {
    const rec = {
      id: entry.id || genId(),
      date: entry.date,
      action: entry.action,
      payload: entry.payload || null,
      // createdAt 保留真实时间前缀，并追加单调序号，确保同毫秒内严格有序（补推顺序正确）
      createdAt: (entry.createdAt || new Date().toISOString()) + '|' + (++_seq)
    };
    const s = await store(STORE_PENDING, 'readwrite');
    return reqToPromise(s.put(rec));
  }

  // 读取全部待同步项，按 createdAt 升序。U4：隔离状态下仅用于【只读展示数量】，不参与任何重放。
  async function getAllPending() {
    const s = await store(STORE_PENDING, 'readonly');
    const all = await reqToPromise(s.getAll());
    return (all || []).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  // 按 id 删除一条待同步项（补推成功一条删一条）。
  async function deletePending(id) {
    const s = await store(STORE_PENDING, 'readwrite');
    return reqToPromise(s.delete(id));
  }

  // 按 date 删除该日期所有待同步项（某次在线操作成功，清除可能残留的旧待同步项）。
  async function deletePendingByDate(date) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING, 'readwrite');
      const os = tx.objectStore(STORE_PENDING);
      const idx = os.index('date');
      const getReq = idx.getAllKeys(date);
      getReq.onsuccess = () => {
        const keys = getReq.result || [];
        let i = 0;
        const next = () => {
          if (i >= keys.length) { resolve(); return; }
          const delReq = os.delete(keys[i]);
          delReq.onsuccess = () => { i++; next(); };
          delReq.onerror = () => reject(delReq.error);
        };
        next();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  // 账号计件「已提交镜像」：keyPath = pw_key（business_date|account_code）
  function pwKey(date, account) { return date + '|' + account; }

  // 写入/更新一条计件镜像（离线也能保留；与 Supabase 行同构，额外带 pw_key）
  async function putPiecework(row) {
    const rec = Object.assign({}, row, { pw_key: pwKey(row.business_date, row.account_code) });
    const s = await store(STORE_PIECEWORK, 'readwrite');
    return reqToPromise(s.put(rec));
  }

  // 读取某用户全部计件镜像（按 business_date 倒序），仅当前用户。
  async function getAllPiecework(userId) {
    if (userId == null) return [];
    const s = await store(STORE_PIECEWORK, 'readonly');
    const all = await reqToPromise(s.getAll());
    const rows = (all || []).filter((r) => r.user_id === userId);
    rows.sort((a, b) => (b.business_date || '').localeCompare(a.business_date || ''));
    return rows;
  }

  // 软删：写入 deleted_at tombstone（与 Supabase 软删语义一致），其余字段保留。
  async function deletePiecework(date, account) {
    const existing = await getPiecework(date, account);
    const tomb = Object.assign({}, existing || {}, {
      business_date: date, account_code: account,
      deleted_at: new Date().toISOString()
    });
    if (existing && existing.user_id) tomb.user_id = existing.user_id;
    return putPiecework(tomb);
  }

  async function getPiecework(date, account) {
    const s = await store(STORE_PIECEWORK, 'readonly');
    const row = await reqToPromise(s.get(pwKey(date, account)));
    return row || null;
  }

  /* ---------- pending_pw（账号计件离线待同步队列 / outbox） ---------- */

  // 写入一条待同步项。kind: 'piecework' | 'price'；action: 'save' | 'delete' | 'price'
  // 不直接删除现有数据；离线录入后联网补推。
  async function putPieceworkPending(entry) {
    const rec = {
      id: entry.id || genId(),
      kind: entry.kind || 'piecework',
      date: entry.date || null,
      account: entry.account || null,
      action: entry.action || 'save',
      payload: entry.payload || null,
      createdAt: (entry.createdAt || new Date().toISOString()) + '|' + (++_seq)
    };
    const s = await store(STORE_PENDING_PW, 'readwrite');
    return reqToPromise(s.put(rec));
  }

  // 读取全部待同步项，按 createdAt 升序（补推顺序）。
  async function getAllPieceworkPending() {
    const s = await store(STORE_PENDING_PW, 'readonly');
    const all = await reqToPromise(s.getAll());
    return (all || []).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  // 按 id 删除一条待同步项（补推成功一条删一条）。
  async function deletePieceworkPending(id) {
    const s = await store(STORE_PENDING_PW, 'readwrite');
    return reqToPromise(s.delete(id));
  }

  // 按 (date, account) 删除该键所有待同步项（某次在线操作成功，清除残留）。
  async function deletePieceworkPendingByKey(date, account) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_PW, 'readwrite');
      const os = tx.objectStore(STORE_PENDING_PW);
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const v = cur.value;
        if (v.date === date && v.account === account) cur.delete();
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  return {
    openDB, putRecord, getAllRecords, getRecord, deleteRecord,
    getMeta, setMeta, setOutboxQuarantined, isOutboxQuarantined, OUTBOX_QUARANTINE_KEY,
    putPending, getAllPending, deletePending, deletePendingByDate,
    putPiecework, getAllPiecework, getPiecework, deletePiecework,
    putPieceworkPending, getAllPieceworkPending, deletePieceworkPending, deletePieceworkPendingByKey
  };
})();

if (typeof window !== 'undefined') window.LocalDB = LocalDB;
