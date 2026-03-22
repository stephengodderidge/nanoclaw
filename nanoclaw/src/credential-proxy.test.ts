import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamPath: string;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    lastUpstreamPath = '';

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (proxyServer?.listening) {
      await new Promise<void>((r) => proxyServer.close(() => r()));
    }
    if (upstreamServer?.listening) {
      await new Promise<void>((r) => upstreamServer.close(() => r()));
    }
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(): Promise<number> {
    Object.assign(mockEnv, {
      GITHUB_TOKEN: 'ghp_test-token-for-proxy',
      COPILOT_API_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('throws if GITHUB_TOKEN is not configured', () => {
    // mockEnv is empty — no GITHUB_TOKEN
    expect(() => startCredentialProxy(0)).toThrow('GITHUB_TOKEN not found');
  });

  it('injects Authorization Bearer header with GitHub token', async () => {
    proxyPort = await startProxy();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer ghp_test-token-for-proxy',
    );
  });

  it('injects Copilot-specific headers', async () => {
    proxyPort = await startProxy();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['copilot-integration-id']).toBe('copilot-chat');
  });

  it('strips /v1 prefix from request path', async () => {
    proxyPort = await startProxy();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(lastUpstreamPath).toBe('/chat/completions');
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('replaces any container-sent Authorization header', async () => {
    proxyPort = await startProxy();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer container-should-not-have-this',
        },
      },
      '{}',
    );

    // Proxy must replace with the real token, not forward the container's
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer ghp_test-token-for-proxy',
    );
  });
});
