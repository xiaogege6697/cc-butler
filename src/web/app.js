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
    autoHuntToggle: $('#autoHuntToggle'),
    skillHuntBtn: $('#skillHuntBtn'),
    skillStats: $('#skillStats'),
    skillSearch: $('#skillSearch'),
    skillFilters: $('#skillFilters'),
    skillList: $('#skillList'),
    requestCount: $('#requestCount'),
    requestList: $('#requestList'),
    toastContainer: $('#toastContainer'),
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
  // 渲染：Token 进度条
  // ==========================================================================

  function renderProgress() {
    // 目前没有独立的 token 余额 API，从 deployment health 状态推断
    // 用 deployment 的健康状态来展示
    if (deployments.length === 0) {
      dom.progressGrid.innerHTML = '<div class="empty-state"><span class="empty-state__emoji">📭</span>暂无 deployment</div>';
      return;
    }

    dom.progressGrid.innerHTML = deployments.map(function (d) {
      var emoji = d.enabled ? '🟢' : '🔴';
      var barClass = 'progress-card__bar--green';
      // 用 order 作为伪进度值展示（实际项目中替换为真实 token 数据）
      var percent = Math.max(0, Math.min(100, 100 - (d.order - 1) * 20));
      if (percent < 40) barClass = 'progress-card__bar--red';
      else if (percent < 70) barClass = 'progress-card__bar--yellow';

      var statusText = '';
      if (!d.enabled) {
        statusText = '已禁用';
        barClass = 'progress-card__bar--red';
      } else if (d.health && !d.health.isHealthy) {
        statusText = '冷却中 ❄️';
        barClass = 'progress-card__bar--yellow';
      } else {
        statusText = '正常 😊';
      }

      return (
        '<div class="card progress-card">' +
          '<div class="progress-card__header">' +
            '<span class="progress-card__name">' + emoji + ' ' + escapeHtml(d.name) + '</span>' +
            '<span class="progress-card__percent" style="color:var(--accent-' + (barClass.includes('green') ? 'green' : barClass.includes('yellow') ? 'yellow' : 'red') + ')">' +
              statusText +
            '</span>' +
          '</div>' +
          '<div class="progress-card__bar-wrap">' +
            '<div class="progress-card__bar ' + barClass + '" style="width:' + percent + '%"></div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    dom.tokenUpdateTime.textContent = '刚刚更新 ↻';
  }

  // ==========================================================================
  // 渲染：Deployment 可拖动卡片
  // ==========================================================================

  function renderDeployments() {
    if (deployments.length === 0) {
      dom.deploymentList.innerHTML = '<div class="empty-state"><span class="empty-state__emoji">📭</span>暂无 deployment</div>';
      return;
    }

    // 按 order 排序
    var sorted = deployments.slice().sort(function (a, b) { return a.order - b.order; });

    dom.deploymentList.innerHTML = sorted.map(function (d, index) {
      // 健康指示器 emoji
      var healthEmoji = '';
      if (!d.enabled) healthEmoji = '💤';
      else if (d.health && !d.health.isHealthy) healthEmoji = '❄️';
      else if (d.health && d.health.consecutiveFailures > 0) healthEmoji = '⚠️';
      else healthEmoji = '🟢';

      // token 余额进度条
      var tokenData = tokenStatus[d.id];
      var percent = 0;
      var barClass = 'dep-card__bar--gray';
      var balanceText = '无余额数据';
      var hasData = false;

      if (tokenData && tokenData.percentage != null) {
        percent = Math.round(tokenData.percentage);
        hasData = true;
        balanceText = (tokenData.usedQuota != null && tokenData.totalQuota != null)
          ? tokenData.usedQuota.toFixed(1) + ' / ' + tokenData.totalQuota.toFixed(1)
          : percent + '%';
      } else if (tokenData && tokenData.balance != null) {
        hasData = true;
        percent = Math.min(100, Math.max(0, Math.round(tokenData.balance)));
        balanceText = '余额 ' + tokenData.balance.toFixed(1);
      }

      // 色彩逻辑：percent 是已用百分比，越高越危险
      if (hasData) {
        if (percent >= 80) barClass = 'dep-card__bar--red';
        else if (percent >= 50) barClass = 'dep-card__bar--yellow';
        else barClass = 'dep-card__bar--green';
      }

      if (!d.enabled) {
        barClass = 'dep-card__bar--red';
      }

      // 颜色值用于百分比文字
      var percentColor = barClass.includes('green') ? 'var(--accent-green)'
        : barClass.includes('yellow') ? 'var(--accent-yellow)'
        : barClass.includes('gray') ? 'var(--text-dim)' : 'var(--accent-red)';

      // 货币符号
      var currencyHtml = '';
      if (tokenData && tokenData.currency) {
        var symbol = tokenData.currency;
        if (tokenData.currency === 'CNY' || tokenData.currency === 'cny') symbol = '¥';
        else if (tokenData.currency === 'USD' || tokenData.currency === 'usd') symbol = '$';
        currencyHtml = '<span class="dep-card__currency">' + symbol + '</span>';
      }

      // 套餐标签
      var planHtml = '';
      if (tokenData && tokenData.plan) {
        planHtml = '<span class="dep-card__plan-tag">' + escapeHtml(tokenData.plan) + '</span>';
      }

      // 刷新倒计时
      var resetHtml = '';
      if (tokenData && tokenData.resetAt) {
        var resetTime = new Date(tokenData.resetAt);
        var now = new Date();
        if (resetTime > now) {
          var diffMs = resetTime - now;
          var diffH = Math.floor(diffMs / 3600000);
          var diffM = Math.floor((diffMs % 3600000) / 60000);
          var countdown = diffH > 0 ? diffH + 'h' + diffM + 'm' : diffM + 'm';
          resetHtml = '<span class="dep-card__reset-countdown">刷新于 ' + countdown + '</span>';
        }
      }

      return (
        '<div class="dep-card" draggable="true" data-id="' + d.id + '" data-order="' + d.order + '">' +
          '<span class="dep-card__drag-handle" title="拖动排序">⠿</span>' +
          '<div class="dep-card__top">' +
            '<div class="dep-card__title-area">' +
              '<div class="dep-card__name">' + escapeHtml(d.name) + '</div>' +
              '<div class="dep-card__model">' + escapeHtml(d.model || d.baseUrl || '--') + '</div>' +
            '</div>' +
            '<span class="dep-card__health" title="' + healthEmoji + '">' + healthEmoji + '</span>' +
          '</div>' +
          '<div class="dep-card__progress">' +
            '<div class="dep-card__progress-header">' +
              '<span class="dep-card__progress-label">余额' + planHtml + '</span>' +
              '<span class="dep-card__progress-value" style="color:' + percentColor + '">' +
                currencyHtml + balanceText + resetHtml +
              '</span>' +
            '</div>' +
            '<div class="dep-card__bar-wrap">' +
              '<div class="dep-card__bar ' + barClass + '" style="width:' + percent + '%"></div>' +
            '</div>' +
          '</div>' +
          '<div class="dep-card__bottom">' +
            '<span class="dep-card__order-tag">P' + d.order + '</span>' +
            '<label class="toggle" onclick="event.stopPropagation()">' +
              '<input type="checkbox" class="js-deployment-toggle" data-id="' + d.id + '"' +
                (d.enabled ? ' checked' : '') + '>' +
              '<span class="toggle__track"><span class="toggle__thumb"></span></span>' +
            '</label>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    // 绑定 toggle 事件
    dom.deploymentList.querySelectorAll('.js-deployment-toggle').forEach(function (el) {
      el.addEventListener('change', function () {
        var id = this.dataset.id;
        api('/deployments/' + id + '/toggle', { method: 'PATCH' })
          .then(function () {
            showToast('✅ 已切换 ' + id);
          })
          .catch(function (err) {
            showToast('❌ 切换失败: ' + err.message);
            // 恢复 checkbox 状态
            this.checked = !this.checked;
          }.bind(this));
      });
    });

    // 绑定拖动事件
    bindDragEvents();
  }

  // ==========================================================================
  // 拖动排序逻辑
  // ==========================================================================

  function bindDragEvents() {
    var cards = dom.deploymentList.querySelectorAll('.dep-card');
    cards.forEach(function (card) {
      card.addEventListener('dragstart', onDragStart);
      card.addEventListener('dragend', onDragEnd);
      card.addEventListener('dragover', onDragOver);
      card.addEventListener('dragleave', onDragLeave);
      card.addEventListener('drop', onDrop);
    });
  }

  function onDragStart(e) {
    var card = e.currentTarget;
    dragState = { id: card.dataset.id, el: card };
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);

    // 延迟设置拖动样式，避免截图问题
    requestAnimationFrame(function () {
      card.classList.add('is-dragging');
    });
  }

  function onDragEnd(e) {
    var card = e.currentTarget;
    card.classList.remove('is-dragging');
    // 清除所有占位符
    dom.deploymentList.querySelectorAll('.is-placeholder').forEach(function (el) {
      el.classList.remove('is-placeholder');
    });
    dragState = null;
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    var target = e.currentTarget;
    // 跳过自身
    if (dragState && target.dataset.id === dragState.id) return;

    // 清除其他占位符
    dom.deploymentList.querySelectorAll('.is-placeholder').forEach(function (el) {
      if (el !== target) el.classList.remove('is-placeholder');
    });

    target.classList.add('is-placeholder');
  }

  function onDragLeave(e) {
    var target = e.currentTarget;
    // 只在真正离开时移除（排除子元素触发）
    if (!target.contains(e.relatedTarget)) {
      target.classList.remove('is-placeholder');
    }
  }

  function onDrop(e) {
    e.preventDefault();
    var target = e.currentTarget;
    target.classList.remove('is-placeholder');

    if (!dragState || target.dataset.id === dragState.id) return;

    var draggedId = dragState.id;
    var targetId = target.dataset.id;

    // 根据 DOM 顺序重新计算 order
    reorderDeployments(draggedId, targetId);
  }

  function reorderDeployments(draggedId, targetId) {
    // 复制并按当前 order 排序
    var sorted = deployments.slice().sort(function (a, b) { return a.order - b.order; });
    var draggedIndex = sorted.findIndex(function (d) { return d.id === draggedId; });
    var targetIndex = sorted.findIndex(function (d) { return d.id === targetId; });

    if (draggedIndex === -1 || targetIndex === -1) return;

    // 从数组中移除被拖动的元素，插入到目标位置
    var dragged = sorted.splice(draggedIndex, 1)[0];
    sorted.splice(targetIndex, 0, dragged);

    // 重新分配 order（从 1 开始）
    var updates = [];
    sorted.forEach(function (d, i) {
      var newOrder = i + 1;
      if (d.order !== newOrder) {
        d.order = newOrder;
        updates.push({ id: d.id, order: newOrder });
      }
    });

    // 更新本地数据
    deployments = sorted;

    // 重新渲染
    renderDeployments();

    // 落地回弹动画 — 找到被拖动的卡片
    var settledCard = dom.deploymentList.querySelector('.dep-card[data-id="' + draggedId + '"]');
    if (settledCard) {
      settledCard.classList.add('is-settling');
      settledCard.addEventListener('animationend', function handler() {
        settledCard.classList.remove('is-settling');
        settledCard.removeEventListener('animationend', handler);
      });
    }

    // 批量调用 API 更新 order
    if (updates.length > 0) {
      var promises = updates.map(function (u) {
        return api('/deployments/' + u.id, {
          method: 'PUT',
          body: JSON.stringify({ order: u.order }),
        }).catch(function (err) {
          showToast('❌ 更新 order 失败 (' + u.id + '): ' + err.message);
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
        var detail = document.getElementById('detail-' + id);
        if (detail) detail.remove();
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

        // 更新详情内容
        var detailEl = document.getElementById('detail-' + r.id);
        if (detailEl) {
          detailEl.innerHTML = renderRequestDetail(r);
        }
      } else {
        // 新增记录：用 DocumentFragment 构建
        var itemEl = document.createElement('div');
        itemEl.className = 'request-item';
        itemEl.dataset.id = r.id;
        itemEl.innerHTML =
          '<span class="request-item__method">' + method + '</span>' +
          '<span class="request-item__path">' + escapeHtml(path) + '</span>' +
          '<span class="request-item__status request-item__status--' + sc + '">' + emoji + ' ' + (r.status || '--') + '</span>' +
          '<span class="request-item__duration">' + dur + '</span>' +
          '<span class="request-item__deployment">' + escapeHtml(depName) + '</span>';

        var detailEl = document.createElement('div');
        detailEl.className = 'request-detail';
        detailEl.id = 'detail-' + r.id;
        detailEl.innerHTML = renderRequestDetail(r);

        // 绑定展开/收起
        itemEl.addEventListener('click', function () {
          detailEl.classList.toggle('is-visible');
        });

        requestElCache.set(r.id, itemEl);

        // 新增记录 prepend 到列表头部
        if (dom.requestList.firstChild) {
          dom.requestList.insertBefore(itemEl, dom.requestList.firstChild);
          dom.requestList.insertBefore(detailEl, itemEl.nextSibling);
        } else {
          dom.requestList.appendChild(itemEl);
          dom.requestList.appendChild(detailEl);
        }
      }
    });
  }

  function renderRequestDetail(r) {
    var lines = [];

    lines.push(row('Deployment', escapeHtml(r.deploymentName || '--')));
    lines.push(row('开始时间', r.startedAt ? new Date(r.startedAt).toLocaleString() : '--'));
    if (r.endedAt) {
      lines.push(row('耗时', formatDuration(r.endedAt - r.startedAt)));
    }
    if (r.modelRequested) {
      lines.push(row('请求模型', escapeHtml(r.modelRequested)));
    }
    if (r.modelOverride) {
      lines.push(row('模型覆盖', escapeHtml(r.modelOverride)));
    }
    if (r.modelServed) {
      lines.push(row('实际模型', escapeHtml(r.modelServed)));
    }
    if (r.isStream != null) {
      lines.push(row('流式', r.isStream ? '是' : '否'));
    }
    if (r.error) {
      lines.push(row('错误', '<span style="color:var(--accent-red)">' + escapeHtml(r.error) + '</span>'));
    }

    // Token 统计
    var tokens = [];
    if (r.inputTokens != null) tokens.push(tokenStat('📥 Input', r.inputTokens));
    if (r.outputTokens != null) tokens.push(tokenStat('📤 Output', r.outputTokens));
    if (r.cacheReadTokens != null) tokens.push(tokenStat('⚡ Cache Read', r.cacheReadTokens));
    if (r.cacheCreationTokens != null) tokens.push(tokenStat('💾 Cache Write', r.cacheCreationTokens));

    var tokensHtml = tokens.length > 0
      ? '<div class="request-detail__tokens">' + tokens.join('') + '</div>'
      : '';

    return lines.join('') + tokensHtml;
  }

  function row(label, value) {
    return '<div class="request-detail__row"><span class="request-detail__label">' + label + '</span><span class="request-detail__value">' + value + '</span></div>';
  }

  function tokenStat(label, value) {
    return '<span class="token-stat"><span class="token-stat__label">' + label + '</span><span class="token-stat__value">' + formatNumber(value) + '</span></span>';
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
