'use strict';

const express = require('express');
const path = require('path');

const config = require('./config');
const { createHealthChecker } = require('./health-checker');
const { createRouterEngine } = require('./router-engine');
const { createProxy } = require('./proxy');
const { createAdmin } = require('./admin');

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
// 创建 admin（REST API + SSE）
// ---------------------------------------------------------------------------
const { router: adminRouter, sseHandler } = createAdmin(config, healthChecker, routerEngine);

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

module.exports = app;
