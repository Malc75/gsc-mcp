# gsc-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server for **Google Search Console**. It gives an AI agent
(Claude Code, Hermes, or any MCP client) your search performance data, URL inspection, sitemaps and ready-made
SEO reports, using **your own Google credentials**. Nothing goes through a third party.

It is modelled on the Search Console side of [GSC Magic](https://gscmagic.com): the same tool names where they
overlap (`gsc_query_analytics`, `gsc_list_sites`, `report_quick_wins`, ...), so prompts written for one work with
the other. It does **not** cover Bing Webmaster Tools, GA4, IndexNow or Core Web Vitals.

- **Read-only by default.** The write tools only exist when you set `GSC_ALLOW_WRITE=true`.
- **Finished numbers, not raw dumps.** The `report_*` tools do the comparison here and return a short result.
- **Honest limits.** Results flag truncation; reports say when data may be incomplete.

## Tools

| Tool | What it does |
|---|---|
| `gsc_list_sites` | Every property the account can access, with permission level. Use these exact names elsewhere. |
| `gsc_get_site` | One property and your permission on it. |
| `gsc_query_analytics` | Clicks / impressions / CTR / position by query, page, country, device, date or searchAppearance, with filters, search type and row limit (max 25,000). |
| `gsc_list_sitemaps`, `gsc_get_sitemap` | Submitted sitemaps with errors, warnings, submitted vs indexed counts. |
| `gsc_inspect_url` | URL Inspection: indexed?, coverage state, canonicals, last crawl, robots, mobile usability. |
| `gsc_inspect_urls_batch` | Up to 100 URLs, throttled, compact status per URL; stops cleanly if Google rate-limits. |
| `report_quick_wins` | Query + page pairs at positions 4-20 with many impressions, ranked by estimated extra clicks. |
| `report_traffic_drops` | Biggest click losers and gainers vs the previous equal period, by page or query. |
| `report_content_decay` | Pages whose clicks fell in each of the last three windows (a steady slide, not a dip). |
| `report_cannibalization` | Queries where two or more of your pages share the impressions. |
| `report_ctr_outliers` | Pages with a CTR under half the median at the same position: title / description candidates. |
| `report_brand_split` | Branded vs non-branded clicks, impressions and share, with top queries. |
| `gsc_compare_periods` | Compare **any two date ranges**: totals for both with differences, plus the biggest page or query losers and gainers. |
| `report_seo_recommendations` | Runs quick wins, CTR outliers, drops, decay and cannibalization together and returns **one ranked list** with a suggested action, confidence and evidence per item. |
| `report_weekly` | Last 7 days vs the 7 before: totals, movers, new and lost queries, top recommendations, plus a ready-to-send Markdown `report`. Made for scheduling. |
| `gsc_auth_status` | How the server authenticates and whether write is on (no Google call). |
| `gsc_submit_sitemap`, `gsc_delete_sitemap`, `gsc_add_site`, `gsc_delete_site` | **Write**, only with `GSC_ALLOW_WRITE=true`. |

Every tool declares `readOnlyHint` / `destructiveHint` so clients can show what is safe.

## Set up Google access

You need a Google Cloud project with the **Search Console API** enabled, then one of:

### A. Service account (recommended)
1. Google Cloud console, **IAM & Admin, Service accounts**: create one, then **Keys, Add key, JSON**. Save the file somewhere private (for example `~/.config/gsc-mcp/service-account.json`, `chmod 600`).
2. In Search Console, **Settings, Users and permissions, Add user**: add the service account's email (`...@....iam.gserviceaccount.com`). *Restricted* is enough for read-only; use *Full* if you will enable write tools.
3. Set `GSC_SERVICE_ACCOUNT_FILE` to the file path.

### B. OAuth (acts as you)
Create an OAuth client (type *Desktop app*), obtain a refresh token for the scope
`https://www.googleapis.com/auth/webmasters.readonly` (or `.../webmasters` for write), and either put
`{"client_id","client_secret","refresh_token"}` in a file and set `GSC_OAUTH_FILE`, or set
`GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET` / `GSC_OAUTH_REFRESH_TOKEN`.

Credentials are read from files or environment variables only. They are never logged, never part of a tool
argument, and error messages carry Google's error code, never secrets.

## Install

Requires Node 22+.

```bash
git clone https://github.com/Malc75/gsc-mcp.git
cd gsc-mcp
npm install
npm test        # 31 tests against a mock Google API; no credentials needed
```

## Use with Claude Code

```bash
claude mcp add gsc --scope user \
  --env GSC_SERVICE_ACCOUNT_FILE=/home/you/.config/gsc-mcp/service-account.json \
  -- node /path/to/gsc-mcp/src/index.js
```

Then `/mcp` should list `gsc`. Try: *"List my Search Console sites"*, then *"Show quick wins for https://example.com/"*.
To allow write tools add `--env GSC_ALLOW_WRITE=true`.

## Use with Hermes

```bash
hermes mcp add gsc --command node \
  --env GSC_SERVICE_ACCOUNT_FILE=/home/you/.config/gsc-mcp/service-account.json \
  --args /path/to/gsc-mcp/src/index.js
hermes mcp test gsc
```

(`--args` must be the last option.) Hermes prefixes the tools, e.g. `mcp_gsc_gsc_list_sites`. Use
`hermes mcp configure gsc` to hide tools you do not want the agent to see.

## Weekly reports on a schedule

The server does not run anything by itself; your agent calls `report_weekly` on a schedule. With Hermes:

```bash
hermes cron create "0 8 * * 1" \
  "Call the gsc report_weekly tool for site https://example.com/ and send me the 'report' text it returns, unchanged. If the call fails, say what error it returned." \
  --name "Weekly Search Console report" --deliver telegram
```

That is a Monday 08:00 summary of the week that ended two days earlier. "Monitoring" here means a weekly
comparison, not live alerts. Any scheduler that can call an MCP tool works the same way.

## How the recommendations are ranked

`report_seo_recommendations` and `report_weekly` order findings by `priority_score = estimated clicks x weight`:
quick win 1.0, CTR outlier 0.8, traffic drop 0.5, content decay 0.5, cannibalization 0.25. The weights are judgement
calls that reflect how reliable each kind of estimate is, and every result states its `method` and, per item, its
`estimate_basis` and `confidence`. Treat them as a way to choose what to work on first, not as forecasts. The
agent still decides what to do; the tool supplies ranked evidence.

## HTTP mode (optional)

For a client that connects to a URL rather than launching a command:

```bash
GSC_MCP_TOKEN=$(openssl rand -hex 32) GSC_SERVICE_ACCOUNT_FILE=... node src/index.js --http
# Streamable HTTP at http://127.0.0.1:3333/mcp, header: Authorization: Bearer <token>
```

It binds to `127.0.0.1` by default and **refuses to start without `GSC_MCP_TOKEN`** (16+ characters). The
transport is stateless. If you expose it beyond localhost, put TLS in front of it.

## Things worth knowing

- **Data lags about 2 days**, so periods end two days ago by default. `data_state: "all"` includes fresher,
  still-changing numbers.
- **Google hides rare queries** for privacy. Query totals will be lower than page totals, and brand-split shares
  cover only clicks with a known query.
- **Property names must match exactly**: `https://example.com/` (with trailing slash) for URL-prefix
  properties, `sc-domain:example.com` for domain properties. `gsc_list_sites` shows them.
- **URL Inspection quota** is about 2,000 per day per property (600 per minute).
- **Reports read up to 50,000 rows**; if a site has more, the result says `data_may_be_incomplete`.
- **Quick-wins estimates** assume about 10% CTR at position 3. They are a ranking aid, not a forecast.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403` | The service account (or Google account) is not a user on that property, or the Search Console API is not enabled in the Google Cloud project. |
| `404` | The property name is not exactly as `gsc_list_sites` shows it. |
| `Google token request failed (400 invalid_grant)` | Wrong or revoked refresh token, or a service-account key that was deleted. |
| `No Google credentials configured` | Neither `GSC_SERVICE_ACCOUNT_FILE` nor the OAuth variables reached the server. Check your client's `env` block. |

## Development

```bash
npm test      # unit tests for the report maths (11) + end-to-end tests (20) that run the real server over stdio
              # (and HTTP) with a real MCP client against a mock Google API
```

The end-to-end tests also verify that the service-account JWT is correctly signed and that the read-only
scope is requested unless write is enabled. They have not been run against the real Google API.

## Licence

MIT
