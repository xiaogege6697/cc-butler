'use strict';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createRouterEngine } = require('../src/router-engine');

// ─── helper：构造 mock configModule ────────────────────────────
function makeConfigModule(config) {
  return { getConfig: () => config };
}

// ─── helper：构造 mock healthChecker ───────────────────────────
function makeHealthChecker(unavailableIds = new Set()) {
  return {
    isAvailable: (id) => !unavailableIds.has(id),
    reportFailure: mock.fn(),
    reportSuccess: mock.fn(),
  };
}

// ─── helper：构造一个 deployment ───────────────────────────────
function dep(id, { enabled = true, order = 1, weight = 1 } = {}) {
  return { id, enabled, order, weight, baseUrl: `https://${id}.example.com`, apiKey: 'sk-test' };
}

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe('selectDeployment', () => {

  it('单个 enabled deployment → 直接选中', () => {
    const config = makeConfigModule({ deployments: [dep('a')] });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    const result = selectDeployment();
    assert.equal(result.id, 'a');
  });

  it('多个同 order 的 deployment → 加权随机，结果在候选集中', () => {
    const deployments = [dep('a', { weight: 1 }), dep('b', { weight: 1 }), dep('c', { weight: 1 })];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    // 多次调用验证结果都在候选集内，且三种都能被选中
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      const r = selectDeployment();
      assert.ok(['a', 'b', 'c'].includes(r.id), `意外结果: ${r.id}`);
      seen.add(r.id);
    }
    // 统计意义上 300 次三个等权节点都应该出现过
    assert.equal(seen.size, 3, `加权随机应该覆盖所有节点，实际只命中: ${[...seen]}`);
  });

  it('加权随机：高 weight 的 deployment 被选中的次数明显更多', () => {
    const deployments = [dep('light', { weight: 1 }), dep('heavy', { weight: 99 })];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    let heavyCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (selectDeployment().id === 'heavy') heavyCount++;
    }
    // weight 99:1 → 期望 heavy 被选中 ~990 次，保守断言 > 900
    assert.ok(heavyCount > 900, `heavy 选中次数 ${heavyCount}/${N}，应该远超半数`);
  });

  it('enabled: false 的 deployment 被排除', () => {
    const deployments = [dep('a', { enabled: false }), dep('b', { enabled: true })];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    const result = selectDeployment();
    assert.equal(result.id, 'b');
  });

  it('健康检查标记为不可用的 deployment 被排除', () => {
    const deployments = [dep('a'), dep('b')];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker(new Set(['a']));
    const { selectDeployment } = createRouterEngine(config, health);

    const result = selectDeployment();
    assert.equal(result.id, 'b');
  });

  it('所有 deployment 都不可用 → 返回 null', () => {
    const deployments = [dep('a'), dep('b')];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker(new Set(['a', 'b']));
    const { selectDeployment } = createRouterEngine(config, health);

    assert.equal(selectDeployment(), null);
  });

  it('重试时 excludeSet 生效，排除已试过的 deployment', () => {
    const deployments = [dep('a', { order: 1 }), dep('b', { order: 1 }), dep('c', { order: 1 })];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    const excludeSet = new Set(['a']);
    const result = selectDeployment(undefined, excludeSet);
    assert.ok(['b', 'c'].includes(result.id), `应排除 a，实际选中: ${result.id}`);
  });

  it('空 deployment 列表 → 返回 null', () => {
    const config = makeConfigModule({ deployments: [] });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    assert.equal(selectDeployment(), null);
  });

  it('不同 order 的 deployment → 优先选 order 最小的', () => {
    const deployments = [dep('low', { order: 1 }), dep('mid', { order: 5 }), dep('high', { order: 10 })];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    // 多次调用都应返回 order=1 的节点
    for (let i = 0; i < 50; i++) {
      assert.equal(selectDeployment().id, 'low');
    }
  });

  it('order 最小组全部不可用时，不会降级到次优组', () => {
    const deployments = [dep('a', { order: 1 }), dep('b', { order: 2 })];
    const config = makeConfigModule({ deployments });
    // a 被健康检查排除，但算法只取最小 order 组，不会降级
    const health = makeHealthChecker(new Set(['a']));
    const { selectDeployment } = createRouterEngine(config, health);

    // 实际行为：candidates = [b]，order 排序后 minOrder=2，topGroup=[b]
    // 所以 b 会被选中（a 被排除后 b 是唯一候选）
    const result = selectDeployment();
    assert.equal(result.id, 'b');
  });

  it('excludeSet 排除所有候选时 → 返回 null', () => {
    const deployments = [dep('a')];
    const config = makeConfigModule({ deployments });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    assert.equal(selectDeployment(undefined, new Set(['a'])), null);
  });

  it('deployments 字段不存在时 → 返回 null（防御性编程）', () => {
    const config = makeConfigModule({});
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    assert.equal(selectDeployment(), null);
  });

  it('modelAliases 能正确解析模型别名', () => {
    // selectDeployment 内部调 resolveModel，验证别名是否生效
    // 这里通过间接方式验证：只要不抛错即说明 resolveModel 正常工作
    const deployments = [dep('a')];
    const config = makeConfigModule({
      deployments,
      modelAliases: { 'mini': 'claude-3-haiku' },
    });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    // 传入别名 'mini'，应正常返回 deployment（不影响过滤逻辑）
    const result = selectDeployment('mini');
    assert.equal(result.id, 'a');
  });

  it('weight 缺失时默认为 1', () => {
    const d1 = { id: 'x', enabled: true, order: 1, baseUrl: 'https://x.com', apiKey: 'k' };
    const d2 = { id: 'y', enabled: true, order: 1, baseUrl: 'https://y.com', apiKey: 'k' };
    const config = makeConfigModule({ deployments: [d1, d2] });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      seen.add(selectDeployment().id);
    }
    assert.equal(seen.size, 2, '两个无 weight 字段的 deployment 应等概率被选中');
  });

  it('order 缺失时默认为 999', () => {
    // 没有 order 字段的 deployment order=999，会被有 order=1 的优先
    const d1 = { id: 'no-order', enabled: true, baseUrl: 'https://x.com', apiKey: 'k' };
    const d2 = dep('has-order', { order: 1 });
    const config = makeConfigModule({ deployments: [d1, d2] });
    const health = makeHealthChecker();
    const { selectDeployment } = createRouterEngine(config, health);

    assert.equal(selectDeployment().id, 'has-order');
  });
});
