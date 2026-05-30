'use strict';

const { createRegistry } = require('./registry');
const { createDeepSeekAdapter } = require('./builtin-deepseek');
const { createZhipuAdapter } = require('./builtin-zhipu');
const { createKimiAdapter } = require('./builtin-kimi');
const { createSiliconFlowAdapter } = require('./builtin-siliconflow');
const { createOpenRouterAdapter } = require('./builtin-openrouter');
const { createXiaomiAdapter } = require('./builtin-xiaomi');
const { createMiniMaxAdapter } = require('./builtin-minimax');
const { createGacCodeAdapter } = require('./builtin-gaccode');

/**
 * 创建并初始化完整的 registry
 * @param {Array<object>} [customAdapters] - 自定义 adapter 配置数组
 * @returns {object} 初始化后的 registry
 */
function createInitializedRegistry(customAdapters = []) {
  const registry = createRegistry();

  // 注册内建 adapters
  registry.register(createDeepSeekAdapter());
  registry.register(createZhipuAdapter());
  registry.register(createKimiAdapter());
  registry.register(createSiliconFlowAdapter());
  registry.register(createOpenRouterAdapter());
  registry.register(createXiaomiAdapter());
  registry.register(createMiniMaxAdapter());
  registry.register(createGacCodeAdapter());

  // 加载自定义 adapters
  if (customAdapters.length > 0) {
    registry.loadCustomAdapters(customAdapters);
  }

  return registry;
}

module.exports = {
  createRegistry,
  createInitializedRegistry,
  createDeepSeekAdapter,
  createZhipuAdapter,
  createKimiAdapter,
  createSiliconFlowAdapter,
  createOpenRouterAdapter,
  createXiaomiAdapter,
  createMiniMaxAdapter,
  createGacCodeAdapter,
};
