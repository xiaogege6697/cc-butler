'use strict';

/**
 * SiliconFlow 内建 adapter
 * 支持 SiliconFlow API 的余额查询
 */

const SILICONFLOW_USER_INFO_URL = 'https://api.siliconflow.cn/v1/user/info';

/**
 * 创建 SiliconFlow adapter
 * @returns {object} adapter 对象
 */
function createSiliconFlowAdapter() {
  return {
    id: 'siliconflow',
    name: 'SiliconFlow',
    match: /siliconflow/i,
    authType: 'bearer',

    /**
     * 获取 SiliconFlow 余额
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
        const response = await fetch(SILICONFLOW_USER_INFO_URL, {
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

        if (data.code !== 20000) {
          throw new Error(`SiliconFlow API error: code=${data.code}, message=${data.message || 'unknown'}`);
        }

        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const balance = parseNum(data.data?.balance);
        const totalBalance = parseNum(data.data?.totalBalance);
        const usedQuota = (totalBalance != null && balance != null) ? totalBalance - balance : null;

        return {
          balance,
          totalQuota: totalBalance > 0 ? totalBalance : null,
          usedQuota,
          currency: 'CNY',
          plan: null,
          resetAt: null,
          source: 'siliconflow-api',
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

module.exports = { createSiliconFlowAdapter };
