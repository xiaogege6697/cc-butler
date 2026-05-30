'use strict';

// ---------------------------------------------------------------------------
// 超时配置（毫秒）
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// 辅助函数：通过点符号路径遍历嵌套对象
// ---------------------------------------------------------------------------
/**
 * 通过点符号路径获取嵌套对象的值
 * @param {object} obj - 源对象
 * @param {string} path - 点符号路径，如 "data.balance"
 * @returns {*} 路径对应的值，路径不存在返回 undefined
 */
function resolveJsonPath(obj, path) {
  if (!obj || !path) return undefined;

  const keys = path.split('.');
  let current = obj;

  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    // 防止原型链污染
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

// ---------------------------------------------------------------------------
// 标准化结果对象
// ---------------------------------------------------------------------------
function normalizeResult(raw = {}) {
  return {
    balance: raw.balance ?? null,
    totalQuota: raw.totalQuota ?? null,
    usedQuota: raw.usedQuota ?? null,
    currency: raw.currency ?? null,
    plan: raw.plan ?? null,
    resetAt: raw.resetAt ?? null,
    source: raw.source ?? 'adapter',
    raw: raw.raw ?? raw,
  };
}

// ---------------------------------------------------------------------------
// 通用 HTTP 余额获取（用于自定义 adapters）
// ---------------------------------------------------------------------------
/**
 * 通过 HTTP 获取余额信息
 * @param {object} customAdapter - 自定义 adapter 配置
 * @param {object} dep - deployment 对象
 * @returns {Promise<object>} 标准化结果
 */
async function fetchBalanceViaHttp(customAdapter, dep) {
  const { endpoint, authType = 'bearer', headers: customHeaders = {}, responseMap = {} } = customAdapter;

  if (!endpoint) {
    throw new Error(`Custom adapter "${customAdapter.id}" missing endpoint`);
  }

  // SSRF 防护：仅允许 https:// 协议，禁止私有/回环地址
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') {
      throw new Error(`Custom adapter endpoint must use https:// protocol, got: ${url.protocol}`);
    }
    const hostname = url.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('169.254.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      throw new Error(`Custom adapter endpoint resolves to private/loopback address: ${hostname}`);
    }
  } catch (err) {
    if (err.message.includes('must use https') || err.message.includes('private/loopback')) throw err;
    throw new Error(`Custom adapter "${customAdapter.id}" has invalid endpoint URL: ${err.message}`);
  }

  const apiKey = dep.apiKey;
  if (!apiKey) {
    throw new Error(`Deployment "${dep.id}" missing apiKey for adapter "${customAdapter.id}"`);
  }

  // 构建请求 headers
  const headers = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };

  // 添加认证 header
  if (authType === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (authType === 'cookie') {
    headers['Cookie'] = `token=${apiKey}`;
  }

  // 创建超时 AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 截断错误信息，防止 API key 泄露
      const safeText = (text || response.statusText).slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${safeText}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (jsonErr) {
      throw new Error(`Custom adapter "${customAdapter.id}" received non-JSON response from ${endpoint}`);
    }

    // 使用 responseMap 提取字段
    const result = {};
    if (responseMap.balance) {
      result.balance = resolveJsonPath(data, responseMap.balance);
    }
    if (responseMap.totalQuota) {
      result.totalQuota = resolveJsonPath(data, responseMap.totalQuota);
    }
    if (responseMap.usedQuota) {
      result.usedQuota = resolveJsonPath(data, responseMap.usedQuota);
    }
    if (responseMap.currency) {
      result.currency = resolveJsonPath(data, responseMap.currency);
    }
    if (responseMap.plan) {
      result.plan = resolveJsonPath(data, responseMap.plan);
    }
    if (responseMap.resetAt) {
      result.resetAt = resolveJsonPath(data, responseMap.resetAt);
    }

    return normalizeResult({
      ...result,
      source: 'custom-adapter',
      raw: data,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Registry 工厂函数
// ---------------------------------------------------------------------------
/**
 * 创建 adapter registry
 * @returns {{ register, find, list, loadCustomAdapters, resolveJsonPath }}
 */
function createRegistry() {
  /** @type {Map<string, object>} 内建 adapters */
  const adapters = new Map();

  /** @type {Map<string, object>} 自定义 adapters */
  const customAdapters = new Map();

  // =========================================================================
  // 内建 adapter 注册
  // =========================================================================

  /**
   * 注册一个内建 adapter
   * @param {object} adapter - adapter 对象
   * @param {string} adapter.id - 唯一标识符
   * @param {string} adapter.name - 显示名称
   * @param {RegExp} adapter.match - 匹配 baseUrl 或 deployment name 的正则
   * @param {string} [adapter.authType='bearer'] - 认证类型
   * @param {Function} adapter.fetch - 获取余额的异步函数
   */
  function register(adapter) {
    if (!adapter?.id) {
      throw new Error('Adapter must have an id');
    }
    if (!adapter.match || !(adapter.match instanceof RegExp)) {
      throw new Error(`Adapter "${adapter.id}" must have a RegExp match pattern`);
    }
    if (typeof adapter.fetch !== 'function') {
      throw new Error(`Adapter "${adapter.id}" must have a fetch function`);
    }

    adapters.set(adapter.id, {
      ...adapter,
      name: adapter.name || adapter.id,
      authType: adapter.authType || 'bearer',
    });
  }

  // =========================================================================
  // 自定义 adapter 加载
  // =========================================================================

  /**
   * 加载用户自定义 adapters
   * @param {Array<object>} customAdapterConfigs - 自定义 adapter 配置数组
   */
  function loadCustomAdapters(customAdapterConfigs = []) {
    customAdapters.clear();

    for (const config of customAdapterConfigs) {
      if (!config?.id) {
        console.warn('[registry] Skipping custom adapter without id');
        continue;
      }

      // 将字符串 match 转换为 RegExp（转义特殊字符后作为字面匹配）
      let matchPattern;
      if (typeof config.match === 'string') {
        const escaped = config.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        matchPattern = new RegExp(escaped, 'i');
      } else if (config.match instanceof RegExp) {
        matchPattern = config.match;
      } else {
        console.warn(`[registry] Custom adapter "${config.id}" has no valid match pattern`);
        continue;
      }

      const customAdapter = {
        id: config.id,
        name: config.name || config.id,
        match: matchPattern,
        authType: config.authType || 'bearer',
        endpoint: config.endpoint,
        headers: config.headers || {},
        responseMap: config.responseMap || {},
        // 为自定义 adapter 创建 fetch 函数
        fetch: async (dep, deploymentConfig) => {
          return fetchBalanceViaHttp(customAdapter, dep);
        },
      };

      customAdapters.set(config.id, customAdapter);
    }
  }

  // =========================================================================
  // Adapter 查找
  // =========================================================================

  /**
   * 查找匹配的 adapter
   * 优先级：(a) config.balanceAdapter 指定 > (b) 匹配 baseUrl > (c) 匹配 name
   * @param {object} dep - deployment 对象
   * @param {object} config - deployment 配置（可能包含 balanceAdapter 覆盖）
   * @returns {object|null} 匹配的 adapter，未找到返回 null
   */
  function find(dep, config = {}) {
    if (!dep) return null;

    // (a) 检查 config.balanceAdapter 覆盖
    if (config.balanceAdapter) {
      const override = adapters.get(config.balanceAdapter) || customAdapters.get(config.balanceAdapter);
      if (override) return override;
    }

    // (b) 匹配 baseUrl
    const baseUrl = dep.baseUrl || '';
    for (const adapter of adapters.values()) {
      if (adapter.match.test(baseUrl)) {
        return adapter;
      }
    }

    // (c) 匹配 name
    const name = dep.name || '';
    for (const adapter of adapters.values()) {
      if (adapter.match.test(name)) {
        return adapter;
      }
    }

    // 自定义 adapters 也按同样优先级查找
    for (const adapter of customAdapters.values()) {
      if (adapter.match.test(baseUrl)) {
        return adapter;
      }
    }
    for (const adapter of customAdapters.values()) {
      if (adapter.match.test(name)) {
        return adapter;
      }
    }

    return null;
  }

  // =========================================================================
  // 列出所有 adapters
  // =========================================================================

  /**
   * 列出所有注册的 adapters
   * @returns {Array<object>} adapter 列表
   */
  function list() {
    const result = [];

    for (const adapter of adapters.values()) {
      result.push({
        id: adapter.id,
        name: adapter.name,
        type: 'builtin',
        authType: adapter.authType,
        match: adapter.match.toString(),
      });
    }

    for (const adapter of customAdapters.values()) {
      result.push({
        id: adapter.id,
        name: adapter.name,
        type: 'custom',
        authType: adapter.authType,
        endpoint: adapter.endpoint,
        match: adapter.match.toString(),
      });
    }

    return result;
  }

  // =========================================================================
  // 返回公开 API
  // =========================================================================

  return {
    register,
    find,
    list,
    loadCustomAdapters,
    resolveJsonPath,
  };
}

module.exports = { createRegistry };
