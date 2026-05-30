'use strict';

/**
 * Kimi (Moonshot) 内建 adapter
 * 支持 Moonshot API 的余额查询
 */

const MOONSHOT_BALANCE_URL = 'https://api.moonshot.cn/v1/users/me/balance';

/**
 * 创建 Kimi adapter
 * @returns {object} adapter 对象
 */
function createKimiAdapter() {
  return {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    match: /kimi|moonshot/i,
    authType: 'bearer',

    /**
     * 获取 Kimi 余额
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
        const response = await fetch(MOONSHOT_BALANCE_URL, {
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

        if (data.code !== 0) {
          throw new Error(`Moonshot API error: code=${data.code}, msg=${data.msg || 'unknown'}`);
        }

        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const availableBalance = parseNum(data.data?.available_balance);

        return {
          balance: availableBalance,
          totalQuota: null,
          usedQuota: null,
          currency: 'CNY',
          plan: null,
          resetAt: null,
          source: 'moonshot-api',
          raw: {
            ...data,
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createKimiAdapter };
