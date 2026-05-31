# Changelog

本文件记录 cc-butler 的所有重要变更。

## [Unreleased]

### 变更
- Skill-evolver 改走本地代理（localhost:8118），移除 CLI spawn 依赖
- Token-scanner 按 deployment 独立扫描间隔（默认 10 分钟，scanIntervalMinutes 字段）
- Token-scanner 只扫描活跃区（enabled=true），暂存区不扫

## [0.1.0] - 2025-05-31

### 新增
- Phase 1: 智能路由（优先级+权重）+ 漫画风 Dashboard
- Phase 2/3: Token Scanner + Skill 库 + Dashboard 漫画风优化
- Phase 4: Token Scanner Provider Adapter + macOS LaunchAgent
- Phase 5: Skill 三角色分离（scorer/evolver/installer）+ Dashboard Skill 库 UI
- Phase 6+7: 请求详情 Modal + 暖白磨砂视觉重设计 + 四主题切换 + 路由双区拖拽 + 新增路由
- 可拖动部署卡片
- 顶栏手动刷新按钮
- Token 消耗整合到路由卡片
- 路由卡片两列网格布局
