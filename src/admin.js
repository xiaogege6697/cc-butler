'use strict';

const express = require('express');
const { bus: captureBus, getRecords, getRecord, clearRecords } = require('./capture');

// ---------------------------------------------------------------------------
// apiKey 脱敏
// ---------------------------------------------------------------------------
function maskKey(key) {
  if (!key || typeof key !== 'string') return key;
  // env: 格式不脱敏，直接返回
  if (key.startsWith('env:')) return key;
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// ---------------------------------------------------------------------------
// 创建 admin 模块
// ---------------------------------------------------------------------------
function createAdmin(config, healthChecker, routerEngine, tokenScanner, skillStore, skillHunter, skillEvaluator) {
  const router = express.Router();

  // =========================================================================
  // REST API — Deployments
  // =========================================================================

  // 列出所有 deployment（apiKey 脱敏）+ 健康状态
  router.get('/deployments', (_req, res) => {
    try {
      const deployments = config.getDeployments();
      const healthStatus = healthChecker.getStatus();
      const activeId = config.getActiveDeploymentId();

      const list = deployments.map((d) => ({
        ...d,
        apiKey: maskKey(d.apiKey),
        health: healthStatus[d.id] || null,
        isActive: d.id === activeId,
      }));

      res.json({ deployments: list });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 单个 deployment（含完整 apiKey）
  router.get('/deployments/:id', (req, res) => {
    try {
      const d = config.getDeployment(req.params.id);
      if (!d) {
        return res.status(404).json({ error: { message: 'Deployment 不存在' } });
      }
      const healthStatus = healthChecker.getStatus();
      const activeId = config.getActiveDeploymentId();
      res.json({
        ...d,
        // 单个详情不脱敏
        health: healthStatus[d.id] || null,
        isActive: d.id === activeId,
      });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 新增 deployment
  router.post('/deployments', (req, res) => {
    try {
      const d = config.addDeployment(req.body);
      res.status(201).json(d);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 更新 deployment
  router.put('/deployments/:id', (req, res) => {
    try {
      const d = config.updateDeployment(req.params.id, req.body);
      if (!d) {
        return res.status(404).json({ error: { message: 'Deployment 不存在' } });
      }
      res.json(d);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 删除 deployment
  router.delete('/deployments/:id', (req, res) => {
    try {
      const ok = config.deleteDeployment(req.params.id);
      if (!ok) {
        return res.status(404).json({ error: { message: 'Deployment 不存在' } });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 切换 enabled 状态
  router.patch('/deployments/:id/toggle', (req, res) => {
    try {
      const d = config.toggleDeployment(req.params.id);
      if (!d) {
        return res.status(404).json({ error: { message: 'Deployment 不存在' } });
      }
      res.json({ id: d.id, enabled: d.enabled });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // =========================================================================
  // REST API — Router
  // =========================================================================

  // 路由引擎状态 + 健康概览
  router.get('/router/status', (_req, res) => {
    try {
      const deployments = config.getDeployments();
      const healthStatus = healthChecker.getStatus();
      const routerConfig = config.getRouterConfig();
      const activeId = config.getActiveDeploymentId();

      const summary = deployments.map((d) => ({
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        healthy: healthStatus[d.id]?.isHealthy ?? true,
        isActive: d.id === activeId,
      }));

      res.json({
        router: routerConfig,
        activeDeploymentId: activeId,
        health: healthStatus,
        deployments: summary,
      });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // =========================================================================
  // REST API — Requests（请求历史）
  // =========================================================================

  // 请求历史列表
  router.get('/requests', (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
      const records = getRecords(limit);
      res.json({ requests: records });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 单条请求详情
  router.get('/requests/:id', (req, res) => {
    try {
      const record = getRecord(parseInt(req.params.id, 10));
      if (!record) {
        return res.status(404).json({ error: { message: '请求记录不存在' } });
      }
      res.json(record);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 清空请求历史
  router.delete('/requests', (_req, res) => {
    try {
      clearRecords();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // =========================================================================
  // REST API — Config
  // =========================================================================

  // 获取完整配置
  router.get('/config', (_req, res) => {
    try {
      // 直接返回内存中的配置，不脱敏（管理接口）
      res.json(config.load());
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 更新路由/预算配置
  router.put('/config', (req, res) => {
    try {
      const { router: routerCfg, budget, modelAliases, tokenScanner, skillHunter } = req.body;

      const current = config.getConfig();

      if (routerCfg !== undefined) current.router = routerCfg;
      if (budget !== undefined) current.budget = budget;
      if (modelAliases !== undefined) current.modelAliases = modelAliases;
      if (tokenScanner !== undefined) current.tokenScanner = tokenScanner;
      if (skillHunter !== undefined) current.skillHunter = skillHunter;

      // 保存到磁盘
      config.save();

      config.bus.emit('config.updated', current);

      res.json({ success: true, config: current });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // =========================================================================
  // REST API — Token Scanner
  // =========================================================================

  // 获取 token 余额缓存
  router.get('/token/status', (_req, res) => {
    try {
      const data = tokenScanner.getCachedData();
      res.json(data || { lastScanAt: null, deployments: {} });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 手动触发 token 扫描
  router.post('/token/scan', async (_req, res) => {
    try {
      const result = await tokenScanner.scan();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 存储 cookie credentials（用于 token-scanner 需要 cookie 认证的场景）
  router.post('/token/credentials', (req, res) => {
    const { deploymentId, credentials } = req.body;
    if (!deploymentId || !credentials) {
      return res.status(400).json({ error: 'deploymentId and credentials required' });
    }
    // 验证 deploymentId 是否对应真实 deployment
    const deployments = config.getDeployments();
    const validIds = new Set(deployments.map(d => d.id));
    if (!validIds.has(deploymentId)) {
      return res.status(400).json({ error: `Unknown deployment: ${deploymentId}` });
    }
    // 验证 credentials 结构
    if (typeof credentials !== 'object' || (!credentials.cookie && !credentials.username)) {
      return res.status(400).json({ error: 'credentials must contain cookie or username' });
    }
    if (typeof tokenScanner.setCredentials !== 'function') {
      return res.status(501).json({ error: 'setCredentials not supported by current tokenScanner' });
    }
    try {
      tokenScanner.setCredentials(deploymentId, credentials);
      res.json({ ok: true, deploymentId });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // =========================================================================
  // REST API — Skills
  // =========================================================================

  // 获取所有 skill 列表
  router.get('/skills', (req, res) => {
    try {
      const { status, category, q } = req.query;
      let skills;

      if (q) {
        skills = skillStore.search(q);
      } else if (status) {
        skills = skillStore.getByStatus(status);
      } else if (category) {
        skills = skillStore.getByCategory(category);
      } else {
        skills = skillStore.getAll();
      }

      res.json({ skills });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // Skill 统计信息
  router.get('/skills/stats', (_req, res) => {
    try {
      const stats = skillStore.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 单个 skill 详情
  router.get('/skills/:id', (req, res) => {
    try {
      const skill = skillStore.getById(req.params.id);
      if (!skill) {
        return res.status(404).json({ error: { message: 'Skill 不存在' } });
      }

      // 尝试加载详情内容
      const content = skillStore.getContent(req.params.id);

      // 尝试加载评估历史
      const history = skillEvaluator.getHistory(req.params.id);

      res.json({ ...skill, content: content || null, evaluationHistory: history });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 手动触发 skill 搜集
  router.post('/skills/hunt', async (_req, res) => {
    try {
      const result = await skillHunter.hunt();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 触发单个 skill 评估
  router.post('/skills/:id/evaluate', async (req, res) => {
    try {
      const result = await skillEvaluator.evaluate(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 安装 skill
  router.post('/skills/:id/install', (req, res) => {
    try {
      const result = skillEvaluator.install(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 触发 skill 进化（需要 body.skillIds 数组）
  router.post('/skills/:id/evolve', async (req, res) => {
    try {
      const { skillIds } = req.body;
      // 如果没有提供 skillIds，用当前 skill 作为种子，需要至少再加一个
      const ids = Array.isArray(skillIds) && skillIds.length >= 2
        ? skillIds
        : null;

      if (!ids) {
        return res.status(400).json({
          error: { message: '进化需要至少 2 个 skill，请通过 body.skillIds 传入' },
        });
      }

      const result = await skillEvaluator.evolve(ids);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // 删除 skill
  router.delete('/skills/:id', (req, res) => {
    try {
      const ok = skillStore.remove(req.params.id);
      if (!ok) {
        return res.status(404).json({ error: { message: 'Skill 不存在' } });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // =========================================================================
  // SSE Handler
  // =========================================================================
  function sseHandler(req, res) {
    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 立即发送一个连接成功事件
    res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

    // 30 秒心跳
    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 30000);

    // SSE 发送辅助函数
    function sendEvent(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // ---- 订阅 capture.js 的 bus 事件 ----
    const onRequestStart = (record) => sendEvent('request.start', record);
    const onRequestEnd = (record) => sendEvent('request.end', record);
    const onRecordsCleared = () => sendEvent('records.cleared', { timestamp: Date.now() });

    captureBus.on('request.start', onRequestStart);
    captureBus.on('request.end', onRequestEnd);
    captureBus.on('records.cleared', onRecordsCleared);

    // ---- 订阅 config.js 的 bus 事件 ----
    const onDeploymentsUpdated = (data) => sendEvent('deployments.updated', data);
    const onDeploymentChanged = (data) => sendEvent('deployment.changed', data);

    config.bus.on('deployment:added', onDeploymentChanged);
    config.bus.on('deployment:updated', onDeploymentChanged);
    config.bus.on('deployment:deleted', onDeploymentChanged);
    config.bus.on('deployment:toggled', onDeploymentChanged);
    config.bus.on('active:changed', onDeploymentsUpdated);

    // ---- 订阅 health-checker 事件（通过 config.bus） ----
    const onCooldown = (data) => sendEvent('deployment.cooldown', data);
    const onRecovered = (data) => sendEvent('deployment.recovered', data);

    // health-checker 的 bus 就是 config.bus（创建时传入的）
    config.bus.on('deployment.cooldown', onCooldown);
    config.bus.on('deployment.recovered', onRecovered);

    // ---- Token Scanner 事件 ----
    const onTokenUpdated = (data) => sendEvent('token.updated', data);
    const onTokenAlert = (data) => sendEvent('token.alert', data);

    config.bus.on('token.updated', onTokenUpdated);
    config.bus.on('token.alert', onTokenAlert);

    // ---- Skill Hunter / Evaluator 事件 ----
    const onSkillsHunted = (data) => sendEvent('skills.hunted', data);
    const onSkillEvaluated = (data) => sendEvent('skill.evaluated', data);
    const onSkillEvolved = (data) => sendEvent('skill.evolved', data);
    const onSkillInstalled = (data) => sendEvent('skill.installed', data);
    const onSkillDiscovered = (data) => sendEvent('skill.discovered', data);
    const onHuntStart = (data) => sendEvent('hunt.start', data);
    const onHuntProgress = (data) => sendEvent('hunt.progress', data);
    const onHuntComplete = (data) => sendEvent('hunt.complete', data);

    config.bus.on('skills.hunted', onSkillsHunted);
    config.bus.on('skill.evaluated', onSkillEvaluated);
    config.bus.on('skill.evolved', onSkillEvolved);
    config.bus.on('skill.installed', onSkillInstalled);
    config.bus.on('skill.discovered', onSkillDiscovered);
    config.bus.on('hunt.start', onHuntStart);
    config.bus.on('hunt.progress', onHuntProgress);
    config.bus.on('hunt.complete', onHuntComplete);

    // ---- 客户端断开时清理 ----
    req.on('close', () => {
      clearInterval(heartbeat);

      captureBus.off('request.start', onRequestStart);
      captureBus.off('request.end', onRequestEnd);
      captureBus.off('records.cleared', onRecordsCleared);

      config.bus.off('deployment:added', onDeploymentChanged);
      config.bus.off('deployment:updated', onDeploymentChanged);
      config.bus.off('deployment:deleted', onDeploymentChanged);
      config.bus.off('deployment:toggled', onDeploymentChanged);
      config.bus.off('active:changed', onDeploymentsUpdated);
      config.bus.off('deployment.cooldown', onCooldown);
      config.bus.off('deployment.recovered', onRecovered);

      config.bus.off('token.updated', onTokenUpdated);
      config.bus.off('token.alert', onTokenAlert);

      config.bus.off('skills.hunted', onSkillsHunted);
      config.bus.off('skill.evaluated', onSkillEvaluated);
      config.bus.off('skill.evolved', onSkillEvolved);
      config.bus.off('skill.installed', onSkillInstalled);
      config.bus.off('skill.discovered', onSkillDiscovered);
      config.bus.off('hunt.start', onHuntStart);
      config.bus.off('hunt.progress', onHuntProgress);
      config.bus.off('hunt.complete', onHuntComplete);
    });
  }

  return { router, sseHandler };
}

module.exports = { createAdmin };
