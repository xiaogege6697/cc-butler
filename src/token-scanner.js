'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createInitializedRegistry } = require('./providers');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.CC_BUTLER_ROOT
  ? path.resolve(process.env.CC_BUTLER_ROOT)
  : path.join(PROJECT_ROOT, 'data');
const CACHE_PATH = path.join(DATA_DIR, 'token-cache.json');
const TMP_EXT = '.tmp';

// ---------------------------------------------------------------------------
// 原子写入（与 config.js 一致）
// ---------------------------------------------------------------------------
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = filePath + TMP_EXT + '.' + crypto.randomBytes(4).toString('hex');

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// 读取缓存文件
// ---------------------------------------------------------------------------
function readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[token-scanner] 缓存文件读取失败（可能已损坏）: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 创建 Token Scanner
// ---------------------------------------------------------------------------
/**
 * @param {object} config - config 模块实例
 * @param {EventEmitter} bus - config.bus 事件总线
 * @returns {{ start, stop, scan, getStatus, setCredentials, getCachedData }}
 */
// 默认扫描间隔（分钟）
const DEFAULT_SCAN_INTERVAL_MINUTES = 10;

function createTokenScanner(config, bus) {
  const _timers = new Map(); // deploymentId -> timeoutId
  let _lastResult = null; // 内存缓存
  const _credentials = new Map(); // deploymentId -> { username, password, cookie }

  // 初始化 provider adapter registry
  const customAdapters = config.getConfig()?.tokenScanner?.customAdapters || [];
  const registry = createInitializedRegistry(customAdapters);

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 通过 adapter registry 获取真实余额数据
   */
  async function fetchBalance(dep) {
    const depConfig = dep; // deployment config may have balanceAdapter override
    const adapter = registry.find(dep, depConfig);

    if (!adapter) {
      // No matching adapter, return null-source result
      return {
        balance: null, totalQuota: null, usedQuota: null,
        percentage: null, currency: null, plan: null, resetAt: null,
        source: 'no-adapter',
        raw: { provider: 'unknown', baseUrl: dep.baseUrl },
      };
    }

    // Resolve apiKey if it's env:XXX format
    const apiKey = dep.apiKey?.startsWith('env:')
      ? process.env[dep.apiKey.slice(4)]
      : dep.apiKey;

    const result = await adapter.fetch({ ...dep, apiKey }, depConfig);

    // Calculate percentage from balance/totalQuota if available
    let percentage = null;
    if (result.totalQuota && result.totalQuota > 0 && result.usedQuota != null && Number.isFinite(result.usedQuota)) {
      percentage = Math.round((result.usedQuota / result.totalQuota) * 100);
    } else if (result.balance != null && result.totalQuota && result.totalQuota > 0 && Number.isFinite(result.balance)) {
      percentage = Math.round(((result.totalQuota - result.balance) / result.totalQuota) * 100);
    }

    return {
      balance: result.balance ?? null,
      totalQuota: result.totalQuota ?? null,
      usedQuota: result.usedQuota ?? null,
      percentage,
      currency: result.currency ?? null,
      plan: result.plan ?? null,
      resetAt: result.resetAt ?? null,
      source: result.source || 'adapter',
      raw: result.raw || {},
    };
  }

  /**
   * 检查是否触发阈值告警
   */
  function checkAlert(depId, data, threshold) {
    if (data.percentage == null) return false;
    return data.percentage >= threshold * 100;
  }

  /**
   * 执行一次完整的扫描流程
   */
  async function doScan() {
    // 只扫活跃区
    const deployments = config.getDeployments().filter(d => d.enabled);
    const cfg = config.getConfig();
    const alertThreshold = cfg.budget?.alertThreshold ?? 0.8;

    const now = new Date().toISOString();
    const cache = {
      lastScanAt: now,
      deployments: {},
    };

    for (const dep of deployments) {
      try {
        const balanceData = await fetchBalance(dep);
        balanceData.lastUpdated = now;

        cache.deployments[dep.id] = balanceData;

        // 检查阈值告警
        if (checkAlert(dep.id, balanceData, alertThreshold)) {
          bus.emit('token.alert', {
            deploymentId: dep.id,
            percentage: balanceData.percentage,
            threshold: alertThreshold,
            data: balanceData,
          });
        }
      } catch (err) {
        // 单个 deployment 失败不影响其他
        const previous = _lastResult?.deployments?.[dep.id] || readCache()?.deployments?.[dep.id];
        if (previous && previous.source !== 'error') {
          // Keep previous data but mark as stale
          cache.deployments[dep.id] = {
            ...previous,
            stale: true,
            lastError: err.message,
            lastUpdated: now,
          };
        } else {
          cache.deployments[dep.id] = {
            balance: null, totalQuota: null, usedQuota: null,
            percentage: null, currency: null, plan: null, resetAt: null,
            source: 'error',
            lastUpdated: now,
            raw: { error: err.message },
          };
        }
      }
    }

    // 原子写入缓存
    atomicWrite(CACHE_PATH, cache);

    // 内存缓存
    _lastResult = cache;

    // 通知 Dashboard
    bus.emit('token.updated', cache);

    return cache;
  }

  // =========================================================================
  // 公开 API
  // =========================================================================

  /**
   * 扫描单个 deployment（用于按 deployment 独立定时）
   * @param {string} deploymentId
   * @returns {Promise<object>} 该 deployment 的扫描结果
   */
  async function scanSingle(deploymentId) {
    const dep = config.getDeployments().find(d => d.id === deploymentId && d.enabled);
    if (!dep) {
      console.warn(`[token-scanner] deployment ${deploymentId} 不存在，跳过`);
      return null;
    }

    const cfg = config.getConfig();
    const alertThreshold = cfg.budget?.alertThreshold ?? 0.8;
    const now = new Date().toISOString();

    try {
      const balanceData = await fetchBalance(dep);
      balanceData.lastUpdated = now;

      // 合并到内存缓存
      if (!_lastResult) _lastResult = { lastScanAt: now, deployments: {} };
      _lastResult.lastScanAt = now;
      _lastResult.deployments[dep.id] = balanceData;

      // 原子写入磁盘
      atomicWrite(CACHE_PATH, _lastResult);

      // 检查阈值告警
      if (checkAlert(dep.id, balanceData, alertThreshold)) {
        bus.emit('token.alert', {
          deploymentId: dep.id,
          percentage: balanceData.percentage,
          threshold: alertThreshold,
          data: balanceData,
        });
      }

      // 通知 Dashboard
      bus.emit('token.updated', _lastResult);

      console.log(`[token-scanner] ${dep.id} 扫描完成`);
      return balanceData;
    } catch (err) {
      const previous = _lastResult?.deployments?.[dep.id] || readCache()?.deployments?.[dep.id];
      const errorResult = (previous && previous.source !== 'error')
        ? { ...previous, stale: true, lastError: err.message, lastUpdated: now }
        : {
            balance: null, totalQuota: null, usedQuota: null,
            percentage: null, currency: null, plan: null, resetAt: null,
            source: 'error', lastUpdated: now,
            raw: { error: err.message },
          };

      if (!_lastResult) _lastResult = { lastScanAt: now, deployments: {} };
      _lastResult.deployments[dep.id] = errorResult;
      atomicWrite(CACHE_PATH, _lastResult);
      bus.emit('token.updated', _lastResult);

      console.error(`[token-scanner] ${dep.id} 扫描失败:`, err.message);
      return errorResult;
    }
  }

  /**
   * 启动定时扫描（每个 deployment 独立间隔）
   */
  function start() {
    stop(); // 先清理已有的定时器

    const cfg = config.getConfig();
    const scannerConfig = cfg.tokenScanner || {};
    if (scannerConfig.enabled === false) {
      console.log('[token-scanner] 定时扫描已禁用');
      return;
    }

    // 重新加载自定义 adapters
    const customAdapters = cfg.tokenScanner?.customAdapters || [];
    registry.loadCustomAdapters(customAdapters);

    // 只扫活跃区（enabled=true），暂存区不扫
    const deployments = config.getDeployments().filter(d => d.enabled);

    // 启动时先全量扫一次
    doScan().catch((err) => {
      console.error('[token-scanner] 初始扫描失败:', err.message);
    });

    // 为每个 deployment 启动独立定时器
    for (const dep of deployments) {
      scheduleDeployment(dep);
    }

    console.log(`[token-scanner] 定时扫描已启动，${deployments.length} 个活跃 deployment，默认间隔 ${DEFAULT_SCAN_INTERVAL_MINUTES} 分钟`);
  }

  /**
   * 为单个 deployment 调度定时扫描
   * 使用 setTimeout 链式调用，避免重叠
   */
  function scheduleDeployment(dep) {
    const minutes = dep.scanIntervalMinutes || DEFAULT_SCAN_INTERVAL_MINUTES;
    const ms = minutes * 60 * 1000;

    const timerId = setTimeout(async () => {
      try {
        // 只扫描这一个 deployment
        await scanSingle(dep.id);
      } catch (err) {
        console.error(`[token-scanner] 定时扫描 ${dep.id} 失败:`, err.message);
      }
      // 扫完后重新调度（deployment 可能已被删除或移入暂存区）
      const current = config.getDeployments().find(d => d.id === dep.id && d.enabled);
      if (current) {
        scheduleDeployment(current);
      }
    }, ms);

    if (timerId.unref) timerId.unref();
    _timers.set(dep.id, timerId);
  }

  /**
   * 停止定时扫描
   */
  function stop() {
    for (const [depId, timerId] of _timers) {
      clearTimeout(timerId);
    }
    _timers.clear();
    console.log('[token-scanner] 定时扫描已停止');
  }

  /**
   * 手动触发一次扫描
   * @returns {Promise<object>} 扫描结果
   */
  async function scan() {
    console.log('[token-scanner] 手动触发扫描');
    return doScan();
  }

  /**
   * 获取缓存的余额数据（从磁盘读取）
   * @returns {object|null}
   */
  function getStatus() {
    return readCache();
  }

  /**
   * 获取内存中最近一次扫描结果（不读磁盘）
   * 如果当前进程没有扫描过，回退到磁盘缓存
   */
  function getCachedData() {
    return _lastResult || readCache();
  }

  /**
   * 设置登录凭据（后期 CDP 抓取时使用）
   * @param {string} deploymentId - deployment ID
   * @param {object} credentials - { username, password, cookie }
   */
  function setCredentials(deploymentId, credentials) {
    // 清理 deploymentId 防止日志注入
    const safeId = String(deploymentId).replace(/[\r\n]/g, '').slice(0, 100);
    _credentials.set(safeId, {
      username: credentials.username || '',
      password: credentials.password || '',
      cookie: credentials.cookie || '',
      updatedAt: new Date().toISOString(),
    });
    console.log(`[token-scanner] 已设置 ${safeId} 的登录凭据`);
  }

  /**
   * 清除指定 deployment 的凭据
   * @param {string} deploymentId
   */
  function clearCredentials(deploymentId) {
    _credentials.delete(deploymentId);
    console.log(`[token-scanner] 已清除 ${deploymentId} 的登录凭据`);
  }

  /**
   * 获取指定 deployment 的凭据（内部使用）
   */
  function getCredentials(deploymentId) {
    return _credentials.get(deploymentId) || null;
  }

  return {
    start,
    stop,
    scan,
    getStatus,
    getCachedData,
    setCredentials,
    getCredentials,
    clearCredentials,
    getRegistry: () => registry,
  };
}

module.exports = { createTokenScanner };
