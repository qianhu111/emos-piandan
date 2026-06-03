/**
 * Emos 片单 (Watchlist) Worker —— 多数据源重构版
 *
 * 依据 Emos 官方文档实现「动态片单」接口： https://wiki.emos.best/api/watch.html
 *
 * 架构（预计算）：Cron 定时抓数据源写入 D1，Emos 来 GET /watch/<key> 时只读 D1、不实时抓取。
 *
 * 功能总览：
 *   - 数据源抽象层 Provider：每个 provider 实现 fetchDiscover()，归一化输出为 TMDB 条目。
 *     内置 TMDB / 豆瓣两个 provider，PROVIDERS 注册表可代码级扩展（Bangumi/Trakt…）。
 *   - 片单全部存 D1（lists 表），代码不硬编码任何固定片单；所有片单地位平等，均可改可删。
 *   - 片单 CRUD API：创建 / 修改 / 删除 / 启用切换 / 导入导出。
 *   - 三种抓取模式：scheduled() 按 cron_mode 分派 hot/new/full，new/full 断点续传（progress 表）。
 *   - 控制台：响应式 / 暗亮主题 / toast / 动态表单 / 首次部署引导（onboarding）。
 *   - 错误日志系统（logs 表）：分级记录、控制台查看与筛选、导出与复制诊断信息。
 *
 * 关键约束：Emos 只认 tmdb_id + tmdb_type(movie/tv)，因此所有 provider 最终都归一到 TMDB id；
 *   TMDB provider 天然产出 tmdb_id；豆瓣 provider 用「标题回查 TMDB」解析（反爬时降级跳过）。
 *
 * 依赖：必须绑定 D1（binding = "DB"）。未绑定时 fetch 返回 500、scheduled 跳过。
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/w780"; // 封面图尺寸
const DOUBAN_BASE = "https://movie.douban.com";
const CACHE_TTL = 6 * 60 * 60;   // TMDB 上游 / Emos 响应缓存，6 小时
const DOUBAN_TTL = 30 * 60;      // 豆瓣上游缓存，30 分钟
const MAX_PAGE = 500;            // TMDB discover 单查询页数上限
const PAGE_SIZE = 20;            // TMDB / 豆瓣每页约 20 条
const DEFAULT_HOT_PAGES = 5;     // 基础抓取每源抓多少页
const DEFAULT_SUBREQ_BUDGET = 45; // 单次调用子请求预算（免费版上限 50，留余量）

// ---- Cron 调度（阶段 2）----
const CRON_MODES = ["hot", "new", "full"]; // 合法的 Cron 心跳模式
const DEFAULT_CRON_MODE = "hot";   // 默认心跳执行热门抓取
const DEFAULT_HOT_INTERVAL = 1;    // hot 模式：每 N 次心跳抓一次（1=每次）
const DEFAULT_FULL_FLOOR_YEAR = 0; // full 回溯截止年份；0=不限（实际下限见 HARD_FLOOR_YEAR）
const HARD_FLOOR_YEAR = 1950;      // full 模式硬下限：再老的年份数据稀少，不再回溯
const MODE_BATCH_PAGES = 50;       // new/full 每源每次心跳最多推进页数（实际仍受子请求预算限制）
const DEFAULT_FULL_MAX_CHAIN = 500; // full「一次抓完」后台自触发续抓的最大轮数上限（防失控硬保险；每轮约 45 页，500 轮 ≈ 2.2 万页 / 44 万条，覆盖现实任何片单。可用 env FULL_MAX_CHAIN 调；真正的终止靠「零进展即停」+ 数据抓完）

// ============================================================
//  数据源抽象层（Provider）
//  接口：async fetchDiscover({ params, page, mode, year, opts, log })
//          -> { items: [{ tmdb_id, tmdb_type, title, cover }], hasMore, degraded? }
//        normalizeParams(rawParams) -> { params }（已校验规范）| { error }
//        formFields：供控制台动态渲染筛选表单（阶段 3 用）。
//  opts：{ token, lang, region, budget }；log：(level, source, message) => void。
// ============================================================

/** TMDB 数据源：discover/movie|tv，支持类型/排序/genre/语言/地区筛选；hot 按热度，new/full 按发行日期+年份。 */
const tmdbProvider = {
  id: "tmdb",
  label: "TMDB",
  supportsYear: true, // 支持按年份筛选（new/full 可按年回溯）
  formFields: [
    { name: "type", label: "类型", type: "enum", options: ["tv", "movie"], required: true, default: "tv" },
    { name: "sort", label: "排序", type: "enum", options: [{ value: "popularity.desc", label: "人气最高" }, { value: "vote_average.desc", label: "评分最高" }, { value: "latest", label: "最新添加" }, { value: "revenue.desc", label: "票房最高" }], default: "popularity.desc" },
    { name: "with_genres", label: "Genre IDs（可选）", type: "text", placeholder: "如 18 或 18,10765", hint: "逗号=且 竖线=或；动画16 剧情18 纪录99 喜剧35" },
    { name: "without_genres", label: "排除 Genre IDs（可选）", type: "text", placeholder: "如 16", hint: "排除这些类型；动画16。逗号(且)/竖线(或)分隔" },
    { name: "with_original_language", label: "原始语言（可选）", type: "text", placeholder: "ja", hint: "2 位码 ja/zh/en/ko" },
    { name: "with_origin_country", label: "地区（可选）", type: "text", placeholder: "JP", hint: "2 位国家码 CN/US/JP/KR" },
  ],

  normalizeParams(p) {
    p = p || {};
    const type = p.type === "movie" || p.type === "tv" ? p.type : null;
    if (!type) return { error: "TMDB 源需指定 type=movie 或 tv" };
    const out = { type, sort: resolveSort(p.sort, type) };
    const g = String(p.with_genres ?? "").trim();
    if (g) {
      if (!/^[0-9]+([,|][0-9]+){0,9}$/.test(g)) return { error: "with_genres 须为 TMDB 数字 ID，逗号(且)/竖线(或)分隔" };
      out.with_genres = g;
    }
    const wg = String(p.without_genres ?? "").trim();
    if (wg) {
      if (!/^[0-9]+([,|][0-9]+){0,9}$/.test(wg)) return { error: "without_genres 须为 TMDB 数字 ID，逗号(且)/竖线(或)分隔" };
      out.without_genres = wg;
    }
    const lang = String(p.with_original_language ?? "").trim().toLowerCase();
    if (lang) {
      if (!/^[a-z]{2}$/.test(lang)) return { error: "with_original_language 须为 2 位 ISO-639-1 码，如 ja/zh/en" };
      out.with_original_language = lang;
    }
    const cc = String(p.with_origin_country ?? "").trim().toUpperCase();
    if (cc) {
      if (!/^[A-Z]{2}$/.test(cc)) return { error: "with_origin_country 须为 2 位国家码，如 CN/US/JP" };
      out.with_origin_country = cc;
    }
    return { params: out };
  },

  async fetchDiscover({ params, page = 1, mode = "hot", year = null, opts, log }) {
    const p = params;
    const type = p.type;
    const q = { page };
    q.include_adult = "false";

    if (mode === "hot") {
      q.sort_by = p.sort || "popularity.desc";
      // 仅 hot 加 region：按人气排序、无发行日期过滤，region 只改变上映地区口径，不会过滤掉结果。
      if (opts.region && type === "movie") q.region = opts.region;
    } else {
      // new / full：按发行日期降序，并按目标年份过滤（年份逻辑在阶段 2 调度里给出）。
      // 【不要加 region】：region 会把日期口径限定到该国发行记录，与 primary_release_date.gte/lte 叠加后，
      // 在 CN 等 TMDB 发行数据稀疏的地区会过滤掉几乎所有结果，导致「抓最新/全量」抓不到内容（电影源尤甚）。
      q.sort_by = type === "movie" ? "primary_release_date.desc" : "first_air_date.desc";
      if (year) {
        const gte = `${year}-01-01`, lte = `${year}-12-31`;
        if (type === "movie") { q["primary_release_date.gte"] = gte; q["primary_release_date.lte"] = lte; }
        else { q["first_air_date.gte"] = gte; q["first_air_date.lte"] = lte; }
      }
    }
    if (p.with_genres) q.with_genres = p.with_genres;
    if (p.without_genres) q.without_genres = p.without_genres;
    if (p.with_original_language) q.with_original_language = p.with_original_language;
    if (p.with_origin_country) q.with_origin_country = p.with_origin_country;
    if (q.sort_by === "vote_average.desc") q["vote_count.gte"] = "200"; // 否则单票满分霸榜

    const data = await tmdbGet(`/discover/${type}`, q, opts);
    const results = data.results || [];
    const items = [];
    for (const r of results) {
      if (!r.id) continue;
      const title = r.title || r.name || r.original_title || r.original_name;
      if (!title) continue;
      items.push({
        tmdb_id: r.id,
        tmdb_type: type,
        title: String(title).slice(0, 100),
        cover: r.backdrop_path || r.poster_path ? IMG_BASE + (r.backdrop_path || r.poster_path) : "",
      });
    }
    const totalPages = Math.min(data.total_pages || 0, MAX_PAGE);
    const hasMore = results.length >= PAGE_SIZE && page < MAX_PAGE && (totalPages ? page < totalPages : true);
    return { items, hasMore, totalPages };
  },
};

/** 豆瓣数据源：search_subjects 取榜单（title/cover），再按标题回查 TMDB 得到 tmdb_id；反爬/限流时降级跳过。 */
const doubanProvider = {
  id: "douban",
  label: "豆瓣",
  supportsYear: false, // 榜单不按年份筛选：new/full 下单遍翻完即 done，不按年回溯
  formFields: [
    { name: "type", label: "类型", type: "enum", options: ["movie", "tv"], required: true, default: "movie" },
    { name: "tag", label: "豆瓣标签", type: "text", placeholder: "热门", hint: "热门/最新/经典/豆瓣高分/华语/欧美/日本/韩国 等" },
    { name: "sort", label: "排序", type: "enum", options: [{ value: "recommend", label: "综合推荐" }, { value: "time", label: "最新" }, { value: "rank", label: "评分最高" }], default: "recommend" },
  ],

  normalizeParams(p) {
    p = p || {};
    const type = p.type === "tv" ? "tv" : "movie";
    const out = { type };
    const tag = String(p.tag ?? "").trim().slice(0, 20);
    if (tag) {
      if (/["'<>\\]/.test(tag)) return { error: "tag 含非法字符" };
      out.tag = tag;
    }
    const sort = String(p.sort ?? "").trim();
    if (sort) {
      if (!["recommend", "time", "rank"].includes(sort)) return { error: "sort 仅支持 recommend/time/rank" };
      out.sort = sort;
    }
    return { params: out };
  },

  async fetchDiscover({ params, page = 1, opts, log }) {
    const type = params.type === "tv" ? "tv" : "movie";
    // 豆瓣条目没有 tmdb_id，必须回查 TMDB；缺 token 直接降级（避免产出无法被 Emos 使用的条目）
    if (!opts.token) {
      log && log("warn", "douban", "未配置 TMDB_TOKEN，豆瓣源无法解析为 tmdb_id，本次降级跳过");
      return { items: [], hasMore: false, degraded: true };
    }
    let data;
    try {
      data = await doubanGet("/j/search_subjects", {
        type, tag: params.tag || "热门", sort: params.sort || "recommend",
        page_limit: 20, page_start: (page - 1) * 20,
      }, opts);
    } catch (e) {
      if (isBudgetErr(e)) throw e;
      log && log("warn", "douban", `豆瓣抓取失败（反爬/限流），本次降级跳过：${trunc(e)}`);
      return { items: [], hasMore: false, degraded: true };
    }
    const subjects = (data && data.subjects) || [];
    const items = [];
    for (const s of subjects) {
      if (!s || !s.title) continue;
      let resolved = null;
      try {
        resolved = await searchTmdb(type, s.title, doubanYear(s), opts);
      } catch (e) {
        if (isBudgetErr(e)) throw e; // 预算耗尽必须向上中止，不能当作普通解析失败吞掉
        log && log("warn", "douban", `TMDB 解析失败：${s.title} ${trunc(e)}`);
        continue;
      }
      if (!resolved) { log && log("info", "douban", `未匹配到 TMDB，跳过：${s.title}`); continue; }
      items.push({
        tmdb_id: resolved.id,
        tmdb_type: type,
        title: String(s.title).slice(0, 100),
        cover: resolved.cover || s.cover || "",
      });
    }
    return { items, hasMore: subjects.length >= 20 };
  },
};

// Provider 注册表：key = provider id。后续加 Bangumi/Trakt 只需在此注册一个实现同接口的对象。
const PROVIDERS = {
  [tmdbProvider.id]: tmdbProvider,
  [doubanProvider.id]: doubanProvider,
};

// ---------- 上游抓取助手（被各 provider 复用） ----------

/** 计入子请求预算；超额抛出可识别错误，由抓取循环捕获并优雅停止（远离免费版 50/次上限）。 */
function chargeBudget(opts) {
  if (opts && opts.budget && !opts.budget.charge()) throw new Error("SUBREQUEST_BUDGET");
}

/** 调一次 TMDB，借 Cloudflare 边缘缓存上游响应。兼容 v4 Read Token(Bearer) / v3 API Key(query)。 */
async function tmdbGet(path, query, opts) {
  chargeBudget(opts);
  const u = new URL(TMDB_BASE + path);
  u.searchParams.set("language", opts.lang || "zh-CN");
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== "") u.searchParams.set(k, String(v));
  const headers = { Accept: "application/json" };
  if (looksLikeJwt(opts.token)) headers.Authorization = `Bearer ${opts.token}`;
  else u.searchParams.set("api_key", opts.token);
  const res = await fetch(u.toString(), { headers, cf: { cacheTtl: CACHE_TTL, cacheEverything: true } });
  if (!res.ok) throw new Error(`TMDB ${res.status} ${await safeText(res)}`);
  return res.json();
}

/** 调一次豆瓣（带移动端 UA + Referer 以降低被反爬概率），失败由调用方降级处理。 */
async function doubanGet(path, query, opts) {
  chargeBudget(opts);
  const u = new URL(DOUBAN_BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== "") u.searchParams.set(k, String(v));
  const res = await fetch(u.toString(), {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      Referer: "https://movie.douban.com/explore",
    },
    cf: { cacheTtl: DOUBAN_TTL, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`豆瓣 ${res.status}`);
  return res.json();
}

/** 按标题(+年份)回查 TMDB，取最匹配的一条，返回 { id, cover }（无结果返回 null）。 */
async function searchTmdb(type, title, year, opts) {
  const q = { query: title };
  if (year) q[type === "tv" ? "first_air_date_year" : "year"] = year;
  const data = await tmdbGet(`/search/${type === "tv" ? "tv" : "movie"}`, q, opts);
  const r = (data.results || [])[0];
  if (!r || !r.id) return null;
  return { id: r.id, cover: r.backdrop_path || r.poster_path ? IMG_BASE + (r.backdrop_path || r.poster_path) : "" };
}

/** 从豆瓣条目里尽量取出年份（search_subjects 通常无 year 字段，返回 null 即纯标题搜索）。 */
function doubanYear(s) {
  const y = parseInt(s && (s.year || s.release_year), 10);
  return y >= 1900 && y <= 2100 ? y : null;
}

// ============================================================
//  Worker 入口
// ============================================================

export default {
  // ---------- Emos 拉取 / 控制台 / 管理 API ----------
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const path = url.pathname;

    // 控制台（静态页，无需 D1 即可打开；页内操作再带 token）
    if (path === "/" || path === "/console") return htmlResponse(renderConsole());

    if (!env.DB) return json({ error: "未绑定 D1 数据库（binding=DB）。请前往 Worker → Settings → Bindings 绑定 D1，Variable name 必须填 DB" }, 500);

    // 管理 API（均需 ADMIN_TOKEN）
    if (path === "/admin/providers") return handleProviders(url, env, request);
    if (path === "/admin/lists") {
      return request.method === "GET" ? handleListsGet(url, env, request) : handleListsPost(url, env, request);
    }
    if (path === "/admin/refresh") return handleRefresh(url, env, request, ctx);
    if (path === "/admin/cron") return handleCron(url, env, request);
    if (path === "/admin/logs") return handleLogs(url, env, request);
    if (path === "/admin/onboarding") return handleOnboarding(url, env, request);

    // Emos 拉取：GET /watch/<key>
    const m = path.match(/^\/watch\/([^/]+)\/?$/);
    if (m) {
      if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
      return handleWatch(decodeURIComponent(m[1]), env);
    }
    return json({ error: "未知路径" }, 404);
  },

  // ---------- Cron 心跳（阶段 2：按 cron_mode 分派 hot/new/full + 间隔门控 + 心跳计数） ----------
  // Cron 触发频率在 Cloudflare 后台配置；每次触发执行哪种模式由控制台切换（config.cron_mode）。
  async scheduled(event, env, ctx) {
    if (!env.DB) return console.error("scheduled: 未绑定 D1（binding=DB），跳过");
    await ensureSchema(env);
    const log = dbLogger();

    // 心跳计数与时间始终记录（即便因 token 缺失或间隔门控本次未实际抓取）
    const seq = (await getConfigInt(env, "heartbeat_seq", 0)) + 1;
    await setConfig(env, "heartbeat_seq", seq);
    await setConfig(env, "last_heartbeat_at", nowCN());
    await cleanupLogs(env); // 每次心跳顺手清理过期日志

    if (!env.TMDB_TOKEN) { log("warn", "cron", "未配置 TMDB_TOKEN，跳过抓取"); return flushLogs(env, log); }

    const mode = await cronMode(env); // 读 config.cron_mode，非法值回退 hot

    // hot 模式按 hot_interval 门控：每 N 次心跳才抓一次（new/full 每次心跳都推进）
    if (mode === "hot") {
      const interval = await getConfigInt(env, "hot_interval", DEFAULT_HOT_INTERVAL);
      if (interval > 1 && seq % interval !== 0) {
        log("info", "cron", `hot 间隔门控：心跳 #${seq}，每 ${interval} 次抓一次，本次跳过`);
        return flushLogs(env, log);
      }
    }

    log("info", "cron", `心跳 #${seq}：执行 ${mode} 模式`);
    const opts = makeOpts(env);
    opts.budget = makeBudget(env);
    try { await runMode(env, mode, opts, log, { source: "cron" }); }
    catch (e) { log("error", "cron", `心跳执行 ${mode} 出错：${trunc(e)}`, e && e.stack); }
    await flushLogs(env, log);
  },
};

// ============================================================
//  管理 API 处理器
// ============================================================

/** 鉴权：返回错误 Response 表示拒绝，null 表示通过。token 取自 ?token= 或 X-Admin-Token 头。 */
function checkAdmin(env, url, request) {
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN（secret），管理功能已禁用。请前往 Settings → Variables and Secrets 添加 ADMIN_TOKEN" }, 403);
  const token = url.searchParams.get("token") || (request && request.headers.get("X-Admin-Token"));
  if (token !== env.ADMIN_TOKEN) return json({ error: "无效的 token" }, 401);
  return null;
}

/** GET /admin/providers：返回数据源清单与各自的筛选字段（供控制台动态渲染表单）。 */
async function handleProviders(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  const providers = Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, fields: p.formFields || [] }));
  return json({ ok: true, providers });
}

/** GET /admin/lists：所有片单 + 条目统计（控制台主数据）。 */
async function handleListsGet(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  await ensureSchema(env);

  const rows = (await env.DB.prepare("SELECT * FROM lists ORDER BY position ASC, created_at ASC").all()).results || [];
  const counts = (await env.DB.prepare("SELECT list_key, tier, COUNT(*) AS n FROM items GROUP BY list_key, tier").all()).results || [];
  const countOf = (k, t) => (counts.find((c) => c.list_key === k && c.tier === t) || {}).n || 0;
  const lists = rows.map((L) => {
    const pub = listToPublic(L);
    pub.hot = countOf(L.list_key, 0);
    pub.deep = countOf(L.list_key, 1);
    pub.total = pub.hot + pub.deep;
    return pub;
  });
  return json({ ok: true, lists });
}

/** POST /admin/lists：片单 CRUD。body.action ∈ create | update | delete | toggle。 */
async function handleListsPost(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  if (request.method !== "POST") return json({ error: "Method Not Allowed（请用 POST）" }, 405);
  await ensureSchema(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: "请求体不是合法 JSON" }, 400); }
  const action = String(body?.action || "");

  let r;
  if (action === "create") r = await createList(env, body);
  else if (action === "update") r = await updateList(env, body);
  else if (action === "delete") r = await deleteList(env, String(body?.list_key || body?.key || "").trim());
  else if (action === "toggle") r = await toggleList(env, String(body?.list_key || body?.key || "").trim(), !!body?.enabled);
  else if (action === "import") r = await importLists(env, body);
  else return json({ error: "未知 action（create|update|delete|toggle|import）" }, 400);

  return r.err ? json({ error: r.err }, r.status || 400) : json(r.body, r.status || 200);
}

// 初始片单模板（Onboarding 一键创建用；params 均符合 tmdbProvider.normalizeParams）。
const LIST_TEMPLATES = [
  { key: "hot-movie", name: "热门电影", desc: "TMDB 热门电影，按人气降序", sources: [{ provider: "tmdb", params: { type: "movie", sort: "popularity.desc" } }] },
  { key: "hot-tv", name: "热门电视剧", desc: "TMDB 热门剧集，按人气降序，排除动画", sources: [{ provider: "tmdb", params: { type: "tv", sort: "popularity.desc", without_genres: "16" } }] },
  { key: "hot-anime", name: "热门动漫", desc: "日漫 + 国漫合并（动画 genre=16，原语言 ja / zh）", sources: [
    { provider: "tmdb", params: { type: "tv", with_genres: "16", with_original_language: "ja" } },
    { provider: "tmdb", params: { type: "tv", with_genres: "16", with_original_language: "zh" } },
  ] },
];

/** GET /admin/onboarding：返回 D1 是否为空 + 初始片单模板，供首次部署引导一键创建（复用 import 流程）。 */
async function handleOnboarding(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM lists").first();
  return json({ ok: true, empty: ((row && row.n) || 0) === 0, templates: LIST_TEMPLATES });
}

/** hot「本轮已刷新」游标：存已刷新片单 key 集合（config.hot_cursor）。hot 无年份进度，用它实现跨轮续抓 + 全部刷完自动重置（开始新一轮）。 */
async function hotDoneSet(env) {
  try { return new Set(JSON.parse((await getConfig(env, "hot_cursor", "")) || "[]")); } catch { return new Set(); }
}
async function setHotDone(env, set) { await setConfig(env, "hot_cursor", JSON.stringify([...set])); }

/** 统计某模式下「未完成」的启用片单数：hot 看 hot_cursor 游标（片单级）；new/full 看各源 progress(mode).done。用于判断该模式是否已覆盖所有启用片单、是否需要后台续抓。 */
async function modePendingCount(env, mode) {
  const lists = await getEnabledListRows(env);
  if (mode === "hot") {
    const done = await hotDoneSet(env);
    let pending = 0;
    for (const L of lists) if (!done.has(L.list_key)) pending++;
    return pending;
  }
  let pending = 0;
  for (const L of lists) {
    const sources = parseSources(L.sources);
    for (let i = 0; i < sources.length; i++) {
      const p = await getProgress(env, mode, L.list_key, i);
      if (!p || !p.done) pending++;
    }
  }
  return pending;
}

/** 「一次抓完」：用 ctx.waitUntil 后台自触发下一轮 /admin/refresh?mode=MODE（带 _chain 计数），免费版借此绕过单次子请求上限、把多片单/多年抓取分摊到多次调用。无 ctx（如本地 verify）时返回 false。 */
function chainMode(env, request, ctx, mode, nextChain) {
  if (!ctx || typeof ctx.waitUntil !== "function" || !env.ADMIN_TOKEN) return false;
  const u = new URL(request.url);
  u.searchParams.set("mode", mode);
  u.searchParams.set("_chain", String(nextChain));
  u.searchParams.delete("key");   // 续抓始终针对全部启用片单
  u.searchParams.delete("token"); // token 走请求头，不留在 URL
  ctx.waitUntil(
    fetch(u.toString(), { method: "GET", headers: { "X-Admin-Token": env.ADMIN_TOKEN } }).catch(() => {})
  );
  return true;
}

/** POST/GET /admin/refresh：手动单次触发抓取，?mode=hot|new|full（默认 hot），?key= 指定单片单（含禁用），省略=全部启用。不改变 cron_mode。 */
async function handleRefresh(url, env, request, ctx) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  if (!env.TMDB_TOKEN) return json({ error: "未配置 TMDB_TOKEN（secret），无法抓取。请前往 Settings → Variables and Secrets 加密填入 TMDB_TOKEN" }, 500);
  await ensureSchema(env);

  const mode = url.searchParams.get("mode") || "hot";
  if (!CRON_MODES.includes(mode)) return json({ error: `未知 mode：${mode}（可选 ${CRON_MODES.join(" / ")}）` }, 400);

  const opts = makeOpts(env);
  opts.budget = makeBudget(env);
  const log = dbLogger();

  const only = url.searchParams.get("key");
  const r = await runMode(env, mode, opts, log, { only, source: "admin" });

  // 三种模式「一次点击覆盖所有启用片单」：推进一批后若仍有未完成片单、且本轮确有推进，
  // 则用 ctx.waitUntil 后台自触发续抓（免费版借此绕过单次 50 子请求上限），直到全覆盖或达链上限。
  let chained = false, pending = null;
  if (!only) {
    const label = mode === "hot" ? "热门" : mode === "new" ? "最新" : "全量";
    pending = await modePendingCount(env, mode);
    const chain = clampInt(url.searchParams.get("_chain"), 0, 1e6, 0);
    const maxChain = clampInt(env.FULL_MAX_CHAIN, 1, 100000, DEFAULT_FULL_MAX_CHAIN);
    if (pending > 0 && r.advanced > 0 && chain < maxChain) {
      chained = chainMode(env, request, ctx, mode, chain + 1);
    }
    if (pending > 0 && !chained) {
      const why = chain >= maxChain ? `已达自动续抓上限，请再次点击「${label}」继续`
        : r.advanced === 0 ? "本轮无进展（上游报错或预算不足），请查看日志"
        : `后台续抓未启动（无 ctx），请再次点击「${label}」继续`;
      log("warn", "admin", `${label}未覆盖全部启用片单：剩余 ${pending} 个未完成（${why}）`);
    } else if (pending === 0 && chain > 0) {
      log("info", "admin", `${label}已覆盖全部启用片单（共 ${chain + 1} 轮后台续抓）`);
    }
  }

  await flushLogs(env, log);
  if (r.error) return json({ error: r.error }, 404);
  const resp = { ok: true, mode, manual: true, budget: { max: opts.budget.max, used: opts.budget.used }, report: r.report };
  if (!only) { resp.chained = chained; resp.pending = pending; }
  return json(resp);
}

/**
 * GET/POST /admin/cron：Cron 模式切换、状态查询与进度重置。
 *   GET  返回当前 cron_mode / hot_interval / full_floor_year + 心跳与各模式状态、new/full 进度。
 *   POST 设置上述配置（仅持久化；下次 Cron 触发即按新模式执行，切换不清空抓取进度）；
 *        或 { reset_progress: "new"|"full"|"all", list_key? } 重置抓取进度（不动已累积条目）。
 */
async function handleCron(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  await ensureSchema(env);

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "请求体不是合法 JSON" }, 400); }

    if (body.cron_mode !== undefined) {
      const mode = String(body.cron_mode || "").trim();
      if (!CRON_MODES.includes(mode)) return json({ error: `未知 cron_mode：${mode}（可选 ${CRON_MODES.join(" / ")}）` }, 400);
      await setConfig(env, "cron_mode", mode);
    }
    if (body.hot_interval !== undefined) {
      await setConfig(env, "hot_interval", clampInt(body.hot_interval, 1, 100, DEFAULT_HOT_INTERVAL));
    }
    if (body.full_floor_year !== undefined) {
      // 0=不限；非 0 时不低于硬下限，且不超过当前年份
      const y = clampInt(body.full_floor_year, 0, currentYear(), DEFAULT_FULL_FLOOR_YEAR);
      await setConfig(env, "full_floor_year", y === 0 ? 0 : Math.max(y, HARD_FLOOR_YEAR));
    }
    if (body.reset_progress !== undefined) {
      const m = String(body.reset_progress || "").trim();
      if (!["new", "full", "hot", "all"].includes(m)) return json({ error: `reset_progress 仅支持 new / full / hot / all（got ${m}）` }, 400);
      const lk = body.list_key !== undefined ? String(body.list_key || "").trim() : null;
      if (m === "hot" || m === "all") await resetHotCursor(env, lk || null); // hot 进度=「已刷新」游标(config.hot_cursor)，单独清
      if (m !== "hot") await resetProgress(env, m, lk || null);              // new/full/all 清 progress 表（hot 不涉及 progress 表）
    }
  }

  return json({ ok: true, ...(await cronStatus(env)) });
}

/** 汇总 Cron 当前配置 + 心跳时间 + new/full 进度（控制台面板与诊断信息共用）。 */
async function cronStatus(env) {
  const cm = await getConfig(env, "cron_mode", DEFAULT_CRON_MODE);
  const status = {
    cron_mode: CRON_MODES.includes(cm) ? cm : DEFAULT_CRON_MODE,
    hot_interval: await getConfigInt(env, "hot_interval", DEFAULT_HOT_INTERVAL),
    full_floor_year: await getConfigInt(env, "full_floor_year", DEFAULT_FULL_FLOOR_YEAR),
    hard_floor_year: HARD_FLOOR_YEAR,
    current_year: currentYear(),
    heartbeat_seq: await getConfigInt(env, "heartbeat_seq", 0),
    last_heartbeat_at: await getConfig(env, "last_heartbeat_at", null),
    last_hot_at: await getConfig(env, "last_hot_at", null),
    last_new_at: await getConfig(env, "last_new_at", null),
    last_full_at: await getConfig(env, "last_full_at", null),
    hot_pending: await modePendingCount(env, "hot"),
    new_pending: await modePendingCount(env, "new"),
    full_pending: await modePendingCount(env, "full"),
  };
  // new/full 抓取进度（progress 表为空时各为空数组；由阶段 2-3 / 2-4 写入）
  status.progress = { new: [], full: [] };
  const rows = (await env.DB.prepare(
    "SELECT mode, list_key, src_idx, year, page, total_pages, done, pages_done, updated_at FROM progress ORDER BY mode, list_key, src_idx"
  ).all()).results || [];
  for (const r of rows) (status.progress[r.mode] || (status.progress[r.mode] = [])).push(r);
  return status;
}

/** GET /admin/logs：查看日志。?level=info|warn|error 过滤级别、?list_key= 过滤片单、?limit= 条数（默认 200，上限 LOG_KEEP_ROWS）；最新在前。 */
async function handleLogs(url, env, request) {
  const denied = checkAdmin(env, url, request);
  if (denied) return denied;
  await ensureSchema(env);
  const where = [], binds = [];
  const level = url.searchParams.get("level");
  if (["info", "warn", "error"].includes(level)) { where.push("level = ?"); binds.push(level); }
  const lk = url.searchParams.get("list_key");
  if (lk) { where.push("list_key = ?"); binds.push(lk); }
  const limit = clampInt(url.searchParams.get("limit"), 1, LOG_KEEP_ROWS, 200);
  const sql = `SELECT id, ts, level, source, list_key, message, detail FROM logs${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  const rows = (await env.DB.prepare(sql).bind(...binds, limit).all()).results || [];
  return json({ ok: true, logs: rows });
}

/** GET /watch/<key>：只读 D1，组装 Emos JSON。 */
async function handleWatch(key, env) {
  try {
    const row = await env.DB.prepare(
      "SELECT name, cover, cover_auto, updated_at, max_items FROM lists WHERE list_key = ?"
    ).bind(key).first();
    if (!row) return json({ error: `片单不存在：${key}` }, 404);

    const { results } = await env.DB.prepare(
      "SELECT tmdb_id, tmdb_type, title FROM items WHERE list_key = ? ORDER BY tier ASC, seq ASC"
    ).bind(key).all();

    let videos = (results || []).map((v, i) => ({
      tmdb_id: v.tmdb_id, tmdb_type: v.tmdb_type, title: v.title, sort: Math.min(i + 1, 100),
    }));
    if (row.max_items > 0) videos = videos.slice(0, row.max_items);

    return json({
      name: String(row.name || key).slice(0, 50),
      cover: row.cover || row.cover_auto || "",
      updated_at: row.updated_at || nowCN(),
      videos,
    }, 200, { "Cache-Control": `public, max-age=${CACHE_TTL}` });
  } catch (e) {
    const log = dbLogger();
    log("error", "watch", `/watch/${key} 读取失败：${trunc(e)}`, e && e.stack, key);
    await flushLogs(env, log);
    return json({ error: "读取片单数据失败", detail: trunc(e) }, 500);
  }
}

// ============================================================
//  片单 CRUD 逻辑
// ============================================================

/** 校验并规范化 sources（[{provider, params}]）：交由各 provider 校验自身 params。 */
function normalizeSources(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "sources 需为非空数组（[{provider, params}]）" };
  if (raw.length > 5) return { error: "单个片单最多 5 个数据源" };
  const out = [];
  for (const s of raw) {
    const pid = String((s && s.provider) || "").trim();
    const provider = PROVIDERS[pid];
    if (!provider) return { error: `未知数据源：${pid || "(空)"}（可用：${Object.keys(PROVIDERS).join(" / ")}）` };
    const r = provider.normalizeParams((s && s.params) || {});
    if (r.error) return { error: `数据源 ${pid}：${r.error}` };
    out.push({ provider: pid, params: r.params });
  }
  return { sources: out };
}

/** 校验封面 URL：空 -> null（清除）；非空须 http(s) 且 <=500。 */
function normCover(c) {
  const v = String(c ?? "").trim().slice(0, 500);
  if (!v) return { value: null };
  if (!/^https?:\/\//i.test(v)) return { error: "cover 需以 http:// 或 https:// 开头" };
  return { value: v };
}

async function createList(env, body) {
  const key = String(body.list_key || body.key || "").trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(key)) return { status: 400, err: "list_key 仅限小写字母/数字/下划线/连字符，1–32 位" };
  if (await env.DB.prepare("SELECT 1 FROM lists WHERE list_key = ?").bind(key).first())
    return { status: 400, err: `片单 key 已存在：${key}` };

  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) return { status: 400, err: "缺少片单名称" };
  const ns = normalizeSources(body.sources);
  if (ns.error) return { status: 400, err: ns.error };
  const cover = normCover(body.cover);
  if (cover.error) return { status: 400, err: cover.error };

  const now = nowCN();
  await env.DB.prepare(
    `INSERT INTO lists (list_key, name, sources, cover, cover_auto, max_items, enabled, position, next_seq, updated_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?)`
  ).bind(
    key, name, JSON.stringify(ns.sources), cover.value,
    clampInt(body.max_items, 0, 1000, 0),
    body.enabled === false ? 0 : 1,
    clampInt(body.position, 0, 9999, 0),
    now
  ).run();
  return { status: 200, body: { ok: true, action: "create", list: listToPublic(await getListRow(env, key)) } };
}

/** 导入片单配置：body.lists 为导出文件中的数组，逐个 upsert（已存在则 update，否则 create），复用既有校验。 */
async function importLists(env, body) {
  const arr = Array.isArray(body.lists) ? body.lists : null;
  if (!arr) return { status: 400, err: "缺少 lists 数组（应为导出文件的 { lists: [...] } 格式）" };
  if (arr.length > 100) return { status: 400, err: "单次最多导入 100 个片单" };
  let created = 0, updated = 0; const errors = [];
  for (const it of arr) {
    const key = String(it?.list_key || it?.key || "").trim();
    const exists = key && (await env.DB.prepare("SELECT 1 FROM lists WHERE list_key = ?").bind(key).first());
    const r = exists ? await updateList(env, { ...it, list_key: key }) : await createList(env, { ...it, list_key: key });
    if (r.err) errors.push(`${key || "(无 key)"}：${r.err}`);
    else if (exists) updated++; else created++;
  }
  return { status: 200, body: { ok: true, action: "import", created, updated, errors } };
}

async function updateList(env, body) {
  const key = String(body.list_key || body.key || "").trim();
  const row = await getListRow(env, key);
  if (!row) return { status: 404, err: `片单不存在：${key}` };

  const sets = [], vals = [];
  if (body.name !== undefined) {
    const n = String(body.name || "").trim().slice(0, 80);
    if (!n) return { status: 400, err: "名称不能为空" };
    sets.push("name = ?"); vals.push(n);
  }
  if (body.sources !== undefined) {
    const ns = normalizeSources(body.sources);
    if (ns.error) return { status: 400, err: ns.error };
    sets.push("sources = ?"); vals.push(JSON.stringify(ns.sources));
  }
  if (body.cover !== undefined) {
    const c = normCover(body.cover);
    if (c.error) return { status: 400, err: c.error };
    sets.push("cover = ?"); vals.push(c.value);
  }
  if (body.max_items !== undefined) { sets.push("max_items = ?"); vals.push(clampInt(body.max_items, 0, 1000, 0)); }
  if (body.enabled !== undefined) { sets.push("enabled = ?"); vals.push(body.enabled ? 1 : 0); }
  if (body.position !== undefined) { sets.push("position = ?"); vals.push(clampInt(body.position, 0, 9999, 0)); }
  if (!sets.length) return { status: 400, err: "没有要更新的字段" };

  vals.push(key);
  await env.DB.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE list_key = ?`).bind(...vals).run();
  return { status: 200, body: { ok: true, action: "update", list: listToPublic(await getListRow(env, key)) } };
}

/** 删除片单：任何片单都可删（无内置不可删限制），连带清其 items，避免孤儿行。 */
async function deleteList(env, key) {
  const row = await getListRow(env, key);
  if (!row) return { status: 404, err: `片单不存在：${key}` };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM items WHERE list_key = ?").bind(key),
    env.DB.prepare("DELETE FROM lists WHERE list_key = ?").bind(key),
  ]);
  return { status: 200, body: { ok: true, action: "delete", key } };
}

async function toggleList(env, key, enabled) {
  const row = await getListRow(env, key);
  if (!row) return { status: 404, err: `片单不存在：${key}` };
  await env.DB.prepare("UPDATE lists SET enabled = ? WHERE list_key = ?").bind(enabled ? 1 : 0, key).run();
  return { status: 200, body: { ok: true, action: "toggle", key, enabled } };
}

// ============================================================
//  抓取逻辑（按模式分派：hot / new / full，子请求预算内）
// ============================================================

/** 读 config.cron_mode，非法值回退默认 hot。 */
async function cronMode(env) {
  const m = await getConfig(env, "cron_mode", DEFAULT_CRON_MODE);
  return CRON_MODES.includes(m) ? m : DEFAULT_CRON_MODE;
}

/** full 模式有效截止年份：full_floor_year=0 表示不限（用硬下限 HARD_FLOOR_YEAR）。 */
async function fullFloorYear(env) {
  const y = await getConfigInt(env, "full_floor_year", DEFAULT_FULL_FLOOR_YEAR);
  return y === 0 ? HARD_FLOOR_YEAR : Math.max(y, HARD_FLOOR_YEAR);
}

/**
 * 按模式对片单执行一轮抓取；scheduled() 与 /admin/refresh 共用。
 *   only 指定单个片单（含禁用），否则取所有启用片单。
 * 返回 { mode, report }；only 不存在时返回 { error }。结束时记录 last_<mode>_at。
 */
async function runMode(env, mode, opts, log, { only, source = "cron" } = {}) {
  let lists;
  if (only) {
    const row = await getListRow(env, only);
    if (!row) return { error: `片单不存在：${only}` };
    lists = [row];
  } else {
    lists = await getEnabledListRows(env);
  }

  // hot 跨轮续抓游标（仅针对「全部启用片单」）：跳过本轮已刷新的；若上一轮已覆盖全部，则清空开始新一轮。
  let hotDone = null;
  if (mode === "hot" && !only) {
    hotDone = await hotDoneSet(env);
    if (lists.length && lists.every((L) => hotDone.has(L.list_key))) hotDone = new Set();
  }

  // new/full：按「启用片单数」给每源每轮分配页数配额，让单次子请求预算公平覆盖所有片单，
  // 避免第一个片单的源就吃光预算、其余片单本轮全被跳过（表现为「只有第一个片单在抓」）。
  // 单片单时配额≈整份预算，行为与原先一致；片单越多每轮各抓越少，靠后台续抓多轮抓完。
  const budgetMax = opts.budget ? opts.budget.max : MODE_BATCH_PAGES;
  const perListCap = Math.min(MODE_BATCH_PAGES, Math.max(1, Math.floor(budgetMax / Math.max(1, lists.length))));

  const report = [];
  for (const L of lists) {
    if (hotDone && hotDone.has(L.list_key)) continue; // 本轮已刷新，跳过
    if (opts.budget && opts.budget.left() <= 0) { report.push({ key: L.list_key, skipped: "子请求预算用尽" }); continue; }
    try {
      if (mode === "new") report.push(await refreshListNew(env, L, opts, log, perListCap));
      else if (mode === "full") report.push(await refreshListFull(env, L, opts, log, perListCap));
      else {
        const rb = await refreshListBasic(env, L, opts, log); // hot（默认）
        report.push(rb);
        if (hotDone && rb.complete) hotDone.add(L.list_key); // 完整刷新才记入本轮游标，否则下轮续抓
      }
    } catch (e) {
      if (isBudgetErr(e)) { report.push({ key: L.list_key, skipped: "子请求预算用尽" }); break; }
      report.push({ key: L.list_key, error: trunc(e) });
      log("error", source, `片单 ${L.list_key}（${mode}）抓取失败：${trunc(e)}`, e && e.stack, L.list_key);
    }
  }
  if (hotDone) await setHotDone(env, hotDone);
  await setConfig(env, `last_${mode}_at`, nowCN());
  const added = report.reduce((a, x) => a + (x.unique || 0), 0);
  const advanced = report.reduce((a, x) => a + (x.advanced || 0), 0);
  log("info", source, `${mode} 抓取完成：${report.length} 个片单，新增 ${added} 条`);
  return { mode, report, advanced };
}

/** 对一个片单的所有源抓 page 1..HOT_PAGES（hot 模式），合并去重写入 tier=0，并更新封面/时间。 */
async function refreshListBasic(env, list, opts, log) {
  const sources = parseSources(list.sources);
  const collected = [];
  let cover = "";
  let degraded = false;
  let advanced = 0, complete = true;
  const pages = hotPages(env);

  try {
    for (const src of sources) {
      const provider = PROVIDERS[src.provider];
      if (!provider) { log("warn", "fetch", `片单 ${list.list_key} 含未知数据源 ${src.provider}，跳过`); continue; }
      for (let page = 1; page <= pages; page++) {
        const res = await provider.fetchDiscover({ params: src.params, page, mode: "hot", opts, log });
        advanced++;
        if (res.degraded) degraded = true;
        for (const it of res.items) { if (!cover && it.cover) cover = it.cover; collected.push(it); }
        if (!res.hasMore) break;
      }
    }
  } catch (e) {
    complete = false; // 预算中断或上游报错 → 本片单未完整刷新，hot 游标不记入，下轮续抓
    if (isBudgetErr(e)) log("warn", "fetch", `子请求预算用尽，片单 ${list.list_key} 本轮提前结束`);
    else log("error", "fetch", `片单 ${list.list_key} 抓取出错：${trunc(e)}`, e && e.stack, list.list_key);
  }

  const deduped = dedupeItems(collected);
  await insertItems(env, list.list_key, deduped, 0);
  if (deduped.length || cover) await touchList(env, list.list_key, cover);
  return {
    key: list.list_key, fetched: collected.length, unique: deduped.length, advanced, complete,
    degraded, budgetLeft: opts.budget ? opts.budget.left() : null,
  };
}

/**
 * 抓取「单个源、单个年份」从 fromPage 起的一批页（new / full 共用核心）。
 *   - year=null 表示该源不按年份筛选（如豆瓣），单遍翻完其榜单。
 *   - 达 batchCap 或子请求预算将尽即停；不抛预算错误，以 budgetHit 标记返回，
 *     由调用方保存进度并让出本次心跳（下次续抓）。
 * 返回 { items, nextPage, yearDone, totalPages, advanced, budgetHit, degraded }。
 */
async function crawlSourceYear(provider, src, mode, year, fromPage, opts, log, batchCap) {
  const items = [];
  let page = fromPage, advanced = 0, totalPages = null;
  let yearDone = false, budgetHit = false, degraded = false;

  while (advanced < batchCap) {
    if (opts.budget && opts.budget.left() <= 0) { budgetHit = true; break; }
    let res;
    try {
      res = await provider.fetchDiscover({ params: src.params, page, mode, year, opts, log });
    } catch (e) {
      if (isBudgetErr(e)) { budgetHit = true; break; } // 预算耗尽：本页不计入，下次重抓
      throw e; // 其它错误交由上层 per-source 处理
    }
    if (res.degraded) degraded = true;
    for (const it of res.items) items.push(it);
    if (res.totalPages != null) totalPages = res.totalPages;
    page++; advanced++;
    if (!res.hasMore) { yearDone = true; break; }
  }
  return { items, nextPage: page, yearDone, totalPages, advanced, budgetHit, degraded };
}

/**
 * new / full 的公共骨架：遍历片单各源、调 advance(i, src, provider) 推进单源，
 * 汇总条目去重写 tier=1、更新封面/时间，返回统计。
 *   advance 返回 { items, degraded, done, budgetHit }（done=该源是否全部抓完）。
 *   预算耗尽（budgetHit）时存好进度后停止后续源，让出本次心跳。
 */
async function runFetchMode(env, list, mode, opts, log, advance) {
  const key = list.list_key;
  const sources = parseSources(list.sources);
  const collected = [];
  let cover = "", degraded = false, done = 0, pending = 0, advanced = 0;

  for (let i = 0; i < sources.length; i++) {
    if (opts.budget && opts.budget.left() <= 0) { pending++; continue; } // 预算已尽，余下源下次心跳推进
    const src = sources[i];
    const provider = PROVIDERS[src.provider];
    if (!provider) { log("warn", "cron", `片单 ${key} 含未知数据源 ${src.provider}，跳过`); continue; }

    const r = await advance(i, src, provider);
    for (const it of r.items) { if (!cover && it.cover) cover = it.cover; collected.push(it); }
    if (r.degraded) degraded = true;
    advanced += r.advanced || 0;
    if (r.done) done++; else pending++;
    if (r.budgetHit) break; // 预算用尽：进度已存，让出本次心跳
  }

  const deduped = dedupeItems(collected);
  if (deduped.length) await insertItems(env, key, deduped, 1);
  const coverToSet = list.cover_auto ? null : (cover || null); // 不覆盖已有封面（通常来自热门）
  if (deduped.length || coverToSet) await touchList(env, key, coverToSet);

  return { key, mode, fetched: collected.length, unique: deduped.length, done, pending, advanced, degraded, budgetLeft: opts.budget ? opts.budget.left() : null };
}

/**
 * 最新发行抓取（new）：只抓「当前年份」、按发行日期降序，逐心跳推进、断点续传，翻完即 done。
 *   - 按年源（TMDB）：进度年≠当前年时自动重置（跨年自动续抓今年新片）。
 *   - 非按年源（豆瓣）：单遍翻完其榜单即 done（year 记 NULL），需手动重置才再抓。
 */
async function refreshListNew(env, list, opts, log, batchCap = MODE_BATCH_PAGES) {
  const yr = currentYear();
  const base = await runFetchMode(env, list, "new", opts, log, async (i, src, provider) => {
    const byYear = provider.supportsYear !== false;
    const targetYear = byYear ? yr : null;
    const prev = await getProgress(env, "new", list.list_key, i);
    let page = 1, pagesDone = 0;
    if (prev) {
      if (byYear && prev.year !== targetYear) { page = 1; pagesDone = 0; }                       // 跨年：重置续抓今年
      else if (prev.done) return { items: [], degraded: false, done: true, budgetHit: false, advanced: 0 };   // 已完成：跳过
      else { page = prev.page || 1; pagesDone = prev.pages_done || 0; }                           // 续抓
    }
    const r = await crawlSourceYear(provider, src, "new", targetYear, page, opts, log, batchCap);
    await saveProgress(env, "new", list.list_key, i, {
      year: targetYear, page: r.nextPage, total_pages: r.totalPages,
      done: r.yearDone ? 1 : 0, pages_done: pagesDone + r.advanced,
    });
    return { items: r.items, degraded: r.degraded, done: r.yearDone, budgetHit: r.budgetHit, advanced: r.advanced };
  });
  return { ...base, year: yr };
}

/**
 * 全量历史抓取（full）：从当前年逐年回溯（2026→2025→…），每年按发行日期降序翻完再进上一年，
 * 到截止年份（full_floor_year，下限 HARD_FLOOR_YEAR）即 done。逐心跳推进一批、断点续传。
 *   - 非按年源（豆瓣）：单遍翻完其榜单即 done（year 记 NULL），不按年回溯。
 *   条目写 tier=1。
 */
async function refreshListFull(env, list, opts, log, batchCap = MODE_BATCH_PAGES) {
  const floor = await fullFloorYear(env);
  const base = await runFetchMode(env, list, "full", opts, log, async (i, src, provider) => {
    const key = list.list_key;
    const byYear = provider.supportsYear !== false;
    const prev = await getProgress(env, "full", key, i);
    if (prev && prev.done) return { items: [], degraded: false, done: true, budgetHit: false, advanced: 0 }; // 已完成：跳过
    let pagesDone = prev ? (prev.pages_done || 0) : 0;

    // 非按年源：与 new 相同，单遍翻完即 done
    if (!byYear) {
      const page = prev ? (prev.page || 1) : 1;
      const r = await crawlSourceYear(provider, src, "full", null, page, opts, log, batchCap);
      await saveProgress(env, "full", key, i, { year: null, page: r.nextPage, total_pages: r.totalPages, done: r.yearDone ? 1 : 0, pages_done: pagesDone + r.advanced });
      return { items: r.items, degraded: r.degraded, done: r.yearDone, budgetHit: r.budgetHit, advanced: r.advanced };
    }

    // 按年源：逐年回溯，一次心跳内可跨多个年份，直至 batch 上限 / 预算将尽 / 回溯到底
    let year = prev && prev.year != null ? prev.year : currentYear();
    let page = prev ? (prev.page || 1) : 1;
    let totalPages = prev ? prev.total_pages : null;
    const items = [];
    let degraded = false, budgetHit = false, sourceDone = false, advanced = 0;

    while (advanced < batchCap) {
      if (year < floor) { sourceDone = true; break; }                          // 回溯到底
      if (opts.budget && opts.budget.left() <= 0) { budgetHit = true; break; } // 预算将尽
      const r = await crawlSourceYear(provider, src, "full", year, page, opts, log, batchCap - advanced);
      for (const it of r.items) items.push(it);
      if (r.degraded) degraded = true;
      if (r.totalPages != null) totalPages = r.totalPages;
      advanced += r.advanced; pagesDone += r.advanced;
      if (r.budgetHit) { page = r.nextPage; budgetHit = true; break; }
      if (r.yearDone) { year -= 1; page = 1; }   // 本年翻完，进上一年
      else { page = r.nextPage; break; }          // 达 batch 上限，年中暂停
    }
    await saveProgress(env, "full", key, i, { year, page, total_pages: totalPages, done: sourceDone ? 1 : 0, pages_done: pagesDone });
    return { items, degraded, done: sourceDone, budgetHit, advanced };
  });
  return { ...base, floor_year: floor };
}

/** 跨源 + 跨页去重（按 tmdb_type:tmdb_id），保留首次出现顺序。 */
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = `${it.tmdb_type}:${it.tmdb_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

// ============================================================
//  D1 读写
// ============================================================

/** 惰性建表（与 schema.sql 结构一致；显式执行 schema.sql 更稳）。 */
async function ensureSchema(env) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS lists (
       list_key   TEXT PRIMARY KEY,
       name       TEXT    NOT NULL,
       sources    TEXT    NOT NULL,
       cover      TEXT,
       cover_auto TEXT,
       max_items  INTEGER NOT NULL DEFAULT 0,
       enabled    INTEGER NOT NULL DEFAULT 1,
       position   INTEGER NOT NULL DEFAULT 0,
       next_seq   INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT,
       created_at TEXT
     )`,
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
    `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS progress (
       mode        TEXT    NOT NULL,
       list_key    TEXT    NOT NULL,
       src_idx     INTEGER NOT NULL,
       year        INTEGER,
       page        INTEGER NOT NULL DEFAULT 1,
       total_pages INTEGER,
       done        INTEGER NOT NULL DEFAULT 0,
       pages_done  INTEGER NOT NULL DEFAULT 0,
       updated_at  TEXT,
       PRIMARY KEY (mode, list_key, src_idx)
     )`,
    `CREATE TABLE IF NOT EXISTS logs (
       id       INTEGER PRIMARY KEY AUTOINCREMENT,
       ts       TEXT    NOT NULL,
       level    TEXT    NOT NULL,
       source   TEXT,
       list_key TEXT,
       message  TEXT,
       detail   TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_logs_id ON logs(id DESC)`,
  ];
  for (const sql of ddl) await env.DB.prepare(sql).run();
}

// ---------- config 表读写（全局键值，value 一律存字符串） ----------

/** 读一个配置值（字符串）；不存在返回 dflt。 */
async function getConfig(env, key, dflt = null) {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
  return row && row.value != null ? row.value : dflt;
}

/** 读一个整数配置值；缺失或非法返回 dflt。 */
async function getConfigInt(env, key, dflt) {
  const v = await getConfig(env, key, null);
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n;
}

/** 写一个配置值（upsert，value 转字符串）。 */
async function setConfig(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value == null ? null : String(value)).run();
}

// ---------- progress 表读写（new / full 断点续传，每「模式×片单×源」一行） ----------

/** 读某源的抓取进度；无则返回 undefined。 */
async function getProgress(env, mode, key, srcIdx) {
  return env.DB.prepare(
    "SELECT year, page, total_pages, done, pages_done FROM progress WHERE mode = ? AND list_key = ? AND src_idx = ?"
  ).bind(mode, key, srcIdx).first();
}

/** 写某源的抓取进度（upsert）。 */
async function saveProgress(env, mode, key, srcIdx, p) {
  await env.DB.prepare(
    `INSERT INTO progress (mode, list_key, src_idx, year, page, total_pages, done, pages_done, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mode, list_key, src_idx) DO UPDATE SET
       year = excluded.year, page = excluded.page, total_pages = excluded.total_pages,
       done = excluded.done, pages_done = excluded.pages_done, updated_at = excluded.updated_at`
  ).bind(mode, key, srcIdx, p.year ?? null, p.page, p.total_pages ?? null, p.done ? 1 : 0, p.pages_done || 0, nowCN()).run();
}

/** 重置抓取进度：删除匹配的 progress 行，下次心跳/手动触发从头开始（不动已累积条目）。mode='all' 清 new+full。 */
async function resetProgress(env, mode, listKey) {
  const where = [], vals = [];
  if (mode && mode !== "all") { where.push("mode = ?"); vals.push(mode); }
  if (listKey) { where.push("list_key = ?"); vals.push(listKey); }
  const sql = "DELETE FROM progress" + (where.length ? " WHERE " + where.join(" AND ") : "");
  await env.DB.prepare(sql).bind(...vals).run();
}

/** 重置 hot 进度：清「本轮已刷新」游标(config.hot_cursor)。无 list_key 全清（下轮从头刷新所有片单）；指定则仅移除该片单。不动已入库条目。 */
async function resetHotCursor(env, listKey) {
  if (!listKey) { await setConfig(env, "hot_cursor", "[]"); return; }
  const set = await hotDoneSet(env);
  set.delete(listKey);
  await setHotDone(env, set);
}

/** 取单个片单原始行（sources 仍是 JSON 字符串）。 */
async function getListRow(env, key) {
  if (!key) return null;
  return env.DB.prepare("SELECT * FROM lists WHERE list_key = ?").bind(key).first();
}

/** 取所有「启用」片单原始行，按展示顺序。 */
async function getEnabledListRows(env) {
  return (await env.DB.prepare("SELECT * FROM lists WHERE enabled = 1 ORDER BY position ASC, created_at ASC").all()).results || [];
}

/** 原始行 -> 对外结构（解析 sources，布尔化 enabled）。 */
function listToPublic(L) {
  if (!L) return null;
  return {
    key: L.list_key,
    name: L.name,
    sources: parseSources(L.sources),
    cover: L.cover || "",
    cover_auto: L.cover_auto || "",
    max_items: L.max_items || 0,
    enabled: L.enabled === 1,
    position: L.position || 0,
    updated_at: L.updated_at || null,
    created_at: L.created_at || null,
  };
}

function parseSources(raw) {
  try { return JSON.parse(raw) || []; } catch { return []; }
}

/**
 * 批量写入条目（去重累积）：新条目按全局自增 seq 入库；已存在则把 tier 取较小值
 * （上过热门即归 tier=0 恒排前），并刷新标题。整批一个事务。
 */
async function insertItems(env, key, items, tier) {
  if (!items.length) return;
  const row = await env.DB.prepare("SELECT next_seq FROM lists WHERE list_key = ?").bind(key).first();
  if (!row) return; // 片单已被删除：放弃写入
  let seq = row.next_seq ?? 0;

  const stmts = items.map((v) =>
    env.DB.prepare(
      `INSERT INTO items (list_key, tmdb_type, tmdb_id, title, tier, seq)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_key, tmdb_type, tmdb_id)
       DO UPDATE SET tier = MIN(tier, excluded.tier), title = excluded.title`
    ).bind(key, v.tmdb_type, v.tmdb_id, v.title, tier, seq++)
  );
  // seq 单调递增即可（允许空洞：被去重忽略的条目也消耗序号）
  stmts.push(env.DB.prepare("UPDATE lists SET next_seq = ? WHERE list_key = ?").bind(seq, key));
  await env.DB.batch(stmts);
}

/** 抓取后更新自动封面（仅在取到新封面时覆盖）与更新时间。 */
async function touchList(env, key, cover) {
  await env.DB.prepare(
    "UPDATE lists SET cover_auto = COALESCE(?, cover_auto), updated_at = ? WHERE list_key = ?"
  ).bind(cover || null, nowCN(), key).run();
}

// ============================================================
//  运行期上下文与小工具
// ============================================================

function makeOpts(env) {
  return { token: env.TMDB_TOKEN, lang: env.TMDB_LANG || "zh-CN", region: env.TMDB_REGION || "CN", budget: null };
}

/** 子请求预算：charge() 计一次，超额返回 false（由 chargeBudget 抛错中止）。 */
function makeBudget(env) {
  const max = clampInt(env.SUBREQ_BUDGET, 1, 1000, DEFAULT_SUBREQ_BUDGET);
  let used = 0;
  return {
    max,
    get used() { return used; },
    charge() { if (used >= max) return false; used++; return true; },
    left() { return Math.max(0, max - used); },
  };
}

const hotPages = (env) => clampInt(env.HOT_PAGES, 1, 25, DEFAULT_HOT_PAGES);

// ---------- 日志：缓冲 + 批量落库（logs 表）；写日志绝不影响主流程 ----------
const LOG_KEEP_ROWS = 500; // logs 保留最近条数
const LOG_KEEP_DAYS = 7;   // logs 保留天数

/**
 * 运行期日志器：log(level, source, message, detail?, listKey?) 同步入缓冲并打到 console，
 * 运行结束由 flushLogs() 一次性批量写入 D1（避免每条 await；Worker 里 fire-and-forget 常写不进）。
 *   level=info|warn|error   source=cron|admin|fetch|douban|...
 */
function dbLogger() {
  const buffer = [];
  const log = (level, source, message, detail = null, listKey = null) => {
    buffer.push({ level, source, message, detail, list_key: listKey });
    const line = `[${level}] ${source}: ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  log.buffer = buffer;
  return log;
}

/** 把 logger 缓冲的日志批量写入 D1；失败仅告警，绝不向上抛。 */
async function flushLogs(env, log) {
  const buf = log && log.buffer;
  if (!env || !env.DB || !buf || !buf.length) return;
  const ts = nowCN();
  try {
    const stmts = buf.map((e) => env.DB.prepare(
      "INSERT INTO logs (ts, level, source, list_key, message, detail) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(ts, String(e.level || "info"), e.source || null, e.list_key || null,
      String(e.message ?? "").slice(0, 500), e.detail != null ? String(e.detail).slice(0, 2000) : null));
    await env.DB.batch(stmts);
  } catch (e) { console.error("flushLogs 失败：" + trunc(e)); }
  buf.length = 0;
}

/** 写一条日志并立即落库（供请求处理器里的零散记录使用）。 */
async function writeLog(env, level, source, message, detail = null, listKey = null) {
  const log = dbLogger();
  log(level, source, message, detail, listKey);
  await flushLogs(env, log);
}

/** 清理过期日志：仅保留最近 LOG_KEEP_ROWS 条，且删除早于 LOG_KEEP_DAYS 天的记录。每次心跳调用。 */
async function cleanupLogs(env) {
  try {
    await env.DB.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)").bind(LOG_KEEP_ROWS).run();
    const c = new Date(Date.now() + 8 * 3600 * 1000 - LOG_KEEP_DAYS * 86400 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const cut = `${c.getUTCFullYear()}-${p(c.getUTCMonth() + 1)}-${p(c.getUTCDate())} ${p(c.getUTCHours())}:${p(c.getUTCMinutes())}:${p(c.getUTCSeconds())}`;
    await env.DB.prepare("DELETE FROM logs WHERE ts < ?").bind(cut).run();
  } catch (e) { console.error("cleanupLogs 失败：" + trunc(e)); }
}

function isBudgetErr(e) { return String(e && e.message || e).includes("SUBREQUEST_BUDGET"); }
function trunc(e) { return String(e && e.message || e).slice(0, 300); }

/** 排序白名单；"latest" 按媒体类型映射到日期字段。非白名单回退 popularity.desc。 */
function resolveSort(sort, type) {
  if (sort === "latest") return type === "movie" ? "primary_release_date.desc" : "first_air_date.desc";
  const ok = ["popularity.desc", "vote_average.desc", "revenue.desc", "primary_release_date.desc", "first_air_date.desc"];
  return ok.includes(sort) ? sort : "popularity.desc";
}

/** 生成 "YYYY-MM-DD HH:MM:SS" 的北京时间(UTC+8)。 */
function nowCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 当前北京时间的年份（数字），供 new/full 模式与配置校验使用。 */
function currentYear() {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();
}

function looksLikeJwt(s) { return typeof s === "string" && s.split(".").length === 3 && s.length > 100; }
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : Math.max(min, Math.min(max, n));
}
async function safeText(res) { try { return (await res.text()).slice(0, 200); } catch { return ""; } }

function htmlResponse(body) { return cors(new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } })); }
function json(obj, status = 200, extra = {}) {
  return cors(new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  }));
}
function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}

// ============================================================
//  控制台（阶段 3）：响应式 / 暗亮主题 / toast / 动态表单 / 移动端适配。
//  renderConsole 组装：consoleCss()（样式）+ consoleBody()（页面骨架）+ consoleJs()（浏览器脚本）。
// ============================================================
function renderConsole() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emos 片单控制台</title>
<style>${consoleCss()}</style>
</head>
<body>
${consoleBody()}
<script>
${consoleJs()}
</script>
</body>
</html>`;
}

// ============================================================
//  控制台分段构建器：consoleCss（样式）/ consoleBody（骨架）/ jsXxx（脚本），
//  由上方 renderConsole() 组装为单页；各段拼进同一个 <script>，共享作用域。
// ============================================================

/** 控制台样式：CSS 变量驱动暗/亮主题，含响应式、toast、卡片、面板、状态栏。 */
function consoleCss() {
  return `
*{box-sizing:border-box}
:root{
  --bg:#0e1014;--panel:#15171d;--panel2:#1a1d24;--elev:#1f232c;
  --bd:#23272f;--bd2:#2f343e;
  --fg:#e8eaed;--mut:#8b93a0;--mut2:#5f6672;
  --acc:#6366f1;--acc2:#818cf8;--accfg:#fff;--ring:rgba(99,102,241,.32);
  --ok:#2e9e6b;--okfg:#4ade80;--err:#e5484d;--errfg:#f87171;--warn:#c79232;--warnfg:#fbbf24;
  --tint-acc:rgba(99,102,241,.15);--tint-ok:rgba(46,158,107,.16);--tint-err:rgba(229,72,77,.15);--tint-warn:rgba(199,146,50,.16);
  --r:9px;--rs:6px;
}
[data-theme=light]{
  --bg:#fbfbfc;--panel:#ffffff;--panel2:#f5f6f8;--elev:#ffffff;
  --bd:#ebecf0;--bd2:#dcdee4;
  --fg:#16181f;--mut:#646b78;--mut2:#9aa0aa;
  --acc:#6366f1;--acc2:#4f46e5;--accfg:#fff;--ring:rgba(99,102,241,.25);
  --ok:#16895a;--okfg:#15803d;--err:#dc2626;--errfg:#dc2626;--warn:#b45309;--warnfg:#b45309;
  --tint-acc:rgba(99,102,241,.1);--tint-ok:rgba(22,137,90,.12);--tint-err:rgba(220,38,38,.1);--tint-warn:rgba(180,83,9,.12);
}
body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,Arial,sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
::selection{background:var(--tint-acc)}

header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 24px;background:var(--panel);border-bottom:1px solid var(--bd);flex-wrap:wrap;position:sticky;top:0;z-index:20}
header h1{font-size:15px;font-weight:600;margin:0;display:flex;align-items:center;gap:9px}
.auth{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

input,select{background:var(--panel2);border:1px solid var(--bd2);color:var(--fg);padding:7px 11px;border-radius:var(--rs);font-size:13px;max-width:100%;font-family:inherit;transition:border-color .12s,box-shadow .12s}
input::placeholder{color:var(--mut2)}
input:focus,select:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--ring)}

button{background:var(--panel2);color:var(--fg);border:1px solid var(--bd2);padding:7px 13px;border-radius:var(--rs);cursor:pointer;font-size:13px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;white-space:nowrap;transition:background .12s,border-color .12s,opacity .12s,transform .06s}
button:hover{background:var(--elev);border-color:var(--mut2)}
button:active{transform:translateY(1px)}
button:disabled{opacity:.5;cursor:default}
button:focus-visible{outline:none;box-shadow:0 0 0 3px var(--ring)}
button.pri{background:var(--acc);border-color:var(--acc);color:var(--accfg)}
button.pri:hover{background:var(--acc2);border-color:var(--acc2)}
button.ok{background:var(--ok);border-color:var(--ok);color:#fff}
button.ok:hover{filter:brightness(1.08)}
button.del{background:transparent;border-color:transparent;color:var(--errfg);padding-left:9px;padding-right:9px}
button.del:hover{background:var(--tint-err);border-color:transparent}
button.sm{padding:5px 10px;font-size:12px}
button.active{background:var(--acc);border-color:var(--acc);color:var(--accfg)}
.spin{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;animation:sp .6s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}

.sec{padding:20px 24px 4px;max-width:1180px;margin:0 auto}
.sec h2{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:0 0 10px}

.bar{display:flex;gap:10px;flex-wrap:wrap;padding:18px 24px;max-width:1180px;margin:0 auto}
.bar .it{display:flex;flex-direction:column;gap:3px;background:var(--panel);border:1px solid var(--bd);border-radius:var(--r);padding:12px 15px;flex:1;min-width:128px}
.bar .it b{font-size:21px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.bar .it span{font-size:11px;color:var(--mut)}

.panel{background:var(--panel);border:1px solid var(--bd);border-radius:var(--r);padding:15px 16px;margin:0 24px;max-width:1132px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px;max-width:1180px;margin:0 auto}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:var(--r);padding:15px;display:flex;flex-direction:column;gap:9px;transition:border-color .12s}
.card:hover{border-color:var(--bd2)}
.card.off{opacity:.5}
.card.add{border:1px dashed var(--bd2);background:transparent}
.title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.key{color:var(--mut);font-weight:450;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tag{font-size:10.5px;font-weight:500;padding:2px 8px;border-radius:999px;border:1px solid var(--bd2);color:var(--mut)}
.tag.on{background:var(--tint-ok);border-color:transparent;color:var(--okfg)}
.tag.src{background:var(--tint-acc);border-color:transparent;color:var(--acc2)}
.meta{color:var(--mut);font-size:12.5px;line-height:1.5}
.srcdesc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ops{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:4px}
.f{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}
.f input,.f select{width:100%}
.two{display:flex;gap:8px}.two>*{flex:1;min-width:0}
.hint{font-size:11px;color:var(--mut2);line-height:1.5}
.edit{border-top:1px solid var(--bd);padding-top:11px;margin-top:5px;display:none;flex-direction:column;gap:8px}
.edit.open{display:flex}
.note{font-size:12.5px;line-height:1.65;color:var(--mut);background:var(--panel2);border:1px solid var(--bd);border-radius:var(--rs);padding:11px 13px}
.note b{color:var(--fg);font-weight:600}

.fold{max-width:1180px;margin:14px auto 0;background:var(--panel);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;transition:border-color .12s}
.fold:hover{border-color:var(--bd2)}
.fold>summary{padding:14px 16px;cursor:pointer;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);display:flex;align-items:center;gap:10px;user-select:none;list-style:none;transition:color .12s}
.fold>summary::-webkit-details-marker{display:none}
.fold>summary::before{content:"";width:6px;height:6px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(-45deg);transition:transform .15s;opacity:.7}
.fold[open]>summary::before{transform:rotate(45deg)}
.fold>summary:hover{color:var(--fg)}
.fold[open]>summary{border-bottom:1px solid var(--bd)}
.foldbody{padding:15px 16px}
.fold .foldbody>.panel{margin:0;border:0;padding:0;background:transparent;border-radius:0;max-width:none}
.fold .foldbody>.cards{padding:0}
.fsub{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:450;color:var(--mut2);font-size:11.5px}
.sub-h{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:16px 0 9px}
.sub-h:first-child{margin-top:0}

footer{color:var(--mut2);padding:22px 24px 36px;font-size:12px;line-height:1.65;max-width:1180px;margin:0 auto}
code{background:var(--panel2);border:1px solid var(--bd);border-radius:5px;padding:1.5px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}

#toast{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:60;max-width:min(360px,92vw)}
.to{background:var(--elev);border:1px solid var(--bd2);border-left:3px solid var(--bd2);border-radius:var(--rs);padding:10px 13px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.3);animation:slide .18s ease}
.to.ok{border-left-color:var(--ok)}.to.err{border-left-color:var(--err)}.to.warn{border-left-color:var(--warn)}.to.info{border-left-color:var(--acc)}
@keyframes slide{from{opacity:0;transform:translateX(16px)}}

.logitem{border:1px solid var(--bd);border-radius:var(--rs);padding:9px 12px;margin-bottom:7px;cursor:pointer;transition:border-color .12s}
.logitem:hover{border-color:var(--bd2)}
.loghd{display:flex;gap:9px;align-items:center}
.logmsg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.logts{color:var(--mut2);font-size:11px;white-space:nowrap}
.logsub{color:var(--mut);font-size:11px;margin-top:3px}
.lvb{font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;border:1px solid var(--bd2);text-transform:uppercase;letter-spacing:.03em}
.lv-error .lvb{color:var(--errfg);border-color:transparent;background:var(--tint-err)}
.lv-warn .lvb{color:var(--warnfg);border-color:transparent;background:var(--tint-warn)}
.lv-info .lvb{color:var(--mut)}
.logdet{display:none;white-space:pre-wrap;word-break:break-all;background:var(--panel2);border:1px solid var(--bd);border-radius:var(--rs);padding:10px;margin:7px 0 0;font-size:11px;line-height:1.5;max-height:240px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.logitem.open .logdet{display:block}
.logitem.open .logmsg{white-space:normal}

/* 亮色：极淡阴影提升层次（暗色靠边框分层，不需要阴影） */
[data-theme=light] .bar .it,[data-theme=light] .card,[data-theme=light] .fold,[data-theme=light] .panel,[data-theme=light] .to{box-shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.05)}
[data-theme=light] .card:hover,[data-theme=light] .fold:hover{box-shadow:0 2px 10px rgba(16,24,40,.08)}

@media (max-width:600px){
  header{padding:11px 15px}.sec{padding:16px 15px 4px}.bar{padding:14px 15px}footer{padding:18px 15px 30px}
  .panel{margin:0 15px}.fold{margin-left:15px;margin-right:15px}.cards{grid-template-columns:1fr}.auth{width:100%}.auth input{flex:1}
  .logts{display:none}
}`;
}

/** 控制台页面骨架：JS 渲染进各容器（#statusbar/#cronPanel/#manualBar/#addCard/#cards/#settings）。 */
function consoleBody() {
  return `
<header>
  <h1>🎬 Emos 片单控制台 <span class="key">多数据源</span></h1>
  <div class="auth">
    <button id="themeBtn" class="sm" title="切换暗/亮主题">🌓 主题</button>
    <input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off" style="width:190px">
    <button id="saveTokenBtn">保存</button>
    <span id="authState" class="key"></span>
  </div>
</header>

<div id="onboard" style="display:none"></div>

<div id="statusbar" class="bar"></div>

<details class="fold">
  <summary>➕ 添加片单</summary>
  <div class="foldbody"><div id="addCard" class="cards"></div></div>
</details>

<details class="fold" open>
  <summary>🎬 片单 <span class="fsub" id="listSub"></span></summary>
  <div class="foldbody"><div id="cards" class="cards"></div></div>
</details>

<details class="fold">
  <summary>⚙️ 抓取调度 <span class="fsub" id="schedSub"></span></summary>
  <div class="foldbody">
    <div class="sub-h">手动触发 · 单次，不改变 Cron 模式</div>
    <div id="manualBar" class="panel"></div>
    <div class="sub-h">Cron 调度</div>
    <div id="cronPanel" class="panel"></div>
  </div>
</details>

<details class="fold">
  <summary>📋 运行日志 <span class="fsub" id="logSub"></span></summary>
  <div class="foldbody"><div id="logsPanel" class="panel"></div></div>
</details>

<details class="fold">
  <summary>🔧 设置与备份</summary>
  <div class="foldbody"><div id="settings" class="panel"></div></div>
</details>

<footer>填进 Emos 的是 <code>/watch/&lt;key&gt;</code>（点片单卡片「复制链接」）。Cron 触发频率在 Cloudflare 后台 Settings → Triggers → Cron Triggers 配置；每次触发执行哪种模式由「抓取调度」面板切换。</footer>

<div id="toast"></div>`;
}

/** 浏览器端核心：状态、token、主题切换、toast、按钮 loading、统一请求封装。 */
function jsCore() {
  return `
var TK='emos_admin_token',THEME='emos_theme';
var PROV=[],STATE={lists:[],cron:null};
function token(){return localStorage.getItem(TK)||'';}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

/* 主题：暗色默认，持久化到 localStorage */
function applyTheme(t){document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');}
function curTheme(){return localStorage.getItem(THEME)||'dark';}
function toggleTheme(){var t=curTheme()==='light'?'dark':'light';localStorage.setItem(THEME,t);applyTheme(t);}

/* 页内 toast（替代 alert）：type=ok|err|warn|info；err 停留更久 */
function toast(msg,type){
  var box=document.getElementById('toast');if(!box)return;
  var d=document.createElement('div');d.className='to '+(type||'info');d.textContent=msg;
  box.appendChild(d);
  setTimeout(function(){d.style.transition='opacity .3s';d.style.opacity='0';setTimeout(function(){d.remove();},300);},type==='err'?6000:3600);
}

/* 按钮 loading 态：busy(btn,true) 存原内容并转圈禁用；busy(btn,false) 还原 */
function busy(btn,on){
  if(!btn)return;
  if(on){if(btn.dataset.busy)return;btn.dataset.busy='1';btn.dataset.html=btn.innerHTML;btn.disabled=true;btn.innerHTML='<span class="spin"></span>';}
  else{if(!btn.dataset.busy)return;delete btn.dataset.busy;btn.disabled=false;if(btn.dataset.html!=null)btn.innerHTML=btn.dataset.html;}
}
async function withBusy(btn,fn){busy(btn,true);try{return await fn();}finally{busy(btn,false);}}

function needToken(){if(!token()){toast('请先填写并保存 ADMIN_TOKEN','warn');return false;}return true;}

/* 统一请求：非 2xx 抛出含服务端 error 文案的 Error，由调用方 catch + toast */
async function req(path,opts){
  var r=await fetch(path,opts),d={};
  try{d=await r.json();}catch(e){}
  if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
  return d;
}
function api(p){return req(p,{headers:{'X-Admin-Token':token()}});}
function apiPost(p,b){return req(p,{method:'POST',headers:{'X-Admin-Token':token(),'Content-Type':'application/json'},body:JSON.stringify(b)});}
`;
}

/** 顶部状态栏 + 相对时间。STATE.lists / STATE.cron 由 loadAll 填充。 */
function jsStatus() {
  return `
var MODE_LABEL={hot:'热门',new:'最新发行',full:'全量历史'};
function modeLabel(m){return MODE_LABEL[m]||m||'—';}

/* 北京时间字符串("YYYY-MM-DD HH:MM:SS")→ 相对时间 */
function relTime(s){
  if(!s)return '从未';
  var t=Date.parse(String(s).replace(' ','T')+'+08:00');
  if(isNaN(t))return String(s);
  var d=Date.now()-t;if(d<0)d=0;
  var m=Math.floor(d/60000);
  if(m<1)return '刚刚';
  if(m<60)return m+' 分钟前';
  var h=Math.floor(m/60);
  if(h<24)return h+' 小时前';
  return Math.floor(h/24)+' 天前';
}

function renderStatus(){
  var lists=STATE.lists||[],cron=STATE.cron||{},total=0,enabled=0;
  for(var i=0;i<lists.length;i++){total+=(lists[i].total||0);if(lists[i].enabled)enabled++;}
  var hb=cron.last_heartbeat_at;
  var el=document.getElementById('statusbar');if(!el)return;
  el.innerHTML=
    '<div class="it"><b>'+total+'</b><span>总条目数</span></div>'+
    '<div class="it"><b>'+lists.length+'</b><span>片单 · 启用 '+enabled+'</span></div>'+
    '<div class="it"><b>'+esc(modeLabel(cron.cron_mode))+'</b><span>当前 Cron 模式</span></div>'+
    '<div class="it"><b>'+esc(relTime(hb))+'</b><span>上次心跳'+(hb?(' · '+esc(hb)):'')+'</span></div>';
}
`;
}

/** 片单管理（一）：动态源表单 + 添加片单卡片 + 创建（含 key/名称校验）。 */
function jsListsForm() {
  return `
function provById(id){for(var i=0;i<PROV.length;i++)if(PROV[i].id===id)return PROV[i];return null;}
function provOptions(cur){return PROV.map(function(p){return '<option value="'+p.id+'"'+(p.id===cur?' selected':'')+'>'+esc(p.label)+'</option>';}).join('');}

/* 按 provider.formFields 渲染输入，id=prefix+name，可用 vals 预填（编辑复用） */
function fieldsHtml(fields,prefix,vals){
  vals=vals||{};
  return (fields||[]).map(function(f){
    var v=vals[f.name],inner;
    if(f.type==='enum'){
      inner='<select id="'+prefix+f.name+'">'+f.options.map(function(o){
        var val=(o&&o.value!=null)?o.value:o,lbl=(o&&o.label!=null)?o.label:o;
        var sel=(v!=null?String(v)===String(val):val===f.default)?' selected':'';
        return '<option value="'+esc(val)+'"'+sel+'>'+esc(lbl)+'</option>';
      }).join('')+'</select>';
    }else{
      inner='<input id="'+prefix+f.name+'" value="'+esc(v!=null?v:'')+'" placeholder="'+esc(f.placeholder||'')+'">';
    }
    return '<label class="f">'+esc(f.label)+inner+(f.hint?'<span class="hint">'+esc(f.hint)+'</span>':'')+'</label>';
  }).join('');
}
function readParams(prefix,providerId){
  var p=provById(providerId),params={};
  if(p)(p.fields||[]).forEach(function(f){var el=document.getElementById(prefix+f.name);if(el&&String(el.value).trim()!=='')params[f.name]=el.value.trim();});
  return params;
}

function renderAddCard(){
  var box=document.getElementById('addCard');if(!box)return;
  box.innerHTML='<div class="card add">'+
    '<div class="title">➕ 新建片单</div>'+
    '<div class="two">'+
      '<label class="f">Key（URL 末段）<input id="a-key" maxlength="32" placeholder="如 jpdrama"><span class="hint">小写字母/数字/_/-，1–32 位</span></label>'+
      '<label class="f">名称<input id="a-name" maxlength="80" placeholder="如 日剧"></label>'+
    '</div>'+
    '<label class="f">数据源<select id="a-provider"></select></label>'+
    '<div id="a-fields"></div>'+
    '<div class="two">'+
      '<label class="f">返回上限<input id="a-max" type="number" min="0" max="1000" placeholder="0=不限"></label>'+
      '<label class="f">封面 URL（可选）<input id="a-cover" maxlength="500" placeholder="留空=用榜首背景图"></label>'+
    '</div>'+
    '<button class="pri" id="a-submit">创建片单</button>'+
  '</div>'+
  '<div class="card">'+
    '<div class="title">ℹ️ 填写说明</div>'+
    '<div class="note">'+
      '<div><b>Key</b>：片单链接末段，最终为 <code>/watch/&lt;key&gt;</code>；小写字母/数字/-/_，1–32 位。</div>'+
      '<div><b>名称</b>：控制台与片单卡片上显示的名字，可随时修改。</div>'+
      '<div><b>数据源</b>：<b>TMDB</b> 直接产出条目，可选类型/排序/genre 等筛选；<b>豆瓣</b> 抓榜单后回查 TMDB（需配 TMDB_TOKEN，遇反爬自动降级跳过）。</div>'+
      '<div><b>筛选项</b>：排序 / 类型 / 标签随数据源自动切换；TMDB 还可按 <b>Genre IDs</b>、原始语言、地区筛选。</div>'+
      '<div><b>Genre 语法</b>：逗号 <code>,</code> = 且（同时满足），竖线 <code>|</code> = 或（任一）；<code>without_genres</code> 为排除。</div>'+
      '<div><b>通用</b>（电影/剧集）：<code>16</code>动画 <code>35</code>喜剧 <code>80</code>犯罪 <code>99</code>纪录 <code>18</code>剧情 <code>10751</code>家庭 <code>9648</code>悬疑 <code>37</code>西部</div>'+
      '<div><b>仅电影</b>：<code>28</code>动作 <code>12</code>冒险 <code>14</code>奇幻 <code>36</code>历史 <code>27</code>恐怖 <code>10402</code>音乐 <code>10749</code>爱情 <code>878</code>科幻 <code>53</code>惊悚 <code>10752</code>战争 <code>10770</code>电视电影</div>'+
      '<div><b>仅剧集</b>：<code>10759</code>动作冒险 <code>10762</code>儿童 <code>10763</code>新闻 <code>10764</code>真人秀 <code>10765</code>科幻奇幻 <code>10766</code>肥皂剧 <code>10767</code>脱口秀 <code>10768</code>战争政治</div>'+
      '<div><b>返回上限</b>：该片单最多返回多少条，<code>0</code> = 不限。</div>'+
      '<div><b>封面 URL</b>：可选，留空则自动用榜首背景图。</div>'+
      '<div>创建后把 <code>/watch/&lt;key&gt;</code> 填进 Emos 即可使用。</div>'+
    '</div>'+
  '</div>';
  var sel=document.getElementById('a-provider');
  sel.innerHTML=provOptions(PROV[0]&&PROV[0].id);
  sel.addEventListener('change',renderAddFields);
  document.getElementById('a-submit').addEventListener('click',function(){addList(this);});
  renderAddFields();
}
function renderAddFields(){
  var p=provById(document.getElementById('a-provider').value);
  document.getElementById('a-fields').innerHTML=p?fieldsHtml(p.fields,'f-',{}):'';
}
async function addList(btn){
  if(!needToken())return;
  var key=document.getElementById('a-key').value.trim(),name=document.getElementById('a-name').value.trim();
  if(!/^[a-z0-9_-]{1,32}$/.test(key)){toast('Key 仅限小写字母/数字/下划线/连字符，1–32 位','warn');return;}
  if(!name){toast('请填写片单名称','warn');return;}
  var pid=document.getElementById('a-provider').value;
  var max=parseInt(document.getElementById('a-max').value,10);
  var body={action:'create',list_key:key,name:name,sources:[{provider:pid,params:readParams('f-',pid)}],max_items:isNaN(max)?0:max,cover:document.getElementById('a-cover').value.trim()};
  try{await withBusy(btn,function(){return apiPost('/admin/lists',body);});toast('已创建片单 /'+key,'ok');loadAll();}
  catch(e){toast('创建失败：'+e.message,'err');}
}
`;
}

/** 片单管理（二）：卡片渲染 + 编辑(含换源) + 启停/删除/复制(剪贴板 fallback) + 单卡抓取 + 事件委托。 */
function jsListsCards() {
  return `
function renderLists(){
  var box=document.getElementById('cards');if(!box)return;
  var lists=STATE.lists||[];
  var ls=document.getElementById('listSub');if(ls)ls.textContent=lists.length?(lists.length+' 个'):'';
  if(!token()){box.innerHTML='<div class="meta">填入并保存 ADMIN_TOKEN 后即可管理片单。</div>';return;}
  if(!lists.length){box.innerHTML='<div class="meta">还没有片单，展开上方「➕ 添加片单」创建第一个。</div>';return;}
  box.innerHTML=lists.map(cardHtml).join('');
}
function cardHtml(L){
  var k=L.key;
  var srcTags=(L.sources||[]).map(function(s){return '<span class="tag src">'+esc(s.provider)+'</span>';}).join('');
  var tag=L.enabled?'<span class="tag on">启用</span>':'<span class="tag">停用</span>';
  var srcDesc=(L.sources||[]).map(function(s){var ps=Object.keys(s.params||{}).map(function(x){return x+'='+s.params[x];}).join(', ');return esc(s.provider)+(ps?(' · '+esc(ps)):'');}).join('　/　');
  var s0=(L.sources||[])[0]||{provider:(PROV[0]&&PROV[0].id),params:{}},p0=provById(s0.provider),multi=(L.sources||[]).length>1;
  return '<div class="card'+(L.enabled?'':' off')+'">'+
    '<div class="title">'+esc(L.name)+' <span class="key">/'+esc(k)+'</span> '+tag+srcTags+'</div>'+
    '<div class="meta srcdesc" title="'+srcDesc+'">'+srcDesc+'</div>'+
    '<div class="meta"><b style="font-size:17px">'+(L.total||0)+'</b> 条 · 热门 '+(L.hot||0)+' ＋ 最新/全量 '+(L.deep||0)+(L.max_items>0?(' · 上限 '+L.max_items):'')+'</div>'+
    '<div class="meta">更新：'+esc(relTime(L.updated_at))+(L.updated_at?(' · '+esc(L.updated_at)):'')+'</div>'+
    '<div class="ops">'+
      '<button class="sm pri" data-act="refresh" data-key="'+k+'">⚡ 抓热门</button>'+
      '<button class="sm" data-act="toggle" data-key="'+k+'" data-on="'+(L.enabled?'0':'1')+'">'+(L.enabled?'停用':'启用')+'</button>'+
      '<button class="sm" data-act="copy" data-key="'+k+'">📋 链接</button>'+
      '<button class="sm" data-act="edit" data-key="'+k+'">✏️ 编辑</button>'+
      '<button class="sm del" data-act="del" data-key="'+k+'">🗑 删除</button>'+
    '</div>'+
    '<div class="edit" id="edit-'+k+'">'+
      '<div class="two">'+
        '<label class="f">名称<input id="e-name-'+k+'" value="'+esc(L.name)+'" maxlength="80"></label>'+
        '<label class="f">返回上限<input id="e-max-'+k+'" type="number" min="0" max="1000" value="'+(L.max_items>0?L.max_items:'')+'" placeholder="0=不限"></label>'+
      '</div>'+
      '<label class="f">封面 URL<input id="e-cover-'+k+'" value="'+esc(L.cover||'')+'" maxlength="500" placeholder="留空=用榜首背景图"></label>'+
      '<label class="f" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="e-srcon-'+k+'" style="width:auto"> 保存时更新数据源'+(multi?'（本片单含多源，勾选将替换为下方单个源）':'')+'</label>'+
      '<label class="f">数据源<select class="e-prov" id="e-prov-'+k+'" data-key="'+k+'">'+provOptions(s0.provider)+'</select></label>'+
      '<div id="e-fields-'+k+'">'+(p0?fieldsHtml(p0.fields,'ef-'+k+'-',s0.params):'')+'</div>'+
      '<button class="ok sm" data-act="save" data-key="'+k+'">保存修改</button>'+
    '</div>'+
  '</div>';
}
function renderEditFields(k){
  var sel=document.getElementById('e-prov-'+k);if(!sel)return;
  var p=provById(sel.value);
  document.getElementById('e-fields-'+k).innerHTML=p?fieldsHtml(p.fields,'ef-'+k+'-',{}):'';
}
function toggleEditCard(k){var e=document.getElementById('edit-'+k);if(e)e.classList.toggle('open');}

async function saveEdit(btn,k){
  if(!needToken())return;
  var name=document.getElementById('e-name-'+k).value.trim();
  if(!name){toast('名称不能为空','warn');return;}
  var max=parseInt(document.getElementById('e-max-'+k).value,10);
  var body={action:'update',list_key:k,name:name,max_items:isNaN(max)?0:max,cover:document.getElementById('e-cover-'+k).value.trim()};
  if(document.getElementById('e-srcon-'+k).checked){var pid=document.getElementById('e-prov-'+k).value;body.sources=[{provider:pid,params:readParams('ef-'+k+'-',pid)}];}
  try{await withBusy(btn,function(){return apiPost('/admin/lists',body);});toast('/'+k+' 已保存','ok');loadAll();}
  catch(e){toast('保存失败：'+e.message,'err');}
}
async function toggleList(btn,k,on){
  try{await withBusy(btn,function(){return apiPost('/admin/lists',{action:'toggle',list_key:k,enabled:on==='1'});});toast('/'+k+(on==='1'?' 已启用':' 已停用'),'ok');loadAll();}
  catch(e){toast('切换失败：'+e.message,'err');}
}
async function delList(btn,k){
  if(!confirm('删除片单 /'+k+' ？将连同其抓取数据一并清除，不可恢复。'))return;
  try{await withBusy(btn,function(){return apiPost('/admin/lists',{action:'delete',list_key:k});});toast('已删除片单 /'+k,'ok');loadAll();}
  catch(e){toast('删除失败：'+e.message,'err');}
}
async function refreshOne(btn,k){
  if(!needToken())return;
  try{var d=await withBusy(btn,function(){return api('/admin/refresh?mode=hot&key='+encodeURIComponent(k));});
    var r=(d.report||[])[0]||{};
    toast('/'+k+' 完成：+'+(r.unique||0)+' 条（子请求 '+d.budget.used+'/'+d.budget.max+'）'+(r.degraded?' ⚠降级':''),'ok');loadAll();}
  catch(e){toast('抓取失败：'+e.message,'err');}
}
function copyLink(k){
  var u=location.origin+'/watch/'+k;
  if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){
    navigator.clipboard.writeText(u).then(function(){toast('已复制：'+u,'ok');},function(){window.prompt('复制此链接填入 Emos：',u);});
  }else{window.prompt('复制此链接填入 Emos：',u);}
}
function bindCards(){
  var box=document.getElementById('cards');if(!box)return;
  box.addEventListener('click',function(e){
    var b=e.target.closest('button');if(!b)return;
    var act=b.getAttribute('data-act'),k=b.getAttribute('data-key');
    if(act==='refresh')refreshOne(b,k);
    else if(act==='toggle')toggleList(b,k,b.getAttribute('data-on'));
    else if(act==='copy')copyLink(k);
    else if(act==='edit')toggleEditCard(k);
    else if(act==='save')saveEdit(b,k);
    else if(act==='del')delList(b,k);
  });
  box.addEventListener('change',function(e){
    var t=e.target;if(t&&t.classList&&t.classList.contains('e-prov'))renderEditFields(t.getAttribute('data-key'));
  });
}
`;
}

/** Cron 调度面板：模式切换 + 各模式状态 + 热门间隔/截止年配置 + 进度重置。 */
function jsCron() {
  return `
function progStat(rows){rows=rows||[];var done=0,run=0;for(var i=0;i<rows.length;i++){if(rows[i].done)done++;else run++;}return {done:done,run:run};}
function renderCron(){
  var box=document.getElementById('cronPanel');if(!box)return;
  var c=STATE.cron;
  if(!c){box.innerHTML='<div class="meta">填入 ADMIN_TOKEN 后显示 Cron 调度状态。</div>';return;}
  var btns=['hot','new','full'].map(function(m){return '<button class="'+(c.cron_mode===m?'active':'')+'" data-act="mode" data-mode="'+m+'">'+modeLabel(m)+'</button>';}).join('');
  var np=progStat(c.progress&&c.progress.new),fp=progStat(c.progress&&c.progress.full),frontier='';
  if(c.progress&&c.progress.full){
    var ys=c.progress.full.filter(function(r){return !r.done&&r.year!=null;}).map(function(r){return r.year;});
    if(ys.length)frontier=' · 回溯至 '+Math.min.apply(null,ys);
  }
  box.innerHTML=
    '<div class="row" style="margin-bottom:10px"><span class="meta">当前模式：</span>'+btns+'</div>'+
    '<div class="note">'+
      '<div>🔥 热门：上次执行 '+esc(relTime(c.last_hot_at))+' · 每 '+c.hot_interval+' 次心跳抓一次</div>'+
      '<div>🆕 最新（当年 '+c.current_year+'）：'+np.done+' 源完成 / '+np.run+' 进行中 · 上次 '+esc(relTime(c.last_new_at))+'</div>'+
      '<div>📚 全量：'+fp.done+' 源完成 / '+fp.run+' 进行中'+frontier+' · 截止 '+(c.full_floor_year>0?c.full_floor_year:('不限（到 '+c.hard_floor_year+'）'))+' · 上次 '+esc(relTime(c.last_full_at))+'</div>'+
    '</div>'+
    '<div class="row" style="margin-top:10px;align-items:flex-end">'+
      '<label class="f">热门间隔（每 N 次心跳）<input id="c-hotint" type="number" min="1" max="100" value="'+c.hot_interval+'" style="width:130px"></label>'+
      '<button class="sm" data-act="save-int">保存间隔</button>'+
      '<label class="f">全量截止年（0=不限）<input id="c-floor" type="number" min="0" max="'+c.current_year+'" value="'+(c.full_floor_year||0)+'" style="width:150px"></label>'+
      '<button class="sm" data-act="save-floor">保存截止年</button>'+
    '</div>'+
    '<div class="row" style="margin-top:10px">'+
      '<button class="sm" data-act="reset-hot">↺ 重置热门进度</button>'+
      '<button class="sm" data-act="reset-new">↺ 重置最新进度</button>'+
      '<button class="sm" data-act="reset-full">↺ 重置全量进度</button>'+
    '</div>'+
    '<div class="hint" style="margin-top:8px">Cron 触发频率请在 Cloudflare 后台 → Settings → Triggers → Cron Triggers 设置（如每小时 <code>0 * * * *</code>）。切换模式立即生效，下次触发即按新模式执行。</div>';
  var sub=document.getElementById('schedSub');
  if(sub){var pend=c[c.cron_mode+'_pending'];sub.textContent='当前 '+modeLabel(c.cron_mode)+(pend>0?(' · 进行中（剩 '+pend+'）'):'');}
}
async function setCronMode(btn,mode){
  try{await withBusy(btn,function(){return apiPost('/admin/cron',{cron_mode:mode});});toast('Cron 模式已切到「'+modeLabel(mode)+'」','ok');loadAll();}
  catch(e){toast('切换失败：'+e.message,'err');}
}
async function saveCron(btn,patch){
  try{await withBusy(btn,function(){return apiPost('/admin/cron',patch);});toast('已保存','ok');loadAll();}
  catch(e){toast('保存失败：'+e.message,'err');}
}
async function resetProg(btn,mode){
  if(!confirm('重置「'+modeLabel(mode)+'」抓取进度？下次将从头开始（已入库条目不变）。'))return;
  try{await withBusy(btn,function(){return apiPost('/admin/cron',{reset_progress:mode});});toast(modeLabel(mode)+' 进度已重置','ok');loadAll();}
  catch(e){toast('重置失败：'+e.message,'err');}
}
function bindCron(){
  var box=document.getElementById('cronPanel');if(!box)return;
  box.addEventListener('click',function(e){
    var b=e.target.closest('button');if(!b)return;var act=b.getAttribute('data-act');
    if(act==='mode')setCronMode(b,b.getAttribute('data-mode'));
    else if(act==='save-int')saveCron(b,{hot_interval:parseInt(document.getElementById('c-hotint').value,10)});
    else if(act==='save-floor')saveCron(b,{full_floor_year:parseInt(document.getElementById('c-floor').value,10)});
    else if(act==='reset-hot')resetProg(b,'hot');
    else if(act==='reset-new')resetProg(b,'new');
    else if(act==='reset-full')resetProg(b,'full');
  });
}
`;
}

/** 手动触发区：hot/new/full 三按钮，对所有启用片单单次抓取，不改 cron_mode。 */
function jsManual() {
  return `
function renderManual(){
  var box=document.getElementById('manualBar');if(!box)return;
  box.innerHTML='<div class="row">'+
    '<button class="pri" data-mact="hot">⚡ 抓热门</button>'+
    '<button data-mact="new">🆕 抓最新（当年）</button>'+
    '<button data-mact="full">📚 全量历史</button>'+
    '<span class="hint">三种模式均对所有启用片单执行，并在后台自动连续抓完（进度见上方「抓取调度」）。不改变当前 Cron 模式。</span>'+
  '</div>';
}
async function manualRun(btn,mode){
  if(!needToken())return;
  try{var d=await withBusy(btn,function(){return api('/admin/refresh?mode='+mode);});
    var rep=d.report||[],add=rep.reduce(function(a,x){return a+(x.unique||0);},0),label=modeLabel(mode);
    if(d.pending!==undefined){
      if(d.chained){toast(label+' 已启动：本轮 '+rep.length+' 片单 +'+add+' 条，后台自动连续抓取中…（进度见「抓取调度」）','ok');startModePoll(mode);}
      else if(d.pending>0){toast(label+' 本轮 +'+add+' 条，仍有 '+d.pending+' 个片单未完成，请再次点击「'+label+'」继续','warn');}
      else{toast(label+'：'+rep.length+' 片单 · 新增 '+add+' 条 ✅','ok');}
    }else{
      toast(label+'：'+rep.length+' 片单 · 新增 '+add+' 条（子请求 '+d.budget.used+'/'+d.budget.max+'）','ok');
    }
    loadAll();}
  catch(e){toast('抓取失败：'+e.message,'err');}
}
// 后台续抓期间定时刷新进度，直到对应模式 pending=0；设次数兜底，避免永久轮询。
var modePoll=null,modePollN=0;
function startModePoll(mode){
  if(modePoll)clearInterval(modePoll);
  modePollN=0;
  modePoll=setInterval(function(){
    modePollN++;
    loadAll().then(function(){
      var p=STATE.cron?STATE.cron[mode+'_pending']:null;
      if(p===0){stopModePoll();toast(modeLabel(mode)+' 已覆盖全部启用片单 ✅','ok');}
      else if(modePollN>=200){stopModePoll();toast(modeLabel(mode)+' 仍在进行，已停止自动刷新；稍后可在「抓取调度」查看','info');}
    },function(){});
  },6000);
}
function stopModePoll(){if(modePoll){clearInterval(modePoll);modePoll=null;}}
function bindManual(){
  var box=document.getElementById('manualBar');if(!box)return;
  box.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var m=b.getAttribute('data-mact');if(m)manualRun(b,m);});
}
`;
}

/** 设置面板：Token/Secret 与 D1 绑定说明 + 片单配置导入/导出。 */
function jsSettings() {
  return `
function renderSettings(){
  var box=document.getElementById('settings');if(!box)return;
  box.innerHTML='<div class="note">'+
    '<div><b>数据源 Token</b>：TMDB_TOKEN、ADMIN_TOKEN 为 Cloudflare 加密 Secret，出于安全不在此页填写。请到 Worker → Settings → Variables and Secrets 配置。</div>'+
    '<div style="margin-top:6px"><b>D1 绑定</b>：Worker → Settings → Bindings 绑定 D1，Variable name 必须为 <code>DB</code>。</div>'+
    '<div style="margin-top:6px"><b>本机 ADMIN_TOKEN</b>：<span id="set-auth"></span> · 仅存于此浏览器，用于调用管理 API。</div>'+
  '</div>'+
  '<div class="row" style="margin-top:10px">'+
    '<button class="sm" id="cfgExport">导出片单配置</button>'+
    '<button class="sm" id="cfgImportBtn">导入片单配置</button>'+
    '<input type="file" id="cfgFile" accept="application/json,.json" style="display:none">'+
    '<span class="hint" id="cfgHint"></span>'+
  '</div>';
  var s=document.getElementById('set-auth');if(s)s.textContent=token()?'已保存':'未设置';
}
function exportConfig(){
  var lists=(STATE.lists||[]).map(function(l){return {key:l.key,name:l.name,sources:l.sources,cover:l.cover||'',max_items:l.max_items||0,enabled:l.enabled!==false,position:l.position||0};});
  if(!lists.length){toast('暂无片单可导出','warn');return;}
  var blob=new Blob([JSON.stringify({version:1,exported_at:new Date().toISOString(),lists:lists},null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=u;a.download='emos-lists-'+Date.now()+'.json';a.click();URL.revokeObjectURL(u);
  toast('已导出 '+lists.length+' 个片单','ok');
}
async function importConfig(file){
  if(!token()){toast('请先填入并保存 ADMIN_TOKEN','warn');return;}
  var h=document.getElementById('cfgHint');
  try{
    var data=JSON.parse(await file.text()),lists=data&&data.lists?data.lists:(Array.isArray(data)?data:null);
    if(!lists||!lists.length){toast('文件中没有片单（需 {lists:[...]} 或数组）','err');return;}
    if(h)h.textContent='导入中…';
    var d=await apiPost('/admin/lists',{action:'import',lists:lists}),bad=(d.errors||[]).length;
    toast('导入完成：新建 '+d.created+' · 更新 '+d.updated+(bad?' · 失败 '+bad:''),bad?'warn':'ok');
    if(h)h.textContent=bad?d.errors.join('；'):'';
    loadAll();
  }catch(e){toast('导入失败：'+e.message,'err');if(h)h.textContent='';}
}
function bindSettings(){
  var box=document.getElementById('settings');if(!box)return;
  box.addEventListener('click',function(e){
    if(e.target.id==='cfgExport'){exportConfig();return;}
    if(e.target.id==='cfgImportBtn'){var f=document.getElementById('cfgFile');if(f)f.click();}
  });
  box.addEventListener('change',function(e){
    if(e.target.id==='cfgFile'&&e.target.files[0]){importConfig(e.target.files[0]);e.target.value='';}
  });
}
`;
}

/** 日志面板：级别/片单筛选 + 列表渲染 + 展开详情；事件委托绑定在 #logsPanel 上。 */
function jsLogs() {
  return `
var LOGS=[];
function renderLogsBar(){
  var box=document.getElementById('logsPanel');if(!box)return;
  var lk=STATE.lists.map(function(l){return '<option value="'+esc(l.key)+'">'+esc(l.name)+'</option>';}).join('');
  box.innerHTML='<div class="row" style="margin-bottom:10px">'+
    '<select id="logLevel"><option value="">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option></select>'+
    '<select id="logKey"><option value="">全部片单</option>'+lk+'</select>'+
    '<button class="sm" id="logReload">刷新</button>'+
    '<button class="sm" id="logExport">导出</button>'+
    '<button class="sm" id="logCopy">复制诊断</button>'+
    '<span class="hint" id="logHint"></span></div><div id="logList"></div>';
  if(!token())document.getElementById('logList').innerHTML='<div class="meta">填入并保存 ADMIN_TOKEN 后查看日志。</div>';
}
function logRow(r){
  var d=r.detail?'<pre class="logdet">'+esc(r.detail)+'</pre>':'';
  return '<div class="logitem lv-'+esc(r.level)+'"><div class="loghd">'+
    '<span class="lvb">'+esc(r.level)+'</span><span class="logmsg">'+esc(r.message)+'</span>'+
    '<span class="logts">'+esc(r.ts)+'</span></div>'+
    '<div class="logsub">'+esc(r.source||'')+(r.list_key?' · '+esc(r.list_key):'')+'</div>'+d+'</div>';
}
async function loadLogs(){
  if(!token())return;
  var lv=(document.getElementById('logLevel')||{}).value||'';
  var lk=(document.getElementById('logKey')||{}).value||'';
  var h=document.getElementById('logHint');if(h)h.textContent='加载中…';
  try{var d=await api('/admin/logs?limit=200'+(lv?'&level='+lv:'')+(lk?'&list_key='+encodeURIComponent(lk):''));
    var L=d.logs||[],el=document.getElementById('logList');LOGS=L;
    el.innerHTML=L.length?L.map(logRow).join(''):'<div class="meta">暂无日志</div>';
    if(h)h.textContent=L.length+' 条';
    var es=document.getElementById('logSub');if(es){var ne=L.filter(function(r){return r.level==='error';}).length;es.textContent=ne?('⚠ '+ne+' 错误'):'';}}
  catch(e){if(h)h.textContent='加载失败：'+e.message;}
}
function exportLogs(){
  if(!LOGS.length){toast('暂无日志可导出','warn');return;}
  var blob=new Blob([JSON.stringify(LOGS,null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=u;a.download='emos-logs-'+Date.now()+'.json';a.click();URL.revokeObjectURL(u);
  toast('已导出 '+LOGS.length+' 条','ok');
}
function copyDiag(){
  var c=STATE.cron||{},provs={};
  (STATE.lists||[]).forEach(function(l){(l.sources||[]).forEach(function(s){if(s&&s.provider)provs[s.provider]=1;});});
  var t=JSON.stringify({
    ts:new Date().toISOString(),
    env:{origin:location.origin,ua:navigator.userAgent,secure:window.isSecureContext},
    config:{cron_mode:c.cron_mode||null,hot_interval:c.hot_interval||null,full_floor_year:c.full_floor_year||null,last_heartbeat_at:c.last_heartbeat_at||null,lists:(STATE.lists||[]).length,providers:Object.keys(provs)},
    logs:LOGS
  },null,2);
  if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){
    navigator.clipboard.writeText(t).then(function(){toast('诊断信息已复制','ok');},function(){window.prompt('复制诊断信息：',t);});
  }else{window.prompt('复制诊断信息：',t);}
}
function bindLogs(){
  var box=document.getElementById('logsPanel');if(!box)return;
  box.addEventListener('change',function(e){if(e.target.id==='logLevel'||e.target.id==='logKey')loadLogs();});
  box.addEventListener('click',function(e){
    if(e.target.id==='logReload'){loadLogs();return;}
    if(e.target.id==='logExport'){exportLogs();return;}
    if(e.target.id==='logCopy'){copyDiag();return;}
    var it=e.target.closest('.logitem');if(it)it.classList.toggle('open');});
}
`;
}

/** 接线与启动：主题/token/事件绑定，loadAll 并行拉取三端点并渲染。 */
function jsBoot() {
  return `
async function loadAll(){
  if(!token()){
    renderStatus();renderCron();renderManual();renderSettings();renderLists();renderLogsBar();
    var ac=document.getElementById('addCard');if(ac)ac.innerHTML='<div class="meta">填入并保存 ADMIN_TOKEN 后可添加片单。</div>';
    return;
  }
  try{
    var res=await Promise.all([api('/admin/providers'),api('/admin/lists'),api('/admin/cron')]);
    PROV=res[0].providers||[];STATE.lists=res[1].lists||[];STATE.cron=res[2];
    renderStatus();renderCron();renderManual();renderSettings();renderAddCard();renderLists();renderLogsBar();loadLogs();renderOnboard();
  }catch(e){toast('加载失败：'+e.message,'err');}
}
function boot(){
  applyTheme(curTheme());
  var tk=document.getElementById('token');tk.value=token();
  function showAuth(){document.getElementById('authState').textContent=token()?'已保存':'未设置';}
  document.getElementById('themeBtn').addEventListener('click',toggleTheme);
  document.getElementById('saveTokenBtn').addEventListener('click',function(){
    var v=tk.value.trim();if(v)localStorage.setItem(TK,v);else localStorage.removeItem(TK);
    showAuth();toast(v?'ADMIN_TOKEN 已保存':'已清空 ADMIN_TOKEN',v?'ok':'warn');loadAll();
  });
  showAuth();bindCards();bindCron();bindManual();bindLogs();bindSettings();bindOnboard();loadAll();
}
boot();
`;
}

/** 首次部署引导（骨架）：token 已填且无片单时显示欢迎面板；模板渲染/一键创建下一轮填充。 */
function jsOnboard() {
  return `
var ONBOARD_TPL=[],OBSKIP='emos_ob_skip';
async function renderOnboard(){
  var box=document.getElementById('onboard');if(!box)return;
  if(!token()||localStorage.getItem(OBSKIP)||(STATE.lists&&STATE.lists.length)){box.style.display='none';box.innerHTML='';return;}
  box.style.display='';
  box.innerHTML='<div class="sec"><h2>👋 欢迎！先创建第一个片单</h2></div>'+
    '<div class="panel" id="onboardPanel"><div class="meta">正在加载初始模板…</div></div>';
  try{
    var d=await api('/admin/onboarding');
    if(!d.empty){box.style.display='none';box.innerHTML='';return;}
    ONBOARD_TPL=d.templates||[];
    var cards=ONBOARD_TPL.map(function(t){return '<label class="row" style="align-items:flex-start;gap:8px;margin-bottom:8px">'+
      '<input type="checkbox" class="obChk" data-key="'+esc(t.key)+'" checked>'+
      '<span><b>'+esc(t.name)+'</b><div class="meta">'+esc(t.desc||'')+'</div></span></label>';}).join('');
    var p=document.getElementById('onboardPanel');
    if(p)p.innerHTML='<div class="meta" style="margin-bottom:8px">勾选要创建的推荐片单，之后可在控制台随时修改或删除。</div>'+cards+
      '<div class="row" style="margin-top:10px"><button class="sm" id="obCreate">创建所选片单</button><button class="sm" id="obSkip">跳过</button><span class="hint" id="obHint"></span></div>';
  }catch(e){var q=document.getElementById('onboardPanel');if(q)q.innerHTML='<div class="meta">加载失败：'+esc(e.message)+'</div>';}
}
async function createSelected(){
  var sel=ONBOARD_TPL.filter(function(t){var c=document.querySelector('#onboard .obChk[data-key="'+t.key+'"]');return c&&c.checked;});
  if(!sel.length){toast('请至少勾选一个片单','warn');return;}
  var h=document.getElementById('obHint');if(h)h.textContent='创建中…';
  try{
    var d=await apiPost('/admin/lists',{action:'import',lists:sel}),bad=(d.errors||[]).length;
    toast('已创建 '+d.created+' 个片单'+(bad?'（'+bad+' 个失败）':''),bad?'warn':'ok');
    loadAll();
  }catch(e){toast('创建失败：'+e.message,'err');if(h)h.textContent='';}
}
function bindOnboard(){
  var box=document.getElementById('onboard');if(!box)return;
  box.addEventListener('click',function(e){
    if(e.target.id==='obCreate'){createSelected();return;}
    if(e.target.id==='obSkip'){localStorage.setItem(OBSKIP,'1');renderOnboard();}
  });
}
`;
}

/** 组装浏览器端脚本：各分段拼成单个 <script> 内容（共享同一作用域）。 */
function consoleJs() {
  return [jsCore(), jsStatus(), jsListsForm(), jsListsCards(), jsCron(), jsManual(), jsSettings(), jsLogs(), jsOnboard(), jsBoot()].join("\n");
}
