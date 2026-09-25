/*
 * server.js — 零依赖开发服务器：静态文件 + /api/* 演示接口。
 * 用法: node server.js [port]   然后访问 http://localhost:8080
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8080;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json'
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/time') {
    return sendJson(res, 200, { now: new Date().toISOString(), tz: 'Asia/Shanghai' });
  }
  if (route === '/api/users') {
    return sendJson(res, 200, { users: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }] });
  }
  if (route === '/api/slow') {
    const ms = Math.min(Number(url.searchParams.get('ms')) || 500, 10000);
    return setTimeout(() => sendJson(res, 200, { delayed: ms }), ms);
  }
  if (route === '/api/flaky') {
    // 50% 概率 500，用来验证故障注入与重放
    if (Math.random() < 0.5) return sendJson(res, 500, { error: 'random server failure' });
    return sendJson(res, 200, { ok: true, lucky: Math.random() });
  }
  if (route === '/api/echo' && req.method === 'POST') {
    return readBody(req).then((body) => sendJson(res, 200, { echoed: body }));
  }
  return sendJson(res, 404, { error: 'unknown api', route });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  let filePath = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    // sw.js 必须不被强缓存，否则浏览器可能长时间不检查 SW 更新
    if (filePath.endsWith('sw.js')) headers['cache-control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`调试台: http://localhost:${PORT}`);
});
