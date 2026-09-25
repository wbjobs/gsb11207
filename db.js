/*
 * db.js — IndexedDB 封装，同时运行于主线程与 Service Worker。
 * 存两份数据：recordings（录制）与 state（规则 + 开关，跨标签页 / SW 重启后的单一事实源）。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'sw-debug-console';
  var DB_VERSION = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state', { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var result = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(result && result._value); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
        if (result && typeof result === 'object' && 'onsuccess' in result) {
          result.onsuccess = function () { result._value = result.result; };
        }
      });
    });
  }

  function getAll(store) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  var api = {
    addRecording: function (rec) { return tx('recordings', 'readwrite', function (s) { return s.add(rec); }); },
    getRecordings: function () { return getAll('recordings'); },
    deleteRecording: function (id) { return tx('recordings', 'readwrite', function (s) { return s.delete(id); }); },
    clearRecordings: function () { return tx('recordings', 'readwrite', function (s) { return s.clear(); }); },
    saveState: function (state) {
      return tx('state', 'readwrite', function (s) { return s.put({ key: 'app', value: state, updatedAt: Date.now() }); });
    },
    loadState: function () {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = db.transaction('state', 'readonly').objectStore('state').get('app');
          req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
  };

  global.DBG_DB = api;
})(typeof self !== 'undefined' ? self : globalThis);
