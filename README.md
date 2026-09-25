# SW 请求调试台

基于 Service Worker 的请求拦截调试工具：录制、重放、故障注入（延迟 / 失败 / mock / 断网）。

## 运行

```bash
node server.js        # 默认 8080
# 打开 http://localhost:8080 （SW 在 localhost 下无需 HTTPS）
```

打开两个标签页可验证规则实时同步；DevTools → Application 可观察 SW 生命周期与缓存。

## 架构

```
index.html / app.js     调试台 UI（主线程，仅异步渲染，不做重活）
sw.js                   拦截 /api/*，执行故障注入 / 录制 / 重放
rules.js                纯函数规则引擎（SW / 页面 / Node 测试三端共用）
db.js                   IndexedDB 封装（recordings + state 两个 store）
server.js               零依赖静态服务 + /api/* 演示接口
test/rules.test.js      规则引擎单测: node test/rules.test.js
```

数据流：UI 变更 → 写 IndexedDB（单一事实源）→ `postMessage` 给 SW → `BroadcastChannel` 同步其他标签页。SW 被回收后从 IndexedDB 重新水合，录制新增时 SW 主动向所有客户端广播。

## 关键技术点（对应验收标准）

- **请求体克隆**：请求/响应体都是一次性流，`sw.js` 中一律 `request.clone()` / `response.clone()` 后再读体，原始请求照常发网。
- **故障注入**：规则按数组顺序匹配（`contains` / `regex` + 方法过滤），支持 `delay`（延迟后透传）、`fail`（指定状态码）、`mock`（自定义状态/头/体），命中即短路。
- **录制 + 离线重放**：录制存 `{method, url, reqBody, status, headers, resBody}`；重放按「方法 + URL + 请求体」全等匹配取最新一条。模拟断网开关或真实断网（`fetch` 抛错）时自动兜底重放。重放时剥离 `content-encoding` / `content-length`，避免按错误编码解析。
- **SW 更新**：`VERSION` 变更 → 新 SW 进入 waiting → 页面提示「立即更新」→ `SKIP_WAITING` → `controllerchange` 刷新。`activate` 删除所有非当前版本缓存，旧缓存不残留；`sw.js` 以 `no-cache` 下发保证更新可被发现。
- **跨标签页控制**：`BroadcastChannel('dbg-sync')` 同步规则与开关；录制列表变更也广播，各页即时刷新。
- **缓存不污染**：Cache API 只缓存应用外壳白名单（版本化 cache name）；业务透传统一 `fetch(req, {cache: 'no-store'})`，调试响应永不进入 HTTP 缓存。
- **权限范围**：SW 注册在 `./` 作用域，只控制同源页面；`fetch` 处理器对跨域请求直接放行不拦截。
- **主线程不卡**：规则匹配、体克隆、重放查找全部在 SW 内执行；录制为 fire-and-forget 异步写库；UI 仅做异步渲染。

## 手动验收路径

1. 添加规则 `/api/flaky` → fail 503 → 点「GET /api/flaky」必失败且日志带 `[fail]`。
2. 开录制 → 点各演示按钮 → 开「模拟断网」+「重放」→ 再点同样按钮，响应与录制一致且带 `[replay]`。
3. `sw.js` 中 `VERSION` +1 → 刷新 → 出现「立即更新」→ 点击后 DevTools 中旧 `dbg-shell-v*` 缓存已删除。
4. 开两个标签页，任一边改规则/开关，另一边即时生效。
5. 关闭调试台后正常请求无任何 `[dbg]` 标记，响应头无 `x-dbg`。

## 已知限制

- 录制体按文本存储，二进制响应（图片/流）未做 base64 处理。
- 重放匹配为全等匹配，未做参数归一化（如时间戳 query 会导致 miss）。
