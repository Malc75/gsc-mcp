import http from 'node:http';
import crypto from 'node:crypto';

/** A tiny fake of Google's token endpoint, Search Console API and URL Inspection API. */
export async function startMockGoogle({ publicKey, queryHandler } = {}) {
  const log = [];
  const state = { tokenCalls: 0, sitemaps: new Set(['https://example.com/sitemap.xml']), sites: [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:example.org', permissionLevel: 'siteFullUser' }] };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const entry = { method: req.method, path: url.pathname, auth: req.headers.authorization, body: raw };
    log.push(entry);

    if (url.pathname === '/token') {
      state.tokenCalls++;
      const form = new URLSearchParams(raw);
      entry.form = Object.fromEntries(form);
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const [h, c, s] = form.get('assertion').split('.');
        const okSig = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
        entry.claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        if (!okSig) return json(400, { error: 'invalid_grant' });
      } else if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== 'good-refresh') return json(400, { error: 'invalid_grant' });
      } else return json(400, { error: 'unsupported_grant_type' });
      return json(200, { access_token: `tok-${state.tokenCalls}`, expires_in: 3600 });
    }

    if (!/^Bearer tok-\d+$/.test(req.headers.authorization || '')) return json(401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });

    const p = url.pathname; // keep percent-encoding: site URLs contain '/' and ':'
    const dec = decodeURIComponent;
    let m;
    if (req.method === 'GET' && p === '/webmasters/v3/sites') return json(200, { siteEntry: state.sites });
    if ((m = p.match(/^\/webmasters\/v3\/sites\/([^/]+)$/))) {
      const site = state.sites.find((s) => s.siteUrl === dec(m[1]));
      if (req.method === 'GET') return site ? json(200, site) : json(404, { error: { code: 404, message: 'Site not found', errors: [{ reason: 'notFound' }] } });
      if (req.method === 'PUT') { state.sites.push({ siteUrl: dec(m[1]), permissionLevel: 'siteUnverifiedUser' }); return res.writeHead(204).end(); }
      if (req.method === 'DELETE') return res.writeHead(204).end();
    }
    if ((m = p.match(/^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/)) && req.method === 'POST') {
      const body = JSON.parse(raw);
      const rows = queryHandler ? queryHandler(body, dec(m[1])) : [];
      const page = rows.slice(body.startRow || 0, (body.startRow || 0) + (body.rowLimit || 1000));
      return json(200, { rows: page, responseAggregationType: 'auto' });
    }
    if ((m = p.match(/^\/webmasters\/v3\/sites\/([^/]+)\/sitemaps$/)) && req.method === 'GET')
      return json(200, { sitemap: [...state.sitemaps].map((path) => ({ path, lastSubmitted: '2026-10-01T00:00:00Z', isPending: false, isSitemapsIndex: false, errors: '0', warnings: '2', contents: [{ type: 'web', submitted: '120', indexed: '100' }] })) });
    if ((m = p.match(/^\/webmasters\/v3\/sites\/([^/]+)\/sitemaps\/([^/]+)$/))) {
      if (req.method === 'PUT') { state.sitemaps.add(dec(m[2])); return res.writeHead(204).end(); }
      if (req.method === 'DELETE') { state.sitemaps.delete(dec(m[2])); return res.writeHead(204).end(); }
      if (req.method === 'GET') return state.sitemaps.has(dec(m[2])) ? json(200, { path: dec(m[2]), errors: '1', warnings: '0', contents: [] }) : json(404, { error: { code: 404, message: 'not found' } });
    }
    if (p === '/v1/urlInspection/index:inspect' && req.method === 'POST') {
      const b = JSON.parse(raw);
      if (b.inspectionUrl.includes('ratelimited')) return json(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
      return json(200, { inspectionResult: { inspectionResultLink: 'https://search.google.com/x', indexStatusResult: { verdict: b.inspectionUrl.includes('noindex') ? 'NEUTRAL' : 'PASS', coverageState: b.inspectionUrl.includes('noindex') ? 'Excluded by noindex tag' : 'Submitted and indexed', lastCrawlTime: '2026-10-20T10:00:00Z', googleCanonical: b.inspectionUrl }, mobileUsabilityResult: { verdict: 'PASS' } } });
    }
    return json(404, { error: { code: 404, message: `no route ${req.method} ${p}` } });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { base: `http://127.0.0.1:${port}`, log, state, close: () => new Promise((r) => server.close(r)) };
}
