/* sw.js 逻辑端到端测试：在 Node 中用桩模拟 SW 运行环境 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const PUB = require('path').join(__dirname, '..', 'public');

/* ---------- IndexedDB 内存桩 ---------- */
function createIDB() {
  const dbs = new Map();
  function makeStore(data) {
    return {
      get: (k) => req(data.get(k)),
      put: (v) => { data.set(v[Object.keys(v).includes('id') ? 'id' : 'key'], v); return req(undefined); },
      getAll: () => req([...data.values()]),
      delete: (k) => { data.delete(k); return req(undefined); },
      clear: () => { data.clear(); return req(undefined); },
      createIndex: () => {}
    };
  }
  function req(result) {
    const r = { result };
    queueMicrotask(() => r.onsuccess && r.onsuccess());
    return r;
  }
  return {
    open(name, version) {
      const r = {};
      queueMicrotask(() => {
        if (!dbs.has(name)) {
          const stores = new Map();
          const db = {
            objectStoreNames: { contains: (n) => stores.has(n) },
            createObjectStore: (n) => { stores.set(n, new Map()); return makeStore(stores.get(n)); },
            transaction: (storeName) => {
              const t = {};
              queueMicrotask(() => t.oncomplete && t.oncomplete());
              t.objectStore = (n) => makeStore(stores.get(n));
              return t;
            }
          };
          r.result = db;
          r.onupgradeneeded && r.onupgradeneeded();
          dbs.set(name, db);
        } else {
          r.result = dbs.get(name);
        }
        r.onsuccess && r.onsuccess();
      });
      return r;
    }
  };
}

/* ---------- Cache API 内存桩 ---------- */
function createCaches() {
  const stores = new Map();
  function makeCache(map) {
    return {
      put: async (reqOrUrl, resp) => {
        const url = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
        map.set(url, resp.clone());
      },
      match: async (reqOrUrl) => {
        const url = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
        return map.get(url) || undefined;
      },
      keys: async () => [...map.keys()].map((u) => new Request(u)),
      delete: async (reqOrUrl) => {
        const url = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
        return map.delete(url);
      }
    };
  }
  return {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return makeCache(stores.get(name));
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    _stores: stores
  };
}

/* ---------- 装载 sw.js ---------- */
function loadSW() {
  const listeners = {};
  const channels = [];
  const caches = createCaches();
  let fetchImpl = async () => new Response('UNSTUBBED', { status: 500 });
  const fetchCalls = [];

  const sandbox = {
    console,
    setTimeout,
    queueMicrotask,
    URL,
    RegExp,
    Promise,
    Response,
    Request,
    Headers,
    Date,
    Math,
    JSON,
    encodeURIComponent,
    indexedDB: createIDB(),
    caches,
    BroadcastChannel: class {
      constructor(name) { this.name = name; this.onmessage = null; channels.push(this); }
      postMessage(msg) {
        for (const ch of channels) {
          if (ch !== this && ch.name === this.name && ch.onmessage) {
            queueMicrotask(() => ch.onmessage({ data: msg }));
          }
        }
      }
    },
    importScripts: (...files) => {
      for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(PUB, f), 'utf8'), context, { filename: f });
      }
    },
    fetch: (...args) => { fetchCalls.push(args[0] && args[0].url || args[0]); return fetchImpl(...args); },
    __setFetch: (fn) => { fetchImpl = fn; }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  sandbox.clients = { claim: async () => {} };
  sandbox.skipWaiting = async () => {};

  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });

  return {
    listeners,
    channels,
    caches,
    fetchCalls,
    setFetch: (fn) => sandbox.__setFetch(fn),
    async fireFetch(request) {
      let respPromise;
      const event = { request, respondWith: (p) => { respPromise = p; } };
      for (const fn of listeners.fetch || []) fn(event);
      return respPromise;
    },
    async fireActivate() {
      for (const fn of listeners.activate || []) await fn({ waitUntil: (p) => p });
    },
    async fireInstall() {
      for (const fn of listeners.install || []) await fn({ waitUntil: (p) => p });
    },
    swChannel: () => channels[channels.length - 1]
  };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

/* ---------- 测试 ---------- */
(async () => {
  const env = loadSW();
  await env.fireInstall();
  await env.fireActivate();
  await flush(); // hydrate

  const api = (p, opts) => new Request('http://localhost:8080' + p, opts);

  // 后端桩：/api/users 返回动态 nonce
  env.setFetch(async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/users') return new Response(JSON.stringify({ nonce: Math.random() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/api/echo') return new Response(JSON.stringify({ echo: await req.text() }), { status: 200 });
    return new Response('ok:' + u.pathname, { status: 200 });
  });

  /* 1. 直通：不碰缓存 */
  let resp = await env.fireFetch(api('/api/users'));
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(env.fetchCalls.length, 1, '直通应触网');
  assert.deepStrictEqual(await env.caches.keys(), ['dbg-recordings'].filter(() => false), '直通不应创建缓存');
  console.log('✓ 1 直通不污染缓存');

  /* 2. 故障注入：fail 500 */
  env.swChannel().onmessage({ data: { type: 'state', rules: [
    { id: 'r1', enabled: true, urlPattern: '/api/users', method: 'GET', action: 'fail', status: 503 }
  ] } });
  resp = await env.fireFetch(api('/api/users'));
  assert.strictEqual(resp.status, 503);
  assert.strictEqual(env.fetchCalls.length, 1, 'fail 规则不应触网');
  console.log('✓ 2 fail 规则按状态码失败');

  /* 3. 故障注入：网络错误 + 正则匹配 */
  env.swChannel().onmessage({ data: { type: 'state', rules: [
    { id: 'r2', enabled: true, urlPattern: '/\\/api\\/echo/', method: 'POST', action: 'fail', status: 0 }
  ] } });
  resp = await env.fireFetch(api('/api/echo', { method: 'POST', body: 'x=1' }));
  assert.strictEqual(resp.type, 'error', 'status=0 应为网络错误');
  console.log('✓ 3 网络错误注入 + 正则匹配');

  /* 4. mock */
  env.swChannel().onmessage({ data: { type: 'state', rules: [
    { id: 'r3', enabled: true, urlPattern: '/api/users', method: 'ALL', action: 'mock', status: 200, mockBody: '{"mock":true}' }
  ] } });
  resp = await env.fireFetch(api('/api/users'));
  assert.strictEqual(await resp.text(), '{"mock":true}');
  assert.strictEqual(resp.headers.get('X-DBG-Mock'), '1');
  console.log('✓ 4 mock 响应');

  /* 5. 延迟 */
  env.swChannel().onmessage({ data: { type: 'state', rules: [
    { id: 'r4', enabled: true, urlPattern: '/api/users', method: 'ALL', action: 'delay', delayMs: 120 }
  ] } });
  let t0 = Date.now();
  resp = await env.fireFetch(api('/api/users'));
  assert.ok(Date.now() - t0 >= 110, '延迟应 >= ~120ms，实际 ' + (Date.now() - t0));
  assert.strictEqual(resp.status, 200);
  console.log('✓ 5 延迟注入 (' + (Date.now() - t0) + 'ms)');

  /* 6. 规则停用后直通 */
  env.swChannel().onmessage({ data: { type: 'state', rules: [
    { id: 'r4', enabled: false, urlPattern: '/api/users', method: 'ALL', action: 'delay', delayMs: 5000 }
  ] } });
  t0 = Date.now();
  resp = await env.fireFetch(api('/api/users'));
  assert.ok(Date.now() - t0 < 500, '停用规则不应生效');
  console.log('✓ 6 规则启停');

  /* 7. 录制（含 POST 请求体克隆） */
  env.swChannel().onmessage({ data: { type: 'state', rules: [], mode: 'record' } });
  const recA = await (await env.fireFetch(api('/api/users'))).text();
  await env.fireFetch(api('/api/echo', { method: 'POST', body: '{"n":1}' }));
  await env.fireFetch(api('/api/echo', { method: 'POST', body: '{"n":2}' }));
  await flush();
  const recCaches = await env.caches.keys();
  assert.ok(recCaches.includes('dbg-recordings'), '录制应写入 dbg-recordings');
  const recCache = await env.caches.open('dbg-recordings');
  assert.strictEqual((await recCache.keys()).length, 3, '两个不同 body 的 POST 应分别录制');
  console.log('✓ 7 录制（GET×1 + POST 不同 body×2，请求体克隆建键）');

  /* 8. 断网重放一致性：fetch 桩直接抛错模拟离线 */
  env.setFetch(async () => { throw new TypeError('offline'); });
  env.swChannel().onmessage({ data: { type: 'state', mode: 'replay' } });
  resp = await env.fireFetch(api('/api/users'));
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(await resp.text(), recA, '重放内容应与录制一致');
  assert.strictEqual(resp.headers.get('X-DBG-Replay'), '1');
  resp = await env.fireFetch(api('/api/echo', { method: 'POST', body: '{"n":2}' }));
  assert.deepStrictEqual(JSON.parse(await resp.text()), { echo: '{"n":2}' }, 'POST 应按 body 精确重放');
  resp = await env.fireFetch(api('/api/echo', { method: 'POST', body: '{"n":99}' }));
  assert.strictEqual(resp.status, 504, '未录制的请求应 504');
  console.log('✓ 8 断网重放一致（含 POST body 区分、未录制 504）');

  /* 9. 全局断网 */
  env.swChannel().onmessage({ data: { type: 'state', mode: 'passthrough', offlineAll: true } });
  resp = await env.fireFetch(api('/api/users'));
  assert.strictEqual(resp.type, 'error');
  env.swChannel().onmessage({ data: { type: 'state', offlineAll: false } });
  console.log('✓ 9 全局断网');

  /* 10. SW 更新：旧版本缓存被清理，录制缓存保留 */
  const oldCache = await env.caches.open('dbg-runtime-v0');
  await oldCache.put('http://x/old', new Response('stale'));
  await env.fireActivate();
  const names = await env.caches.keys();
  assert.ok(!names.includes('dbg-runtime-v0'), '旧版本缓存应被清理');
  assert.ok(names.includes('dbg-recordings'), '录制缓存应保留');
  assert.strictEqual((await recCache.keys()).length, 3, '录制内容不丢失');
  console.log('✓ 10 SW 更新清理旧缓存、保留录制');

  /* 11. 多标签页同步：第二个“标签页”频道改规则，SW 立即生效 */
  const BC = env.swChannel().constructor;
  const tab2 = new BC('dbg-console');
  tab2.postMessage({ type: 'state', rules: [
    { id: 'r9', enabled: true, urlPattern: '/api/users', method: 'ALL', action: 'mock', mockBody: '{"from":"tab2"}' }
  ], mode: 'passthrough' });
  await flush();
  env.setFetch(async () => new Response('should-not-reach', { status: 200 }));
  resp = await env.fireFetch(api('/api/users'));
  assert.strictEqual(await resp.text(), '{"from":"tab2"}', 'tab2 的规则应同步到 SW');
  console.log('✓ 11 多标签页规则同步');

  /* 12. 清空录制 */
  tab2.postMessage({ type: 'clear-recordings' });
  await flush();
  assert.strictEqual((await recCache.keys()).length, 0, '清空后录制缓存应为空');
  console.log('✓ 12 清空录制');

  console.log('\n全部通过 ✅');
  process.exit(0);
})().catch((err) => { console.error('✗ 失败:', err); process.exit(1); });
