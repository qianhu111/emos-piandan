# Emos 动态片单 Worker

把 [TMDB](https://www.themoviedb.org/) / 豆瓣的榜单，变成 [Emos](https://wiki.emos.best/api/watch.html) 可订阅的「动态片单」。运行在 Cloudflare Workers + D1 上，**全程网页端操作，无需命令行、无需 `wrangler.toml`**。

部署完成后，填进 Emos 的是 `https://<你的-worker-域名>/watch/<片单key>`，片单内容由 Worker 按 Cron 定时自动更新。

---

## 特性

- **多数据源**：内置 TMDB、豆瓣，代码级可扩展（后续可加 Bangumi / Trakt 等）。
- **三种抓取模式**：热门 `hot` / 最新 `new` / 全量 `full`。可在控制台手动单次触发，也可设为 Cron 心跳自动执行。
- **网页控制台**：片单增删改查、启用/禁用、复制订阅链接；暗色/亮色切换；手机端适配。
- **可观测**：错误日志面板（按级别 / 片单筛选）+ 一键「导出日志」「复制诊断信息」。
- **易上手**：首次部署有欢迎引导，一键创建推荐片单；片单配置可导入 / 导出（JSON）备份与分享。
- **零额外依赖**：只用 D1，一处存储，不需要 KV / R2 / 外部数据库。

---

## 准备

1. 一个 **Cloudflare 账号**（免费版即可）。
2. 一个 **TMDB 令牌**：登录 TMDB → [Settings → API](https://www.themoviedb.org/settings/api)，复制 **API Read Access Token（v4）** 或 **API Key（v3）**——本服务两者都支持，会自动识别。
3. 自定义一个**管理密码**（下文的 `ADMIN_TOKEN`，登录控制台用；设一个足够长、别人猜不到的字符串）。

---

## 部署步骤（全程在 Cloudflare 网页后台）

> 你需要项目里的三个文件：`index.js`（后端 + 内嵌前端）、`schema.sql`（建表）、本 `README.md`。

**1. 创建 Worker**
Workers & Pages → Create → Workers → 起个名字 → Deploy（先部署一个默认版本占位）。

**2. 填入代码**
进入该 Worker → **Edit code** → 清空编辑器里的默认内容 → 粘贴整个 `index.js` → Deploy。

**3. 创建 D1 数据库**
Storage & Databases → D1 → Create database → 起个名字（如 `emos`）。

**4. 建表**
打开刚建的 D1 → **Console** 标签 → 粘贴整个 `schema.sql` → 执行。
（可跳过：Worker 首次运行会自动建表。此步用于显式初始化。）

**5. 绑定 D1 到 Worker**
回到 Worker → Settings → **Bindings** → Add → D1 database → 选刚建的库，
**Variable name 必须填 `DB`**（区分大小写），保存。

**6. 添加 Cron 触发器**
Worker → Settings → **Triggers** → Cron Triggers → Add → 填 `0 * * * *`（每小时一次心跳）→ 保存。
> 触发**频率**只能在这里配置；每次触发**执行哪种模式**由控制台切换（见下文）。

**7. 配置 Secrets**
Worker → Settings → **Variables and Secrets** → 用 **Encrypt（加密）** 方式填入两项：
- `TMDB_TOKEN`：第 2 步准备的 TMDB 令牌
- `ADMIN_TOKEN`：你自定义的管理密码

**8. 完成初始化**
打开 Worker 域名（形如 `https://<name>.<account>.workers.dev`）→ 控制台顶部填入 `ADMIN_TOKEN` 并保存 → 按欢迎引导**一键创建推荐片单** → 完成。
之后把 `https://<域名>/watch/<片单key>` 填进 Emos 即可。

---

## 抓取模式与 Cron 调度

三种模式，控制台「抓取调度」面板一键切换 Cron 模式，**下次 Cron 触发即按新模式执行**；三种模式也都能在「手动触发」区直接执行（不改变当前 Cron 模式），其中「全量」会在后台自动连续抓完所有启用片单。

| 模式 | 抓什么 | 行为 |
| --- | --- | --- |
| **hot（热门）** | 各启用片单的头部热门页 | 默认模式。写入 `tier=0`，恒排所有条目最前。可设「每 N 次心跳执行一次」（`hot_interval`）。 |
| **new（最新）** | 仅当前年份发布的内容，按发行日期降序 | 写入 `tier=1`。翻完当年所有页后标记「已完成」并停止；保持模式不变，等你手动切回。 |
| **full（全量）** | 从当前年逐年回溯（2026 → 2025 → …），对所有启用片单生效 | 写入 `tier=1`。进度存 D1、断点续传，可设回溯截止年份。**手动点「全量」会在后台自动连续抓完所有启用片单**（免费版亦可，自动绕过单次请求子请求上限）；作为 Cron 模式时每次心跳推进一批。 |

**排序规则**：`tier=0`（热门）永远最前、按榜单位置；`tier=1`（最新/全量）排其后、按入库顺序。同一条目若两处都出现，取较小的 `tier`（热门优先）。

**典型用法**：日常 `hot` 自动更新热门；想补今年新片临时切 `new`，跑完切回；想铺满历史时点一次「全量」，后台会自动连续抓完所有启用片单。

---

## 日常使用

- **添加片单**：选数据源 → 配置筛选（类型 / Genre / 排除 Genre / 语言 / 地区 / 排序）→ 命名 → 保存。
- **管理片单**：随时改名、换源、调条件、改封面、设返回条数上限、启用/禁用、删除（任何片单都可删）。
- **订阅链接**：每张片单卡片点「复制链接」得到 `/watch/<key>`，填进 Emos。非 HTTPS 环境会弹出链接供手动复制。
- **备份/迁移**：设置面板「导出片单配置」下载 JSON；换环境后「导入片单配置」一键还原（按 key 自动新建或更新）。

---

## 排错

**先看控制台「日志」面板**：按级别（error/warn/info）或片单筛选，点条目展开看详情。

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 打开域名提示「未绑定 D1」 | 没绑定，或 Variable name 不是 `DB` | 重做第 5 步，确认变量名是 `DB` |
| 控制台提示「未配置 ADMIN_TOKEN」 | 没配置该 Secret | 重做第 7 步 |
| 抓取失败 / 片单为空 | `TMDB_TOKEN` 错误或额度问题 | 检查第 7 步的 Secret；看日志面板的 error 详情 |
| 豆瓣源没数据 | 豆瓣反爬，已自动降级 | 配好 `TMDB_TOKEN`（豆瓣条目要归一到 TMDB id）；或改用 TMDB 源 |
| Emos 拉不到内容 | `/watch/<key>` 的 key 写错，或片单被禁用/暂无数据 | 核对 key；启用片单并先手动触发一次抓取 |

**求助作者**：日志面板「复制诊断信息」一键复制摘要（最近错误 + 配置摘要 + 环境信息，**已脱敏，不含 Token**），或「导出日志」下载 JSON，连同问题描述发给作者即可。

---

## 免费额度

常规自用规模远在 Cloudflare 免费额度内：Workers 免费版每天 10 万次请求；D1 免费版提供数 GB 存储与每天数百万行读 / 十万行写；Worker 每次调用的子请求上限 50（本服务内置预算控制，自动在上限内收敛）。Cron 每小时一次心跳，开销极小。主要消耗来自 Emos 侧对 `/watch/<key>` 的轮询，量很小。

---

## 接口格式（Emos 兼容）

`GET /watch/<key>` 返回：

```json
{
  "name": "片单名称",
  "cover": "封面图 URL",
  "updated_at": "YYYY-MM-DD HH:MM:SS",
  "videos": [
    { "tmdb_id": 1024, "tmdb_type": "tv", "title": "标题", "sort": 1 }
  ]
}
```

`sort` 取值 1–100，越小越靠前。

---

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `index.js` | 全部后端逻辑 + 内嵌前端控制台（单文件部署） |
| `schema.sql` | D1 表结构（`lists` / `items` / `config` / `progress` / `logs`） |
| `verify.mjs` | 本地校验脚本（内存版 D1 mock + 伪造 fetch 跑真实入口），开发时 `node verify.mjs` |
