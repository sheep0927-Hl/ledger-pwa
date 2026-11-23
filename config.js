/* ============================================================
 * U4 第一批整改 — 手机 PWA 只读查看端：集中环境配置
 *
 * 铁律（本文件不得违反）：
 *  - 不得包含任何真实 project ref、完整 URL 或明文 Key。
 *  - prod / test / dev 三套 profile 的 url 与 key 一律为空字符串：
 *    本轮零真实云端连接，禁止连接/访问/查询生产或 staging。
 *  - 生产凭据须在【构建期注入】，禁止提交到源码；注入前一律进入离线只读模式。
 *  - 当前生效环境由 window.LEDGER_ENV（默认 'dev'）决定。
 *  - READ_ONLY = true：客户端只读保护，不是服务端 RLS 强制隔离。
 * ============================================================ */
(function (root) {
  'use strict';
  var W = root || {};

  var PLACEHOLDER_NOTE = '需构建期注入，禁止提交到源码';

  var LEDGER_ENV_CONFIG = {
    READ_ONLY: true,
    ENV_LABEL: '手机端只读查看端（U4 第一批整改）',
    ACTIVE_ENV: (W.LEDGER_ENV || 'dev'),
    profiles: {
      dev:  { url: '', key: '', label: '开发（占位，未配置）', note: PLACEHOLDER_NOTE },
      test: { url: '', key: '', label: '测试（占位，未配置）', note: PLACEHOLDER_NOTE },
      prod: { url: '', key: '', label: '生产（构建期注入）', note: PLACEHOLDER_NOTE }
    },
    note: '三套 profile 的 url/key 均为空字符串：本轮零真实云端连接；' +
          '生产凭据需构建期注入，禁止提交到源码。'
  };

  LEDGER_ENV_CONFIG.activeProfile =
    LEDGER_ENV_CONFIG.profiles[LEDGER_ENV_CONFIG.ACTIVE_ENV] ||
    LEDGER_ENV_CONFIG.profiles.dev;

  W.LEDGER_ENV_CONFIG = LEDGER_ENV_CONFIG;
  W.LEDGER_READ_ONLY = LEDGER_ENV_CONFIG.READ_ONLY;   // READ_ONLY 常量
  W.LEDGER_ENV_LABEL = LEDGER_ENV_CONFIG.ENV_LABEL;   // ENV_LABEL

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LEDGER_ENV_CONFIG;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
