'use strict';

/**
 * 智能路由引擎 — priority-weighted 算法
 * 按 order 升序取最小组，组内按 weight 加权随机
 */

/**
 * 加权随机选择
 * @param {Array} items - 带 weight 属性的对象数组
 * @returns {Object|null}
 */
function weightedRandom(items) {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];

  const totalWeight = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  if (totalWeight <= 0) return items[0];

  let rand = Math.random() * totalWeight;
  for (const item of items) {
    rand -= (item.weight ?? 1);
    if (rand <= 0) return item;
  }

  // 浮点精度兜底
  return items[items.length - 1];
}

/**
 * 创建路由引擎
 * @param {Object} configModule - 配置模块，需提供 getConfig() 方法
 * @param {Object} healthChecker - 健康检查器，需提供 isAvailable() / reportFailure() / reportSuccess()
 * @returns {{ selectDeployment, routeRequest }}
 */
function createRouterEngine(configModule, healthChecker) {
  /**
   * 解析模型别名，获取标准模型名
   * @param {string} model - 请求中的模型名
   * @param {Object} config - 当前配置
   * @returns {string} 标准模型名
   */
  function resolveModel(model, config) {
    if (!model) return model;
    return config.modelAliases?.[model] ?? model;
  }

  /**
   * 选择一个 deployment（核心路由算法）
   * @param {string} model - 请求的模型名
   * @param {Set} excludeSet - 需要排除的 deployment ID 集合
   * @returns {Object|null} 选中的 deployment 配置
   */
  function selectDeployment(model, excludeSet = new Set()) {
    const config = configModule.getConfig();
    const resolvedModel = resolveModel(model, config);

    // 1. 获取所有 enabled 的 deployment
    const enabled = (config.deployments || []).filter(d => d.enabled);

    // 2. 过滤掉冷却中的
    const available = enabled.filter(d => healthChecker.isAvailable(d.id));

    // 3. 过滤掉排除集合中的
    const candidates = available.filter(d => !excludeSet.has(d.id));

    if (candidates.length === 0) return null;

    // 4. 按 order 升序排序，取最小 order 组
    candidates.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const minOrder = candidates[0].order ?? 999;
    const topGroup = candidates.filter(d => (d.order ?? 999) === minOrder);

    // 5. 同组内按 weight 加权随机
    return weightedRandom(topGroup);
  }

  /**
   * 路由请求（含重试逻辑）
   * @param {Object} req - Express request
   * @param {Object} res - Express response
   */
  async function routeRequest(req, res) {
    const config = configModule.getConfig();
    const maxRetries = config.router?.numRetries ?? 2;
    const timeout = config.router?.timeout ?? 300000;

    const excludeSet = new Set();
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const deployment = selectDeployment(req.body?.model, excludeSet);

      if (!deployment) {
        // 没有可用 deployment 了
        if (!res.headersSent) {
          res.status(503).json({
            error: {
              type: 'no_available_deployment',
              message: lastError ? `所有 deployment 均失败，最近错误: ${lastError}` : '没有可用的 deployment',
            },
          });
        }
        return;
      }

      excludeSet.add(deployment.id);

      try {
        // 构建上游请求
        const upstreamUrl = buildUpstreamUrl(deployment, req);
        const upstreamHeaders = buildUpstreamHeaders(deployment, req);
        const body = JSON.stringify(req.body);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const upstreamRes = await fetch(upstreamUrl, {
          method: req.method,
          headers: upstreamHeaders,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text().catch(() => '');
          throw new Error(`上游返回 ${upstreamRes.status}: ${errText.slice(0, 200)}`);
        }

        // 成功：报告健康并转发响应
        healthChecker.reportSuccess(deployment.id);
        await forwardResponse(upstreamRes, res);
        return;

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        healthChecker.reportFailure(deployment.id, lastError);
        // 继续下一次重试
      }
    }

    // 全部重试失败
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          type: 'all_retries_exhausted',
          message: `重试 ${maxRetries} 次后仍失败: ${lastError}`,
        },
      });
    }
  }

  /**
   * 构建上游 URL
   */
  function buildUpstreamUrl(deployment, req) {
    const base = deployment.baseUrl.replace(/\/+$/, '');
    return `${base}${req.originalUrl || req.url}`;
  }

  /**
   * 构建上游请求头，替换 Authorization
   */
  function buildUpstreamHeaders(deployment, req) {
    const headers = { ...req.headers };
    // 替换为上游 API key
    headers['authorization'] = `Bearer ${resolveApiKey(deployment.apiKey)}`;
    // 移除 host 头，避免上游拒绝
    delete headers['host'];
    delete headers['connection'];
    return headers;
  }

  /**
   * 解析 API key（支持 env: 前缀读取环境变量）
   */
  function resolveApiKey(apiKey) {
    if (!apiKey) return '';
    if (apiKey.startsWith('env:')) {
      return process.env[apiKey.slice(4)] || '';
    }
    return apiKey;
  }

  /**
   * 转发上游响应给客户端
   */
  async function forwardResponse(upstreamRes, res) {
    // 转发状态码
    res.status(upstreamRes.status);

    // 转发响应头
    for (const [key, value] of upstreamRes.headers) {
      // 跳过不应转发的头
      if (['transfer-encoding', 'connection'].includes(key)) continue;
      res.setHeader(key, value);
    }

    // 流式转发
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    res.end();
  }

  return { selectDeployment, routeRequest };
}

module.exports = { createRouterEngine };
