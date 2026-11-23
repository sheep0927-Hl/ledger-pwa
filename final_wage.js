/* =============================================================================
 * 最终工资规则（2026-11-04 确认口径）· Mac / PWA 同构唯一真源
 * 与 macos-app/Sources/FinalWageRule.swift 逐项对应，字段编号、价格键、公式完全一致。
 *
 * 11 项：1 SAM视频 2 SAM笔记 3 SAM素材 4 BeeBag视频 5 BeeBag笔记 6 抖音发布
 *        7 小红书出单 8 小红书退款 9 抖音出单 10 额外收入(元) 11 日工资总额(元)
 * 六项内容计件单价：31 / 5 / 5 / 30 / 4 / 4，均可独立调整、带生效日期与历史版本。
 *
 * 金额公式（仅 F 当日起）：
 *   六项 = Σ(数量 × 该项在业务日生效的单价)
 *   小红书净出单 = (小红书出单 − 小红书退款) × P(xhs_order)，默认 4
 *   抖音出单     = 抖音出单数 × 系统现有出单单价（configAt(date).price，规则不变）
 *   额外收入     = assist
 *   日工资总额   = 六项 + 小红书净出单 + 抖音出单 + 额外收入
 *
 * 历史保护：
 *   - 5 元素材价只在本模块独立价格簿，绝不写回 CONFIG.materialPrice / PRICE_VERSIONS。
 *   - date < F 的历史日一律返回 legacyTotal（旧链路原值），六项显示「原始未拆分」。
 *   - 历史取价改为「PRICE_VERSIONS 命中版本，否则启用瞬间固化的基线」，绝不回退当前 CONFIG，
 *     因此改任何当前单价都不会重新计算旧月份工资（详见 legacyConfigAt）。
 *   - 抖音不记录退款；不拆分、不伪造历史账号数量。
 * ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FinalWage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FIELDS = [
    { no: 1,  key: 'sam_video',    title: '小红书 SAM 视频数',   short: 'SAM 视频数' },
    { no: 2,  key: 'sam_note',     title: '小红书 SAM 笔记数',   short: 'SAM 笔记数' },
    { no: 3,  key: 'sam_material', title: '小红书 SAM 素材数',   short: 'SAM 素材数' },
    { no: 4,  key: 'bee_video',    title: '小红书 BeeBag 视频数', short: 'BeeBag 视频数' },
    { no: 5,  key: 'bee_note',     title: '小红书 BeeBag 笔记数', short: 'BeeBag 笔记数' },
    { no: 6,  key: 'dy_publish',   title: '抖音发布数',           short: '抖音发布数' },
    { no: 7,  key: 'xhs_order',    title: '小红书出单数',         short: '小红书出单数' },
    { no: 8,  key: 'xhs_refund',   title: '小红书退款数',         short: '小红书退款数' },
    { no: 9,  key: 'dy_order',     title: '抖音出单数',           short: '抖音出单数' },
    { no: 10, key: 'extra_income', title: '额外收入（元）',        short: '额外收入(元)', money: true },
    { no: 11, key: 'daily_total',  title: '日工资总额（元）',      short: '日工资总额(元)', money: true, computed: true }
  ];

  var ITEMS = [
    { no: 1, fieldKey: 'sam_video',    account: 'xiaohongshu_sam',    content: 'video',    priceKey: 'xiaohongshu_sam|video',    defaultPrice: 31 },
    { no: 2, fieldKey: 'sam_note',     account: 'xiaohongshu_sam',    content: 'note',     priceKey: 'xiaohongshu_sam|note',     defaultPrice: 5 },
    { no: 3, fieldKey: 'sam_material', account: 'xiaohongshu_sam',    content: 'material', priceKey: 'xiaohongshu_sam|material', defaultPrice: 5 },
    { no: 4, fieldKey: 'bee_video',    account: 'xiaohongshu_beebag', content: 'video',    priceKey: 'xiaohongshu_beebag|video', defaultPrice: 30 },
    { no: 5, fieldKey: 'bee_note',     account: 'xiaohongshu_beebag', content: 'note',     priceKey: 'xiaohongshu_beebag|note',  defaultPrice: 4 },
    { no: 6, fieldKey: 'dy_publish',   account: 'douyin_sam',         content: 'publish',  priceKey: 'douyin_sam|publish',       defaultPrice: 4 }
  ];

  var XHS_ORDER_PRICE_KEY = 'xhs_order';
  var DEFAULT_EFFECTIVE_FROM = '2026-11-05';
  var DEFAULT_PRICES = (function () {
    var m = {};
    ITEMS.forEach(function (it) { m[it.priceKey] = it.defaultPrice; });
    m[XHS_ORDER_PRICE_KEY] = 4;
    return m;
  })();
  var PRICE_KEYS = ITEMS.map(function (x) { return x.priceKey; }).concat([XHS_ORDER_PRICE_KEY]);

  /* 系统出厂默认（与 PriceConfigValues.compatDefaults 一致）——历史锁定的兜底价 */
  var COMPAT_DEFAULTS = {
    price: 4, notePrice: 4, materialPrice: 4, videoPrice: 30,
    salaryThreshold: 20000, salaryHigh: 2000, salaryLow: 3000
  };

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function isActive(date, from) { return !!from && String(date) >= String(from); }

  /* 价格簿：取 effective_from <= date 的最后一条；全都晚于 date → 最早一条；无条目 → null。
   * 【墓碑语义】软删条目必须参与「取最后一条」的竞争，否则「清空价格」会被直接
   * filter 掉、旧价仍命中，界面永远显示不出「未设置」。与 Swift FinalWagePriceBook.priceAt 同构。 */
  function priceAt(key, date, entries) {
    var valid = (entries || []).filter(function (e) { return e.key === key; });
    if (!valid.length) return null;
    var sorted = valid.slice().sort(function (a, b) {
      return a.effective_from < b.effective_from ? -1 : (a.effective_from > b.effective_from ? 1 : 0);
    });
    var active = sorted.filter(function (e) { return e.effective_from <= date; });
    var picked = active.length ? active[active.length - 1] : sorted[0];
    return picked.deleted_at ? null : picked.unit_price;
  }

  function seedBook(effectiveFrom, entries) {
    var out = (entries || []).slice();
    PRICE_KEYS.forEach(function (k) {
      // 已有条目（含用户主动清空的墓碑）一律不覆盖，尊重用户设置。
      var exists = out.some(function (e) { return e.key === k && e.effective_from === effectiveFrom; });
      if (!exists) out.push({ key: k, unit_price: DEFAULT_PRICES[k], effective_from: effectiveFrom });
    });
    return out;
  }

  function setPrice(key, unitPrice, effectiveFrom, entries) {
    // 同 key 同生效日的活动条目与墓碑都移除，避免「清空后再设置」留下同日矛盾条目。
    var out = (entries || []).filter(function (e) {
      return !(e.key === key && e.effective_from === effectiveFrom);
    });
    out.push({ key: key, unit_price: unitPrice, effective_from: effectiveFrom });
    return out;
  }

  /** 清空某项价格 = 「未设置」（不是 0 元）：同生效日写一条墓碑，旧生效日版本保留。 */
  function unsetPrice(key, effectiveFrom, entries) {
    var out = (entries || []).filter(function (e) {
      return !(e.key === key && e.effective_from === effectiveFrom);
    });
    out.push({ key: key, unit_price: 0, effective_from: effectiveFrom, deleted_at: new Date().toISOString() });
    return out;
  }

  function blockedKeys(counts, date, entries) {
    return ITEMS.filter(function (it) {
      return num(counts[it.fieldKey]) > 0 && priceAt(it.priceKey, date, entries) === null;
    }).map(function (it) { return it.priceKey; });
  }

  /**
   * 每日金额唯一入口。
   * @param opt {date, counts, xhs, refund, dy, extra, effectiveFrom, entries,
   *             dyOrderUnitPrice, legacyTotal, legacyNoteQty, legacyVideoQty, legacyMaterialQty}
   */
  function daily(opt) {
    var date = opt.date, counts = opt.counts || {};
    var active = isActive(date, opt.effectiveFrom);
    var xhsNet = num(opt.xhs) - num(opt.refund);
    var dyAmount = num(opt.dy) * num(opt.dyOrderUnitPrice);
    var legacyTotal = num(opt.legacyTotal);

    if (!active) {
      // 与 Swift FinalWageCalculator.daily 同构：历史日仍返回 6 条零值行，
      // 但金额完全不读价格簿、不按新六项重算；UI 依据 isLegacy 显示「原始未拆分」。
      var legacyLines = ITEMS.map(function (it) {
        return { item: it, count: 0, unitPrice: null, amount: 0, isBlocked: false };
      });
      return {
        date: date, isLegacy: true, lines: legacyLines, contentTotal: 0,
        xhsNetCount: xhsNet, xhsOrderUnitPrice: null, xhsNetAmount: 0,
        dyOrderCount: num(opt.dy), dyOrderUnitPrice: num(opt.dyOrderUnitPrice),
        dyOrderAmount: dyAmount, extraIncome: num(opt.extra),
        total: legacyTotal, legacyTotal: legacyTotal, blockedKeys: [],
        legacyRaw: {
          noteQty: num(opt.legacyNoteQty), videoQty: num(opt.legacyVideoQty),
          materialQty: num(opt.legacyMaterialQty), xhs: num(opt.xhs),
          refund: num(opt.refund), dy: num(opt.dy), assist: num(opt.extra)
        }
      };
    }

    var lines = ITEMS.map(function (it) {
      var n = Math.max(0, num(counts[it.fieldKey]));
      var p = priceAt(it.priceKey, date, opt.entries);
      return {
        item: it, count: n, unitPrice: p,
        amount: n * (p === null ? 0 : p),
        isBlocked: n > 0 && p === null
      };
    });
    var contentTotal = lines.reduce(function (a, l) { return a + l.amount; }, 0);
    var xp = priceAt(XHS_ORDER_PRICE_KEY, date, opt.entries);
    var xhsAmount = xhsNet * (xp === null ? 0 : xp);

    return {
      date: date, isLegacy: false, lines: lines, contentTotal: contentTotal,
      xhsNetCount: xhsNet, xhsOrderUnitPrice: xp, xhsNetAmount: xhsAmount,
      dyOrderCount: num(opt.dy), dyOrderUnitPrice: num(opt.dyOrderUnitPrice),
      dyOrderAmount: dyAmount, extraIncome: num(opt.extra),
      total: contentTotal + xhsAmount + dyAmount + num(opt.extra),
      legacyTotal: null,
      blockedKeys: blockedKeys(counts, date, opt.entries)
    };
  }

  function monthly(month, dailies) {
    var m = {
      month: month, itemCounts: {}, itemAmounts: {},
      contentTotal: 0, xhsNetAmount: 0, dyOrderAmount: 0, extraIncome: 0,
      dailyTotalSum: 0, legacyTotalSum: 0, legacyDays: 0, newRuleDays: 0
    };
    dailies.forEach(function (d) {
      m.dailyTotalSum += d.total;
      if (d.isLegacy) {
        m.legacyDays += 1;
        m.legacyTotalSum += d.legacyTotal === null ? d.total : d.legacyTotal;
        return;
      }
      m.newRuleDays += 1;
      d.lines.forEach(function (l) {
        var k = l.item.priceKey;
        m.itemCounts[k] = (m.itemCounts[k] || 0) + l.count;
        m.itemAmounts[k] = (m.itemAmounts[k] || 0) + l.amount;
      });
      m.contentTotal += d.contentTotal;
      m.xhsNetAmount += d.xhsNetAmount;
      m.dyOrderAmount += d.dyOrderAmount;
      m.extraIncome += d.extraIncome;
    });
    m.orderedLines = ITEMS.map(function (it) {
      return { item: it, count: m.itemCounts[it.priceKey] || 0, amount: m.itemAmounts[it.priceKey] || 0 };
    });
    return m;
  }

  /** 历史锁定取价：优先命中 PRICE_VERSIONS；否则回退【启用瞬间固化的基线】，
   *  基线缺失才用出厂默认。绝不回退当前 CONFIG —— 改价不会重算旧月份工资。 */
  function legacyConfigAt(date, versions, baseline) {
    var list = (versions || []).slice().sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    var picked = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].from <= date) picked = list[i]; else break;
    }
    if (!picked && list.length) picked = list[0];
    return picked || baseline || COMPAT_DEFAULTS;
  }

  /** 历史日金额（旧链路逐字复刻，取价改为锁定配置）。 */
  function legacyTotal(r, opt) {
    var c = legacyConfigAt(r.date, opt.versions, opt.baseline);
    var gross;
    if (opt.isPieceworkActive && opt.isPieceworkActive(r.date)) {
      gross = num(r.material_qty) * c.materialPrice + num(opt.pieceworkDailyAmount && opt.pieceworkDailyAmount(r.date));
    } else {
      gross = num(r.note_qty) * c.notePrice + num(r.material_qty) * c.materialPrice
            + num(r.video_qty) * c.videoPrice;
    }
    return (num(r.xhs) + num(r.dy) - num(r.refund)) * c.price + num(r.assist) + gross;
  }

  /** 历史月应发总额（旧 monthlySalary 同结构，取价锁定）。 */
  function legacyMonthlyTotal(recs, month, opt) {
    var c = legacyConfigAt(month + '-31', opt.versions, opt.baseline);
    var live = 0, pub = 0;
    recs.forEach(function (r) {
      live += (num(r.xhs) + num(r.dy) - num(r.refund)) * c.price;
      if (opt.isPieceworkActive && opt.isPieceworkActive(r.date)) {
        pub += num(r.material_qty) * c.materialPrice + num(opt.pieceworkDailyAmount && opt.pieceworkDailyAmount(r.date));
      } else {
        pub += num(r.note_qty) * c.notePrice + num(r.material_qty) * c.materialPrice
             + num(r.video_qty) * c.videoPrice;
      }
    });
    var base = (live + pub) > c.salaryThreshold ? c.salaryHigh : c.salaryLow;
    return live + pub + base;
  }

  return {
    FIELDS: FIELDS, ITEMS: ITEMS, XHS_ORDER_PRICE_KEY: XHS_ORDER_PRICE_KEY,
    DEFAULT_EFFECTIVE_FROM: DEFAULT_EFFECTIVE_FROM, DEFAULT_PRICES: DEFAULT_PRICES,
    PRICE_KEYS: PRICE_KEYS, COMPAT_DEFAULTS: COMPAT_DEFAULTS,
    num: num, isActive: isActive, priceAt: priceAt, seedBook: seedBook, setPrice: setPrice,
    unsetPrice: unsetPrice, blockedKeys: blockedKeys, daily: daily, monthly: monthly,
    legacyConfigAt: legacyConfigAt, legacyTotal: legacyTotal, legacyMonthlyTotal: legacyMonthlyTotal
  };
});
