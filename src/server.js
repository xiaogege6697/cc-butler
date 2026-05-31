'use strict';

const express = require('express');
const path = require('path');

const config = require('./config');
const { createHealthChecker } = require('./health-checker');
const { createRouterEngine } = require('./router-engine');
const { createProxy } = require('./proxy');
const { createAdmin } = require('./admin');
const { createTokenScanner } = require('./token-scanner');
const { createSkillStore } = require('./skill-store');
const { createSkillHunter } = require('./skill-hunter');
const { createSkillEvaluator } = require('./skill-evaluator');

// ---------------------------------------------------------------------------
// 全局错误处理
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('[cc-butler] 未捕获异常:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[cc-butler] 未处理的 Promise 拒绝:', reason);
});

// ---------------------------------------------------------------------------
// 初始化配置
// ---------------------------------------------------------------------------
config.load();

const deployments = config.getDeployments();
const healthChecker = createHealthChecker(deployments, config.bus);
const routerEngine = createRouterEngine(config, healthChecker);

// ---------------------------------------------------------------------------
// 创建代理路由（raw body 处理 + 路由转发）
// ---------------------------------------------------------------------------
const proxyRouter = createProxy(config, routerEngine, healthChecker);

// ---------------------------------------------------------------------------
// Phase 2/3 模块初始化
// ---------------------------------------------------------------------------

// Token Scanner — 定时扫描各 deployment 的 token 余额
const tokenScanner = createTokenScanner(config, config.bus);
if (config.getConfig().tokenScanner?.enabled) {
  tokenScanner.start();
}

// Skill Store — 管理 skill 索引和缓存
const skillStore = createSkillStore(config.bus);
skillStore.load();

// Skill Hunter — 从 GitHub 等源搜集 skill 信息
const skillHunter = createSkillHunter(skillStore, config.getConfig(), config.bus);
if (config.getConfig().skillHunter?.autoHunt) {
  skillHunter.startAutoHunt();
}

// Skill Evaluator — 评估、进化、安装 skill
const skillEvaluator = createSkillEvaluator(skillStore, config.bus);

// ---------------------------------------------------------------------------
// 创建 admin（REST API + SSE）
// ---------------------------------------------------------------------------
const { router: adminRouter, sseHandler } = createAdmin(
  config, healthChecker, routerEngine,
  tokenScanner, skillStore, skillHunter, skillEvaluator
);

// ---------------------------------------------------------------------------
// Express 应用组装
// ---------------------------------------------------------------------------
const app = express();

// /v1/* → 代理转发（raw body，必须在 JSON parser 之前）
app.use('/v1', proxyRouter);

// /events → SSE 实时推送
app.get('/events', sseHandler);

// /admin/* → 管理 API（JSON body）
app.use('/admin', express.json(), adminRouter);

// 静态文件
app.use(express.static(path.join(__dirname, 'web')));

// ---------------------------------------------------------------------------
// 启动服务
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8118;
app.listen(PORT, () => {
  console.log(`[cc-butler] 服务已启动 → http://localhost:${PORT}`);
  console.log(`[cc-butler] 代理地址 → http://localhost:${PORT}/v1`);
  console.log(`[cc-butler] 管理面板 → http://localhost:${PORT}/admin`);
});

// ---------------------------------------------------------------------------
// 优雅关闭
// ---------------------------------------------------------------------------
function gracefulShutdown(signal) {
  console.log(`[cc-butler] 收到 ${signal}，正在关闭...`);
  tokenScanner.stop();
  skillHunter.stopAutoHunt();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = app;
