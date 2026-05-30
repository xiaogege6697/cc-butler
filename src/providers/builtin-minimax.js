'use strict';

/**
 * MiniMax 内建 adapter
 * 支持 MiniMax coding plan 余额查询
 * 注意: API 字段命名有误导性，usage 字段实际是剩余量
 */

const MINIMAX_REMAINS_URL = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';

/**
 * 创建 MiniMax adapter
 * @returns {object} adapter 对象
 */
function createMiniMaxAdapter() {
  return {
    id: 'minimax',
    name: 'MiniMax',
    match: /minimax|minimaxi/i,
    authType: 'bearer',

    /**
     * 获取 MiniMax 余额
     * 注意: current_interval_usage_count 和 current_weekly_usage_count 实际是剩余量，不是已用量
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
        const response = await fetch(MINIMAX_REMAINS_URL, {
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

        // 检查 API 错误
        if (data.base_resp?.status_code !== 0) {
          throw new Error(`API error ${data.base_resp?.status_code}: ${data.base_resp?.status_msg || 'unknown'}`);
        }

        const modelRemains = data.model_remains?.[0] || {};

        // 注意: 字段命名有误导性，usage 实际是剩余量
        const parseNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const balance = parseNum(modelRemains.current_interval_usage_count);
        const totalQuota = parseNum(modelRemains.current_interval_total_count);
        const usedQuota = (totalQuota != null && balance != null) ? totalQuota - balance : null;
        const resetAt = modelRemains.end_time ? new Date(modelRemains.end_time).toISOString() : null;

        return {
          balance,
          totalQuota,
          usedQuota,
          currency: 'requests',
          plan: null,
          resetAt,
          source: 'minimax-api',
          raw: {
            ...data,
            breakdown: {
              balance,
              totalQuota,
              usedQuota,
              weeklyBalance: modelRemains.current_weekly_usage_count || 0,
              weeklyTotal: modelRemains.current_weekly_total_count || 0,
              weeklyEndTime: modelRemains.weekly_end_time ? new Date(modelRemains.weekly_end_time).toISOString() : null,
              modelName: modelRemains.model_name,
            },
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createMiniMaxAdapter };
