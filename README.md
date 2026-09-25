# 调试台（SW 请求拦截）

基于 Service Worker + Cache API + IndexedDB + postMessage/BroadcastChannel 的请求调试台：
拦截页面请求，支持录制、离线重放、故障注入（延迟 / 失败 / Mock / 断网），多标签页规则同步。

## 运行

```bash
node server.js 8080        # 打开 http://localhost:8080
node test/sw-test.js       # 逻辑端到端测试（无需浏览器，Node 内模拟 SW 环境）
```

## 结构

- `server.js` — 零依赖静态服务器 + Demo API（`/api/time` `/api/users` `/api/slow` `/api/echo`）。
  `sw.js` 以 `Cache-Control: no-store` + `Service-Worker-Allowed: /` 下发，保证更新检测可靠、权限范围为根。
- `public/sw.js` — Service Worker 核心：fetch 拦截、规则匹配、录制/重放、故障注入、缓存版本治理。
- `public/db.js` — IndexedDB 封装，页面与 SW（`importScripts`）共用；IDB 是规则/模式的事实源。
- `public/app.js` — 控制台 UI 逻辑：规则编辑、模式切换、录制列表、实时日志、SW 更新。
- `test/sw-test.js` — 12 项验收测试（内存桩模拟 caches/indexedDB/fetch）。

## 关键设计

**请求处理优先级**（`sw.js` 的 `handle`）：
全局断网 → 故障注入规则 → 重放模式 → 录制模式 → 直通。
直通路径完全不触碰 Cache API，正常请求零污染。

**请求体克隆**：POST 录制/重放前 `request.clone().text()` 读取请求体，
录制键 = `方法 + URL + djb2(body)`，同 URL 不同 body 的 POST 互不覆盖，重放精确匹配。

**录制/重放**：响应 `clone()` 存入 Cache API（`dbg-recordings`，跨 SW 版本保留），
元数据存 IndexedDB。重放模式只查缓存绝不触网，因此断网后重放结果与录制完全一致；
未录制的请求返回 504。

**SW 更新**：`SW_VERSION` 递增 → 版本化缓存 `dbg-runtime-v{N}`；
`activate` 删除所有不在白名单的 `dbg-*` 旧缓存（录制缓存保留），
`skipWaiting` + `clients.claim` 立即接管，页面监听 `controllerchange` 自动刷新一次。
页面每 60s `registration.update()` 主动探测。

**多标签页同步**：任一标签页改规则 → 写 IndexedDB（事实源）→ BroadcastChannel 广播 →
SW 内存态与其它标签页 UI 同步更新。SW 被浏览器回收重启后从 IDB 重新水合，状态不丢。

**主线程不卡**：拦截、延迟、读写缓存全部发生在 SW 线程；页面端 IDB 操作全异步，
日志渲染事件驱动，无任何同步 XHR / 长任务。

## 验收标准对照（test/sw-test.js）

| 标准 | 测试 |
| --- | --- |
| 故障注入按规则失败 | #2 fail 状态码、#3 网络错误、#4 mock、#5 延迟、#6 启停 |
| 录制后断网重放一致 | #7 录制（含 POST body 克隆）、#8 fetch 抛错模拟断网后逐字节一致 |
| SW 更新后旧缓存不残留 | #10 `dbg-runtime-v0` 被清除、录制保留 |
| 多标签页规则同步 | #11 第二频道广播规则后 SW 立即生效 |
| 缓存不污染正常请求 | #1 直通零缓存写入 |
| 主线程不卡 | 架构保证：全部拦截逻辑在 SW 线程，页面端无异步阻塞 |
