'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = process.env.CC_BUTLER_ROOT
  ? path.resolve(process.env.CC_BUTLER_ROOT)
  : path.join(PROJECT_ROOT, 'data');
const SKILLS_DIR = path.join(DATA_ROOT, 'skills');
const INDEX_PATH = path.join(SKILLS_DIR, 'index.json');
const CACHE_DIR = path.join(SKILLS_DIR, 'cache');
const TMP_EXT = '.tmp';
const MAX_SKILLS = 1000;

// status 合法值及转换规则
const VALID_STATUSES = new Set(['new', 'installed', 'skipped', 'evolved']);
const STATUS_TRANSITIONS = {
  new: ['installed', 'skipped', 'evolved'],
  installed: ['evolved'],
  evolved: ['installed'],
};

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------
let _index = null;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 原子写入：先写 .tmp 再 fs.rename
 */
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = filePath + TMP_EXT + '.' + crypto.randomBytes(4).toString('hex');

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * 生成 skill ID
 */
function generateId() {
  return 'skill-' + crypto.randomBytes(8).toString('hex');
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 获取缓存文件路径
 */
function cacheFilePath(id) {
  return path.join(CACHE_DIR, `${id}.json`);
}

/**
 * 验证状态流转是否合法
 */
function isValidTransition(fromStatus, toStatus) {
  if (!VALID_STATUSES.has(toStatus)) return false;
  if (fromStatus === toStatus) return true;
  const allowed = STATUS_TRANSITIONS[fromStatus];
  return allowed ? allowed.includes(toStatus) : false;
}

/**
 * 将 skill 数据规范化，填充默认值
 */
function normalizeSkill(data) {
  return {
    id: data.id || generateId(),
    name: data.name || '',
    source: data.source || '',
    sourceUrl: data.sourceUrl || '',
    author: data.author || '',
    description: data.description || '',
    category: data.category || '',
    stars: data.stars ?? null,
    score: data.score ?? null,
    scoreBreakdown: data.scoreBreakdown ?? null,
    status: data.status || 'new',
    installedAt: data.installedAt || null,
    discoveredAt: data.discoveredAt || new Date().toISOString(),
    evolvedFrom: data.evolvedFrom || [],
    contentPath: data.contentPath || null,
    tags: data.tags || [],
  };
}

/**
 * 超过上限时按 discoveredAt 排序删除最旧的记录
 */
function trimIndex(index, bus) {
  if (index.length <= MAX_SKILLS) return;

  // 按 discoveredAt 升序排列，最旧的在前
  const sorted = [...index].sort((a, b) =>
    (a.discoveredAt || '').localeCompare(b.discoveredAt || '')
  );

  const removeCount = index.length - MAX_SKILLS;
  const toRemove = sorted.slice(0, removeCount);
  const removeIds = new Set(toRemove.map((s) => s.id));

  // 清理对应的缓存文件
  for (const id of removeIds) {
    const cp = cacheFilePath(id);
    if (fs.existsSync(cp)) {
      fs.unlinkSync(cp);
    }
  }

  _index = index.filter((s) => !removeIds.has(s.id));
  bus.emit('skills.trimmed', { removedCount: removeCount });
}

// ---------------------------------------------------------------------------
// createSkillStore
// ---------------------------------------------------------------------------
function createSkillStore(bus) {
  // -----------------------------------------------------------------------
  // load — 加载 index.json，不存在则创建空数组
  // -----------------------------------------------------------------------
  function load() {
    ensureDir(SKILLS_DIR);
    ensureDir(CACHE_DIR);

    if (!fs.existsSync(INDEX_PATH)) {
      _index = [];
      atomicWrite(INDEX_PATH, _index);
    } else {
      const raw = fs.readFileSync(INDEX_PATH, 'utf8');
      _index = JSON.parse(raw);
    }

    return _index;
  }

  // -----------------------------------------------------------------------
  // save — 持久化当前内存索引到磁盘
  // -----------------------------------------------------------------------
  function save() {
    if (!_index) load();
    atomicWrite(INDEX_PATH, _index);
  }

  // -----------------------------------------------------------------------
  // getAll — 获取所有 skill
  // -----------------------------------------------------------------------
  function getAll() {
    if (!_index) load();
    return [..._index];
  }

  // -----------------------------------------------------------------------
  // getById — 按 ID 获取
  // -----------------------------------------------------------------------
  function getById(id) {
    if (!_index) load();
    return _index.find((s) => s.id === id) || null;
  }

  // -----------------------------------------------------------------------
  // getByCategory — 按分类筛选
  // -----------------------------------------------------------------------
  function getByCategory(category) {
    if (!_index) load();
    return _index.filter((s) => s.category === category);
  }

  // -----------------------------------------------------------------------
  // getByStatus — 按状态筛选
  // -----------------------------------------------------------------------
  function getByStatus(status) {
    if (!_index) load();
    return _index.filter((s) => s.status === status);
  }

  // -----------------------------------------------------------------------
  // search — 按名称/描述/tags 模糊搜索
  // -----------------------------------------------------------------------
  function search(query) {
    if (!_index) load();
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];

    return _index.filter((s) => {
      const name = (s.name || '').toLowerCase();
      const desc = (s.description || '').toLowerCase();
      const tags = (s.tags || []).join(' ').toLowerCase();
      return name.includes(q) || desc.includes(q) || tags.includes(q);
    });
  }

  // -----------------------------------------------------------------------
  // add — 添加新 skill，自动生成 id + discoveredAt
  // -----------------------------------------------------------------------
  function add(skillData) {
    if (!_index) load();

    const skill = normalizeSkill(skillData);
    // 确保新增时 id 唯一
    if (_index.some((s) => s.id === skill.id)) {
      skill.id = generateId();
    }

    _index.push(skill);
    trimIndex(_index, bus);
    save();

    bus.emit('skill.added', { id: skill.id });
    bus.emit('skills.updated');
    return skill;
  }

  // -----------------------------------------------------------------------
  // update — 部分更新
  // -----------------------------------------------------------------------
  function update(id, patch) {
    if (!_index) load();
    const idx = _index.findIndex((s) => s.id === id);
    if (idx === -1) return null;

    // 不允许通过 patch 修改 id
    const { id: _ignored, ...safePatch } = patch;
    Object.assign(_index[idx], safePatch);
    save();

    bus.emit('skills.updated');
    return _index[idx];
  }

  // -----------------------------------------------------------------------
  // setStatus — 更新状态（带状态机校验）
  // -----------------------------------------------------------------------
  function setStatus(id, status) {
    if (!_index) load();
    const skill = _index.find((s) => s.id === id);
    if (!skill) return null;

    if (!isValidTransition(skill.status, status)) {
      throw new Error(
        `不允许的状态流转: ${skill.status} → ${status}`
      );
    }

    const prev = skill.status;
    skill.status = status;

    // installed 状态自动记录安装时间
    if (status === 'installed' && !skill.installedAt) {
      skill.installedAt = new Date().toISOString();
    }

    save();
    bus.emit('skills.updated');
    return { id, from: prev, to: status };
  }

  // -----------------------------------------------------------------------
  // setContent — 保存 skill 详情到 cache/{id}.json
  // -----------------------------------------------------------------------
  function setContent(id, content) {
    if (!_index) load();
    const skill = _index.find((s) => s.id === id);
    if (!skill) return null;

    ensureDir(CACHE_DIR);
    const filePath = cacheFilePath(id);
    atomicWrite(filePath, content);

    skill.contentPath = filePath;
    save();
    return filePath;
  }

  // -----------------------------------------------------------------------
  // getContent — 读取 skill 详情
  // -----------------------------------------------------------------------
  function getContent(id) {
    const filePath = cacheFilePath(id);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }

  // -----------------------------------------------------------------------
  // remove — 删除 skill（mv cache 文件到 trash）
  // -----------------------------------------------------------------------
  function remove(id) {
    if (!_index) load();
    const idx = _index.findIndex((s) => s.id === id);
    if (idx === -1) return false;

    _index.splice(idx, 1);
    save();

    // 移动缓存文件而非删除
    const cp = cacheFilePath(id);
    if (fs.existsSync(cp)) {
      const trashDir = path.join(
        require('os').homedir(),
        '.openclaw',
        'trash',
        new Date().toISOString().slice(0, 10)
      );
      ensureDir(trashDir);
      const dest = path.join(trashDir, `${id}.json`);
      try {
        fs.renameSync(cp, dest);
      } catch {
        // 跨设备 rename 失败时回退到 copy+unlink
        fs.copyFileSync(cp, dest);
        fs.unlinkSync(cp);
      }
    }

    bus.emit('skills.updated');
    return true;
  }

  // -----------------------------------------------------------------------
  // clearAll — 清空所有 skill
  // -----------------------------------------------------------------------
  function clearAll() {
    if (!_index) load();

    // 逐个移动缓存文件
    for (const skill of _index) {
      const cp = cacheFilePath(skill.id);
      if (fs.existsSync(cp)) {
        const trashDir = path.join(
          require('os').homedir(),
          '.openclaw',
          'trash',
          new Date().toISOString().slice(0, 10)
        );
        ensureDir(trashDir);
        const dest = path.join(trashDir, `${skill.id}.json`);
        try {
          fs.renameSync(cp, dest);
        } catch {
          try {
            fs.copyFileSync(cp, dest);
            fs.unlinkSync(cp);
          } catch {
            // 忽略单个文件失败
          }
        }
      }
    }

    _index = [];
    save();
    bus.emit('skills.updated');
  }

  // -----------------------------------------------------------------------
  // getStats — 按分类/状态分组统计
  // -----------------------------------------------------------------------
  function getStats() {
    if (!_index) load();

    const byCategory = {};
    const byStatus = {};

    for (const skill of _index) {
      const cat = skill.category || 'uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      const st = skill.status || 'unknown';
      byStatus[st] = (byStatus[st] || 0) + 1;
    }

    return {
      total: _index.length,
      byCategory,
      byStatus,
    };
  }

  // -----------------------------------------------------------------------
  // 返回接口
  // -----------------------------------------------------------------------
  return {
    load,
    getAll,
    getById,
    getByCategory,
    getByStatus,
    search,
    add,
    update,
    setStatus,
    setContent,
    getContent,
    remove,
    clearAll,
    getStats,
  };
}

module.exports = { createSkillStore };
