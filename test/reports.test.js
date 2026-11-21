import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/reports.js';

const row = (o) => ({ clicks: 0, impressions: 0, ctr: 0, position: 10, ...o });

test('quickWins: only positions 4-20 with enough impressions, ranked by estimated extra clicks', () => {
  const out = r.quickWins([
    row({ query: 'a', page: '/a', position: 6, impressions: 1000, clicks: 20 }), // 100-20 = 80
    row({ query: 'b', page: '/b', position: 12, impressions: 400, clicks: 4 }), // 40-4 = 36
    row({ query: 'c', page: '/c', position: 2, impressions: 5000, clicks: 400 }), // top 3: excluded
    row({ query: 'd', page: '/d', position: 8, impressions: 50, clicks: 0 }), // too few impressions
    row({ query: 'e', page: '/e', position: 5, impressions: 1000, clicks: 150 }), // already above target CTR: no gain
    row({ query: 'f', page: '/f', position: 25, impressions: 9000, clicks: 0 }), // beyond 20
  ]);
  assert.deepEqual(out.map((x) => [x.query, x.potential_extra_clicks]), [['a', 80], ['b', 36]]);
});

test('trafficDrops: losers, gainers, new and vanished pages; small pages ignored', () => {
  const cur = [row({ page: '/down', clicks: 50 }), row({ page: '/up', clicks: 90 }), row({ page: '/new', clicks: 40 }), row({ page: '/tiny', clicks: 2 })];
  const prev = [row({ page: '/down', clicks: 120 }), row({ page: '/up', clicks: 60 }), row({ page: '/gone', clicks: 70 }), row({ page: '/tiny', clicks: 1 })];
  const { losers, gainers } = r.trafficDrops(cur, prev, 'page', { minClicks: 10 });
  assert.deepEqual(losers.map((x) => x.page).sort(), ['/down', '/gone']);
  assert.ok(losers.some((x) => x.page === '/gone' && x.change === -70 && x.change_pct === -100));
  assert.ok(losers.some((x) => x.page === '/down' && x.change === -70 && x.change_pct === -58.3));
  assert.deepEqual(gainers.map((x) => [x.page, x.change]), [['/new', 40], ['/up', 30]].sort((a, b) => b[1] - a[1]));
  assert.ok(![...losers, ...gainers].some((x) => x.page === '/tiny'));
  assert.equal(gainers.find((x) => x.page === '/new').change_pct, null); // no previous clicks: no percentage
});

test('contentDecay: only pages that fall in every window and started with enough clicks', () => {
  const w1 = [row({ page: '/slide', clicks: 100 }), row({ page: '/dip', clicks: 100 }), row({ page: '/flat', clicks: 100 }), row({ page: '/small', clicks: 10 })];
  const w2 = [row({ page: '/slide', clicks: 70 }), row({ page: '/dip', clicks: 40 }), row({ page: '/flat', clicks: 100 }), row({ page: '/small', clicks: 5 })];
  const w3 = [row({ page: '/slide', clicks: 30 }), row({ page: '/dip', clicks: 90 }), row({ page: '/flat', clicks: 90 }), row({ page: '/small', clicks: 1 })];
  const out = r.contentDecay([w1, w2, w3], { minClicks: 20 });
  assert.deepEqual(out.map((x) => x.page), ['/slide']);
  assert.equal(out[0].lost_clicks, 70);
  assert.equal(out[0].lost_pct, 70);
});

test('cannibalization: queries with 2+ pages each over the share threshold', () => {
  const rows = [
    row({ query: 'shoes', page: '/a', impressions: 600, clicks: 30, position: 5 }),
    row({ query: 'shoes', page: '/b', impressions: 400, clicks: 10, position: 7 }),
    row({ query: 'shoes', page: '/c', impressions: 20, clicks: 0, position: 30 }), // under 10% share
    row({ query: 'boots', page: '/a', impressions: 900, clicks: 50 }), // one page only
    row({ query: 'tiny', page: '/x', impressions: 30 }), row({ query: 'tiny', page: '/y', impressions: 30 }), // too few impressions
  ];
  const out = r.cannibalization(rows, { minImpressions: 100, minShare: 0.1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].query, 'shoes');
  assert.deepEqual(out[0].pages.map((p) => [p.page, p.share]), [['/a', 0.588], ['/b', 0.392]]);
});

test('ctrOutliers: pages under half the median CTR at their position', () => {
  const pages = [];
  for (let i = 0; i < 5; i++) pages.push(row({ page: `/ok${i}`, position: 5, impressions: 1000, clicks: 80, ctr: 0.08 }));
  pages.push(row({ page: '/weak', position: 5, impressions: 2000, clicks: 20, ctr: 0.01 }));
  pages.push(row({ page: '/lonely', position: 15, impressions: 2000, clicks: 1, ctr: 0.0005 })); // bucket too small for a median
  const out = r.ctrOutliers(pages, { minImpressions: 500 });
  assert.deepEqual(out.map((x) => x.page), ['/weak']);
  assert.equal(out[0].potential_extra_clicks, 140); // 2000 * 0.08 - 20
});

test('brandSplit: case-insensitive term match, shares add up', () => {
  const rows = [row({ query: 'Acme login', clicks: 60, impressions: 100 }), row({ query: 'acme ltd', clicks: 20, impressions: 50 }), row({ query: 'cheap widgets', clicks: 20, impressions: 400 })];
  const out = r.brandSplit(rows, ['ACME'], { top: 5 });
  assert.equal(out.branded.clicks, 80);
  assert.equal(out.non_branded.clicks, 20);
  assert.equal(out.branded.click_share, 0.8);
  assert.equal(out.non_branded.click_share, 0.2);
  assert.equal(out.branded.top_queries[0].query, 'Acme login');
});

// ---- totals / compare / recommendations / weekly -------------------------------------------

test('totalsDelta: differences and percentages; no percentage when the baseline is zero', () => {
  const d = r.totalsDelta({ clicks: 150, impressions: 3000, ctr: 0.05, position: 6.5 }, { clicks: 100, impressions: 4000, ctr: 0.025, position: 8 });
  assert.deepEqual(d, { clicks: 50, clicks_pct: 50, impressions: -1000, impressions_pct: -25, ctr: 0.025, position: -1.5 });
  assert.equal(r.totalsDelta({ clicks: 5, impressions: 5, ctr: 0, position: 1 }, { clicks: 0, impressions: 0, ctr: 0, position: 0 }).clicks_pct, null);
});

test('newAndLostQueries: queries with clicks in one period only; tiny ones ignored', () => {
  const cur = [row({ query: 'new', clicks: 9 }), row({ query: 'both', clicks: 5 }), row({ query: 'newtiny', clicks: 1 }), row({ query: 'zeroBefore', clicks: 4 })];
  const prev = [row({ query: 'gone', clicks: 7 }), row({ query: 'both', clicks: 6 }), row({ query: 'zeroBefore', clicks: 0 }), row({ query: 'gonetiny', clicks: 2 })];
  const out = r.newAndLostQueries(cur, prev, { minClicks: 3 });
  assert.deepEqual(out.new_queries.map((x) => x.query), ['new', 'zeroBefore']);
  assert.deepEqual(out.lost_queries.map((x) => x.query), ['gone']);
});

test('recommendations: ordered by estimated clicks x weight; each item explains itself', () => {
  const out = r.recommendations({
    quickWins: [{ query: 'blue widgets', page: '/blue', position: 8, impressions: 1000, clicks: 10, ctr: 0.01, potential_extra_clicks: 90 }],
    ctrOutliers: [{ page: '/weak', position: 5, impressions: 2000, clicks: 20, ctr: 0.01, median_ctr_at_position: 0.08, potential_extra_clicks: 140 }],
    losers: [{ page: '/b', clicks: 20, previous_clicks: 60, change: -40, change_pct: -66.7, position: 6, previous_position: 4 }],
    decay: [{ page: '/slide', clicks_oldest: 100, clicks_middle: 60, clicks_latest: 30, lost_clicks: 70, lost_pct: 70 }],
    cannibalization: [{ query: 'blue widgets', total_impressions: 1600, pages: [{ page: '/blue', clicks: 10 }, { page: '/blog/blue', clicks: 5 }] }],
  });
  // 140*0.8=112, 90*1=90, 70*0.5=35, 40*0.5=20, 15*0.25=3.75
  assert.deepEqual(out.map((x) => [x.rank, x.type, x.priority_score]), [[1, 'ctr_outlier', 112], [2, 'quick_win', 90], [3, 'content_decay', 35], [4, 'traffic_drop', 20], [5, 'cannibalization', 3.8]]);
  assert.match(out[0].action, /title and meta description of \/weak.*1% against 8%/);
  assert.equal(out[0].confidence, 'medium');
  assert.ok(out.every((x) => x.estimate_basis && x.evidence));
});

test('recommendations: zero-gain items are dropped, and the limit applies', () => {
  const qw = Array.from({ length: 5 }, (_, i) => ({ query: `q${i}`, page: '/p', position: 6, impressions: 100, clicks: 0, ctr: 0, potential_extra_clicks: 10 + i }));
  assert.equal(r.recommendations({ quickWins: [...qw, { query: 'none', page: '/n', position: 6, impressions: 1, clicks: 0, ctr: 0, potential_extra_clicks: 0 }] }, { limit: 3 }).length, 3);
  assert.deepEqual(r.recommendations({}), []);
});

test('weeklyMarkdown: renders totals, sections and "none" for empty ones', () => {
  const md = r.weeklyMarkdown({
    site: 'https://example.com/',
    period: { start: '2026-11-07', end: '2026-11-13' },
    previous_period: { start: '2026-10-31', end: '2026-11-06' },
    totals: { clicks: 200, impressions: 5000, ctr: 0.04, position: 6.1 },
    previous_totals: { clicks: 150, impressions: 4000, ctr: 0.0375, position: 6.8 },
    change: { clicks: 50, clicks_pct: 33.3, impressions: 1000, impressions_pct: 25, ctr: 0.0025, position: -0.7 },
    top_gainers: [{ page: '/a', change: 40, previous_clicks: 60, clicks: 100 }],
    top_losers: [],
    new_queries: [{ query: 'new q', clicks: 8, position: 4.2 }],
    lost_queries: [],
    recommendations: [{ rank: 1, type: 'quick_win', estimated_clicks: 90, confidence: 'medium', action: 'Do the thing.' }],
    notes: ['Data lags.'],
  });
  assert.match(md, /^# Search Console weekly report: https:\/\/example\.com\//);
  assert.match(md, /Change: clicks \+50 \(\+33\.3%\), impressions \+1000 \(\+25%\), position -0\.7/);
  assert.match(md, /## Pages gaining clicks\n- \/a: \+40 \(60 to 100\)/);
  assert.match(md, /## Pages losing clicks\n- none/);
  assert.match(md, /#1 \[quick_win, ~90 clicks, medium confidence\] Do the thing\./);
  assert.match(md, /_Data lags\._$/);
});
