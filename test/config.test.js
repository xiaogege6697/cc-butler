const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// 辅助函数：清除 require.cache 中 config.js 及其依赖，强制重新加载
// ---------------------------------------------------------------------------
const CONFIG_MODULE_PATH = path.resolve(__dirname, '../src/config.js');

function freshConfig() {
  // 清除 config.js 自身
  delete require.cache[CONFIG_MODULE_PATH];
  // 清除 config.js require 过的所有子模块（crypto/events 等内置模块不受影响）
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.resolve(__dirname, '..'))) {
      delete require.cache[key];
    }
  }
  return require(CONFIG_MODULE_PATH);
}

// ---------------------------------------------------------------------------
// 临时目录管理
// ---------------------------------------------------------------------------
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-butler-config-test-'));
});

after(() => {
  // 清理临时目录
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 每个 test 前：设置 CC_BUTLER_ROOT 环境变量
beforeEach(() => {
  process.env.CC_BUTLER_ROOT = tmpDir;
});

// 每个 test 后：清理环境变量和临时目录中的配置文件
afterEach(() => {
  delete process.env.CC_BUTLER_ROOT;
  const configPath = path.join(tmpDir, 'config.json');
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
  // 清理可能残留的 .tmp 文件
  for (const f of fs.readdirSync(tmpDir)) {
    if (f.endsWith('.tmp')) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  }
});

// ===========================================================================
// 测试
// ===========================================================================

describe('config.js', () => {
  // ---------------------------------------------------------------------------
  // bus 是 EventEmitter 实例
  // ---------------------------------------------------------------------------
  describe('bus', () => {
    it('应该是 EventEmitter 实例', () => {
      const config = freshConfig();
      assert.ok(config.bus instanceof EventEmitter);
    });
  });

  // ---------------------------------------------------------------------------
  // load() — 从磁盘加载配置
  // ---------------------------------------------------------------------------
  describe('load()', () => {
    it('配置文件不存在时返回默认配置', () => {
      const config = freshConfig();
      const result = config.load();

      assert.equal(result.deployments.length, 0);
      assert.equal(result.router.strategy, 'priority-weighted');
      assert.equal(result.router.numRetries, 2);
      assert.equal(result.budget.alertThreshold, 0.8);
      assert.equal(result.activeDeploymentId, null);
    });

    it('配置文件存在时从磁盘加载', () => {
      const mockConfig = {
        deployments: [{ id: 'dep1', name: 'test', baseUrl: 'http://localhost:8080' }],
        router: { strategy: 'round-robin', numRetries: 3, timeout: 60000 },
        modelAliases: { 'gpt-4': 'claude-3' },
        budget: { dailyTokenLimit: 100000, alertThreshold: 0.9 },
        tokenScanner: { intervalHours: 12, enabled: false },
        skillHunter: { autoHunt: false, intervalHours: 48, sources: ['github'], keywords: [] },
        activeDeploymentId: 'dep1',
      };
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify(mockConfig, null, 2),
        'utf8'
      );

      const config = freshConfig();
      const result = config.load();

      assert.equal(result.deployments.length, 1);
      assert.equal(result.deployments[0].name, 'test');
      assert.equal(result.router.strategy, 'round-robin');
      assert.equal(result.modelAliases['gpt-4'], 'claude-3');
      assert.equal(result.activeDeploymentId, 'dep1');
    });

    it('加载后触发 loaded 事件', () => {
      const config = freshConfig();

      let emitted = null;
      config.bus.once('loaded', (cfg) => { emitted = cfg; });

      config.load();

      assert.ok(emitted);
      assert.equal(emitted.router.strategy, 'priority-weighted');
    });

    it('多次 load 会覆盖内存中的配置', () => {
      const config = freshConfig();

      // 第一次 load：默认配置
      const first = config.load();
      assert.equal(first.deployments.length, 0);

      // 写入一个有 deployment 的配置文件
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify({ deployments: [{ id: 'x' }], router: {} }, null, 2),
        'utf8'
      );

      // 第二次 load：覆盖
      const second = config.load();
      assert.equal(second.deployments.length, 1);
      assert.equal(second.deployments[0].id, 'x');
    });
  });

  // ---------------------------------------------------------------------------
  // getConfig() — 返回完整配置对象
  // ---------------------------------------------------------------------------
  describe('getConfig()', () => {
    it('自动触发 load 并返回配置对象', () => {
      const config = freshConfig();
      const result = config.getConfig();

      assert.ok(result);
      assert.equal(typeof result.router, 'object');
      assert.ok(Array.isArray(result.deployments));
    });

    it('返回的是内部引用（修改会影响内部状态）', () => {
      const config = freshConfig();
      const result = config.getConfig();

      result.router.strategy = 'modified';
      const again = config.getConfig();
      assert.equal(again.router.strategy, 'modified');
    });
  });

  // ---------------------------------------------------------------------------
  // getDeployments() — 返回 deployment 数组
  // ---------------------------------------------------------------------------
  describe('getDeployments()', () => {
    it('没有 deployment 时返回空数组', () => {
      const config = freshConfig();
      const deps = config.getDeployments();
      assert.ok(Array.isArray(deps));
      assert.equal(deps.length, 0);
    });

    it('有 deployment 时返回完整列表', () => {
      // 预先写入含 deployment 的配置
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify({
          deployments: [
            { id: 'd1', name: 'alpha', enabled: true },
            { id: 'd2', name: 'beta', enabled: false },
          ],
          router: {},
        }, null, 2),
        'utf8'
      );

      const config = freshConfig();
      const deps = config.getDeployments();

      assert.equal(deps.length, 2);
      assert.equal(deps[0].name, 'alpha');
      assert.equal(deps[1].name, 'beta');
    });
  });

  // ---------------------------------------------------------------------------
  // resolveApiKey() — API Key 解析
  // ---------------------------------------------------------------------------
  describe('resolveApiKey()', () => {
    it('env: 前缀时从环境变量解析', () => {
      const config = freshConfig();
      process.env.TEST_API_KEY = 'sk-12345';

      const result = config.resolveApiKey('env:TEST_API_KEY');
      assert.equal(result, 'sk-12345');

      delete process.env.TEST_API_KEY;
    });

    it('env: 前缀但环境变量不存在时返回空字符串', () => {
      const config = freshConfig();
      // 确保不存在这个变量
      delete process.env.NONEXISTENT_KEY_VAR;

      const result = config.resolveApiKey('env:NONEXISTENT_KEY_VAR');
      assert.equal(result, '');
    });

    it('普通字符串直接返回原值', () => {
      const config = freshConfig();
      assert.equal(config.resolveApiKey('sk-plain-key'), 'sk-plain-key');
    });

    it('空字符串直接返回', () => {
      const config = freshConfig();
      assert.equal(config.resolveApiKey(''), '');
    });

    it('null/undefined 直接返回', () => {
      const config = freshConfig();
      assert.equal(config.resolveApiKey(null), null);
      assert.equal(config.resolveApiKey(undefined), undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // update() — 通过 addDeployment / updateDeployment / save 更新配置并触发事件
  // ---------------------------------------------------------------------------
  describe('addDeployment()', () => {
    it('新增 deployment 并自动生成 id', () => {
      const config = freshConfig();
      config.load();

      const dep = config.addDeployment({ name: 'test-dep', baseUrl: 'http://localhost:3000' });

      assert.ok(dep.id);
      assert.equal(dep.name, 'test-dep');
      assert.equal(dep.baseUrl, 'http://localhost:3000');
      assert.equal(dep.enabled, true); // 默认 enabled
      assert.equal(dep.weight, 50); // 默认 weight
    });

    it('使用传入的 id（如果提供）', () => {
      const config = freshConfig();
      config.load();

      const dep = config.addDeployment({ id: 'custom-id', name: 'custom' });
      assert.equal(dep.id, 'custom-id');
    });

    it('触发 deployment:added 事件', () => {
      const config = freshConfig();
      config.load();

      let emitted = null;
      config.bus.once('deployment:added', (dep) => { emitted = dep; });

      config.addDeployment({ name: 'event-test' });

      assert.ok(emitted);
      assert.equal(emitted.name, 'event-test');
    });

    it('持久化到磁盘', () => {
      const config = freshConfig();
      config.load();

      config.addDeployment({ name: 'persist-test' });

      // 重新加载模块验证持久化
      const config2 = freshConfig();
      const deps = config2.getDeployments();
      assert.equal(deps.length, 1);
      assert.equal(deps[0].name, 'persist-test');
    });
  });

  describe('updateDeployment()', () => {
    it('更新指定 deployment 的字段', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'before' });

      const updated = config.updateDeployment(added.id, { name: 'after', weight: 80 });

      assert.equal(updated.name, 'after');
      assert.equal(updated.weight, 80);
    });

    it('id 不存在时返回 null', () => {
      const config = freshConfig();
      config.load();

      const result = config.updateDeployment('nonexistent', { name: 'x' });
      assert.equal(result, null);
    });

    it('patch 中的 id 字段被忽略（不允许修改 id）', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ id: 'original-id', name: 'test' });

      const updated = config.updateDeployment('original-id', { id: 'hacked', name: 'changed' });

      assert.equal(updated.id, 'original-id');
      assert.equal(updated.name, 'changed');
    });

    it('触发 deployment:updated 事件，携带 before/after', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'before-update' });

      let eventData = null;
      config.bus.once('deployment:updated', (data) => { eventData = data; });

      config.updateDeployment(added.id, { name: 'after-update' });

      assert.ok(eventData);
      assert.equal(eventData.before.name, 'before-update');
      assert.equal(eventData.after.name, 'after-update');
    });
  });

  describe('deleteDeployment()', () => {
    it('删除指定 deployment 并返回 true', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'to-delete' });

      const result = config.deleteDeployment(added.id);

      assert.equal(result, true);
      assert.equal(config.getDeployments().length, 0);
    });

    it('id 不存在时返回 false', () => {
      const config = freshConfig();
      config.load();

      assert.equal(config.deleteDeployment('nonexistent'), false);
    });

    it('删除的是 activeDeployment 时自动清空 activeDeploymentId', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'active-one' });

      config.setActiveDeploymentId(added.id);
      assert.equal(config.getActiveDeploymentId(), added.id);

      config.deleteDeployment(added.id);
      assert.equal(config.getActiveDeploymentId(), null);
    });

    it('触发 deployment:deleted 事件', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'event-del' });

      let emitted = null;
      config.bus.once('deployment:deleted', (dep) => { emitted = dep; });

      config.deleteDeployment(added.id);

      assert.ok(emitted);
      assert.equal(emitted.name, 'event-del');
    });
  });

  describe('toggleDeployment()', () => {
    it('切换 enabled 状态', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'toggle', enabled: true });

      const result = config.toggleDeployment(added.id);

      assert.equal(result.enabled, false);
    });

    it('再次切换恢复原状态', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'toggle', enabled: true });

      config.toggleDeployment(added.id);
      const result = config.toggleDeployment(added.id);

      assert.equal(result.enabled, true);
    });

    it('id 不存在时返回 null', () => {
      const config = freshConfig();
      config.load();

      assert.equal(config.toggleDeployment('nonexistent'), null);
    });

    it('触发 deployment:toggled 事件', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'evt-toggle', enabled: true });

      let eventData = null;
      config.bus.once('deployment:toggled', (data) => { eventData = data; });

      config.toggleDeployment(added.id);

      assert.ok(eventData);
      assert.equal(eventData.id, added.id);
      assert.equal(eventData.enabled, false);
    });
  });

  describe('activeDeploymentId', () => {
    it('setActiveDeploymentId 设置激活项', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'active' });

      const result = config.setActiveDeploymentId(added.id);

      assert.equal(result, true);
      assert.equal(config.getActiveDeploymentId(), added.id);
    });

    it('设置不存在的 id 返回 false', () => {
      const config = freshConfig();
      config.load();

      assert.equal(config.setActiveDeploymentId('nonexistent'), false);
    });

    it('传 null 清空激活项', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'active' });
      config.setActiveDeploymentId(added.id);

      const result = config.setActiveDeploymentId(null);

      assert.equal(result, true);
      assert.equal(config.getActiveDeploymentId(), null);
    });

    it('触发 active:changed 事件', () => {
      const config = freshConfig();
      config.load();
      const added = config.addDeployment({ name: 'evt-active' });

      let eventData = null;
      config.bus.once('active:changed', (data) => { eventData = data; });

      config.setActiveDeploymentId(added.id);

      assert.ok(eventData);
      assert.equal(eventData.from, null);
      assert.equal(eventData.to, added.id);
    });
  });

  // ---------------------------------------------------------------------------
  // save() — 原子写入
  // ---------------------------------------------------------------------------
  describe('save()', () => {
    it('将内存配置写入磁盘', () => {
      const config = freshConfig();
      config.load();
      config.getConfig().router.strategy = 'saved-strategy';

      config.save();

      // 验证磁盘文件内容
      const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.router.strategy, 'saved-strategy');
    });
  });
});
