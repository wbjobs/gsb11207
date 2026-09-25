/* dbg-console Service Worker: intercept / record / replay / fault injection. */
'use strict';

// 每次发布必须递增：activate 阶段按版本清理旧缓存，保证“SW 更新后旧缓存不残留”。
var SW_VERSION = 1;
var RUNTIME_CACHE = 'dbg-runtime-v' + SW_VERSION; // 版本化运行时缓存（mock 资源等）
var REC_CACHE = 'dbg-recordings';                 // 录制体缓存：跨 SW 版本保留，用于离线重放
var CACHE_WHITELIST = [RUNTIME_CACHE, REC_CACHE];
var CHANNEL = 'dbg-console';

importScripts('db.js');

var state = {
  rules: [],          // [{id, enabled, urlPattern, method, action, delayMs, status, mockBody, contentType}]
  mode: 'passthrough',// passthrough | record | replay
  offlineAll: false   // 全局断网
};
var stateReady = hydrate();

function hydrate() {
  return Promise.all([
    DbgDB.getState('rules'),
    DbgDB.getState('mode'),
    DbgDB.getState('offlineAll')
  ]).then(function (vals) {
    if (Array.isArray(vals[0])) state.rules = vals[0];
    if (typeof vals[1] === 'string') state.mode = vals[1];
    if (typeof vals[2] === 'boolean') state.offlineAll = vals[2];
  }).catch(function () { /* IDB 不可用时保持默认直通 */ });
}

/* ---------------- 生命周期 ---------------- */

self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (name) {
          // 只清理本调试台的缓存，绝不动页面自身或其它工具的缓存
          if (name.indexOf('dbg-') === 0 && CACHE_WHITELIST.indexOf(name) === -1) {
            return caches.delete(name);
          }
        }));
      })
      .then(function () { return self.clients.claim(); })
      .then(function () { stateReady = hydrate(); })
  );
});

/* ---------------- 跨标签页同步 ----------------
 * 页面端任何标签页修改规则/模式后：写 IndexedDB（事实源）+ BroadcastChannel 广播。
 * SW 与其它标签页都监听同一频道，收到即更新内存态，实现多标签页规则同步。
 */
var bus = new BroadcastChannel(CHANNEL);
bus.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.type === 'state') {
    if (Array.isArray(msg.rules)) state.rules = msg.rules;
    if (typeof msg.mode === 'string') state.mode = msg.mode;
    if (typeof msg.offlineAll === 'boolean') state.offlineAll = msg.offlineAll;
  } else if (msg.type === 'clear-recordings') {
    clearRecordingCache();
  }
};

// 兼容 postMessage 控制（页面拿到 SW 引用后直接发）
self.addEventListener('message', function (event) {
  var msg = event.data || {};
  if (msg.type === 'state') {
    bus.onmessage({ data: msg });
  } else if (msg.type === 'ping') {
    event.source && event.source.postMessage({ type: 'pong', version: SW_VERSION, state: state });
  }
});

/* ---------------- 工具 ---------------- */

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function djb2(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 录制键 = 方法 + URL + 请求体哈希，保证 POST 不同 body 不互相覆盖
function requestKey(method, url, bodyText) {
  return method.toUpperCase() + ' ' + url + ' ' + djb2(bodyText || '');
}

function recCacheUrl(origin, key) {
  return origin + '/__dbg_rec__/' + encodeURIComponent(key);
}

function readBody(request) {
  // 请求体是流，只能读一次：先 clone 再读，原请求仍可继续 fetch
  if (request.method === 'GET' || request.method === 'HEAD') return Promise.resolve('');
  return request.clone().text().catch(function () { return ''; });
}

function jsonResponse(obj, status, extraHeaders) {
  var headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-DBG': '1' };
  if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
  return new Response(JSON.stringify(obj), { status: status, headers: headers });
}

function matchRule(request) {
  var url = request.url;
  var method = request.method.toUpperCase();
  for (var i = 0; i < state.rules.length; i++) {
    var r = state.rules[i];
    if (!r || r.enabled === false) continue;
    if (r.method && r.method !== 'ALL' && r.method !== method) continue;
    if (!r.urlPattern) continue;
    var hit = false;
    var rx = r.urlPattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (rx) {
      // 仅 /pattern/flags 完整形式按正则处理；普通含斜杠路径走子串匹配
      try { hit = new RegExp(rx[1], rx[2]).test(url); } catch (e) { hit = false; }
    } else {
      hit = url.indexOf(r.urlPattern) !== -1;
    }
    if (hit) return r;
  }
  return null;
}

function broadcast(entry) {
  try { bus.postMessage(entry); } catch (e) { /* 页面未监听时忽略 */ }
}

function clearRecordingCache() {
  return caches.open(REC_CACHE).then(function (c) {
    return c.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return c.delete(k); }));
    });
  });
}

/* ---------------- 录制 / 重放 ---------------- */

function record(request, bodyText) {
  return fetch(request).then(function (response) {
    // 只录制可读取的响应（basic/cors），opaque 响应体读不到，直接放行不录
    if (response.type !== 'basic' && response.type !== 'default') return response;
    var key = requestKey(request.method, request.url, bodyText);
    var toCache = response.clone();
    var origin = new URL(request.url).origin;
    caches.open(REC_CACHE).then(function (c) {
      return c.put(recCacheUrl(origin, key), toCache);
    }).then(function () {
      return DbgDB.putRecording({
        key: key,
        url: request.url,
        method: request.method.toUpperCase(),
        reqBody: bodyText || '',
        status: response.status,
        contentType: response.headers.get('Content-Type') || '',
        time: Date.now()
      });
    }).then(function () {
      broadcast({ type: 'recorded', key: key, url: request.url, method: request.method });
    }).catch(function () { /* 录制失败不影响正常请求 */ });
    return response;
  });
}

function replay(request, bodyText) {
  var key = requestKey(request.method, request.url, bodyText);
  var origin = new URL(request.url).origin;
  return caches.open(REC_CACHE).then(function (c) {
    return c.match(recCacheUrl(origin, key));
  }).then(function (cached) {
    if (cached) {
      broadcast({ type: 'hit', kind: 'replay', url: request.url, method: request.method, status: cached.status });
      var headers = new Headers(cached.headers);
      headers.set('X-DBG-Replay', '1');
      return cached.blob().then(function (body) {
        return new Response(body, { status: cached.status, statusText: cached.statusText, headers: headers });
      });
    }
    broadcast({ type: 'hit', kind: 'replay-miss', url: request.url, method: request.method, status: 504 });
    return jsonResponse({ error: 'no recording', url: request.url }, 504);
  });
}

/* ---------------- 故障注入 ---------------- */

function applyRule(rule, request) {
  var chain = Promise.resolve();
  if (rule.delayMs > 0) {
    chain = chain.then(function () { return sleep(rule.delayMs); });
  }
  return chain.then(function () {
    switch (rule.action) {
      case 'fail':
        if (!rule.status || rule.status === 0) {
          // 模拟网络层失败（连接被重置）
          broadcast({ type: 'hit', kind: 'fail', url: request.url, method: request.method, status: 0 });
          return Response.error();
        }
        broadcast({ type: 'hit', kind: 'fail', url: request.url, method: request.method, status: rule.status });
        return jsonResponse({ error: 'injected failure', rule: rule.id }, rule.status);
      case 'mock':
        broadcast({ type: 'hit', kind: 'mock', url: request.url, method: request.method, status: rule.status || 200 });
        return new Response(rule.mockBody || '', {
          status: rule.status || 200,
          headers: { 'Content-Type': rule.contentType || 'application/json; charset=utf-8', 'X-DBG-Mock': '1' }
        });
      case 'offline':
        broadcast({ type: 'hit', kind: 'offline', url: request.url, method: request.method, status: 0 });
        return Response.error();
      case 'delay':
      default:
        // 纯延迟：延时后走真实网络
        broadcast({ type: 'hit', kind: 'delay', url: request.url, method: request.method, status: -1 });
        return fetch(request);
    }
  });
}

/* ---------------- 拦截入口 ---------------- */

self.addEventListener('fetch', function (event) {
  event.respondWith(handle(event.request));
});

function handle(request) {
  return stateReady.then(function () {
    var url = new URL(request.url);

    // 内部存储键、SW 自身相关请求永不拦截，避免缓存污染
    if (url.pathname.indexOf('/__dbg_rec__/') === 0) {
      return jsonResponse({ error: 'reserved' }, 404);
    }

    // 全局断网
    if (state.offlineAll && url.pathname.indexOf('/api/') === 0) {
      broadcast({ type: 'hit', kind: 'offline', url: request.url, method: request.method, status: 0 });
      return Response.error();
    }

    // 1) 故障注入规则优先
    var rule = matchRule(request);
    if (rule) return applyRule(rule, request);

    // 2) 重放模式：只认录制缓存，绝不触网（离线重放一致性的核心）
    if (state.mode === 'replay') {
      return readBody(request).then(function (bodyText) {
        return replay(request, bodyText);
      });
    }

    // 3) 录制模式：克隆请求体用于建键，响应克隆后入 Cache API
    if (state.mode === 'record') {
      return readBody(request).then(function (bodyText) {
        return record(request, bodyText);
      });
    }

    // 4) 直通：完全不碰 Cache API，正常请求零污染
    return fetch(request);
  }).catch(function (err) {
    // SW 内部任何异常都不能拖垮页面请求
    try { return fetch(request); } catch (e) { return Response.error(); }
  });
}
