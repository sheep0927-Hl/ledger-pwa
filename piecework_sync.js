/* 账号计件离线同步核心（独立于 daily_records 的旧同步核心，不重写旧路径）
 *
 * 最终五项口径（与 Mac AccountPieceworkEngine.items、pwa/app.js、Supabase 迁移 11 完全一致）：
 *   xiaohongshu_sam    : note(图文) 5 / video(视频) 31
 *   xiaohongshu_beebag : note(图文) 4 / video(视频) 30
 *   douyin_sam         : publish(发布总数) 4  ← 只有一个数量，绝不拆成图文 + 视频双算
 *
 * 设计约束：
 *  - 仅封装「离线待同步队列的补推」纯逻辑，网络 I/O 由调用方以适配器注入，便于在
 *    Node 中用 mock 做端到端验证（浏览器外也能跑真实代码）。
 *  - 与 daily_records 的 flushPending / replayPending 物理隔离（独立 outbox 表 pending_pw），
 *    绝不混入旧队列；本文件不触碰任何旧同步代码。
 *  - 单价快照在「保存时」写入行内（*_unit_price_snapshot），调价不影响已存记录。
 *  - 同一 (user_id, business_date, account_code) 用 onConflict upsert，重复提交不会生成两条计费。
 *  - 未设置单价 = 该账号/内容在业务日无生效价格（null），数量>0 时阻止生成，绝不默认为 0 元。
 */
var PieceworkSync = (function () {
  // 账号 → 允许的计件类型（唯一真相源；抖音只有 publish）
  var PW_ACCOUNT_CONTENT = {
    xiaohongshu_sam: ['note', 'video'],
    xiaohongshu_beebag: ['note', 'video'],
    douyin_sam: ['publish']
  };
  var PW_COUNT_FIELD = { note: 'note_count', video: 'video_count', publish: 'publish_count' };
  var PW_PRICE_FIELD = {
    note: 'note_unit_price_snapshot',
    video: 'video_unit_price_snapshot',
    publish: 'publish_unit_price_snapshot'
  };
  var PW_DEFAULT_PRICES = {
    'xiaohongshu_sam|note': 5, 'xiaohongshu_sam|video': 31,
    'xiaohongshu_beebag|note': 4, 'xiaohongshu_beebag|video': 30,
    'douyin_sam|publish': 4
  };

  function rid() {
    try {
      if (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (_) {}
    return 'pw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function nonNeg(v) { const n = parseInt(v, 10); return isNaN(n) || n < 0 ? 0 : n; }

  // 构建一条计件 upsert 行（含保存时单价快照）。
  // opt.counts / opt.prices 均为 { note?, video?, publish? }；price = null 表示「未设置」。
  // 返回 { row } 或 { blocked:true }（有数量但对应单价未设置 → 不应据此计费）。
  function makePieceworkRow(opt) {
    const { date, account, counts, prices, uid, existingId, now } = opt;
    const allowed = PW_ACCOUNT_CONTENT[account] || [];
    const c = counts || {}, p = prices || {};
    const row = {
      id: existingId || rid(),
      user_id: uid,
      business_date: date,
      account_code: account,
      // 五个数量列 / 五个快照列同存；非该账号允许的类型恒为 0
      // （抖音行绝不出现 note/video 数量，publish 不伪装成 graphic/video）。
      note_count: 0, video_count: 0, publish_count: 0,
      note_unit_price_snapshot: 0, video_unit_price_snapshot: 0, publish_unit_price_snapshot: 0,
      created_at: now,
      updated_at: now
    };
    for (const ct of allowed) {
      const n = nonNeg(c[ct]);
      const rawPrice = (p[ct] === undefined || p[ct] === null) ? null : p[ct];
      if (n > 0 && rawPrice === null) return { blocked: true };
      row[PW_COUNT_FIELD[ct]] = n;
      row[PW_PRICE_FIELD[ct]] = rawPrice === null ? 0 : nonNeg(rawPrice);
    }
    return { row: row };
  }

  // 单条记录金额：只累加该账号允许的类型，从结构上杜绝抖音 publish 双算。
  function pieceworkRowAmount(r) {
    let sum = 0;
    for (const ct of (PW_ACCOUNT_CONTENT[r.account_code] || [])) {
      sum += (Number(r[PW_COUNT_FIELD[ct]]) || 0) * (Number(r[PW_PRICE_FIELD[ct]]) || 0);
    }
    return sum;
  }

  // 离线补推（纯逻辑，适配器注入 I/O）：
  //  - items: 待同步项数组（按 createdAt 升序）
  //  - upsertPiecework(rows): 返回 null/undefined 表示成功，否则视为失败（保留队列）
  //  - upsertPrices(rows): 同上（价格历史）
  //  - onSuccess(entry): 单条成功后回调（调用方负责从 outbox 删除）
  //  - onFail(entry, err): 单条失败后回调并【立即中止】（保留剩余队列，下次重试）
  //  - onConflict(entry): 可选，服务端返回「冲突/更优版本」时回调（用于提示，不静默覆盖）
  async function flush(opts) {
    const { items, upsertPiecework, upsertPrices, onSuccess, onFail, onConflict } = opts;
    if (!items || !items.length) return { processed: 0, remaining: 0 };
    let processed = 0;
    for (const entry of items) {
      let err = null, conflict = false;
      try {
        if (entry.kind === 'price') {
          err = await upsertPrices(entry.payload.rows);
        } else {
          // 模拟服务端「冲突」：若注入返回 { conflict:true } 则视为冲突而非普通失败
          const res = await upsertPiecework([entry.payload]);
          if (res && res.conflict) { conflict = true; err = new Error('conflict'); }
        }
      } catch (e) { err = e; }
      if (err) {
        if (conflict && onConflict) onConflict(entry, err);
        else if (onFail) onFail(entry, err);
        break; // 失败/冲突立即中止，保留队列
      }
      processed++;
      if (onSuccess) await onSuccess(entry);
    }
    return { processed, remaining: items.length - processed };
  }

  return {
    rid, makePieceworkRow, pieceworkRowAmount, flush,
    PW_ACCOUNT_CONTENT, PW_COUNT_FIELD, PW_PRICE_FIELD, PW_DEFAULT_PRICES
  };
})();

if (typeof window !== 'undefined') window.PieceworkSync = PieceworkSync;
if (typeof module !== 'undefined' && module.exports) module.exports = PieceworkSync;
