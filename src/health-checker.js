'use strict';

/**
 * 健康检查模块 — 被动模式
 * 请求失败时更新状态，冷却过期自动恢复，恢复时通知 bus
 */

/**
 * 创建健康检查器
 * @param {Array} deployments - deployment 配置数组
 * @param {EventEmitter} bus - 事件总线，用于通知 deployment.recovered
 * @returns {{ reportFailure, reportSuccess, isAvailable, getStatus, reset }}
 */
function createHealthChecker(deployments, bus) {
  // 每个 deployment 的健康状态
  const statusMap = new Map();

  for (const dep of deployments) {
    statusMap.set(dep.id, {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      isHealthy: true,
      lastError: null,
    });
  }

  /**
   * 报告请求失败
   * @param {string} id - deployment ID
   * @param {Error|string} error - 错误信息
   */
  function reportFailure(id, error) {
    const status = statusMap.get(id);
    if (!status) return;

    status.consecutiveFailures++;
    status.lastError = error instanceof Error ? error.message : String(error);

    const dep = deployments.find(d => d.id === id);
    const allowedFails = dep?.healthCheck?.allowedFails ?? 3;
    const cooldownTime = (dep?.healthCheck?.cooldownTime ?? 60) * 1000;

    if (status.consecutiveFailures >= allowedFails && status.isHealthy) {
      status.isHealthy = false;
      status.cooldownUntil = Date.now() + cooldownTime;
    }
  }

  /**
   * 报告请求成功，重置失败计数
   * @param {string} id - deployment ID
   */
  function reportSuccess(id) {
    const status = statusMap.get(id);
    if (!status) return;

    status.consecutiveFailures = 0;
    status.isHealthy = true;
    status.lastError = null;
  }

  /**
   * 检查 deployment 是否可用（不在冷却期）
   * 冷却过期自动恢复并发出 deployment.recovered 事件
   * @param {string} id - deployment ID
   * @returns {boolean}
   */
  function isAvailable(id) {
    const status = statusMap.get(id);
    if (!status) return false;

    // 健康的直接返回
    if (status.isHealthy) return true;

    // 冷却期未过
    if (Date.now() < status.cooldownUntil) return false;

    // 冷却期已过，自动恢复
    const wasUnhealthy = !status.isHealthy;
    status.isHealthy = true;
    status.consecutiveFailures = 0;
    status.lastError = null;

    if (wasUnhealthy && bus) {
      bus.emit('deployment.recovered', { id });
    }

    return true;
  }

  /**
   * 获取所有 deployment 健康状态快照
   * @returns {Object} { [id]: { consecutiveFailures, cooldownUntil, isHealthy, lastError } }
   */
  function getStatus() {
    const result = {};
    for (const [id, status] of statusMap) {
      result[id] = { ...status };
    }
    return result;
  }

  /**
   * 手动重置某个 deployment 的健康状态
   * @param {string} id - deployment ID
   */
  function reset(id) {
    const status = statusMap.get(id);
    if (!status) return;

    status.consecutiveFailures = 0;
    status.cooldownUntil = 0;
    status.isHealthy = true;
    status.lastError = null;
  }

  return { reportFailure, reportSuccess, isAvailable, getStatus, reset };
}

module.exports = { createHealthChecker };
