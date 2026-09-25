/*
 * rules.js — 纯函数规则引擎，不依赖 window / self。
 * 同时被 sw.js (importScripts)、app.js (<script>)、Node 测试 (require) 使用。
 */
(function (global) {
  'use strict';

  // rule: { id, enabled, pattern, matchType: 'contains'|'regex', method: 'ANY'|'GET'|..., action: 'delay'|'fail'|'mock', delayMs, status, mockStatus, mockBody, mockHeaders }
  function matchRule(rule, req) {
    if (!rule || !rule.enabled) return false;
    if (rule.method && rule.method !== 'ANY' && rule.method !== req.method) return false;
    if (rule.matchType === 'regex') {
      try {
        return new RegExp(rule.pattern).test(req.url);
      } catch (e) {
        return false;
      }
    }
    return req.url.indexOf(rule.pattern) !== -1;
  }

  // 按数组顺序取第一条命中的故障规则（上面的规则优先级高）
  function findFault(rules, req) {
    for (var i = 0; i < rules.length; i++) {
      if (matchRule(rules[i], req)) return rules[i];
    }
    return null;
  }

  // 录制匹配：方法 + URL + 请求体 三者一致才算同一次调用
  function matchRecording(recording, req) {
    return (
      recording.method === req.method &&
      recording.url === req.url &&
      (recording.reqBody || '') === (req.body || '')
    );
  }

  function findRecording(recordings, req) {
    for (var i = recordings.length - 1; i >= 0; i--) {
      if (matchRecording(recordings[i], req)) return recordings[i];
    }
    return null;
  }

  var api = { matchRule: matchRule, findFault: findFault, matchRecording: matchRecording, findRecording: findRecording };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DBG_RULES = api;
})(typeof self !== 'undefined' ? self : globalThis);
