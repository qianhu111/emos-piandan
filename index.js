/**
 * Emos 片单 (Watchlist) Worker —— TMDB 热榜 · D1 累积 · 双 Cron 预计算
 *
 * 依据 Emos 官方文档实现的「动态片单」接口：
 *   https://wiki.emos.best/api/watch.html
 *
 * 架构（与早期「拉取时实时抓」不同，已改为预计算）：
 *   - Cron 定时抓 TMDB 写入 D1，Emos 来 GET 时只读 D1、不再实时调 TMDB。
 *   - 两个独立、并行推进的 Cron：
 *       ① 热门（每周一次）：抓各片单榜单头部 page 1..HOT_PAGES，写 tier=0。
 *       ② 游标（每小时一次）：沿热度往后深翻 page cursor..+DEEP_PAGES，写 tier=1，
 *          游标持久化到 D1，逐步铺开长尾；每个来源翻到 TMDB 第 500 页封顶。
 *   - 去重累积靠 items 主键 + INSERT...ON CONFLICT，只增不删；已存条目若再次上
 *     热门榜会把 tier 提升到 0。输出按 (tier, seq) 排序：热门恒在前，深翻挤在 sort=100。
 *
 * 路由（部署后把对应 URL 填进 Emos 即可）：
 *   现用 2 个名额：
 *     GET /watch/tv      -> 电视剧（排除动画）
 *     GET /watch/anime   -> 动漫（日漫 + 国漫，合并为一个片单）
 *   备用 / 后续加额度再配（代码已就绪，并在 LISTS_ENABLED 里启用即开始抓取）：
 *     GET /watch/movie /top /doc /concert /trending /today
 *     GET /              -> 默认片单（env.DEFAULT_LIST，默认 tv）
 *
 * 注：Emos 协议只有 movie / tv 两种类型；一个片单可由多个 TMDB 来源合并而成
 *     （如「动漫」= 日语动画 + 中文动画），靠不同 URL 区分不同片单。
 *
 * 依赖：必须绑定 D1（binding = "DB"）。未绑定时 fetch 返回 500、scheduled 跳过。
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/w780"; // 封面图用的尺寸
const CACHE_TTL = 6 * 60 * 60; // Emos 拉取响应缓存 / TMDB 上游边缘缓存，6 小时
const MAX_PAGE = 500; // TMDB discover/list 单查询的页数上限
const PAGE_SIZE = 20; // TMDB 每页固定返回 20 条

// 片单注册表：key = URL 末段路径。
// 每个片单由一个或多个 TMDB 来源(sources)合并而成；source.type 用于结果不带
// media_type 的端点(discover / popular / top_rated)，trending/all 结果自带 media_type 可省略。
const LISTS = {
  // ===== 当前 2 个名额 =====
  // ① 电视剧：排除动画分类(genre 16)
  tv: {
    name: "热门电视剧",
    sources: [
      { path: "/discover/tv", type: "tv", query: { sort_by: "popularity.desc", without_genres: "16" } },
    ],
  },
  // ② 动漫：日漫(原语言日) + 国漫(原语言中) 合并为一个片单
  //    TMDB 的 with_original_language 只能填单值，所以用两个来源合并；
  //    每个来源各自维护翻页游标，互不影响。
  anime: {
    name: "热门动漫",
    sources: [
      { path: "/discover/tv", type: "tv", query: { sort_by: "popularity.desc", with_genres: "16", with_original_language: "ja" } },
      { path: "/discover/tv", type: "tv", query: { sort_by: "popularity.desc", with_genres: "16", with_original_language: "zh" } },
    ],
  },

  // ===== 备用 / 后续加额度，把 key 加进 LISTS_ENABLED 即开始抓取 =====
  movie: { name: "热门电影", sources: [{ path: "/movie/popular", type: "movie" }] },
  top:   { name: "高分电影", sources: [{ path: "/movie/top_rated", type: "movie" }] },
  // 纪录片：电影 + 剧集的纪录片(genre 99)
  doc: {
    name: "热门纪录片",
    sources: [
      { path: "/discover/movie", type: "movie", query: { sort_by: "popularity.desc", with_genres: "99" } },
      { path: "/discover/tv",    type: "tv",    query: { sort_by: "popularity.desc", with_genres: "99" } },
    ],
  },
  // 演唱会：TMDB 无「演唱会」专类，用音乐类电影(genre 10402)近似
  concert: { name: "热门演唱会", sources: [{ path: "/discover/movie", type: "movie", query: { sort_by: "popularity.desc", with_genres: "10402" } }] },
  // 混合热门（结果自带 media_type，source 无需 type）
  trending: { name: "本周热门", sources: [{ path: "/trending/all/week" }] },
  today:    { name: "今日热门", sources: [{ path: "/trending/all/day" }] },
};

export default {
  // ========== Emos 拉取：只读 D1，组装 JSON 返回（不调 TMDB）==========
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);

    // 前端运维控制台（静态页面，无需 D1 即可打开；页面内的操作再带 token）
    if (url.pathname === "/" || url.pathname === "/console") return htmlResponse(renderConsole());

    if (!env.DB) return json({ error: "未绑定 D1 数据库（binding=DB），请按 README 配置后重试" }, 500);

    // 管理 API（需 ADMIN_TOKEN）：手动触发抓取 / 查看各片单状态 / 写配置覆盖
    if (url.pathname === "/admin/refresh") return handleAdminRefresh(url, env, request);
    if (url.pathname === "/admin/stats") return handleAdminStats(url, env, request);
    if (url.pathname === "/admin/config") return handleConfigPost(url, env, request); // POST，须在 method!=GET 检查前路由
    if (url.pathname === "/admin/list") return handleListPost(url, env, request);     // POST：添加/删除/启用片单

    if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);

    // 解析片单 key：/watch/anime -> "anime"；/watch 或未知路径 -> 默认片单
    // 注册表含内置 + 自建片单；禁用片单仍照常服务已存数据（禁用只停 cron 抓取）。
    const { pathname } = url;
    const seg = pathname.replace(/\/+$/, "").split("/").pop() || "";
    const reg = await getRegistry(env);
    const fallback = reg[env.DEFAULT_LIST] ? env.DEFAULT_LIST : "tv";
    const key = reg[seg] ? seg : fallback;
    const list = reg[key] || { name: key };

    try {
      const meta = await env.DB.prepare(
        "SELECT cover, updated_at FROM lists WHERE list_key = ?"
      ).bind(key).first();
      // 配置覆盖层：D1 config > env(NAME_/COVER) > 代码默认 / 抓取自动值
      const cfg = await env.DB.prepare(
        "SELECT name, cover, max_items FROM config WHERE list_key = ?"
      ).bind(key).first();

      const { results } = await env.DB.prepare(
        "SELECT tmdb_id, tmdb_type, title FROM items WHERE list_key = ? ORDER BY tier ASC, seq ASC"
      ).bind(key).all();

      // sort 按位置：热门(tier0)在前，越靠前越小；超过 100 统一记 100（符合 1-100 约定）
      let videos = (results || []).map((v, i) => ({
        tmdb_id: v.tmdb_id,
        tmdb_type: v.tmdb_type,
        title: v.title,
        sort: Math.min(i + 1, 100),
      }));
      // 控制台设了 max_items(>0) 则截断返回 Emos 的条数
      if (cfg?.max_items > 0) videos = videos.slice(0, cfg.max_items);

      const payload = {
        // 标题 1-50 字；优先级 config.name > NAME_<KEY> 环境变量 > 代码默认
        name: String(cfg?.name || env[`NAME_${key.toUpperCase()}`] || list.name).slice(0, 50),
        cover: cfg?.cover || env.COVER || meta?.cover || "",
        updated_at: meta?.updated_at || nowCN(),
        videos,
      };
      return json(payload, 200, { "Cache-Control": `public, max-age=${CACHE_TTL}` });
    } catch (err) {
      return json({ error: "读取片单数据失败", detail: String(err) }, 500);
    }
  },

  // ========== Cron：每小时心跳，按 D1 里存的间隔决定各片单这次跑不跑 ==========
  async scheduled(event, env, ctx) {
    if (!env.DB) return console.error("scheduled: 未绑定 D1（binding=DB），跳过");
    await ensureSchema(env);

    const token = env.TMDB_TOKEN;
    if (!token) return console.error("scheduled: 未配置 TMDB_TOKEN，跳过抓取");

    const opts = { token, lang: env.TMDB_LANG || "zh-CN", region: env.TMDB_REGION || "CN" };
    const now = Math.floor(Date.now() / 1000); // Worker 运行时可用 Date.now()
    const reg = await getRegistry(env);         // 内置 + 自建片单
    const cfgMap = await loadConfigMap(env);
    const g = globalFrom(cfgMap);               // { hot_every, deep_every }（带默认）

    // 逐个「启用」片单串行处理：把单次调用的 TMDB 子请求峰值压低，远离免费版上限。
    for (const key of enabledKeysFrom(reg, cfgMap, env)) {
      const list = reg[key];
      const m = await getListTimes(env, key); // { last_hot, last_deep }
      // 距上次抓取超过间隔才跑；跑成功才落时间戳（失败则下次心跳自动重试）。
      if (now - m.last_hot >= g.hot_every * 3600) {
        try { await refreshHot(env, key, list, opts); await setTime(env, key, "last_hot", now); }
        catch (err) { console.error(`scheduled[hot] ${key} 失败:`, err); }
      }
      if (now - m.last_deep >= g.deep_every * 3600) {
        try { await advanceDeep(env, key, list, opts); await setTime(env, key, "last_deep", now); }
        catch (err) { console.error(`scheduled[deep] ${key} 失败:`, err); }
      }
    }
  },
};

// 全局抓取间隔默认值（与改造前行为一致：深翻每次心跳跑、热门每周一次）。
const DEFAULT_HOT_EVERY = 168; // 小时
const DEFAULT_DEEP_EVERY = 1;  // 小时

/** 合并注册表：内置 LISTS（custom:false）+ D1 自建 custom_lists（custom:true）。运行时动态解析。 */
async function getRegistry(env) {
  const reg = {};
  for (const [k, v] of Object.entries(LISTS)) reg[k] = { name: v.name, sources: v.sources, custom: false };
  try {
    const rows = (await env.DB.prepare("SELECT list_key, name, sources FROM custom_lists").all()).results || [];
    for (const r of rows) {
      let sources = [];
      try { sources = JSON.parse(r.sources) || []; } catch { sources = []; }
      reg[r.list_key] = { name: r.name, sources, custom: true };
    }
  } catch { /* custom_lists 表可能尚未建（旧库首次）——忽略，仅用内置 */ }
  return reg;
}

/** 一次读全部 config 行 → Map(list_key -> row)。 */
async function loadConfigMap(env) {
  const m = new Map();
  const rows = (await env.DB.prepare(
    "SELECT list_key, name, cover, max_items, hot_every, deep_every, enabled FROM config"
  ).all()).results || [];
  for (const r of rows) m.set(r.list_key, r);
  return m;
}

/** 从 config map 取全局抓取间隔（缺省/越界回退默认）。 */
function globalFrom(cfgMap) {
  const r = cfgMap.get("__global__") || {};
  return {
    hot_every: clampInt(r.hot_every, 1, 8760, DEFAULT_HOT_EVERY),
    deep_every: clampInt(r.deep_every, 1, 720, DEFAULT_DEEP_EVERY),
  };
}

/** env.LISTS_ENABLED 解析为默认启用集合（仅作种子；D1 config.enabled 优先）。 */
function defaultEnabledSet(env) {
  return new Set(
    String(env.LISTS_ENABLED || "tv,anime").split(",").map((s) => s.trim()).filter(Boolean)
  );
}

/** 注册表中所有「启用」的 key 集合：config.enabled 显式(1/0)优先，否则回退 env 默认。 */
function enabledKeysFrom(reg, cfgMap, env) {
  const dflt = defaultEnabledSet(env);
  const out = new Set();
  for (const k of Object.keys(reg)) {
    const r = cfgMap.get(k);
    const on = r && r.enabled != null ? r.enabled === 1 : dflt.has(k);
    if (on) out.add(k);
  }
  return out;
}

/** 读某片单上次 hot/deep 抓取时间（epoch 秒），无则视为 0（首次心跳即跑）。 */
async function getListTimes(env, key) {
  const r = await env.DB.prepare(
    "SELECT last_hot, last_deep FROM lists WHERE list_key = ?"
  ).bind(key).first();
  return { last_hot: r?.last_hot || 0, last_deep: r?.last_deep || 0 };
}

/** 记录某片单某类抓取的完成时间。col 仅允许 last_hot/last_deep（防注入）。 */
async function setTime(env, key, col, ts) {
  if (col !== "last_hot" && col !== "last_deep") return;
  await env.DB.prepare(
    `INSERT INTO lists (list_key, ${col}) VALUES (?, ?)
     ON CONFLICT(list_key) DO UPDATE SET ${col} = excluded.${col}`
  ).bind(key, ts).run();
}

const hotPages = (env) => clampInt(env.HOT_PAGES, 1, 25, 5); // 每源每次抓页数（25 页=500 条，封顶防子请求过多）
const deepPages = (env) => clampInt(env.DEEP_PAGES, 1, 25, 5);

/** 校验管理鉴权：返回错误 Response 表示拒绝，null 表示通过。token 取自 ?token= 或 X-Admin-Token 头。 */
function checkAdmin(env, url, request) {
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN（secret），管理功能已禁用。执行 `npx wrangler secret put ADMIN_TOKEN`" }, 403);
  const token = url.searchParams.get("token") || (request && request.headers.get("X-Admin-Token"));
  if (token !== env.ADMIN_TOKEN) return json({ error: "无效的 token" }, 401);
  return null;
}

/** 管理端点：手动触发抓取（首次填充 / 诊断 / 控制台按钮）。需 ADMIN_TOKEN。
 *  GET /admin/refresh?mode=hot|deep[&key=tv]&token=<ADMIN_TOKEN>（key 省略=全部启用片单） */
async function handleAdminRefresh(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  if (!env.TMDB_TOKEN) return json({ error: "未配置 TMDB_TOKEN（secret），无法抓取。执行 `npx wrangler secret put TMDB_TOKEN`" }, 500);

  await ensureSchema(env);
  const mode = url.searchParams.get("mode") === "deep" ? "deep" : "hot";
  const opts = { token: env.TMDB_TOKEN, lang: env.TMDB_LANG || "zh-CN", region: env.TMDB_REGION || "CN" };
  const reg = await getRegistry(env);
  const only = url.searchParams.get("key");
  // 指定 key 即使被禁用也可手动触发；省略则触发全部「启用」片单。
  const keys = only ? (reg[only] ? [only] : []) : [...enabledKeysFrom(reg, await loadConfigMap(env), env)];

  const report = [];
  for (const key of keys) {
    try {
      report.push({ key, ...(mode === "hot" ? await refreshHot(env, key, reg[key], opts) : await advanceDeep(env, key, reg[key], opts)) });
    } catch (err) {
      report.push({ key, error: String(err) });
    }
  }
  return json({ ok: true, mode, keys, report }, 200);
}

/** 管理端点：返回所有片单的状态（条目数 / 游标 / 更新时间），供控制台展示。需 ADMIN_TOKEN。 */
async function handleAdminStats(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  await ensureSchema(env);

  const counts = (await env.DB.prepare(
    "SELECT list_key, tier, COUNT(*) AS n FROM items GROUP BY list_key, tier"
  ).all()).results || [];
  const metas = (await env.DB.prepare(
    "SELECT list_key, cover, updated_at, cursor, last_hot, last_deep FROM lists"
  ).all()).results || [];
  const reg = await getRegistry(env);
  const cfgMap = await loadConfigMap(env);
  const g = globalFrom(cfgMap);                 // 全局抓取间隔（带默认）
  const enabledSet = enabledKeysFrom(reg, cfgMap, env);

  const countOf = (k, t) => (counts.find((c) => c.list_key === k && c.tier === t) || {}).n || 0;
  const lists = Object.keys(reg).map((key) => {
    const m = metas.find((x) => x.list_key === key);
    const c = cfgMap.get(key) || {};
    let cursor = null;
    try { cursor = m && m.cursor ? JSON.parse(m.cursor).pages : null; } catch { cursor = null; }
    const hot = countOf(key, 0), deep = countOf(key, 1);
    return {
      key,
      // 有效显示名：config 覆盖 > NAME_<KEY> 环境变量 > 注册表名
      name: String(c.name || env[`NAME_${key.toUpperCase()}`] || reg[key].name),
      enabled: enabledSet.has(key),
      custom: !!reg[key].custom,
      sources: (reg[key].sources || []).length,
      hot, deep, total: hot + deep,
      cover: (m && m.cover) || "",
      updated_at: (m && m.updated_at) || null,
      cursor,
      // 配置覆盖原值，供控制台表单回填（未设为 ""/0）
      cfg: { name: c.name || "", cover: c.cover || "", max_items: c.max_items || 0 },
      last_hot: (m && m.last_hot) || 0,
      last_deep: (m && m.last_deep) || 0,
    };
  });
  return json({ ok: true, enabled: [...enabledSet], deepMaxPage: MAX_PAGE, hot_every: g.hot_every, deep_every: g.deep_every, lists }, 200);
}

/** 管理端点：写入配置覆盖（控制台编辑后即时生效，无需重部署）。需 ADMIN_TOKEN。
 *  POST /admin/config  body JSON：
 *    per-list  { key, name, cover, max_items }                → 覆盖该片单标题/封面/最大返回条数
 *    全局间隔  { key:"__global__", hot_every, deep_every }     → 心跳调度间隔（小时） */
async function handleConfigPost(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  if (request.method !== "POST") return json({ error: "Method Not Allowed（请用 POST）" }, 405);
  await ensureSchema(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: "请求体不是合法 JSON" }, 400); }
  const key = String(body?.key || "").trim();

  // —— 全局间隔行（hot_every/deep_every，越界回退默认）——
  if (key === "__global__") {
    const hot_every = clampInt(body.hot_every, 1, 8760, DEFAULT_HOT_EVERY);
    const deep_every = clampInt(body.deep_every, 1, 720, DEFAULT_DEEP_EVERY);
    await env.DB.prepare(
      `INSERT INTO config (list_key, hot_every, deep_every) VALUES ('__global__', ?, ?)
       ON CONFLICT(list_key) DO UPDATE SET hot_every = excluded.hot_every, deep_every = excluded.deep_every`
    ).bind(hot_every, deep_every).run();
    return json({ ok: true, key, hot_every, deep_every }, 200);
  }

  // —— per-list 行（name/cover/max_items；内置 + 自建片单均可覆盖）——
  const reg = await getRegistry(env);
  if (!reg[key]) return json({ error: `未知片单 key：${key}` }, 400);
  const name = String(body.name ?? "").trim().slice(0, 80) || null;       // 空 = 清除覆盖
  let cover = String(body.cover ?? "").trim().slice(0, 500);
  if (cover && !/^https?:\/\//i.test(cover)) return json({ error: "cover 需以 http:// 或 https:// 开头" }, 400);
  cover = cover || null;                                                   // 空 = 清除覆盖
  const max_items = clampInt(body.max_items, 0, 1000, 0);                  // 0/非法 = 不限

  await env.DB.prepare(
    `INSERT INTO config (list_key, name, cover, max_items) VALUES (?, ?, ?, ?)
     ON CONFLICT(list_key) DO UPDATE SET name = excluded.name, cover = excluded.cover, max_items = excluded.max_items`
  ).bind(key, name, cover, max_items).run();
  return json({ ok: true, key, name, cover, max_items }, 200);
}

/** 管理端点：片单生命周期。需 ADMIN_TOKEN。POST /admin/list，body JSON 按 action 区分：
 *    add    { action:"add", key, name, type, sort?, with_genres?, with_original_language? }
 *    delete { action:"delete", key }                       // 仅自建片单；内置只能禁用
 *    toggle { action:"toggle", key, enabled:true|false }   // 内置/自建均可 */
async function handleListPost(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  if (request.method !== "POST") return json({ error: "Method Not Allowed（请用 POST）" }, 405);
  await ensureSchema(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: "请求体不是合法 JSON" }, 400); }
  const action = String(body?.action || "");
  const key = String(body?.key || "").trim();

  // —— 启用/禁用（内置 & 自建均可，写 config.enabled）——
  if (action === "toggle") {
    const reg = await getRegistry(env);
    if (!reg[key]) return json({ error: `未知片单 key：${key}` }, 400);
    const enabled = body.enabled ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO config (list_key, enabled) VALUES (?, ?)
       ON CONFLICT(list_key) DO UPDATE SET enabled = excluded.enabled`
    ).bind(key, enabled).run();
    return json({ ok: true, action, key, enabled: enabled === 1 }, 200);
  }

  // —— 删除（仅自建片单；连带清数据，避免孤儿行）——
  if (action === "delete") {
    if (LISTS[key]) return json({ error: "内置片单不可删除，只能禁用" }, 400);
    const reg = await getRegistry(env);
    if (!reg[key]) return json({ error: `片单不存在：${key}` }, 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM custom_lists WHERE list_key = ?").bind(key),
      env.DB.prepare("DELETE FROM items WHERE list_key = ?").bind(key),
      env.DB.prepare("DELETE FROM lists WHERE list_key = ?").bind(key),
      env.DB.prepare("DELETE FROM config WHERE list_key = ?").bind(key),
    ]);
    return json({ ok: true, action, key }, 200);
  }

  // —— 添加（引导表单：服务端按 type 拼单个 discover 源，无客户端 path/JSON）——
  if (action === "add") {
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) return json({ error: "key 仅限小写字母/数字/下划线/连字符，1–32 位" }, 400);
    if (LISTS[key]) return json({ error: `key 与内置片单冲突：${key}` }, 400);
    const reg = await getRegistry(env);
    if (reg[key]) return json({ error: `key 已存在：${key}` }, 400);

    const name = String(body.name ?? "").trim().slice(0, 80);
    if (!name) return json({ error: "缺少片单名称" }, 400);
    const type = body.type === "movie" || body.type === "tv" ? body.type : null;
    if (!type) return json({ error: "type 必须是 movie 或 tv" }, 400);

    const query = { sort_by: resolveSort(body.sort, type) };
    if (query.sort_by === "vote_average.desc") query["vote_count.gte"] = "200"; // 否则单票满分会霸榜
    const genres = String(body.with_genres ?? "").trim();
    if (genres) {
      if (!/^[0-9]+([,|][0-9]+){0,9}$/.test(genres)) return json({ error: "genre 须为 TMDB 数字 ID，可用逗号(且)/竖线(或)分隔" }, 400);
      query.with_genres = genres;
    }
    const lang = String(body.with_original_language ?? "").trim().toLowerCase();
    if (lang) {
      if (!/^[a-z]{2}$/.test(lang)) return json({ error: "语言须为 2 位 ISO-639-1 码，如 ja / zh / en" }, 400);
      query.with_original_language = lang;
    }
    const sources = [{ path: `/discover/${type}`, type, query }];
    await env.DB.prepare("INSERT INTO custom_lists (list_key, name, sources) VALUES (?, ?, ?)")
      .bind(key, name, JSON.stringify(sources)).run();
    await env.DB.prepare(
      `INSERT INTO config (list_key, enabled) VALUES (?, 1)
       ON CONFLICT(list_key) DO UPDATE SET enabled = 1`
    ).bind(key).run(); // 新建即启用
    return json({ ok: true, action, key, name, sources }, 200);
  }

  return json({ error: "未知 action（add|delete|toggle）" }, 400);
}

/** 排序白名单；"latest" 按媒体类型映射到对应日期字段。非白名单回退 popularity.desc。 */
function resolveSort(sort, type) {
  if (sort === "latest") return type === "movie" ? "primary_release_date.desc" : "first_air_date.desc";
  const ok = ["popularity.desc", "vote_average.desc", "revenue.desc", "primary_release_date.desc", "first_air_date.desc"];
  return ok.includes(sort) ? sort : "popularity.desc";
}

function htmlResponse(body) {
  return cors(new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
}

/** 运维控制台页面（单文件 HTML，原生 JS，无构建）。操作通过 X-Admin-Token 头鉴权。 */
function renderConsole() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emos 片单控制台</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,"Segoe UI",Roboto,sans-serif;background:#0f1115;color:#e6e8ec}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 20px;background:#171a21;border-bottom:1px solid #262b36;flex-wrap:wrap}
header h1{font-size:18px;margin:0}
.auth{display:flex;gap:8px;align-items:center}
.auth input{background:#0f1115;border:1px solid #333a48;color:#e6e8ec;padding:7px 10px;border-radius:8px;width:200px}
button{background:#2b3140;color:#e6e8ec;border:1px solid #3a4252;padding:7px 12px;border-radius:8px;cursor:pointer;font-size:13px}
button:hover{background:#353d4f}
button.hot{background:#7c3aed;border-color:#7c3aed}button.hot:hover{background:#8b4ff0}
button.deep{background:#2563eb;border-color:#2563eb}button.deep:hover{background:#3b73f0}
.toolbar{display:flex;gap:8px;padding:14px 20px;flex-wrap:wrap}
.log{margin:0 20px 12px;padding:10px 12px;border-radius:8px;background:#171a21;border:1px solid #262b36;min-height:20px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;white-space:pre-wrap}
.log.ok{border-color:#2e7d52;color:#86efac}.log.err{border-color:#a23b3b;color:#fca5a5}.log.warn{border-color:#a98031;color:#fcd34d}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding:0 20px 28px}
.card{background:#171a21;border:1px solid #262b36;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card.off{opacity:.62}
.card img{width:100%;height:120px;object-fit:cover;background:#0b0d11}
.card .body{padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.title{font-weight:600;font-size:15px}
.key{color:#8a93a6;font-weight:400;font-size:12px}
.tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid #3a4252;color:#8a93a6;margin-left:4px}
.tag.on{background:#16351f;border-color:#2e7d52;color:#86efac}
.stat{font-size:13px}.stat b{font-size:17px}
.meta{color:#8a93a6;font-size:12px}
.ops{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.preview{font-size:12px}
.preview table{width:100%;border-collapse:collapse;margin-top:6px}
.preview th,.preview td{text-align:left;padding:3px 6px;border-bottom:1px solid #262b36}
.preview th{color:#8a93a6;font-weight:500}
.pvhead{color:#8a93a6;margin-top:6px}
footer{color:#6b7280;padding:8px 20px 24px;font-size:12px}
code{background:#0f1115;border:1px solid #262b36;border-radius:5px;padding:1px 5px}
.panel{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:0 20px 12px;color:#8a93a6;font-size:13px}
.panel input{background:#0f1115;border:1px solid #333a48;color:#e6e8ec;padding:6px 8px;border-radius:6px;width:78px}
.edit{display:flex;flex-direction:column;gap:6px;border-top:1px solid #262b36;padding-top:9px;margin-top:2px}
.edit label{display:flex;align-items:center;gap:6px;font-size:12px;color:#8a93a6}
.edit input{flex:1;background:#0f1115;border:1px solid #333a48;color:#e6e8ec;padding:5px 8px;border-radius:6px;min-width:0}
.edit input[type=number]{flex:none;width:96px}
button.save{background:#2e7d52;border-color:#2e7d52}button.save:hover{background:#369160}
/* ===== 第二轮：分区 / 开关 / 徽标 / 删除 / 添加卡 + 美化 ===== */
header{background:linear-gradient(135deg,#1b1f29,#13161d);position:sticky;top:0;z-index:5;box-shadow:0 1px 0 #262b36}
.sec{padding:16px 20px 2px}
.sec h2{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#7c8aa5;margin:0 0 6px;display:flex;align-items:center;gap:8px}
.sec h2::before{content:"";width:3px;height:13px;background:#7c3aed;border-radius:2px}
.card{transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease;box-shadow:0 1px 2px rgba(0,0,0,.35)}
.card:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(0,0,0,.45);border-color:#39455c}
.card .body{gap:9px}
.titlerow{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.tag.custom{background:#2a2140;border-color:#7c3aed;color:#c4b5fd}
/* 启用/禁用开关 */
.switch{position:relative;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#8a93a6;user-select:none;white-space:nowrap}
.switch input{position:absolute;opacity:0;width:0;height:0}
.switch .track{width:38px;height:20px;border-radius:999px;background:#3a4252;position:relative;transition:background .15s;flex:none}
.switch .track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#e6e8ec;transition:transform .15s}
.switch input:checked+.track{background:#2e7d52}
.switch input:checked+.track::after{transform:translateX(18px)}
button.del{background:#3a2230;border-color:#a23b3b;color:#fca5a5}button.del:hover{background:#4a2733}
/* 添加片单卡 */
.card.add{border:1px dashed #3a4252;background:#14171e}
.addform{display:flex;flex-direction:column;gap:9px}
.addform label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#8a93a6}
.addform input,.addform select{background:#0f1115;border:1px solid #333a48;color:#e6e8ec;padding:7px 9px;border-radius:6px;width:100%}
.addform .two{display:flex;gap:9px}.addform .two>label{flex:1;min-width:0}
.addform .radio{flex-direction:row;align-items:center;gap:14px}
.addform .radio span{display:inline-flex;align-items:center;gap:5px;color:#e6e8ec}
.addform .radio input{width:auto}
.addform .hint{font-size:11px;color:#6b7280;margin-top:-2px}
.addform .hint a{color:#8b9bd0;text-decoration:none}.addform .hint a:hover{text-decoration:underline}
button.add{background:#7c3aed;border-color:#7c3aed;font-weight:600}button.add:hover{background:#8b4ff0}
</style>
</head>
<body>
<header>
  <h1>🎬 Emos 片单控制台</h1>
  <div class="auth">
    <input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off">
    <button onclick="saveToken()">保存</button>
    <span id="authState"></span>
  </div>
</header>
<div class="sec"><h2>全局设置</h2></div>
<div class="toolbar">
  <button onclick="loadStats()">↻ 刷新状态</button>
  <button class="hot" onclick="run('','hot')">⚡ 全部抓热门</button>
  <button class="deep" onclick="run('','deep')">⛏ 全部深翻一次</button>
</div>
<div class="panel">
  <span>⏱ 抓取间隔：</span>
  <label>热门每 <input id="g-hot" type="number" min="1" max="8760" value="168"> 小时</label>
  <label>深翻每 <input id="g-deep" type="number" min="1" max="720" value="1"> 小时</label>
  <button class="save" onclick="saveGlobal()">保存间隔</button>
  <span>心跳每小时触发，按此间隔决定各片单这次跑不跑（即时生效，无需重部署）</span>
</div>
<div id="log" class="log">填入 ADMIN_TOKEN 并保存，即可查看状态、手动触发抓取、启用/禁用与自定义片单。</div>
<div class="sec"><h2>片单</h2></div>
<div id="cards" class="cards">
  <div class="card add" id="addCard">
    <div class="body">
      <div class="title">➕ 添加片单</div>
      <div class="meta">服务端按下表生成单个 TMDB discover 源，添加后默认启用。多源/合并片单仍需改代码。</div>
      <div class="addform">
        <div class="two">
          <label>Key（URL 末段）<input id="a-key" maxlength="32" placeholder="如 jpdrama"></label>
          <label>名称 <input id="a-name" maxlength="80" placeholder="如 日剧"></label>
        </div>
        <label>类型
          <div class="radio">
            <span><input type="radio" name="a-type" value="tv" checked> 剧集 (tv)</span>
            <span><input type="radio" name="a-type" value="movie"> 电影 (movie)</span>
          </div>
        </label>
        <div class="two">
          <label>排序
            <select id="a-sort">
              <option value="popularity.desc">热度</option>
              <option value="vote_average.desc">评分</option>
              <option value="latest">最新</option>
              <option value="revenue.desc">票房</option>
            </select>
          </label>
          <label>原始语言（可选）<input id="a-lang" maxlength="2" placeholder="如 ja"></label>
        </div>
        <label>Genre IDs（可选）<input id="a-genres" placeholder="如 18 或 18,10765"></label>
        <div class="hint">Genre：逗号=且、竖线=或；ID 见 <a href="https://www.themoviedb.org/talk/5daf6eb0ae36680011d7e6ee" target="_blank" rel="noreferrer">TMDB Genre 列表</a>（剧情 18 · 动画 16 · 纪录 99 · 喜剧 35）。语言填 2 位码（ja/zh/en/ko）。</div>
        <button class="add" onclick="addList()">添加片单</button>
      </div>
    </div>
  </div>
</div>
<footer>填入 Emos 的是 <code>/watch/tv</code>、<code>/watch/anime</code>（可点卡片「复制导入链接」）。数据由 Cron 每小时心跳维护、按上方间隔决定节奏；卡片内可自定义名称/封面/返回上限，即时生效、无需重部署。</footer>
<script>
var TK='emos_admin_token';
function token(){return localStorage.getItem(TK)||'';}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function setAuth(){var h=!!token();var el=document.getElementById('authState');el.textContent=h?'token 已保存':'未设置 token';el.className=h?'ok':'warn';}
function saveToken(){var v=document.getElementById('token').value.trim();if(v)localStorage.setItem(TK,v);setAuth();loadStats();}
function api(p){return fetch(p,{headers:{'X-Admin-Token':token()}});}
function apiPost(p,b){return fetch(p,{method:'POST',headers:{'X-Admin-Token':token(),'Content-Type':'application/json'},body:JSON.stringify(b)});}
function log(m,c){var el=document.getElementById('log');el.textContent=m;el.className='log '+(c||'');}
async function loadStats(){
  if(!token()){log('请先填写并保存 ADMIN_TOKEN','warn');return;}
  log('加载状态…');
  try{
    var r=await api('/admin/stats');var d=await r.json();
    if(!r.ok){log('错误：'+(d.error||('HTTP '+r.status)),'err');return;}
    render(d);log('状态已更新 · '+new Date().toLocaleTimeString(),'ok');
  }catch(e){log('请求失败：'+e,'err');}
}
function render(d){
  if(d.hot_every)document.getElementById('g-hot').value=d.hot_every;
  if(d.deep_every)document.getElementById('g-deep').value=d.deep_every;
  var c=document.getElementById('cards');c.querySelectorAll('.card.dyn').forEach(function(n){n.remove();});
  d.lists.forEach(function(L){
    var div=document.createElement('div');div.className='card dyn'+(L.enabled?'':' off');
    var cur=L.cursor?(' · 游标 '+L.cursor.join('/')+'/'+d.deepMaxPage+' 页'):'';
    var cover=L.cover?('<img src="'+esc(L.cover)+'" loading="lazy" alt="">'):'';
    var tag=L.enabled?'<span class="tag on">启用</span>':'<span class="tag">未启用</span>';
    var cfg=L.cfg||{name:'',cover:'',max_items:0};
    var lim=cfg.max_items>0?(' · 上限 '+cfg.max_items):'';
    var badge=L.custom?' <span class="tag custom">自定义</span>':'';
    div.innerHTML=cover+'<div class="body">'+
      '<div class="titlerow">'+
        '<div class="title">'+esc(L.name)+' <span class="key">/'+L.key+'</span>'+badge+' '+tag+'</div>'+
        '<label class="switch" title="启用/禁用 cron 抓取"><input type="checkbox" data-act="toggle" data-key="'+L.key+'"'+(L.enabled?' checked':'')+'><span class="track"></span></label>'+
      '</div>'+
      '<div class="stat"><b>'+L.total+'</b> 条 ＝ 热门 '+L.hot+' ＋ 深翻 '+L.deep+lim+'</div>'+
      '<div class="meta">更新：'+(L.updated_at||'未抓取')+cur+'</div>'+
      '<div class="ops">'+
        '<button class="hot" data-act="run" data-key="'+L.key+'" data-mode="hot">抓热门</button>'+
        '<button class="deep" data-act="run" data-key="'+L.key+'" data-mode="deep">深翻一次</button>'+
        '<button data-act="preview" data-key="'+L.key+'">查看条目</button>'+
        '<button data-act="copy" data-key="'+L.key+'">📋 复制导入链接</button>'+
        (L.custom?'<button class="del" data-act="del" data-key="'+L.key+'">🗑 删除</button>':'')+
      '</div>'+
      '<div class="edit">'+
        '<label>名称 <input id="cfg-name-'+L.key+'" maxlength="80" placeholder="'+esc(L.name)+'" value="'+esc(cfg.name)+'"></label>'+
        '<label>封面 <input id="cfg-cover-'+L.key+'" maxlength="500" placeholder="留空=用榜首背景图" value="'+esc(cfg.cover)+'"></label>'+
        '<label>上限 <input id="cfg-max-'+L.key+'" type="number" min="0" max="1000" placeholder="0=不限" value="'+(cfg.max_items>0?cfg.max_items:'')+'"> 条</label>'+
        '<div class="ops"><button class="save" data-act="save" data-key="'+L.key+'">保存自定义</button></div>'+
      '</div>'+
      '<div class="preview" id="pv-'+L.key+'"></div>'+
    '</div>';
    c.appendChild(div);
  });
}
async function run(key,mode){
  if(!token()){log('请先保存 ADMIN_TOKEN','warn');return;}
  log((mode==='hot'?'抓热门':'深翻')+(key?(' · '+key):' · 全部')+' …');
  try{
    var r=await api('/admin/refresh?mode='+mode+(key?('&key='+encodeURIComponent(key)):''));var d=await r.json();
    if(!r.ok){log('错误：'+(d.error||('HTTP '+r.status)),'err');return;}
    var rep=(d.report||[]).map(function(x){return x.key+'：'+(x.error?('❌ '+x.error):('+'+x.unique+' / 抓'+x.fetched));}).join('   ');
    log('完成 · '+(rep||'无启用片单'),'ok');loadStats();
  }catch(e){log('请求失败：'+e,'err');}
}
async function preview(key){
  var box=document.getElementById('pv-'+key);
  if(box.getAttribute('data-open')==='1'){box.innerHTML='';box.setAttribute('data-open','0');return;}
  box.textContent='加载中…';box.setAttribute('data-open','1');
  try{
    var r=await fetch('/watch/'+encodeURIComponent(key));var d=await r.json();
    var vs=d.videos||[];
    var rows=vs.slice(0,50).map(function(v){return '<tr><td>'+v.sort+'</td><td>'+v.tmdb_type+'</td><td>'+v.tmdb_id+'</td><td>'+esc(v.title)+'</td></tr>';}).join('');
    box.innerHTML='<div class="pvhead">共 '+vs.length+' 条，预览前 '+Math.min(50,vs.length)+'：</div>'+
      '<table><thead><tr><th>sort</th><th>类型</th><th>TMDB</th><th>标题</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){box.textContent='加载失败：'+e;}
}
function saveGlobal(){
  if(!token()){log('请先保存 ADMIN_TOKEN','warn');return;}
  var hot=parseInt(document.getElementById('g-hot').value,10);
  var deep=parseInt(document.getElementById('g-deep').value,10);
  apiPost('/admin/config',{key:'__global__',hot_every:hot,deep_every:deep}).then(function(r){return r.json().then(function(d){
    if(!r.ok){log('保存间隔失败：'+(d.error||('HTTP '+r.status)),'err');return;}
    log('间隔已保存：热门每 '+d.hot_every+' 小时、深翻每 '+d.deep_every+' 小时（即时生效）','ok');loadStats();
  });}).catch(function(e){log('请求失败：'+e,'err');});
}
function saveConfig(key){
  if(!token()){log('请先保存 ADMIN_TOKEN','warn');return;}
  var name=document.getElementById('cfg-name-'+key).value.trim();
  var cover=document.getElementById('cfg-cover-'+key).value.trim();
  var max=parseInt(document.getElementById('cfg-max-'+key).value,10);
  apiPost('/admin/config',{key:key,name:name,cover:cover,max_items:isNaN(max)?0:max}).then(function(r){return r.json().then(function(d){
    if(!r.ok){log(key+' 保存失败：'+(d.error||('HTTP '+r.status)),'err');return;}
    log(key+' 自定义已保存（即时生效）：名称「'+(d.name||'默认')+'」上限 '+(d.max_items||'不限'),'ok');loadStats();
  });}).catch(function(e){log('请求失败：'+e,'err');});
}
function copyLink(key){
  var u=location.origin+'/watch/'+key;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(u).then(function(){log('已复制导入链接：'+u,'ok');},function(){log('复制失败，请手动复制：'+u,'warn');});
  }else{log('浏览器不支持自动复制，请手动复制：'+u,'warn');}
}
function addList(){
  if(!token()){log('请先保存 ADMIN_TOKEN','warn');return;}
  var key=document.getElementById('a-key').value.trim();
  var name=document.getElementById('a-name').value.trim();
  var type=(document.querySelector('input[name=a-type]:checked')||{}).value||'tv';
  var sort=document.getElementById('a-sort').value;
  var genres=document.getElementById('a-genres').value.trim();
  var lang=document.getElementById('a-lang').value.trim();
  if(!key){log('请填写 Key','warn');return;}
  if(!name){log('请填写名称','warn');return;}
  var body={action:'add',key:key,name:name,type:type,sort:sort};
  if(genres)body.with_genres=genres;
  if(lang)body.with_original_language=lang;
  apiPost('/admin/list',body).then(function(r){return r.json().then(function(d){
    if(!r.ok){log('添加失败：'+(d.error||('HTTP '+r.status)),'err');return;}
    log('已添加片单 /'+d.key+'（默认启用）· 导入链接 '+location.origin+'/watch/'+d.key,'ok');
    ['a-key','a-name','a-genres','a-lang'].forEach(function(id){document.getElementById(id).value='';});
    loadStats();
  });}).catch(function(e){log('请求失败：'+e,'err');});
}
function toggleList(key,on){
  if(!token()){log('请先保存 ADMIN_TOKEN','warn');loadStats();return;}
  apiPost('/admin/list',{action:'toggle',key:key,enabled:on}).then(function(r){return r.json().then(function(d){
    if(!r.ok){log('切换失败：'+(d.error||('HTTP '+r.status)),'err');loadStats();return;}
    log('片单 /'+key+(on?' 已启用（下次心跳起参与抓取）':' 已禁用（停止抓取；已存数据仍照常 /watch）'),'ok');loadStats();
  });}).catch(function(e){log('请求失败：'+e,'err');loadStats();});
}
function delList(key){
  if(!token()){log('请先保存 ADMIN_TOKEN','warn');return;}
  if(!confirm('删除自建片单 /'+key+' ？将连同其抓取数据一并清除，不可恢复。')){return;}
  apiPost('/admin/list',{action:'delete',key:key}).then(function(r){return r.json().then(function(d){
    if(!r.ok){log('删除失败：'+(d.error||('HTTP '+r.status)),'err');return;}
    log('已删除片单 /'+key+' 及其全部数据','ok');loadStats();
  });}).catch(function(e){log('请求失败：'+e,'err');});
}
document.getElementById('cards').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  var act=b.getAttribute('data-act'),key=b.getAttribute('data-key'),mode=b.getAttribute('data-mode');
  if(act==='run')run(key,mode);else if(act==='preview')preview(key);else if(act==='save')saveConfig(key);else if(act==='copy')copyLink(key);else if(act==='del')delList(key);
});
document.getElementById('cards').addEventListener('change',function(e){
  var t=e.target;
  if(t&&t.getAttribute&&t.getAttribute('data-act')==='toggle'&&t.type==='checkbox')toggleList(t.getAttribute('data-key'),t.checked);
});
document.getElementById('token').value=token();setAuth();if(token())loadStats();
</script>
</body>
</html>`;
}

/** 热门：每个来源抓 page 1..HOT_PAGES，写入 tier=0，并更新封面/时间。 */
async function refreshHot(env, key, list, opts) {
  const to = hotPages(env);
  const results = await fetchPages(list, opts, () => ({ from: 1, to }));
  const videos = extractVideos(results);
  await insertItems(env, key, videos, 0);
  await touchList(env, key, pickCover(results));
  return { mode: "hot", fetched: results.length, unique: videos.length };
}

/** 游标：读各来源游标，往后抓 DEEP_PAGES 页(封顶 500)，写入 tier=1，推进并保存游标。 */
async function advanceDeep(env, key, list, opts) {
  const sources = list.sources || [];
  const start = hotPages(env) + 1; // 游标起点紧接热门页之后，区间不重叠

  const row = await env.DB.prepare("SELECT cursor FROM lists WHERE list_key = ?").bind(key).first();
  const pages = parseCursorPages(row?.cursor, sources.length, start);
  const step = deepPages(env);

  // 为每个来源算本次抓取范围；已达 500 页上限的来源跳过
  let hasWork = false;
  const ranges = pages.map((p) => {
    if (p > MAX_PAGE) return null;
    hasWork = true;
    return { from: p, to: Math.min(p + step - 1, MAX_PAGE) };
  });
  if (!hasWork) return { mode: "deep", done: true, fetched: 0, unique: 0 }; // 所有来源都已翻到顶

  const results = await fetchPages(list, opts, (i) => ranges[i]); // ranges[i]=null 的源自动跳过
  const videos = extractVideos(results);
  await insertItems(env, key, videos, 1);

  const nextPages = pages.map((p, i) => (ranges[i] ? ranges[i].to + 1 : p));
  await saveCursor(env, key, nextPages, pickCover(results));
  return { mode: "deep", fetched: results.length, unique: videos.length, cursor: nextPages };
}

/** 抓取一个片单的若干来源页：rangeFor(i, src) 返回该来源要抓的 {from,to}（或 null 跳过）。 */
async function fetchPages(list, opts, rangeFor) {
  const sources = list.sources || [];
  const all = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const range = rangeFor(i, src);
    if (!range) continue;
    for (let page = range.from; page <= range.to; page++) {
      const data = await fetchTmdb(src.path, { ...opts, page, query: src.query });
      const rs = data.results || [];
      // discover / popular / top_rated 端点结果不带 media_type，按来源指定的类型补上
      if (src.type) for (const r of rs) r.media_type = src.type;
      all.push(...rs);
      if (rs.length < PAGE_SIZE) break; // 该来源没有更多了
    }
  }
  return all;
}

/** 调一次 TMDB，并借助 Cloudflare 边缘缓存上游响应。 */
async function fetchTmdb(path, { token, lang, region, page, query }) {
  const u = new URL(TMDB_BASE + path);
  u.searchParams.set("language", lang);
  u.searchParams.set("page", String(page));
  if (region) u.searchParams.set("region", region);
  // 片单自定义筛选条件（discover 用的 with_genres / with_original_language 等）
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));

  const headers = { Accept: "application/json" };
  // 兼容两种密钥：v4 Read Access Token (JWT，用 Bearer) / v3 API Key (用 query 参数)
  if (looksLikeJwt(token)) headers.Authorization = `Bearer ${token}`;
  else u.searchParams.set("api_key", token);

  const res = await fetch(u.toString(), {
    headers,
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`TMDB ${res.status} ${await safeText(res)}`);
  return res.json();
}

/** 从 TMDB 结果筛选/规范出有效条目（跨来源 + 翻页去重；不含 sort，sort 在输出时按位置赋值）。 */
function extractVideos(results) {
  const out = [];
  const seen = new Set();
  for (const r of results) {
    const type = r.media_type; // TMDB 提供，或在 fetchPages 里按 source.type 补上
    if (type !== "movie" && type !== "tv") continue; // 过滤 person 等非影视条目
    if (!r.id) continue;
    const id = `${type}:${r.id}`;
    if (seen.has(id)) continue;
    const title = r.title || r.name || r.original_title || r.original_name;
    if (!title) continue;

    seen.add(id);
    out.push({ tmdb_id: r.id, tmdb_type: type, title: String(title).slice(0, 100) });
  }
  return out;
}

// ---------- D1 读写 ----------

/** 惰性建表（兜底；正式初始化建议用 schema.sql + wrangler d1 execute）。 */
async function ensureSchema(env) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS items (
       list_key  TEXT    NOT NULL,
       tmdb_type TEXT    NOT NULL,
       tmdb_id   INTEGER NOT NULL,
       title     TEXT    NOT NULL,
       tier      INTEGER NOT NULL,
       seq       INTEGER NOT NULL,
       PRIMARY KEY (list_key, tmdb_type, tmdb_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_items_order ON items(list_key, tier, seq)`,
    `CREATE TABLE IF NOT EXISTS lists (
       list_key   TEXT PRIMARY KEY,
       cover      TEXT,
       updated_at TEXT,
       cursor     TEXT,
       next_seq   INTEGER NOT NULL DEFAULT 0,
       last_hot   INTEGER,
       last_deep  INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS config (
       list_key   TEXT PRIMARY KEY,
       name       TEXT,
       cover      TEXT,
       max_items  INTEGER,
       hot_every  INTEGER,
       deep_every INTEGER,
       enabled    INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS custom_lists (
       list_key TEXT PRIMARY KEY,
       name     TEXT NOT NULL,
       sources  TEXT NOT NULL
     )`,
  ];
  for (const sql of ddl) await env.DB.prepare(sql).run();
  // 旧库补列（已存在则忽略）：lists 的心跳时间戳、config 的启用覆盖。
  for (const c of ["last_hot INTEGER", "last_deep INTEGER"]) {
    try { await env.DB.prepare(`ALTER TABLE lists ADD COLUMN ${c}`).run(); } catch {}
  }
  try { await env.DB.prepare("ALTER TABLE config ADD COLUMN enabled INTEGER").run(); } catch {}
}

/**
 * 批量写入条目（去重累积）。新条目按全局自增 seq 入库；已存在则仅把 tier 取较小值
 * （一旦上过热门即归入 tier=0，恒排前）。整批在一个事务里完成。
 */
async function insertItems(env, key, items, tier) {
  if (!items.length) return;
  await env.DB.prepare("INSERT OR IGNORE INTO lists (list_key) VALUES (?)").bind(key).run();
  const row = await env.DB.prepare("SELECT next_seq FROM lists WHERE list_key = ?").bind(key).first();
  let seq = row?.next_seq ?? 0;

  const stmts = items.map((v) =>
    env.DB.prepare(
      `INSERT INTO items (list_key, tmdb_type, tmdb_id, title, tier, seq)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_key, tmdb_type, tmdb_id)
       DO UPDATE SET tier = MIN(tier, excluded.tier)`
    ).bind(key, v.tmdb_type, v.tmdb_id, v.title, tier, seq++)
  );
  // seq 计数器单调递增即可（允许空洞：被去重忽略的条目也消耗了序号）
  stmts.push(env.DB.prepare("UPDATE lists SET next_seq = ? WHERE list_key = ?").bind(seq, key));
  await env.DB.batch(stmts);
}

/** 热门抓取后更新片单封面/时间（新封面优先）。 */
async function touchList(env, key, cover) {
  await env.DB.prepare(
    `INSERT INTO lists (list_key, cover, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(list_key) DO UPDATE SET
       cover = COALESCE(excluded.cover, lists.cover),
       updated_at = excluded.updated_at`
  ).bind(key, cover || null, nowCN()).run();
}

/** 游标抓取后保存各来源下一页游标（封面只在原本为空时补）。 */
async function saveCursor(env, key, pages, cover) {
  await env.DB.prepare(
    `INSERT INTO lists (list_key, cover, updated_at, cursor) VALUES (?, ?, ?, ?)
     ON CONFLICT(list_key) DO UPDATE SET
       cursor = excluded.cursor,
       cover = COALESCE(lists.cover, excluded.cover),
       updated_at = excluded.updated_at`
  ).bind(key, cover || null, nowCN(), JSON.stringify({ pages })).run();
}

/** 解析游标 JSON 为长度=源数的页码数组，缺省/损坏时回退到 start。 */
function parseCursorPages(raw, n, start) {
  let pages = [];
  try {
    pages = JSON.parse(raw)?.pages || [];
  } catch {
    pages = [];
  }
  return Array.from({ length: n }, (_, i) => (Number.isInteger(pages[i]) ? pages[i] : start));
}

// ---------- 小工具 ----------

/** 用榜单靠前作品的背景图当封面，没有则回退海报。 */
function pickCover(results) {
  const head = results.find((r) => r.backdrop_path || r.poster_path);
  return head ? IMG_BASE + (head.backdrop_path || head.poster_path) : "";
}

/** 生成 "YYYY-MM-DD HH:MM:SS" 的北京时间(UTC+8)。 */
function nowCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

function looksLikeJwt(s) {
  return typeof s === "string" && s.split(".").length === 3 && s.length > 100;
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : Math.max(min, Math.min(max, n));
}
async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
function json(obj, status = 200, extra = {}) {
  return cors(
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
    })
  );
}
function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return res;
}
