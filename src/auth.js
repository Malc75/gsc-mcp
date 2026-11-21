import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

/**
 * Obtains and caches Google access tokens. Supports a service-account key (signed JWT) or an OAuth
 * refresh token. Error messages carry Google's error code only, never request bodies or secrets.
 */
export class TokenProvider {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.cached = null; // { token, expiresAt }
    this.inflight = null;
  }

  get mode() {
    return this.config.credentials?.type || 'none';
  }

  async getToken() {
    if (!this.config.credentials) {
      throw new Error(
        'No Google credentials configured. Set GSC_SERVICE_ACCOUNT_FILE (service-account key) or GSC_OAUTH_FILE / GSC_OAUTH_REFRESH_TOKEN. See the README.'
      );
    }
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate() {
    this.cached = null;
  }

  async refresh() {
    const c = this.config.credentials;
    let body;
    if (c.type === 'service_account') {
      const iat = Math.floor(Date.now() / 1000);
      const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claims = b64u(
        JSON.stringify({ iss: c.clientEmail, scope: this.config.scope, aud: c.tokenUri, iat, exp: iat + 3600 })
      );
      const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(c.privateKey).toString('base64url');
      body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      });
    } else {
      body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
      });
    }
    const res = await this.fetch(c.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`Google token request failed (${res.status} ${json.error || 'unknown'})`);
    }
    this.cached = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
    return this.cached.token;
  }
}
