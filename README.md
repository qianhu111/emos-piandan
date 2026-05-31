# Emos 片单 Worker（TMDB · D1 累积 · 心跳调度预计算）

一个 Cloudflare Worker，按 [Emos 官方文档](https://wiki.emos.best/api/watch.html) 实现「动态片单」接口。
内容来自 **TMDB**：由 **Cron 定时抓取写入 D1 数据库**，Emos 来 `GET` 时**只读 D1**、不再实时请求 TMDB —— 响应快、与上游限速解耦。

抓取分两条并行推进的逻辑，节奏由控制台调（**改间隔即时生效，无需重部署**）：

- **热门**（默认每周一次）：抓各片单榜单头部，保证头部及时更新。
- **游标**（默认每小时一次）：沿热度往后翻页深挖长尾，逐步把整个分类铺满（每来源翻到 TMDB 第 500 页封顶）。

调度采用「**Cron 每小时心跳 + 代码按 D1 里存的间隔决定这次跑不跑**」：Cron 只负责每小时叫醒一次，
具体「热门每 N 小时、深翻每 N 小时」存在 D1 的 `config` 表里，在控制台随时改、立刻生效。

两者写入同一张表，靠主键去重累积、**只增不删**；曾上过热门榜的条目恒排在前。

> ⚠️ 本 Worker **必须绑定 D1**（binding 名为 `DB`），否则 `GET` 返回 500、定时任务跳过。

## 工作原理

```
Cron 每小时心跳 ─┬─ 距上次热门 ≥ hot_every 小时 → 抓 page 1..HOT_PAGES → 写 D1（tier=0，恒排前）┐
                 └─ 距上次深翻 ≥ deep_every 小时 → 抓 page cursor..+DEEP → 写 D1（tier=1）       ├─→ D1
                                                   cursor += DEEP（封顶 500 页，持久化到 D1）     ┘
控制台 ─ POST /admin/config → 写 config 覆盖层（name/cover/max_items、hot_every/deep_every）→ D1
控制台 ─ POST /admin/list   → 启用/禁用 · 添加(自建 discover 源)/删除片单 → D1（custom_lists + config.enabled）
Emos  ─ GET /watch/<key>    → 只读 D1，叠加 config 覆盖，按 (tier, seq) 排序组装 JSON 返回
```

## 返回结构（符合官方约定）

```json
{
  "name": "热门电视剧",
  "cover": "https://image.tmdb.org/t/p/w780/xxx.jpg",
  "updated_at": "2026-05-31 21:00:00",
  "videos": [
    { "tmdb_id": 1024, "tmdb_type": "tv",    "title": "电视标题", "sort": 1 },
    { "tmdb_id": 2048, "tmdb_type": "movie", "title": "电影标题", "sort": 2 }
  ]
}
```

`sort` 按位置赋值：热门层在前（1、2、3…），深翻层统一记 `100`（符合「1-100、越小越靠前」）。

## 路由（每个路径就是一个片单，填进 Emos 即可）

Emos 片单需兑换额度，默认 2 个名额。**当前启用并定时抓取这 2 个**（见 `LISTS_ENABLED`）：

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `/watch/tv` | 热门电视剧 | discover/tv，排除动画(genre 16) |
| `/watch/anime` | 热门动漫 | **日漫 + 国漫合并**：动画(genre 16) + 原语言 `ja`、`zh` 两来源合并（各自独立游标） |

**后续加额度再启用（代码已就绪，加进 `LISTS_ENABLED` 即开始抓取并填 URL）：**

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `/watch/movie` | 热门电影 | movie/popular |
| `/watch/doc` | 热门纪录片 | 电影 + 剧集的纪录片(genre 99) |
| `/watch/concert` | 热门演唱会 | 音乐类电影(genre 10402)，近似 |
| `/watch/top` | 高分电影 | movie/top_rated |
| `/watch/trending`、`/watch/today` | 混合热门 | trending/all |

> 要加/改片单：**简单的单一 `discover` 源直接在控制台「➕ 添加片单」即可**（生成自建片单，可随时删除）；**多源合并 / trending 等复杂片单**仍编辑 `src/index.js` 的 `LISTS`（给 `sources` 增删来源；结果不带 `media_type` 的端点要在来源上标 `type: "movie" | "tv"`）。内置片单只能在控制台禁用、不能删除。

## 部署（以 Cloudflare 网页端为主）

> ⚠️ **网页端部署不读 `wrangler.toml`**：该文件只对命令行 `wrangler` 生效。用网页控制台部署时，下面的 D1 绑定、Cron 触发器、变量、Secret 都要在控制台 UI 里**手动配一遍**（`wrangler.toml` 仅作参数对照表）。

### 方式 A：网页控制台（Dashboard）

1. **建 Worker**：Workers & Pages → Create → Worker，命名（如 `emos-watchlist`）→ 先 Deploy 一个空模板。
2. **填代码**：进该 Worker → Edit code → 把整份 `src/index.js` 粘进去 → Deploy。
3. **建 D1 数据库**：左侧 Storage & Databases → D1 SQL Database → Create，名字如 `emos-watchlist`。
4. **建表**：进该 D1 → **Console** 标签 → 粘贴 `schema.sql` 内容执行。（也可跳过——Worker 首次运行会惰性建表；显式建一次更稳。）
5. **绑定 D1**：回到 Worker → Settings → Bindings → Add binding → D1 database → **Variable name 必须填 `DB`** → 选上面那个库 → 保存。
6. **加 Cron 触发器**：Worker → Settings → Triggers → Cron Triggers → Add → 填 `0 * * * *`（每小时心跳）→ 保存。**漏了这步就不会自动抓取**，只能在控制台手动触发。
7. **配变量与机密**：Worker → Settings → Variables and Secrets：
   - **Secret（加密）**：`TMDB_TOKEN`（必需；缺它定时抓取直接跳过）、`ADMIN_TOKEN`（保护控制台 / 手动触发，任意字符串）。TMDB Token 在 <https://www.themoviedb.org/settings/api> 获取（v4 Read Token 或 v3 API Key 均可）。
   - **普通变量（可选）**：`TMDB_LANG`、`TMDB_REGION`、`DEFAULT_LIST`、`HOT_PAGES`、`DEEP_PAGES`、`LISTS_ENABLED`；不填则用代码默认值。
8. **完成**：打开 `https://<worker名>.<子域>.workers.dev/`（或自定义域）就是控制台，填入 `ADMIN_TOKEN` 即可用。把 `…/watch/tv`、`…/watch/anime` 填进 Emos。

> 改代码后重复第 2 步（重新粘贴 + Deploy）即可；D1 / Cron / 变量已配好，不用再动。新增的表/列（如本次的 `config.enabled`、`custom_lists`）由代码里的 `ensureSchema` 在首次 admin 调用时自动补，无需手动迁移。

### 方式 B：命令行 wrangler（可选）

命令行部署会自动读取 `wrangler.toml`，把绑定 / 变量 / Cron 一次建好（Secret 仍需单独设）：

```bash
npm i -D wrangler
npx wrangler d1 create emos-watchlist                              # 把输出的 database_id 填进 wrangler.toml
npx wrangler d1 execute emos-watchlist --remote --file=schema.sql  # 建表
npx wrangler secret put TMDB_TOKEN                                 # 再 put ADMIN_TOKEN
npx wrangler deploy
```

发布后把 `https://<你的worker域名>/watch/tv`、`/watch/anime` 填入 Emos。首轮数据等整点 Cron，或在控制台点「全部抓热门」手动触发一次填充。

## 抓取频率与免费额度（当前 tv+anime 两片单，HOT=DEEP=5 页，默认间隔）

| Cloudflare 免费额度<sup>*</sup> | 本方案用量 | 余量 |
| --- | --- | --- |
| 子请求 **50 / 次调用** | 多数心跳只深翻 ≈ tv 5 页 + anime 6 页 ≈ **11**；热门也到期的那次 ≈ **22** | ✅ 充足 |
| 请求 **10 万 / 天** | 心跳 24 + Emos 拉取 ≈ **~30 / 天** | ✅ |
| D1 写 **10 万行 / 天** | ≤100 行/片单/次 × 2 片单 ×（深翻 24 + 热门偶发）≈ **~5,000 / 天** | ✅ |
| D1 读 **500 万行 / 天** | Emos 拉取 × 全表（满载几万行） | ✅ |
| D1 存储 **5 GB** | 满载约 3 万条 ≈ **几 MB** | ✅ |
| Cron **5 个 / Worker** | **1** 个（每小时心跳） | ✅ |

<sup>*</sup> 额度按 2026 年初官方口径，**部署前请用 `wrangler` 或 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) / [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 再核对一次**。

- **瓶颈是「子请求 50/次」**：默认每小时心跳大多只跑深翻（≈11）；热门与深翻在同一小时到期时峰值 ≈22，仍远低于 50。若把更多片单加进 `LISTS_ENABLED` 致单次 >45，请把心跳 cron 拆密或升级 Workers Paid（子请求上限 1000）。
- **铺满速度**：tv 共 500 页 ÷ 5 页/次 = 100 次，深翻每小时一次约 **4 天**走遍可及范围。控制台间隔最小粒度是「小时」（心跳频率）；想更细（如每 30 分），把心跳 cron 调密（网页端 Settings → Triggers → Cron Triggers，或命令行改 `wrangler.toml` 后 `deploy`）即可，仍在额度内。

## 可调参数（网页端在 Settings → Variables and Secrets 配置；命令行写 `wrangler.toml` 的 `[vars]`，密钥用 Secret）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `TMDB_LANG` | `zh-CN` | TMDB 返回语言 |
| `TMDB_REGION` | `CN` | 地区，影响上映/排行口径 |
| `DEFAULT_LIST` | `tv` | 根路径 `/` 返回哪个片单 |
| `HOT_PAGES` | `5` | 热门每次每来源抓页数（×20=条数） |
| `DEEP_PAGES` | `5` | 游标每次每来源深翻页数 |
| `LISTS_ENABLED` | `tv,anime` | **初始默认**启用的片单（仅作种子）；控制台开关后以 D1 `config.enabled` 为准 |
| `NAME_<KEY>` | — | 覆盖某片单标题（控制台 per-list 名称优先级更高） |
| `COVER` | — | 固定封面图（控制台 per-list 封面优先级更高；都不设则取榜首作品背景图） |
| `TMDB_TOKEN` | — | **Secret**：网页端在 Settings → Variables and Secrets 加密填入；命令行 `npx wrangler secret put TMDB_TOKEN` |
| `ADMIN_TOKEN` | — | **Secret**：保护控制台与 `/admin/*` 端点；配置方式同上 |

> **抓取间隔不再用 env / cron 配置**：改由控制台写入 D1 的 `config` 表（全局 `hot_every` / `deep_every`，单位小时，即时生效）。
> 配置优先级：**D1 config（控制台）> env（`NAME_`/`COVER`/`LISTS_ENABLED`）> 代码默认 / 抓取自动值**。
> 启用判定：**D1 `config.enabled`（1/0）> `env.LISTS_ENABLED` 成员 >（默认不在则不抓）**；旧库 `ALTER` 自动补 `enabled` 列（NULL = 回退 env，行为同现状）。

## 控制台

访问根路径 **`/`**（即 `https://<域名>/`）是一个运维控制台：填入 `ADMIN_TOKEN` 后，可：

- **查看状态**：各片单条目数 / 游标 / 更新时间 / 启用状态 / 是否自建。
- **启用 / 禁用片单**：每张卡片右上角的开关，即时生效（写 D1 `config.enabled`）。**禁用只停 cron 抓取，不影响 `GET /watch/<key>` 返回已存数据** —— 已填进 Emos 的链接不会断。
- **添加 / 删除片单**：
  - **添加**：「➕ 添加片单」卡用引导表单（key / 名称 / 类型 movie·tv / 排序 / 可选 genre / 可选语言）生成**单个 TMDB `discover` 源**，添加后默认启用。`sources` 由服务端按类型拼装，前端不传 path/JSON，无注入面。
  - **删除**：仅限**自建**片单（连带清除其 items / 游标 / 配置）；**内置片单不可删除，只能禁用**。
  - 需要**多源合并 / trending 等复杂片单**，仍改 `src/index.js` 的 `LISTS`。
- **手动触发**：一键抓热门 / 深翻一次（全部或单个片单；指定片单即使被禁用也可手动触发）。
- **预览内容**：查看某片单将返回 Emos 的条目。
- **深度自定义（即时生效，无需重部署）**：
  - 每张卡片可改 **名称 / 固定封面 URL / 返回上限 `max_items`**（0 = 不限），保存后写入 D1 `config` 表，下次 `GET /watch/<key>` 即叠加生效（内置与自建片单均可）。
  - 每张卡片有 **「📋 复制导入链接」**，一键复制该片单的 Emos 导入地址 `<origin>/watch/<key>`（需 HTTPS 或 localhost 才能用系统剪贴板）。
  - 顶部 **「⏱ 抓取间隔」面板**：设「热门每 N 小时、深翻每 N 小时」，控制每小时心跳里各片单的抓取节奏。

token 存在浏览器本地，所有操作经 `X-Admin-Token` 头鉴权；写配置走 `POST /admin/config`，片单生命周期（启用/禁用、添加、删除）走 `POST /admin/list`。

## 首次填充 / 手动触发 / 排错

数据由 Cron **每小时心跳**填充：心跳触发后，按 `config` 里存的间隔（默认深翻每小时、热门每周）决定各片单这次跑不跑。刚部署时 D1 是空的，访问会返回空 `videos` —— 这是正常现象，等下一个整点心跳就会写入第一批。

**想立即填充**：打开控制台（根路径 `/`），填好 `ADMIN_TOKEN`，点「⚡ 全部抓热门」/「⛏ 全部深翻一次」——网页端最省事。也可直接调端点：

```bash
# PowerShell 请用 curl.exe，不要用 curl 别名
curl.exe "https://<域名>/admin/refresh?mode=hot&token=<ADMIN_TOKEN>"
curl.exe "https://<域名>/admin/refresh?mode=deep&token=<ADMIN_TOKEN>"
```

返回每个片单的 `fetched`（原始条数）/`unique`（去重后）/`cursor`，或 `error`。常见问题定位：

| 现象 | 原因 / 处理 |
| --- | --- |
| 控制台报 `Unexpected token '<' … is not valid JSON` | 某 admin 接口返回了 HTML 错误页（不是 JSON）：多半 **D1 未绑定/绑定名不对**，或 Worker 抛异常。直接开 `https://<域名>/admin/stats?token=<TOKEN>` 看真实响应；网页端检查 Settings → Bindings 里 binding 名是否为 `DB`。 |
| 数据一直不自动更新 | **没加 Cron 触发器** → Settings → Triggers → Cron Triggers 加 `0 * * * *`。网页端部署不会从 `wrangler.toml` 自动建 cron。 |
| `report` 里 `error` 含 `TMDB 401/404` | `TMDB_TOKEN` 未配或无效 → Settings → Variables and Secrets 重设。 |
| 返回 `未绑定 D1` | Worker 没绑 D1，或 binding 名不是 `DB`（Settings → Bindings）。 |
| `fetched>0` 但 `/watch/tv` 仍空 | 确认该片单已启用（控制台开关，或在 `LISTS_ENABLED` 内）。 |

**查库 / 看日志**：

- **网页端**：D1 → 你的库 → **Console** 标签跑 SQL；Worker → **Logs** 标签看 cron/请求实时日志。
- **命令行**：
  ```bash
  npx wrangler d1 execute emos-watchlist --remote --command "SELECT tier, count(*) FROM items GROUP BY tier"
  npx wrangler tail     # 实时日志
  ```

## 本地调试

> 本节是命令行 `wrangler` 工作流；纯网页端部署可跳过（网页端用上面的「控制台手动触发 + Logs/Console 标签」即可）。

```bash
npx wrangler dev
# 触发一次「心跳」（wrangler 的 __scheduled 测试端点；cron 参数我们已不读取，给个占位即可）：
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"   # 空库首次心跳会同时跑热门+深翻
# 想强制某次抓取（绕过间隔门控），直接用手动端点（先在 dev 设 ADMIN_TOKEN）：
curl "http://localhost:8787/admin/refresh?mode=hot&token=<ADMIN_TOKEN>"
curl "http://localhost:8787/admin/refresh?mode=deep&token=<ADMIN_TOKEN>"   # 多跑几次看游标推进
# 查看本地库：
npx wrangler d1 execute emos-watchlist --local --command "SELECT tier, count(*) FROM items GROUP BY tier"
# 拉取片单：
curl http://localhost:8787/watch/tv
# 跑离线单测（内存版 D1 + mock TMDB，秒级，无需联网/部署）：
node _test.mjs
```
