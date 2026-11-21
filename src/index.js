#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { createServer, VERSION } from './server.js';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`gsc-mcp ${VERSION} - Google Search Console MCP server

Usage:
  gsc-mcp           stdio transport (Claude Code, Hermes, any MCP client that launches a command)
  gsc-mcp --http    Streamable HTTP on GSC_MCP_HOST:GSC_MCP_PORT (default 127.0.0.1:3333) at /mcp,
                    requires GSC_MCP_TOKEN (sent as "Authorization: Bearer <token>")

Configuration is by environment variables only; see the README.`);
  process.exit(0);
}

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`gsc-mcp: ${e.message}`);
  process.exit(1);
}

if (args.includes('--http')) {
  await startHttp(config);
} else {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol, so diagnostics go to stderr.
  console.error(`gsc-mcp ${VERSION} ready (stdio, credentials: ${config.credentials?.type || 'none'}, write tools: ${config.allowWrite})`);
}

async function startHttp(cfg) {
  const { host, port, token } = cfg.http;
  if (!token || token.length < 16) {
    console.error('gsc-mcp: --http needs GSC_MCP_TOKEN (at least 16 characters) so the endpoint is not open to anyone who can reach it');
    process.exit(1);
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const authorised = (req) => {
    const got = Buffer.from(req.headers.authorization || '');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };

  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      // Stateless: a fresh server + transport per request, nothing held between calls.
      const server = createServer(cfg);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Bad request' }));
    }
  });
  srv.listen(port, host, () => console.error(`gsc-mcp ${VERSION} listening on http://${host}:${port}/mcp (credentials: ${cfg.credentials?.type || 'none'}, write tools: ${cfg.allowWrite})`));
}
