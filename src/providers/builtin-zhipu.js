'use strict';

/**
 * Zhipu (智谱) 内建 adapter
 * 支持智谱 BigModel / Z.ai API 的余额查询
 *
 * API 端点（经 4 个开源项目交叉验证）：
 *   GET https://api.z.ai/api/monitor/usage/quota/limit  — Z.ai 官方 API
 *   GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report — 网页 API
 *
 * Z.ai 返回格式（含 5h/周/月 token 限额，带刷新时间）：
 * {
 *   "code": 200,
 *   "data": {
 *     "level": "pro",
 *     "limits": [
 *       { "type": "5h Token", "unit": 3, "usage": 1000000, "currentValue": 72000, "remaining": 928000, "percentage": 7, "nextResetTime": 1712956800000 },
 *       { "type": "Weekly Token", "unit": 6, "usage": 5000000, "currentValue": 2650000, "remaining": 2350000, "percentage": 53, "nextResetTime": 1713388800000 }
 *     ]
 *   }
 * }
 *
 * BigModel 余额端点（付费 API，返回现金余额）：
 * {
 *   "code": 200,
 *   "data": { "balance": 17.28, "availableBalance": 17.28, "rechargeAmount": 100.00, "totalSpendAmount": 92.72 }
 * }
 */

// Z.ai 端点：token plan 限额（5h/周/月刷新）
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
// BigModel 端点：付费 API 余额
const BIGMODEL_BALANCE_URL = 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report';

const TIMEOUT = 10_000;

/**
 * 创建 Zhipu adapter
 * @returns {object} adapter 对象
 */
function createZhipuAdapter() {
  return {
    id: 'zhipu',
    name: 'Zhipu (智谱)',
    match: /zhipu|bigmodel|glm|z\.ai/i,
    authType: 'bearer',

    /**
     * 获取智谱余额
     * 策略：先尝试 Z.ai quota 端点（token plan），失败则尝试 bigmodel 余额端点（付费 API）
     * @param {object} dep - deployment 对象
     * @param {object} config - deployment 配置
     * @returns {Promise<object>} 标准化余额结果
     */
    async fetch(dep, config) {
      const apiKey = dep.apiKey;
      if (!apiKey) {
        throw new Error(`Deployment "${dep.id}" missing apiKey`);
      }

      // 尝试 Z.ai quota 端点（token plan，含 5h/周/月限额）
      try {
        const quotaResult = await fetchZaiQuota(apiKey, dep);
        if (quotaResult) return quotaResult;
      } catch (err) {
        console.warn(`[zhipu-adapter] Z.ai quota failed: ${err.message}, trying bigmodel`);
      }

      // 回退：尝试 bigmodel 余额端点（付费 API）
      try {
        const balanceResult = await fetchBigModelBalance(apiKey, dep);
        if (balanceResult) return balanceResult;
      } catch (err) {
        console.warn(`[zhipu-adapter] bigmodel balance failed: ${err.message}`);
      }

      // 两个都失败，返回 null 余额
      return {
        balance: null,
        totalQuota: null,
        usedQuota: null,
        currency: 'CNY',
        plan: 'unknown',
        resetAt: null,
        source: 'zhipu-api',
        raw: { provider: 'zhipu', note: 'Both Z.ai and bigmodel endpoints failed' },
      };
    },
  };
}

/**
 * 从 Z.ai quota 端点获取 token plan 限额信息
 * 返回包含 5h/周/月限额的多层限额结构
 */
async function fetchZaiQuota(apiKey, dep) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(ZAI_QUOTA_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.code !== 200 || !data.data?.limits?.length) return null;

    // 取第一个 limit（通常是 5h Token）作为主限额
    const primary = data.data.limits[0];
    const resetAt = primary.nextResetTime ? new Date(primary.nextResetTime).toISOString() : null;

    return {
      balance: primary.remaining ?? null,
      totalQuota: primary.usage ?? null,
      usedQuota: primary.currentValue ?? null,
      currency: 'tokens',
      plan: data.data.level || 'token-plan',
      resetAt,
      source: 'zai-quota-api',
      raw: {
        level: data.data.level,
        limits: data.data.limits,
        primaryType: primary.type,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 从 bigmodel 余额端点获取付费 API 余额
 * 返回现金余额信息
 */
async function fetchBigModelBalance(apiKey, dep) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(BIGMODEL_BALANCE_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.code !== 200 || !data.data) return null;

    return {
      balance: data.data.availableBalance ?? null,
      totalQuota: data.data.rechargeAmount ?? null,
      usedQuota: data.data.totalSpendAmount ?? null,
      currency: 'CNY',
      plan: 'pay-as-you-go',
      resetAt: null,
      source: 'bigmodel-balance-api',
      raw: data.data,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { createZhipuAdapter };
