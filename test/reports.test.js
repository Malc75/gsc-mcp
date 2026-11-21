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
