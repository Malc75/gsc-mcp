import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GscClient, GscError, shapeRows, round } from './gsc.js';
import { TokenProvider } from './auth.js';
import { defaultEnd, isDate, shift, window } from './dates.js';
import * as reports from './reports.js';

export const VERSION = '0.2.0';
const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance'];
const OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'];
const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];
const REPORT_MAX_ROWS = 50_000;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/** Wrap a handler so API/config errors become tool errors (isError) instead of protocol errors. */
const safe = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    if (e instanceof GscError || e?.message) return fail(e.message);
    return fail('Unexpected error');
  }
};

export function createServer(config, { fetchImpl = fetch, client } = {}) {
  const tokens = new TokenProvider(config, fetchImpl);
  const gsc = client || new GscClient(config, tokens, fetchImpl);
  const server = new McpServer({ name: 'gsc-mcp', version: VERSION });

  const site = z.string().min(1).describe('Search Console property exactly as listed by gsc_list_sites, e.g. "https://example.com/" or "sc-domain:example.com"');
  const resolveSite = (s) => {
    const v = s || config.defaultSite;
    if (!v) throw new Error('site is required (or set GSC_DEFAULT_SITE)');
    return v;
  };
  const siteOpt = site.optional();
  const days = (def = 28) => z.number().int().min(1).max(480).default(def).describe(`Length of the period in days (default ${def}). Ends 2 days ago because Search Console data lags.`);
  const endDate = z.string().optional().describe('Last day of the period, YYYY-MM-DD (default: 2 days ago)');
  const resolveEnd = (e) => {
    if (e === undefined) return defaultEnd();
    if (!isDate(e)) throw new Error('end_date must be YYYY-MM-DD');
    return e;
  };

  const analyticsBody = (start, end, dimensions, extra = {}) => ({
    startDate: start,
    endDate: end,
    dimensions,
    type: extra.searchType || 'web',
    dataState: extra.dataState || 'final',
    ...(extra.filters?.length
      ? { dimensionFilterGroups: [{ groupType: 'and', filters: extra.filters.map((f) => ({ dimension: f.dimension, operator: f.operator, expression: f.expression })) }] }
      : {}),
  });

  async function fetchRows(s, start, end, dimensions, opts = {}) {
    const { rows, truncated } = await gsc.queryAll(s, analyticsBody(start, end, dimensions, opts), REPORT_MAX_ROWS);
    return { rows: shapeRows(rows, dimensions), truncated };
  }

  // ---- status -------------------------------------------------------------------------------
  server.registerTool(
    'gsc_auth_status',
    {
      title: 'Auth status',
      description: 'Show how this server authenticates and whether write tools are enabled. Makes no Google call.',
      inputSchema: {},
      annotations: { ...READ, openWorldHint: false },
    },
    safe(async () => ({
      credentials: tokens.mode,
      write_tools_enabled: config.allowWrite,
      scope: config.scope,
      default_site: config.defaultSite,
      version: VERSION,
    }))
  );

  // ---- properties ---------------------------------------------------------------------------
  server.registerTool(
    'gsc_list_sites',
    {
      title: 'List sites',
      description: 'List every Search Console property this account can access, with permission level. Use these exact names in other tools.',
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const sites = await gsc.listSites();
      return { count: sites.length, sites: sites.map((s) => ({ site: s.siteUrl, permission: s.permissionLevel })) };
    })
  );

  server.registerTool(
    'gsc_get_site',
    { title: 'Get site', description: 'One property and the account\'s permission level on it.', inputSchema: { site: siteOpt }, annotations: READ },
    safe(async ({ site: s }) => {
      const r = await gsc.getSite(resolveSite(s));
      return { site: r.siteUrl, permission: r.permissionLevel };
    })
  );

  // ---- performance --------------------------------------------------------------------------
  server.registerTool(
    'gsc_query_analytics',
    {
      title: 'Query search analytics',
      description:
        'Search performance (clicks, impressions, CTR, average position) grouped by query, page, country, device, date or searchAppearance, with optional filters. Without dimensions you get one total row. Returns at most row_limit rows (max 25,000) and says when truncated.',
      inputSchema: {
        site: siteOpt,
        start_date: z.string().optional().describe('YYYY-MM-DD. Default: end_date minus days.'),
        end_date: endDate,
        days: days(28),
        dimensions: z.array(z.enum(DIMENSIONS)).max(4).default([]).describe('Group by these dimensions, in order'),
        filters: z
          .array(z.object({ dimension: z.enum(DIMENSIONS), operator: z.enum(OPERATORS), expression: z.string() }))
          .max(10)
          .default([])
          .describe('All filters must match (AND). Regex operators use RE2 syntax.'),
        search_type: z.enum(SEARCH_TYPES).default('web'),
        data_state: z.enum(['final', 'all']).default('final').describe('"all" includes fresh, still-changing data'),
        row_limit: z.number().int().min(1).max(25_000).default(1000),
        start_row: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const end = resolveEnd(a.end_date);
      const start = a.start_date ?? shift(end, -(a.days - 1));
      if (!isDate(start)) throw new Error('start_date must be YYYY-MM-DD');
      const body = { ...analyticsBody(start, end, a.dimensions, { filters: a.filters, searchType: a.search_type, dataState: a.data_state }), rowLimit: a.row_limit, startRow: a.start_row };
      const rows = await gsc.queryOnce(s, body);
      return {
        site: s,
        start_date: start,
        end_date: end,
        dimensions: a.dimensions,
        row_count: rows.length,
        truncated: rows.length === a.row_limit,
        rows: shapeRows(rows, a.dimensions),
      };
    })
  );

  // ---- sitemaps -----------------------------------------------------------------------------
  const sitemapShape = (m) => ({
    path: m.path,
    type: m.type,
    is_pending: m.isPending,
    is_index: m.isSitemapsIndex,
    last_submitted: m.lastSubmitted,
    last_downloaded: m.lastDownloaded,
    errors: Number(m.errors || 0),
    warnings: Number(m.warnings || 0),
    contents: (m.contents || []).map((c) => ({ type: c.type, submitted: Number(c.submitted || 0), indexed: Number(c.indexed || 0) })),
  });

  server.registerTool(
    'gsc_list_sitemaps',
    { title: 'List sitemaps', description: 'Sitemaps submitted for a property, with status, errors, warnings and submitted/indexed counts.', inputSchema: { site: siteOpt }, annotations: READ },
    safe(async ({ site: s }) => {
      const list = await gsc.listSitemaps(resolveSite(s));
      return { count: list.length, sitemaps: list.map(sitemapShape) };
    })
  );

  server.registerTool(
    'gsc_get_sitemap',
    { title: 'Get sitemap', description: 'Details of one submitted sitemap.', inputSchema: { site: siteOpt, feedpath: z.string().describe('Full sitemap URL') }, annotations: READ },
    safe(async ({ site: s, feedpath }) => sitemapShape(await gsc.getSitemap(resolveSite(s), feedpath)))
  );

  // ---- URL inspection -----------------------------------------------------------------------
  const inspectShape = (r) => {
    const i = r.inspectionResult || {};
    const idx = i.indexStatusResult || {};
    return {
      verdict: idx.verdict,
      coverage_state: idx.coverageState,
      indexing_state: idx.indexingState,
      robots_txt_state: idx.robotsTxtState,
      page_fetch_state: idx.pageFetchState,
      last_crawl_time: idx.lastCrawlTime,
      crawled_as: idx.crawledAs,
      google_canonical: idx.googleCanonical,
      user_canonical: idx.userCanonical,
      sitemaps: idx.sitemap,
      referring_urls: idx.referringUrls,
      mobile_usability: i.mobileUsabilityResult?.verdict,
      rich_results: i.richResultsResult?.verdict,
      inspection_link: i.inspectionResultLink,
    };
  };

  server.registerTool(
    'gsc_inspect_url',
    {
      title: 'Inspect URL',
      description: 'URL Inspection: is the URL indexed, coverage state, canonicals, last crawl, robots, mobile usability, rich results. Quota is about 2,000 inspections a day per property.',
      inputSchema: { site: siteOpt, url: z.string().url().describe('A URL inside the property'), language_code: z.string().default('en-GB') },
      annotations: READ,
    },
    safe(async ({ site: s, url, language_code }) => inspectShape(await gsc.inspectUrl(resolveSite(s), url, language_code)))
  );

  server.registerTool(
    'gsc_inspect_urls_batch',
    {
      title: 'Inspect URLs (batch)',
      description: 'Inspect up to 100 URLs one after another (throttled to stay inside Google\'s quota) and return a compact status per URL. Stops early and says so if Google rate-limits.',
      inputSchema: { site: siteOpt, urls: z.array(z.string().url()).min(1).max(100), language_code: z.string().default('en-GB') },
      annotations: READ,
    },
    safe(async ({ site: s, urls, language_code }) => {
      const prop = resolveSite(s);
      const results = [];
      let stopped = null;
      for (const url of urls) {
        try {
          const r = inspectShape(await gsc.inspectUrl(prop, url, language_code));
          results.push({ url, verdict: r.verdict, coverage_state: r.coverage_state, last_crawl_time: r.last_crawl_time, google_canonical: r.google_canonical });
        } catch (e) {
          if (e instanceof GscError && e.status === 429) {
            stopped = 'Rate limited by Google; remaining URLs were not inspected.';
            break;
          }
          results.push({ url, error: e.message });
        }
        await new Promise((r) => setTimeout(r, config.inspectDelayMs ?? 150));
      }
      const summary = {};
      for (const r of results) summary[r.coverage_state || (r.error ? 'error' : 'unknown')] = (summary[r.coverage_state || (r.error ? 'error' : 'unknown')] || 0) + 1;
      return { requested: urls.length, inspected: results.length, stopped_early: stopped, summary, results };
    })
  );

  // ---- reports (computed here from live data; read-only) ------------------------------------
  const reportMeta = (s, start, end, truncated) => ({ site: s, start_date: start, end_date: end, data_may_be_incomplete: truncated || undefined });

  server.registerTool(
    'report_quick_wins',
    {
      title: 'Quick wins',
      description: 'Query + page pairs ranking in positions 4-20 with many impressions: the cheapest traffic to gain, sorted by estimated extra clicks (assumes ~10% CTR at position 3; an estimate, not a forecast).',
      inputSchema: { site: siteOpt, days: days(28), end_date: endDate, min_impressions: z.number().int().min(1).default(100), min_position: z.number().default(4), max_position: z.number().default(20), limit: z.number().int().min(1).max(200).default(25) },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const w = window(a.days, resolveEnd(a.end_date));
      const { rows, truncated } = await fetchRows(s, w.start, w.end, ['query', 'page']);
      return { ...reportMeta(s, w.start, w.end, truncated), quick_wins: reports.quickWins(rows, { minImpressions: a.min_impressions, minPosition: a.min_position, maxPosition: a.max_position, limit: a.limit }) };
    })
  );

  server.registerTool(
    'report_traffic_drops',
    {
      title: 'Traffic drops and gains',
      description: 'Compare a period with the equally long period before it and return the biggest click losers and gainers by page or query.',
      inputSchema: { site: siteOpt, days: days(28), end_date: endDate, dimension: z.enum(['page', 'query']).default('page'), min_clicks: z.number().int().min(0).default(10).describe('Ignore items with fewer clicks than this in both periods'), limit: z.number().int().min(1).max(100).default(20) },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const end = resolveEnd(a.end_date);
      const cur = window(a.days, end);
      const prev = window(a.days, end, 1);
      const [c, p] = await Promise.all([fetchRows(s, cur.start, cur.end, [a.dimension]), fetchRows(s, prev.start, prev.end, [a.dimension])]);
      return {
        ...reportMeta(s, cur.start, cur.end, c.truncated || p.truncated),
        previous_period: prev,
        ...reports.trafficDrops(c.rows, p.rows, a.dimension, { minClicks: a.min_clicks, limit: a.limit }),
      };
    })
  );

  server.registerTool(
    'report_content_decay',
    {
      title: 'Content decay',
      description: 'Pages whose clicks fell in each of the last three consecutive windows: a steady slide rather than a one-off dip. Candidates for a content refresh.',
      inputSchema: { site: siteOpt, window_days: days(28), end_date: endDate, min_clicks: z.number().int().min(1).default(20).describe('Minimum clicks in the oldest window'), limit: z.number().int().min(1).max(100).default(25) },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const end = resolveEnd(a.end_date);
      const ws = [window(a.window_days, end, 2), window(a.window_days, end, 1), window(a.window_days, end, 0)];
      const res = await Promise.all(ws.map((w) => fetchRows(s, w.start, w.end, ['page'])));
      return { ...reportMeta(s, ws[0].start, end, res.some((r) => r.truncated)), windows: ws, decaying_pages: reports.contentDecay(res.map((r) => r.rows), { minClicks: a.min_clicks, limit: a.limit }) };
    })
  );

  server.registerTool(
    'report_cannibalization',
    {
      title: 'Keyword cannibalization',
      description: 'Queries where two or more of your pages each get a meaningful share of impressions, splitting ranking signals.',
      inputSchema: { site: siteOpt, days: days(28), end_date: endDate, min_impressions: z.number().int().min(1).default(100), min_share: z.number().min(0).max(1).default(0.1), limit: z.number().int().min(1).max(100).default(20) },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const w = window(a.days, resolveEnd(a.end_date));
      const { rows, truncated } = await fetchRows(s, w.start, w.end, ['query', 'page']);
      return { ...reportMeta(s, w.start, w.end, truncated), cannibalized_queries: reports.cannibalization(rows, { minImpressions: a.min_impressions, minShare: a.min_share, limit: a.limit }) };
    })
  );

  server.registerTool(
    'report_ctr_outliers',
    {
      title: 'CTR outliers',
      description: 'Pages whose CTR is under half the median CTR of your pages at the same position: candidates for better titles and meta descriptions.',
      inputSchema: { site: siteOpt, days: days(28), end_date: endDate, min_impressions: z.number().int().min(1).default(500), limit: z.number().int().min(1).max(100).default(25) },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const w = window(a.days, resolveEnd(a.end_date));
      const { rows, truncated } = await fetchRows(s, w.start, w.end, ['page']);
      return { ...reportMeta(s, w.start, w.end, truncated), ctr_outliers: reports.ctrOutliers(rows, { minImpressions: a.min_impressions, limit: a.limit }) };
    })
  );

  server.registerTool(
    'report_brand_split',
    {
      title: 'Brand vs non-brand',
      description: 'Branded vs non-branded queries: clicks, impressions, CTR and click share, with the top queries in each group. Google hides rare queries, so shares cover only clicks with a known query.',
      inputSchema: { site: siteOpt, brand_terms: z.array(z.string().min(1)).min(1).max(20).describe('Words that make a query branded, e.g. ["acme","acme ltd"]'), days: days(28), end_date: endDate, top: z.number().int().min(1).max(50).default(10) },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const w = window(a.days, resolveEnd(a.end_date));
      const { rows, truncated } = await fetchRows(s, w.start, w.end, ['query']);
      return { ...reportMeta(s, w.start, w.end, truncated), ...reports.brandSplit(rows, a.brand_terms, { top: a.top }), note: 'Queries Google withholds for privacy are not in these numbers.' };
    })
  );

  // ---- comparison, recommendations, weekly --------------------------------------------------
  const datePair = (start, end, label) => {
    if (!isDate(start) || !isDate(end)) throw new Error(`${label}: dates must be YYYY-MM-DD`);
    if (start > end) throw new Error(`${label}: start date is after end date`);
    return { start, end };
  };

  async function totalsFor(s, w, opts = {}) {
    const rows = await gsc.queryOnce(s, { ...analyticsBody(w.start, w.end, [], opts), rowLimit: 1 });
    return reports.totalsFromRow(rows[0]);
  }

  server.registerTool(
    'gsc_compare_periods',
    {
      title: 'Compare two date ranges',
      description:
        'Compare any two date ranges (this year vs last, before vs after a change, two campaigns). Returns total clicks, impressions, CTR and position for both with the differences, plus the biggest losers and gainers by page or query. The two ranges may be different lengths; changes are then absolute, so compare like with like where you can.',
      inputSchema: {
        site: siteOpt,
        current_start: z.string().describe('YYYY-MM-DD'),
        current_end: z.string().describe('YYYY-MM-DD'),
        previous_start: z.string().describe('YYYY-MM-DD, the baseline range'),
        previous_end: z.string().describe('YYYY-MM-DD'),
        dimension: z.enum(['page', 'query']).default('page'),
        min_clicks: z.number().int().min(0).default(10).describe('Ignore items with fewer clicks than this in both ranges'),
        limit: z.number().int().min(1).max(100).default(20),
        search_type: z.enum(SEARCH_TYPES).default('web'),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const cur = datePair(a.current_start, a.current_end, 'current range');
      const prev = datePair(a.previous_start, a.previous_end, 'previous range');
      const opts = { searchType: a.search_type };
      const [ct, pt, c, p] = await Promise.all([
        totalsFor(s, cur, opts),
        totalsFor(s, prev, opts),
        fetchRows(s, cur.start, cur.end, [a.dimension], opts),
        fetchRows(s, prev.start, prev.end, [a.dimension], opts),
      ]);
      const notes = [];
      const len = (w) => Math.round((Date.parse(w.end) - Date.parse(w.start)) / 86_400_000) + 1;
      if (len(cur) !== len(prev)) notes.push(`The ranges differ in length (${len(cur)} vs ${len(prev)} days), so absolute changes are not like for like.`);
      if (cur.start <= prev.end && prev.start <= cur.end) notes.push('The two ranges overlap.');
      return {
        site: s,
        current: { ...cur, totals: ct },
        previous: { ...prev, totals: pt },
        change: reports.totalsDelta(ct, pt),
        position_note: 'A negative position change means better (closer to position 1).',
        ...reports.trafficDrops(c.rows, p.rows, a.dimension, { minClicks: a.min_clicks, limit: a.limit }),
        data_may_be_incomplete: c.truncated || p.truncated || undefined,
        notes,
      };
    })
  );

  /** Fetch whatever the recommendation sources need, once each, running independent queries together. */
  async function gatherFindings(s, end, { windowDays, dropDays, include }) {
    const memo = new Map();
    const rowsFor = (w, dims) => {
      const key = `${w.start}|${w.end}|${dims.join(',')}`;
      if (!memo.has(key)) memo.set(key, fetchRows(s, w.start, w.end, dims));
      return memo.get(key);
    };
    const main = window(windowDays, end);
    const dropCur = window(dropDays, end);
    const dropPrev = window(dropDays, end, 1);
    const jobs = {};
    if (include.quickWins || include.cannibalization) jobs.queryPage = rowsFor(main, ['query', 'page']);
    if (include.ctr) jobs.page = rowsFor(main, ['page']);
    if (include.drops) {
      jobs.dropCur = rowsFor(dropCur, ['page']);
      jobs.dropPrev = rowsFor(dropPrev, ['page']);
    }
    if (include.decay) {
      jobs.d1 = rowsFor(window(windowDays, end, 2), ['page']);
      jobs.d2 = rowsFor(window(windowDays, end, 1), ['page']);
      jobs.d3 = rowsFor(main, ['page']);
    }
    const keys = Object.keys(jobs);
    const results = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await jobs[k]])));
    const truncated = Object.values(results).some((r) => r.truncated);
    const input = {};
    if (include.quickWins) input.quickWins = reports.quickWins(results.queryPage.rows, { limit: 50 });
    if (include.cannibalization) input.cannibalization = reports.cannibalization(results.queryPage.rows, { limit: 30 });
    if (include.ctr) input.ctrOutliers = reports.ctrOutliers(results.page.rows, { limit: 50 });
    if (include.drops) input.losers = reports.trafficDrops(results.dropCur.rows, results.dropPrev.rows, 'page', { minClicks: include.dropMinClicks ?? 10, limit: 30 }).losers;
    if (include.decay) input.decay = reports.contentDecay([results.d1.rows, results.d2.rows, results.d3.rows], { limit: 30 });
    return { input, truncated, windows: { main, dropCur, dropPrev } };
  }

  server.registerTool(
    'report_seo_recommendations',
    {
      title: 'Prioritised SEO recommendations',
      description:
        'Runs quick wins, CTR outliers, traffic drops, content decay and keyword cannibalization together and returns ONE list ordered by estimated clicks at stake, each item with a suggested action, a confidence level and the numbers behind it. Ordering is explained in the "method" field. Estimates are heuristics for choosing what to work on first, not forecasts.',
      inputSchema: { site: siteOpt, days: days(28), end_date: endDate, limit: z.number().int().min(1).max(50).default(15) },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const end = resolveEnd(a.end_date);
      const g = await gatherFindings(s, end, { windowDays: a.days, dropDays: a.days, include: { quickWins: true, cannibalization: true, ctr: true, drops: true, decay: true } });
      const recs = reports.recommendations(g.input, { limit: a.limit });
      return {
        site: s,
        analysed: { start_date: g.windows.main.start, end_date: end, days: a.days },
        method: reports.RECOMMENDATION_METHOD,
        recommendation_count: recs.length,
        recommendations: recs,
        data_may_be_incomplete: g.truncated || undefined,
        note: recs.length ? undefined : 'Nothing met the thresholds. On a small site, try a longer period (days up to 480).',
      };
    })
  );

  server.registerTool(
    'report_weekly',
    {
      title: 'Weekly report',
      description:
        'Fixed-format weekly summary: the last 7 days against the 7 before (ending 2 days ago because of Search Console lag): totals and changes, pages gaining and losing clicks, new and lost queries, and the top prioritised recommendations. Returns structured data and a ready-to-send Markdown "report" string. Designed to be called on a schedule.',
      inputSchema: { site: siteOpt, end_date: endDate, top_recommendations: z.number().int().min(1).max(15).default(5), min_clicks: z.number().int().min(0).default(3).describe('Ignore pages/queries with fewer clicks than this') },
      annotations: READ,
    },
    safe(async (a) => {
      const s = resolveSite(a.site);
      const end = resolveEnd(a.end_date);
      const cur = window(7, end);
      const prev = window(7, end, 1);
      const [ct, pt, curQ, prevQ, curP, prevP, g] = await Promise.all([
        totalsFor(s, cur),
        totalsFor(s, prev),
        fetchRows(s, cur.start, cur.end, ['query']),
        fetchRows(s, prev.start, prev.end, ['query']),
        fetchRows(s, cur.start, cur.end, ['page']),
        fetchRows(s, prev.start, prev.end, ['page']),
        // Recommendations look at a 28-day window (7 days is too little to rank on); drops use the weekly windows already fetched above.
        gatherFindings(s, end, { windowDays: 28, dropDays: 7, include: { quickWins: true, cannibalization: true, ctr: true, drops: false, decay: true } }),
      ]);
      const pages = reports.trafficDrops(curP.rows, prevP.rows, 'page', { minClicks: a.min_clicks, limit: 5 });
      const q = reports.newAndLostQueries(curQ.rows, prevQ.rows, { minClicks: a.min_clicks, limit: 5 });
      const input = { ...g.input, losers: reports.trafficDrops(curP.rows, prevP.rows, 'page', { minClicks: Math.max(a.min_clicks, 5), limit: 20 }).losers };
      const recs = reports.recommendations(input, { limit: a.top_recommendations });
      const incomplete = [curQ, prevQ, curP, prevP].some((r) => r.truncated) || g.truncated;
      const report = {
        site: s,
        period: cur,
        previous_period: prev,
        totals: ct,
        previous_totals: pt,
        change: reports.totalsDelta(ct, pt),
        top_gainers: pages.gainers,
        top_losers: pages.losers,
        new_queries: q.new_queries,
        lost_queries: q.lost_queries,
        recommendations: recs,
        data_may_be_incomplete: incomplete || undefined,
        notes: [
          'Search Console data lags about 2 days, so the week ends 2 days ago.',
          'Google hides rare queries, so query lists cover only queries it reports.',
          'Recommendations use the last 28 days and are heuristics for ordering work, not forecasts.',
          ...(incomplete ? ['Some data was truncated at 50,000 rows, so figures may be incomplete.'] : []),
        ],
      };
      return { ...report, report: reports.weeklyMarkdown(report) };
    })
  );

  // ---- write tools (only when GSC_ALLOW_WRITE=true) ----------------------------------------
  if (config.allowWrite) {
    server.registerTool(
      'gsc_submit_sitemap',
      { title: 'Submit sitemap', description: 'Submit or resubmit a sitemap for a property. WRITE.', inputSchema: { site: siteOpt, feedpath: z.string().url().describe('Full sitemap URL') }, annotations: WRITE },
      safe(async ({ site: s, feedpath }) => {
        await gsc.submitSitemap(resolveSite(s), feedpath);
        return { submitted: feedpath };
      })
    );
    server.registerTool(
      'gsc_delete_sitemap',
      { title: 'Delete sitemap', description: 'Remove a sitemap from Search Console (does not delete the file). WRITE.', inputSchema: { site: siteOpt, feedpath: z.string().url() }, annotations: DESTRUCTIVE },
      safe(async ({ site: s, feedpath }) => {
        await gsc.deleteSitemap(resolveSite(s), feedpath);
        return { deleted: feedpath };
      })
    );
    server.registerTool(
      'gsc_add_site',
      { title: 'Add site', description: 'Add a property to Search Console (verification still happens in the Search Console UI). WRITE.', inputSchema: { site }, annotations: WRITE },
      safe(async ({ site: s }) => {
        await gsc.addSite(s);
        return { added: s };
      })
    );
    server.registerTool(
      'gsc_delete_site',
      { title: 'Delete site', description: 'Remove a property from this account\'s Search Console. WRITE, destructive.', inputSchema: { site }, annotations: DESTRUCTIVE },
      safe(async ({ site: s }) => {
        await gsc.deleteSite(s);
        return { deleted: s };
      })
    );
  }

  return server;
}

export { round };
