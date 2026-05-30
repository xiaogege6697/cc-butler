/**
 * cc-管家 — 前端逻辑
 * EventSource + REST API 驱动
 */
(function () {
  'use strict';

  // ==========================================================================
  // 常量 & DOM 引用
  // ==========================================================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    connDot: $('#connDot'),
    connText: $('#connText'),
    tokenUpdateTime: $('#tokenUpdateTime'),
    progressGrid: $('#progressGrid'),
    deploymentList: $('#deploymentList'),
    depSummary: $('#depSummary'),
    activeZone: $('#activeZone'),
    stagingZone: $('#stagingZone'),
    stagingZoneCards: $('#stagingZoneCards'),
    autoHuntToggle: $('#autoHuntToggle'),
    skillHuntBtn: $('#skillHuntBtn'),
    skillStats: $('#skillStats'),
    skillSearch: $('#skillSearch'),
    skillFilters: $('#skillFilters'),
    skillList: $('#skillList'),
    requestCount: $('#requestCount'),
    requestList: $('#requestList'),
    toastContainer: $('#toastContainer'),
    // 主题
    themeSwitcher: $('#themeSwitcher'),
    // 新增路由
    addDeployBtn: $('#addDeployBtn'),
    addDeployForm: $('#addDeployForm'),
    addDeployCancel: $('#addDeployCancel'),
    // Modal
    requestModal: $('#requestModal'),
    modalTitle: $('#modalTitle'),
    modalClose: $('#modalClose'),
    modalTabs: $('#modalTabs'),
    modalBody: $('#modalBody'),
  };

  // ==========================================================================
  // 状态
  // ==========================================================================
  let sse = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;       // 初始退避 1s
  var MAX_RECONNECT_DELAY = 30000; // 最大退避 30s
  let deployments = [];
  let tokenStatus = {};       // { [id]: { balance, totalQuota, usedQuota, percentage } }
  let requests = [];
  let config = {};
  var dragState = null;        // 拖动排序状态

  // Skill 库状态
  var skills = [];
  var skillStats = {};
  var skillFilter = { q: '', category: '' };
  var skillSearchTimer = null;

  // rAF 合并渲染标记
  var renderScheduled = false;

  // Modal 状态
  var modalState = {
    record: null,
    activeTab: 'overview',
  };

  // ==========================================================================
  // 工具函数
  // ==========================================================================

  function timeAgo(ts) {
    if (!ts) return '--';
    const diff = (Date.now() - ts) / 1000;
    if (diff < 5) return '刚刚';
    if (diff < 60) return Math.floor(diff) + '秒前';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    return Math.floor(diff / 86400) + '天前';
  }

  function formatDuration(ms) {
    if (ms == null) return '--';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function formatNumber(n) {
    if (n == null) return '--';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function statusEmoji(status) {
    if (status == null) return '😊';
    if (status >= 200 && status < 300) return '😊';
    if (status === 429) return '❄️';
    if (status >= 400 && status < 500) return '⚠️';
    return '💥';
  }

  function statusClass(status) {
    if (status == null) return '';
    if (status >= 200 && status < 300) return 'ok';
    if (status >= 400) return 'error';
    return '';
  }

  function healthDotClass(deployment) {
    if (!deployment.enabled) return 'disabled';
    if (!deployment.health) return 'healthy';
    if (!deployment.health.isHealthy) return 'unhealthy';
    return 'healthy';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==========================================================================
  // Toast
  // ==========================================================================

  function showToast(msg, duration) {
    duration = duration || 3000;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    dom.toastContainer.appendChild(el);
    setTimeout(function () {
      el.classList.add('toast--leaving');
      setTimeout(function () { el.remove(); }, 300);
    }, duration);
  }

  // ==========================================================================
  // API 调用
  // ==========================================================================

  function api(path, options) {
    options = options || {};
    return fetch('/admin' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then(function (res) {
      if (!res.ok) throw new Error('API ' + res.status);
      return res.json();
    });
  }

  // ==========================================================================
  // 渲染：Token 消耗
  // ==========================================================================

  function renderProgress() {
    // Token 消耗已整合到路由卡片中，这里只更新时间戳
    dom.tokenUpdateTime.textContent = '刚刚更新 ↻';
  }

  // ==========================================================================
  // 渲染：Deployment 双区卡片
  // ==========================================================================

  // 生成单个路由卡片 HTML（整合 Token 消耗）
  function buildDepCard(d, isStaging) {
    var dotClass = 'dep-card__health-dot--healthy';
    if (!d.enabled) dotClass = 'dep-card__health-dot--disabled';
    else if (d.health && !d.health.isHealthy) dotClass = 'dep-card__health-dot--unhealthy';

    // Token 消耗数据
    var tokenData = tokenStatus[d.id];
    var percent = 0;
    var barClass = 'dep-card__bar--gray';
    var consumedText = '暂无数据';
    if (tokenData && tokenData.percentage != null) {
      percent = Math.round(tokenData.percentage);
      var currency = '';
      if (tokenData.currency) {
        if (tokenData.currency === 'CNY' || tokenData.currency === 'cny') currency = '¥';
        else if (tokenData.currency === 'USD' || tokenData.currency === 'usd') currency = '$';
      }
      var used = tokenData.usedQuota != null ? tokenData.usedQuota.toFixed(1) : '--';
      var total = tokenData.totalQuota != null ? tokenData.totalQuota.toFixed(1) : '--';
      consumedText = currency + used + ' / ' + total;
      if (percent >= 80) barClass = 'dep-card__bar--red';
      else if (percent >= 50) barClass = 'dep-card__bar--yellow';
      else barClass = 'dep-card__bar--green';
    }

    var stagingClass = isStaging ? ' dep-card--staging' : '';
    var orderHtml = isStaging ? '' : '<span class="dep-card__order">P' + d.order + '</span>';

    return (
      '<div class="dep-card' + stagingClass + '" draggable="true" data-id="' + d.id + '" data-order="' + d.order + '" data-enabled="' + d.enabled + '">' +
        '<div class="dep-card__header">' +
          '<span class="dep-card__drag-handle" title="拖拽排序">⠿</span>' +
          '<div class="dep-card__left">' +
            '<span class="dep-card__health-dot ' + dotClass + '"></span>' +
            '<div class="dep-card__title-area">' +
              '<div class="dep-card__name">' + escapeHtml(d.name) + '</div>' +
              '<div class="dep-card__model">' + escapeHtml(d.model || d.baseUrl || '--') + '</div>' +
            '</div>' +
          '</div>' +
          orderHtml +
        '</div>' +
        '<div class="dep-card__consumption">' +
          '<div class="dep-card__consumption-info">' +
            '<span class="dep-card__consumption-label">Token 消耗</span>' +
            '<span class="dep-card__consumption-text">' + consumedText + '</span>' +
          '</div>' +
          '<div class="dep-card__bar-wrap">' +
            '<div class="dep-card__bar ' + barClass + '" style="width:' + Math.max(2, percent) + '%"></div>' +
          '</div>' +
        '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderDeployments() {
    var enabled = deployments.filter(function (d) { return d.enabled; })
      .sort(function (a, b) { return a.order - b.order; });
    var disabled = deployments.filter(function (d) { return !d.enabled; });

    // 摘要
    dom.depSummary.textContent = enabled.length + ' 活跃 · ' + disabled.length + ' 暂存';

    // 活跃区
    if (enabled.length === 0) {
      dom.activeZone.innerHTML = '<div class="empty-state" style="padding:16px"><span class="empty-state__emoji">📭</span>暂无活跃路由</div>';
    } else {
      dom.activeZone.innerHTML = enabled.map(function (d) { return buildDepCard(d, false); }).join('');
    }

    // 灰度区
    dom.stagingZoneCards.innerHTML = disabled.map(function (d) { return buildDepCard(d, true); }).join('');

    // 灰度区空状态
    var emptyEl = dom.stagingZone.querySelector('.dep-zone__empty');
    if (emptyEl) {
      emptyEl.style.display = disabled.length === 0 ? 'block' : 'none';
    }

    // 绑定拖拽
    bindDragEvents();
  }

  // ==========================================================================
  // 拖拽排序 + 跨区拖拽
  // ==========================================================================

  function bindDragEvents() {
    var cards = dom.deploymentList.querySelectorAll('.dep-card');
    cards.forEach(function (card) {
      card.addEventListener('dragstart', onDragStart);
      card.addEventListener('dragend', onDragEnd);
      card.addEventListener('dragover', onCardDragOver);
      card.addEventListener('dragleave', onCardDragLeave);
      card.addEventListener('drop', onCardDrop);
    });

    // 灰度区作为整体 drop target
    dom.stagingZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dom.stagingZone.classList.add('is-drop-target');
    });
    dom.stagingZone.addEventListener('dragleave', function (e) {
      if (!dom.stagingZone.contains(e.relatedTarget)) {
        dom.stagingZone.classList.remove('is-drop-target');
      }
    });
    dom.stagingZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dom.stagingZone.classList.remove('is-drop-target');
      if (!dragState) return;
      // 拖到灰度区 → 禁用
      var dep = deployments.find(function (d) { return d.id === dragState.id; });
      if (dep && dep.enabled) {
        toggleDeployment(dep.id, false);
      }
      dragState = null;
    });

    // 活跃区作为整体 drop target（从灰度区拖回来）
    dom.activeZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    dom.activeZone.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!dragState) return;
      var dep = deployments.find(function (d) { return d.id === dragState.id; });
      if (dep && !dep.enabled) {
        toggleDeployment(dep.id, true);
      }
      dragState = null;
    });
  }

  function onDragStart(e) {
    var card = e.currentTarget;
    dragState = { id: card.dataset.id, el: card };
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
    requestAnimationFrame(function () {
      card.classList.add('is-dragging');
    });
  }

  function onDragEnd(e) {
    e.currentTarget.classList.remove('is-dragging');
    dom.deploymentList.querySelectorAll('.is-placeholder').forEach(function (el) {
      el.classList.remove('is-placeholder');
    });
    dom.stagingZone.classList.remove('is-drop-target');
    dragState = null;
  }

  function onCardDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var target = e.currentTarget;
    if (dragState && target.dataset.id === dragState.id) return;
    dom.deploymentList.querySelectorAll('.is-placeholder').forEach(function (el) {
      if (el !== target) el.classList.remove('is-placeholder');
    });
    target.classList.add('is-placeholder');
  }

  function onCardDragLeave(e) {
    var target = e.currentTarget;
    if (!target.contains(e.relatedTarget)) {
      target.classList.remove('is-placeholder');
    }
  }

  function onCardDrop(e) {
    e.preventDefault();
    var target = e.currentTarget;
    target.classList.remove('is-placeholder');
    if (!dragState || target.dataset.id === dragState.id) return;

    var draggedId = dragState.id;
    var targetId = target.dataset.id;

    // 同区排序（两个都是 enabled 或都是 disabled）
    var dragged = deployments.find(function (d) { return d.id === draggedId; });
    var target2 = deployments.find(function (d) { return d.id === targetId; });
    if (dragged && target2 && dragged.enabled === target2.enabled) {
      if (dragged.enabled) {
        reorderActiveDeployments(draggedId, targetId);
      }
      // disabled 区不排序，忽略
    } else if (dragged && target2 && dragged.enabled !== target2.enabled) {
      // 跨区拖拽 → 切换状态
      toggleDeployment(draggedId, !dragged.enabled);
    }

    dragState = null;
  }

  function toggleDeployment(id, enable) {
    api('/deployments/' + id + '/toggle', { method: 'PATCH' })
      .then(function () {
        var dep = deployments.find(function (d) { return d.id === id; });
        if (dep) dep.enabled = enable;
        if (enable) {
          // 启用时分配到末尾 order
          var maxOrder = 0;
          deployments.forEach(function (d) { if (d.enabled && d.order > maxOrder) maxOrder = d.order; });
          if (dep) dep.order = maxOrder + 1;
        }
        renderDeployments();
        renderProgress();
        showToast(enable ? '✅ 已启用路由' : '⏸ 已暂存路由');
      })
      .catch(function (err) {
        showToast('❌ 切换失败: ' + err.message);
      });
  }

  function reorderActiveDeployments(draggedId, targetId) {
    var sorted = deployments.filter(function (d) { return d.enabled; })
      .sort(function (a, b) { return a.order - b.order; });
    var draggedIdx = sorted.findIndex(function (d) { return d.id === draggedId; });
    var targetIdx = sorted.findIndex(function (d) { return d.id === targetId; });
    if (draggedIdx === -1 || targetIdx === -1) return;

    var dragged = sorted.splice(draggedIdx, 1)[0];
    sorted.splice(targetIdx, 0, dragged);

    var updates = [];
    sorted.forEach(function (d, i) {
      var newOrder = i + 1;
      if (d.order !== newOrder) {
        d.order = newOrder;
        updates.push({ id: d.id, order: newOrder });
      }
    });

    // 同步到主数组
    sorted.forEach(function (d) {
      var main = deployments.find(function (x) { return x.id === d.id; });
      if (main) main.order = d.order;
    });

    renderDeployments();

    // 回弹动画
    var settledCard = dom.activeZone.querySelector('.dep-card[data-id="' + draggedId + '"]');
    if (settledCard) {
      settledCard.classList.add('is-settling');
      settledCard.addEventListener('animationend', function handler() {
        settledCard.classList.remove('is-settling');
        settledCard.removeEventListener('animationend', handler);
      });
    }

    // 批量持久化
    if (updates.length > 0) {
      var promises = updates.map(function (u) {
        return api('/deployments/' + u.id, {
          method: 'PUT',
          body: JSON.stringify({ order: u.order }),
        }).catch(function (err) {
          showToast('❌ 更新 order 失败: ' + err.message);
        });
      });
      Promise.all(promises).then(function () {
        showToast('✅ 优先级已更新');
      });
    }
  }

  // ==========================================================================
  // Skill 库：维度定义（前端展示用，与 skill-scorer DIMENSIONS 对齐）
  // ==========================================================================

  var SKILL_DIMENSIONS = [
    { key: 'frontmatter',         label: '元数据完整性' },
    { key: 'workflow',            label: '工作流清晰度' },
    { key: 'failureModes',        label: '失败场景覆盖' },
    { key: 'checkpoints',         label: '检查点/暂停点' },
    { key: 'specificity',         label: '指令具体性' },
    { key: 'resourceIntegration', label: '资源整合' },
    { key: 'architecture',        label: '架构质量' },
    { key: 'testPerformance',     label: '实测效果' },
    { key: 'antiPatterns',        label: '反模式规避' },
  ];

  var SKILL_STATUS_META = {
    new:      { emoji: '🆕', label: '新建' },
    installed:{ emoji: '✅', label: '已安装' },
    skipped:  { emoji: '⏭', label: '已跳过' },
    evolved:  { emoji: '🧬', label: '已进化' },
  };

  // ==========================================================================
  // Skill 库：数据加载
  // ==========================================================================

  function loadSkills() {
    var params = [];
    if (skillFilter.q) params.push('q=' + encodeURIComponent(skillFilter.q));
    if (skillFilter.category) params.push('category=' + encodeURIComponent(skillFilter.category));
    var query = params.length > 0 ? '?' + params.join('&') : '';

    return api('/skills' + query)
      .then(function (data) {
        skills = data.skills || [];
        renderSkillCards();
      })
      .catch(function (err) {
        showToast('❌ 加载 skill 失败: ' + err.message);
      });
  }

  function loadSkillStats() {
    return api('/skills/stats')
      .then(function (data) {
        skillStats = data;
        renderSkillStatsBar();
        renderSkillFilters();
      })
      .catch(function () { /* ignore */ });
  }

  // ==========================================================================
  // Skill 库：渲染
  // ==========================================================================

  function renderSkills() {
    var autoHunt = config.skillHunter && config.skillHunter.autoHunt;
    dom.autoHuntToggle.checked = !!autoHunt;

    // 绑定自动搜集 toggle
    dom.autoHuntToggle.onchange = function () {
      var enabled = this.checked;
      api('/config', {
        method: 'PUT',
        body: JSON.stringify({ skillHunter: Object.assign({}, config.skillHunter || {}, { autoHunt: enabled }) }),
      })
        .then(function () {
          showToast(enabled ? '✅ 自动搜集已开启' : '⏹ 自动搜集已关闭');
        })
        .catch(function (err) {
          showToast('❌ 设置失败: ' + err.message);
        });
    };

    // 绑定手动搜集按钮
    dom.skillHuntBtn.onclick = function () {
      var btn = dom.skillHuntBtn;
      btn.classList.add('is-loading');
      btn.textContent = '🔍 搜集中...';
      api('/skills/hunt', { method: 'POST' })
        .then(function (result) {
          var count = (result && result.discovered) || 0;
          showToast('✅ 搜集完成，发现 ' + count + ' 个新 skill');
          loadSkillStats();
          loadSkills();
        })
        .catch(function (err) {
          showToast('❌ 搜集失败: ' + err.message);
        })
        .finally(function () {
          btn.classList.remove('is-loading');
          btn.textContent = '🔍 手动搜集';
        });
    };

    // 绑定搜索输入（防抖）
    dom.skillSearch.value = skillFilter.q;
    dom.skillSearch.oninput = function () {
      clearTimeout(skillSearchTimer);
      var val = this.value.trim();
      skillSearchTimer = setTimeout(function () {
        skillFilter.q = val;
        loadSkills();
      }, 300);
    };

    // 加载数据
    loadSkillStats();
    loadSkills();
  }

  // 统计条
  function renderSkillStatsBar() {
    var total = skillStats.total || 0;
    var byStatus = skillStats.byStatus || {};
    var installed = byStatus.installed || 0;
    var evaluated = 0;
    // 统计已评估的 skill（通过 loadSkills 的数据推算，stats API 没有这个字段）
    // 用 local skills 数据来补
    skills.forEach(function (s) { if (s.score != null) evaluated++; });

    dom.skillStats.innerHTML =
      '<span class="skill-stats__item">📦 总计 <span class="skill-stats__value">' + total + '</span></span>' +
      '<span class="skill-stats__item">✅ 已安装 <span class="skill-stats__value">' + installed + '</span></span>' +
      '<span class="skill-stats__item">🆕 新发现 <span class="skill-stats__value">' + (byStatus.new || 0) + '</span></span>';
  }

  // 分类筛选按钮
  function renderSkillFilters() {
    var byCategory = skillStats.byCategory || {};
    var categories = Object.keys(byCategory).sort();
    if (categories.length === 0) {
      dom.skillFilters.innerHTML = '';
      return;
    }

    // "全部" 按钮
    var html = '<button class="skill-filters__btn' + (skillFilter.category === '' ? ' is-active' : '') + '" data-cat="">全部</button>';
    categories.forEach(function (cat) {
      var isActive = skillFilter.category === cat;
      html += '<button class="skill-filters__btn' + (isActive ? ' is-active' : '') + '" data-cat="' + escapeHtml(cat) + '">' +
        escapeHtml(cat) + ' <span style="opacity:0.6">(' + byCategory[cat] + ')</span></button>';
    });
    dom.skillFilters.innerHTML = html;

    // 绑定点击
    dom.skillFilters.querySelectorAll('.skill-filters__btn').forEach(function (btn) {
      btn.onclick = function () {
        skillFilter.category = this.dataset.cat || '';
        loadSkills();
      };
    });
  }

  // Skill 卡片列表
  function renderSkillCards() {
    if (skills.length === 0) {
      dom.skillList.innerHTML =
        '<div class="skill-placeholder">' +
          '<span class="skill-placeholder__emoji">🔍</span>' +
          '<div>Skill 猎手正在搜寻中...</div>' +
          '<div style="font-size:12px;margin-top:4px;color:var(--text-dim)">关注 claude-code skill / mcp 生态</div>' +
        '</div>';
      return;
    }

    dom.skillList.innerHTML = skills.map(function (s) {
      return renderSkillCard(s);
    }).join('');

    // 更新统计条中的已评估数
    renderSkillStatsBar();
  }

  function scoreLevel(score) {
    if (score >= 70) return 'high';
    if (score >= 40) return 'mid';
    return 'low';
  }

  function renderSkillCard(skill) {
    var statusMeta = SKILL_STATUS_META[skill.status] || SKILL_STATUS_META.new;
    var catTag = skill.category
      ? '<span class="skill-card__tag">' + escapeHtml(skill.category) + '</span>'
      : '';
    var tags = (skill.tags || []).map(function (t) {
      return '<span class="skill-card__tag">' + escapeHtml(t) + '</span>';
    }).join('');

    // 分数条
    var scoreHtml = '';
    if (skill.score != null) {
      var level = scoreLevel(skill.score);
      scoreHtml =
        '<div class="skill-card__score-wrap">' +
          '<div class="skill-card__score-bar"><div class="skill-card__score-fill skill-card__score-fill--' + level + '" style="width:' + skill.score + '%"></div></div>' +
          '<span class="skill-card__score-num skill-card__score-num--' + level + '">' + skill.score + '</span>' +
        '</div>';
    }

    // 操作按钮（阻止冒泡避免触发展开）
    var actionsHtml =
      '<div class="skill-card__actions">' +
        '<button class="btn btn--evaluate" data-action="evaluate" data-id="' + escapeHtml(skill.id) + '">🔍 评估</button>' +
        '<button class="btn btn--install" data-action="install" data-id="' + escapeHtml(skill.id) + '">📥 安装</button>' +
        '<button class="btn btn--delete" data-action="delete" data-id="' + escapeHtml(skill.id) + '">🗑 删除</button>' +
      '</div>';

    return (
      '<div class="skill-card" data-id="' + escapeHtml(skill.id) + '">' +
        '<div class="skill-card__header">' +
          '<div class="skill-card__title-area">' +
            '<span class="skill-card__name">' + escapeHtml(skill.name) + '</span>' +
            '<span class="skill-card__description">' + escapeHtml(skill.description || '') + '</span>' +
          '</div>' +
          '<span class="skill-card__status skill-card__status--' + escapeHtml(skill.status) + '">' +
            statusMeta.emoji + ' ' + statusMeta.label +
          '</span>' +
        '</div>' +
        (catTag || tags ? '<div class="skill-card__tags">' + catTag + tags + '</div>' : '') +
        scoreHtml +
        actionsHtml +
        '<div class="skill-card__breakdown" id="breakdown-' + escapeHtml(skill.id) + '"></div>' +
      '</div>'
    );
  }

  // 展开/收起分数维度详情
  function toggleSkillBreakdown(skillId) {
    var container = document.getElementById('breakdown-' + skillId);
    if (!container) return;

    // 如果已展开则收起
    if (container.classList.contains('is-visible')) {
      container.classList.remove('is-visible');
      return;
    }

    // 先查本地缓存
    var skill = skills.find(function (s) { return s.id === skillId; });
    if (skill && skill.scoreBreakdown && Object.keys(skill.scoreBreakdown).length > 0) {
      renderBreakdown(container, skill.scoreBreakdown);
      container.classList.add('is-visible');
      return;
    }

    // 否则从 API 获取详情
    container.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">加载中...</div>';
    container.classList.add('is-visible');

    api('/skills/' + skillId)
      .then(function (detail) {
        // 回填到本地缓存
        if (skill) {
          skill.scoreBreakdown = detail.scoreBreakdown || {};
          skill.content = detail.content;
        }
        if (detail.scoreBreakdown && Object.keys(detail.scoreBreakdown).length > 0) {
          renderBreakdown(container, detail.scoreBreakdown);
        } else {
          container.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">暂无评估数据，请先评估此 skill</div>';
        }
      })
      .catch(function (err) {
        container.innerHTML = '<div style="font-size:12px;color:var(--accent-red);padding:4px 0;">加载失败: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function renderBreakdown(container, breakdown) {
    var rows = SKILL_DIMENSIONS.map(function (dim) {
      var entry = breakdown[dim.key];
      if (!entry) return '';
      var score = entry.score || 0;
      var max = entry.max || 1;
      var pct = Math.round((score / max) * 100);
      var level = scoreLevel(pct);
      return (
        '<div class="skill-card__breakdown-row">' +
          '<span class="skill-card__breakdown-label">' + dim.label + '</span>' +
          '<div class="skill-card__breakdown-bar"><div class="skill-card__breakdown-fill skill-card__breakdown-fill--' + level + '" style="width:' + pct + '%"></div></div>' +
          '<span class="skill-card__breakdown-score skill-card__breakdown-score--' + level + '">' + score + '/' + max + '</span>' +
        '</div>'
      );
    }).join('');

    container.innerHTML =
      '<div class="skill-card__breakdown-title">📊 维度评分</div>' +
      rows;
  }

  // ==========================================================================
  // Skill 库：事件委托（卡片点击 + 操作按钮）
  // ==========================================================================

  dom.skillList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      var action = btn.dataset.action;
      var id = btn.dataset.id;
      if (action === 'evaluate') handleSkillEvaluate(id, btn);
      else if (action === 'install') handleSkillInstall(id, btn);
      else if (action === 'delete') handleSkillDelete(id, btn);
      return;
    }

    // 点击卡片展开/收起
    var card = e.target.closest('.skill-card');
    if (card) {
      toggleSkillBreakdown(card.dataset.id);
    }
  });

  function handleSkillEvaluate(id, btn) {
    btn.classList.add('is-loading');
    btn.textContent = '🔍 评估中...';
    api('/skills/' + id + '/evaluate', { method: 'POST' })
      .then(function (result) {
        showToast('✅ 评估完成: ' + (result.score || '--') + ' 分');
        // 更新本地数据
        var skill = skills.find(function (s) { return s.id === id; });
        if (skill && result) {
          skill.score = result.score;
          skill.scoreBreakdown = result.breakdown || {};
        }
        renderSkillCards();
        renderSkillStatsBar();
      })
      .catch(function (err) {
        showToast('❌ 评估失败: ' + err.message);
      })
      .finally(function () {
        btn.classList.remove('is-loading');
        btn.textContent = '🔍 评估';
      });
  }

  function handleSkillInstall(id, btn) {
    btn.classList.add('is-loading');
    btn.textContent = '📥 安装中...';
    api('/skills/' + id + '/install', { method: 'POST' })
      .then(function (result) {
        showToast('✅ 已安装: ' + (result.installPath || ''));
        var skill = skills.find(function (s) { return s.id === id; });
        if (skill) {
          skill.status = 'installed';
          skill.installedAt = result.installedAt || Date.now();
          skill.installPath = result.installPath || null;
        }
        renderSkillCards();
        renderSkillStatsBar();
      })
      .catch(function (err) {
        showToast('❌ 安装失败: ' + err.message);
      })
      .finally(function () {
        btn.classList.remove('is-loading');
        btn.textContent = '📥 安装';
      });
  }

  function handleSkillDelete(id, btn) {
    if (!confirm('确定删除此 skill？')) return;
    btn.classList.add('is-loading');
    btn.textContent = '🗑 删除中...';
    api('/skills/' + id, { method: 'DELETE' })
      .then(function () {
        showToast('🗑 已删除');
        skills = skills.filter(function (s) { return s.id !== id; });
        renderSkillCards();
        loadSkillStats();
      })
      .catch(function (err) {
        showToast('❌ 删除失败: ' + err.message);
      })
      .finally(function () {
        btn.classList.remove('is-loading');
        btn.textContent = '🗑 删除';
      });
  }

  // ==========================================================================
  // 渲染：请求列表（增量更新）
  // ==========================================================================

  // id → DOM element 缓存
  var requestElCache = new Map();

  function renderRequests() {
    dom.requestCount.textContent = requests.length + ' 条';

    if (requests.length === 0) {
      dom.requestList.innerHTML = '<div class="empty-state"><span class="empty-state__emoji">📭</span>暂无请求</div>';
      requestElCache.clear();
      return;
    }

    // 移除不在当前数据中的缓存元素
    var currentIds = new Set(requests.map(function (r) { return r.id; }));
    requestElCache.forEach(function (el, id) {
      if (!currentIds.has(id)) {
        el.remove();
        requestElCache.delete(id);
      }
    });

    // 构建已有 id 集合，用于判断新增
    var existingIds = new Set(requestElCache.keys());

    requests.forEach(function (r, index) {
      var dur = r.endedAt ? formatDuration(r.endedAt - r.startedAt) : '...';
      var sc = statusClass(r.status);
      var emoji = statusEmoji(r.status);
      var method = r.method || '--';
      var path = r.path || '--';
      var depName = r.deploymentName || '--';

      if (existingIds.has(r.id)) {
        // 增量更新：只修改变化的属性
        var el = requestElCache.get(r.id);
        var methodEl = el.querySelector('.request-item__method');
        var pathEl = el.querySelector('.request-item__path');
        var statusEl = el.querySelector('.request-item__status');
        var durationEl = el.querySelector('.request-item__duration');
        var deploymentEl = el.querySelector('.request-item__deployment');

        if (methodEl) methodEl.textContent = method;
        if (pathEl) pathEl.textContent = path;
        if (statusEl) {
          statusEl.className = 'request-item__status request-item__status--' + sc;
          statusEl.textContent = emoji + ' ' + (r.status || '--');
        }
        if (durationEl) durationEl.textContent = dur;
        if (deploymentEl) deploymentEl.textContent = depName;
      } else {
        // 新增记录
        var itemEl = document.createElement('div');
        itemEl.className = 'request-item';
        itemEl.dataset.id = r.id;
        itemEl.innerHTML =
          '<span class="request-item__method">' + method + '</span>' +
          '<span class="request-item__path">' + escapeHtml(path) + '</span>' +
          '<span class="request-item__status request-item__status--' + sc + '">' + emoji + ' ' + (r.status || '--') + '</span>' +
          '<span class="request-item__duration">' + dur + '</span>' +
          '<span class="request-item__deployment">' + escapeHtml(depName) + '</span>';

        // 点击打开 Modal
        itemEl.addEventListener('click', function () {
          openRequestModal(r.id);
        });

        requestElCache.set(r.id, itemEl);

        // 新增记录 prepend 到列表头部
        if (dom.requestList.firstChild) {
          dom.requestList.insertBefore(itemEl, dom.requestList.firstChild);
        } else {
          dom.requestList.appendChild(itemEl);
        }
      }
    });
  }

  // ==========================================================================
  // 请求详情 Modal
  // ==========================================================================

  function openRequestModal(id) {
    // 从本地缓存找记录
    var record = requests.find(function (r) { return r.id === id; });
    if (!record) {
      showToast('❌ 找不到请求 #' + id);
      return;
    }

    // 如果记录还没结束，从 API 获取完整数据
    if (!record.endedAt) {
      api('/requests/' + id)
        .then(function (full) {
          modalState.record = full;
          modalState.activeTab = 'overview';
          renderModal();
        })
        .catch(function () {
          modalState.record = record;
          modalState.activeTab = 'overview';
          renderModal();
        });
    } else {
      modalState.record = record;
      modalState.activeTab = 'overview';
      renderModal();
    }
  }

  function renderModal() {
    var r = modalState.record;
    if (!r) return;

    // 标题
    dom.modalTitle.innerHTML = '📡 请求 #' + r.id;

    // 渲染 Tab 面板
    dom.modalBody.innerHTML =
      '<div class="modal-tab-panel' + (modalState.activeTab === 'overview' ? ' is-visible' : '') + '" data-panel="overview">' +
        renderOverview(r) +
      '</div>' +
      '<div class="modal-tab-panel' + (modalState.activeTab === 'request' ? ' is-visible' : '') + '" data-panel="request">' +
        renderJsonPanel(r.reqBody, '请求体') +
      '</div>' +
      '<div class="modal-tab-panel' + (modalState.activeTab === 'response' ? ' is-visible' : '') + '" data-panel="response">' +
        renderJsonPanel(r.resBody, '响应体') +
      '</div>' +
      '<div class="modal-tab-panel' + (modalState.activeTab === 'headers' ? ' is-visible' : '') + '" data-panel="headers">' +
        renderHeadersPanel(r) +
      '</div>';

    // 高亮当前 Tab
    dom.modalTabs.querySelectorAll('.modal__tab').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.tab === modalState.activeTab);
    });

    // 显示 Modal
    dom.requestModal.classList.add('is-visible');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    dom.requestModal.classList.remove('is-visible');
    document.body.style.overflow = '';
    modalState.record = null;
  }

  function switchTab(tabName) {
    modalState.activeTab = tabName;
    dom.modalBody.querySelectorAll('.modal-tab-panel').forEach(function (panel) {
      panel.classList.toggle('is-visible', panel.dataset.panel === tabName);
    });
    dom.modalTabs.querySelectorAll('.modal__tab').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.tab === tabName);
    });
  }

  // 概览 Tab
  function renderOverview(r) {
    var dur = r.endedAt ? formatDuration(r.endedAt - r.startedAt) : '进行中...';
    var sc = statusClass(r.status);
    var statusLabel = r.status ? (r.status + ' ' + statusEmoji(r.status)) : '⏳';

    // 指标卡片
    var cards =
      '<div class="overview-grid">' +
        overviewCard('🎯 路由', escapeHtml(r.deploymentName || '--'), '', '') +
        overviewCard('⏱ 耗时', dur, '', '') +
        overviewCard('📊 状态', statusLabel, 'overview-card__value--' + (sc || 'warn'), '') +
        overviewCard('🕐 时间', r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '--',
          '', r.startedAt ? new Date(r.startedAt).toLocaleDateString() : '') +
      '</div>';

    // 标签
    var tags = '<div class="overview-tags">';
    tags += '<span class="overview-tag overview-tag--' + (r.isStream ? 'stream' : 'non-stream') + '">' +
      (r.isStream ? '⚡ 流式' : '📦 非流式') + '</span>';
    if (r.error) {
      tags += '<span class="overview-tag overview-tag--error">❌ 错误</span>';
    }
    tags += '</div>';

    // 模型流向
    var modelHtml = '';
    if (r.modelRequested || r.modelServed || r.modelOverride) {
      modelHtml = '<div class="model-flow">' +
        '<span class="model-flow__label">模型</span>' +
        '<span class="model-flow__name">' + escapeHtml(r.modelRequested || '未指定') + '</span>';
      if (r.modelOverride) {
        modelHtml += '<span class="model-flow__arrow">→</span>' +
          '<span class="model-flow__override">覆盖: ' + escapeHtml(r.modelOverride) + '</span>';
      }
      if (r.modelServed && r.modelServed !== r.modelRequested) {
        modelHtml += '<span class="model-flow__arrow">→</span>' +
          '<span class="model-flow__name">' + escapeHtml(r.modelServed) + '</span>';
      }
      modelHtml += '</div>';
    }

    // Token 条形图
    var tokenHtml = renderTokenBars(r);

    // 错误信息
    var errorHtml = '';
    if (r.error) {
      errorHtml = '<div class="truncate-notice" style="border-color:rgba(255,71,87,0.3);background:rgba(255,71,87,0.06);color:var(--accent-red);text-align:left">' +
        '💬 ' + escapeHtml(r.error) + '</div>';
    }

    return cards + tags + modelHtml + tokenHtml + errorHtml;
  }

  function overviewCard(label, value, valueClass, sub) {
    return '<div class="overview-card">' +
      '<span class="overview-card__label">' + label + '</span>' +
      '<span class="overview-card__value ' + valueClass + '">' + value + '</span>' +
      (sub ? '<span class="overview-card__sub">' + sub + '</span>' : '') +
    '</div>';
  }

  function renderTokenBars(r) {
    var items = [];
    if (r.inputTokens != null) items.push({ label: '📥 Input', value: r.inputTokens, cls: 'input' });
    if (r.outputTokens != null) items.push({ label: '📤 Output', value: r.outputTokens, cls: 'output' });
    if (r.cacheReadTokens != null) items.push({ label: '⚡ Cache Read', value: r.cacheReadTokens, cls: 'cache-read' });
    if (r.cacheCreationTokens != null) items.push({ label: '💾 Cache Write', value: r.cacheCreationTokens, cls: 'cache-write' });

    if (items.length === 0) return '';

    var maxVal = Math.max.apply(null, items.map(function (it) { return it.value; })) || 1;

    var bars = items.map(function (it) {
      var pct = Math.max(2, Math.round((it.value / maxVal) * 100));
      return '<div class="token-bar-row">' +
        '<span class="token-bar-row__label">' + it.label + '</span>' +
        '<div class="token-bar-row__bar-wrap">' +
          '<div class="token-bar-row__bar token-bar-row__bar--' + it.cls + '" style="width:' + pct + '%"></div>' +
        '</div>' +
        '<span class="token-bar-row__value">' + formatNumber(it.value) + '</span>' +
      '</div>';
    }).join('');

    return '<div class="token-bars">' +
      '<div class="token-bars__title">Token 用量</div>' +
      bars +
    '</div>';
  }

  // 请求体 / 响应体 Tab
  function renderJsonPanel(data, label) {
    if (data == null) {
      return '<div class="json-viewer__empty">📭 无' + label + '数据</div>';
    }

    var formatted;
    try {
      // 处理 express.raw() 存储的 Buffer 对象 { type: "Buffer", data: [...] }
      if (data && typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data)) {
        var bytes = new Uint8Array(data.data);
        var str = new TextDecoder().decode(bytes);
        try { data = JSON.parse(str); } catch (e) { data = str; }
      }
      if (typeof data === 'string') {
        // 尝试 JSON.parse 后格式化
        try { data = JSON.parse(data); } catch (e) { /* 保持原样 */ }
      }
      if (typeof data === 'object') {
        formatted = syntaxHighlightJSON(data);
      } else {
        formatted = escapeHtml(String(data));
      }
    } catch (e) {
      formatted = escapeHtml(String(data));
    }

    // 截断检查
    var notice = '';
    if (formatted.length > 50000) {
      formatted = formatted.slice(0, 50000);
      notice = '<div class="truncate-notice">⚠️ 内容过大，仅显示前 50,000 字符</div>';
    }

    return '<div class="json-viewer">' + formatted + '</div>' + notice;
  }

  // Headers Tab
  function renderHeadersPanel(r) {
    var reqHtml = renderHeadersTable(r.reqHeaders, '请求头');
    var resHtml = renderHeadersTable(r.resHeaders, '响应头');
    return '<div class="headers-grid">' +
      '<div>' +
        '<div class="headers-section__title">📨 请求头</div>' +
        reqHtml +
      '</div>' +
      '<div>' +
        '<div class="headers-section__title">📬 响应头</div>' +
        resHtml +
      '</div>' +
    '</div>';
  }

  function renderHeadersTable(headers, label) {
    if (!headers || Object.keys(headers).length === 0) {
      return '<div class="json-viewer__empty">无' + label + '</div>';
    }
    var rows = Object.keys(headers).map(function (key) {
      return '<tr><td>' + escapeHtml(key) + '</td><td>' + escapeHtml(String(headers[key])) + '</td></tr>';
    }).join('');
    return '<table class="headers-table">' + rows + '</table>';
  }

  // JSON 语法高亮
  function syntaxHighlightJSON(obj) {
    var json = JSON.stringify(obj, null, 2);
    // 转义 HTML
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 高亮
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|\bnull\b)/g,
      function (match) {
        var cls = 'json-viewer__number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'json-viewer__key';
          } else {
            cls = 'json-viewer__string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'json-viewer__boolean';
        } else if (/null/.test(match)) {
          cls = 'json-viewer__null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  // ==========================================================================
  // Modal 事件绑定
  // ==========================================================================

  function initModal() {
    // 关闭按钮
    dom.modalClose.addEventListener('click', closeModal);

    // 点击遮罩关闭
    dom.requestModal.addEventListener('click', function (e) {
      if (e.target === dom.requestModal) closeModal();
    });

    // ESC 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dom.requestModal.classList.contains('is-visible')) {
        closeModal();
      }
    });

    // Tab 切换
    dom.modalTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.modal__tab');
      if (tab && tab.dataset.tab) {
        switchTab(tab.dataset.tab);
      }
    });
  }

  // ==========================================================================
  // 刷新按钮
  // ==========================================================================

  function initRefresh() {
    dom.tokenUpdateTime.addEventListener('click', function () {
      dom.tokenUpdateTime.style.opacity = '0.5';
      dom.tokenUpdateTime.style.pointerEvents = 'none';
      Promise.all([
        loadDeployments(),
        loadRequests(),
        loadConfig(),
      ]).finally(function () {
        setTimeout(function () {
          dom.tokenUpdateTime.style.opacity = '';
          dom.tokenUpdateTime.style.pointerEvents = '';
        }, 500);
      });
    });
  }

  // ==========================================================================
  // 主题切换
  // ==========================================================================

  function initTheme() {
    var saved = localStorage.getItem('cc-butler-theme') || 'bright';
    applyTheme(saved);

    dom.themeSwitcher.addEventListener('click', function (e) {
      var btn = e.target.closest('.theme-btn');
      if (!btn) return;
      applyTheme(btn.dataset.theme);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cc-butler-theme', theme);
    // 高亮当前按钮
    dom.themeSwitcher.querySelectorAll('.theme-btn').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.theme === theme);
    });
  }

  // ==========================================================================
  // 新增路由
  // ==========================================================================

  function initAddDeploy() {
    dom.addDeployBtn.addEventListener('click', function () {
      dom.addDeployBtn.style.display = 'none';
      dom.addDeployForm.classList.add('is-visible');
      dom.addDeployForm.querySelector('input[name="name"]').focus();
    });

    dom.addDeployCancel.addEventListener('click', function () {
      dom.addDeployForm.classList.remove('is-visible');
      dom.addDeployBtn.style.display = '';
      dom.addDeployForm.reset();
    });

    dom.addDeployForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(dom.addDeployForm);
      var name = (fd.get('name') || '').trim();
      var apiKey = (fd.get('apiKey') || '').trim();
      if (!name || !apiKey) {
        showToast('❌ 名称和 API Key 不能为空');
        return;
      }

      var body = {
        name: name,
        baseUrl: (fd.get('baseUrl') || '').trim(),
        apiKey: apiKey,
        model: (fd.get('model') || '').trim(),
      };

      api('/deployments', {
        method: 'POST',
        body: JSON.stringify(body),
      })
        .then(function () {
          showToast('✅ 已添加路由: ' + name);
          dom.addDeployForm.classList.remove('is-visible');
          dom.addDeployBtn.style.display = '';
          dom.addDeployForm.reset();
          loadDeployments();
        })
        .catch(function (err) {
          showToast('❌ 添加失败: ' + err.message);
        });
    });
  }

  // ==========================================================================
  // SSE 连接
  // ==========================================================================

  // rAF 合并渲染：SSE 事件只更新 state，用 requestAnimationFrame 合并到下一帧统一渲染
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function () {
      renderScheduled = false;
      renderRequests();
    });
  }

  function connectSSE() {
    if (sse) {
      sse.close();
    }

    sse = new EventSource('/events');

    sse.addEventListener('connected', function () {
      // 连接成功，重置退避
      reconnectDelay = 1000;
      updateConnectionStatus('connected');
      showToast('✅ SSE 已连接');
    });

    sse.addEventListener('request.start', function (e) {
      try {
        var record = JSON.parse(e.data);
        // 插入到列表头部
        var idx = requests.findIndex(function (r) { return r.id === record.id; });
        if (idx === -1) {
          requests.unshift(record);
        } else {
          requests[idx] = record;
        }
        // 保持最多 50 条
        if (requests.length > 50) requests.length = 50;
        scheduleRender();
      } catch (err) { /* ignore */ }
    });

    sse.addEventListener('request.end', function (e) {
      try {
        var record = JSON.parse(e.data);
        var idx = requests.findIndex(function (r) { return r.id === record.id; });
        if (idx !== -1) {
          requests[idx] = record;
        } else {
          requests.unshift(record);
        }
        scheduleRender();
      } catch (err) { /* ignore */ }
    });

    sse.addEventListener('deployment.changed', function () {
      // deployment 变更，重新加载
      loadDeployments();
    });

    sse.addEventListener('deployments.updated', function () {
      loadDeployments();
    });

    sse.addEventListener('deployment.cooldown', function (e) {
      try {
        var data = JSON.parse(e.data);
        showToast('❄️ Deployment ' + (data.id || '') + ' 进入冷却');
      } catch (err) { /* ignore */ }
      loadDeployments();
    });

    sse.addEventListener('deployment.recovered', function (e) {
      try {
        var data = JSON.parse(e.data);
        showToast('✅ Deployment ' + (data.id || '') + ' 已恢复');
      } catch (err) { /* ignore */ }
      loadDeployments();
    });

    sse.addEventListener('records.cleared', function () {
      requests = [];
      renderRequests();
      showToast('🗑 请求历史已清空');
    });

    // Skill 库 SSE 事件
    sse.addEventListener('skill.discovered', function (e) {
      try {
        var skill = JSON.parse(e.data);
        // 检查是否已存在
        var exists = skills.some(function (s) { return s.id === skill.id; });
        if (!exists) {
          skills.unshift(skill);
          renderSkillCards();
          renderSkillStatsBar();
          showToast('🆕 新 skill: ' + (skill.name || skill.id));
        }
      } catch (err) { /* ignore */ }
    });

    sse.addEventListener('skill.evaluated', function (e) {
      try {
        var data = JSON.parse(e.data);
        var skill = skills.find(function (s) { return s.id === data.id; });
        if (skill) {
          skill.score = data.score;
          skill.scoreBreakdown = data.breakdown || skill.scoreBreakdown;
        }
        renderSkillCards();
      } catch (err) { /* ignore */ }
    });

    sse.addEventListener('skill.installed', function (e) {
      try {
        var data = JSON.parse(e.data);
        var skill = skills.find(function (s) { return s.id === data.id; });
        if (skill) {
          skill.status = 'installed';
          skill.installedAt = data.installedAt || Date.now();
          skill.installPath = data.installPath || null;
        }
        renderSkillCards();
        renderSkillStatsBar();
      } catch (err) { /* ignore */ }
    });

    sse.addEventListener('skill.evolved', function (e) {
      try {
        var data = JSON.parse(e.data);
        // 进化可能产生新 skill，重新加载整个列表
        loadSkills();
        loadSkillStats();
      } catch (err) { /* ignore */ }
    });

    sse.onerror = function () {
      updateConnectionStatus('disconnected');
      sse.close();
      sse = null;
      // 指数退避重连 + resync 全量数据
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function () {
        loadDeployments();
        loadRequests();
        loadSkillStats();
        loadSkills();
        connectSSE();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    };
  }

  function updateConnectionStatus(status) {
    dom.connDot.className = 'top-bar__dot';
    if (status === 'connected') {
      dom.connDot.classList.add('top-bar__dot--connected');
      dom.connText.textContent = '已连接';
    } else if (status === 'disconnected') {
      dom.connDot.classList.add('top-bar__dot--disconnected');
      dom.connText.textContent = '已断开';
    } else {
      dom.connText.textContent = '连接中...';
    }
  }

  // ==========================================================================
  // 数据加载
  // ==========================================================================

  function loadDeployments() {
    // 并行加载 deployment 列表和 token 余额
    Promise.all([
      api('/deployments'),
      api('/token/status').catch(function () { return { deployments: {} }; }),
    ])
      .then(function (results) {
        var depData = results[0];
        var tokenData = results[1];
        deployments = depData.deployments || [];
        tokenStatus = tokenData.deployments || {};
        renderDeployments();
        renderProgress();
      })
      .catch(function (err) {
        showToast('❌ 加载 deployment 失败: ' + err.message);
      });
  }

  function loadRequests() {
    api('/requests?limit=30')
      .then(function (data) {
        requests = data.requests || [];
        renderRequests();
      })
      .catch(function (err) {
        showToast('❌ 加载请求历史失败: ' + err.message);
      });
  }

  function loadConfig() {
    api('/config')
      .then(function (data) {
        config = data;
        renderSkills();
      })
      .catch(function (err) {
        showToast('❌ 加载配置失败: ' + err.message);
      });
  }

  // ==========================================================================
  // 初始化
  // ==========================================================================

  function init() {
    updateConnectionStatus('connecting');
    initTheme();
    initModal();
    initAddDeploy();
    initRefresh();
    loadDeployments();
    loadRequests();
    loadConfig();
    connectSSE();
  }

  // DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
