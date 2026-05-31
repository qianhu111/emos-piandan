-- Emos 片单 Worker 的 D1 表结构
-- 初始化（远程）：npx wrangler d1 execute emos-watchlist --remote --file=schema.sql
-- 本地调试：把 --remote 换成 --local
-- 注：Worker 的 scheduled() 启动时也会惰性建表，这里是显式初始化途径，二者结构一致。

CREATE TABLE IF NOT EXISTS items (
  list_key  TEXT    NOT NULL,            -- 片单 key：tv / anime / movie ...
  tmdb_type TEXT    NOT NULL,            -- 'movie' | 'tv'
  tmdb_id   INTEGER NOT NULL,
  title     TEXT    NOT NULL,
  tier      INTEGER NOT NULL,            -- 0=上过热门榜（恒排前）  1=仅游标深翻
  seq       INTEGER NOT NULL,            -- 入库顺序，同 tier 内决定先后
  PRIMARY KEY (list_key, tmdb_type, tmdb_id)   -- 去重累积：同一片单同一条目只存一次
);

-- 输出排序用：WHERE list_key=? ORDER BY tier, seq
CREATE INDEX IF NOT EXISTS idx_items_order ON items(list_key, tier, seq);

CREATE TABLE IF NOT EXISTS lists (
  list_key   TEXT PRIMARY KEY,
  cover      TEXT,                        -- 片单封面（榜首作品背景图）
  updated_at TEXT,                        -- 最近一次抓取的北京时间
  cursor     TEXT,                        -- JSON: {"pages":[p0,p1,...]} 每来源下一深翻页
  next_seq   INTEGER NOT NULL DEFAULT 0,  -- seq 自增计数器（允许空洞）
  last_hot   INTEGER,                     -- 上次热门抓取时间（epoch 秒；心跳调度据此判定本次跑不跑）
  last_deep  INTEGER                      -- 上次深翻抓取时间（epoch 秒）
);

-- 配置覆盖层：控制台编辑后写入这里，fetch/scheduled 读取时叠加，即时生效、无需重部署。
--   per-list 行（list_key=片单 key）：用 name / cover / max_items 覆盖该片单。
--   全局行  （list_key='__global__'）：用 hot_every / deep_every 控制心跳调度间隔。
CREATE TABLE IF NOT EXISTS config (
  list_key   TEXT PRIMARY KEY,            -- 片单 key，或 '__global__'
  name       TEXT,                        -- 覆盖片单标题
  cover      TEXT,                        -- 覆盖固定封面 URL
  max_items  INTEGER,                     -- 返回 Emos 的最大条数；0/NULL = 不限
  hot_every  INTEGER,                     -- 仅 __global__：热门抓取间隔（小时，默认 168）
  deep_every INTEGER,                     -- 仅 __global__：深翻抓取间隔（小时，默认 1）
  enabled    INTEGER                      -- 启用覆盖：1/0；NULL=回退 env.LISTS_ENABLED 成员判定
);

-- 用户在控制台自建的片单（内置 LISTS 之外）。key 不与内置撞；删除时连带清 items/lists/config 行。
CREATE TABLE IF NOT EXISTS custom_lists (
  list_key TEXT PRIMARY KEY,              -- URL 末段，[a-z0-9_-]
  name     TEXT NOT NULL,                 -- 片单标题
  sources  TEXT NOT NULL                  -- JSON: [{path,type,query}]，服务端按引导表单生成的单个 discover 源
);
