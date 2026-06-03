-- Emos 片单 Worker —— D1 表结构（重构版 · 多数据源）
--
-- 网页端部署：进 D1 数据库 → Console 标签 → 粘贴本文件内容执行。
-- 说明：Worker 运行时 ensureSchema() 也会惰性建表，二者结构一致；此处为显式初始化途径。
--
-- 设计要点（本次重构）：
--   1. 片单全部存 D1（lists 表），代码里不再硬编码任何固定片单；所有片单地位平等，均可改可删。
--   2. 每个片单由一个或多个「数据源」组成，存在 lists.sources（JSON 数组），适配多数据源（TMDB / 豆瓣 / 后续扩展）。
--   3. items 沿用 tier/seq 累积模型：tier=0 热门恒排前，tier=1 最新/全量排后；输出按 (tier, seq) 排序。

-- ============ 片单定义 + 运行态（唯一片单来源） ============
CREATE TABLE IF NOT EXISTS lists (
  list_key   TEXT PRIMARY KEY,            -- URL 末段，[a-z0-9_-]{1,32}
  name       TEXT    NOT NULL,            -- 片单标题（1-80 字）
  sources    TEXT    NOT NULL,            -- JSON 数组：[{ "provider":"tmdb", "params":{...} }, ...]
  cover      TEXT,                        -- 用户固定封面 URL（覆盖自动封面；留空=用 cover_auto）
  cover_auto TEXT,                        -- 抓取时自动取的榜首作品背景图
  max_items  INTEGER NOT NULL DEFAULT 0,  -- 返回 Emos 的最大条数；0 = 不限
  enabled    INTEGER NOT NULL DEFAULT 1,  -- 启用开关：1/0（禁用只停 cron 抓取，已存数据照常 /watch）
  position   INTEGER NOT NULL DEFAULT 0,  -- 控制台展示顺序（小在前）
  next_seq   INTEGER NOT NULL DEFAULT 0,  -- seq 自增计数器（允许空洞）
  updated_at TEXT,                        -- 最近一次抓取的北京时间 "YYYY-MM-DD HH:MM:SS"
  created_at TEXT                         -- 片单创建时间（北京时间）
);

-- ============ 抓取到的条目（去重累积，只增不删） ============
CREATE TABLE IF NOT EXISTS items (
  list_key  TEXT    NOT NULL,             -- 所属片单
  tmdb_type TEXT    NOT NULL,             -- 'movie' | 'tv'（Emos 只认这两种）
  tmdb_id   INTEGER NOT NULL,             -- TMDB id（所有数据源最终都归一到 TMDB id）
  title     TEXT    NOT NULL,
  tier      INTEGER NOT NULL,             -- 0=热门（恒排前）  1=最新/全量（排后）
  seq       INTEGER NOT NULL,             -- 入库顺序，同 tier 内决定先后
  PRIMARY KEY (list_key, tmdb_type, tmdb_id)   -- 同一片单同一条目只存一次
);

-- 输出排序用：WHERE list_key=? ORDER BY tier, seq
CREATE INDEX IF NOT EXISTS idx_items_order ON items(list_key, tier, seq);

-- ============ 全局配置（KV） ============
-- 单行一个键值，value 一律存字符串（读取时由代码做类型校正）。阶段 2 起使用以下键：
--   cron_mode         当前 Cron 心跳执行哪种模式：'hot' | 'new' | 'full'（默认 'hot'）
--   hot_interval      hot 模式 Cron 间隔：每 N 次心跳抓一次热门（默认 1=每次）
--   full_floor_year   full 模式回溯截止年份；0 = 不限（实际硬下限见代码 HARD_FLOOR_YEAR）
--   heartbeat_seq     Cron 心跳计数器（用于 hot 间隔门控，自增）
--   last_heartbeat_at 最近一次 Cron 心跳时间（北京时间）
--   last_hot_at / last_new_at / last_full_at  各模式最近一次实际执行时间（北京时间）
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ============ 抓取进度（new / full 断点续传） ============
-- 每个「片单 × 数据源 × 模式」一行，记录抓到哪一年哪一页，支持跨心跳续传。
--   - new：只抓当前年份；year 不等于当前年份时代码会自动重置（跨年自动续抓今年新片）。
--   - full：从当前年份逐年回溯（2026→2025→…），翻完一年进上一年，低于截止年份即 done。
--   - 不支持按年筛选的源（如豆瓣，supportsYear=false）：单遍翻完其榜单即 done，不按年回溯。
-- 完成（done=1）后该源不再推进；切换 cron_mode 不清进度，重置请用控制台「重置进度」。
CREATE TABLE IF NOT EXISTS progress (
  mode        TEXT    NOT NULL,            -- 'new' | 'full'
  list_key    TEXT    NOT NULL,            -- 所属片单
  src_idx     INTEGER NOT NULL,            -- 源在 lists.sources 数组中的下标
  year        INTEGER,                     -- 当前抓取年份（new=当年；full=回溯中的年份；非年份源可为 NULL）
  page        INTEGER NOT NULL DEFAULT 1,  -- 当前年份下一个要抓的页码
  total_pages INTEGER,                     -- 当前年份总页数（来自上游，供进度展示；未知为 NULL）
  done        INTEGER NOT NULL DEFAULT 0,  -- 该(模式,片单,源)是否已完成：1/0
  pages_done  INTEGER NOT NULL DEFAULT 0,  -- 累计已抓页数（展示用）
  updated_at  TEXT,                        -- 最近推进时间（北京时间）
  PRIMARY KEY (mode, list_key, src_idx)
);

-- ============ 错误日志（阶段 4：可观测） ============
-- 每次 Cron 心跳清理：仅保留最近 500 条且 7 天内的记录（见代码 cleanupLogs / LOG_KEEP_ROWS / LOG_KEEP_DAYS）。
-- 与 ensureSchema() 中的惰性建表保持结构一致。
CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT    NOT NULL,            -- 北京时间 "YYYY-MM-DD HH:MM:SS"
  level    TEXT    NOT NULL,            -- info | warn | error
  source   TEXT,                        -- cron | admin | fetch | douban | watch（自由文本，仅展示）
  list_key TEXT,                        -- 相关片单（可选）
  message  TEXT,                        -- 摘要
  detail   TEXT                         -- 详情（错误堆栈 / 上游响应体，截断存储）
);

-- 列表查询用：最新在前
CREATE INDEX IF NOT EXISTS idx_logs_id ON logs(id DESC);
