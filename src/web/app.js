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
  let deployments = [];
  let requests = [];
  let config = {};

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
  // 渲染：Deployment 列表
  // ==========================================================================

  function renderDeployments() {
    if (deployments.length === 0) {
      dom.deploymentList.innerHTML = '<div class="empty-state"><span class="empty-state__emoji">📭</span>暂无 deployment</div>';
      return;
    }

    dom.deploymentList.innerHTML = deployments.map(function (d) {
      var dotClass = healthDotClass(d);
      var statusEmojiStr = '';
      if (!d.enabled) statusEmojiStr = '💤 已禁用';
      else if (d.health && !d.health.isHealthy) statusEmojiStr = '❄️ 冷却中';
      else if (d.health && d.health.consecutiveFailures > 0) statusEmojiStr = '⚠️ ' + d.health.consecutiveFailures + '次失败';
      else statusEmojiStr = '😊 正常';

      return (
        '<div class="deployment-row" data-id="' + d.id + '">' +
          '<div class="deployment-row__info">' +
            '<span class="deployment-row__dot deployment-row__dot--' + dotClass + '"></span>' +
            '<span class="deployment-row__name">' + escapeHtml(d.name) + '</span>' +
            '<span class="deployment-row__order">order:' + d.order + '</span>' +
          '</div>' +
          '<span class="deployment-row__status">' + statusEmojiStr + '</span>' +
          '<label class="toggle">' +
            '<input type="checkbox" class="js-deployment-toggle" data-id="' + d.id + '"' +
              (d.enabled ? ' checked' : '') + '>' +
            '<span class="toggle__track"><span class="toggle__thumb"></span></span>' +
          '</label>' +
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
  }

  // ==========================================================================
  // 渲染：Skill 列表
  // ==========================================================================

  function renderSkills() {
    // 目前 skill 库没有后端 API，显示占位
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

    // 显示占位 skill 卡片（示例数据，后续对接真实 API）
    dom.skillList.innerHTML =
      '<div class="skill-placeholder">' +
        '<span class="skill-placeholder__emoji">🔍</span>' +
        '<div>Skill 猎手正在搜寻中...</div>' +
        '<div style="font-size:12px;margin-top:4px;color:var(--text-dim)">关注 claude-code skill / mcp 生态</div>' +
      '</div>';
  }

  // ==========================================================================
  // 渲染：请求列表
  // ==========================================================================

  function renderRequests() {
    dom.requestCount.textContent = requests.length + ' 条';

    if (requests.length === 0) {
      dom.requestList.innerHTML = '<div class="empty-state"><span class="empty-state__emoji">📭</span>暂无请求</div>';
      return;
    }

    dom.requestList.innerHTML = requests.map(function (r) {
      var dur = r.endedAt ? formatDuration(r.endedAt - r.startedAt) : '...';
      var sc = statusClass(r.status);
      var emoji = statusEmoji(r.status);
      var method = r.method || '--';
      var path = r.path || '--';
      var depName = r.deploymentName || '--';

      var html =
        '<div class="request-item" data-id="' + r.id + '">' +
          '<span class="request-item__method">' + method + '</span>' +
          '<span class="request-item__path">' + escapeHtml(path) + '</span>' +
          '<span class="request-item__status request-item__status--' + sc + '">' + emoji + ' ' + (r.status || '--') + '</span>' +
          '<span class="request-item__duration">' + dur + '</span>' +
          '<span class="request-item__deployment">' + escapeHtml(depName) + '</span>' +
        '</div>' +
        '<div class="request-detail" id="detail-' + r.id + '">' +
          renderRequestDetail(r) +
        '</div>';

      return html;
    }).join('');

    // 绑定展开/收起
    dom.requestList.querySelectorAll('.request-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = this.dataset.id;
        var detail = document.getElementById('detail-' + id);
        if (detail) {
          detail.classList.toggle('is-visible');
        }
      });
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

  function connectSSE() {
    if (sse) {
      sse.close();
    }

    sse = new EventSource('/events');

    sse.addEventListener('connected', function () {
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
        renderRequests();
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
        renderRequests();
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

    sse.onerror = function () {
      updateConnectionStatus('disconnected');
      // 自动重连由 EventSource 内置处理
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
    api('/deployments')
      .then(function (data) {
        deployments = data.deployments || [];
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
