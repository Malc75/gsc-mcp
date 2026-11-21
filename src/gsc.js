const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GscError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const HINTS = {
  401: 'The access token was rejected. Check the credentials.',
  403: 'Access denied. The Google account (or service account email) must be added as a user on this Search Console property, and the Search Console API must be enabled in the Google Cloud project.',
  404: 'Not found. Property URLs must match exactly: "https://example.com/" for a URL-prefix property (with trailing slash) or "sc-domain:example.com" for a domain property. Use gsc_list_sites for the exact names.',
  429: 'Rate limited by Google. Wait and retry, or reduce the request size.',
};

/** Thin client over the Search Console and URL Inspection REST APIs. */
export class GscClient {
  constructor(config, tokens, fetchImpl = fetch) {
    this.config = config;
    this.tokens = tokens;
    this.fetch = fetchImpl;
  }

  async request(method, url, body, { retries = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getToken();
      const res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate(); // expired/revoked token: fetch a fresh one once
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await sleep(Math.min(Number(res.headers.get('retry-after')) || 1, 5) * 1000);
        continue;
      }
      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (!res.ok) {
        const g = json?.error || {};
        const reason = g.errors?.[0]?.reason || g.status || String(res.status);
        throw new GscError(res.status, reason, `Google API error ${res.status} ${reason}: ${g.message || 'request failed'}. ${HINTS[res.status] || ''}`.trim());
      }
      return json ?? {};
    }
  }

  siteUrl(site) {
    return `${this.config.apiBase}/sites/${encodeURIComponent(site)}`;
  }

  listSites() {
    return this.request('GET', `${this.config.apiBase}/sites`).then((r) => r.siteEntry || []);
  }

  getSite(site) {
    return this.request('GET', this.siteUrl(site));
  }

  addSite(site) {
    return this.request('PUT', this.siteUrl(site));
  }

  deleteSite(site) {
    return this.request('DELETE', this.siteUrl(site));
  }

  listSitemaps(site) {
    return this.request('GET', `${this.siteUrl(site)}/sitemaps`).then((r) => r.sitemap || []);
  }

  getSitemap(site, feedpath) {
    return this.request('GET', `${this.siteUrl(site)}/sitemaps/${encodeURIComponent(feedpath)}`);
  }

  submitSitemap(site, feedpath) {
    return this.request('PUT', `${this.siteUrl(site)}/sitemaps/${encodeURIComponent(feedpath)}`);
  }

  deleteSitemap(site, feedpath) {
    return this.request('DELETE', `${this.siteUrl(site)}/sitemaps/${encodeURIComponent(feedpath)}`);
  }

  inspectUrl(site, url, languageCode = 'en-GB') {
    return this.request('POST', `${this.config.inspectBase}/urlInspection/index:inspect`, {
      inspectionUrl: url,
      siteUrl: site,
      languageCode,
    });
  }

  queryOnce(site, body) {
    return this.request('POST', `${this.siteUrl(site)}/searchAnalytics/query`, body).then((r) => r.rows || []);
  }

  /**
   * Pages through searchAnalytics/query (25,000 rows per page) up to maxRows.
   * Returns { rows, truncated } where truncated means more rows exist than were returned.
   */
  async queryAll(site, body, maxRows = 50_000) {
    const pageSize = Math.min(25_000, maxRows);
    const rows = [];
    let startRow = body.startRow || 0;
    for (;;) {
      const page = await this.queryOnce(site, { ...body, rowLimit: Math.min(pageSize, maxRows - rows.length), startRow });
      rows.push(...page);
      if (page.length < pageSize || rows.length >= maxRows) {
        return { rows, truncated: rows.length >= maxRows && page.length === pageSize };
      }
      startRow += page.length;
    }
  }
}

/** Turn API rows ({keys:[..], clicks,...}) into {dimension: value, ..., clicks, impressions, ctr, position}. */
export function shapeRows(rows, dimensions) {
  return rows.map((r) => {
    const o = {};
    dimensions.forEach((d, i) => {
      o[d] = r.keys?.[i];
    });
    o.clicks = r.clicks ?? 0;
    o.impressions = r.impressions ?? 0;
    o.ctr = round(r.ctr ?? 0, 4);
    o.position = round(r.position ?? 0, 1);
    return o;
  });
}

export const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
};
