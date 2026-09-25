/*
 * sw.js — 调试台 Service Worker。
 * 职责：拦截同源 /api/ 请求，执行故障注入 / 录制 / 离线重放；
 *       应用外壳用带版本号的 Cache API 缓存，activate 时清理旧版本，避免缓存残留。
 */
/* global DBG_RULES, DBG_DB */
importScripts('rules.js', 'db.js');

var VERSION = 1; // 发版时 +1，activate 会清掉旧版本缓存
var SHELL_CACHE = 'dbg-shell-v' + VERSION;
var SHELL = ['./', './index.html', './style.css', './app.js', './rules.js', './db.js'];

// 内存态：规则与开关。postMessage 实时同步；SW 被回收后从 IndexedDB 重新水合。
var state = { rules: [], recording: false, replay: false, offline: false };
var hydrated = false;

function hydrate() {
  if (hydrated) return Promise.resolve();
  return DBG_DB.loadState()
    .then(function (saved) {
      if (saved) state = saved;
      hydrated = true;
    })
    .catch(function () { hydrated = true; });
}

function broadcast(msg) {
  return self.clients.matchAll({ includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (c) { c.postMessage(msg); });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) { return cache.addAll(SHELL); })
    // 不自动 skipWaiting：等主线程确认（用户点“立即更新”）后发 SKIP_WAITING
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          // 只保留当前版本缓存，旧版本一律删除 —— SW 更新后旧缓存不残留
          if (key !== SHELL_CACHE) return caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
      .then(hydrate)
  );
});

self.addEventListener('message', function (event) {
  var msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (msg.type === 'SYNC_STATE') {
    state = msg.state;
    hydrated = true;
    DBG_DB.saveState(state); // 落盘，供其他标签页与未来的 SW 实例读取
  } else if (msg.type === 'GET_STATE') {
    hydrate().then(function () {
      if (event.source) event.source.postMessage({ type: 'STATE', state: state });
    });
  }
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 跨域请求不拦截

  if (url.pathname.indexOf('/api/') === 0) {
    event.respondWith(hydrate().then(function () { return handleApi(event.request); }));
    return;
  }

  // 应用外壳：仅对白名单内文件 cache-first，其余请求完全不碰缓存，避免污染正常请求
  if (event.request.method === 'GET' && isShellAsset(url)) {
    event.respondWith(
      caches.match(event.request, { cacheName: SHELL_CACHE }).then(function (hit) {
        return hit || fetch(event.request);
      })
    );
  }
});

function isShellAsset(url) {
  var path = url.pathname.replace(/^\//, './');
  if (path === './') return true;
  return SHELL.indexOf(path) !== -1;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function jsonResponse(obj, status, extraHeaders) {
  var headers = { 'content-type': 'application/json; charset=utf-8' };
  if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
  return new Response(JSON.stringify(obj), { status: status, headers: headers });
}

function readBody(request) {
  // 请求体是流，只能消费一次 —— 先 clone 再读，原始请求照常发给网络
  return request.clone().text().catch(function () { return ''; });
}

function handleApi(request) {
  var url = request.url;
  var method = request.method;

  return readBody(request).then(function (body) {
    var reqInfo = { url: url, method: method, body: body };

    // 1. 断网模拟：不触网，优先重放，否则 503
    if (state.offline) {
      if (state.replay) {
        return replayFromRecordings(reqInfo).then(function (hit) {
          return hit || jsonResponse({ error: 'offline', detail: '模拟断网，且无匹配录制' }, 503, { 'x-dbg': 'offline' });
        });
      }
      return jsonResponse({ error: 'offline', detail: '模拟断网' }, 503, { 'x-dbg': 'offline' });
    }

    // 2. 故障注入：delay / fail / mock
    var fault = DBG_RULES.findFault(state.rules, reqInfo);
    if (fault) return applyFault(fault, request, reqInfo);

    // 3. 重放模式：先查录制，未命中再走网络
    if (state.replay) {
      return replayFromRecordings(reqInfo).then(function (hit) {
        return hit || passthrough(request, reqInfo);
      });
    }

    // 4. 正常透传（no-store，防止调试响应进入浏览器 HTTP 缓存造成污染）
    return passthrough(request, reqInfo);
  });
}

function applyFault(rule, request, reqInfo) {
  var proceed = function () {
    if (rule.action === 'fail') {
      return jsonResponse({ error: 'injected-failure', rule: rule.pattern }, rule.status || 503, { 'x-dbg': 'fail' });
    }
    if (rule.action === 'mock') {
      var headers = { 'x-dbg': 'mock' };
      try {
        var extra = JSON.parse(rule.mockHeaders || '{}');
        Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
      } catch (e) { /* 忽略非法 JSON */ }
      if (!Object.keys(headers).some(function (k) { return k.toLowerCase() === 'content-type'; })) {
        headers['content-type'] = 'application/json; charset=utf-8';
      }
      return new Response(rule.mockBody || '', { status: rule.mockStatus || 200, headers: headers });
    }
    // delay：等待后透传
    return passthrough(request, reqInfo);
  };
  if (rule.action === 'delay' && rule.delayMs > 0) {
    return sleep(rule.delayMs).then(proceed);
  }
  return Promise.resolve().then(proceed);
}

function passthrough(request, reqInfo) {
  return fetch(request, { cache: 'no-store' }).then(function (response) {
    if (state.recording) capture(reqInfo, response); // 异步录制，不阻塞响应
    return response;
  }).catch(function (err) {
    // 真实断网时，若开了重放则兜底重放（离线重放）
    if (state.replay) {
      return replayFromRecordings(reqInfo).then(function (hit) {
        if (hit) return hit;
        throw err;
      });
    }
    throw err;
  });
}

function capture(reqInfo, response) {
  var cloned = response.clone(); // 响应体同样只能消费一次
  cloned.text().then(function (resBody) {
    var headers = {};
    cloned.headers.forEach(function (v, k) { headers[k] = v; });
    var rec = {
      url: reqInfo.url,
      method: reqInfo.method,
      reqBody: reqInfo.body,
      status: cloned.status,
      headers: headers,
      resBody: resBody,
      time: Date.now()
    };
    return DBG_DB.addRecording(rec).then(function () {
      rec.id = undefined;
      broadcast({ type: 'RECORDING_ADDED', recording: rec });
    });
  }).catch(function () { /* 录制失败不影响业务请求 */ });
}

function replayFromRecordings(reqInfo) {
  return DBG_DB.getRecordings().then(function (all) {
    var rec = DBG_RULES.findRecording(all, reqInfo);
    if (!rec) return null;
    var headers = {};
    Object.keys(rec.headers || {}).forEach(function (k) {
      // 存储的是解码后的文本，必须去掉编码与长度头，否则浏览器会按错误方式解析
      var lk = k.toLowerCase();
      if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return;
      headers[k] = rec.headers[k];
    });
    headers['x-dbg'] = 'replay';
    return new Response(rec.resBody, { status: rec.status, headers: headers });
  });
}
