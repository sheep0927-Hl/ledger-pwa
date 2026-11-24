/* =============================================================================
 * 最终工资规则 · PWA 界面集成层（11 项主表 / 历史 / 月度 / 六价设置）
 *
 * 依赖：final_wage.js（规则真源）、app.js（既有数据/保存/同步链路）、
 *       piecework_sync.js、localdb.js、style.css。
 *
 * 设计铁律
 *   - 不修改 app.js 的任何既有函数体；通过「包装」接管金额与渲染，
 *     旧 DOM id（t-* / e-*）保留在隐藏兼容层，字段级 LWW / 离线队列 / 同步零回归。
 *   - 5 项账号计件数量写既有 accountPiecework 行（LocalDB + 独立 outbox）；
 *     SAM 素材数量复用既有 material_qty；出单/退款/抖音出单/额外收入复用既有字段。
 *   - 历史日（date < F）金额 = 锁定的旧链路原值，不按新六项重算、不拆分旧账。
 *   - 空值显示「—」、显式 0 显示「0」、单价未设置显示「未设置」并阻止保存。
 *   - 抖音不记录退款（11 项中无抖音退款字段）。
 *   - Mock 数据模式（?fwdemo=1）：注入测试数据渲染真实页面供截图验收，
 *     不登录、不联网、不写 Supabase、不改生产数据。
 * ========================================================================== */
(function () {
  'use strict';

  var FW = (typeof FinalWage !== 'undefined') ? FinalWage
    : (typeof require === 'function' ? require('./final_wage.js') : null);
  if (!FW) { console.error('[FW] final_wage.js 未加载'); return; }

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var KEY_BOOK = 'final_wage_prices';
  var KEY_FROM = 'final_wage_effective_from';
  var KEY_BASELINE = 'final_wage_legacy_baseline';

  /* 独立版本标识：证明「本次价格簿合并修复版 UI」确实加载。
   * 与 app.js 的 APP_BUILD_ID 解耦 —— 后者自 20261123 未变，无法证明 UI 修复版生效。
   * 严禁在此写入任何密钥/URL/账号信息。 */
  var FINAL_WAGE_UI_BUILD_ID = '20261124-price-merge-v1';

  var STATE = {
    book: [],
    from: FW.DEFAULT_EFFECTIVE_FROM,
    baseline: null,
    mock: false,
    editDate: null,
    accountPricesMissing: false
  };

  /* ---------- 本地配置（IndexedDB / localStorage 均可，绝不写云端） ---------- */
  function readLocal(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (_) { return fallback; }
  }
  function writeLocal(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  function loadState() {
    STATE.from = readLocal(KEY_FROM, FW.DEFAULT_EFFECTIVE_FROM) || FW.DEFAULT_EFFECTIVE_FROM;
    var book = readLocal(KEY_BOOK, null);
    if (!Array.isArray(book) || !book.length) {
      book = FW.seedBook(STATE.from, []);
      writeLocal(KEY_BOOK, book);
    }
    STATE.book = book;
    STATE.baseline = readLocal(KEY_BASELINE, null);
  }

  /* ---------- 账户价格历史合并（对齐 Mac FinalWageStoreAdapter.mergedFinalWageEntries） ----------
   * Mac 语义（Sources/FinalWageStoreAdapter.swift:90）：
   *   derived = accountPrices.filter { !$0.isDeleted }.map {
   *     key: accountCode + "|" + contentType, unitPrice, effectiveFrom }
   *   merged = finalWagePrices + derived   —— 直接拼接，不去重；
   *   取价由 priceAt 按 (effective_from, created_at) 升序取 <= date 的最后一条。
   * PWA 同构：非删 account_price_history 行 → FW 条目追加在播种簿之后；
   *   FW.priceAt 稳定排序下同 effective_from 时后 appended 者胜出（等价 Mac 语义：
   *   云端行 created_at 晚于播种簿出厂）。绝不硬编码单价，绝不回落迁移默认价。 */
  function derivedAccountEntries() {
    var src = null;
    try { if (typeof accountPrices !== 'undefined' && accountPrices) src = accountPrices; } catch (_) {}
    if (!src || !src.length) return [];
    return src.filter(function (p) { return p && !p.deleted_at; }).map(function (p) {
      return {
        key: p.account_code + '|' + p.content_type,
        unit_price: FW.num(p.unit_price),
        effective_from: p.effective_from,
        created_at: p.created_at || ''
      };
    });
  }
  function mergedBook() {
    var derived = derivedAccountEntries();
    return derived.length ? STATE.book.concat(derived) : STATE.book;
  }

  /** 账户价格历史加载结果提示（授权要求 8：加载失败/为空不得静默当作正确工资）。
   *  已登录 + 云端行数为空 + 非 Mock → 历史页横幅显示警告，提示单价可能回落默认值。 */
  function refreshAccountPricesHealth() {
    STATE.accountPricesMissing = false;
    if (STATE.mock) return;
    var logged = false;
    try { logged = (typeof currentUser !== 'undefined' && currentUser && !!currentUser.id); } catch (_) {}
    if (!logged) return;
    var src = null;
    try { if (typeof accountPrices !== 'undefined' && accountPrices) src = accountPrices; } catch (_) {}
    if (!src || !src.length) STATE.accountPricesMissing = true;
  }

  /** loadAccountPrices 完成后（成功/失败均触发）刷新全部工资视图，
   *  避免「先用默认价渲染、账户价到达后不更新」（授权要求 7）。 */
  function applyAccountPricesRefresh() {
    refreshAccountPricesHealth();
    renderEntry();
    renderHistoryTable();
    renderPriceSettings();
    // 通知诊断面板（仅 ?diag=1 有监听）：账户价到达后已重算，可刷新运行时快照。
    try { window.dispatchEvent(new CustomEvent('fw-diag-refresh')); } catch (_) {}
  }

  /** 启用瞬间固化历史取价基线（只做一次），保证此后改价不重算旧月。
   *  关键：必须采集【启用瞬间旧链路真实会用的取价】，而不是出厂默认。
   *  有 PRICE_VERSIONS 时 configAt 返回最早版本；无版本时返回当前 CONFIG。
   *  与 Mac 端 PriceHistory.config(at: "2000-01-01", fallback: currentPriceConfig()) 同构，
   *  因此「启用前」与「启用后」历史金额逐字相同。 */
  function ensureBaseline() {
    if (STATE.baseline) return;
    var versions = (typeof PRICE_VERSIONS !== 'undefined') ? PRICE_VERSIONS : [];
    var c = (typeof configAt === 'function')
      ? configAt('2000-01-01')
      : FW.legacyConfigAt('2000-01-01', versions, null);
    STATE.baseline = {
      price: c.price, notePrice: c.notePrice, materialPrice: c.materialPrice,
      videoPrice: c.videoPrice, salaryThreshold: c.salaryThreshold,
      salaryHigh: c.salaryHigh, salaryLow: c.salaryLow
    };
    writeLocal(KEY_BASELINE, STATE.baseline);
  }

  function priceAt(key, date) { return FW.priceAt(key, date, mergedBook()); }

  /* ---------- 11 项数据读取 / 写入 ---------- */

  /** 读取某日的 11 项值（前 6 项：5 个来自 accountPiecework，素材来自 material_qty） */
  function readFields(date) {
    var rec = (typeof records !== 'undefined' && records)
      ? records.find(function (r) { return r.date === date && !r.deleted_at; }) : null;
    var out = {};
    FW.FIELDS.forEach(function (f) { out[f.key] = FW.isActive(date, STATE.from) ? 0 : null; });
    if (!rec) return out;
    out.xhs_order = FW.num(rec.xhs);
    out.xhs_refund = FW.num(rec.refund);
    out.dy_order = FW.num(rec.dy);
    out.extra_income = FW.num(rec.assist);
    out.sam_material = FW.num(rec.material_qty);
    if (typeof accountPiecework !== 'undefined' && accountPiecework) {
      FW.ITEMS.forEach(function (it) {
        if (it.content === 'material') return;
        var row = accountPiecework.find(function (r) {
          return !r.deleted_at && r.business_date === date && r.account_code === it.account;
        });
        if (!row) return;
        var col = { note: 'note_count', video: 'video_count', publish: 'publish_count' }[it.content];
        out[it.fieldKey] = FW.num(row[col]);
      });
    }
    return out;
  }

  /** 某日金额（唯一入口，Mac FinalWageCalculator.daily 同构） */
  function dailyOf(date) {
    var rec = (typeof records !== 'undefined' && records)
      ? records.find(function (r) { return r.date === date && !r.deleted_at; }) : null;
    if (!rec) return null;
    var f = readFields(date);
    var counts = {};
    FW.ITEMS.forEach(function (it) { counts[it.fieldKey] = FW.num(f[it.fieldKey]); });
    var versions = (typeof PRICE_VERSIONS !== 'undefined') ? PRICE_VERSIONS : [];
    return FW.daily({
      date: date, counts: counts,
      xhs: rec.xhs, refund: rec.refund, dy: rec.dy, extra: rec.assist,
      effectiveFrom: STATE.from, entries: mergedBook(),
      dyOrderUnitPrice: (typeof configAt === 'function' ? configAt(date).price : 4),
      legacyTotal: FW.legacyTotal(rec, {
        versions: versions, baseline: STATE.baseline,
        isPieceworkActive: (typeof isPieceworkActive === 'function' ? isPieceworkActive : null),
        pieceworkDailyAmount: (typeof pieceworkDailyAmount === 'function' ? pieceworkDailyAmount : null)
      }),
      legacyNoteQty: rec.note_qty, legacyVideoQty: rec.video_qty, legacyMaterialQty: rec.material_qty
    });
  }

  /** 从任意 11 项输入容器收集值：空字符串 = null（空值），显式 0 = 0。 */
  function collectVals(selector) {
    var vals = {};
    document.querySelectorAll(selector).forEach(function (el) {
      var t = el.value.trim();
      vals[el.dataset.key] = t === '' ? null : Math.max(0, FW.num(t));
    });
    return vals;
  }

  function dyUnitPrice(date) {
    return (typeof configAt === 'function') ? FW.num(configAt(date).price) : 4;
  }

  /** 今日录入页「所见即所得」的日工资总额：直接消费 DOM 输入，用户敲数字即变，
   *  不等保存、不依赖 records 镜像。历史日期仍返回锁定的旧链路原值。 */
  function entryDaily(date) {
    if (!FW.isActive(date, STATE.from)) {
      return dailyOf(date) || FW.daily({
        date: date, counts: {}, xhs: 0, refund: 0, dy: 0, extra: 0,
        effectiveFrom: STATE.from, entries: mergedBook(),
        dyOrderUnitPrice: dyUnitPrice(date), legacyTotal: 0
      });
    }
    var vals = collectVals('#fw-entry-rows .fw-input');
    var counts = {};
    FW.ITEMS.forEach(function (it) { counts[it.fieldKey] = FW.num(vals[it.fieldKey]); });
    return FW.daily({
      date: date, counts: counts,
      xhs: FW.num(vals.xhs_order), refund: FW.num(vals.xhs_refund),
      dy: FW.num(vals.dy_order), extra: FW.num(vals.extra_income),
      effectiveFrom: STATE.from, entries: mergedBook(),
      dyOrderUnitPrice: dyUnitPrice(date), legacyTotal: 0
    });
  }

  /* ---------- 金额链路接管（包装既有函数，旧函数体不改） ---------- */
  function installMoneyHooks() {
    // 单条金额：历史日返回【锁定的旧链路原值】，新规则日返回最终公式结果。
    // 两端都来自同一个 daily()，与 11 项主表 / 月度统计逐位一致。
    if (typeof window.recordTotal === 'function') {
      var oldRecordTotal = window.recordTotal;
      window.recordTotal = function (r) {
        var d = dailyOf(r.date);
        return d ? d.total : oldRecordTotal(r);
      };
    }
    // 工资报表：纯历史区间 → 原函数逐字返回（含底薪，历史零变化）；
    // 含新规则日 → 旧底薪结构保留，收入项改按最终规则逐日汇总。
    // U4 第六阶段 P0-2：本包装是 PWA 工资页的【活跃入口】，必须与 app.js computeSalary
    // 遵守同两条规则 —— 计件不参与底薪档位判定、计件完整且只计入一次最终工资。
    if (typeof window.computeSalary === 'function') {
      var oldComputeSalary = window.computeSalary;
      window.computeSalary = function (recs) {
        var hasNew = recs.some(function (r) { return FW.isActive(r.date, STATE.from); });
        var sumAssist = recs.reduce(function (a, r) {
          return a + ((typeof isAssistVisible === 'function' && isAssistVisible(r.date)) ? FW.num(r.assist) : 0);
        }, 0);
        var dailies = recs.map(function (r) { return dailyOf(r.date); });
        var m = FW.monthly((recs[0] && recs[0].date || '').slice(0, 7), dailies.filter(Boolean));
        if (!hasNew) {
          var legacy = oldComputeSalary(recs);
          legacy.fw = m;
          return legacy;
        }
        var s = {
          sumXHS: 0, sumDY: 0, sumRef: 0, sumNote: 0, sumMat: 0, sumVid: 0,
          sumAssist: sumAssist,
          xhsAmt: 0, dyAmt: 0, refundCut: 0,
          liveIncome: 0, noteIncome: 0, matIncome: 0, vidIncome: 0,
          pieceworkIncome: 0, accIncome: 0, base: 0, total: 0,
          threshold: oldComputeSalary(recs).threshold,
          fw: m
        };
        recs.forEach(function (r) {
          s.sumXHS += FW.num(r.xhs); s.sumDY += FW.num(r.dy); s.sumRef += FW.num(r.refund);
          s.sumNote += FW.num(r.note_qty); s.sumMat += FW.num(r.material_qty); s.sumVid += FW.num(r.video_qty);
          var d = dailyOf(r.date);
          if (!d) return;
          if (d.isLegacy) {
            // 历史日的收入分项沿用旧报表口径（逐条调用原函数，逐位一致）
            var one = oldComputeSalary([r]);
            s.xhsAmt += one.xhsAmt; s.dyAmt += one.dyAmt; s.refundCut += one.refundCut;
            s.noteIncome += one.noteIncome; s.matIncome += one.matIncome; s.vidIncome += one.vidIncome;
            s.pieceworkIncome += one.pieceworkIncome;   // 计件只在此累加一次
            s.liveIncome += one.liveIncome;
            // 规则一：accIncome = 账号笔记视频收入（图片 + 素材 + 视频），不含计件
            s.accIncome += one.noteIncome + one.matIncome + one.vidIncome;
          } else {
            s.xhsAmt += d.xhsNetAmount; s.dyAmt += d.dyOrderAmount;
            s.pieceworkIncome += d.contentTotal;        // 六项内容计件归计件，只累加一次
            s.liveIncome += d.xhsNetAmount + d.dyOrderAmount;
            // 规则一：contentTotal 属账号计件，不进 accIncome，也不参与档位判定
          }
        });
        // 规则一：底薪档位 = 直播出单收入 + 账号笔记视频收入（不含计件），
        // 与 app.js computeSalary 的 (liveIncome + accIncome) > threshold 完全一致。
        var mc = FW.legacyConfigAt(m.month + '-31',
          (typeof PRICE_VERSIONS !== 'undefined') ? PRICE_VERSIONS : [], STATE.baseline);
        s.base = (s.liveIncome + s.accIncome) > s.threshold ? mc.salaryHigh : mc.salaryLow;
        // 规则一后半：计件完整计入最终应发工资，作为独立加项且此处是唯一一次。
        s.total = s.liveIncome + s.accIncome + s.base + s.pieceworkIncome;
        return s;
      };
    }
  }

  /* ---------- 今日录入 11 项 ---------- */
  function renderEntry() {
    var box = $('fw-entry-rows'); if (!box) return;
    var date = ($('t-date') && $('t-date').value) || todayStrSafe();
    var f = readFields(date);
    var active = FW.isActive(date, STATE.from);
    var html = '';
    FW.FIELDS.forEach(function (field) {
      if (field.computed) return;
      var item = FW.ITEMS.filter(function (x) { return x.no === field.no; })[0];
      var price = item ? priceAt(item.priceKey, date) : null;
      var val = f[field.key];
      var unset = item && val === null ? false : (item && FW.num(val) > 0 && price === null);
      var priceText = item
        ? (price === null ? '<span class="fw-unset">未设置</span>' : '¥' + price + '/条')
        : (field.key === 'xhs_order' || field.key === 'xhs_refund'
            ? '¥' + (priceAt(FW.XHS_ORDER_PRICE_KEY, date) == null ? 0 : priceAt(FW.XHS_ORDER_PRICE_KEY, date)) + '/单'
            : (field.key === 'dy_order' ? '沿用系统单价' : '—'));
      var shown = val === null ? '' : String(val);
      var disabled = (!active && item) ? ' disabled' : '';
      var title = (!active && item) ? ' title="历史日期：原始数据不按账号拆分"' : '';
      html += '<div class="fw-entry-row" data-field="' + field.key + '"' + title + '>' +
        '<span class="fw-no">' + field.no + '</span>' +
        '<span class="fw-name">' + esc(field.title) + '</span>' +
        '<input class="fw-input' + (unset ? ' fw-unset-input' : '') + '" type="number" inputmode="numeric" min="0" ' +
          'placeholder="—" value="' + esc(shown) + '" data-key="' + field.key + '"' + disabled + ' />' +
        '<span class="fw-price">' + priceText + '</span>' +
        '</div>';
    });
    box.innerHTML = html;
    box.querySelectorAll('.fw-input').forEach(function (el) {
      el.addEventListener('input', function () {
        if (typeof todayDirty !== 'undefined') { try { todayDirty = true; } catch (_) {} }
        syncCompat(date);
        renderEntryTotal(date);
      });
    });
    var hint = $('fw-entry-hint');
    if (hint) {
      hint.innerHTML = active
        ? '规则生效日 F = ' + STATE.from + ' 起生效：六项内容计件 + 小红书净出单 + 抖音出单 + 额外收入。抖音不记录退款。'
        : '历史日期（&lt; F）：按原始旧账展示，六项账号数量不拆分、金额锁定为原值。';
      delete hint.dataset.blocked;
    }
    renderEntryTotal(date);
  }

  function renderEntryTotal(date) {
    var d = entryDaily(date);
    var el = $('fw-daily-total'); if (el) el.textContent = '¥' + d.total;
    var h = $('s-net-money'); if (h) h.textContent = '¥' + d.total;
    var hint = $('fw-entry-hint');
    if (hint && !hint.dataset.blocked && d.hasUnsetPrice) {
      hint.innerHTML = '<span class="fw-unset">⚠ 未设置单价：' + esc(d.blockedKeys.join('、')) + '（数量 > 0 时不允许保存）</span>';
    }
  }

  /** 把 11 项输入同步写回隐藏兼容层，既有 saveRecord 链路零改动。 */
  function syncCompat(date) {
    var vals = {};
    document.querySelectorAll('#fw-entry-rows .fw-input').forEach(function (el) {
      var t = el.value.trim();
      vals[el.dataset.key] = t === '' ? 0 : Math.max(0, FW.num(t));
    });
    var map = {
      xhs_order: 't-xhs', xhs_refund: 't-refund', dy_order: 't-dy',
      extra_income: 't-assist', sam_material: 't-material'
    };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]); if (el && vals[k] !== undefined) el.value = vals[k];
    });
    // 旧 note_qty / video_qty 保持原值（历史账不拆分、不伪造）
    ['t-note', 't-video'].forEach(function (id) { if ($(id) && $(id).value === '') $(id).value = 0; });
  }

  function todayStrSafe() {
    if (typeof todayStr === 'function') return todayStr();
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------- 编辑弹层 11 项 ---------- */
  function renderEditSheet(date) {
    var box = $('fw-edit-rows'); if (!box) return;
    STATE.editDate = date;
    var f = readFields(date);
    var active = FW.isActive(date, STATE.from);
    $('e-date').value = date;
    var html = '';
    FW.FIELDS.forEach(function (field) {
      if (field.computed) return;
      var item = FW.ITEMS.filter(function (x) { return x.no === field.no; })[0];
      var price = item ? priceAt(item.priceKey, date) : null;
      var val = f[field.key];
      html += '<div class="fw-edit-row"><label>' + field.no + '. ' + esc(field.title) + '</label>' +
        '<input id="fw-e-' + field.key + '" data-key="' + field.key + '" type="number" min="0" placeholder="—" ' +
        'value="' + esc(val === null ? '' : val) + '"' + ((!active && item) ? ' disabled' : '') + ' />' +
        '<span class="fw-edit-price">' + (item ? (price === null ? '<em class="fw-unset">未设置</em>' : '¥' + price) : '') + '</span></div>';
    });
    var d = dailyOf(date);
    html += '<div class="fw-edit-total"><span>11. 日工资总额（元）</span><b>¥' + (d ? d.total : 0) + '</b></div>';
    box.innerHTML = html;
    // 同步隐藏兼容层
    var map = { xhs_order: 'e-xhs', xhs_refund: 'e-refund', dy_order: 'e-dy', extra_income: 'e-assist', sam_material: 'e-material' };
    box.querySelectorAll('input[data-key]').forEach(function (el) {
      var target = $(map[el.dataset.key]);
      if (target) target.value = el.value === '' ? 0 : el.value;
      el.addEventListener('input', function () {
        if (target) target.value = el.value === '' ? 0 : el.value;
      });
    });
  }

  /* ---------- 历史记录：每日完整卡片 ----------
   * 11 项默认全部可见、不折叠：顶部左侧日期 + 右侧突出日工资总额（第 11 项），
   * 下方两列网格完整显示前 10 项（全名称 + 明确数值，零值照显）。
   * 数据来源与金额口径完全复用既有 readFields / dailyOf / priceAt，
   * 不新增字段、不改工资规则；F 之前历史日依旧「原始未拆分 + 金额锁定」。 */
  var CARD_LABELS = {
    sam_video: 'SAM 视频数',
    sam_note: 'SAM 笔记数',
    sam_material: 'SAM 素材数',
    bee_video: 'BeeBag 视频数',
    bee_note: 'BeeBag 笔记数',
    dy_publish: '抖音发布数',
    xhs_order: '小红书出单数',
    xhs_refund: '小红书退款数',
    dy_order: '抖音出单数',
    extra_income: '额外收入（元）'
  };

  function weekdayOf(dateStr) {
    try {
      var p = String(dateStr).split('-');
      var d = new Date(Date.UTC(+p[0], (+p[1]) - 1, +p[2]));
      return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
    } catch (_) { return ''; }
  }

  function renderHistoryTable() {
    var box = $('fw-history-table'); if (!box) return;
    var rs = (typeof records !== 'undefined' && records ? records : [])
      .filter(function (r) { return !r.deleted_at; })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
    var banner = $('fw-history-banner');
    if (banner) {
      banner.innerHTML = '<b>历史记录 · 每日完整卡片</b> ｜ 11 项默认全部显示' +
        ' ｜ 规则生效日 F = ' + STATE.from + '，F 之前按原始旧账展示（金额锁定）' +
        (STATE.accountPricesMissing
          ? '<br /><span class="fw-unset">⚠ 账户价格历史未加载（云端读取失败或为空）：BeeBag 视频/笔记、抖音发布等单价可能回落默认价，工资仅供参考，不代表最终口径</span>'
          : '');
    }
    if (!rs.length) { box.innerHTML = '<div class="empty">暂无记录</div>'; return; }
    var gridFields = FW.FIELDS.filter(function (f) { return !f.computed; }); // 前 10 项；第 11 项在卡头
    var body = rs.map(function (r) {
      var f = readFields(r.date), d = dailyOf(r.date);
      var legacy = !!(d && d.isLegacy);
      var cells = gridFields.map(function (field) {
        var item = FW.ITEMS.filter(function (x) { return x.no === field.no; })[0];
        var v, cls = 'hw-cell';
        if (legacy && item) {
          v = '原始未拆分'; cls += ' hw-na';
        } else {
          v = f[field.key];
          var price = item ? priceAt(item.priceKey, r.date) : null;
          if (item && FW.num(v) > 0 && price === null) cls += ' hw-unset';
          if (v === null || v === undefined) v = 0;   // 零值正常显示，不隐藏项目
          v = String(v);
          if (field.money) cls += ' hw-money';
        }
        return '<div class="' + cls + '" title="' + esc(field.title || CARD_LABELS[field.key]) + '">' +
          '<span class="hw-label">' + esc(CARD_LABELS[field.key] || field.short) + '</span>' +
          '<span class="hw-val">' + esc(v) + '</span></div>';
      }).join('');
      var total = d ? d.total : 0;
      return '<article class="hw-card' + (legacy ? ' hw-legacy' : '') + '" data-date="' + r.date + '">' +
        '<header class="hw-head">' +
          '<div class="hw-date">' + esc(r.date) +
            '<span class="hw-weekday">' + esc(weekdayOf(r.date)) + '</span></div>' +
          '<div class="hw-total-wrap">' +
            '<span class="hw-total-label">日工资总额（元）</span>' +
            '<span class="hw-total">¥' + total + '</span></div>' +
        '</header>' +
        '<div class="hw-grid">' + cells + '</div>' +
      '</article>';
    }).join('');
    box.innerHTML = body;
    box.querySelectorAll('.hw-card').forEach(function (el) {
      el.addEventListener('click', function () { openFWEdit(el.dataset.date); });
    });
    renderMonthlyTable(rs);
  }

  /* ---------- 月度统计（按账号 + 类型） ---------- */
  function renderMonthlyTable(rs) {
    var box = $('fw-monthly-table'); if (!box) return;
    var groups = {};
    rs.forEach(function (r) {
      var ym = r.date.slice(0, 7);
      (groups[ym] = groups[ym] || []).push(r);
    });
    var html = '';
    Object.keys(groups).sort().reverse().forEach(function (ym) {
      var dailies = groups[ym].map(function (r) { return dailyOf(r.date); }).filter(Boolean);
      var m = FW.monthly(ym, dailies);
      // 金额一律由每一天的 daily() 用「该业务日生效价」算出后累加；
      // 表头单价列只展示 F 当日的参考价，避免把跨生效日调价误显示成单一固定价。
      var refDate = STATE.from;
      html += '<div class="pw-table-head"><span>账号 / 计件类型</span><span>单价@F</span><span>数量</span><span>金额</span></div>';
      m.orderedLines.forEach(function (l) {
        var p = priceAt(l.item.priceKey, refDate);
        html += '<div class="pw-table-row"><span>' + l.item.no + '. ' + esc(
          FW.FIELDS.filter(function (f) { return f.no === l.item.no; })[0].title) +
          '</span><span>' + (p === null ? '未设置' : '¥' + p) + '</span><span>' + l.count + '</span><span>¥' + l.amount + '</span></div>';
      });
      html += '<div class="pw-table-foot"><span>六项内容计件合计</span><span>—</span><span>—</span><span>¥' + m.contentTotal + '</span></div>' +
        '<div class="pw-table-foot"><span>小红书净出单 / 抖音出单 / 额外收入</span><span>—</span><span>—</span><span>¥' +
        m.xhsNetAmount + ' / ¥' + m.dyOrderAmount + ' / ¥' + m.extraIncome + '</span></div>' +
        '<div class="pw-table-foot fw-strong"><span>' + ym + ' 日工资总额逐日累加（含历史日原值 ¥' + m.legacyTotalSum + '，' + m.legacyDays + ' 天）</span>' +
        '<span>—</span><span>—</span><span>¥' + m.dailyTotalSum + '</span></div>' +
        '<div class="fw-month-sep" data-ym="' + ym + '"></div>';
    });
    box.innerHTML = html || '<div class="empty">暂无数据</div>';
  }

  /* ---------- 六项价格设置 ---------- */
  function renderPriceSettings() {
    var box = $('fw-price-rows'); if (!box) return;
    var eff = $('fw-effective-from');
    if (eff) { eff.value = STATE.from; eff.setAttribute('value', STATE.from); }
    var date = STATE.from;
    box.innerHTML = FW.ITEMS.map(function (it) {
      var p = priceAt(it.priceKey, date);
      return '<div class="fw-price-row" data-key="' + it.priceKey + '">' +
        '<span class="fw-no">' + it.no + '</span>' +
        '<span class="fw-price-name">' + esc(FW.FIELDS[it.no - 1].title) + '</span>' +
        '<span class="fw-price-key">' + esc(it.priceKey) + '</span>' +
        '<input type="number" min="0" placeholder="未设置" value="' + (p === null ? '' : p) + '" />' +
        '<span class="fw-price-now">' + (p === null ? '<em class="fw-unset">未设置</em>' : '现价 ¥' + p + ' · 默认 ' + it.defaultPrice) + '</span>' +
        '</div>';
    }).join('');
    var x = $('fw-xhs-price');
    if (x) { var xp = priceAt(FW.XHS_ORDER_PRICE_KEY, date); x.textContent = xp === null ? '未设置' : xp; }
  }

  function savePriceSettings() {
    // U4：只读查看端 —— 六价保存禁用（保留全部 render）。
    roBlock('savePriceSettings');
    return;
    var eff = $('fw-effective-from');
    var from = (eff && eff.value) || STATE.from;
    STATE.from = from; writeLocal(KEY_FROM, from);
    var rows = document.querySelectorAll('#fw-price-rows .fw-price-row');
    var book = STATE.book.slice();
    rows.forEach(function (row) {
      var input = row.querySelector('input');
      var key = row.dataset.key;
      var t = input.value.trim();
      if (t === '') {
        // 未设置：不写 0，同生效日写墓碑覆盖活动价（旧生效日历史版本保留）
        book = FW.unsetPrice(key, from, book);
      } else {
        book = FW.setPrice(key, Math.max(0, FW.num(t)), from, book);
      }
    });
    STATE.book = book; writeLocal(KEY_BOOK, book);
    var hint = $('fw-price-hint');
    if (hint) hint.textContent = '已保存六项价格（生效日 ' + from + '），历史版本保留；F 之前历史金额不变。';
    renderEntry(); renderHistoryTable(); renderPriceSettings();
  }

  /* ---------- 保存 11 项（写既有数据通道） ---------- */
  /** 同步预检：数量 > 0 但单价未设置 → 阻止保存。供 document capture 监听器调用。 */
  function checkBlocked(vals, date) {
    return FW.blockedKeys(vals, date, mergedBook());
  }

  /** 今日页与编辑弹层共用：把 5 项账号计件写入既有 accountPiecework 通道。 */
  async function saveFWValues(date, vals) {
    // U4：只读查看端 —— 禁止云端写与 outbox 入队，保留全部 render。
    roBlock('saveFWValues');
    return { blocked: false, skippedReadOnly: true, rows: [] };
    if (!FW.isActive(date, STATE.from)) return { blocked: false, skippedLegacy: true };
    // 未设置单价且有数量 → 阻止（与 Mac / piecework_sync.js 同口径）
    var blocked = checkBlocked(vals, date);
    if (blocked.length) return { blocked: true, blockedKeys: blocked };
    var uid = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : null;
    if (!uid) return { blocked: true, blockedKeys: [], reason: '未登录' };
    var now = (typeof nowISO === 'function') ? nowISO() : new Date().toISOString();
    var rows = [];
    var accounts = {};
    FW.ITEMS.forEach(function (it) {
      if (it.content === 'material') return;   // 素材走 material_qty
      (accounts[it.account] = accounts[it.account] || []).push(it);
    });
    for (const code of Object.keys(accounts)) {
      var existing = (typeof accountPiecework !== 'undefined' && accountPiecework)
        ? accountPiecework.find(function (r) { return !r.deleted_at && r.business_date === date && r.account_code === code; })
        : null;
      var row = {
        id: existing ? existing.id : ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('pw-' + Date.now() + '-' + Math.random().toString(16).slice(2))),
        user_id: uid, business_date: date, account_code: code,
        note_count: 0, video_count: 0, publish_count: 0,
        note_unit_price_snapshot: 0, video_unit_price_snapshot: 0, publish_unit_price_snapshot: 0,
        created_at: existing ? existing.created_at : now, updated_at: now
      };
      accounts[code].forEach(function (it) {
        var p = priceAt(it.priceKey, date);
        var col = { note: 'note_count', video: 'video_count', publish: 'publish_count' }[it.content];
        var pcol = { note: 'note_unit_price_snapshot', video: 'video_unit_price_snapshot', publish: 'publish_unit_price_snapshot' }[it.content];
        row[col] = FW.num(vals[it.fieldKey]);
        row[pcol] = p === null ? 0 : p;
      });
      rows.push(row);
    }
    // 1) 本地镜像（离线不丢）
    for (const r of rows) {
      try { if (typeof LocalDB !== 'undefined') await LocalDB.putPiecework(Object.assign({}, r, { deleted_at: null })); } catch (_) {}
    }
    // 2) 内存立即反映
    var merged = new Map();
    ((typeof accountPiecework !== 'undefined' && accountPiecework) || []).forEach(function (r) {
      merged.set(r.business_date + '|' + r.account_code, r);
    });
    rows.forEach(function (r) { merged.set(r.business_date + '|' + r.account_code, r); });
    try { accountPiecework = Array.from(merged.values()); } catch (_) {}
    // 3) 云端（失败入既有独立 outbox）
    var err = null;
    try { if (typeof pushPiecework === 'function') err = await pushPiecework(rows); } catch (e) { err = e; }
    if (err) {
      for (const r of rows) {
        try {
          if (typeof LocalDB !== 'undefined') await LocalDB.putPieceworkPending({
            kind: 'piecework', date: r.business_date, account: r.account_code,
            action: 'save', payload: r, createdAt: now
          });
        } catch (_) {}
      }
    }
    return { blocked: false, rows: rows, offline: !!err };
  }

  async function saveFWDay(date) {
    return saveFWValues(date, collectVals('#fw-entry-rows .fw-input'));
  }

  /* ---------- 打开编辑（包装既有 openEdit） ---------- */
  function openFWEdit(date) {
    if (typeof window.openEdit === 'function') window.openEdit(date);
    renderEditSheet(date);
  }

  /* ---------- Mock 数据模式（真实页面截图验收用，不碰生产数据） ---------- */
  function installMock() {
    var mockRecords = [
      { date: '2026-11-06', xhs: 12, refund: 2, dy: 5, assist: 60,
        note_qty: 0, video_qty: 0, material_qty: 4, deleted_at: null },
      { date: '2026-11-05', xhs: 10, refund: 2, dy: 3, assist: 160,
        note_qty: 0, video_qty: 0, material_qty: 4, deleted_at: null },
      { date: '2026-11-03', xhs: 51, refund: 6, dy: 8, assist: 0,
        note_qty: 3, video_qty: 4, material_qty: 3, deleted_at: null },
      { date: '2026-10-30', xhs: 45, refund: 6, dy: 9, assist: 0,
        note_qty: 0, video_qty: 7, material_qty: 5, deleted_at: null }
    ];
    var mockPW = [
      { business_date: '2026-11-06', account_code: 'xiaohongshu_sam', note_count: 3, video_count: 2, publish_count: 0,
        note_unit_price_snapshot: 5, video_unit_price_snapshot: 31, publish_unit_price_snapshot: 0, deleted_at: null },
      { business_date: '2026-11-06', account_code: 'xiaohongshu_beebag', note_count: 5, video_count: 1, publish_count: 0,
        note_unit_price_snapshot: 4, video_unit_price_snapshot: 30, publish_unit_price_snapshot: 0, deleted_at: null },
      { business_date: '2026-11-06', account_code: 'douyin_sam', note_count: 0, video_count: 0, publish_count: 7,
        note_unit_price_snapshot: 0, video_unit_price_snapshot: 0, publish_unit_price_snapshot: 4, deleted_at: null },
      { business_date: '2026-11-05', account_code: 'xiaohongshu_sam', note_count: 3, video_count: 2, publish_count: 0,
        note_unit_price_snapshot: 5, video_unit_price_snapshot: 31, publish_unit_price_snapshot: 0, deleted_at: null },
      { business_date: '2026-11-05', account_code: 'xiaohongshu_beebag', note_count: 5, video_count: 1, publish_count: 0,
        note_unit_price_snapshot: 4, video_unit_price_snapshot: 30, publish_unit_price_snapshot: 0, deleted_at: null },
      { business_date: '2026-11-05', account_code: 'douyin_sam', note_count: 0, video_count: 0, publish_count: 7,
        note_unit_price_snapshot: 0, video_unit_price_snapshot: 0, publish_unit_price_snapshot: 4, deleted_at: null }
    ];
    try { records = mockRecords; } catch (_) {}
    try { accountPiecework = mockPW; } catch (_) {}
    try {
      currentUser = { id: '00000000-0000-0000-0000-000000000001' };
    } catch (_) {}
    // 历史取价版本：与真实账本当前配置一致（note=5 / material=5 / video=31 / price=4）
    try {
      PRICE_VERSIONS = [{ from: '2026-10-04', price: 4, notePrice: 5, materialPrice: 5,
        videoPrice: 31, salaryThreshold: 20000, salaryHigh: 2000, salaryLow: 3000 }];
    } catch (_) {}
    // 屏蔽真实网络与登录（app.js 的 DOMContentLoaded 会同步调用 tryRestoreSession，
    // 因此截图 harness 还会在 app.js 之前注入 __mock_guard.js 桩掉 supabase client；
    // 这里是第二道保险，保证任何时机都不会走真实业务请求）。
    try { window.tryRestoreSession = async function () {}; } catch (_) {}
    try { window.onLoggedIn = async function () {}; } catch (_) {}
    try { window.loadRecords = async function () {}; } catch (_) {}
    try { window.loadAccountPiecework = async function () {}; } catch (_) {}
    try { window.loadAccountPrices = async function () {}; } catch (_) {}
    try { window.loadPriceVersions = async function () {}; } catch (_) {}
    try { window.refreshPriceConfig = async function () { return false; }; } catch (_) {}
    try { window.refreshPriceVersions = async function () { return false; }; } catch (_) {}
    try { window.autoPull = function () {}; } catch (_) {}
    try { window.flushPending = function () {}; } catch (_) {}
    try { window.flushPieceworkPending = function () {}; } catch (_) {}
    try {
      window.showLogin = function () {   // 防止 getSession 返回 null 后异步把 app 重新藏起来
        var l = $('login-view'); if (l) l.classList.add('hidden');
        var a = $('app'); if (a) a.classList.remove('hidden');
      };
    } catch (_) {}
    var login = $('login-view'); if (login) login.classList.add('hidden');
    var app = $('app'); if (app) app.classList.remove('hidden');
    var d = $('t-date'); if (d) d.value = '2026-11-06';
    STATE.mock = true;
  }

  /* ---------- 事件包装 ---------- */
  /* U4：只读查看端统一写拦截（记录可追踪日志但不抛，避免破坏 UI）。 */
  function roBlock(op) {
    try {
      if (window.LedgerReadOnly && window.LedgerReadOnly.assertWrite) {
        window.LedgerReadOnly.assertWrite(op);
      }
    } catch (_) {}
  }

  function showBlockedHint(text, id) {
    var hint = $(id);
    if (hint) { hint.innerHTML = '<span class="fw-unset">⚠ ' + text + '</span>'; hint.dataset.blocked = '1'; }
  }

  /* ---------- 独立运行时诊断（仅 ?diag=1 由 app.js 读取；严禁输出密钥） ----------
   * 目的：证明「价格簿合并修复版 UI」实际加载并真正执行。
   * 全部取自与历史卡片同源的 mergedBook()/priceAt()/dailyOf()，不另造计算路径。
   * 只返回数量、单价、金额等标量，不含任何 URL / key / 账号信息。 */
  function diagSnapshot() {
    var derived = derivedAccountEntries();
    var merged = mergedBook();
    var baseCount = (STATE.book && STATE.book.length) || 0;
    var mergedCount = (merged && merged.length) || 0;
    var acctCount = 0;
    try { if (typeof accountPrices !== 'undefined' && accountPrices) acctCount = accountPrices.length; } catch (_) {}

    // 三项单价：与历史卡片 2026-11-23 同口径，取合并簿当日生效价
    var probeDate = '2026-11-23';
    var pick = function (key) {
      var p = null;
      try { p = FW.priceAt(key, probeDate, merged); } catch (_) {}
      return (p === null || p === undefined) ? null : p;
    };
    var prices = {
      beeVideo: pick('xiaohongshu_beebag|video'),
      beeNote: pick('xiaohongshu_beebag|note'),
      dyPublish: pick('douyin_sam|publish')
    };

    // 三天工资：与 renderHistoryTable 卡头 ¥total 完全同源（dailyOf(date).total）
    var wages = {};
    ['2026-11-21', '2026-11-22', '2026-11-23'].forEach(function (d) {
      var t = null;
      try { var r = dailyOf(d); if (r) t = r.total; } catch (_) {}
      wages[d] = t;
    });

    return {
      buildId: FINAL_WAGE_UI_BUILD_ID,
      accountPricesCount: acctCount,
      derivedEntriesCount: derived.length,
      baseBookCount: baseCount,
      mergedBookCount: mergedCount,
      prices: prices,
      wages: wages,
      accountPricesMissing: !!STATE.accountPricesMissing,
      probedDate: probeDate
    };
  }

  function installHooks() {
    // 价格簿合并联动（授权要求 7/8）：包装既有 loadAccountPrices —— app.js 登录流程
    // （onLoggedIn → await loadAccountPrices）必然晚于本文件 boot 安装包装，
    // 因此每次账户价格历史拉取完成（成功或失败）都会刷新全部工资视图；
    // 失败/为空时经 refreshAccountPricesHealth 置警告标记，绝不静默当正确。
    try {
      if (typeof window.loadAccountPrices === 'function' && !window.__fw_ap_wrap__) {
        var origLoadAccountPrices = window.loadAccountPrices;
        window.__fw_ap_wrap__ = true;
        window.loadAccountPrices = function () {
          var r = origLoadAccountPrices.apply(this, arguments);
          try {
            Promise.resolve(r).then(function () { applyAccountPricesRefresh(); })
              .catch(function () { applyAccountPricesRefresh(); });
          } catch (_) { applyAccountPricesRefresh(); }
          return r;
        };
      }
    } catch (_) {}

    // 关键：app.js 在 DOMContentLoaded 里先于本文件注册 #t-save / #e-save 的 target 监听器。
    // 同一元素上 capture 标志不决定执行顺序（AT_TARGET 按注册顺序），所以必须在
    // document 的捕获阶段拦截，才能真正做到「单价未设置时阻止整个保存，避免半套数据」。
    // U4：点击捕获写钩子改为只读 no-op —— 拦截保存点击、记录日志，不执行任何保存/入队。
    document.addEventListener('click', function (e) {
      var el = (e.target && e.target.closest) ? e.target.closest('#t-save,#e-save') : null;
      if (!el) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      roBlock('click:' + el.id);
      showBlockedHint('只读查看端：已禁用保存', el.id === 't-save' ? 'fw-entry-hint' : 'e-status');
    }, true);
    var pwSave = $('fw-price-save');
    if (pwSave) pwSave.addEventListener('click', function () { roBlock('click:fw-price-save'); });
    var eff = $('fw-effective-from');
    if (eff) eff.addEventListener('change', function () {
      STATE.from = eff.value || STATE.from;   // U4：只读，不写本地配置
      renderEntry(); renderHistoryTable();
    });
    var d = $('t-date');
    if (d) d.addEventListener('change', function () { renderEntry(); });
    // 暴露给测试 / 截图脚本
    window.FinalWageUI = {
      BUILD_ID: FINAL_WAGE_UI_BUILD_ID, diagSnapshot: diagSnapshot,
      STATE: STATE, loadState: loadState, ensureBaseline: ensureBaseline,
      priceAt: priceAt,       readFields: readFields, dailyOf: dailyOf, entryDaily: entryDaily,
      collectVals: collectVals, checkBlocked: checkBlocked,
      mergedBook: mergedBook, derivedAccountEntries: derivedAccountEntries,
      applyAccountPricesRefresh: applyAccountPricesRefresh,
      refreshAccountPricesHealth: refreshAccountPricesHealth,
      renderEntry: renderEntry, renderEntryTotal: renderEntryTotal,
      renderHistoryTable: renderHistoryTable,
      renderMonthlyTable: renderMonthlyTable, renderPriceSettings: renderPriceSettings,
      renderEditSheet: renderEditSheet, savePriceSettings: savePriceSettings,
      saveFWDay: saveFWDay, saveFWValues: saveFWValues,
      syncCompat: syncCompat, installMock: installMock,
      FW: FW
    };
  }

  function boot() {
    // 版本探针：脚本一执行即挂载，与是否登录无关。
    // app.js 诊断面板据此判断「本次价格簿合并修复版 UI 是否真正加载」。
    try { window.__FW_DIAG__ = { BUILD_ID: FINAL_WAGE_UI_BUILD_ID, diagSnapshot: diagSnapshot }; } catch (_) {}
    var params = (typeof location !== 'undefined' && location.search) || '';
    STATE.mock = /fwdemo=1/.test(params);
    loadState();
    if (STATE.mock) installMock();
    ensureBaseline();
    installMoneyHooks();
    installHooks();
    renderPriceSettings();
    renderEntry();
    renderHistoryTable();
    // 切到历史 / 工资页时刷新 11 项视图
    if (typeof window.switchTab === 'function') {
      var old = window.switchTab;
      window.switchTab = function (tab) {
        old(tab);
        if (tab === 'history' || tab === 'salary') renderHistoryTable();
        if (tab === 'today') renderEntry();
        if (tab === 'settings') renderPriceSettings();
      };
    }
    // 截图 harness：?fwdemo=1&fwtab=history|settings|today 直接渲染对应真实页面。
    // 仅 Mock 模式生效，生产 URL 不受影响。
    var tab = (params.match(/[?&]fwtab=([a-z]+)/) || [])[1];
    if (STATE.mock) {
      document.documentElement.setAttribute('data-fw-mock', '1');
      var report = function () {
        document.documentElement.setAttribute('data-fw-external-requests',
          String((window.__NET_ATTEMPTS__ || []).length));
      };
      report(); setTimeout(report, 400); setTimeout(report, 1200);
      if (tab && typeof window.switchTab === 'function') {
        try { window.switchTab(tab); } catch (_) {}
        renderEntry(); renderHistoryTable(); renderPriceSettings();
      }
    }
    // 兜底（授权要求 7）：若 loadAccountPrices 的调用发生在本文件包装安装之前
    // （极端时序竞态），1.5s 后检查一次账户价是否已到达并补一次刷新。
    // 渲染幂等且仅在派生条目非空时触发，生产正常路径下是无害空操作。
    setTimeout(function () {
      try {
        if (derivedAccountEntries().length) applyAccountPricesRefresh();
      } catch (_) {}
    }, 1500);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
    } else { setTimeout(boot, 0); }
  }
})();
