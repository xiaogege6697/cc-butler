'use strict';

/**
 * Xiaomi MiMo 内建 adapter
 *
 * 只有一个可用认证路径：通过浏览器 cookie 访问 platform.xiaomimimo.com
 * 因为 httpOnly cookie 无法从 Node.js 直接获取，支持两种模式：
 *
 * 1. CDP 模式（推荐）：通过 CDP proxy 在浏览器内执行 fetch
 *    需要配置 cdpProxyUrl + cdpTargetId
 *    浏览器自动带上所有 cookie（包括 httpOnly）
 *
 * 2. 直接模式：用完整 cookie 字符串从 Node.js 发请求
 *    需要包含 httpOnly session cookies
 *
 * 可用端点（platform.xiaomimimo.com）：
 *   - /api/v1/tokenPlan/usage  → credits 用量（month_total_token）
 *   - /api/v1/tokenPlan/detail → 套餐名称 & 到期时间
 *
 * 已废弃（404）：
 *   - api.xiaomimimo.com/v1/user/balance
 *   - token-plan-sgp.xiaomimimo.com/v1/user/balance
 */

const TIMEOUT_MS = 10_000;

function parseNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 通过 CDP proxy 在浏览器内执行 JS 并获取结果
 * @param {string} proxyUrl - CDP proxy 地址（如 http://localhost:3456）
 * @param {string} targetId - 浏览器 tab 的 target ID
 * @param {string} jsExpr - 要执行的 JS 表达式
 * @returns {Promise<string>} eval 返回的 value 字符串
 */
async function cdpEval(proxyUrl, targetId, jsExpr) {
  const url = `${proxyUrl}/eval?target=${targetId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: jsExpr,
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`CDP proxy HTTP ${resp.status}`);
    }

    const wrapper = await resp.json();
    if (wrapper.error) {
      throw new Error(`CDP eval error: ${wrapper.error}`);
    }

    return wrapper.value;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 从 usage + detail 数据中提取标准化的余额结果
 */
function buildResult(usageData, detailData) {
  const monthUsage = usageData?.monthUsage;
  const totalTokenItem = monthUsage?.items?.find(i => i.name === 'month_total_token');
  if (!totalTokenItem) {
    throw new Error('month_total_token not found in usage response');
  }

  const used = parseNum(totalTokenItem.used);
  const limit = parseNum(totalTokenItem.limit);
  const balance = (used != null && limit != null) ? limit - used : null;

  const plan = detailData?.planName || detailData?.planCode || null;
  const resetAt = detailData?.currentPeriodEnd || null;

  return {
    balance,
    totalQuota: limit,
    usedQuota: used,
    currency: 'credits',
    plan,
    resetAt,
    source: 'xiaomi-cdp',
    raw: {
      usage: usageData,
      detail: detailData,
      breakdown: {
        used,
        limit,
        balance,
        percentage: totalTokenItem.percent,
      },
    },
  };
}

/**
 * 创建 Xiaomi MiMo adapter
 * @returns {object} adapter 对象
 */
function createXiaomiAdapter() {
  return {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    match: /xiaomi|mimo/i,
    authType: 'cookie',

    /**
     * 获取 Xiaomi MiMo 余额
     * 优先使用 CDP 模式，回退到直接 cookie 模式
     * @param {object} dep - deployment 对象
     * @returns {Promise<object>} 标准化余额结果
     */
    async fetch(dep) {
      const { cdpProxyUrl, cdpTargetId, cookie } = dep;

      // 模式 1: CDP proxy（推荐，能自动带上 httpOnly cookies）
      if (cdpProxyUrl) {
        const targetId = cdpTargetId || await this._findTarget(cdpProxyUrl);
        if (targetId) {
          return this._fetchViaCdp(cdpProxyUrl, targetId);
        }
      }

      // 模式 2: 直接 cookie（需要完整的 cookie 包括 httpOnly）
      if (cookie) {
        return this._fetchDirect(cookie);
      }

      throw new Error(
        `Deployment "${dep.id}" 需要配置认证信息。` +
        `推荐方案：添加 "cdpProxyUrl" 字段（如 "http://localhost:3456"），adapter 会自动查找小米平台 tab。` +
        `备选方案：添加 "cdpProxyUrl" + "cdpTargetId" 指定 tab。`
      );
    },

    /**
     * 从 CDP proxy 的 /targets 中找到 platform.xiaomimimo.com 的 tab
     * @param {string} proxyUrl
     * @returns {Promise<string|null>} targetId
     */
    async _findTarget(proxyUrl) {
      try {
        const resp = await fetch(`${proxyUrl}/targets`, { signal: AbortSignal.timeout(5000) });
        const targets = await resp.json();
        const match = targets.find(t => /platform\.xiaomimimo\.com/.test(t.url || ''));
        return match?.targetId || null;
      } catch {
        return null;
      }
    },

    /**
     * CDP 模式：通过 CDP proxy 在浏览器内执行 fetch
     * 浏览器自动带上所有 cookie（包括 httpOnly session cookies）
     */
    async _fetchViaCdp(proxyUrl, targetId) {
      // 在浏览器内并行调用 usage + detail
      const jsExpr = [
        '(async()=>{',
        '  const[uR,dR]=await Promise.all([',
        '    fetch("/api/v1/tokenPlan/usage"),',
        '    fetch("/api/v1/tokenPlan/detail")',
        '  ]);',
        '  const u=await uR.json();',
        '  const d=await dR.json();',
        '  return JSON.stringify({usage:u,detail:d});',
        '})()',
      ].join('');

      const raw = await cdpEval(proxyUrl, targetId, jsExpr);
      const combined = JSON.parse(raw);

      // 检查 API 层面的错误
      if (combined.usage?.code !== 0) {
        throw new Error(`usage API error ${combined.usage?.code}: ${combined.usage?.message || 'unknown'}`);
      }
      if (combined.detail?.code !== 0) {
        // detail 失败不阻断，置为 null
        combined.detail = null;
      }

      return buildResult(combined.usage?.data, combined.detail?.data);
    },

    /**
     * 直接模式：用 cookie 字符串从 Node.js 发请求
     * 需要 cookie 包含 httpOnly session cookies
     */
    async _fetchDirect(cookie) {
      const [usageData, detailData] = await Promise.all([
        this._fetchApi('https://platform.xiaomimimo.com/api/v1/tokenPlan/usage', cookie),
        this._fetchApi('https://platform.xiaomimimo.com/api/v1/tokenPlan/detail', cookie).catch(() => null),
      ]);

      return buildResult(usageData, detailData);
    },

    /**
     * 直接发 HTTP 请求到指定 URL
     */
    async _fetchApi(url, cookie) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Cookie': cookie, 'Accept': 'application/json' },
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        }

        const data = await response.json();
        if (data.code !== 0) {
          throw new Error(`API error ${data.code}: ${data.message || 'unknown'}`);
        }

        return data.data;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

module.exports = { createXiaomiAdapter };
