'use strict';

/**
 * Skill 安装模块
 *
 * 从 skill-evaluator.js 提取的安装逻辑。
 * 负责将 skill 内容写入 ~/.claude/skills/ 目录。
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_SKILLS_DIR = path.join(HOME, '.claude', 'skills');

// ---------------------------------------------------------------------------
// 创建 Skill 安装器
// ---------------------------------------------------------------------------

/**
 * @param {Object} skillStore - Skill 存储接口
 * @param {EventEmitter} bus - 事件总线
 * @returns {{ install }}
 */
function createSkillInstaller(skillStore, bus) {
  /**
   * 安装 skill 到 Claude Code 的 skill 目录
   * @param {string} skillId - Skill ID
   * @returns {Object} 安装结果
   */
  function install(skillId) {
    const skill = skillStore.get(skillId);
    if (!skill) {
      throw new Error(`Skill 不存在: ${skillId}`);
    }

    if (!skill.content) {
      throw new Error('Skill 没有内容，无法安装');
    }

    // 确保 ~/.claude/skills/ 目录存在
    if (!fs.existsSync(CLAUDE_SKILLS_DIR)) {
      fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
    }

    // 生成文件名：用 skill name 的 slug
    const slug = (skill.name || skillId)
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '');
    const fileName = `${slug}.md`;
    const targetPath = path.join(CLAUDE_SKILLS_DIR, fileName);

    // 检查是否已存在
    if (fs.existsSync(targetPath)) {
      // 已存在，不覆盖，先备份
      const backupDir = path.join(HOME, '.openclaw', 'trash', new Date().toISOString().slice(0, 10));
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      const backupPath = path.join(backupDir, `${fileName}.bak`);
      fs.copyFileSync(targetPath, backupPath);
    }

    // 写入 skill 文件
    fs.writeFileSync(targetPath, skill.content, 'utf8');

    // 更新 skillStore 状态
    skillStore.update(skillId, {
      status: 'installed',
      installedAt: new Date().toISOString(),
      installPath: targetPath,
    });

    const now = new Date().toISOString();
    bus.emit('skill.installed', { id: skillId, installPath: targetPath, installedAt: now });

    return {
      id: skillId,
      name: skill.name,
      installedTo: targetPath,
      installPath: targetPath,
      installedAt: now,
      previousBackup: fs.existsSync(path.join(HOME, '.openclaw', 'trash', new Date().toISOString().slice(0, 10), `${fileName}.bak`)),
    };
  }

  return { install };
}

module.exports = { createSkillInstaller };
