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

// ---- totals, comparison, recommendations, weekly --------------------------------------------

export function totalsFromRow(row) {
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: round(row?.ctr ?? 0, 4),
    position: round(row?.position ?? 0, 1),
  };
}

/** Difference between two totals objects (current - previous). Position: negative is better. */
export function totalsDelta(cur, prev) {
  const pct = (a, b) => (b ? round(((a - b) / b) * 100, 1) : null);
  return {
    clicks: cur.clicks - prev.clicks,
    clicks_pct: pct(cur.clicks, prev.clicks),
    impressions: cur.impressions - prev.impressions,
    impressions_pct: pct(cur.impressions, prev.impressions),
    ctr: round(cur.ctr - prev.ctr, 4),
    position: round(cur.position - prev.position, 1),
  };
}

/** Queries that earned clicks in one period and none in the other. */
export function newAndLostQueries(curRows, prevRows, { minClicks = 3, limit = 10 } = {}) {
  const cur = new Map(curRows.map((r) => [r.query, r]));
  const prev = new Map(prevRows.map((r) => [r.query, r]));
  const top = (list) => list.sort((a, b) => b.clicks - a.clicks).slice(0, limit).map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position }));
  return {
    new_queries: top(curRows.filter((r) => r.clicks >= minClicks && !(prev.get(r.query)?.clicks > 0))),
    lost_queries: top(prevRows.filter((r) => r.clicks >= minClicks && !(cur.get(r.query)?.clicks > 0))),
  };
}

/**
 * How much each finding type counts for when ranking. These are judgement weights, published in the
 * tool output ("method") so a reader can see exactly how the order was produced.
 */
export const WEIGHTS = {
  quick_win: { weight: 1.0, confidence: 'medium', basis: 'extra clicks if CTR reached ~10% (the typical CTR at position 3)' },
  ctr_outlier: { weight: 0.8, confidence: 'medium', basis: 'extra clicks if CTR matched your median page at the same position' },
  traffic_drop: { weight: 0.5, confidence: 'low', basis: 'clicks lost vs the previous period; may be seasonal or a tracking change' },
  content_decay: { weight: 0.5, confidence: 'medium', basis: 'clicks lost across three consecutive windows' },
  cannibalization: { weight: 0.25, confidence: 'low', basis: 'clicks currently earned by the competing pages (an upper bound on what consolidating could affect)' },
};

/**
 * Merge findings from the individual reports into one list ordered by estimated clicks at stake,
 * weighted by how reliable that kind of estimate is. Every item keeps the numbers it came from.
 * input: { quickWins, ctrOutliers, losers, decay, cannibalization } (each optional)
 */
export function recommendations(input, { limit = 15 } = {}) {
  const items = [];
  const add = (type, target, estimated, action, evidence) => {
    const w = WEIGHTS[type];
    if (!(estimated > 0)) return;
    items.push({ type, target, estimated_clicks: estimated, priority_score: round(estimated * w.weight, 1), confidence: w.confidence, estimate_basis: w.basis, action, evidence });
  };

  for (const q of input.quickWins || []) {
    add('quick_win', `${q.query} -> ${q.page}`, q.potential_extra_clicks,
      `Improve this page for "${q.query}": make sure the title and H1 match the query, expand the section that answers it, and link to the page from related pages. It ranks at position ${q.position}.`,
      { query: q.query, page: q.page, position: q.position, impressions: q.impressions, clicks: q.clicks, ctr: q.ctr });
  }
  for (const p of input.ctrOutliers || []) {
    add('ctr_outlier', p.page, p.potential_extra_clicks,
      `Rewrite the title and meta description of ${p.page}: its CTR is ${pctText(p.ctr)} against ${pctText(p.median_ctr_at_position)} typical for your pages at position ${p.position}.`,
      { page: p.page, position: p.position, impressions: p.impressions, clicks: p.clicks, ctr: p.ctr, median_ctr_at_position: p.median_ctr_at_position });
  }
  for (const d of input.losers || []) {
    const target = d.page ?? d.query;
    add('traffic_drop', target, -d.change,
      `Find out why ${target} lost ${-d.change} clicks${d.change_pct === null ? '' : ` (${d.change_pct}%)`}: check whether its position changed (${d.previous_position ?? 'n/a'} to ${d.position ?? 'n/a'}), whether it is still indexed (gsc_inspect_url), and whether the topic is seasonal.`,
      d);
  }
  for (const d of input.decay || []) {
    add('content_decay', d.page, d.lost_clicks,
      `Refresh ${d.page}: clicks fell from ${d.clicks_oldest} to ${d.clicks_middle} to ${d.clicks_latest} over three consecutive periods. Update outdated facts, add what competitors now cover, and re-promote it internally.`,
      d);
  }
  for (const c of input.cannibalization || []) {
    const clicks = c.pages.reduce((s, p) => s + p.clicks, 0);
    add('cannibalization', c.query, clicks,
      `Several pages compete for "${c.query}" (${c.pages.map((p) => p.page).join(', ')}). Pick one to be the main page, make the others clearly different or merge and redirect them, and link the others to the main page.`,
      c);
  }

  items.sort((a, b) => b.priority_score - a.priority_score);
  return items.slice(0, limit).map((it, i) => ({ rank: i + 1, ...it }));
}

const pctText = (x) => `${round((x ?? 0) * 100, 1)}%`;

export const RECOMMENDATION_METHOD =
  'Items are ordered by priority_score = estimated_clicks x type weight (quick_win 1.0, ctr_outlier 0.8, traffic_drop 0.5, content_decay 0.5, cannibalization 0.25). Estimates are heuristics for ordering work, not forecasts.';

/** Plain-text/Markdown rendering of the weekly report, ready to send as a message or email. */
export function weeklyMarkdown(w) {
  const t = (x) => `${x.clicks} clicks, ${x.impressions} impressions, CTR ${pctText(x.ctr)}, avg position ${x.position}`;
  const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
  const pct = (n) => (n === null ? '' : ` (${n > 0 ? '+' : ''}${n}%)`);
  const lines = [];
  lines.push(`# Search Console weekly report: ${w.site}`);
  lines.push(`Week ${w.period.start} to ${w.period.end} vs ${w.previous_period.start} to ${w.previous_period.end}`);
  lines.push('');
  lines.push('## Totals');
  lines.push(`- This week: ${t(w.totals)}`);
  lines.push(`- Last week: ${t(w.previous_totals)}`);
  lines.push(`- Change: clicks ${signed(w.change.clicks)}${pct(w.change.clicks_pct)}, impressions ${signed(w.change.impressions)}${pct(w.change.impressions_pct)}, position ${signed(w.change.position)} (negative is better)`);
  const block = (title, list, fmt) => {
    lines.push('');
    lines.push(`## ${title}`);
    if (!list.length) lines.push('- none');
    for (const x of list) lines.push(`- ${fmt(x)}`);
  };
  block('Pages gaining clicks', w.top_gainers, (x) => `${x.page}: ${signed(x.change)} (${x.previous_clicks} to ${x.clicks})`);
  block('Pages losing clicks', w.top_losers, (x) => `${x.page}: ${signed(x.change)} (${x.previous_clicks} to ${x.clicks})`);
  block('New queries', w.new_queries, (x) => `${x.query}: ${x.clicks} clicks, position ${x.position}`);
  block('Lost queries', w.lost_queries, (x) => `${x.query}: had ${x.clicks} clicks last week, none this week`);
  block('Top recommendations', w.recommendations, (x) => `#${x.rank} [${x.type}, ~${x.estimated_clicks} clicks, ${x.confidence} confidence] ${x.action}`);
  lines.push('');
  const notes = [...(w.notes || [])];
  lines.push(`_${notes.join(' ')}_`);
  return lines.join('\n');
}
