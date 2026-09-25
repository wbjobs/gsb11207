/* dbg-console 页面端：规则管理 / 跨标签页同步 / SW 生命周期 / 实时日志 */
'use strict';

var CHANNEL = 'dbg-console';
var bus = new BroadcastChannel(CHANNEL);

var state = { rules: [], mode: 'passthrough', offlineAll: false };
var swRegistration = null;
var reloading = false;

/* ---------------- 状态持久化 + 广播 ----------------
 * IndexedDB 是事实源；BroadcastChannel 负责把变更同步给 SW 和其它标签页。
 */
function persistAndBroadcast() {
  return Promise.all([
    DbgDB.setState('rules', state.rules),
    DbgDB.setState('mode', state.mode),
    DbgDB.setState('offlineAll', state.offlineAll)
  ]).then(function () {
    bus.postMessage({
      type: 'state',
      rules: state.rules,
      mode: state.mode,
      offlineAll: state.offlineAll
    });
  });
}

// 其它标签页的变更 → 更新本地 UI
bus.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.type === 'state') {
    state.rules = msg.rules || [];
    state.mode = msg.mode || 'passthrough';
    state.offlineAll = !!msg.offlineAll;
    renderAll();
    log('sync', '从其它标签页同步了规则/模式');
  } else if (msg.type === 'hit') {
    addHitRow(msg);
  } else if (msg.type === 'recorded') {
    addHitRow({ kind: 'record', url: msg.url, method: msg.method, status: 200 });
    refreshRecordings();
  }
};

/* ---------------- Service Worker 注册与更新 ---------------- */

function registerSW() {
  if (!('serviceWorker' in navigator)) {
    setSwStatus('当前环境不支持 Service Worker');
    return Promise.reject(new Error('no sw'));
  }
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
    swRegistration = reg;
    setSwStatus('已激活，scope=' + reg.scope);

    reg.addEventListener('updatefound', function () {
      var nw = reg.installing;
      setSwStatus('发现新版本，安装中…');
      nw.addEventListener('statechange', function () {
        if (nw.state === 'activated') setSwStatus('新版本已激活');
      });
    });

    // 新 SW 接管后刷新一次页面，保证页面与新 SW 状态一致
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    // 周期性检查更新（SW 脚本有更新时 activate 会清理旧版本缓存）
    setInterval(function () { reg.update().catch(function () {}); }, 60 * 1000);
    return reg;
  }).catch(function (err) {
    setSwStatus('注册失败: ' + err.message);
  });
}

function checkUpdate() {
  if (!swRegistration) return;
  setSwStatus('检查更新中…');
  swRegistration.update().then(function () {
    setSwStatus('已检查更新（无更新则保持当前版本）');
  });
}

/* ---------------- 初始加载 ---------------- */

function init() {
  Promise.all([
    DbgDB.getState('rules'),
    DbgDB.getState('mode'),
    DbgDB.getState('offlineAll')
  ]).then(function (vals) {
    if (Array.isArray(vals[0])) state.rules = vals[0];
    if (typeof vals[1] === 'string') state.mode = vals[1];
    if (typeof vals[2] === 'boolean') state.offlineAll = vals[2];
    renderAll();
    return registerSW();
  }).then(function () {
    // 注册完成后把最新状态推给 SW（SW 可能刚重启，内存态为空）
    return persistAndBroadcast();
  }).then(refreshRecordings).then(refreshCaches);
}

/* ---------------- UI 渲染 ---------------- */

function $(sel) { return document.querySelector(sel); }

function setSwStatus(text) { $('#sw-status').textContent = text; }

function renderAll() {
  renderMode();
  renderRules();
}

function renderMode() {
  $('#mode').value = state.mode;
  $('#offline-all').checked = state.offlineAll;
}

function renderRules() {
  var tbody = $('#rules-body');
  tbody.textContent = '';
  state.rules.forEach(function (rule, idx) {
    var tr = document.createElement('tr');

    var tdToggle = document.createElement('td');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rule.enabled !== false;
    cb.addEventListener('change', function () {
      state.rules[idx].enabled = cb.checked;
      persistAndBroadcast();
    });
    tdToggle.appendChild(cb);

    var tdPattern = document.createElement('td');
    tdPattern.textContent = (rule.method || 'ALL') + ' ' + rule.urlPattern;

    var tdAction = document.createElement('td');
    tdAction.textContent = describeAction(rule);

    var tdOps = document.createElement('td');
    var del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', function () {
      state.rules.splice(idx, 1);
      persistAndBroadcast();
      renderRules();
    });
    tdOps.appendChild(del);

    tr.appendChild(tdToggle);
    tr.appendChild(tdPattern);
    tr.appendChild(tdAction);
    tr.appendChild(tdOps);
    tbody.appendChild(tr);
  });
}

function describeAction(rule) {
  var parts = [];
  if (rule.delayMs > 0) parts.push('延迟 ' + rule.delayMs + 'ms');
  switch (rule.action) {
    case 'fail': parts.push(rule.status ? '失败 ' + rule.status : '网络错误'); break;
    case 'mock': parts.push('Mock ' + (rule.status || 200)); break;
    case 'offline': parts.push('断网'); break;
    case 'delay': if (!parts.length) parts.push('仅延迟'); break;
    default: parts.push(rule.action);
  }
  return parts.join(' + ');
}

/* ---------------- 规则表单 ---------------- */

function addRule() {
  var rule = {
    id: 'r' + Date.now().toString(36),
    enabled: true,
    urlPattern: $('#f-pattern').value.trim(),
    method: $('#f-method').value,
    action: $('#f-action').value,
    delayMs: parseInt($('#f-delay').value, 10) || 0,
    status: parseInt($('#f-status').value, 10) || 0,
    mockBody: $('#f-mockbody').value,
    contentType: $('#f-contenttype').value
  };
  if (!rule.urlPattern) {
    alert('请填写 URL 匹配串（子串或 /正则/flags）');
    return;
  }
  state.rules.push(rule);
  persistAndBroadcast();
  renderRules();
  $('#f-pattern').value = '';
  $('#f-mockbody').value = '';
}

/* ---------------- 录制列表 ---------------- */

function refreshRecordings() {
  return DbgDB.getAllRecordings().then(function (rows) {
    rows.sort(function (a, b) { return b.time - a.time; });
    var tbody = $('#rec-body');
    tbody.textContent = '';
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      [row.method, row.url, String(row.status), new Date(row.time).toLocaleTimeString()].forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        td.title = text;
        tr.appendChild(td);
      });
      var tdOps = document.createElement('td');
      var del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', function () {
        DbgDB.deleteRecording(row.key).then(refreshRecordings);
      });
      tdOps.appendChild(del);
      tr.appendChild(tdOps);
      tbody.appendChild(tr);
    });
    $('#rec-count').textContent = String(rows.length);
  });
}

function clearRecordings() {
  DbgDB.clearRecordings().then(function () {
    bus.postMessage({ type: 'clear-recordings' }); // SW 清空录制缓存
    return refreshRecordings();
  });
}

/* ---------------- 缓存状态（验证旧缓存不残留） ---------------- */

function refreshCaches() {
  if (!('caches' in window)) return Promise.resolve();
  return caches.keys().then(function (names) {
    $('#cache-list').textContent = names.length ? names.join(', ') : '(无)';
  });
}

/* ---------------- 实时日志 ---------------- */

function addHitRow(hit) {
  var tbody = $('#log-body');
  var tr = document.createElement('tr');
  var kindLabel = {
    mock: 'MOCK', fail: '故障', delay: '延迟', offline: '断网',
    replay: '重放', 'replay-miss': '重放缺失', record: '录制'
  }[hit.kind] || hit.kind;
  [new Date().toLocaleTimeString(), kindLabel, hit.method || '-',
   hit.url || '-', hit.status == null ? '-' : String(hit.status)].forEach(function (text) {
    var td = document.createElement('td');
    td.textContent = text;
    td.title = text;
    tr.appendChild(td);
  });
  tr.className = 'kind-' + hit.kind;
  tbody.insertBefore(tr, tbody.firstChild);
  while (tbody.children.length > 100) tbody.removeChild(tbody.lastChild);
}

function log(kind, text) {
  addHitRow({ kind: kind, method: '-', url: text, status: '-' });
}

/* ---------------- Demo 请求 ---------------- */

function demoFetch(path, options) {
  var start = performance.now();
  return fetch(path, options).then(function (resp) {
    var ms = Math.round(performance.now() - start);
    return resp.text().then(function (body) {
      log('demo', resp.status + ' ' + path + ' (' + ms + 'ms) ' + body.slice(0, 80));
    });
  }).catch(function (err) {
    log('demo', 'ERR ' + path + ' ' + err.message);
  });
}

/* ---------------- 事件绑定 ---------------- */

document.addEventListener('DOMContentLoaded', function () {
  $('#mode').addEventListener('change', function () {
    state.mode = $('#mode').value;
    persistAndBroadcast();
  });
  $('#offline-all').addEventListener('change', function () {
    state.offlineAll = $('#offline-all').checked;
    persistAndBroadcast();
  });
  $('#btn-add-rule').addEventListener('click', addRule);
  $('#btn-clear-rec').addEventListener('click', clearRecordings);
  $('#btn-refresh-rec').addEventListener('click', refreshRecordings);
  $('#btn-update').addEventListener('click', checkUpdate);
  $('#btn-refresh-cache').addEventListener('click', refreshCaches);
  $('#btn-clear-log').addEventListener('click', function () { $('#log-body').textContent = ''; });

  $('#demo-time').addEventListener('click', function () { demoFetch('/api/time'); });
  $('#demo-users').addEventListener('click', function () { demoFetch('/api/users'); });
  $('#demo-slow').addEventListener('click', function () { demoFetch('/api/slow'); });
  $('#demo-echo').addEventListener('click', function () {
    demoFetch('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'dbg', ts: Date.now() })
    });
  });

  init();
});
