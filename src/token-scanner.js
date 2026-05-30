'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider 模拟数据生成器
// 根据 deployment 的 baseUrl 判断 provider 类型，生成模拟余额数据
// ---------------------------------------------------------------------------
const PROVIDERS = {
  xiaomi: {
    match: (baseUrl) => /xiaomi|mi.*mimo|mimo/i.test(baseUrl || ''),
    generate: (dep) => ({
      balance: 192.5,
      totalQuota: 500,
      usedQuota: 307.5,
      percentage: 61.5,
      source: 'mock',
      raw: {
        provider: 'xiaomi-mimo',
        plan: 'free-tier',
        mock: true,
      },
    }),
  },
  zhipu: {
    match: (baseUrl) => /zhipu|bigmodel|glm/i.test(baseUrl || ''),
    generate: (dep) => ({
      balance: 85.0,
      totalQuota: 100,
      usedQuota: 15.0,
      percentage: 15.0,
      source: 'mock',
      raw: {
        provider: 'zhipu-glm',
        plan: 'standard',
        mock: true,
      },
    }),
  },
};

// 未知 provider 的默认模拟数据
function generateDefaultMock(dep) {
  return {
    balance: null,
    totalQuota: null,
    usedQuota: null,
    percentage: null,
    source: 'mock',
    raw: {
      provider: 'unknown',
      baseUrl: dep.baseUrl,
      mock: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 创建 Token Scanner
// ---------------------------------------------------------------------------
/**
 * @param {object} config - config 模块实例
 * @param {EventEmitter} bus - config.bus 事件总线
 * @returns {{ start, stop, scan, getStatus, setCredentials, getCachedData }}
 */
function createTokenScanner(config, bus) {
  let _timer = null;
  let _lastResult = null; // 内存缓存
  const _credentials = new Map(); // deploymentId -> { username, password, cookie }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 识别 deployment 的 provider 类型，获取模拟数据
   */
  function fetchBalance(dep) {
    for (const [, provider] of Object.entries(PROVIDERS)) {
      if (provider.match(dep.baseUrl)) {
        return provider.generate(dep);
      }
    }
    return generateDefaultMock(dep);
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
    const deployments = config.getDeployments();
    const cfg = config.getConfig();
    const alertThreshold = cfg.budget?.alertThreshold ?? 0.8;

    const now = new Date().toISOString();
    const cache = {
      lastScanAt: now,
      deployments: {},
    };

    for (const dep of deployments) {
      try {
        const balanceData = fetchBalance(dep);
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
        cache.deployments[dep.id] = {
          balance: null,
          totalQuota: null,
          usedQuota: null,
          percentage: null,
          source: 'error',
          lastUpdated: now,
          raw: { error: err.message },
        };
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
   * 启动定时扫描
   */
  function start() {
    stop(); // 先清理已有的定时器

    const cfg = config.getConfig();
    const scannerConfig = cfg.tokenScanner || {};
    if (scannerConfig.enabled === false) {
      console.log('[token-scanner] 定时扫描已禁用');
      return;
    }

    const intervalHours = scannerConfig.intervalHours || 6;
    const intervalMs = intervalHours * 60 * 60 * 1000;

    console.log(`[token-scanner] 定时扫描已启动，间隔 ${intervalHours} 小时`);

    // 启动时立即扫描一次
    doScan().catch((err) => {
      console.error('[token-scanner] 初始扫描失败:', err.message);
    });

    _timer = setInterval(() => {
      doScan().catch((err) => {
        console.error('[token-scanner] 定时扫描失败:', err.message);
      });
    }, intervalMs);

    // 防止定时器阻止进程退出
    if (_timer.unref) {
      _timer.unref();
    }
  }

  /**
   * 停止定时扫描
   */
  function stop() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
      console.log('[token-scanner] 定时扫描已停止');
    }
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
    _credentials.set(deploymentId, {
      username: credentials.username || '',
      password: credentials.password || '',
      cookie: credentials.cookie || '',
      updatedAt: new Date().toISOString(),
    });
    console.log(`[token-scanner] 已设置 ${deploymentId} 的登录凭据`);
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
  };
}

module.exports = { createTokenScanner };
