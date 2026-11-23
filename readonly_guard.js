/* ============================================================
 * U4 第一批整改 — 统一只读保护层（核心）
 *
 * 职责：把所有「业务写」集中拦截并留下可追踪日志，读（select / GET）放行，
 *       Auth 会话请求放行（保留登录/会话能力），旧 outbox 隔离但不删除。
 *
 * 重要：这是【客户端只读保护，不是服务端 RLS 强制隔离】。
 *       fail-closed：代理自身出错时按写拦截处理，绝不静默放行。
 * ============================================================ */
(function (root) {
  'use strict';
  var W = root || {};
  var GLOBAL = (typeof globalThis !== 'undefined') ? globalThis : W;

  // 四个业务写方法；rpc 一并保守拦截（只读查看端无需远端过程调用）。
  var WRITE_METHODS = { insert: 1, upsert: 1, update: 1, delete: 1, rpc: 1 };

  var state = {
    readOnly: true,
    blockedCount: 0,
    log: [],
    outboxQuarantined: false,
    installed: false
  };

  function isReadOnly() { return true; }

  /** 对任何业务写：抛出明确异常 + 追加可追踪日志 + 计数递增。 */
  function assertWrite(op, detail) {
    var entry = {
      op: String(op || 'unknown-write'),
      detail: detail || {},
      ts: Date.now()
    };
    state.blockedCount += 1;
    state.log.push(entry);
    try {
      console.warn('[LedgerReadOnly] 已拦截写操作:', entry.op, entry.detail);
    } catch (_) {}
    throw new Error('[LedgerReadOnly] 只读查看端：写操作 ' + entry.op +
      ' 已被拦截（客户端只读保护，不是服务端 RLS 强制隔离）');
  }

  /** 记录一条诊断日志（内存 + console.warn）。 */
  function log(msg, data) {
    var entry = { op: 'log', detail: { message: String(msg), data: data }, ts: Date.now() };
    state.log.push(entry);
    try { console.warn('[LedgerReadOnly]', msg, data || ''); } catch (_) {}
    return entry;
  }

  function getLog() { return state.log.slice(); }
  function getBlockedCount() { return state.blockedCount; }

  function getLocalDB() {
    if (W && W.LocalDB) return W.LocalDB;
    if (GLOBAL && GLOBAL.LocalDB) return GLOBAL.LocalDB;
    return null;
  }

  /**
   * 用 Proxy 包一层查询 builder：拦写、放行读。
   * 不假设任何 SDK 内部结构：链式方法返回值继续被包裹，写方法出现在链中任意位置都会被拦；
   * 方法一律 bind 到原始对象执行，避免干扰 SDK 私有字段；代理异常时 fail-closed。
   */
  function wrapBuilder(target, table) {
    if (target === null || target === undefined) return target;
    var t = (typeof target === 'object' || typeof target === 'function') ? target : null;
    if (!t) return target;
    return new Proxy(t, {
      get: function (obj, prop, receiver) {
        try {
          if (typeof prop === 'symbol') return Reflect.get(obj, prop, obj);
          // thenable：只读 select 链仍可被 await 正常决议。
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            var v = Reflect.get(obj, prop, obj);
            return typeof v === 'function' ? v.bind(obj) : v;
          }
          if (Object.prototype.hasOwnProperty.call(WRITE_METHODS, prop)) {
            return function () {
              return assertWrite('supabase.' + String(prop), {
                table: table, method: String(prop)
              });
            };
          }
          var val = Reflect.get(obj, prop, obj);
          if (typeof val === 'function') {
            return function () {
              // bind 到原始对象执行，链式返回值再包一层，写调用在任意位置都被拦。
              var res = val.apply(obj, arguments);
              return wrapBuilder(res, table);
            };
          }
          return val;
        } catch (err) {
          if (err && /LedgerReadOnly/.test(String(err.message || err))) throw err;
          return assertWrite('supabase.guard-error', { table: table, prop: String(prop) });
        }
      }
    });
  }

  /** 代理 Supabase client：只拦截 from(table) 的写 builder，auth 等原样放行。 */
  function guardSupabaseClient(sb) {
    if (!sb) return sb;
    return new Proxy(sb, {
      get: function (obj, prop, receiver) {
        try {
          if (prop === 'from') {
            var from = Reflect.get(obj, prop, obj);
            return function (table) {
              return wrapBuilder(from.call(obj, table), table);
            };
          }
          return Reflect.get(obj, prop, obj);   // auth / 会话能力保留
        } catch (err) {
          if (err && /LedgerReadOnly/.test(String(err.message || err))) throw err;
          return assertWrite('supabase.client-guard-error', { prop: String(prop) });
        }
      }
    });
  }

  /** 日志脱敏：只保留路径，绝不记录 host / project ref / query 凭据。 */
  function sanitizeUrl(u) {
    var s = String(u || '');
    try { return new URL(s).pathname; } catch (_) {
      var i = s.indexOf('://');
      return i >= 0 ? s.slice(s.indexOf('/', i + 3)) : s;
    }
  }

  /** Auth 会话请求（token 刷新 / 登录 / 登出 / user）放行，只拦业务表写。 */
  function isSessionRequest(url) {
    return String(url || '').indexOf('/auth/v1/') >= 0;
  }

  /** 拦截非 GET/HEAD 的业务请求（含 /rest/v1/ 的 POST/PATCH/PUT/DELETE）。 */
  function guardFetch(originalFetch) {
    if (typeof originalFetch !== 'function') return originalFetch;
    return function guardedFetch(input, init) {
      var url = '';
      var method = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') url = input.url;
        method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      } catch (_) {}
      if (method === 'GET' || method === 'HEAD' || isSessionRequest(url)) {
        return originalFetch(input, init);
      }
      return assertWrite('fetch.' + method, {
        url: sanitizeUrl(url),
        method: method,
        rest: String(url).indexOf('/rest/v1/') >= 0
      });
    };
  }

  var OUTBOX_QUARANTINE_KEY = 'outbox_quarantined';

  /** 把旧版遗留 outbox 标记为隔离：不清数据、不重放，返回可展示的数量。 */
  async function quarantineOutbox() {
    var pendingCount = 0;
    var pieceworkPendingCount = 0;
    var ldb = getLocalDB();
    try {
      if (ldb && typeof ldb.getAllPending === 'function') {
        pendingCount = (await ldb.getAllPending()).length;
      }
      if (ldb && typeof ldb.getAllPieceworkPending === 'function') {
        pieceworkPendingCount = (await ldb.getAllPieceworkPending()).length;
      }
      // 只写 meta 标记，绝不删除旧 outbox 数据。
      if (ldb && typeof ldb.setOutboxQuarantined === 'function') {
        await ldb.setOutboxQuarantined(true);
      } else if (ldb && typeof ldb.setMeta === 'function') {
        await ldb.setMeta(OUTBOX_QUARANTINE_KEY, true);
      }
    } catch (_) {}
    state.outboxQuarantined = true;
    log('旧版遗留 outbox 已隔离（不清数据、不重放）', {
      pendingCount: pendingCount, pieceworkPendingCount: pieceworkPendingCount
    });
    return {
      quarantined: true,
      pendingCount: pendingCount,
      pieceworkPendingCount: pieceworkPendingCount
    };
  }

  function isOutboxQuarantined() { return state.outboxQuarantined === true; }

  /** 一站式安装：返回被代理的 sb / fetch，由调用方替换全局引用。 */
  function installReadOnlyGuards(opts) {
    opts = opts || {};
    var config = opts.config || (W && W.LEDGER_ENV_CONFIG) || null;
    var guardedSb = opts.sb ? guardSupabaseClient(opts.sb) : null;
    var originalFetch = opts.fetch || (W && W.fetch) ||
      (typeof fetch !== 'undefined' ? fetch : null);
    var guardedFetch = guardFetch(originalFetch);
    state.installed = true;
    log('只读保护已安装', { env: config && config.ACTIVE_ENV, readOnly: true });
    return {
      sb: guardedSb,
      fetch: guardedFetch,
      readOnly: true,
      config: config,
      LedgerReadOnly: api
    };
  }

  var api = {
    isReadOnly: isReadOnly,
    assertWrite: assertWrite,
    log: log,
    getLog: getLog,
    getBlockedCount: getBlockedCount,
    guardSupabaseClient: guardSupabaseClient,
    guardFetch: guardFetch,
    quarantineOutbox: quarantineOutbox,
    isOutboxQuarantined: isOutboxQuarantined,
    installReadOnlyGuards: installReadOnlyGuards,
    OUTBOX_QUARANTINE_KEY: OUTBOX_QUARANTINE_KEY
  };

  W.LedgerReadOnly = api;
  if (GLOBAL !== W) GLOBAL.LedgerReadOnly = api;

  // 兼容 Node：可用 require 或 vm 加载，测试无网络。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
