// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable no-await-in-loop

// The app transport's core (ts/zrdt/apps/host.node.ts) on four desktops:
// each runs the real zrdt service on the protocol-5 stub, with an in-memory
// network (Content 205 group sends, 1:1 repair requests and replies) and an
// in-memory CDN the server can delete and corrupt. It runs both beats of
// zrdt docs/apps/BUILD_M1.md §A with 1 KiB pieces, and drives the git beat
// through the local endpoint over a Unix socket, as the helper does.

import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert } from 'chai';

import type { Bytes, ServeReply } from '../../../zrdt/ZrdtBackend.std.ts';
import { AppsStubBackend } from '../../../zrdt/backends/appsStub.node.ts';
import { stubKeyTag } from '../../../zrdt/backends/stub.node.ts';
import { rawObject } from '../../../zrdt/backends/gitStub.node.ts';
import { ZrdtServiceCore, toHex } from '../../../zrdt/serviceCore.node.ts';
import { checkServedReply } from '../../../zrdt/serveRequests.std.ts';
import { AppsHost } from '../../../zrdt/apps/host.node.ts';
import type {
  HostGroup,
  HostMember,
  RepairRequestMessage,
} from '../../../zrdt/apps/host.node.ts';
import { groupIdOfAppKey } from '../../../zrdt/apps/channels.std.ts';
import {
  APP_GIT,
  APP_TORRENT,
  TEST_PIECE_EXP,
  concat,
  utf8,
} from '../../../zrdt/apps/appMessage.std.ts';
import { AppsEndpoint } from '../../../zrdt/apps/endpoint.node.ts';
import { gitRoutes } from '../../../zrdt/apps/gitRoutes.std.ts';
import type { AppEvent } from '../../../zrdt/apps/api.std.ts';
import { MemoryStorage } from './memoryStorage.node.ts';

function filled(n: number, byte: number): Bytes {
  return new Uint8Array(n).fill(byte);
}

function sha(bytes: Bytes): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// The CDN: pieces by upload order; the server can delete and corrupt
// ---------------------------------------------------------------------------

type Pointer = { key: number; size: number; digest: string };

type FakeCdn = Readonly<{
  objects: Map<number, Bytes>;
  uploads: () => number;
  upload: (piece: Bytes) => Pointer;
  delete: (key: number) => void;
  corrupt: (key: number) => void;
  get: (
    pointer: Pointer
  ) =>
    | { kind: 'missing' }
    | { kind: 'bad'; message: string }
    | { kind: 'ok'; bytes: Bytes };
}>;

function fakeCdn(): FakeCdn {
  const objects = new Map<number, Bytes>();
  let uploads = 0;
  return {
    objects,
    uploads: () => uploads,
    upload: piece => {
      uploads += 1;
      objects.set(uploads, new Uint8Array(piece));
      return { key: uploads, size: piece.length, digest: sha(piece) };
    },
    delete: key => {
      objects.delete(key);
    },
    corrupt: key => {
      const o = objects.get(key);
      if (o) {
        o[0] = 255 - (o[0] ?? 0);
      }
    },
    get: pointer => {
      const o = objects.get(pointer.key);
      if (o === undefined) {
        return { kind: 'missing' };
      }
      // Signal's attachment check (the MAC and digest): the server cannot forge it.
      if (sha(o) !== pointer.digest) {
        return { kind: 'bad', message: 'Bad MAC' };
      }
      return { kind: 'ok', bytes: new Uint8Array(o) };
    },
  };
}

// ---------------------------------------------------------------------------
// Desktops and the network
// ---------------------------------------------------------------------------

type Desk = {
  name: string;
  aci: string;
  key: Bytes;
  host: AppsHost<Pointer>;
  service: ZrdtServiceCore;
  online: boolean;
  inbox: Array<() => Promise<void>>;
  villain: boolean;
  events: Array<AppEvent>;
};

function aciOf(byte: number): string {
  const h = filled(16, byte);
  const hex = toHex(h);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class World {
  readonly desks = new Map<string, Desk>();
  readonly groups = new Map<
    string,
    { title: string; groupId: Bytes; members: Array<string> }
  >();
  readonly cdn = fakeCdn();
  readonly #inFlight = new Set<Promise<void>>();

  addGroup(
    conversationId: string,
    title: string,
    members: Array<string>
  ): void {
    this.groups.set(conversationId, {
      title,
      groupId: createHash('sha256').update(title).digest(),
      members,
    });
  }

  #hostGroup(conversationId: string): HostGroup | undefined {
    const g = this.groups.get(conversationId);
    if (g === undefined) {
      return undefined;
    }
    return {
      conversationId,
      title: g.title,
      groupId: new Uint8Array(g.groupId),
      groupV2: utf8(`groupV2 of ${g.title}`),
      members: g.members.map((name): HostMember => {
        const d = this.desks.get(name);
        if (d === undefined) {
          throw new Error(name);
        }
        return { aci: d.aci, name, key: d.key };
      }),
    };
  }

  #deskByAci(aci: string): Desk | undefined {
    return [...this.desks.values()].find(d => d.aci === aci);
  }

  /** Delivers to `to`, now if it is online, else when it comes online. */
  #deliver(to: Desk, run: () => Promise<void>): void {
    if (!to.online) {
      to.inbox.push(run);
      return;
    }
    const go = async (): Promise<void> => {
      // Not now: delivery is asynchronous, as on the network.
      await new Promise(resolve => setImmediate(resolve));
      try {
        await run();
      } finally {
        this.#inFlight.delete(p);
      }
    };
    const p = go();
    this.#inFlight.add(p);
  }

  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight]);
    }
  }

  setOnline(name: string, online: boolean): void {
    const d = this.desks.get(name);
    if (d === undefined) {
      return;
    }
    d.online = online;
    if (online) {
      for (const run of d.inbox.splice(0)) {
        this.#deliver(d, run);
      }
    }
  }

  async addDesk(name: string, byte: number): Promise<Desk> {
    const aci = aciOf(byte);
    const key = concat([Uint8Array.of(5), filled(32, byte)]);
    const storage = new MemoryStorage();
    const backend = new AppsStubBackend({ env: {} });
    const service = new ZrdtServiceCore({
      createBackend: () => backend,
      intendedKind: () => 'stub',
      storage,
      groupIdOf: id => groupIdOfAppKey(id),
      ourAci: () => aci,
    });
    await service.init();
    const openings = new Map<
      string,
      Map<string, { digest: Bytes; opening: Bytes }>
    >();
    const desk: Desk = {
      name,
      aci,
      key,
      service,
      online: true,
      inbox: [],
      villain: false,
      events: [],
      host: undefined as unknown as AppsHost<Pointer>,
    };
    desk.host = new AppsHost<Pointer>({
      stores: service,
      apps: () => service.appsBackend(),
      pieceExp: TEST_PIECE_EXP,
      env: { ZRDT_REPAIR_TIMEOUT_MS: '150' },
      tamperServed: () => desk.villain,
      openings: {
        put: async (k, digest, opening) => {
          const m = openings.get(k) ?? new Map();
          m.set(toHex(digest), { digest, opening });
          openings.set(k, m);
        },
        all: async k => [...(openings.get(k)?.values() ?? [])],
      },
      cdn: {
        upload: async piece => this.cdn.upload(piece),
        encodePointers: ps => utf8(JSON.stringify(ps)),
        decodePointers: bytes => {
          const list = JSON.parse(
            new TextDecoder().decode(bytes)
          ) as Array<Pointer>;
          return list.map(pointer => ({
            pointer,
            shape: { size: pointer.size, complete: true },
          }));
        },
        download: async pointer => this.cdn.get(pointer),
      },
      signal: {
        ourAci: () => aci,
        ourKey: () => key,
        groups: async () =>
          [...this.groups.keys()]
            .map(id => this.#hostGroup(id))
            .filter((g): g is HostGroup => g !== undefined),
        group: async id => this.#hostGroup(id),
        memberName: a => this.#deskByAci(a)?.name ?? a.slice(0, 8),
        sendApp: async (conversationId, bytes, recipients) => {
          for (const r of recipients) {
            const to = this.#deskByAci(r);
            if (to) {
              this.#deliver(to, () =>
                to.host.receive({ conversationId, senderAci: aci, bytes })
              );
            }
          }
        },
        sendRepairRequest: async (toAci, request: RepairRequestMessage) => {
          const to = this.#deskByAci(toAci);
          if (to) {
            this.#deliver(to, async () => {
              await to.host.onRepairRequest(aci, key, request);
            });
          }
        },
        sendRepairReply: async (
          toAci,
          _groupId,
          reply: ServeReply,
          sealedTo
        ) => {
          const to = this.#deskByAci(toAci);
          if (to === undefined) {
            return;
          }
          this.#deliver(to, async () => {
            // The requester's JOIN §4.4 checks, on the host's book.
            const check = checkServedReply({
              book: to.host.repairBook(),
              now: Date.now(),
              headerAci: reply.header.requesterAci,
              headerKeyTag: reply.header.keyTag,
              headerRequestId: reply.header.requestId,
              conversationId: to.host
                .repairBook()
                .get(toHex(reply.header.requestId))?.conversationId,
              ourAci: to.aci,
              ourKeyTag: stubKeyTag(to.key),
              senderAci: aci,
              responderKeyNow: toHex(key),
            });
            assert.isTrue(check.ok, `the reply to ${to.name} passes §4.4`);
            assert.strictEqual(toHex(sealedTo), toHex(to.key));
            to.host.repairBook().complete(toHex(reply.header.requestId));
            await to.host.onRepairReply(
              aci,
              toHex(reply.header.requestId),
              reply.entries
            );
          });
        },
      },
    });
    desk.host.registerConfirm(async () => true);
    desk.host.subscribe(e => desk.events.push(e));
    this.desks.set(name, desk);
    return desk;
  }

  desk(name: string): Desk {
    const d = this.desks.get(name);
    if (d === undefined) {
      throw new Error(name);
    }
    return d;
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error('timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// The torrent beat
// ---------------------------------------------------------------------------

describe('zrdt apps: host, the torrent beat (BUILD_M1 §A.1)', function (this: Mocha.Suite) {
  this.timeout(30_000);

  it('shares, fetches, survives the CDN villain and a tampering member', async () => {
    const world = new World();
    for (const [name, byte] of [
      ['alice', 0xa1],
      ['bob', 0xb2],
      ['carol', 0xc3],
      ['dave', 0xd4],
    ] as const) {
      await world.addDesk(name, byte);
    }
    world.addGroup('camping', 'Camping', ['alice', 'bob', 'carol', 'dave']);
    const alice = world.desk('alice');
    const bob = world.desk('bob');
    const carol = world.desk('carol');
    const dave = world.desk('dave');
    assert.isTrue(alice.host.available());

    // 20 pieces of 1 KiB; the last is short.
    const file = new Uint8Array(19 * 1024 + 500).map(
      (_, i) => (i * 13 + 7) % 256
    );
    world.setOnline('carol', false);

    // 1. Alice shares.
    const published = await alice.host.publish({
      app: 'bt',
      conversationId: 'camping',
      name: 'trip.mp4',
      stream: file,
    });
    assert.strictEqual(published.kind, 'ok');
    if (published.kind !== 'ok') {
      return;
    }
    assert.strictEqual(world.cdn.uploads(), 20, 'one fresh upload per piece');
    assert.sameMembers(
      published.audience.map(m => m.name),
      ['alice', 'bob', 'carol', 'dave']
    );
    const digest = published.digest;
    const own = await alice.host.fetchPieces(digest);
    assert.strictEqual(own.state, 'complete', 'the author binds her own A');

    // 2. Bob and Dave fetch without a click (confirmed by its author, small).
    await world.settle();
    for (const d of [bob, dave]) {
      const a = await d.host.fetchPieces(digest);
      assert.strictEqual(a.state, 'complete', `${d.name} completes`);
      assert.strictEqual(a.pieces, 20);
      assert.strictEqual(
        sha((await d.host.stream(digest)) ?? new Uint8Array()),
        sha(file)
      );
      assert.isTrue(await d.host.assemble(digest, file));
      const bad = new Uint8Array(file);
      bad[100] = ((bad[100] ?? 0) + 1) % 256;
      assert.isFalse(await d.host.assemble(digest, bad));
    }

    // 3. Alice quits; the server deletes pieces 3, 7, 12 and corrupts 15.
    world.setOnline('alice', false);
    for (const i of [3, 7, 12]) {
      world.cdn.delete(i + 1);
    }
    world.cdn.corrupt(15 + 1);
    dave.villain = true;

    // 4.-5. Carol starts her app: A arrives, 16 pieces pass, 4 go to repair.
    world.setOnline('carol', true);
    await world.settle();
    await until(() =>
      carol.events.some(
        e => e.type === 'announcement' && e.announcement.state === 'repairing'
      )
    );
    const done = await carol.host.fetchPieces(digest);
    await world.settle();
    assert.strictEqual(done.state, 'complete', 'Carol completes after repair');
    assert.strictEqual(
      sha((await carol.host.stream(digest)) ?? new Uint8Array()),
      sha(file)
    );

    const status = carol.host.repairStatus(digest);
    assert.isDefined(status);
    assert.sameMembers(
      status?.pieces.map(p => p.index) ?? [],
      [3, 7, 12, 15],
      'the exact missing list went to repair'
    );
    assert.isTrue(status?.pieces.every(p => p.state === 'ok'));
    assert.isTrue(
      (status?.failedChecks.length ?? 0) > 0 &&
        status?.failedChecks.every(f => f.member === 'dave'),
      'only Dave sent bytes that failed zrdt’s check'
    );
    assert.includeMembers([...(status?.dropped ?? [])], ['alice', 'dave']);
    assert.isTrue(
      carol.events.some(
        e => e.type === 'pieceFailedCheck' && e.from === dave.aci
      ),
      'Carol (only) is told'
    );
    assert.isFalse(bob.events.some(e => e.type === 'pieceFailedCheck'));
  });

  it('holds back an announcement not confirmed by its author until a click', async () => {
    const world = new World();
    await world.addDesk('alice', 0xa1);
    await world.addDesk('bob', 0xb2);
    await world.addDesk('carol', 0xc3);
    world.addGroup('g', 'G', ['alice', 'bob', 'carol']);
    const alice = world.desk('alice');
    const r = await alice.host.publish({
      app: 'bt',
      conversationId: 'g',
      name: 'x.bin',
      stream: filled(3000, 7),
    });
    assert.strictEqual(r.kind, 'ok');
    await world.settle();
    const bob = world.desk('bob');
    const list = await bob.host.announcements('g', APP_TORRENT);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.state, 'complete');
    // A declined share sends nothing.
    alice.host.registerConfirm(async () => false);
    const uploads = world.cdn.uploads();
    assert.deepEqual(
      await alice.host.publish({
        app: 'bt',
        conversationId: 'g',
        name: 'y.bin',
        stream: filled(10, 1),
      }),
      { kind: 'declined' }
    );
    assert.strictEqual(world.cdn.uploads(), uploads);
  });
});

// ---------------------------------------------------------------------------
// The git beat, through the endpoint
// ---------------------------------------------------------------------------

function oidOf(raw: Bytes): string {
  return sha(raw);
}

function treeOf(name: string, blob: Bytes): Bytes {
  return rawObject(
    'tree',
    concat([
      utf8(`100644 ${name}\0`),
      new Uint8Array(Buffer.from(oidOf(blob), 'hex')),
    ])
  );
}

function commitOf(
  tree: Bytes,
  parents: ReadonlyArray<Bytes>,
  msg: string
): Bytes {
  return rawObject(
    'commit',
    utf8(
      [
        `tree ${oidOf(tree)}`,
        ...parents.map(p => `parent ${oidOf(p)}`),
        'author A <a@x> 1700000000 +0000',
        'committer A <a@x> 1700000000 +0000',
        '',
        msg,
      ].join('\n')
    )
  );
}

function streamOf(raws: ReadonlyArray<Bytes>): {
  stream: Bytes;
  ids: Array<string>;
} {
  const sorted = [...raws].sort((x, y) => (oidOf(x) < oidOf(y) ? -1 : 1));
  return { stream: concat(sorted), ids: sorted.map(oidOf) };
}

type Client = (
  method: string,
  path: string,
  body?: unknown
) => Promise<{ status: number; body: Record<string, unknown> }>;

function client(socket: string, token: string): Client {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: socket,
          path,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Zrdt-Protocol': '1',
            ...(data === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(data),
                }),
          },
        },
        res => {
          const chunks = new Array<Buffer<ArrayBuffer>>();
          res.on('data', c => chunks.push(c as Buffer<ArrayBuffer>));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              body: (text === '' ? {} : JSON.parse(text)) as Record<
                string,
                unknown
              >,
            });
          });
        }
      );
      req.on('error', reject);
      if (data !== undefined) {
        req.write(data);
      }
      req.end();
    });
}

function clientOf(endpoints: Map<string, Client>, name: string): Client {
  const c = endpoints.get(name);
  if (c === undefined) {
    throw new Error(`no endpoint for ${name}`);
  }
  return c;
}

/** The helper's upload and push, over the endpoint (ENDPOINT §4.3, §4.5). */
async function push(
  call: Client,
  repo: string,
  raws: ReadonlyArray<Bytes>,
  request: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { stream, ids } = streamOf(raws);
  let upload: string | null = null;
  if (stream.length > 0) {
    const u = await call('POST', `/v1/git/Code/${repo}/uploads`, {
      size: stream.length,
    });
    assert.strictEqual(u.status, 201);
    upload = String(u.body.upload);
    const size = Number(u.body.pieceSize);
    for (let i = 0; i < Number(u.body.pieces); i += 1) {
      const piece = stream.slice(i * size, (i + 1) * size);
      const r = await call(
        'PUT',
        `/v1/git/Code/${repo}/uploads/${upload}/pieces/${i}`,
        {
          sha256: sha(piece),
          data: Buffer.from(piece).toString('base64'),
        }
      );
      assert.strictEqual(r.status, 200);
    }
  }
  return call('POST', `/v1/git/Code/${repo}/pushes`, {
    upload,
    objects: ids,
    share: false,
    covers: null,
    create: false,
    dryRun: false,
    ...request,
  });
}

describe('zrdt apps: host, the git beat through the endpoint (BUILD_M1 §A.2)', function (this: Mocha.Suite) {
  this.timeout(30_000);

  it('P1, clone, forced P2, logs agree, GATE for Dave, a share, P3', async () => {
    const world = new World();
    for (const [name, byte] of [
      ['alice', 0xa1],
      ['bob', 0xb2],
      ['carol', 0xc3],
      ['dave', 0xd4],
    ] as const) {
      await world.addDesk(name, byte);
    }
    world.addGroup('code', 'Code', ['alice', 'bob', 'carol']);
    const dir = await mkdtemp(join(tmpdir(), 'zrdt-apps-test-'));
    const endpoints = new Map<string, Client>();
    const servers = new Array<AppsEndpoint>();
    try {
      for (const name of ['alice', 'bob', 'carol', 'dave']) {
        const d = world.desk(name);
        const ep = new AppsEndpoint({ userData: join(dir, name), port: 0 });
        ep.registerRoutes(
          APP_GIT,
          gitRoutes(d.host.gitDesk(), {
            pieceSize: 1024,
            maxStream: 64 * 1024,
            maxObjectsPerRequest: 256,
          })
        );
        const info = await ep.start();
        servers.push(ep);
        assert.strictEqual(
          (await stat(info.tokenFiles[APP_GIT])).mode % 0o1000,
          0o600
        );
        assert.strictEqual((await stat(info.infoFile)).mode % 0o1000, 0o600);
        const socket = info.socket?.slice('unix:'.length) ?? '';
        assert.strictEqual((await stat(socket)).mode % 0o1000, 0o600);
        const { readFile } = await import('node:fs/promises');
        const token = (await readFile(info.tokenFiles[APP_GIT], 'utf8')).trim();
        endpoints.set(name, client(socket, token));
        // The torrent token does not reach the git routes.
        const btToken = (
          await readFile(info.tokenFiles[APP_TORRENT], 'utf8')
        ).trim();
        assert.strictEqual(
          (await client(socket, btToken)('GET', '/v1/hello')).status,
          404
        );
        assert.strictEqual(
          (await client(socket, 'nope')('GET', '/v1/hello')).status,
          401
        );
      }
      const alice = clientOf(endpoints, 'alice');
      const bob = clientOf(endpoints, 'bob');
      const carol = clientOf(endpoints, 'carol');

      const hello = await alice('GET', '/v1/hello');
      assert.strictEqual(hello.body.objectFormat, 'sha256');
      assert.strictEqual(hello.body.protocol, 1);
      assert.strictEqual((await alice('GET', '/v1/git/Nope/demo')).status, 404);

      const blob0 = rawObject('blob', utf8('hello\n'));
      const tree0 = treeOf('hello.txt', blob0);
      const c0 = commitOf(tree0, [], 'c0');
      const blob1 = rawObject('blob', utf8('hello again\n'));
      const tree1 = treeOf('hello.txt', blob1);
      const c1 = commitOf(tree1, [c0], 'c1');

      // 1. Alice pushes c0, c1 (NEEDS_CREATE without create; then created).
      const first = await push(
        alice,
        'demo',
        [blob0, tree0, c0, blob1, tree1, c1],
        {
          updates: [
            { name: 'refs/heads/main', old: [], new: oidOf(c1), forced: false },
          ],
        }
      );
      assert.strictEqual(first.status, 409);
      assert.strictEqual(first.body.reason, 'NEEDS_CREATE');
      const p1 = await push(
        alice,
        'demo',
        [blob0, tree0, c0, blob1, tree1, c1],
        {
          updates: [
            { name: 'refs/heads/main', old: [], new: oidOf(c1), forced: false },
          ],
          create: true,
        }
      );
      assert.strictEqual(p1.status, 200, JSON.stringify(p1.body));
      assert.strictEqual(p1.body.status, 'ok');
      await world.settle();

      // 2. Bob clones: main = c1, and the objects come back.
      await until(() =>
        world
          .desk('bob')
          .events.some(e => e.type === 'complete' && e.app === APP_GIT)
      );
      const s1 = await bob('GET', '/v1/git/Code/demo');
      assert.strictEqual(s1.status, 200);
      const refs1 = s1.body.refs as Array<{
        name: string;
        values: Array<{ value: string }>;
      }>;
      assert.deepEqual(
        refs1.map(r => [r.name, r.values.map(v => v.value)]),
        [['refs/heads/main', [oidOf(c1)]]]
      );
      const got = await bob('POST', '/v1/git/Code/demo/objects', {
        ids: [oidOf(c1), oidOf(tree1), 'f'.repeat(64)],
      });
      const objs = got.body.objects as Array<{ id: string; raw: string }>;
      assert.strictEqual(objs.length, 2);
      for (const o of objs) {
        assert.strictEqual(
          sha(new Uint8Array(Buffer.from(o.raw, 'base64'))),
          o.id
        );
      }
      assert.deepEqual(got.body.missing, ['f'.repeat(64)]);

      // 3. Bob force-pushes c2 (parent c0).
      const blob2 = rawObject('blob', utf8('amended\n'));
      const tree2 = treeOf('hello.txt', blob2);
      const c2 = commitOf(tree2, [c0], 'c2');
      const p2 = await push(bob, 'demo', [blob2, tree2, c2], {
        updates: [
          {
            name: 'refs/heads/main',
            old: [oidOf(c1)],
            new: oidOf(c2),
            forced: true,
          },
        ],
      });
      assert.strictEqual(p2.status, 200, JSON.stringify(p2.body));
      await world.settle();
      await until(
        () =>
          world
            .desk('carol')
            .events.filter(e => e.type === 'complete' && e.app === APP_GIT)
            .length >= 2
      );
      await until(
        () =>
          world
            .desk('alice')
            .events.filter(e => e.type === 'complete' && e.app === APP_GIT)
            .length >= 2
      );

      // 4. The logs agree on all three screens: Bob force-pushed c1 -> c2.
      const states = new Array<Record<string, unknown>>();
      for (const c of [alice, bob, carol]) {
        const s = await c('GET', '/v1/git/Code/demo');
        states.push(s.body);
        const refs = s.body.refs as Array<{
          name: string;
          values: Array<{ value: string; forced: boolean; author: string }>;
        }>;
        assert.deepEqual(
          refs.map(r => r.values.map(v => [v.value, v.forced, v.author])),
          [[[oidOf(c2), true, 'bob']]]
        );
        const records = s.body.records as Array<{
          updates: Array<{ forced: boolean }>;
        }>;
        assert.strictEqual(records.length, 2);
      }
      assert.deepEqual(states[0]?.refs, states[1]?.refs);
      assert.deepEqual(states[1]?.heads, states[2]?.heads);

      // A re-push of what the table holds: OLD_OBJECT.
      const again = await push(bob, 'demo', [blob1, tree1, c1], {
        updates: [
          { name: 'refs/heads/old', old: [], new: oidOf(c1), forced: false },
        ],
      });
      assert.strictEqual(again.body.reason, 'OLD_OBJECT');

      // 5.-6. Dave joins Code; Carol's push is blocked: GATE, Dave new.
      world.groups.get('code')?.members.push('dave');
      const blob3 = rawObject('blob', utf8('carol\n'));
      const tree3 = treeOf('hello.txt', blob3);
      const c3 = commitOf(tree3, [c2], 'c3');
      const p3 = {
        updates: [
          {
            name: 'refs/heads/main',
            old: [oidOf(c2)],
            new: oidOf(c3),
            forced: false,
          },
        ],
      };
      const blocked = await push(carol, 'demo', [blob3, tree3, c3], p3);
      assert.strictEqual(blocked.status, 409);
      assert.strictEqual(blocked.body.reason, 'GATE');
      assert.deepEqual(
        (blocked.body.seats as Array<{ member: string; reason: string }>).map(
          s => [s.member, s.reason]
        ),
        [['dave', 'NEW']]
      );

      // 7. Alice shares main@c2: COVERS_CHANGED [dave], then the dialog, then OK.
      const share = {
        updates: [
          {
            name: 'refs/heads/main',
            old: [oidOf(c2)],
            new: oidOf(c2),
            forced: false,
          },
        ],
        share: true,
      };
      const ask = await push(alice, 'demo', [blob2, tree2, c2], share);
      assert.strictEqual(ask.body.reason, 'COVERS_CHANGED');
      assert.deepEqual(ask.body.covers, ['dave']);
      let asked: unknown;
      world.desk('alice').host.registerConfirm(async request => {
        asked = request;
        return true;
      });
      const shared = await push(alice, 'demo', [blob2, tree2, c2], {
        ...share,
        covers: ['dave'],
      });
      assert.strictEqual(shared.status, 200, JSON.stringify(shared.body));
      assert.deepEqual(shared.body.covers, ['dave']);
      assert.strictEqual((asked as { kind: string }).kind, 'gitShare');
      await world.settle();
      await until(
        () =>
          world
            .desk('carol')
            .events.filter(e => e.type === 'complete' && e.app === APP_GIT)
            .length >= 3
      );

      // 8. Carol's P3 passes now; Dave's view has S only.
      const passed = await push(carol, 'demo', [blob3, tree3, c3], p3);
      assert.strictEqual(passed.status, 200, JSON.stringify(passed.body));
      await world.settle();
      const daveClient = clientOf(endpoints, 'dave');
      await until(
        () =>
          world
            .desk('dave')
            .events.filter(e => e.type === 'complete' && e.app === APP_GIT)
            .length >= 2
      );
      const daveState = await daveClient('GET', '/v1/git/Code/demo');
      const daveRecords = daveState.body.records as Array<{ share: boolean }>;
      assert.isTrue(daveRecords.some(r => r.share));
      const daveObjects = await daveClient(
        'POST',
        '/v1/git/Code/demo/objects',
        {
          ids: [oidOf(c2), oidOf(c1)],
        }
      );
      assert.deepEqual(
        daveObjects.body.missing,
        [oidOf(c1)],
        'not its history'
      );
    } finally {
      await Promise.all(servers.map(s => s.stop()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses browsers and non-loopback hosts before the token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zrdt-apps-ep-'));
    const ep = new AppsEndpoint({ userData: dir, socket: false, port: 0 });
    try {
      await ep.start();
      assert.strictEqual(
        (
          await ep.answer(
            'GET',
            '/v1/hello',
            { origin: 'http://evil.example' },
            async () => undefined
          )
        ).status,
        403
      );
      assert.strictEqual(
        (
          await ep.answer(
            'GET',
            '/v1/hello',
            { host: 'evil.example' },
            async () => undefined
          )
        ).status,
        403
      );
      assert.strictEqual(
        (
          await ep.answer(
            'GET',
            '/v1/hello',
            { host: '127.0.0.1:1' },
            async () => undefined
          )
        ).status,
        401
      );
    } finally {
      await ep.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
