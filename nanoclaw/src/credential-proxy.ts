/**
 * Copilot auth proxy for container isolation.
 * Containers connect here instead of directly to the Copilot API.
 * The proxy injects real credentials so containers never see them.
 *
 * How it works:
 *   Container sends BYOK requests to http://host:3001/v1/chat/completions
 *   Proxy injects Authorization: Bearer <GITHUB_TOKEN> header
 *   Proxy forwards verbatim to https://api.githubcopilot.com/chat/completions
 *   No request/response body transformation needed.
 *
 * See INVESTIGATION-AUTH.md and docs/decisions/002-auth-byok-proxy.md
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const COPILOT_HEADERS = {
  'copilot-integration-id': 'copilot-chat',
};

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile(['GITHUB_TOKEN', 'COPILOT_API_URL']);

  const githubToken = secrets.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error(
      'GITHUB_TOKEN not found in .env. ' +
        'Create a fine-grained PAT (zero permissions needed) for an account with Copilot access.',
    );
  }

  const upstreamUrl = new URL(
    secrets.COPILOT_API_URL || 'https://api.githubcopilot.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Strip the /v1 prefix that BYOK mode sends
        const upstreamPath = (req.url || '/').replace(/^\/v1/, '') || '/';

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
            authorization: `Bearer ${githubToken}`,
            ...COPILOT_HEADERS,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, upstream: upstreamUrl.host }, 'Copilot auth proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
