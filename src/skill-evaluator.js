'use strict';

/**
 * Skill 评估和进化模块（门面）
 *
 * 原 851 行已拆分为三个独立模块：
 *   - skill-scorer.js    — 9 维评估
 *   - skill-evolver.js   — 进化
 *   - skill-installer.js — 安装
 *
 * 本文件保持向后兼容的入口：createSkillEvaluator, DIMENSIONS, TOTAL_WEIGHT
 */

const { createSkillScorer, DIMENSIONS, TOTAL_WEIGHT } = require('./skill-scorer');
const { createSkillEvolver } = require('./skill-evolver');
const { createSkillInstaller } = require('./skill-installer');

/**
 * @param {Object} skillStore - Skill 存储接口
 * @param {EventEmitter} bus - 事件总线
 * @returns {{ evaluate, evaluateAll, evolve, install, getHistory }}
 */
function createSkillEvaluator(skillStore, bus) {
  const scorer = createSkillScorer(skillStore, bus);
  const evolver = createSkillEvolver(skillStore, bus, scorer);
  const installer = createSkillInstaller(skillStore, bus);

  return {
    evaluate: scorer.evaluate,
    evaluateAll: scorer.evaluateAll,
    evolve: evolver.evolve,
    install: installer.install,
    getHistory: scorer.getHistory,
  };
}

module.exports = { createSkillEvaluator, DIMENSIONS, TOTAL_WEIGHT };
