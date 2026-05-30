'use strict';

/**
 * GACCode 内建 adapter
 * 支持 GACCode credits 余额查询
 */

const GACCODE_BALANCE_URL = 'https://gaccode.com/api/credits/balance';

/**
 * 创建 GACCode adapter
 * @returns {object} adapter 对象
 */
function createGacCodeAdapter() {
  return {
    id: 'gaccode',
    name: 'GACCode',
    match: /gaccode/i,
    authType: 'bearer',

    /**
     * 获取 GACCode 余额
     * @param {object} dep - deployment 对象
     * @param {object} config - deployment 配置
     * @returns {Promise<object>} 标准化余额结果
     */
    async fetch(dep, config) {
      const jwtToken = dep.apiKey;
      if (!jwtToken) {
        throw new Error(`Deployment "${dep.id}" missing apiKey (JWT token)`);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(GACCODE_BALANCE_URL, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${jwtToken}`,
            'Accept': 'application/json',
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        }

        const data = await response.json();
        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const balance = parseNum(data.balance);
        const creditCap = parseNum(data.creditCap);
        const refillRate = parseNum(data.refillRate);

        return {
          balance,
          totalQuota: null, // creditCap 是每个充值周期的最大值，不是总额度
          usedQuota: null,
          currency: 'credits',
          plan: null,
          resetAt: null,
          source: 'gaccode-api',
          raw: {
            ...data,
            breakdown: {
              balance,
              creditCap,
              refillRate,
            },
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createGacCodeAdapter };
