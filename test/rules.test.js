'use strict';
const assert = require('assert');
const R = require('../rules.js');

const req = (url, method = 'GET', body = '') => ({ url, method, body });

// --- matchRule ---
assert.strictEqual(R.matchRule(
  { enabled: true, pattern: '/api/flaky', matchType: 'contains', method: 'ANY' },
  req('http://localhost:8080/api/flaky')
), true, 'contains 命中');

assert.strictEqual(R.matchRule(
  { enabled: true, pattern: '/api/flaky', matchType: 'contains', method: 'POST' },
  req('http://localhost:8080/api/flaky', 'GET')
), false, '方法不匹配不命中');

assert.strictEqual(R.matchRule(
  { enabled: false, pattern: '/api', matchType: 'contains', method: 'ANY' },
  req('http://localhost:8080/api/time')
), false, '禁用规则不命中');

assert.strictEqual(R.matchRule(
  { enabled: true, pattern: '^https?://.*/api/(slow|flaky)', matchType: 'regex', method: 'ANY' },
  req('http://localhost:8080/api/slow?ms=1')
), true, '正则命中');

assert.strictEqual(R.matchRule(
  { enabled: true, pattern: '([', matchType: 'regex', method: 'ANY' },
  req('http://localhost:8080/api/time')
), false, '非法正则不抛异常、不命中');

// --- findFault：按顺序取第一条 ---
const rules = [
  { enabled: true, pattern: '/api/', matchType: 'contains', method: 'ANY', action: 'mock' },
  { enabled: true, pattern: '/api/time', matchType: 'contains', method: 'ANY', action: 'fail' }
];
assert.strictEqual(R.findFault(rules, req('http://x/api/time')).action, 'mock', '前面的规则优先');
assert.strictEqual(R.findFault([], req('http://x/api/time')), null, '无规则返回 null');

// --- findRecording：方法 + URL + 请求体全等，取最新一条 ---
const recordings = [
  { url: 'http://x/api/echo', method: 'POST', reqBody: '{"a":1}', resBody: 'old', time: 1 },
  { url: 'http://x/api/echo', method: 'POST', reqBody: '{"a":1}', resBody: 'new', time: 2 },
  { url: 'http://x/api/echo', method: 'POST', reqBody: '{"a":2}', resBody: 'other', time: 3 }
];
assert.strictEqual(
  R.findRecording(recordings, req('http://x/api/echo', 'POST', '{"a":1}')).resBody,
  'new', '同请求取最新录制'
);
assert.strictEqual(
  R.findRecording(recordings, req('http://x/api/echo', 'POST', '{"a":9}')),
  null, '请求体不同不匹配'
);
assert.strictEqual(
  R.findRecording(recordings, req('http://x/api/echo', 'GET', '')),
  null, '方法不同不匹配'
);

console.log('rules.test.js: 全部通过');
