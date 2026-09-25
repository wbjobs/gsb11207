/* dbg-db: shared IndexedDB wrapper, usable from window and ServiceWorker (importScripts). */
(function (global) {
  'use strict';

  var DB_NAME = 'dbg-console';
  var DB_VERSION = 1;
  var STORE_STATE = 'state';        // key-value: rules / mode / offlineAll
  var STORE_RECORDINGS = 'recordings'; // recording metadata, keyPath 'key'

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_STATE)) {
          db.createObjectStore(STORE_STATE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
          var store = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'key' });
          store.createIndex('url', 'url', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var result;
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
      var out = fn(t.objectStore(store));
      if (out && typeof out.onsuccess !== 'undefined') {
        out.onsuccess = function () { result = out.result; };
      }
    });
  }

  function getState(id) {
    return openDb().then(function (db) {
      return tx(db, STORE_STATE, 'readonly', function (s) { return s.get(id); });
    }).then(function (row) { return row ? row.value : undefined; });
  }

  function setState(id, value) {
    return openDb().then(function (db) {
      return tx(db, STORE_STATE, 'readwrite', function (s) { s.put({ id: id, value: value }); });
    });
  }

  function putRecording(meta) {
    return openDb().then(function (db) {
      return tx(db, STORE_RECORDINGS, 'readwrite', function (s) { s.put(meta); });
    });
  }

  function getAllRecordings() {
    return openDb().then(function (db) {
      return tx(db, STORE_RECORDINGS, 'readonly', function (s) { return s.getAll(); });
    }).then(function (rows) { return rows || []; });
  }

  function deleteRecording(key) {
    return openDb().then(function (db) {
      return tx(db, STORE_RECORDINGS, 'readwrite', function (s) { s.delete(key); });
    });
  }

  function clearRecordings() {
    return openDb().then(function (db) {
      return tx(db, STORE_RECORDINGS, 'readwrite', function (s) { s.clear(); });
    });
  }

  global.DbgDB = {
    openDb: openDb,
    getState: getState,
    setState: setState,
    putRecording: putRecording,
    getAllRecordings: getAllRecordings,
    deleteRecording: deleteRecording,
    clearRecordings: clearRecordings
  };
})(typeof self !== 'undefined' ? self : this);
