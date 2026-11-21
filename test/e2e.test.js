import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startMockGoogle } from './mock-google.js';
import { makeKeyFile, googleEnv, connect } from './helpers.js';

const DAY = 86_400_000;
const iso = (offset) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);

async function withServer(opts, fn) {
  const key = makeKeyFile();
  const google = await startMockGoogle({ publicKey: key.publicKey, queryHandler: opts.queryHandler });
  const env = googleEnv(google.base, { GSC_SERVICE_ACCOUNT_FILE: key.file, ...opts.env });
  const c = await connect(env);
  try {
    await fn({ ...c, google, key });
  } finally {
    await c.close();
    await google.close();
    fs.rmSync(key.dir, { recursive: true, force: true });
  }
}

test('read-only by default: lists read tools only, all with safety annotations', async () => {
  await withServer({}, async ({ client }) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['gsc_list_sites', 'gsc_query_analytics', 'gsc_inspect_url', 'report_quick_wins', 'report_brand_split', 'gsc_auth_status']) assert.ok(names.includes(n), n);
    for (const w of ['gsc_submit_sitemap', 'gsc_delete_sitemap', 'gsc_add_site', 'gsc_delete_site']) assert.ok(!names.includes(w), `${w} must not be offered`);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'every tool is read-only');
  });
});

test('service-account auth: signed JWT with the read-only scope, token reused across calls', async () => {
  await withServer({}, async ({ call, google }) => {
    const r1 = await call('gsc_list_sites');
    await call('gsc_list_sites');
    assert.equal(r1.data.count, 2);
    assert.deepEqual(r1.data.sites[0], { site: 'https://example.com/', permission: 'siteOwner' });
    const tokenCalls = google.log.filter((l) => l.path === '/token');
    assert.equal(tokenCalls.length, 1, 'token fetched once and cached');
    assert.equal(tokenCalls[0].claims.iss, 'bot@proj.iam.gserviceaccount.com');
    assert.equal(tokenCalls[0].claims.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
  });
});

test('property names with special characters are URL-encoded; a 404 explains the fix', async () => {
  await withServer({}, async ({ call, google }) => {
    const ok = await call('gsc_get_site', { site: 'sc-domain:example.org' });
    assert.deepEqual(ok.data, { site: 'sc-domain:example.org', permission: 'siteFullUser' });
    assert.ok(google.log.some((l) => l.path.includes('sc-domain%3Aexample.org')));
    const bad = await call('gsc_get_site', { site: 'https://nope.example/' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /404 notFound/);
    assert.ok(google.log.some((l) => l.path.includes('https%3A%2F%2Fnope.example%2F')), 'trailing slash and scheme are percent-encoded');
    assert.match(bad.text, /gsc_list_sites/);
  });
});

test('gsc_query_analytics: builds the request, shapes rows, flags truncation', async () => {
  let seen;
  const queryHandler = (body) => { seen = body; return [{ keys: ['widgets', '/w'], clicks: 12, impressions: 340, ctr: 0.035294, position: 7.456 }, { keys: ['gadgets', '/g'], clicks: 3, impressions: 90, ctr: 0.0333, position: 12.04 }]; };
  await withServer({ queryHandler }, async ({ call }) => {
    const r = await call('gsc_query_analytics', { site: 'https://example.com/', days: 7, dimensions: ['query', 'page'], filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }], row_limit: 2 });
    assert.equal(seen.endDate, iso(2));
    assert.equal(seen.startDate, iso(8));
    assert.deepEqual(seen.dimensions, ['query', 'page']);
    assert.deepEqual(seen.dimensionFilterGroups, [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }] }]);
    assert.equal(seen.rowLimit, 2);
    assert.equal(seen.dataState, 'final');
    assert.deepEqual(r.data.rows[0], { query: 'widgets', page: '/w', clicks: 12, impressions: 340, ctr: 0.0353, position: 7.5 });
    assert.equal(r.data.truncated, true, 'row_limit reached means more rows may exist');
    assert.equal((await call('gsc_query_analytics', { site: 'https://example.com/', row_limit: 100 })).data.truncated, false);
  });
});

test('invalid dates are rejected before calling Google', async () => {
  await withServer({}, async ({ call, google }) => {
    const r = await call('gsc_query_analytics', { site: 'https://example.com/', end_date: '2026-13-45x' });
    assert.equal(r.isError, true);
    assert.match(r.text, /YYYY-MM-DD/);
    assert.equal(google.log.filter((l) => l.path.includes('searchAnalytics')).length, 0);
  });
});

test('sitemaps and URL inspection are shaped compactly', async () => {
  await withServer({}, async ({ call }) => {
    const sm = await call('gsc_list_sitemaps', { site: 'https://example.com/' });
    assert.deepEqual(sm.data.sitemaps[0].contents, [{ type: 'web', submitted: 120, indexed: 100 }]);
    assert.equal(sm.data.sitemaps[0].warnings, 2);
    const ins = await call('gsc_inspect_url', { site: 'https://example.com/', url: 'https://example.com/page' });
    assert.equal(ins.data.verdict, 'PASS');
    assert.equal(ins.data.coverage_state, 'Submitted and indexed');
    assert.equal(ins.data.mobile_usability, 'PASS');
  });
});

test('batch inspection summarises coverage and stops cleanly when rate limited', async () => {
  await withServer({ env: { GSC_INSPECT_DELAY_MS: '0' } }, async ({ call }) => {
    const r = await call('gsc_inspect_urls_batch', { site: 'https://example.com/', urls: ['https://example.com/a', 'https://example.com/noindex', 'https://example.com/ratelimited', 'https://example.com/never-reached'] });
    assert.equal(r.data.inspected, 2);
    assert.match(r.data.stopped_early, /Rate limited/);
    assert.deepEqual(r.data.summary, { 'Submitted and indexed': 1, 'Excluded by noindex tag': 1 });
  });
});

test('reports run end to end against the API data', async () => {
  const end = iso(2);
  const inWindow = (body, backWindows, days = 28) => body.endDate === new Date(Date.parse(end) - backWindows * days * DAY).toISOString().slice(0, 10);
  const queryHandler = (body) => {
    const dims = body.dimensions.join(',');
    if (dims === 'query,page') return [{ keys: ['blue widgets', '/blue'], clicks: 10, impressions: 1000, ctr: 0.01, position: 8 }, { keys: ['blue widgets', '/blog/blue'], clicks: 5, impressions: 600, ctr: 0.008, position: 9 }];
    if (dims === 'query') return [{ keys: ['acme shop'], clicks: 70, impressions: 200, ctr: 0.35, position: 1.2 }, { keys: ['blue widgets'], clicks: 30, impressions: 2000, ctr: 0.015, position: 8 }];
    if (dims === 'page') {
      if (inWindow(body, 0)) return [{ keys: ['/slide'], clicks: 30, impressions: 900, ctr: 0.03, position: 5 }, { keys: ['/up'], clicks: 90, impressions: 900, ctr: 0.1, position: 3 }];
      if (inWindow(body, 1)) return [{ keys: ['/slide'], clicks: 60, impressions: 900, ctr: 0.06, position: 4 }, { keys: ['/up'], clicks: 50, impressions: 900, ctr: 0.05, position: 4 }];
      return [{ keys: ['/slide'], clicks: 100, impressions: 900, ctr: 0.1, position: 3 }];
    }
    return [];
  };
  await withServer({ queryHandler }, async ({ call }) => {
    const qw = await call('report_quick_wins', { site: 'https://example.com/' });
    assert.equal(qw.data.quick_wins[0].query, 'blue widgets');
    assert.equal(qw.data.quick_wins[0].potential_extra_clicks, 90); // 1000*0.1 - 10
    const cn = await call('report_cannibalization', { site: 'https://example.com/' });
    assert.equal(cn.data.cannibalized_queries[0].pages.length, 2);
    const bs = await call('report_brand_split', { site: 'https://example.com/', brand_terms: ['acme'] });
    assert.equal(bs.data.branded.clicks, 70);
    assert.equal(bs.data.non_branded.click_share, 0.3);
    const td = await call('report_traffic_drops', { site: 'https://example.com/', min_clicks: 10 });
    assert.equal(td.data.losers[0].page, '/slide');
    assert.equal(td.data.gainers[0].page, '/up');
    const cd = await call('report_content_decay', { site: 'https://example.com/', min_clicks: 20 });
    assert.deepEqual(cd.data.decaying_pages.map((p) => [p.page, p.clicks_oldest, p.clicks_middle, p.clicks_latest]), [['/slide', 100, 60, 30]]);
  });
});

test('write tools: absent by default, present with GSC_ALLOW_WRITE=true and the write scope', async () => {
  await withServer({ env: { GSC_ALLOW_WRITE: 'true' } }, async ({ client, call, google }) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const w of ['gsc_submit_sitemap', 'gsc_delete_sitemap', 'gsc_add_site', 'gsc_delete_site']) assert.ok(names.includes(w), w);
    const st = await call('gsc_auth_status');
    assert.equal(st.data.write_tools_enabled, true);
    const sub = await call('gsc_submit_sitemap', { site: 'https://example.com/', feedpath: 'https://example.com/new-sitemap.xml' });
    assert.deepEqual(sub.data, { submitted: 'https://example.com/new-sitemap.xml' });
    const put = google.log.find((l) => l.method === 'PUT' && l.path.includes('/sitemaps/'));
    assert.ok(put.path.includes('new-sitemap.xml'));
    assert.equal(google.log.find((l) => l.path === '/token').claims.scope, 'https://www.googleapis.com/auth/webmasters');
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((t) => t.name === 'gsc_delete_site').annotations.destructiveHint, true);
  });
});

test('OAuth refresh-token auth works, and a bad token reports Google\'s error code only', async () => {
  const google = await startMockGoogle({});
  try {
    const good = await connect(googleEnv(google.base, { GSC_OAUTH_CLIENT_ID: 'cid', GSC_OAUTH_CLIENT_SECRET: 'csecret', GSC_OAUTH_REFRESH_TOKEN: 'good-refresh' }));
    assert.equal((await good.call('gsc_list_sites')).data.count, 2);
    assert.equal((await good.call('gsc_auth_status')).data.credentials, 'oauth');
    await good.close();
    const bad = await connect(googleEnv(google.base, { GSC_OAUTH_CLIENT_ID: 'cid', GSC_OAUTH_CLIENT_SECRET: 'csecret', GSC_OAUTH_REFRESH_TOKEN: 'revoked-token' }));
    const r = await bad.call('gsc_list_sites');
    assert.equal(r.isError, true);
    assert.match(r.text, /Google token request failed \(400 invalid_grant\)/);
    assert.ok(!r.text.includes('csecret') && !r.text.includes('revoked-token'), 'no secrets in errors');
    await bad.close();
  } finally {
    await google.close();
  }
});

test('with no credentials the tools say how to configure them', async () => {
  const c = await connect({ PATH: process.env.PATH });
  try {
    const r = await c.call('gsc_list_sites');
    assert.equal(r.isError, true);
    assert.match(r.text, /GSC_SERVICE_ACCOUNT_FILE/);
    assert.equal((await c.call('gsc_auth_status')).data.credentials, 'none');
  } finally {
    await c.close();
  }
});

test('a bad credentials file stops the server at startup with a clear message', async () => {
  const p = spawn(process.execPath, ['src/index.js'], { env: { PATH: process.env.PATH, GSC_SERVICE_ACCOUNT_FILE: '/definitely/not/here.json' } });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 1);
  assert.match(err, /GSC_SERVICE_ACCOUNT_FILE: cannot read/);
});

test('HTTP mode: refuses to start without a token; 401 without it; works with it', async () => {
  const noToken = spawn(process.execPath, ['src/index.js', '--http'], { env: { PATH: process.env.PATH } });
  let err = '';
  noToken.stderr.on('data', (d) => (err += d));
  assert.equal(await new Promise((r) => noToken.on('close', r)), 1);
  assert.match(err, /GSC_MCP_TOKEN/);

  const key = makeKeyFile();
  const google = await startMockGoogle({ publicKey: key.publicKey });
  const port = 39000 + Math.floor(Math.random() * 500);
  const token = 'a-long-test-token-1234567890';
  const srv = spawn(process.execPath, ['src/index.js', '--http'], { env: googleEnv(google.base, { GSC_SERVICE_ACCOUNT_FILE: key.file, GSC_MCP_PORT: String(port), GSC_MCP_TOKEN: token }) });
  await new Promise((resolve, reject) => { srv.stderr.on('data', (d) => /listening/.test(String(d)) && resolve()); srv.on('close', () => reject(new Error('server exited'))); setTimeout(() => reject(new Error('timeout')), 10000); });
  const post = (headers, body) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.end(JSON.stringify(body));
  });
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.equal((await post({}, init)).status, 401);
    assert.equal((await post({ Authorization: 'Bearer wrong' }, init)).status, 401);
    const ok = await post({ Authorization: `Bearer ${token}` }, init);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /gsc_list_sites/);
    const call = await post({ Authorization: `Bearer ${token}` }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gsc_list_sites', arguments: {} } });
    assert.match(call.body, /example\.com/);
  } finally {
    srv.kill();
    await google.close();
    fs.rmSync(key.dir, { recursive: true, force: true });
  }
});
