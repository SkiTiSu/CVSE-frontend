# 开发说明

## 本地检查

先按 [README](../README.md) 初始化子模块和 Python 环境。前端开发依赖需要 Node.js 20+。

```bash
uv run python -m unittest discover -s tests -v
uv run python -m py_compile server.py public_server.py quick_start.py
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

也可以用已有的 Chromium 运行浏览器测试：

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

Python 测试模拟 RPC 客户端，JS 单元测试使用 jsdom 和模拟 fetch，浏览器测试拦截 API 并阻止外部请求，不需要连接真实后端。

仅查看模拟界面时，可运行：

```bash
node tests/mock_server.cjs
```

访问 `http://127.0.0.1:25124`。该服务仅绑定本机，不代理真实请求，禁用写入。

## 预览分页与缓存

榜单名次可能并列并跳号，不能直接当作分页行号。普通预览先读取正名次稿件的有序 AV/BV 编号，再按行位置切片，仅查询当前页的详情和元数据。RPC 详情响应顺序不固定，返回页面前会按编号顺序恢复。

- 编号缓存有效期为 5 分钟，按类别、期数、审核模式和授权身份隔离；摘要变化或本服务发起重算时失效。
- 同一榜单的并发首次读取合并；LRU 最多保留 8 组、合计 200,000 个编号，超限明确报错，不静默截断。
- 分页总数使用普通编号数；后端摘要数量可能还包括名次为零的特殊稿件，两者可不同。
- HOT/SH 使用单独的 `[0, 1)` 名次查询，详情及元数据最多读取 100 条，浏览器最多缓存 8 组。现有 RPC 没有编号数量限制参数，因此无法保证上游编号响应也只有 100 条。
- 精确 AV/BV 搜索只查询指定类别和期数中的一个编号，不加载整期编号或扫描中间页面。
- 相同的未完成前端请求复用结果；切换条件会取消旧浏览器请求，但不保证后端工作已停止。

实时收录的类别筛选和统计复用已有的每日元数据响应，在分页前完成，不为统计增加 RPC 调用。

## 公开入口的请求限制

以下限制由 `public_server.py` 提供，不适用于直接启动 `server.py` 的全部请求：

| 项目 | 限制 |
| --- | --- |
| 预览读取 | 35 秒 |
| 其他读取 | 15 秒 |
| 浏览器预览等待 | 40 秒（由前端统一设置） |
| 并发 RPC 请求 | 读取、写入各 1 个通道 |

请求不会自动重试。预览超时与榜单不存在、空结果分别处理，失败不会触发重算。

公开入口拒绝 URL 查询参数中的密钥；写入要求非空 `X-Auth-Key`，最终权限由 RPC 后端校验。浏览器静态资源禁用缓存；Python 代码修改后仍需重启 Waitress 进程。
