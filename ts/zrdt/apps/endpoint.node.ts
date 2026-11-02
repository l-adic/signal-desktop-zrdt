// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The local endpoint (zrdt docs/apps/BUILD_M1.md §B.10; docs/zrdt/
// FORK_MAP.md §6; tools/git-remote-zrdt/ENDPOINT.md §1): HTTP/1.1 with JSON
// bodies, on 127.0.0.1 (a port the desktop picks) and on a Unix socket in
// userData (0600), for the git helper and `zbt`.
//
// - Each app has its own random token in `<userData>/zrdt-apps-<app>.token`
//   (0600): `git` for git-sha256, `bt` for the torrent. A request carries it
//   as `Authorization: Bearer`; the token selects the app, and a client sees
//   only that app's routes (and the routes only that app's channels).
// - `<userData>/zrdt-apps.json` (0600) names the endpoint and the token files,
//   so tools find a demo desktop's endpoint from its userData.
// - A browser can reach loopback (CSRF, DNS rebinding): any `Origin` header,
//   and any `Host` but loopback, is refused before the token is read.
// - No route here exposes pointers, openings, nonces, piece keys or SERVE.
//
// Runs in the main window's preload (FORK_MAP §6.1), where zrdtd and Signal's
// state are; nothing here touches them: apps register routes.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppTag, HttpMethod, Route, RouteResponse } from './api.std.ts';
import { RouteError, matchRoute } from './api.std.ts';
import { APP_GIT, APP_TORRENT } from './appMessage.std.ts';
import { drop } from '../../util/drop.std.ts';

/** The token file's short name per app. */
export const TOKEN_NAMES: Readonly<Record<AppTag, string>> = {
  [APP_GIT]: 'git',
  [APP_TORRENT]: 'bt',
};

/** The largest request body: a 1 MiB piece as base64, with room. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** macOS `sun_path` holds 104 bytes; Linux 108. */
const MAX_SOCKET_PATH = 100;

export type EndpointInfo = Readonly<{
  /** `http://127.0.0.1:<port>`, if the TCP listener is on. */
  url?: string;
  /** `unix:<path>`, if the socket listener is on. */
  socket?: string;
  /** The token file of each app. */
  tokenFiles: Readonly<Record<AppTag, string>>;
  /** `<userData>/zrdt-apps.json`. */
  infoFile: string;
}>;

export type EndpointOptions = Readonly<{
  /** The desktop's userData folder. */
  userData: string;
  /** Listen on 127.0.0.1:port (0 picks one); undefined: no TCP listener. */
  port?: number;
  /** Listen on `<userData>/zrdt-apps.sock` (default true). */
  socket?: boolean;
  log?: Readonly<{
    info: (message: string) => void;
    warn: (message: string) => void;
  }>;
}>;

type Reply = { status: number; body: unknown };

function loopbackHost(host: string | undefined): boolean {
  return (
    host === undefined ||
    host === '' ||
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
  );
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks = new Array<Buffer<ArrayBuffer>>();
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer<ArrayBuffer>;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new RouteError(413, 'too_large', 'the request body is too large');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteError(400, 'bad_request', 'the body is not JSON');
  }
}

function query(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    out[k] = v;
  }
  return out;
}

const METHODS: ReadonlyArray<HttpMethod> = ['GET', 'POST', 'PUT', 'DELETE'];

/** The endpoint: routes per app, a token per app, two listeners. */
export class AppsEndpoint {
  readonly #options: EndpointOptions;
  readonly #routes = new Map<AppTag, Array<Route>>();
  readonly #tokens = new Map<string, AppTag>();
  readonly #servers = new Array<http.Server>();
  #info: EndpointInfo | undefined;

  constructor(options: EndpointOptions) {
    this.#options = options;
  }

  /** Adds `app`'s routes (a later route with the same method and pattern wins). */
  registerRoutes(app: AppTag, routes: ReadonlyArray<Route>): void {
    const list = this.#routes.get(app) ?? [];
    for (const route of routes) {
      const i = list.findIndex(
        r => r.method === route.method && r.pattern === route.pattern
      );
      if (i >= 0) {
        list.splice(i, 1);
      }
      list.push(route);
    }
    this.#routes.set(app, list);
  }

  info(): EndpointInfo | undefined {
    return this.#info;
  }

  /** The app a token belongs to (tests). */
  appOfToken(token: string): AppTag | undefined {
    return this.#tokens.get(token);
  }

  /** Answers one request (exposed for tests that skip the socket). */
  async answer(
    method: string,
    rawUrl: string,
    headers: http.IncomingHttpHeaders,
    body: () => Promise<unknown>
  ): Promise<Reply> {
    if (headers.origin !== undefined) {
      return {
        status: 403,
        body: { error: 'forbidden', message: 'no browser requests' },
      };
    }
    if (!loopbackHost(headers.host)) {
      return {
        status: 403,
        body: { error: 'forbidden', message: 'loopback only' },
      };
    }
    const auth = headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const app = this.#tokens.get(token);
    if (app === undefined) {
      return {
        status: 401,
        body: { error: 'unauthorized', message: 'bad or missing token' },
      };
    }
    const url = new URL(rawUrl, 'http://127.0.0.1');
    const routes = this.#routes.get(app) ?? [];
    const matching = routes
      .map(route => ({
        route,
        params: matchRoute(route.pattern, url.pathname),
      }))
      .filter(m => m.params !== undefined);
    if (matching.length === 0) {
      return {
        status: 404,
        body: { error: 'not_found', message: `no route ${url.pathname}` },
      };
    }
    const hit = matching.find(m => m.route.method === method);
    if (hit === undefined || !METHODS.includes(method as HttpMethod)) {
      return {
        status: 405,
        body: { error: 'bad_method', message: `${method} is not allowed here` },
      };
    }
    try {
      const response: RouteResponse = await hit.route.handle({
        method: method as HttpMethod,
        path: url.pathname,
        params: hit.params ?? {},
        query: query(url),
        body: method === 'GET' ? undefined : await body(),
        app,
      });
      return { status: response.status, body: response.body };
    } catch (error) {
      if (error instanceof RouteError) {
        return {
          status: error.status,
          body: { error: error.code, message: error.message },
        };
      }
      this.#options.log?.warn(
        `zrdt apps endpoint: ${method} ${url.pathname} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return {
        status: 500,
        body: { error: 'internal', message: 'internal error' },
      };
    }
  }

  #handler(): http.RequestListener {
    return (req, res) => {
      const reply = ({ status, body }: Reply) => {
        const text = JSON.stringify(body ?? {});
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
        });
        res.end(text);
      };
      drop(
        (async () => {
          try {
            reply(
              await this.answer(
                req.method ?? 'GET',
                req.url ?? '/',
                req.headers,
                () => readBody(req)
              )
            );
          } catch (error) {
            reply(
              error instanceof RouteError
                ? {
                    status: error.status,
                    body: { error: error.code, message: error.message },
                  }
                : {
                    status: 500,
                    body: { error: 'internal', message: 'internal error' },
                  }
            );
          }
        })()
      );
    };
  }

  async #listen(target: string | number): Promise<http.Server> {
    const server = http.createServer(this.#handler());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      const done = () => {
        server.off('error', reject);
        resolve();
      };
      if (typeof target === 'string') {
        server.listen(target, done);
      } else {
        server.listen(target, '127.0.0.1', done);
      }
    });
    this.#servers.push(server);
    return server;
  }

  /** Writes the tokens and the info file, then listens. Idempotent. */
  async start(): Promise<EndpointInfo> {
    if (this.#info !== undefined) {
      return this.#info;
    }
    const { userData } = this.#options;
    await mkdir(userData, { recursive: true });
    const tokenFiles = {} as Record<AppTag, string>;
    for (const app of [APP_GIT, APP_TORRENT] as const) {
      const token = randomBytes(32).toString('hex');
      const file = join(userData, `zrdt-apps-${TOKEN_NAMES[app]}.token`);
      // eslint-disable-next-line no-await-in-loop
      await writeFile(file, `${token}\n`, { mode: 0o600 });
      // eslint-disable-next-line no-await-in-loop
      await chmod(file, 0o600);
      this.#tokens.set(token, app);
      tokenFiles[app] = file;
    }

    let socket: string | undefined;
    if (this.#options.socket !== false) {
      let path = join(userData, 'zrdt-apps.sock');
      if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
        // A custom --user-data-dir can be too long for sun_path.
        path = join(
          tmpdir(),
          `zrdt-apps-${randomBytes(6).toString('hex')}.sock`
        );
      }
      // A socket left by a crash refuses the bind (Signal's single-instance
      // lock means no live owner).
      await rm(path, { force: true });
      await this.#listen(path);
      await chmod(path, 0o600);
      socket = `unix:${path}`;
    }
    let url: string | undefined;
    if (this.#options.port !== undefined) {
      const server = await this.#listen(this.#options.port);
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    const infoFile = join(userData, 'zrdt-apps.json');
    const info: EndpointInfo = {
      ...(url === undefined ? {} : { url }),
      ...(socket === undefined ? {} : { socket }),
      tokenFiles,
      infoFile,
    };
    await writeFile(
      infoFile,
      `${JSON.stringify(
        {
          protocol: 1,
          endpoint: url ?? socket,
          ...(url === undefined ? {} : { url }),
          ...(socket === undefined ? {} : { socket }),
          tokenFiles: {
            git: tokenFiles[APP_GIT],
            bt: tokenFiles[APP_TORRENT],
          },
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    await chmod(infoFile, 0o600);
    this.#info = info;
    this.#options.log?.info(
      `zrdt apps endpoint on ${[url, socket].filter(Boolean).join(' and ')}`
    );
    return info;
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.#servers.splice(0).map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          })
      )
    );
    const socket = this.#info?.socket;
    if (socket !== undefined) {
      await rm(socket.slice('unix:'.length), { force: true });
    }
    this.#info = undefined;
    this.#tokens.clear();
  }
}
