'use strict';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createHealthChecker } = require('../src/health-checker');

// mock EventEmitter 作为 bus
function createMockBus() {
  const events = {};
  return {
    on(event, fn) {
      (events[event] ??= []).push(fn);
    },
    emit(event, data) {
      (events[event] ??= []).forEach(fn => fn(data));
    },
    // 测试用：捕获 emit 调用
    _emitted: [],
    emitAndRecord(event, data) {
      this._emitted.push({ event, data });
      (events[event] ??= []).forEach(fn => fn(data));
    },
  };
}

// 用 emitAndRecord 替换 emit 来记录调用
function createRecordingBus() {
  const bus = createMockBus();
  const originalEmit = bus.emit.bind(bus);
  bus._emitted = [];
  bus.emit = function (event, data) {
    bus._emitted.push({ event, data });
    originalEmit(event, data);
  };
  return bus;
}

// 基础 deployment 配置
function makeDeployments(overrides = {}) {
  return [
    {
      id: 'dep-a',
      healthCheck: {
        allowedFails: 3,
        cooldownTime: 60,
      },
      ...overrides,
    },
    {
      id: 'dep-b',
      // 无 healthCheck 配置，走默认值
    },
  ];
}

describe('createHealthChecker', () => {
  it('初始状态：所有 deployment 可用且健康', () => {
    const deps = makeDeployments();
    const bus = createMockBus();
    const hc = createHealthChecker(deps, bus);

    assert.equal(hc.isAvailable('dep-a'), true);
    assert.equal(hc.isAvailable('dep-b'), true);

    const status = hc.getStatus();
    assert.equal(status['dep-a'].isHealthy, true);
    assert.equal(status['dep-a'].consecutiveFailures, 0);
    assert.equal(status['dep-a'].lastError, null);
    assert.equal(status['dep-b'].isHealthy, true);
  });

  it('未知 deployment ID 返回 false / 不报错', () => {
    const hc = createHealthChecker(makeDeployments(), createMockBus());

    assert.equal(hc.isAvailable('unknown'), false);
    // reportFailure / reportSuccess 对未知 ID 静默
    assert.doesNotThrow(() => hc.reportFailure('unknown', 'err'));
    assert.doesNotThrow(() => hc.reportSuccess('unknown'));
  });

  describe('reportFailure', () => {
    it('累计失败次数，未达阈值时仍可用', () => {
      const deps = makeDeployments();
      const hc = createHealthChecker(deps, createMockBus());

      hc.reportFailure('dep-a', 'timeout');
      hc.reportFailure('dep-a', new Error('500'));

      const status = hc.getStatus()['dep-a'];
      assert.equal(status.consecutiveFailures, 2);
      // 最后一次是 Error 对象，取 .message
      assert.equal(status.lastError, '500');
      assert.equal(status.isHealthy, true);
      assert.equal(hc.isAvailable('dep-a'), true);
    });

    it('达到 allowedFails 后标记为不可用', () => {
      const deps = makeDeployments();
      const hc = createHealthChecker(deps, createMockBus());

      hc.reportFailure('dep-a', 'err1');
      hc.reportFailure('dep-a', 'err2');
      hc.reportFailure('dep-a', 'err3');

      const status = hc.getStatus()['dep-a'];
      assert.equal(status.consecutiveFailures, 3);
      assert.equal(status.isHealthy, false);
      assert.ok(status.cooldownUntil > Date.now(), 'cooldownUntil 应在未来');
    });

    it('使用默认 allowedFails=3 和 cooldownTime=60s（无 healthCheck 配置）', () => {
      const deps = makeDeployments(); // dep-b 没有 healthCheck
      const hc = createHealthChecker(deps, createMockBus());

      for (let i = 0; i < 3; i++) {
        hc.reportFailure('dep-b', `err-${i}`);
      }

      const status = hc.getStatus()['dep-b'];
      assert.equal(status.isHealthy, false);
      // 默认 cooldownTime=60s
      const expectedCooldown = Date.now() + 60 * 1000;
      assert.ok(
        Math.abs(status.cooldownUntil - expectedCooldown) < 100,
        'cooldownUntil 应约为 60s 后'
      );
    });
  });

  describe('reportSuccess', () => {
    it('重置失败计数和健康状态', () => {
      const deps = makeDeployments();
      const hc = createHealthChecker(deps, createMockBus());

      hc.reportFailure('dep-a', 'err1');
      hc.reportFailure('dep-a', 'err2');
      hc.reportSuccess('dep-a');

      const status = hc.getStatus()['dep-a'];
      assert.equal(status.consecutiveFailures, 0);
      assert.equal(status.isHealthy, true);
      assert.equal(status.lastError, null);
    });
  });

  describe('isAvailable 冷却期', () => {
    it('冷却期内返回 false', () => {
      const deps = makeDeployments();
      const hc = createHealthChecker(deps, createMockBus());

      for (let i = 0; i < 3; i++) {
        hc.reportFailure('dep-a', 'err');
      }

      assert.equal(hc.isAvailable('dep-a'), false);
    });

    it('冷却期后自动恢复 + 触发 bus 事件（mock.timers 控制时间）', () => {
      const deps = [
        {
          id: 'dep-x',
          healthCheck: { allowedFails: 2, cooldownTime: 30 },
        },
      ];
      const bus = createRecordingBus();

      // 启用 fake timers
      mock.timers.enable({ apis: ['Date'] });

      const hc = createHealthChecker(deps, bus);

      hc.reportFailure('dep-x', 'err1');
      hc.reportFailure('dep-x', 'err2');

      assert.equal(hc.isAvailable('dep-x'), false, '冷却期内应不可用');
      assert.equal(bus._emitted.length, 0, '不应触发恢复事件');

      // 快进 30 秒
      mock.timers.tick(30 * 1000);

      assert.equal(hc.isAvailable('dep-x'), true, '冷却期后应恢复可用');
      assert.equal(bus._emitted.length, 1);
      assert.equal(bus._emitted[0].event, 'deployment.recovered');
      assert.deepEqual(bus._emitted[0].data, { id: 'dep-x' });

      // 恢复后状态重置
      const status = hc.getStatus()['dep-x'];
      assert.equal(status.consecutiveFailures, 0);
      assert.equal(status.isHealthy, true);

      mock.timers.reset();
    });

    it('冷却期内多次调用 isAvailable 不触发恢复事件', () => {
      const deps = [
        {
          id: 'dep-y',
          healthCheck: { allowedFails: 1, cooldownTime: 60 },
        },
      ];
      const bus = createRecordingBus();

      mock.timers.enable({ apis: ['Date'] });
      const hc = createHealthChecker(deps, bus);

      hc.reportFailure('dep-y', 'err');

      // 快进 10 秒，仍在 60s 冷却期内
      mock.timers.tick(10 * 1000);
      assert.equal(hc.isAvailable('dep-y'), false);
      mock.timers.tick(20 * 1000);
      assert.equal(hc.isAvailable('dep-y'), false);

      // bus 不应收到任何事件
      assert.equal(bus._emitted.length, 0);

      mock.timers.reset();
    });
  });

  describe('reset', () => {
    it('手动重置 deployment 健康状态', () => {
      const deps = makeDeployments();
      const hc = createHealthChecker(deps, createMockBus());

      for (let i = 0; i < 3; i++) {
        hc.reportFailure('dep-a', 'err');
      }

      assert.equal(hc.getStatus()['dep-a'].isHealthy, false);

      hc.reset('dep-a');

      const status = hc.getStatus()['dep-a'];
      assert.equal(status.isHealthy, true);
      assert.equal(status.consecutiveFailures, 0);
      assert.equal(status.cooldownUntil, 0);
      assert.equal(status.lastError, null);
    });

    it('重置未知 ID 不报错', () => {
      const hc = createHealthChecker(makeDeployments(), createMockBus());
      assert.doesNotThrow(() => hc.reset('unknown'));
    });
  });

  describe('getStatus', () => {
    it('返回所有 deployment 的状态快照（深拷贝）', () => {
      const deps = makeDeployments();
      const hc = createHealthChecker(deps, createMockBus());

      hc.reportFailure('dep-a', 'err');

      const snap1 = hc.getStatus();
      const snap2 = hc.getStatus();

      // 不同引用
      assert.notEqual(snap1['dep-a'], snap2['dep-a']);
      // 值相同
      assert.deepEqual(snap1['dep-a'], snap2['dep-a']);
    });
  });
});
