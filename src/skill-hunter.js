'use strict';

/**
 * Skill 搜集引擎 — 从多个信息源搜集最新的 Claude Code skill 信息
 *
 * 当前实现：GitHub API（无认证，rate limit 60次/小时）
 * 预留接口：X/Twitter、官方/社区源
 */

const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15000;       // 单个请求超时 15s
const MIN_HUNT_INTERVAL_MS = 60 * 1000; // 最少间隔 1 分钟
const MAX_CONCURRENT = 3;               // 最大并发数
const CACHE_TTL_MS = 30 * 60 * 1000;    // 缓存有效期 30 分钟

// GitHub 搜索 URL 列表
const SEARCH_URLS = [
  `${GITHUB_API_BASE}/search/repositories?q=SKILL.md+claude&sort=stars&order=desc&per_page=30`,
  `${GITHUB_API_BASE}/search/repositories?q=claude-code+skill&sort=stars&order=desc&per_page=30`,
  `${GITHUB_API_BASE}/search/repositories?q=claude+mcp+server&sort=stars&order=desc&per_page=30`,
];

// 分类推断关键词映射
const CATEGORY_KEYWORDS = [
  { keywords: ['code-review', 'review', 'lint', '代码审查'], category: 'code-review' },
  { keywords: ['research', 'search', 'deep-research', '搜索', '研究'], category: 'research' },
  { keywords: ['mcp', 'server', 'mcp-server'], category: 'mcp-server' },
  { keywords: ['test', 'testing', '单元测试', '测试'], category: 'testing' },
  { keywords: ['security', 'audit', '安全', '审计'], category: 'security' },
];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 发起 HTTPS/HTTP GET 请求，返回 JSON
 * @param {string} url - 请求 URL
 * @param {Object} [headers] - 额外请求头
 * @returns {Promise<Object>}
 */
function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`请求超时: ${url}`));
    }, REQUEST_TIMEOUT_MS);

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'cc-butler/0.1.0',
        'Accept': 'application/vnd.github.v3+json',
        ...headers,
      },
    }, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        fetchJSON(res.headers.location, headers).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        clearTimeout(timer);
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          reject(new Error(`GitHub API 返回 ${res.statusCode}: ${body.slice(0, 200)}`));
        });
        return;
      }

      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * 并发限制执行器
 * @param {Array<Function>} tasks - 返回 Promise 的函数数组
 * @param {number} concurrency - 最大并发数
 * @returns {Promise<Array>} 所有结果
 */
function parallelLimit(tasks, concurrency) {
  return new Promise((resolve, reject) => {
    const results = [];
    let nextIndex = 0;
    let running = 0;
    let settled = 0;
    const total = tasks.length;

    if (total === 0) { resolve([]); return; }

    function runNext() {
      while (running < concurrency && nextIndex < total) {
        const idx = nextIndex++;
        running++;

        tasks[idx]()
          .then((result) => {
            results[idx] = { status: 'fulfilled', value: result };
          })
          .catch((err) => {
            results[idx] = { status: 'rejected', reason: err };
          })
          .finally(() => {
            running--;
            settled++;
            if (settled === total) {
              resolve(results);
            } else {
              runNext();
            }
          });
      }
    }

    runNext();
  });
}

/**
 * 根据 description 和 topics 推断分类
 * @param {string} description
 * @param {Array<string>} topics
 * @returns {string}
 */
function inferCategory(description, topics) {
  const text = `${description || ''} ${(topics || []).join(' ')}`.toLowerCase();

  for (const { keywords, category } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      return category;
    }
  }

  return 'general';
}

/**
 * 从 GitHub 仓库对象提取 skill 信息
 * @param {Object} repo - GitHub API 返回的仓库对象
 * @returns {Object}
 */
function extractRepoInfo(repo) {
  return {
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || '',
    stars: repo.stargazers_count || 0,
    url: repo.html_url,
    updatedAt: repo.updated_at,
    language: repo.language || '',
    topics: repo.topics || [],
    category: inferCategory(repo.description, repo.topics),
    hasSkillMd: false,  // 后续检查后更新
    source: 'github',
  };
}

/**
 * 检查仓库是否有 SKILL.md 文件
 * @param {string} fullName - owner/repo
 * @returns {Promise<boolean>}
 */
async function checkSkillMd(fullName) {
  try {
    const url = `${GITHUB_API_BASE}/repos/${fullName}/contents/SKILL.md`;
    const data = await fetchJSON(url);
    return !!(data && data.name === 'SKILL.md');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 缓存层 — 避免重复请求消耗 rate limit
// ---------------------------------------------------------------------------
const responseCache = new Map();

/**
 * 带缓存的 fetchJSON
 * @param {string} url
 * @param {Object} [headers]
 * @returns {Promise<Object>}
 */
async function cachedFetch(url, headers) {
  const now = Date.now();
  const cached = responseCache.get(url);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await fetchJSON(url, headers);
  responseCache.set(url, { data, timestamp: now });
  return data;
}

// ---------------------------------------------------------------------------
// 预留信息源（X/Twitter、官方/社区）
// ---------------------------------------------------------------------------

/**
 * X/Twitter 搜集（预留，当前跳过）
 * @returns {Promise<Array>}
 */
async function huntTwitter() {
  // 预留接口，CDP 抓取方式待实现
  return [];
}

/**
 * 官方/社区源搜集（预留，当前跳过）
 * @returns {Promise<Array>}
 */
async function huntCommunity() {
  // 预留：Claude Code 官方文档、Reddit r/ClaudeAI、Discord
  return [];
}

// ---------------------------------------------------------------------------
// 主工厂函数
// ---------------------------------------------------------------------------

/**
 * 创建 Skill 搜集引擎
 * @param {Object} skillStore - skill 存储模块，需提供 add() 方法
 * @param {Object} config - 配置对象（通过 config.getConfig() 获取）
 * @param {EventEmitter} bus - 事件总线
 * @returns {{ hunt, startAutoHunt, stopAutoHunt, isRunning, getLastHuntResult }}
 */
function createSkillHunter(skillStore, config, bus) {
  // 状态
  let running = false;
  let lastHuntResult = null;
  let lastHuntTime = 0;
  let autoTimer = null;

  // ---------------------------------------------------------------------------
  // 核心：执行一次搜集
  // ---------------------------------------------------------------------------
  async function hunt() {
    // 防止重入
    if (running) {
      return { skipped: true, reason: 'hunt already in progress' };
    }

    // 频率限制
    const elapsed = Date.now() - lastHuntTime;
    if (elapsed < MIN_HUNT_INTERVAL_MS) {
      return {
        skipped: true,
        reason: `距上次搜集不足 1 分钟（剩余 ${Math.ceil((MIN_HUNT_INTERVAL_MS - elapsed) / 1000)}s）`,
      };
    }

    running = true;
    const startTime = Date.now();

    bus.emit('hunt.start', { timestamp: startTime });

    try {
      const hunterConfig = config.skillHunter || {};
      const enabledSources = hunterConfig.sources || ['github'];
      const allSkills = [];
      const errors = [];

      // --- GitHub 搜集 ---
      if (enabledSources.includes('github')) {
        bus.emit('hunt.progress', { source: 'github', phase: 'searching' });

        try {
          const githubResults = await huntGitHub(hunterConfig);
          allSkills.push(...githubResults);
        } catch (err) {
          errors.push({ source: 'github', error: err.message });
        }

        bus.emit('hunt.progress', { source: 'github', phase: 'done', count: allSkills.length });
      }

      // --- X/Twitter 搜集（预留） ---
      if (enabledSources.includes('twitter')) {
        bus.emit('hunt.progress', { source: 'twitter', phase: 'searching' });
        try {
          const twitterResults = await huntTwitter();
          allSkills.push(...twitterResults);
        } catch (err) {
          errors.push({ source: 'twitter', error: err.message });
        }
        bus.emit('hunt.progress', { source: 'twitter', phase: 'done' });
      }

      // --- 社区源搜集（预留） ---
      if (enabledSources.includes('community')) {
        bus.emit('hunt.progress', { source: 'community', phase: 'searching' });
        try {
          const communityResults = await huntCommunity();
          allSkills.push(...communityResults);
        } catch (err) {
          errors.push({ source: 'community', error: err.message });
        }
        bus.emit('hunt.progress', { source: 'community', phase: 'done' });
      }

      // --- 去重 ---
      const seen = new Set();
      const unique = allSkills.filter((skill) => {
        const key = skill.url || skill.fullName;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // --- 保存 ---
      let newCount = 0;
      for (const skill of unique) {
        try {
          const added = skillStore.add(skill);
          if (added) newCount++;
        } catch {
          // 存储失败不中断流程
        }
      }

      const duration = Date.now() - startTime;
      lastHuntResult = {
        totalFound: unique.length,
        newCount,
        duplicates: allSkills.length - unique.length,
        duration,
        errors: errors.length > 0 ? errors : undefined,
        timestamp: new Date().toISOString(),
      };
      lastHuntTime = Date.now();

      bus.emit('hunt.complete', lastHuntResult);
      bus.emit('skills.hunted', { count: unique.length, newCount });

      return lastHuntResult;
    } catch (err) {
      const failResult = {
        error: err.message,
        timestamp: new Date().toISOString(),
      };
      lastHuntResult = failResult;
      lastHuntTime = Date.now();

      bus.emit('hunt.complete', failResult);
      return failResult;
    } finally {
      running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // GitHub 搜集逻辑
  // ---------------------------------------------------------------------------
  async function huntGitHub(hunterConfig) {
    // 支持用户自定义搜索关键词
    const keywords = hunterConfig.keywords || [];
    const customSearchUrls = keywords.map((kw) =>
      `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(kw)}&sort=stars&order=desc&per_page=30`
    );

    // 合并默认搜索和自定义搜索，去重
    const allSearchUrls = [...new Set([...SEARCH_URLS, ...customSearchUrls])];

    // 并行搜索（限制并发）
    const searchTasks = allSearchUrls.map((url) => () => cachedFetch(url));
    const searchResults = await parallelLimit(searchTasks, MAX_CONCURRENT);

    // 提取仓库列表
    const allRepos = [];
    for (const result of searchResults) {
      if (result.status === 'fulfilled' && result.value?.items) {
        allRepos.push(...result.value.items);
      }
    }

    // 按 url 去重
    const seenUrls = new Set();
    const uniqueRepos = allRepos.filter((repo) => {
      if (seenUrls.has(repo.html_url)) return false;
      seenUrls.add(repo.html_url);
      return true;
    });

    // 提取信息
    const skills = uniqueRepos.map(extractRepoInfo);

    // 检查 SKILL.md（并行限制并发）
    const checkTasks = skills.map((skill) => async () => {
      skill.hasSkillMd = await checkSkillMd(skill.fullName);
      return skill;
    });

    const checkedResults = await parallelLimit(checkTasks, MAX_CONCURRENT);
    const finalSkills = checkedResults
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);

    return finalSkills;
  }

  // ---------------------------------------------------------------------------
  // 定时搜集
  // ---------------------------------------------------------------------------
  function startAutoHunt() {
    const hunterConfig = config.skillHunter || {};
    if (!hunterConfig.autoHunt) return;

    const intervalMs = (hunterConfig.intervalHours || 24) * 60 * 60 * 1000;
    if (autoTimer) clearInterval(autoTimer);

    autoTimer = setInterval(() => {
      hunt().catch(() => {});  // 错误已在内部处理
    }, intervalMs);

    // 启动时立即执行一次
    hunt().catch(() => {});
  }

  function stopAutoHunt() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  function isRunning() {
    return running;
  }

  function getLastHuntResult() {
    return lastHuntResult;
  }

  return {
    hunt,
    startAutoHunt,
    stopAutoHunt,
    isRunning,
    getLastHuntResult,
  };
}

module.exports = { createSkillHunter };
