'use strict';

/**
 * DeepSeek 内建 adapter
 * 支持 DeepSeek API 的余额查询
 */

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/v1/user/balance';

/**
 * 创建 DeepSeek adapter
 * @returns {object} adapter 对象
 */
function createDeepSeekAdapter() {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    match: /deepseek/i,
    authType: 'bearer',

    /**
     * 获取 DeepSeek 余额
     * @param {object} dep - deployment 对象
     * @param {object} config - deployment 配置
     * @returns {Promise<object>} 标准化余额结果
     */
    async fetch(dep, config) {
      const apiKey = dep.apiKey;
      if (!apiKey) {
        throw new Error(`Deployment "${dep.id}" missing apiKey`);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(DEEPSEEK_BALANCE_URL, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        }

        const data = await response.json();

        // DeepSeek 返回格式: { balance_infos: [{ currency: "CNY", total_balance: "...", granted_balance: "...", topped_up_balance: "..." }] }
        const balanceInfo = data.balance_infos?.[0] || {};
        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const totalBalance = parseNum(balanceInfo.total_balance);
        const grantedBalance = parseNum(balanceInfo.granted_balance);
        const toppedUpBalance = parseNum(balanceInfo.topped_up_balance);

        return {
          balance: totalBalance,
          totalQuota: null, // DeepSeek 不提供总额度
          usedQuota: null,
          currency: balanceInfo.currency || 'CNY',
          plan: null,
          resetAt: null,
          source: 'deepseek-api',
          raw: {
            ...data,
            breakdown: {
              total: totalBalance,
              granted: grantedBalance,
              toppedUp: toppedUpBalance,
            },
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createDeepSeekAdapter };
