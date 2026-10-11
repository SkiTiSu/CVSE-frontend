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

## 预览分页

预览不再读取或缓存整期正名次编号，也不显示总页数或提供任意页跳转。每次只请求当前游标附近的名次区间，最多查询当前页 120 条详情及元数据。前端记录已访问页的游标，支持上一页和下一页；改变条件或每页条数会清除旧预览及游标，等待手动点击“预览 / 搜索”从第一页重新开始。

名次可能并列并跳号。游标记录名次及该名次已读条数，下一页从并列组内继续，避免把名次直接当成行号造成漏项。编号查询多预取一个位置判断是否还有下一页；详情响应按编号顺序恢复。现有 RPC 无法限制并列组返回的编号数，极大的并列组仍可能产生较大的编号响应，但不会查询整期详情。

HOT/SH 使用单独的 `[0, 1)` 查询，详情及元数据最多读取 100 条，浏览器最多缓存 8 组。完整 AV/BV 搜索直接查询指定稿件，不扫描名次区间。相同的未完成前端请求复用结果，切换条件取消旧请求；浏览器取消不保证远端工作停止。

实时收录的类别筛选和统计复用已有的每日元数据响应，在分页前完成，不为统计增加 RPC 调用。

## 部署核对

页面和静态资源按文件读取，Python 代码则在进程启动时加载。仅执行 `git pull` 或更新容器挂载目录，不会让运行中的 Python 接口自动更新；需要重启对应服务。代码打包在 Docker 镜像中时，需要重新构建镜像并创建容器，仅重启旧镜像无法更新代码。

上线后读取部署地址的 `/api/health`。当前运行的接口应包含：

```json
"preview": {"api_version": 2, "max_page_size": 120, "pagination": "cursor"}
```

再请求 `/api/ranking-preview?rank=sv&index=216&page=1&page_size=120`（期刊和期数可换成已有榜单）。成功响应应包含布尔字段 `has_next`；为 `true` 时还需有效的 `next_cursor`。若健康检查缺少上述标识、120 条仍被 110 条上限拒绝，或分页字段缺失，说明接口尚未更新，应核对实际处理请求的容器和端口映射。前端会明确提示服务未更新，不再把缺失的分页信息误当作最后一页。

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
