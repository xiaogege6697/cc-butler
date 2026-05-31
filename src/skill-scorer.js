'use strict';

/**
 * Skill 评分模块
 *
 * 9 维评估 Rubric（总分 100）：
 *   frontmatter(7), workflow(12), failureModes(12), checkpoints(6),
 *   specificity(17), resourceIntegration(4), architecture(12),
 *   testPerformance(23), antiPatterns(6)
 *
 * 从 skill-evaluator.js 提取的纯评估逻辑。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 评估维度定义：{ key, weight, label }
const DIMENSIONS = [
  { key: 'frontmatter',           weight: 7,  label: '元数据完整性' },
  { key: 'workflow',              weight: 12, label: '工作流清晰度' },
  { key: 'failureModes',          weight: 12, label: '失败场景覆盖' },
  { key: 'checkpoints',           weight: 6,  label: '检查点/暂停点' },
  { key: 'specificity',           weight: 17, label: '指令具体性' },
  { key: 'resourceIntegration',   weight: 4,  label: '资源整合' },
  { key: 'architecture',          weight: 12, label: '架构质量' },
  { key: 'testPerformance',       weight: 23, label: '实测效果' },
  { key: 'antiPatterns',          weight: 6,  label: '反模式规避' },
];

const TOTAL_WEIGHT = DIMENSIONS.reduce((s, d) => s + d.weight, 0); // 99，允许微小误差

// 已知反模式列表
const ANTI_PATTERNS = [
  { pattern: /不要|禁止|绝不/gi,                       desc: '过度使用否定指令，缺少正面引导' },
  { pattern: /你应该|你应当/gi,                         desc: '使用拟人化指令，不如用祈使句' },
  { pattern: /等一下|wait|pause/i,                      desc: '不必要的人工等待指令' },
  { pattern: /我觉得|我认为|I think/gi,                 desc: '模糊的主观表述' },
  { pattern: /等等|more or less|somewhat/gi,            desc: '含糊程度副词' },
  { pattern: /(\S+)\s+or\s+\1/gi,                      desc: '重复选项（同义反复）' },
  { pattern: /非常非常|很很/g,                           desc: '重复修饰词' },
  { pattern: /注意：|caution:|warning:/gi,              desc: '过多警告标签（应精简为结构化规则）' },
];

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 安全截断字符串
 */
function truncate(str, maxLen = 200) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * 计算 0-100 的分数
 * @param {number} raw - 0~1 之间的原始分
 * @param {number} weight - 维度权重
 * @returns {number} 加权分
 */
function weightedScore(raw, weight) {
  return Math.round(raw * weight * (100 / TOTAL_WEIGHT));
}

/**
 * 从 URL 获取 skill 内容（尝试 README.md 或 SKILL.md）
 * @param {string} sourceUrl - GitHub 仓库 URL
 * @returns {Promise<string|null>}
 */
async function fetchSkillContent(sourceUrl) {
  if (!sourceUrl) return null;

  // 将 GitHub URL 转换为 raw 内容 URL
  let rawUrl = sourceUrl;

  // github.com/user/repo → 尝试 SKILL.md 优先
  if (sourceUrl.includes('github.com')) {
    const repoPath = sourceUrl.replace(/\/$/, '').replace(/\.git$/, '');
    // 移除可能的 /blob/main 或 /tree/main 后缀
    const cleanPath = repoPath.replace(/\/(blob|tree)\/[^/]+.*/, '');

    // 尝试顺序：SKILL.md → README.md
    const candidates = [
      `${cleanPath.replace('github.com', 'raw.githubusercontent.com')}/main/SKILL.md`,
      `${cleanPath.replace('github.com', 'raw.githubusercontent.com')}/master/SKILL.md`,
      `${cleanPath.replace('github.com', 'raw.githubusercontent.com')}/main/README.md`,
      `${cleanPath.replace('github.com', 'raw.githubusercontent.com')}/master/README.md`,
    ];

    for (const url of candidates) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const text = await res.text();
          if (text && text.length > 50) return text;
        }
      } catch {
        console.debug('[skill-scorer] 内容获取失败:', source);
      }
    }
  }

  // 非 GitHub URL 直接 fetch
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
    if (res.ok) return await res.text();
  } catch {
    console.debug('[skill-scorer] 非 GitHub URL 获取失败');
  }

  return null;
}

// ---------------------------------------------------------------------------
// 静态分析器（维度 1-9）
// ---------------------------------------------------------------------------

/**
 * 维度 1: frontmatter — 元数据完整性 (权重 7)
 * 检查是否有 name, description, trigger, category 等结构化元数据
 */
function evaluateFrontmatter(skill, content) {
  let score = 0;
  const max = 7;
  const checks = {
    hasName:        !!(skill.name && skill.name.length > 0),
    hasDescription: !!(skill.description && skill.description.length > 10),
    hasCategory:    !!(skill.category),
    hasTrigger:     /trigger|触发|when|使用场景/i.test(content),
    hasVersion:     /version|版本/i.test(content),
    hasAuthor:      /author|作者|maintainer/i.test(content),
    hasTags:        Array.isArray(skill.tags) && skill.tags.length > 0,
  };

  const passed = Object.values(checks).filter(Boolean).length;
  score = Math.round((passed / Object.keys(checks).length) * max);

  return { score, max, checks };
}

/**
 * 维度 2: workflow — 工作流步骤是否清晰 (权重 12)
 */
function evaluateWorkflow(_skill, content) {
  let score = 0;
  const max = 12;

  // 检查步骤标记
  const stepPatterns = [
    /##?\s+步骤/i,
    /##?\s+step/i,
    /^\s*\d+[\.\)]\s+/m,
    /第一步|第二步|第三步/i,
    /first|then|finally/i,
  ];
  const stepsFound = stepPatterns.filter(p => p.test(content)).length;
  const stepsScore = Math.min(stepsFound / 3, 1) * 5;

  // 检查流程标记（输入 → 处理 → 输出）
  const flowPatterns = [
    /输入|input/i,
    /输出|output|结果/i,
    /处理|process|执行/i,
    /流程|workflow|pipeline/i,
  ];
  const flowFound = flowPatterns.filter(p => p.test(content)).length;
  const flowScore = Math.min(flowFound / 3, 1) * 4;

  // 检查条件分支
  const hasConditional = /如果|if|否则|else|条件|当.*时/i.test(content);
  const conditionalScore = hasConditional ? 3 : 0;

  score = Math.min(Math.round(stepsScore + flowScore + conditionalScore), max);

  return {
    score,
    max,
    checks: { stepsFound, flowFound, hasConditional },
  };
}

/**
 * 维度 3: failureModes — 是否编码了失败场景 (权重 12)
 */
function evaluateFailureModes(_skill, content) {
  let score = 0;
  const max = 12;

  // 检查失败场景描述
  const failurePatterns = [
    /失败|失败模式|failure|error|错误/i,
    /异常|exception|崩溃|crash/i,
    /边界情况|edge case|corner case/i,
    /回退|fallback|降级/i,
    /超时|timeout|重试|retry/i,
  ];
  const failuresFound = failurePatterns.filter(p => p.test(content)).length;

  // 检查错误处理指令
  const handlingPatterns = [
    /处理.*错误|handle.*error/i,
    /返回.*错误|return.*error/i,
    /报告|notify|alert/i,
    /恢复|recover/i,
  ];
  const handlingFound = handlingPatterns.filter(p => p.test(content)).length;

  const rawScore = (failuresFound / failurePatterns.length) * 7 +
                   (handlingFound / handlingPatterns.length) * 5;
  score = Math.min(Math.round(rawScore), max);

  return {
    score,
    max,
    checks: { failuresFound, handlingFound },
  };
}

/**
 * 维度 4: checkpoints — 是否有检查点/暂停点 (权重 6)
 */
function evaluateCheckpoints(_skill, content) {
  let score = 0;
  const max = 6;

  const checkpointPatterns = [
    /检查点|checkpoint|暂停|pause/i,
    /确认|confirm|验证|verify/i,
    /用户确认|user confirm/i,
    /审查|review|审批/i,
    /先.*再/i,
  ];
  const found = checkpointPatterns.filter(p => p.test(content)).length;

  score = Math.min(Math.round((found / checkpointPatterns.length) * max), max);

  return { score, max, checks: { checkpointsFound: found } };
}

/**
 * 维度 5: specificity — 指令是否具体可执行 (权重 17)
 */
function evaluateSpecificity(_skill, content) {
  let score = 0;
  const max = 17;

  // 具体性指标
  const checks = {
    // 有代码示例
    hasCodeExample: /```[\s\S]*?```/.test(content),
    // 有具体的文件路径
    hasFilePaths: /\/[\w.-]+\.[\w]+/.test(content),
    // 有具体的命令
    hasCommands: /`[^`]+`/.test(content) && /npm|pip|git|node|python|curl/.test(content),
    // 有明确的输入输出格式
    hasIOFormat: /参数|argument|返回值|return|输入格式|输出格式/i.test(content),
    // 有量化标准
    hasQuantification: /\d+%|\d+个|至少|最多|不超过|max|min|limit/i.test(content),
    // 避免了模糊表述
    avoidsVagueness: !/可能|大概|也许|probably|maybe|perhaps/i.test(content),
    // 有具体示例
    hasExamples: /示例|example|比如|例如|such as/i.test(content),
  };

  const passed = Object.values(checks).filter(Boolean).length;
  score = Math.round((passed / Object.keys(checks).length) * max);

  return { score, max, checks };
}

/**
 * 维度 6: resourceIntegration — 是否整合了外部资源 (权重 4)
 */
function evaluateResourceIntegration(skill, content) {
  let score = 0;
  const max = 4;

  const checks = {
    hasSourceUrl: !!(skill.sourceUrl),
    hasLinks: /https?:\/\//i.test(content),
    hasMcpIntegration: /mcp|MCP|tool/i.test(content),
    hasExternalRefs: /参考|reference|see also|参阅/i.test(content),
  };

  const passed = Object.values(checks).filter(Boolean).length;
  score = Math.round((passed / Object.keys(checks).length) * max);

  return { score, max, checks };
}

/**
 * 维度 7: architecture — 整体架构质量 (权重 12)
 */
function evaluateArchitecture(skill, content) {
  let score = 0;
  const max = 12;

  const checks = {
    // 有目录结构或模块划分
    hasStructure: /目录|structure|模块|module|组件/i.test(content),
    // 有分层/分层架构描述
    hasLayers: /层|layer|tier|阶段|phase/i.test(content),
    // 有依赖说明
    hasDependencies: /依赖|depend|require|需要.*安装/i.test(content),
    // 内容长度足够（有实质性内容）
    hasEnoughContent: content.length > 500,
    // 有配置说明
    hasConfig: /配置|config|设置|setting/i.test(content),
    // 有清晰的边界定义
    hasScopeDefinition: /范围|scope|边界|boundary|职责/i.test(content),
  };

  const passed = Object.values(checks).filter(Boolean).length;
  score = Math.round((passed / Object.keys(checks).length) * max);

  return { score, max, checks };
}

/**
 * 维度 8: testPerformance — 实测效果 (权重 23)
 * 当前阶段：基于文档质量 + star 数 + 启发式估算
 * 预留 spawn claude CLI 执行真实测试的接口
 */
function evaluateTestPerformance(skill, content) {
  let score = 0;
  const max = 23;

  // 启发式估算
  const heuristicChecks = {
    // 有测试说明
    hasTestSection: /测试|test|验证|verify|检验/i.test(content),
    // 有成功案例
    hasSuccessCases: /成功|success|已完成|working/i.test(content),
    // star 数（如果有）
    hasHighStars: (skill.stars || 0) >= 50,
    // 有中等 star
    hasMediumStars: (skill.stars || 0) >= 10,
    // 有用户反馈
    hasUserFeedback: /反馈|feedback|issue|好评/i.test(content),
    // 文档质量高（内容丰富且结构化）
    hasQualityDoc: content.length > 1000 && /##?\s+/.test(content),
    // 有实际使用说明
    hasUsageGuide: /使用|usage|how to|快速开始|quickstart/i.test(content),
  };

  const passed = Object.values(heuristicChecks).filter(Boolean).length;
  const heuristicScore = Math.round((passed / Object.keys(heuristicChecks).length) * max);

  score = Math.min(heuristicScore, max);

  return {
    score,
    max,
    checks: heuristicChecks,
    note: '启发式估算，预留 claude CLI 真实测试接口',
  };
}

/**
 * 维度 9: antiPatterns — 是否避免了已知反模式 (权重 6)
 */
function evaluateAntiPatterns(_skill, content) {
  let score = 0;
  const max = 6;

  const violations = [];

  for (const ap of ANTI_PATTERNS) {
    const matches = content.match(ap.pattern);
    if (matches && matches.length >= 3) {
      violations.push({
        pattern: ap.pattern.source,
        desc: ap.desc,
        count: matches.length,
      });
    }
  }

  // 没有违规 → 满分，每个违规扣 2 分
  const penalty = violations.length * 2;
  score = Math.max(max - penalty, 0);

  return { score, max, checks: { violations, violationCount: violations.length } };
}

// ---------------------------------------------------------------------------
// 9 维度评估器列表（供 evaluate 和 evaluateContent 使用）
// ---------------------------------------------------------------------------

const evaluators = [
  evaluateFrontmatter,
  evaluateWorkflow,
  evaluateFailureModes,
  evaluateCheckpoints,
  evaluateSpecificity,
  evaluateResourceIntegration,
  evaluateArchitecture,
  evaluateTestPerformance,
  evaluateAntiPatterns,
];

// ---------------------------------------------------------------------------
// 创建 Skill 评分器
// ---------------------------------------------------------------------------

/**
 * @param {Object} skillStore - Skill 存储接口
 * @param {EventEmitter} bus - 事件总线
 * @returns {{ evaluate, evaluateAll, evaluateContent, getHistory }}
 */
function createSkillScorer(skillStore, bus) {
  // 评估历史（内存，按 skillId 索引）
  const history = new Map();

  // =========================================================================
  // 内部辅助
  // =========================================================================

  function recordHistory(skillId, result) {
    if (!history.has(skillId)) {
      history.set(skillId, []);
    }
    const records = history.get(skillId);
    records.push({
      ...result,
      timestamp: Date.now(),
    });
    // 只保留最近 20 条
    if (records.length > 20) {
      records.splice(0, records.length - 20);
    }
  }

  // =========================================================================
  // evaluateContent — 对任意内容运行 9 维评估（不读写 store）
  // =========================================================================

  /**
   * 对给定 skill 对象和内容运行 9 维评估，返回分数和 breakdown。
   * 不读写 skillStore，不记录 history，不发事件。
   * 供 evolver 在评估进化后的内容时使用。
   *
   * @param {Object} skill - skill 元数据对象（至少需要 name）
   * @param {string} content - 要评估的内容
   * @returns {{ score: number, breakdown: Object, rawTotal: number }}
   */
  function evaluateContent(skill, content) {
    const scoreBreakdown = {};
    let rawTotal = 0;

    for (let i = 0; i < DIMENSIONS.length; i++) {
      const dim = DIMENSIONS[i];
      const result = evaluators[i](skill, content);
      scoreBreakdown[dim.key] = {
        score: result.score,
        max: result.max,
        weight: dim.weight,
        label: dim.label,
        checks: result.checks || {},
        ...(result.note ? { note: result.note } : {}),
      };
      rawTotal += result.score;
    }

    const score = Math.min(Math.round((rawTotal / TOTAL_WEIGHT) * 100), 100);

    return { score, breakdown: scoreBreakdown, rawTotal };
  }

  // =========================================================================
  // evaluate — 评估单个 skill（读写 store + history）
  // =========================================================================

  /**
   * 评估单个 skill
   * @param {string} skillId - Skill ID
   * @returns {Promise<Object>} 评估结果
   */
  async function evaluate(skillId) {
    const skill = skillStore.get(skillId);
    if (!skill) {
      throw new Error(`Skill 不存在: ${skillId}`);
    }

    // 1. 获取 content
    let content = skill.content || '';

    // 2. 如果没有 content，尝试从 sourceUrl 获取
    if (!content && skill.sourceUrl) {
      try {
        content = await fetchSkillContent(skill.sourceUrl);
        if (content) {
          // 回填到 skillStore
          skillStore.update(skillId, { content });
        }
      } catch {
        console.debug('[skill-scorer] 内容回填失败');
      }
    }

    // 如果仍然没有 content，返回最低分
    if (!content) {
      const result = {
        id: skillId,
        name: skill.name,
        totalScore: 0,
        scoreBreakdown: {},
        evaluatedAt: new Date().toISOString(),
        warning: '无法获取 skill 内容，所有维度得分为 0',
      };
      recordHistory(skillId, result);
      skillStore.update(skillId, { score: 0, scoreBreakdown: result.scoreBreakdown });
      bus.emit('skill.evaluated', { id: skillId, score: 0 });
      return result;
    }

    // 3. 运行 9 维评估
    const { score: normalizedScore, breakdown: scoreBreakdown, rawTotal } = evaluateContent(skill, content);

    const evaluationResult = {
      id: skillId,
      name: skill.name,
      totalScore: normalizedScore,
      rawTotal,
      scoreBreakdown,
      evaluatedAt: new Date().toISOString(),
      contentLength: content.length,
    };

    // 4. 更新 skillStore
    skillStore.update(skillId, {
      score: normalizedScore,
      scoreBreakdown,
      evaluatedAt: evaluationResult.evaluatedAt,
    });

    // 5. 记录历史 + 事件
    recordHistory(skillId, evaluationResult);
    bus.emit('skill.evaluated', { id: skillId, score: normalizedScore, breakdown: scoreBreakdown });

    return evaluationResult;
  }

  // =========================================================================
  // evaluateAll — 批量评估
  // =========================================================================

  /**
   * 批量评估所有 skill
   * @param {string} [statusFilter] - 可选的状态过滤器（如 'discovered', 'installed'）
   * @returns {Promise<Object>} { results: [], summary: {} }
   */
  async function evaluateAll(statusFilter) {
    const skills = skillStore.getAll(statusFilter ? { status: statusFilter } : undefined);

    const results = [];
    const scores = [];

    for (const skill of skills) {
      try {
        const result = await evaluate(skill.id);
        results.push(result);
        scores.push(result.totalScore);
      } catch (err) {
        results.push({
          id: skill.id,
          name: skill.name,
          error: err.message,
          totalScore: null,
        });
      }
    }

    const validScores = scores.filter(s => s !== null);
    const summary = {
      total: skills.length,
      evaluated: validScores.length,
      averageScore: validScores.length > 0
        ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
        : 0,
      maxScore: validScores.length > 0 ? Math.max(...validScores) : 0,
      minScore: validScores.length > 0 ? Math.min(...validScores) : 0,
      errors: results.filter(r => r.error).length,
    };

    bus.emit('skills.batchEvaluated', summary);

    return { results, summary };
  }

  // =========================================================================
  // getHistory — 获取评估历史
  // =========================================================================

  /**
   * 获取指定 skill 的评估历史
   * @param {string} skillId - Skill ID
   * @returns {Array} 评估历史记录
   */
  function getHistory(skillId) {
    return history.get(skillId) || [];
  }

  return { evaluate, evaluateAll, evaluateContent, getHistory };
}

module.exports = { createSkillScorer, DIMENSIONS, TOTAL_WEIGHT };
