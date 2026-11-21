import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startMockGoogle } from './mock-google.js';
import { makeKeyFile, googleEnv, connect } from './helpers.js';

const DAY = 86_400_000;
const iso = (offset) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
const span = (b) => Math.round((Date.parse(b.endDate) - Date.parse(b.startDate)) / DAY) + 1;

async function withServer(queryHandler, fn) {
  const key = makeKeyFile();
  const google = await startMockGoogle({ publicKey: key.publicKey, queryHandler });
  const c = await connect(googleEnv(google.base, { GSC_SERVICE_ACCOUNT_FILE: key.file }));
  try {
    await fn({ ...c, google });
  } finally {
    await c.close();
    await google.close();
    fs.rmSync(key.dir, { recursive: true, force: true });
  }
}

const okPages = Array.from({ length: 5 }, (_, i) => ({ keys: [`/ok${i}`], clicks: 80, impressions: 1000, ctr: 0.08, position: 5 }));

/** A small site: data keyed by dimensions, window length and how far back the window ends. */
function site(body) {
  const dims = body.dimensions.join(',');
  const end = body.endDate;
  const n = span(body);
  if (dims === '') {
    if (end === iso(2)) return [{ clicks: 200, impressions: 5000, ctr: 0.04, position: 6.123 }];
    if (end === iso(9)) return [{ clicks: 150, impressions: 4000, ctr: 0.0375, position: 6.8 }];
    return [];
  }
  if (dims === 'query' && n === 7) {
    if (end === iso(2)) return [{ keys: ['new q'], clicks: 8, impressions: 90, ctr: 0.09, position: 4.2 }, { keys: ['steady'], clicks: 20, impressions: 300, ctr: 0.07, position: 3 }];
    if (end === iso(9)) return [{ keys: ['lost q'], clicks: 6, impressions: 80, ctr: 0.07, position: 5 }, { keys: ['steady'], clicks: 18, impressions: 280, ctr: 0.06, position: 3 }];
  }
  if (dims === 'query,page' && n === 28) {
    return [
      { keys: ['blue widgets', '/blue'], clicks: 10, impressions: 1000, ctr: 0.01, position: 8 },
      { keys: ['blue widgets', '/blog/blue'], clicks: 5, impressions: 600, ctr: 0.008, position: 9 },
    ];
  }
  if (dims === 'page' && n === 7) {
    if (end === iso(2)) return [{ keys: ['/a'], clicks: 100, impressions: 900, ctr: 0.11, position: 3 }, { keys: ['/b'], clicks: 20, impressions: 500, ctr: 0.04, position: 6 }, { keys: ['/c'], clicks: 40, impressions: 400, ctr: 0.1, position: 4 }];
    if (end === iso(9)) return [{ keys: ['/a'], clicks: 60, impressions: 800, ctr: 0.075, position: 4 }, { keys: ['/b'], clicks: 60, impressions: 500, ctr: 0.12, position: 4 }];
  }
  if (dims === 'page' && n === 28) {
    if (end === iso(2)) return [...okPages, { keys: ['/weak'], clicks: 20, impressions: 2000, ctr: 0.01, position: 5 }, { keys: ['/slide'], clicks: 30, impressions: 375, ctr: 0.08, position: 5 }];
    if (end === iso(30)) return [{ keys: ['/slide'], clicks: 60, impressions: 800, ctr: 0.075, position: 5 }];
    if (end === iso(58)) return [{ keys: ['/slide'], clicks: 100, impressions: 1200, ctr: 0.083, position: 4 }];
  }
  return [];
}

test('report_seo_recommendations: one ranked list from all sources, with method and evidence', async () => {
  await withServer(site, async ({ call }) => {
    const r = await call('report_seo_recommendations', { site: 'https://example.com/' });
    assert.equal(r.isError, false, r.text);
    const recs = r.data.recommendations;
    // score = estimated clicks x weight
    assert.deepEqual(recs.map((x) => [x.rank, x.type, x.target, x.priority_score]), [
      [1, 'ctr_outlier', '/weak', 112], // (2000 x 0.08 - 20) = 140 x 0.8
      [2, 'quick_win', 'blue widgets -> /blue', 90], // 1000 x 0.1 - 10
      [3, 'quick_win', 'blue widgets -> /blog/blue', 55], // 600 x 0.1 - 5
      [4, 'content_decay', '/slide', 35], // 100 -> 60 -> 30: 70 lost x 0.5
      [5, 'traffic_drop', '/slide', 15], // 60 -> 30 vs the previous 28 days: 30 lost x 0.5
      [6, 'cannibalization', 'blue widgets', 3.8], // 15 clicks x 0.25
    ]);
    assert.match(r.data.method, /priority_score = estimated_clicks/);
    assert.ok(recs.every((x) => x.action && x.evidence && x.confidence && x.estimate_basis));
    assert.equal(r.data.analysed.days, 28);
  });
});

test('report_seo_recommendations: says so when nothing qualifies', async () => {
  await withServer(() => [], async ({ call }) => {
    const r = await call('report_seo_recommendations', { site: 'https://example.com/' });
    assert.equal(r.data.recommendation_count, 0);
    assert.match(r.data.note, /longer period/);
  });
});

test('report_weekly: totals, movers, new/lost queries, recommendations and a Markdown report', async () => {
  await withServer(site, async ({ call, google }) => {
    const r = await call('report_weekly', { site: 'https://example.com/' });
    assert.equal(r.isError, false, r.text);
    const d = r.data;
    assert.deepEqual(d.period, { start: iso(8), end: iso(2) });
    assert.deepEqual(d.previous_period, { start: iso(15), end: iso(9) });
    assert.deepEqual(d.totals, { clicks: 200, impressions: 5000, ctr: 0.04, position: 6.1 });
    assert.equal(d.change.clicks, 50);
    assert.equal(d.change.clicks_pct, 33.3);
    assert.deepEqual(d.top_gainers.map((x) => x.page).sort(), ['/a', '/c']);
    assert.deepEqual(d.top_losers.map((x) => [x.page, x.change]), [['/b', -40]]);
    assert.deepEqual(d.new_queries.map((x) => x.query), ['new q']);
    assert.deepEqual(d.lost_queries.map((x) => x.query), ['lost q']);
    // weekly drop for /b (-40) joins the 28-day findings, so it appears in the ranking
    const types = d.recommendations.map((x) => x.type);
    assert.equal(d.recommendations[0].target, '/weak');
    assert.ok(types.includes('traffic_drop'));
    assert.equal(d.recommendations.length, 5);
    assert.match(d.report, /^# Search Console weekly report: https:\/\/example\.com\//);
    assert.match(d.report, /Change: clicks \+50 \(\+33\.3%\)/);
    assert.match(d.report, /## Lost queries\n- lost q/);
    assert.ok(d.notes.some((n) => /lags about 2 days/.test(n)));
    // each distinct (window, dimension) is fetched once even though several findings share it
    const bodies = google.log.filter((l) => l.path.endsWith('/searchAnalytics/query')).map((l) => { const b = JSON.parse(l.body); return `${b.startDate}|${b.endDate}|${b.dimensions.join(',')}`; });
    const pageMain = bodies.filter((b) => b.endsWith(`${iso(2)}|page`) && b.startsWith(`${iso(29)}|`));
    assert.equal(pageMain.length, 1, 'the 28-day page window is queried once and shared');
  });
});

test('report_weekly: an empty site still produces a valid report', async () => {
  await withServer(() => [], async ({ call }) => {
    const r = await call('report_weekly', { site: 'https://example.com/' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.data.totals, { clicks: 0, impressions: 0, ctr: 0, position: 0 });
    assert.deepEqual(r.data.recommendations, []);
    assert.match(r.data.report, /## Top recommendations\n- none/);
  });
});

test('gsc_compare_periods: two arbitrary ranges, totals, deltas, movers, differing-length note', async () => {
  const handler = (b) => {
    const dims = b.dimensions.join(',');
    const isCur = b.endDate === '2026-09-14';
    if (dims === '') return [isCur ? { clicks: 300, impressions: 9000, ctr: 0.0333, position: 7.2 } : { clicks: 500, impressions: 8000, ctr: 0.0625, position: 6.0 }];
    if (dims === 'page') return isCur
      ? [{ keys: ['/x'], clicks: 100, impressions: 3000, ctr: 0.03, position: 8 }, { keys: ['/y'], clicks: 200, impressions: 6000, ctr: 0.03, position: 7 }]
      : [{ keys: ['/x'], clicks: 300, impressions: 3000, ctr: 0.1, position: 4 }, { keys: ['/y'], clicks: 200, impressions: 5000, ctr: 0.04, position: 6 }];
    return [];
  };
  await withServer(handler, async ({ call, google }) => {
    const r = await call('gsc_compare_periods', { site: 'https://example.com/', current_start: '2026-09-01', current_end: '2026-09-14', previous_start: '2026-08-01', previous_end: '2026-08-31' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.current.totals.clicks, 300);
    assert.equal(r.data.previous.totals.clicks, 500);
    assert.deepEqual([r.data.change.clicks, r.data.change.clicks_pct, r.data.change.position], [-200, -40, 1.2]);
    assert.deepEqual(r.data.losers.map((x) => [x.page, x.change]), [['/x', -200]]);
    assert.deepEqual(r.data.gainers, []);
    assert.ok(r.data.notes.some((n) => /differ in length \(14 vs 31 days\)/.test(n)));
    const sent = google.log.filter((l) => l.path.endsWith('/searchAnalytics/query')).map((l) => JSON.parse(l.body));
    assert.ok(sent.some((b) => b.startDate === '2026-08-01' && b.endDate === '2026-08-31' && b.dimensions.length === 0), 'totals requested for the baseline range');
  });
});

test('gsc_compare_periods: rejects bad or reversed dates without calling Google', async () => {
  await withServer(() => [], async ({ call, google }) => {
    const base = { site: 'https://example.com/', previous_start: '2026-08-01', previous_end: '2026-08-31' };
    const rev = await call('gsc_compare_periods', { ...base, current_start: '2026-09-14', current_end: '2026-09-01' });
    assert.equal(rev.isError, true);
    assert.match(rev.text, /current range: start date is after end date/);
    const bad = await call('gsc_compare_periods', { ...base, current_start: 'yesterday', current_end: '2026-09-01' });
    assert.match(bad.text, /YYYY-MM-DD/);
    assert.equal(google.log.filter((l) => l.path.endsWith('/searchAnalytics/query')).length, 0);
  });
});

test('gsc_compare_periods: flags overlapping ranges', async () => {
  await withServer(() => [], async ({ call }) => {
    const r = await call('gsc_compare_periods', { site: 'https://example.com/', current_start: '2026-09-10', current_end: '2026-09-20', previous_start: '2026-09-15', previous_end: '2026-09-25' });
    assert.ok(r.data.notes.includes('The two ranges overlap.'));
  });
});
