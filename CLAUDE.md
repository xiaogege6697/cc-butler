# cc-butler 项目上下文

## 项目定位
单进程、零外部数据库的 Node.js 代理服务器，架在 Claude Code 前面。三大支柱：智能 API 路由、Token 余额监控、Skill 猎手系统。

## 仓库
- GitHub: xiaogege6697/cc-butler
- 默认端口: 8118
- 唯一依赖: express ^4.21.0（Node >= 20.0.0）

## 架构
```
server.js → 入口，模块装配
├── config.js          配置 CRUD + EventEmitter 事件总线
├── router-engine.js   优先级-权重路由算法
├── health-checker.js  被动健康检查
├── proxy.js           HTTP/SSE 转发
├── capture.js         环形缓冲区请求记录
├── admin.js           REST API + SSE 实时推送
├── token-scanner.js   余额扫描（provider adapter 模式）
├── skill-hunter.js    GitHub skill 搜索
├── skill-scorer.js    9 维评分
├── skill-evolver.js   Claude CLI 进化
├── skill-installer.js 安装到 ~/.claude/skills/
├── skill-store.js     Skill JSON 持久化
└── web/               漫画风 Dashboard（vanilla HTML/CSS/JS）
```

## Provider Adapter 系统
src/providers/ 下，每个平台一个 adapter：
- 内置 8 个：deepseek、zhipu、kimi、siliconflow、openrouter、xiaomi、minimax、gaccode
- 自定义：config.json 的 tokenScanner.customAdapters 配置
- 接口：{ id, name, match(RegExp), authType, async fetch(dep, config) }

## 已完成 Phase
- Phase 1-3: 智能路由 + Skill 库 + 漫画风 Dashboard
- Phase 4: Token Scanner Provider Adapter + macOS LaunchAgent
- Phase 5: Skill 三角色分离（scorer/evolver/installer）+ Dashboard Skill 库 UI + 拖拽打磨
- Phase 6: Dashboard 请求详情页（Modal + JSON 查看器 + Token 条形图）
- Phase 7: 视觉重设计（暗色漫画风 → 暖白磨砂卡通风 + Token 消耗 + 路由双区拖拽）

## 待办（后续 Phase）
- Skill-evolver 接入真实 Claude API（当前用 CLI spawn）
- Token-scanner 定时扫描间隔按 provider 自定义（不同平台刷新周期不同）
- Gemini adapter（如需要）

## 已砍掉
- ~~DashScope（阿里百炼）adapter~~ — 内部 RPC + cookie，复杂度高，用得少
- ~~Doubao（豆包）adapter~~ — 只能探测 rate-limit headers，收益低

## 关键设计决策
- 文件存储用 JSON + atomic write（.tmp → rename），不用数据库
- 所有模块用工厂函数 + 依赖注入，通过 config.bus EventEmitter 通信
- Skill 进化有棘轮机制：新分数必须 > 旧最高分才保留
- 前端纯 vanilla JS，无框架无构建步骤
- macOS LaunchAgent 用 process.execPath 动态获取 node 路径
- 余额查询优雅降级：API 失败保留上次缓存（stale: true），不覆盖为 error

## Git Commit 记录
```
3e6a6ce Phase 4: Token Scanner Provider Adapter + macOS LaunchAgent
9fd8347 Phase 5: Skill 三角色分离 + Dashboard Skill 库 UI + 拖拽视觉打磨
```
