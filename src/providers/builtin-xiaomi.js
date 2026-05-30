'use strict';

/**
 * Xiaomi MiMo 内建 adapter
 * 支持多种余额端点的 fallback 链
 */

const XIAOMI_PAYG_URL = 'https://api.xiaomimimo.com/v1/user/balance';
const XIAOMI_TOKEN_PLAN_URL = 'https://token-plan-sgp.xiaomimimo.com/v1/user/balance';
const XIAOMI_COOKIE_USAGE_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage';

/**
 * 创建 Xiaomi MiMo adapter
 * @returns {object} adapter 对象
 */
function createXiaomiAdapter() {
  return {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    match: /xiaomi|mimo/i,
    authType: 'bearer',

    /**
     * 获取 Xiaomi MiMo 余额
     * 依次尝试三个端点，返回第一个成功的
     * @param {object} dep - deployment 对象
     * @param {object} config - deployment 配置
     * @returns {Promise<object>} 标准化余额结果
     */
    async fetch(dep, config) {
      const apiKey = dep.apiKey;
      const cookie = dep.cookie;
      if (!apiKey && !cookie) {
        throw new Error(`Deployment "${dep.id}" missing apiKey or cookie`);
      }

      const errors = [];

      // 端点 1: PAYG balance
      if (apiKey) {
        try {
          const result = await this._fetchPaygBalance(apiKey);
          return result;
        } catch (e) {
          errors.push(`PAYG: ${e.message}`);
        }

        // 端点 2: Token Plan balance
        try {
          const result = await this._fetchTokenPlanBalance(apiKey);
          return result;
        } catch (e) {
          errors.push(`Token Plan: ${e.message}`);
        }
      }

      // 端点 3: Cookie usage
      if (cookie) {
        try {
          const result = await this._fetchCookieUsage(cookie);
          return result;
        } catch (e) {
          errors.push(`Cookie: ${e.message}`);
        }
      }

      throw new Error(`All Xiaomi endpoints failed: ${errors.join('; ')}`);
    },

    /**
     * 端点 1: PAYG balance
     */
    async _fetchPaygBalance(apiKey) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(XIAOMI_PAYG_URL, {
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
        const balanceData = data.data || {};
        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const balance = parseNum(balanceData.balance);
        const chargeBalance = parseNum(balanceData.charge_balance);
        const grantedBalance = parseNum(balanceData.granted_balance);

        return {
          balance,
          totalQuota: null,
          usedQuota: null,
          currency: 'CNY',
          plan: balanceData.plan || 'PAYG',
          resetAt: null,
          source: 'xiaomi-api-payg',
          raw: {
            ...data,
            breakdown: {
              balance,
              chargeBalance,
              grantedBalance,
            },
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },

    /**
     * 端点 2: Token Plan balance
     */
    async _fetchTokenPlanBalance(apiKey) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(XIAOMI_TOKEN_PLAN_URL, {
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
        const balanceData = data.data || {};
        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const tokenBalance = parseNum(balanceData.token_balance);
        const tokenLimit = parseNum(balanceData.token_limit);
        const balance = (tokenBalance != null && tokenLimit != null) ? tokenLimit - tokenBalance : null;

        return {
          balance,
          totalQuota: tokenLimit,
          usedQuota: tokenBalance,
          currency: 'tokens',
          plan: balanceData.plan_name || null,
          resetAt: null,
          source: 'xiaomi-api-token-plan',
          raw: {
            ...data,
            breakdown: {
              balance,
              tokenBalance,
              tokenLimit,
            },
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },

    /**
     * 端点 3: Cookie usage
     */
    async _fetchCookieUsage(cookie) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(XIAOMI_COOKIE_USAGE_URL, {
          method: 'GET',
          headers: {
            'Cookie': cookie,
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
          throw new Error(`API error code ${data.code}: ${data.message || 'unknown error'}`);
        }

        const monthUsage = data.data?.monthUsage;
        const totalTokenItem = monthUsage?.items?.find(i => i.name === 'month_total_token');
        if (!totalTokenItem) {
          throw new Error('month_total_token not found in response');
        }

        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const used = parseNum(totalTokenItem.used);
        const limit = parseNum(totalTokenItem.limit);
        const balance = (used != null && limit != null) ? limit - used : null;

        return {
          balance,
          totalQuota: limit,
          usedQuota: used,
          currency: 'tokens',
          plan: null,
          resetAt: null,
          source: 'xiaomi-cookie',
          raw: {
            ...data,
            breakdown: {
              balance,
              used,
              limit,
            },
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createXiaomiAdapter };
