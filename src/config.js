const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = process.env.CC_BUTLER_ROOT
  ? path.resolve(process.env.CC_BUTLER_ROOT)
  : path.join(PROJECT_ROOT, 'data');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TMP_EXT = '.tmp';

// ---------------------------------------------------------------------------
// 单例状态
// ---------------------------------------------------------------------------
let _config = null;
const bus = new EventEmitter();

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------
function createDefaultConfig() {
  return {
    deployments: [],
    router: {
      strategy: 'priority-weighted',
      numRetries: 2,
      timeout: 300000,
    },
    modelAliases: {},
    budget: {
      dailyTokenLimit: null,
      alertThreshold: 0.8,
    },
    tokenScanner: {
      intervalHours: 6,
      enabled: true,
    },
    skillHunter: {
      autoHunt: true,
      intervalHours: 24,
      sources: ['github'],
      keywords: ['claude-code skill', 'claude-code mcp', 'claude skill', 'SKILL.md'],
    },
    activeDeploymentId: null,
  };
}

// ---------------------------------------------------------------------------
// 原子写入：先写 .tmp 再 fs.rename
// ---------------------------------------------------------------------------
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = filePath + TMP_EXT + '.' + crypto.randomBytes(4).toString('hex');

  // 确保 data 目录存在
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// 读取配置文件
// ---------------------------------------------------------------------------
function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return createDefaultConfig();
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 保存当前内存中的配置到磁盘
// ---------------------------------------------------------------------------
function save() {
  atomicWrite(CONFIG_PATH, _config);
}

// ---------------------------------------------------------------------------
// 生成唯一 ID（短 UUID）
// ---------------------------------------------------------------------------
function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// resolveApiKey: 支持 env:XXX 格式，从 process.env 解析
// ---------------------------------------------------------------------------
function resolveApiKey(key) {
  if (!key) return key;
  if (key.startsWith('env:')) {
    const envName = key.slice(4);
    return process.env[envName] || '';
  }
  return key;
}

// ---------------------------------------------------------------------------
// resolveModelAlias: 通过 modelAliases 表将模型名规范化
// ---------------------------------------------------------------------------
function resolveModelAlias(model) {
  if (!model || !_config) return model;
  const aliases = _config.modelAliases || {};
  return aliases[model] || model;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 从磁盘加载配置，初始化内存状态。首次调用时自动执行。
 * 返回加载后的完整配置对象。
 */
function load() {
  _config = readConfigFile();
  bus.emit('loaded', _config);
  return _config;
}

/**
 * 获取所有 deployment 列表
 */
function getDeployments() {
  if (!_config) load();
  return _config.deployments || [];
}

/**
 * 按 ID 获取单个 deployment
 */
function getDeployment(id) {
  return getDeployments().find((d) => d.id === id) || null;
}

/**
 * 新增 deployment，自动生成 id（如果未提供）。
 * 触发 deployment:added 事件。
 */
function addDeployment(d) {
  if (!_config) load();
  const deployment = {
    id: d.id || generateId(),
    name: d.name || '',
    baseUrl: d.baseUrl || '',
    apiKey: d.apiKey || '',
    model: d.model || '',
    order: d.order ?? (_config.deployments.length + 1),
    weight: d.weight ?? 50,
    enabled: d.enabled ?? true,
    healthCheck: d.healthCheck || { allowedFails: 3, cooldownTime: 60 },
  };
  _config.deployments.push(deployment);
  save();
  bus.emit('deployment:added', deployment);
  return deployment;
}

/**
 * 更新指定 ID 的 deployment，合并字段。
 * 触发 deployment:updated 事件。
 */
function updateDeployment(id, patch) {
  if (!_config) load();
  const idx = _config.deployments.findIndex((d) => d.id === id);
  if (idx === -1) return null;

  // 不允许通过 patch 修改 id
  const { id: _ignored, ...safePatch } = patch;
  const before = { ..._config.deployments[idx] };
  Object.assign(_config.deployments[idx], safePatch);
  save();
  bus.emit('deployment:updated', { id, before, after: _config.deployments[idx] });
  return _config.deployments[idx];
}

/**
 * 删除指定 ID 的 deployment。
 * 触发 deployment:deleted 事件。
 * 如果删除的是当前激活的 deployment，自动清空 activeDeploymentId。
 */
function deleteDeployment(id) {
  if (!_config) load();
  const idx = _config.deployments.findIndex((d) => d.id === id);
  if (idx === -1) return false;

  const [removed] = _config.deployments.splice(idx, 1);
  // 如果删除的是激活项，清空激活
  if (_config.activeDeploymentId === id) {
    _config.activeDeploymentId = null;
  }
  save();
  bus.emit('deployment:deleted', removed);
  return true;
}

/**
 * 切换 deployment 的 enabled 状态。
 * 触发 deployment:toggled 事件。
 */
function toggleDeployment(id) {
  if (!_config) load();
  const d = _config.deployments.find((d) => d.id === id);
  if (!d) return null;

  d.enabled = !d.enabled;
  save();
  bus.emit('deployment:toggled', { id, enabled: d.enabled });
  return d;
}

/**
 * 获取当前激活的 deployment ID
 */
function getActiveDeploymentId() {
  if (!_config) load();
  return _config.activeDeploymentId || null;
}

/**
 * 设置当前激活的 deployment ID。
 * 触发 active:changed 事件。
 */
function setActiveDeploymentId(id) {
  if (!_config) load();

  // 允许 null（清空激活），但如果是具体 ID 需要验证存在
  if (id !== null) {
    const exists = _config.deployments.some((d) => d.id === id);
    if (!exists) return false;
  }

  const prev = _config.activeDeploymentId;
  _config.activeDeploymentId = id;
  save();
  bus.emit('active:changed', { from: prev, to: id });
  return true;
}

/**
 * 获取完整配置对象（内部引用）
 */
function getConfig() {
  if (!_config) load();
  return _config;
}

/**
 * 获取路由配置
 */
function getRouterConfig() {
  if (!_config) load();
  return _config.router || {};
}

/**
 * 获取模型别名映射表
 */
function getModelAliases() {
  if (!_config) load();
  return _config.modelAliases || {};
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
module.exports = {
  // 事件总线
  bus,

  // 配置文件路径（便于外部调试）
  CONFIG_PATH,

  // 核心 API
  load,
  save,
  getDeployments,
  getDeployment,
  addDeployment,
  updateDeployment,
  deleteDeployment,
  toggleDeployment,
  getActiveDeploymentId,
  setActiveDeploymentId,
  resolveApiKey,
  getConfig,
  getRouterConfig,
  getModelAliases,
};
