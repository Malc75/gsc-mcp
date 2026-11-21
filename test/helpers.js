import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function makeKeyFile(base) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-mcp-test-'));
  const file = path.join(dir, 'sa.json');
  fs.writeFileSync(file, JSON.stringify({ type: 'service_account', client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${base}/token` }));
  return { file, publicKey, dir };
}

export function googleEnv(base, extra = {}) {
  return {
    PATH: process.env.PATH,
    GSC_API_BASE: `${base}/webmasters/v3`,
    GSC_INSPECT_BASE: `${base}/v1`,
    GSC_TOKEN_URL: `${base}/token`,
    ...extra,
  };
}

/** Launch the real server over stdio and connect a real MCP client to it. */
export async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/index.js'], env, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* error text */ }
    return { isError: Boolean(r.isError), text, data };
  };
  return { client, call, close: () => client.close() };
}
