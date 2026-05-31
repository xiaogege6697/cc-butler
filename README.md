# cc-butler（cc-管家）

> 🏠 Claude Code 智能管家 — 智能路由 + Token 监控 + Skill 库

轻量级 Node.js 代理，替代 Python litellm + PostgreSQL。单进程、零外部数据库、暖白磨砂卡通风 Dashboard。

<!-- TODO: 添加 Dashboard 截图 -->
<!-- ![Dashboard](docs/screenshot-dashboard.png) -->

## ✨ 特性

### 🔀 智能路由
- 优先级路由（order 1/2/3）+ 同级加权随机
- 被动健康检查 + 冷却降级（连续失败自动切换）
- 失败自动重试（excludeSet 排除已试过的后端）
- SSE 流式双写 + 背压处理 + Token 提取

### 📊 Token 监控
- 定期抓取 provider 余额（小米 MiMo / 智谱 GLM）
- Dashboard 彩色进度条实时展示
- 预算阈值提醒

### 🔮 Skill 库
- 自动/手动搜集 GitHub 最新 Claude Code skill
- 9 维度评估（参考 darwin-skill）
- 棘轮机制进化（通过本地代理调用 Claude）
- 一键安装到 `~/.claude/skills/`

### 🎨 Dashboard
- 暖白磨砂卡通风设计（四主题：明亮/暗色/漫画/线条小狗）
- 路由双区拖拽排序（活跃区 + 暂存区）
- Token 消耗进度条整合到路由卡片
- 请求详情 Modal（概览/请求体/响应体/Headers + JSON 高亮）
- SSE 实时事件推送

## 🚀 快速开始

### 前置条件

- Node.js >= 20.0.0（需要原生 fetch + ReadableStream）
- npm 或 yarn

```bash
# 克隆
git clone https://github.com/xiaogege6697/cc-butler.git
cd cc-butler

# 安装（仅 express 一个依赖）
npm install

# 创建配置文件（从模板复制）
cp config.json.example data/config.json
# 编辑 data/config.json，填入你的 API key

# 启动
npm start

# 或开发模式（自动重启）
npm run dev
```

打开 http://localhost:8118 查看 Dashboard。

## ⚙️ 配置 Claude Code

```bash
# 在 ~/.zshenv 中添加
export ANTHROPIC_BASE_URL="http://127.0.0.1:8118"
export ANTHROPIC_API_KEY="placeholder"
export ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.1"
export ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.1"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-5.1"
```

## 📁 项目结构

```
src/
├── server.js           # Express 入口
├── config.js           # 部署配置持久化
├── router-engine.js    # 智能路由引擎
├── health-checker.js   # 健康检查 + 冷却
├── proxy.js            # 代理转发 + SSE 双写
├── capture.js          # 环形缓冲区 + EventBus
├── admin.js            # REST API + SSE
├── token-scanner.js    # Provider 余额抓取（per-deployment 独立间隔）
├── skill-hunter.js     # Skill 搜集引擎
├── skill-evaluator.js  # Skill 评估门面
├── skill-scorer.js     # Skill 9 维评分
├── skill-evolver.js    # Skill 进化（本地代理调用 Claude）
├── skill-installer.js  # Skill 安装到 ~/.claude/skills/
├── skill-store.js      # Skill JSON 持久化
└── web/                # Dashboard UI
    ├── index.html
    ├── styles.css
    └── app.js
```

## 🔧 API

| 方法 | 路径 | 说明 |
|------|------|------|
| ALL | `/v1/*` | 代理转发到上游 |
| GET | `/admin/deployments` | 部署列表 |
| PATCH | `/admin/deployments/:id/toggle` | 开关部署 |
| GET | `/admin/requests` | 请求历史 |
| GET | `/admin/token/status` | Token 余额 |
| POST | `/admin/token/scan` | 手动扫描余额 |
| GET | `/admin/skills` | Skill 列表 |
| POST | `/admin/skills/hunt` | 手动搜集 skill |
| POST | `/admin/skills/:id/evaluate` | 评估 skill |
| POST | `/admin/skills/:id/evolve` | 进化 skill |
| POST | `/admin/skills/:id/install` | 安装 skill |
| GET | `/events` | SSE 实时事件流 |

## 🛠 技术栈

- **Node.js 20+**（原生 fetch + ReadableStream）
- **express** — 唯一运行时依赖
- **零前端构建** — 纯 vanilla HTML/CSS/JS
- **零外部数据库** — 全部 JSON 文件持久化

## 🐳 Docker 部署

```bash
docker-compose up -d
```

data/ 目录会挂载为 volume，配置和缓存数据持久化。

## 🖥️ macOS 服务

```bash
# 注册为 LaunchAgent（开机自启）
npm run enable:mac-service

# 卸载
npm run disable:mac-service
```

## ❓ Troubleshooting

**Q: 启动报错 `EADDRINUSE`**
A: 端口 8118 被占用，用 `PORT=8119 npm start` 换端口，或 `lsof -i :8118` 查看占用进程。

**Q: Token 余额显示 `no-adapter`**
A: 确认 deployment 的 baseUrl 格式正确，且已安装对应 provider 的 adapter。

**Q: Skill 进化失败**
A: 确认 cc-butler 正在运行（进化通过 localhost:8118 调用），检查日志中的错误信息。

## 📄 License

[MIT](LICENSE)
