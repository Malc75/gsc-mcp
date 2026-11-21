import { round } from './gsc.js';

/** Typical share of clicks a result gets at position 3 - the benchmark "quick wins" aim for. Estimate only. */
export const TARGET_CTR = 0.1;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Rows are {query?, page?, clicks, impressions, ctr, position}. */

export function quickWins(rows, { minImpressions = 100, minPosition = 4, maxPosition = 20, limit = 25 } = {}) {
  return rows
    .filter((r) => r.impressions >= minImpressions && r.position >= minPosition && r.position <= maxPosition)
    .map((r) => ({
      query: r.query,
      page: r.page,
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      potential_extra_clicks: Math.max(0, Math.round(r.impressions * TARGET_CTR - r.clicks)),
    }))
    .filter((r) => r.potential_extra_clicks > 0)
    .sort((a, b) => b.potential_extra_clicks - a.potential_extra_clicks)
    .slice(0, limit);
}

export function trafficDrops(current, previous, key, { minClicks = 10, limit = 20 } = {}) {
  const prev = new Map(previous.map((r) => [r[key], r]));
  const seen = new Set();
  const out = [];
  for (const r of current) {
    const p = prev.get(r[key]);
    seen.add(r[key]);
    out.push(delta(r[key], r, p));
  }
  for (const p of previous) {
    if (!seen.has(p[key])) out.push(delta(p[key], undefined, p));
  }
  const big = out.filter((d) => Math.max(d.clicks, d.previous_clicks) >= minClicks);
  return {
    losers: big.filter((d) => d.change < 0).sort((a, b) => a.change - b.change).slice(0, limit),
    gainers: big.filter((d) => d.change > 0).sort((a, b) => b.change - a.change).slice(0, limit),
  };
  function delta(k, cur, prv) {
    const c = cur?.clicks ?? 0;
    const pc = prv?.clicks ?? 0;
    return {
      [key]: k,
      clicks: c,
      previous_clicks: pc,
      change: c - pc,
      change_pct: pc ? round(((c - pc) / pc) * 100, 1) : null,
      position: cur?.position ?? null,
      previous_position: prv?.position ?? null,
    };
  }
}

/** windows = [oldest, middle, newest] page rows. A decaying page's clicks fall in every step. */
export function contentDecay(windows, { minClicks = 20, limit = 25 } = {}) {
  const [w1, w2, w3] = windows.map((rows) => new Map(rows.map((r) => [r.page, r])));
  const out = [];
  for (const [page, r1] of w1) {
    const c1 = r1.clicks;
    const c2 = w2.get(page)?.clicks ?? 0;
    const c3 = w3.get(page)?.clicks ?? 0;
    if (c1 >= minClicks && c1 > c2 && c2 > c3) {
      out.push({ page, clicks_oldest: c1, clicks_middle: c2, clicks_latest: c3, lost_clicks: c1 - c3, lost_pct: round(((c1 - c3) / c1) * 100, 1) });
    }
  }
  return out.sort((a, b) => b.lost_clicks - a.lost_clicks).slice(0, limit);
}

export function cannibalization(rows, { minImpressions = 100, minShare = 0.1, limit = 20 } = {}) {
  const byQuery = new Map();
  for (const r of rows) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, []);
    byQuery.get(r.query).push(r);
  }
  const out = [];
  for (const [query, list] of byQuery) {
    const total = list.reduce((s, r) => s + r.impressions, 0);
    if (total < minImpressions) continue;
    const pages = list
      .map((r) => ({ page: r.page, impressions: r.impressions, clicks: r.clicks, position: r.position, share: round(r.impressions / total, 3) }))
      .filter((p) => p.share >= minShare)
      .sort((a, b) => b.impressions - a.impressions);
    if (pages.length >= 2) out.push({ query, total_impressions: total, pages });
  }
  return out.sort((a, b) => b.total_impressions - a.total_impressions).slice(0, limit);
}

/** Pages whose CTR is under half the median CTR of pages at the same (rounded) position. */
export function ctrOutliers(rows, { minImpressions = 500, limit = 25 } = {}) {
  const buckets = new Map();
  for (const r of rows) {
    if (r.impressions < minImpressions) continue;
    const b = Math.min(20, Math.max(1, Math.round(r.position)));
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r.ctr);
  }
  const medians = new Map();
  for (const [b, ctrs] of buckets) if (ctrs.length >= 3) medians.set(b, median(ctrs));
  const out = [];
  for (const r of rows) {
    if (r.impressions < minImpressions) continue;
    const b = Math.min(20, Math.max(1, Math.round(r.position)));
    const m = medians.get(b);
    if (m !== undefined && r.ctr < m * 0.5) {
      out.push({
        page: r.page,
        position: r.position,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.ctr,
        median_ctr_at_position: round(m, 4),
        potential_extra_clicks: Math.max(0, Math.round(r.impressions * m - r.clicks)),
      });
    }
  }
  return out.sort((a, b) => b.potential_extra_clicks - a.potential_extra_clicks).slice(0, limit);
}

export function brandSplit(rows, brandTerms, { top = 10 } = {}) {
  const terms = brandTerms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const groups = { branded: [], non_branded: [] };
  for (const r of rows) {
    const q = String(r.query || '').toLowerCase();
    (terms.some((t) => q.includes(t)) ? groups.branded : groups.non_branded).push(r);
  }
  const sum = (list, k) => list.reduce((s, r) => s + r[k], 0);
  const totalClicks = sum(rows, 'clicks');
  const summarise = (list) => {
    const clicks = sum(list, 'clicks');
    const impressions = sum(list, 'impressions');
    return {
      queries: list.length,
      clicks,
      impressions,
      ctr: impressions ? round(clicks / impressions, 4) : 0,
      click_share: totalClicks ? round(clicks / totalClicks, 3) : 0,
      top_queries: [...list].sort((a, b) => b.clicks - a.clicks).slice(0, top).map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position })),
    };
  };
  return { brand_terms: terms, branded: summarise(groups.branded), non_branded: summarise(groups.non_branded) };
}
