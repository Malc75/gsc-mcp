const DAY = 86_400_000;

export const fmt = (d) => d.toISOString().slice(0, 10);

/** Search Console data lags ~2 days, so "today" for analysis purposes is two days ago. */
export function defaultEnd(now = new Date()) {
  return fmt(new Date(now.getTime() - 2 * DAY));
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function shift(dateStr, days) {
  return fmt(new Date(Date.parse(dateStr) + days * DAY));
}

/** Range of `days` ending at `end`, optionally moved back by `back` whole windows. */
export function window(days, end, back = 0) {
  const e = shift(end, -back * days);
  return { start: shift(e, -(days - 1)), end: e };
}
