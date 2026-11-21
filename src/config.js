import fs from 'node:fs';

const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * All configuration comes from environment variables (nothing is read from the command line except
 * --http), so credentials never appear in a process list or in an MCP client's tool arguments.
 *
 * Credentials (one of):
 *   GSC_SERVICE_ACCOUNT_FILE  path to a service-account JSON key (or GOOGLE_APPLICATION_CREDENTIALS).
 *                             Add the service account's email as a user on each Search Console property.
 *   GSC_OAUTH_FILE            path to JSON {"client_id","client_secret","refresh_token"}
 *   or GSC_OAUTH_CLIENT_ID + GSC_OAUTH_CLIENT_SECRET + GSC_OAUTH_REFRESH_TOKEN
 */
export function loadConfig(env = process.env) {
  const allowWrite = bool(env.GSC_ALLOW_WRITE);
  const cfg = {
    allowWrite,
    scope: allowWrite
      ? 'https://www.googleapis.com/auth/webmasters'
      : 'https://www.googleapis.com/auth/webmasters.readonly',
    defaultSite: env.GSC_DEFAULT_SITE || null,
    apiBase: (env.GSC_API_BASE || 'https://www.googleapis.com/webmasters/v3').replace(/\/$/, ''),
    inspectBase: (env.GSC_INSPECT_BASE || 'https://searchconsole.googleapis.com/v1').replace(/\/$/, ''),
    tokenUrl: env.GSC_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    http: {
      host: env.GSC_MCP_HOST || '127.0.0.1',
      port: Number(env.GSC_MCP_PORT || 3333),
      token: env.GSC_MCP_TOKEN || '',
    },
    credentials: null,
  };

  const saFile = env.GSC_SERVICE_ACCOUNT_FILE || env.GOOGLE_APPLICATION_CREDENTIALS;
  const oauthFile = env.GSC_OAUTH_FILE;
  if (saFile) {
    const key = readJson(saFile, 'GSC_SERVICE_ACCOUNT_FILE');
    if (!key.client_email || !key.private_key) {
      throw new Error('GSC_SERVICE_ACCOUNT_FILE is not a service-account key (client_email / private_key missing)');
    }
    cfg.credentials = {
      type: 'service_account',
      clientEmail: key.client_email,
      privateKey: key.private_key,
      tokenUri: env.GSC_TOKEN_URL || key.token_uri || cfg.tokenUrl,
    };
  } else if (oauthFile || env.GSC_OAUTH_REFRESH_TOKEN) {
    const o = oauthFile
      ? readJson(oauthFile, 'GSC_OAUTH_FILE')
      : {
          client_id: env.GSC_OAUTH_CLIENT_ID,
          client_secret: env.GSC_OAUTH_CLIENT_SECRET,
          refresh_token: env.GSC_OAUTH_REFRESH_TOKEN,
        };
    if (!o.client_id || !o.client_secret || !o.refresh_token) {
      throw new Error('OAuth credentials need client_id, client_secret and refresh_token');
    }
    cfg.credentials = {
      type: 'oauth',
      clientId: o.client_id,
      clientSecret: o.client_secret,
      refreshToken: o.refresh_token,
      tokenUri: cfg.tokenUrl,
    };
  }
  return cfg;
}

function readJson(file, name) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`${name}: cannot read ${file} (${e.code || 'error'})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name}: ${file} is not valid JSON`);
  }
}
