'use strict';

/**
 * Skill 进化模块
 *
 * 通过本地代理（localhost:8118）调用 Claude API 执行进化，
 * 复用已有的路由、负载均衡和健康检查。
 */

const http = require('http');

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 通过本地代理调用 Claude Messages API
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userContent - 用户内容
 * @param {number} [timeout=180000] - 超时毫秒
 * @returns {Promise<string>} 模型回复文本
 */
function runLocalProxy(systemPrompt, userContent, timeout = 180000) {
  const port = process.env.PORT || 8118;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      stream: false,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userContent },
      ],
    });

    const req = http.request({
      hostname: 'localhost',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-version': '2023-06-01',
      },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`本地代理返回 ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const text = json.content?.[0]?.text || '';
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`解析代理响应失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('本地代理请求超时'));
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 创建 Skill 进化器
// ---------------------------------------------------------------------------

/**
 * @param {Object} skillStore - Skill 存储接口
 * @param {EventEmitter} bus - 事件总线
 * @param {Object} scorer - 评分器，需提供 evaluate(id) 和 evaluateContent(skill, content)
 * @returns {{ evolve }}
 */
function createSkillEvolver(skillStore, bus, scorer) {
  /**
   * 进化指定 skill 集合
   * @param {string[]} skillIds - 要进化的 skill ID 列表
   * @returns {Promise<Object>} 进化结果
   */
  async function evolve(skillIds) {
    if (!Array.isArray(skillIds) || skillIds.length < 2) {
      throw new Error('进化至少需要 2 个 skill');
    }

    // 1. 获取所有指定 skill
    const skills = skillIds.map(id => {
      const skill = skillStore.get(id);
      if (!skill) throw new Error(`Skill 不存在: ${id}`);
      return skill;
    });

    // 2. 验证是否同类型
    const categories = new Set(skills.map(s => s.category).filter(Boolean));
    if (categories.size > 1) {
      throw new Error(`skill 类别不兼容: ${[...categories].join(', ')}`);
    }

    // 3. 先评估所有 skill（确保有分数）
    const evaluations = [];
    for (const skill of skills) {
      try {
        const result = await scorer.evaluate(skill.id);
        evaluations.push(result);
      } catch {
        console.warn('[skill-evolver] Skill 评估失败，使用零分:', skill.id);
        evaluations.push({ id: skill.id, name: skill.name, totalScore: 0 });
      }
    }

    const maxOldScore = Math.max(...evaluations.map(e => e.totalScore || 0));

    // 4. 组装内容
    const combinedContent = skills.map(s =>
      `--- Skill: ${s.name} (${s.id}) ---\n${s.content || '(无内容)'}`
    ).join('\n\n');

    const bestSkill = evaluations.reduce((best, e) =>
      (e.totalScore || 0) > (best.totalScore || 0) ? e : best
    , evaluations[0]);

    // 5. 通过本地代理调用 Claude 生成整合方案
    const evolvePrompt = [
      '你是一个 Claude Code Skill 进化专家。',
      '以下是 ' + skills.length + ' 个同类型 skill 的内容。',
      '请将它们整合为一个更优秀的 skill，要求：',
      '1. 取各家之长，避免各家之短',
      '2. 结构更清晰、指令更具体',
      '3. 增加失败处理和检查点',
      '4. 避免所有已知反模式',
      '5. 输出格式为完整的 SKILL.md 内容（Markdown 格式）',
      '',
      '最佳 skill 是: ' + bestSkill.name + '（分数 ' + (bestSkill.totalScore || 0) + '）',
      '请以其为基础进行改进。',
    ].join('\n');

    let evolvedContent;
    try {
      evolvedContent = await runLocalProxy(evolvePrompt, combinedContent);
    } catch (err) {
      throw new Error(`Skill 进化失败: ${err.message}`);
    }

    if (!evolvedContent || evolvedContent.length < 100) {
      throw new Error('进化结果内容过短，可能失败');
    }

    // 6. 对新内容运行评估（使用 scorer.evaluateContent）
    const tempSkill = {
      name: `${bestSkill.name}-evolved`,
      category: skills[0].category,
      content: evolvedContent,
    };

    const { score: newScore, breakdown: newBreakdown } = scorer.evaluateContent(tempSkill, evolvedContent);

    // 7. 棘轮机制：只保留改进
    const improved = newScore > maxOldScore;

    const evolveResult = {
      newScore,
      oldMaxScore: maxOldScore,
      improved,
      scoreBreakdown: newBreakdown,
      evolvedContent: improved ? evolvedContent : null,
      evolvedFrom: skillIds,
      evolvedAt: new Date().toISOString(),
    };

    if (improved) {
      // 8. 创建新的 evolved skill
      const newSkill = {
        name: `${bestSkill.name}-evolved`,
        description: `由 ${skills.map(s => s.name).join(' + ')} 进化而来`,
        category: skills[0].category,
        status: 'evolved',
        content: evolvedContent,
        score: newScore,
        scoreBreakdown: newBreakdown,
        evolvedFrom: skillIds,
        sourceUrl: null,
      };

      const added = skillStore.add(newSkill);

      bus.emit('skill.evolved', {
        id: added.id,
        fromIds: skillIds,
        oldMaxScore: maxOldScore,
        newScore,
      });

      evolveResult.id = added.id;
      evolveResult.name = added.name;
    } else {
      bus.emit('skill.evolutionRejected', {
        fromIds: skillIds,
        oldMaxScore: maxOldScore,
        newScore,
        reason: `新分 ${newScore} 未超过旧最高分 ${maxOldScore}`,
      });
    }

    return evolveResult;
  }

  return { evolve };
}

module.exports = { createSkillEvolver };
