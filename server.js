/* 零依赖静态服务器 + Demo API。用法: node server.js [port] */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2], 10) || 8080;
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const api = {
  'GET /api/time': (req, res) => {
    sendJson(res, 200, { now: new Date().toISOString(), tz: 'Asia/Shanghai' });
  },
  'GET /api/users': (req, res) => {
    sendJson(res, 200, {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Linus' },
        { id: 3, name: 'Grace' }
      ],
      nonce: Math.random().toString(36).slice(2)
    });
  },
  'GET /api/slow': (req, res) => {
    setTimeout(() => sendJson(res, 200, { slow: true, took: '1000ms' }), 1000);
  },
  'POST /api/echo': async (req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, { echo: body, length: body.length });
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const routeKey = req.method + ' ' + url.pathname;

  if (api[routeKey]) {
    Promise.resolve(api[routeKey](req, res)).catch((err) => {
      sendJson(res, 500, { error: String(err) });
    });
    return;
  }

  // 静态文件
  let filePath = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not found', path: url.pathname });
      return;
    }
    const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    if (path.basename(filePath) === 'sw.js') {
      // SW 脚本必须绕过 HTTP 缓存，否则更新检测不可靠
      headers['Cache-Control'] = 'no-store';
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`调试台: http://localhost:${PORT}`);
});
