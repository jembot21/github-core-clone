// The forge's composition root: one HTTP server that routes every surface —
// REST v3, GraphQL, MCP and git smart HTTP — over one shared store. main.ts owns
// the trial lifecycle (bind, register, wait for done); this file is the server it
// runs. The starter shipped this file with two routes; the surfaces live in lib/.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { sendError } from './lib/http.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/**
 * Whether this request carries the trial's bearer token. The token is the
 * process's MAKEFUN_SHOP_TOKEN; when none is configured (a developer running
 * the server by hand) every request is the viewer's.
 */
function authorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = createStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice, with no token: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":true}\n');
        return;
      }

      // Every other surface speaks for the token's owner only.
      if (!authorized(req, token)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendError(res, 404, 'Not Found');
        return;
      }

      if (await handleRest(store, req, res, url)) return;

      // Everything else, every method: GitHub's 404 body, as JSON, never HTML.
      sendError(res, 404, 'Not Found');
    })().catch(() => {
      // A handler fault must never take the server down mid-trial.
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
}
