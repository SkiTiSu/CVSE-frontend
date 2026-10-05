# CVSE Frontend Display

Simplified CVSE video data display system that fetches real server data.

## Quick Start

### 1. Install Dependencies
Install uv: https://docs.uv.dev/ (or `nix develop` for Nix users)
```bash
git submodule update --init --recursive
uv sync 
```

### 2. Start Server
Use `CVSE_SERVER_HOST`(default: "0.0.0.0") and `CVSE_SERVER_PORT`(default: "25123") to specify server configuration.
```bash
uv run server.py
```

### 3. Access
- Frontend: http://localhost:25123
- API Data: http://localhost:25123/api/weekly-data

## File Description

- `index.html` - Frontend page
- `server.py` - Web server core code
- `quick_start.py` - Startup script
- `rpc_tools/` - CVSE client library

## Features

- 📊 Display weekly video statistics
- 🎯 Filter videos by category
- 🔗 Click to jump to Bilibili page
- 📱 Responsive design

## TODO

- 添加 CORS 解决封面显示问题
- 完成皮卡挑选，预览校审（注意预览校审逻辑是如果有已经计算好的数据，直接展示，只有用户提出请求时才重新计算。重新计算开销极大，大约需要运行几分钟，需要合理设计/设置权限防止浪费服务器资源）

## Review workflow

- 搬运筛选支持全部、仅搬运、排除搬运；服务端先筛选，再统计和分页。
- 编辑面板一次只打开一个。点击面板外、取消、关闭、Escape 或切换页面会丢弃当前未保存草稿；此前“保存到本地”的修改仍然保留。
- “收录排除”和“批量排除”使用现有排除状态：`is_examined=true`、`ranks=[]`。保留搬运标记和 Staff 信息，不删除稿件。
- 排除/拒收只进入本地待提交队列，可移除或清空；只有确认“提交更改”才发送后端。
- 预览每条稿件使用横向列表，显示播放、点赞、分享、硬币、收藏、评论、弹幕；“新上榜”改为“新投稿”。
- HOT/SH 默认隐藏，勾选后仅在预览第一页显示（精确编号搜索仍显示命中稿件），按 special_rank 区分；首次预览附带 rank 0 的 [0,1) 查询，详情/元数据各最多100条，浏览器缓存最多8组榜单/期数。切换显示和翻页不重复特殊查询。普通页按缓存的有序稿件索引切片，详情和元数据只读取当前页。 大榜单首次建立编号缓存可能需要十几秒；临时公开服务的预览超时为35秒，浏览器等待40秒，其余读取仍为15秒，不自动重试。

## Checks (no production service required)

This application uses native browser ES modules, so it has no frontend bundling/build step.

```bash
# Python 3.13; submodules must be initialized as above
uv sync --frozen
uv run python -m unittest discover -s tests -v
uv run python -m py_compile server.py quick_start.py

# Node.js 20+; development-only dependencies
npm ci
npm run check
npm test

# Real Chromium layout/interaction coverage (all API requests are mocked)
npx playwright install chromium
npm run test:browser
# Or use an existing browser:
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser

# Optional local mock UI; only binds loopback, disables writes and remote fetches
node tests/mock_server.cjs
# http://127.0.0.1:25124
```

The Python suite mocks every RPC client and uses synthetic fixture data. DOM unit tests use jsdom with mocked fetch. Browser tests block non-local requests, including production APIs and external covers. The local fixture server never imports the production server or proxies requests.

## Temporary public entrypoint

`uv run python public_server.py` serves the modified real application on loopback
`127.0.0.1:25125`. Use this entrypoint (not `server.py`) for a requested public
Quick Tunnel. It never reads a default, environment, or file-based API key.
Mutations require a nonempty user-supplied `X-Auth-Key` header; the existing RPC
service checks that key. Credentials in query strings are rejected. The UI does
not claim a key is valid from an anonymous read operation.

With the official Cloudflare binary installed, the requested temporary tunnel is:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:25125
```

Both processes must stay alive on the same network-capable host. Quick Tunnels
are temporary and have no uptime guarantee. Browser-to-tunnel HTTPS does not add
TLS to the existing raw TCP RPC leg at `47.104.91.74:8663`; deployment on an
appropriate trusted network or a TLS-protected RPC transport is recommended.

Validation in the current cloud execution environment: local health succeeded,
but outbound RPC returned `Network is unreachable`. Quick Tunnel creation also
failed resolving `api.trycloudflare.com` because outbound DNS was unreachable.
No public URL was allocated, no live mutation was performed, and no key was
read or configured. The user must enter any key themselves in the browser.

## Bounded preview recovery

Normal preview pages slice a rank-ordered index snapshot by row offset (page size
1–110). Rank values may repeat and skip numbers; they must never be used as row
offsets. On a cache miss, one RPC reads all positive-rank AV/BV indexes, without
reading all ranking details or metadata. The detached ID snapshot is shared for
five minutes by ranking, issue, review mode and authorization identity. Summary
changes and local recalculation invalidate it. Concurrent cold reads coalesce.
An LRU retains at most eight snapshots and 200,000 IDs total; oversized snapshots
fail explicitly rather than silently dropping rows. Detail and metadata calls
remain limited to the requested page. RPC detail order is restored to index order,
including ties. Pagination totals use the snapshot length; the summary still
shows upstream count (which can also include rank-zero special entries).
Special rows use a separate [0,1) rank interval on the first uncached preview,
with at most 100 detail and metadata records. The existing RPC has no index
limit parameter: the rank-zero index response and upstream generation cannot
be guaranteed to contain at most 100 records. No full-ranking detail scan is used.
Repeated identical in-flight previews share one fetch. Changed criteria cancel
the old browser fetch; browser cancellation does not guarantee that remote work
has stopped. The read timeout remains 15 seconds and the browser deadline is
20 seconds. There are separate one-request read and write lanes (two total),
so a stalled write cannot consume the read lane. Writes are never retried.

Source updates do not reload the running Waitress process. Applying the Python
changes requires an explicitly authorized service restart; changing these files
alone must not be treated as a production fix being active. Static JS may be
served from disk before that restart, so deployment must be coordinated.


## Additional review controls (2026-10-05)

- Recording rank filters support OR multi-selection. “其他（未审核且无归属）” means
  `is_examined=false` and `ranks=[]`, and remains a subset of the unexamined count.
  Filtering and statistics run before pagination on the existing daily metadata
  response, without extra upstream calls. Counts follow the current query filters.
- The combined recording AV/BV input recognizes AV prefixes and numeric AV IDs,
  retaining the existing selected-date scope. Selecting checkboxes does not fetch;
  click Search to apply the selection. Identical pending recording requests share
  one fetch.
  “清除筛选” resets the date to today, clears keyword/ID/rank/status/republish
  filters, and fetches page one once; page size, layout and pending edits remain.
- Preview returns duration and review state from its existing metadata batch.
  Exclusions are visibly marked, including pending local changes; removing pending
  changes restores the marker. Submission does not automatically recalculate rankings.
- Preview has synchronized top/bottom page jump controls and 70/110 row options.
  Normal pages have a 110-row bound; rank-zero HOT/SH details retain their 100-row
  bound. Jumping slices the shared ID snapshot and reads only that page’s details,
  never intervening pages.
- Preview AV/BV search accepts complete IDs only and calls lookupRankingInfo with
  one index in the selected ranking and issue. It does not scan rank intervals,
  fetch special rows, or retry misses. Matching HOT/SH is visible even when hidden
  in normal browsing. Invalid IDs are rejected before RPC.
- Missing cached rankings get a friendly 404 response; empty results, timeouts,
  and other failures remain distinct. No error path automatically recalculates.
- The header uses the supplied white CVSE logo over the indigo background.

The public entrypoint supports `CVSE_PUBLIC_PORT` (default 25125) to avoid replacing
an existing local service, e.g. `CVSE_PUBLIC_PORT=25126 .venv/bin/python public_server.py`.
Point the requested `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:25126`
at that port. Both processes and this computer must remain running.


## Appearance

The header appearance selector supports system, light and dark modes. System is
selected by default and responds immediately to OS appearance changes. Manual
preferences are saved locally and synchronized across tabs; theme switching
never requests backend data. The theme initializer runs before the stylesheet
paints to avoid a light flash when restoring dark mode. If browser storage is
unavailable, switching still works for the current tab.


## Mobile layout

At widths up to 768px, navigation uses two rows and recording filters can be
expanded without making a request. The selected date and summary remain visible;
collapsing preserves filter selections. Forms use 16px input text and 44px action
buttons, while pagination and preview controls wrap into explicit grids. Recording
cards use compact thumbnails. The editor keeps its save/cancel actions outside its
scrolling body and respects dynamic viewport height and safe-area insets. Desktop
layout is unchanged. Layout checks cover 320px, 390px and 430px widths in light and
dark modes, including a 440px-tall editor viewport.
