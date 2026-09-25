/*
 * app.js — 调试台主线程控制器。
 * 状态流：UI 变更 → 写 IndexedDB → postMessage 给 SW → BroadcastChannel 通知其他标签页。
 * 重活（规则匹配、体克隆、重放查找）全部在 SW 内完成，主线程只做异步渲染，不阻塞。
 */
/* global DBG_DB */
(function () {
  'use strict';

  var TAB_ID = Math.random().toString(36).slice(2);
  var state = { rules: [], recording: false, replay: false, offline: false };
  var channel = 'BroadcastChannel' in window ? new BroadcastChannel('dbg-sync') : null;
  var applyingRemote = false;

  // ---------- SW 生命周期 ----------
  var swStatus = document.getElementById('sw-status');
  var updateBtn = document.getElementById('sw-update');

  function setSwStatus(text) { swStatus.textContent = text; }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      setSwStatus(reg.active ? '已激活 (scope: ' + reg.scope + ')' : '安装中…');

      reg.addEventListener('updatefound', function () {
        var worker = reg.installing;
        setSwStatus('发现新版本，安装中…');
        worker.addEventListener('statechange', function () {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            setSwStatus('新版本就绪');
            updateBtn.hidden = false; // 等用户确认再切换，避免打断当前操作
          }
        });
      });

      updateBtn.addEventListener('click', function () {
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      });

      navigator.serviceWorker.addEventListener('controllerchange', function () {
        window.location.reload(); // 新 SW 接管后刷新，保证页面与 SW 版本一致
      });

      syncToSW();
    }).catch(function (err) {
      setSwStatus('注册失败: ' + err.message);
    });

    navigator.serviceWorker.addEventListener('message', function (event) {
      var msg = event.data || {};
      if (msg.type === 'RECORDING_ADDED') {
        prependRecording(msg.recording);
      } else if (msg.type === 'STATE') {
        applyRemoteState(msg.state);
      }
    });
  } else {
    setSwStatus('当前浏览器不支持 Service Worker');
  }

  function syncToSW() {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SYNC_STATE', state: state });
    } else if (navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.active) reg.active.postMessage({ type: 'SYNC_STATE', state: state });
      });
    }
  }

  // ---------- 跨标签页同步 ----------
  if (channel) {
    channel.onmessage = function (event) {
      var msg = event.data || {};
      if (msg.tabId === TAB_ID) return;
      if (msg.type === 'STATE') applyRemoteState(msg.state);
      if (msg.type === 'RECORDINGS_CHANGED') renderRecordings();
    };
  }

  function applyRemoteState(remote) {
    applyingRemote = true;
    state = remote;
    renderRules();
    renderToggles();
    applyingRemote = false;
  }

  function commitState() {
    if (applyingRemote) return;
    DBG_DB.saveState(state);
    syncToSW();
    if (channel) channel.postMessage({ type: 'STATE', state: state, tabId: TAB_ID });
  }

  // ---------- 开关 ----------
  ['recording', 'replay', 'offline'].forEach(function (key) {
    document.getElementById('toggle-' + key).addEventListener('change', function (e) {
      state[key] = e.target.checked;
      commitState();
    });
  });

  function renderToggles() {
    ['recording', 'replay', 'offline'].forEach(function (key) {
      document.getElementById('toggle-' + key).checked = !!state[key];
    });
  }

  // ---------- 规则编辑 ----------
  var ruleForm = document.getElementById('rule-form');
  var actionSel = document.getElementById('rule-action');
  actionSel.addEventListener('change', renderActionParams);
  renderActionParams();

  function renderActionParams() {
    var action = actionSel.value;
    document.getElementById('params-delay').hidden = action !== 'delay';
    document.getElementById('params-fail').hidden = action !== 'fail';
    document.getElementById('params-mock').hidden = action !== 'mock';
  }

  ruleForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var rule = {
      id: Date.now(),
      enabled: true,
      pattern: document.getElementById('rule-pattern').value.trim(),
      matchType: document.getElementById('rule-matchtype').value,
      method: document.getElementById('rule-method').value,
      action: actionSel.value,
      delayMs: Number(document.getElementById('rule-delay').value) || 0,
      status: Number(document.getElementById('rule-status').value) || 503,
      mockStatus: Number(document.getElementById('rule-mock-status').value) || 200,
      mockBody: document.getElementById('rule-mock-body').value,
      mockHeaders: document.getElementById('rule-mock-headers').value
    };
    if (!rule.pattern) return;
    state.rules.push(rule);
    ruleForm.reset();
    renderActionParams();
    renderRules();
    commitState();
  });

  function renderRules() {
    var tbody = document.getElementById('rules-body');
    tbody.textContent = '';
    state.rules.forEach(function (rule, idx) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="checkbox" ' + (rule.enabled ? 'checked' : '') + ' data-idx="' + idx + '" class="rule-enable"></td>' +
        '<td><code>' + escapeHtml(rule.pattern) + '</code>' + (rule.matchType === 'regex' ? ' <em>(regex)</em>' : '') + '</td>' +
        '<td>' + rule.method + '</td>' +
        '<td>' + describeAction(rule) + '</td>' +
        '<td><button data-idx="' + idx + '" class="rule-del">删除</button></td>';
      tbody.appendChild(tr);
    });
  }

  function describeAction(rule) {
    if (rule.action === 'delay') return '延迟 ' + rule.delayMs + 'ms';
    if (rule.action === 'fail') return '失败 ' + rule.status;
    return 'mock ' + rule.mockStatus;
  }

  document.getElementById('rules-body').addEventListener('click', function (e) {
    var idx = Number(e.target.dataset.idx);
    if (e.target.classList.contains('rule-del')) {
      state.rules.splice(idx, 1);
      renderRules();
      commitState();
    } else if (e.target.classList.contains('rule-enable')) {
      state.rules[idx].enabled = e.target.checked;
      commitState();
    }
  });

  // ---------- 录制列表 ----------
  function recordingRow(rec) {
    var tr = document.createElement('tr');
    var path = rec.url.replace(location.origin, '');
    tr.innerHTML =
      '<td>' + rec.method + '</td>' +
      '<td><code>' + escapeHtml(path) + '</code></td>' +
      '<td>' + rec.status + '</td>' +
      '<td>' + (rec.resBody || '').length + 'B</td>' +
      '<td>' + new Date(rec.time).toLocaleTimeString() + '</td>' +
      (rec.id ? '<td><button data-id="' + rec.id + '" class="rec-del">删除</button></td>' : '<td></td>');
    return tr;
  }

  function prependRecording(rec) {
    var tbody = document.getElementById('rec-body');
    tbody.insertBefore(recordingRow(rec), tbody.firstChild);
  }

  function renderRecordings() {
    DBG_DB.getRecordings().then(function (all) {
      var tbody = document.getElementById('rec-body');
      tbody.textContent = '';
      all.sort(function (a, b) { return b.time - a.time; }).forEach(function (rec) {
        tbody.appendChild(recordingRow(rec));
      });
    });
  }

  document.getElementById('rec-body').addEventListener('click', function (e) {
    if (!e.target.classList.contains('rec-del')) return;
    DBG_DB.deleteRecording(Number(e.target.dataset.id)).then(function () {
      renderRecordings();
      if (channel) channel.postMessage({ type: 'RECORDINGS_CHANGED', tabId: TAB_ID });
    });
  });

  document.getElementById('rec-clear').addEventListener('click', function () {
    DBG_DB.clearRecordings().then(function () {
      renderRecordings();
      if (channel) channel.postMessage({ type: 'RECORDINGS_CHANGED', tabId: TAB_ID });
    });
  });

  // ---------- 演示请求 ----------
  var logEl = document.getElementById('log');

  function log(text, cls) {
    var line = document.createElement('div');
    line.className = 'log-line ' + (cls || '');
    line.textContent = new Date().toLocaleTimeString() + '  ' + text;
    logEl.insertBefore(line, logEl.firstChild);
  }

  function fire(method, path, body) {
    var start = performance.now();
    var init = { method: method };
    if (body !== undefined) {
      init.body = body;
      init.headers = { 'content-type': 'application/json' };
    }
    fetch(path, init).then(function (res) {
      var ms = Math.round(performance.now() - start);
      var tag = res.headers.get('x-dbg');
      return res.text().then(function (text) {
        log(method + ' ' + path + ' → ' + res.status + ' (' + ms + 'ms)' +
          (tag ? ' [' + tag + ']' : '') + '  ' + text.slice(0, 120), tag ? 'dbg' : '');
      });
    }).catch(function (err) {
      log(method + ' ' + path + ' → 网络错误: ' + err.message, 'err');
    });
  }

  document.getElementById('demo').addEventListener('click', function (e) {
    var action = e.target.dataset.demo;
    if (!action) return;
    if (action === 'time') fire('GET', '/api/time');
    if (action === 'users') fire('GET', '/api/users');
    if (action === 'slow') fire('GET', '/api/slow?ms=800');
    if (action === 'flaky') fire('GET', '/api/flaky');
    if (action === 'echo') fire('POST', '/api/echo', JSON.stringify({ hello: 'world', t: Date.now() }));
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 启动：从 IndexedDB 恢复状态（单一事实源） ----------
  DBG_DB.loadState().then(function (saved) {
    if (saved) {
      applyingRemote = true;
      state = saved;
      applyingRemote = false;
    }
    renderRules();
    renderToggles();
    renderRecordings();
    syncToSW();
  });
})();
