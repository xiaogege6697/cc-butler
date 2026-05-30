'use strict';

/**
 * OpenRouter 内建 adapter
 * 支持 OpenRouter API 的余额查询（并行请求两个端点）
 */

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const OPENROUTER_AUTH_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';

/**
 * 创建 OpenRouter adapter
 * @returns {object} adapter 对象
 */
function createOpenRouterAdapter() {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    match: /openrouter/i,
    authType: 'bearer',

    /**
     * 获取 OpenRouter 余额
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

      const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      };

      try {
        const [creditsResult, authKeyResult] = await Promise.allSettled([
          fetch(OPENROUTER_CREDITS_URL, {
            method: 'GET',
            headers,
            signal: controller.signal,
          }).then(async (res) => {
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
            }
            return res.json();
          }),
          fetch(OPENROUTER_AUTH_KEY_URL, {
            method: 'GET',
            headers,
            signal: controller.signal,
          }).then(async (res) => {
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
            }
            return res.json();
          }),
        ]);

        // 两个端点都失败则抛错
        if (creditsResult.status === 'rejected' && authKeyResult.status === 'rejected') {
          const creditsErr = creditsResult.reason?.message || 'unknown';
          const authErr = authKeyResult.reason?.message || 'unknown';
          throw new Error(`Both OpenRouter endpoints failed: credits=${creditsErr}, auth_key=${authErr}`);
        }

        const creditsData = creditsResult.status === 'fulfilled' ? creditsResult.value?.data : null;
        const authKeyData = authKeyResult.status === 'fulfilled' ? authKeyResult.value?.data : null;

        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const totalCredits = parseNum(creditsData?.total_credits);
        const totalUsage = parseNum(creditsData?.total_usage);
        const balance = (totalCredits != null && totalUsage != null) ? totalCredits - totalUsage : null;
        const isFreeTier = authKeyData?.is_free_tier ?? null;

        return {
          balance,
          totalQuota: totalCredits > 0 ? totalCredits : null,
          usedQuota: totalUsage > 0 ? totalUsage : null,
          currency: 'USD',
          plan: isFreeTier !== null ? (isFreeTier ? 'free' : 'paid') : null,
          resetAt: null,
          source: 'openrouter-api',
          raw: {
            credits: creditsResult.status === 'fulfilled' ? creditsResult.value : null,
            auth_key: authKeyResult.status === 'fulfilled' ? authKeyResult.value : null,
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createOpenRouterAdapter };
