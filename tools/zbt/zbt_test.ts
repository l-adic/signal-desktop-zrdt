// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for zbt against the desktop's real bt routes (ts/zrdt/apps/bt) on a
// fake transport. Run from the repository root:
//   node --import tsx --test tools/zbt/zbt_test.ts

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { BtManager, PIECE_BYTES } from '../../ts/zrdt/apps/bt/manager.std.ts';
import { BtRoutes } from '../../ts/zrdt/apps/bt/routes.std.ts';
import {
  FakeBtApi,
  fileBytes,
} from '../../ts/test-node/zrdt/apps/bt/fakeBtApi.std.ts';
import { MemoryWriter } from '../../ts/test-node/zrdt/apps/bt/memoryWriter.std.ts';
import { discover, parseEndpoint } from './client.ts';
import { main, parseArgs } from './zbt.ts';

const TOKEN = 'secret-bt-token';

type World = {
  api: FakeBtApi;
  manager: BtManager;
  answer: boolean;
  url: string;
  socket: string;
  dir: string;
  servers: Array<http.Server>;
};

let world: World;

function serve(routes: BtRoutes): http.Server {
  return http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    const answer = async () => {
      let r: { status: number; body: unknown };
      if (req.headers.authorization === `Bearer ${TOKEN}`) {
        r = await routes.handle({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body: text.length > 0 ? JSON.parse(text) : undefined,
        });
      } else {
        r = { status: 401, body: { error: 'unauthorized', message: 'no' } };
      }
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    };
    req.on('end', () => {
      void answer();
    });
  });
}

function listen(server: http.Server, target: string | number): Promise<void> {
  return new Promise(resolve => {
    if (typeof target === 'number') {
      server.listen(target, '127.0.0.1', () => resolve());
    } else {
      server.listen(target, () => resolve());
    }
  });
}

before(async () => {
  const api = new FakeBtApi();
  const w: Partial<World> = { api, answer: true, servers: [] };
  const manager = new BtManager({
    api,
    writer: new MemoryWriter(),
    // `world` is assigned below, before any request.
    confirmShare: async () => world.answer,
  });
  const routes = new BtRoutes({
    manager,
    findGroup: alias =>
      alias === 'Camping'
        ? { conversationId: 'conv', title: 'Camping', memberCount: 4 }
        : undefined,
    self: () => ({ aci: 'aci-alice', name: 'Alice' }),
    sha256: b => new Uint8Array(createHash('sha256').update(b).digest()),
    randomId: () => Math.random().toString(16).slice(2),
    now: () => Date.now(),
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zbt-'));
  const tcp = serve(routes);
  await listen(tcp, 0);
  const socket = path.join(dir, 's.sock');
  const unix = serve(routes);
  await listen(unix, socket);
  const address = tcp.address();
  const port =
    typeof address === 'object' && address != null ? address.port : 0;
  world = {
    ...(w as World),
    manager,
    url: `http://127.0.0.1:${port}`,
    socket,
    dir,
    servers: [tcp, unix],
  };
});

after(async () => {
  for (const s of world.servers) {
    s.close();
  }
  await fs.rm(world.dir, { recursive: true, force: true });
});

function io(
  env: Record<string, string>,
  files: Record<string, Uint8Array<ArrayBuffer>> = {}
) {
  const out: Array<string> = [];
  const err: Array<string> = [];
  return {
    out,
    err,
    io: {
      env,
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
      readFile: async (p: string) => {
        const f = files[p];
        if (f === undefined) {
          throw new Error(`ENOENT ${p}`);
        }
        return f;
      },
    },
  };
}

void test('parseEndpoint: loopback http and unix only', () => {
  assert.deepEqual(parseEndpoint('http://127.0.0.1:7470'), {
    kind: 'tcp',
    host: '127.0.0.1',
    port: 7470,
  });
  assert.deepEqual(parseEndpoint('unix:/tmp/x.sock'), {
    kind: 'unix',
    path: '/tmp/x.sock',
  });
  assert.equal(parseEndpoint('http://example.com:80'), undefined);
  assert.equal(parseEndpoint('http://10.0.0.1:7470'), undefined);
  assert.equal(parseEndpoint('http://127.0.0.1'), undefined);
  assert.equal(parseEndpoint('https://127.0.0.1:7470'), undefined);
  assert.equal(parseEndpoint('unix:'), undefined);
});

void test('discover: precedence of endpoint and token', async () => {
  const files: Record<string, string> = {
    '/ud/zrdt-apps.json': JSON.stringify({
      endpoint: 'unix:/ud/zrdt-apps.sock',
      tokens: { bt: 'from-file', git: 'other' },
    }),
    '/ud/port.json': JSON.stringify({
      port: 7471,
      tokenFiles: { bt: '/ud/bt.token' },
    }),
    '/ud/bt.token': 'tok\n',
  };
  const read = async (p: string) => {
    const f = files[p];
    if (f === undefined) {
      throw new Error('ENOENT');
    }
    return f;
  };
  assert.deepEqual(
    await discover({ ZRDT_ENDPOINT: '/ud/zrdt-apps.json' }, {}, read),
    {
      endpoint: { kind: 'unix', path: '/ud/zrdt-apps.sock' },
      token: 'from-file',
    }
  );
  assert.deepEqual(
    await discover({ ZRDT_ENDPOINT: '/ud/port.json' }, {}, read),
    { endpoint: { kind: 'tcp', host: '127.0.0.1', port: 7471 }, token: 'tok' }
  );
  assert.deepEqual(
    await discover(
      { ZRDT_ENDPOINT: '/ud/zrdt-apps.json', ZRDT_TOKEN: 'env' },
      { endpoint: 'http://127.0.0.1:9' },
      read
    ),
    { endpoint: { kind: 'tcp', host: '127.0.0.1', port: 9 }, token: 'env' }
  );
  assert.deepEqual(
    await discover(
      { ZRDT_SOCKET: '/ud/s.sock', ZRDT_TOKEN_FILE: '/ud/bt.token' },
      {},
      read
    ),
    { endpoint: { kind: 'unix', path: '/ud/s.sock' }, token: 'tok' }
  );
  await assert.rejects(discover({}, {}, read), /no endpoint/);
  await assert.rejects(
    discover(
      { ZRDT_ENDPOINT: 'http://example.com:1', ZRDT_TOKEN: 'x' },
      {},
      read
    ),
    /loopback/
  );
  await assert.rejects(
    discover({ ZRDT_ENDPOINT: 'unix:/x' }, {}, read),
    /no token/
  );
});

void test('parseArgs', () => {
  assert.deepEqual(parseArgs(['share', 'trip.mp4', '--group', 'Camping']), {
    command: 'share',
    positional: ['trip.mp4'],
    group: 'Camping',
    name: undefined,
    wait: undefined,
    json: false,
    endpoint: undefined,
    tokenFile: undefined,
  });
  assert.equal(
    parseArgs(['status', 'ab', '--group', 'G', '--wait', '5']).wait,
    5
  );
  assert.throws(() => parseArgs([]), /no command/);
  assert.throws(() => parseArgs(['share', '--group', 'G']), /argument/);
  assert.throws(() => parseArgs(['ls']), /needs --group/);
  assert.throws(() => parseArgs(['ls', '--group']), /needs a value/);
  assert.throws(
    () => parseArgs(['ls', '--group', 'G', '--x']),
    /unknown option/
  );
  assert.throws(() => parseArgs(['frob', '--group', 'G']), /unknown command/);
  assert.throws(
    () => parseArgs(['status', 'a', '--group', 'G', '--wait', '-1']),
    /seconds/
  );
});

void test('zbt share, ls and status over TCP', async () => {
  world.answer = true;
  const bytes = fileBytes(2 * PIECE_BYTES + 7);
  const env = { ZRDT_ENDPOINT: world.url, ZRDT_TOKEN: TOKEN };
  const s = io(env, { '/home/alice/trip.mp4': bytes });
  assert.equal(
    await main(
      ['share', '/home/alice/trip.mp4', '--group', 'Camping', '--json'],
      s.io
    ),
    0
  );
  const shared = JSON.parse(s.out[0] ?? '{}') as {
    status: string;
    file: string;
    audience: number;
  };
  assert.equal(shared.status, 'ok');
  assert.equal(shared.audience, 4);

  const l = io(env);
  assert.equal(await main(['ls', '--group', 'Camping'], l.io), 0);
  assert.match(l.out[0] ?? '', /^trip\.mp4 {2}2 MiB {2}shared by you/);
  assert.match(
    l.out[0] ?? '',
    /### {2}Shared with 4 members: every piece checked/
  );

  const st = io(env);
  assert.equal(
    await main(
      ['status', shared.file, '--group', 'Camping', '--json', '--wait', '5'],
      st.io
    ),
    0
  );
  const f = JSON.parse(st.out[0] ?? '{}') as { state: string; pieces: number };
  assert.equal(f.state, 'checked');
  assert.equal(f.pieces, 3);
});

void test('zbt over the unix socket; a declined share exits 1', async () => {
  world.answer = false;
  const env = { ZRDT_ENDPOINT: `unix:${world.socket}`, ZRDT_TOKEN: TOKEN };
  const h = io(env);
  assert.equal(await main(['hello'], h.io), 0);
  assert.equal(h.out[0], 'bt endpoint of Alice');
  const s = io(env, { 'x.bin': fileBytes(10) });
  assert.equal(await main(['share', 'x.bin', '--group', 'Camping'], s.io), 1);
  assert.match(
    s.out[0] ?? '',
    /not shared: the share was cancelled in Signal \(DECLINED\)/
  );
});

void test('zbt: wrong token, unknown group, nobody listening', async () => {
  const bad = io({ ZRDT_ENDPOINT: world.url, ZRDT_TOKEN: 'wrong' });
  assert.equal(await main(['ls', '--group', 'Camping'], bad.io), 3);
  assert.match(bad.err[0] ?? '', /unauthorized/);
  const none = io({ ZRDT_ENDPOINT: world.url, ZRDT_TOKEN: TOKEN });
  assert.equal(await main(['ls', '--group', 'Work'], none.io), 3);
  assert.match(none.err[0] ?? '', /no_group/);
  const down = io({
    ZRDT_ENDPOINT: `unix:${path.join(world.dir, 'nobody.sock')}`,
    ZRDT_TOKEN: TOKEN,
  });
  assert.equal(await main(['hello'], down.io), 3);
  assert.match(down.err[0] ?? '', /is Signal running/);
  const usage = io({});
  assert.equal(await main(['ls'], usage.io), 2);
});

void test('the zbt script runs under plain node (type stripping)', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = path.join(import.meta.dirname, 'zbt.ts');
  const r = spawnSync(process.execPath, [script], {
    env: {},
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
