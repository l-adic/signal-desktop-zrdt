// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable no-await-in-loop

// The protocol-5 stub and codec (zrdt docs/apps/BUILD_M1.md §B), at the frame
// level with 1 KiB pieces (k = 10): the torrent beat (build, bind, accept,
// missing, a tampered repair entry, complete, assemble) and the git beat
// (P1, a forced P2, the views, OLD_OBJECT, GATE for a newcomer, a share with
// COVERS_CHANGED then OK, ROOT from a relative store). Every op goes through
// the codec both ways: the request is encoded, decoded and encoded again;
// the reply is encoded and decoded back to the stub's result.

import { assert } from 'chai';

import type {
  AppSeat,
  Bytes,
  Digest,
  GitUpdate,
  Oid,
  ServeHeld,
} from '../../../zrdt/ZrdtBackend.std.ts';
import { ZrdtBackendError } from '../../../zrdt/ZrdtBackend.std.ts';
import { Code } from '../../../zrdt/backends/codec.std.ts';
import {
  AppOp,
  decodeAppReply,
  decodeRequest5,
  encodeAppReply,
  encodeAppRequest,
  isAppRequest,
  sortSeats,
} from '../../../zrdt/backends/codec5.std.ts';
import type {
  AppRequest,
  AppResultOf,
} from '../../../zrdt/backends/codec5.std.ts';
import { AppsStubBackend } from '../../../zrdt/backends/appsStub.node.ts';
import {
  channelIdOf,
  safeComponent,
} from '../../../zrdt/backends/pieceStub.node.ts';
import {
  checkObjects,
  rawObject,
} from '../../../zrdt/backends/gitStub.node.ts';
import { validRefName } from '../../../zrdt/apps/gitBody.std.ts';
import {
  decodeRecord,
  encodeRecord,
  makeRecord,
  sha256,
  stubKeyTag,
} from '../../../zrdt/backends/stub.node.ts';
import {
  APP_GIT,
  APP_TORRENT,
  CHANNEL_GIT,
  CHANNEL_TORRENT,
  TEST_PIECE_EXP,
  compareStrings,
  concat,
  lenField,
  parseAppHeader,
  routeOfAppMessage,
  toHex,
  utf8,
  zrdtAppMessageBytes,
} from '../../../zrdt/apps/appMessage.std.ts';
import {
  pieceOfOpening,
  slicePiece,
  slicePieces,
} from '../../../zrdt/apps/pieces.std.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filled(length: number, byte: number): Bytes {
  return new Uint8Array(length).fill(byte);
}

type Member = Readonly<{
  name: string;
  aci: Bytes;
  key: Bytes;
  seat: AppSeat;
}>;

function member(name: string, byte: number): Member {
  const aci = filled(16, byte);
  const key = concat([Uint8Array.of(0x05), filled(32, byte)]);
  return { name, aci, key, seat: { aci, tag: stubKeyTag(key) } };
}

const alice = member('alice', 0xa1);
const bob = member('bob', 0xb2);
const carol = member('carol', 0xc3);
const dave = member('dave', 0xd4);
const eve = member('eve', 0xe5);

const SG = filled(32, 0x51);

async function runApp(
  stub: AppsStubBackend,
  req: AppRequest
): Promise<unknown> {
  switch (req.op) {
    case AppOp.CHANNEL:
      return stub.channel(req.signalGroup, req.app, req.name);
    case AppOp.PIECES_BIND:
      return stub.piecesBind(req);
    case AppOp.PIECE_ACCEPT:
      return stub.pieceAccept(req.pieceKey, req.index, req.piece);
    case AppOp.PIECE_OPENING:
      return stub.pieceOpening(req.pieceKey, req.index, req.piece);
    case AppOp.PIECES_COMPLETE:
      return stub.piecesComplete(req.pieceKey);
    case AppOp.ASSEMBLE:
      return stub.assemble(req.pieceKey, req.stream);
    case AppOp.BT_BUILD:
      return stub.btBuild(req);
    case AppOp.BT_FILE:
      return stub.btFile(req.pieceKey);
    case AppOp.GIT_PREPARE:
      return stub.gitPrepare(req);
    case AppOp.GIT_OBJECTS:
      return stub.gitObjects(req.pieceKey, req.stream);
    case AppOp.GIT_VIEW:
      return stub.gitView(req.signalGroup, req.channelKey, req.repo, req.helds);
    default:
      throw new Error('unknown op');
  }
}

/** Runs one app op through the codec both ways. */
async function call<O extends AppOp>(
  stub: AppsStubBackend,
  req: AppRequest & { op: O }
): Promise<AppResultOf[O]> {
  const payload = encodeAppRequest(req);
  const decoded = decodeRequest5(payload);
  assert.notStrictEqual(typeof decoded, 'number', `${AppOp[req.op]} decodes`);
  if (typeof decoded === 'number' || !isAppRequest(decoded)) {
    throw new Error('not an app request');
  }
  assert.strictEqual(
    toHex(encodeAppRequest(decoded)),
    toHex(payload),
    `${AppOp[req.op]} request re-encodes`
  );
  const result = (await runApp(stub, decoded)) as AppResultOf[O];
  const reply = encodeAppReply(req.op, result);
  const back = decodeAppReply(req.op, reply[0] ?? 0, reply.slice(1));
  assert.deepEqual(back, result, `${AppOp[req.op]} reply round trip`);
  return result;
}

/** One desktop: a stub and its channel store key. */
type Desk = { me: Member; stub: AppsStubBackend; channelKey: string };

async function desk(
  me: Member,
  channel: Bytes,
  relative = false
): Promise<Desk> {
  const stub = new AppsStubBackend({ env: {} });
  const channelKey = `app:conv-${me.name}:${toHex(channel)}`;
  if (relative) {
    await stub.createRelative(channelKey, channel);
  } else {
    await stub.create(channelKey, channel);
  }
  return { me, stub, channelKey };
}

async function audienceOf(
  stub: AppsStubBackend,
  members: ReadonlyArray<Member>
): Promise<Bytes> {
  const result = await stub.audience(
    members.map(m => ({ aci: m.aci, key: m.key }))
  );
  assert.strictEqual(result.kind, 'ok');
  return result.kind === 'ok' ? result.audience : new Uint8Array(0);
}

/** Content 205's value around committed bytes, with a nonce and links. */
function content205(
  committed: Bytes,
  nonce: Bytes,
  links: ReadonlyArray<Digest>
): Bytes {
  const meta = concat([...links.map(l => lenField(1, l)), lenField(2, nonce)]);
  return zrdtAppMessageBytes({
    groupV2: lenField(1, filled(32, 0x77)),
    meta,
    committed,
  });
}

type Published = Readonly<{
  digest: Digest;
  record: Bytes;
  opening: Bytes;
  bytes205: Bytes;
  links: ReadonlyArray<Digest>;
  author: Member;
}>;

/** The author commits A (from the 205 bytes) and accepts it into her channel. */
async function publish(
  d: Desk,
  channel: Bytes,
  committed: Bytes,
  nonceByte: number,
  links: ReadonlyArray<Digest> = []
): Promise<Published> {
  const nonce = filled(32, nonceByte);
  const bytes205 = content205(committed, nonce, links);
  const c = await d.stub.commit(channel, d.me.aci, nonce, bytes205);
  assert.strictEqual(c.kind, 'ok');
  if (c.kind !== 'ok') {
    throw new Error('commit');
  }
  assert.strictEqual(toHex(c.opening), toHex(concat([nonce, committed])));
  const a = await d.stub.accept(
    d.channelKey,
    { group: channel, commit: c.commit, links, author: d.me.aci },
    c.opening
  );
  assert.strictEqual(a.kind, 'accepted');
  if (a.kind !== 'accepted') {
    throw new Error('accept');
  }
  return {
    digest: a.digest,
    record: a.record,
    opening: c.opening,
    bytes205,
    links,
    author: d.me,
  };
}

/** A receiver commits the bytes as received and accepts A. */
async function receive(d: Desk, channel: Bytes, p: Published): Promise<void> {
  const nonce = p.opening.slice(0, 32);
  const c = await d.stub.commit(channel, p.author.aci, nonce, p.bytes205);
  assert.strictEqual(c.kind, 'ok');
  if (c.kind !== 'ok') {
    throw new Error('commit');
  }
  const a = await d.stub.accept(
    d.channelKey,
    { group: channel, commit: c.commit, links: p.links, author: p.author.aci },
    c.opening
  );
  assert.strictEqual(a.kind, 'accepted', `${d.me.name} accepts`);
}

async function bind(
  d: Desk,
  p: Published,
  app: string,
  pieceKey = toHex(p.digest)
): Promise<AppResultOf[AppOp.PIECES_BIND]> {
  return call(d.stub, {
    op: AppOp.PIECES_BIND,
    pieceKey,
    channelKey: d.channelKey,
    signalGroup: SG,
    app,
    ownAci: d.me.aci,
    ownKey: d.me.key,
    announcement: p.record,
    opening: p.opening,
  });
}

// ---------------------------------------------------------------------------
// The torrent beat (BUILD_M1 §A.1 at the frame level)
// ---------------------------------------------------------------------------

describe('zrdt apps: protocol-5 stub, torrent', () => {
  const stream = new Uint8Array(4 * 1024 + 300).map((_, i) => (i * 7) % 251);
  const pieces = slicePieces(stream, TEST_PIECE_EXP);

  it('slices a stream into pieces of 2^k bytes, the last short', () => {
    assert.strictEqual(pieces.length, 5);
    assert.strictEqual(pieces[4]?.length, 300);
    assert.deepEqual(slicePiece(stream, TEST_PIECE_EXP, 1), pieces[1]);
  });

  it('CHANNEL: one id per (signal group, app, name); limits', async () => {
    const stub = new AppsStubBackend({ env: {} });
    const r = await call(stub, {
      op: AppOp.CHANNEL,
      signalGroup: SG,
      app: APP_TORRENT,
      name: CHANNEL_TORRENT,
    });
    assert.deepEqual(r, {
      kind: 'ok',
      channel: channelIdOf(SG, utf8(APP_TORRENT), utf8(CHANNEL_TORRENT)),
    });
    const git = await call(stub, {
      op: AppOp.CHANNEL,
      signalGroup: SG,
      app: APP_GIT,
      name: CHANNEL_GIT,
    });
    assert.notDeepEqual(git, r);
    assert.deepEqual(
      await call(stub, {
        op: AppOp.CHANNEL,
        signalGroup: SG,
        app: '',
        name: CHANNEL_TORRENT,
      }),
      { kind: 'badApp', reason: 'limits' }
    );
  });

  it('runs the beat: build, bind, accept, missing, repair, complete, assemble', async () => {
    const channel = channelIdOf(SG, utf8(APP_TORRENT), utf8(CHANNEL_TORRENT));
    const a = await desk(alice, channel);
    const b = await desk(bob, channel);
    const c = await desk(carol, channel);
    const e = await desk(eve, channel);
    const audience = await audienceOf(a.stub, [alice, bob, carol, dave]);
    const pointers = utf8('pointers are opaque to zrdtd');

    const built = await call(a.stub, {
      op: AppOp.BT_BUILD,
      channel,
      author: alice.aci,
      nonce: filled(32, 0x99),
      exp: TEST_PIECE_EXP,
      audience,
      name: 'trip.mp4',
      pointers,
      stream,
    });
    assert.strictEqual(built.kind, 'ok');
    if (built.kind !== 'ok') {
      return;
    }
    assert.strictEqual(built.ordered.length, 5);
    const header = parseAppHeader(built.message);
    assert.isDefined(header, 'BT_BUILD returns a canonical app message');
    assert.strictEqual(
      toHex(header?.pointers ?? new Uint8Array()),
      toHex(pointers)
    );

    const A = await publish(a, channel, built.message, 0x01);
    const route = routeOfAppMessage(A.bytes205);
    assert.strictEqual(route?.app, APP_TORRENT);
    assert.strictEqual(route?.channel, CHANNEL_TORRENT);
    await receive(b, channel, A);
    await receive(c, channel, A);
    await receive(e, channel, A);
    const pieceKey = toHex(A.digest);

    // The author binds her own A like any receiver.
    const own = await bind(a, A, APP_TORRENT);
    assert.strictEqual(own.kind, 'ok');
    for (let i = 0; i < pieces.length; i += 1) {
      const r = await call(a.stub, {
        op: AppOp.PIECE_ACCEPT,
        pieceKey,
        index: i,
        piece: pieces[i] ?? new Uint8Array(),
      });
      assert.deepEqual(r, {
        kind: 'ok',
        digest: built.ordered[i] ?? new Uint8Array(),
      });
    }

    // Bob binds: the reply restates A's descriptor.
    const bound = await bind(b, A, APP_TORRENT);
    assert.strictEqual(bound.kind, 'ok');
    if (bound.kind === 'ok') {
      assert.strictEqual(bound.len, stream.length);
      assert.strictEqual(bound.exp, TEST_PIECE_EXP);
      assert.deepEqual(bound.ordered, built.ordered);
      assert.strictEqual(toHex(bound.body), toHex(utf8('zbt1')));
      assert.strictEqual(toHex(bound.pointers), toHex(pointers));
    }
    // The piece key is taken now.
    let threw: unknown;
    try {
      await b.stub.piecesBind({
        pieceKey,
        channelKey: b.channelKey,
        signalGroup: SG,
        app: APP_TORRENT,
        ownAci: bob.aci,
        ownKey: bob.key,
        announcement: A.record,
        opening: A.opening,
      });
    } catch (error) {
      threw = error;
    }
    assert.instanceOf(threw, ZrdtBackendError);
    assert.strictEqual(
      threw instanceof ZrdtBackendError && threw.code,
      'chatOpen'
    );

    // Bob gets pieces 0, 1, 3 from the CDN; 2 and 4 are missing.
    for (const i of [0, 1, 3]) {
      await call(b.stub, {
        op: AppOp.PIECE_ACCEPT,
        pieceKey,
        index: i,
        piece: pieces[i] ?? new Uint8Array(),
      });
    }
    // A wrong index, a flipped byte, a short piece: BAD_PIECE.
    const flipped = new Uint8Array(pieces[2] ?? new Uint8Array());
    flipped[5] = ((flipped[5] ?? 0) + 1) % 256;
    for (const [i, piece] of [
      [1, pieces[2]],
      [2, flipped],
      [4, pieces[4]?.slice(1)],
      [5, pieces[4]],
    ] as const) {
      assert.deepEqual(
        await call(b.stub, {
          op: AppOp.PIECE_ACCEPT,
          pieceKey,
          index: i,
          piece: piece ?? new Uint8Array(),
        }),
        { kind: 'badPiece' }
      );
    }
    const missing = await call(b.stub, {
      op: AppOp.PIECES_COMPLETE,
      pieceKey,
    });
    assert.strictEqual(missing.kind, 'missing');
    if (missing.kind === 'missing') {
      const want = [built.ordered[2], built.ordered[4]]
        .map(d => toHex(d ?? new Uint8Array()))
        .sort();
      assert.deepEqual(
        missing.digests.map(toHex),
        want,
        'the exact missing list'
      );
    }

    // Repair from Alice: PIECE_OPENING, then per-digest SERVE on her piece
    // store for Bob; Bob reads (i, bytes) from the openings.
    const helds = new Array<ServeHeld>();
    for (const i of [2, 4]) {
      const o = await call(a.stub, {
        op: AppOp.PIECE_OPENING,
        pieceKey,
        index: i,
        piece: pieces[i] ?? new Uint8Array(),
      });
      assert.strictEqual(o.kind, 'ok');
      if (o.kind === 'ok') {
        helds.push({
          digest: built.ordered[i] ?? new Uint8Array(),
          opening: o.opening,
        });
      }
    }
    const served = await a.stub.serve({
      chat: pieceKey,
      ownAci: alice.aci,
      requesterAci: bob.aci,
      key: bob.key,
      requestId: filled(16, 3),
      since: [],
      ownSince: [],
      mode: 'perDigest',
      wanted: helds.map(h => h.digest),
      forExport: false,
      strict: false,
      live: [],
      disown: [],
      held: helds,
    });
    assert.strictEqual(served.entries.length, 2);
    for (const entry of served.entries) {
      assert.strictEqual(entry.kind, 'addressed');
      if (entry.kind !== 'addressed' || entry.opening === undefined) {
        throw new Error('no opening');
      }
      const got = pieceOfOpening(entry.opening);
      assert.isDefined(got);
      if (got === undefined) {
        return;
      }
      // A villain's flipped byte is refused; the good bytes are taken.
      const bad = new Uint8Array(got.bytes);
      bad[0] = ((bad[0] ?? 0) + 1) % 256;
      assert.deepEqual(
        await call(b.stub, {
          op: AppOp.PIECE_ACCEPT,
          pieceKey,
          index: got.index,
          piece: bad,
        }),
        { kind: 'badPiece' }
      );
      const ok = await call(b.stub, {
        op: AppOp.PIECE_ACCEPT,
        pieceKey,
        index: got.index,
        piece: got.bytes,
      });
      assert.strictEqual(ok.kind, 'ok');
    }
    // SERVE does not hand Eve the content: she is not in A's audience.
    const toEve = await a.stub.serve({
      chat: pieceKey,
      ownAci: alice.aci,
      requesterAci: eve.aci,
      key: eve.key,
      requestId: filled(16, 4),
      since: [],
      ownSince: [],
      mode: 'perDigest',
      wanted: helds.map(h => h.digest),
      forExport: false,
      strict: false,
      live: [],
      disown: [],
      held: helds,
    });
    assert.isTrue(toEve.entries.every(x => x.kind === 'boundary'));

    const done = await call(b.stub, { op: AppOp.PIECES_COMPLETE, pieceKey });
    assert.strictEqual(done.kind, 'accepted');
    if (done.kind === 'accepted') {
      assert.deepEqual((await b.stub.heads(pieceKey)).map(toHex), [
        toHex(done.digest),
      ]);
      const F = decodeRecord(done.record);
      assert.deepEqual(
        F?.links.map(toHex),
        built.ordered.map(toHex).sort(),
        'F links the N pieces'
      );
    }
    assert.deepEqual(
      await call(b.stub, { op: AppOp.ASSEMBLE, pieceKey, stream }),
      { kind: 'ok' }
    );
    const tampered = new Uint8Array(stream);
    tampered[3000] = ((tampered[3000] ?? 0) + 1) % 256;
    assert.deepEqual(
      await call(b.stub, { op: AppOp.ASSEMBLE, pieceKey, stream: tampered }),
      { kind: 'badPiece', index: 2 }
    );
    assert.deepEqual(
      await call(b.stub, {
        op: AppOp.ASSEMBLE,
        pieceKey,
        stream: stream.slice(1),
      }),
      { kind: 'badPiece', index: 5 }
    );
    assert.deepEqual(await call(b.stub, { op: AppOp.BT_FILE, pieceKey }), {
      kind: 'ok',
      name: 'trip.mp4',
      len: stream.length,
    });

    // Eve is not seated: never offered, opened or fetched (T-m12).
    assert.deepEqual(await bind(e, A, APP_TORRENT), {
      kind: 'badApp',
      reason: 'notSeated',
    });
    // Carol binds under the wrong app, with a wrong opening, or before A is
    // stored: refused, and the key stays free.
    assert.deepEqual(await bind(c, A, APP_GIT), {
      kind: 'badApp',
      reason: 'notApp',
    });
    const wrongOpening = new Uint8Array(A.opening);
    wrongOpening[0] = ((wrongOpening[0] ?? 0) + 1) % 256;
    assert.deepEqual(
      await bind(c, { ...A, opening: wrongOpening }, APP_TORRENT),
      { kind: 'badApp', reason: 'opening' }
    );
    const other = makeRecord({
      group: channel,
      commit: filled(32, 9),
      links: [],
      author: alice.aci,
    });
    assert.deepEqual(
      await bind(c, { ...A, record: encodeRecord(other) }, APP_TORRENT),
      { kind: 'badApp', reason: 'notStored' }
    );
    assert.deepEqual(
      await bind(c, { ...A, record: filled(10, 1) }, APP_TORRENT),
      { kind: 'malformed' }
    );
    assert.strictEqual((await bind(c, A, APP_TORRENT)).kind, 'ok');

    // Protocol-4 ops on a piece key: no ACCEPT, no NEW; CLOSE drops it.
    let refused: unknown;
    try {
      await b.stub.acceptRecord(pieceKey, A.record, A.opening);
    } catch (error) {
      refused = error;
    }
    assert.strictEqual((refused as ZrdtBackendError).code, 'badInput');
    await b.stub.close(pieceKey);
    assert.isUndefined(b.stub.ctx(pieceKey));
    let gone: unknown;
    try {
      await b.stub.pieceAccept(pieceKey, 0, pieces[0] ?? new Uint8Array());
    } catch (error) {
      gone = error;
    }
    assert.strictEqual((gone as ZrdtBackendError).code, 'unknownChat');
  });

  it('BT_BUILD refuses unsafe names and broken limits', async () => {
    const stub = new AppsStubBackend({ env: {} });
    const audience = await audienceOf(stub, [alice, bob]);
    const base = {
      op: AppOp.BT_BUILD as const,
      channel: filled(32, 1),
      author: alice.aci,
      nonce: filled(32, 2),
      exp: TEST_PIECE_EXP,
      audience,
      name: 'ok.txt',
      pointers: new Uint8Array(0),
      stream,
    };
    for (const name of [
      '',
      '..',
      'a/b',
      'CON',
      'nul.txt',
      ' x',
      'x.',
      'a\u0001',
    ]) {
      assert.deepEqual(
        await call(stub, { ...base, name }),
        {
          kind: 'badName',
        },
        name
      );
      assert.isFalse(safeComponent(name));
    }
    assert.deepEqual(await call(stub, { ...base, exp: 12 }), {
      kind: 'badApp',
      reason: 'limits',
    });
    assert.deepEqual(
      await call(stub, { ...base, stream: new Uint8Array(65 * 1024) }),
      { kind: 'badApp', reason: 'limits' }
    );
    assert.deepEqual(await call(stub, { ...base, stream: new Uint8Array(0) }), {
      kind: 'badApp',
      reason: 'limits',
    });
  });

  it('decodes app op bytes the lanes do not define as UNKNOWN_OP', () => {
    assert.strictEqual(decodeRequest5(Uint8Array.of(0x1d)), Code.UNKNOWN_OP);
    assert.strictEqual(decodeRequest5(Uint8Array.of(0x2f)), Code.UNKNOWN_OP);
    assert.strictEqual(decodeRequest5(Uint8Array.of(0x30)), Code.UNKNOWN_OP);
    assert.strictEqual(decodeRequest5(Uint8Array.of(0x17)), Code.BAD_REQUEST);
  });
});

// ---------------------------------------------------------------------------
// The git beat (BUILD_M1 §A.2 at the frame level)
// ---------------------------------------------------------------------------

function oidOf(raw: Bytes): Oid {
  return sha256(raw);
}

function treeOf(
  entries: ReadonlyArray<{ mode: string; name: string; oid: Oid }>
): Bytes {
  return rawObject(
    'tree',
    concat(entries.map(e => concat([utf8(`${e.mode} ${e.name}\0`), e.oid])))
  );
}

function commitOf(tree: Oid, parents: ReadonlyArray<Oid>, msg: string): Bytes {
  const lines = [
    `tree ${toHex(tree)}`,
    ...parents.map(p => `parent ${toHex(p)}`),
    'author A <a@x> 1700000000 +0000',
    'committer A <a@x> 1700000000 +0000',
    '',
    msg,
  ];
  return rawObject('commit', utf8(lines.join('\n')));
}

function streamOf(raws: ReadonlyArray<Bytes>): Bytes {
  return concat(
    [...raws].sort((x, y) => compareStrings(toHex(oidOf(x)), toHex(oidOf(y))))
  );
}

describe('zrdt apps: protocol-5 stub, git', () => {
  const blob0 = rawObject('blob', utf8('hello\n'));
  const tree0 = treeOf([
    { mode: '100644', name: 'hello.txt', oid: oidOf(blob0) },
  ]);
  const c0 = commitOf(oidOf(tree0), [], 'c0');
  const blob1 = rawObject('blob', utf8('hello again\n'));
  const tree1 = treeOf([
    { mode: '100644', name: 'hello.txt', oid: oidOf(blob1) },
  ]);
  const c1 = commitOf(oidOf(tree1), [oidOf(c0)], 'c1');
  const blob2 = rawObject('blob', utf8('amended\n'));
  const tree2 = treeOf([
    { mode: '100644', name: 'hello.txt', oid: oidOf(blob2) },
  ]);
  const c2 = commitOf(oidOf(tree2), [oidOf(c0)], 'c2');
  const blob3 = rawObject('blob', utf8('carol\n'));
  const tree3 = treeOf([
    { mode: '100644', name: 'hello.txt', oid: oidOf(blob3) },
  ]);
  const c3 = commitOf(oidOf(tree3), [oidOf(c2)], 'c3');

  it('checks raw objects: ids, order, kinds, trees and commit headers', () => {
    const ok = checkObjects(streamOf([blob0, tree0, c0]));
    assert.isTrue(Array.isArray(ok));
    const tag = rawObject('tag', utf8('object x\n'));
    assert.deepEqual(checkObjects(tag), {
      kind: 'badObjects',
      reason: 'kind',
      oid: oidOf(tag),
    });
    const gitlink = treeOf([
      { mode: '160000', name: 'sub', oid: filled(32, 1) },
    ]);
    assert.strictEqual(
      (checkObjects(gitlink) as { reason: string }).reason,
      'gitlink'
    );
    const unsorted = concat(
      [blob0, tree0, c0].sort((x, y) =>
        toHex(oidOf(x)) < toHex(oidOf(y)) ? 1 : -1
      )
    );
    assert.strictEqual(
      (checkObjects(unsorted) as { reason: string }).reason,
      'order'
    );
    const signed = rawObject(
      'commit',
      utf8(
        `tree ${toHex(oidOf(tree0))}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\ngpgsig x\n\nm`
      )
    );
    assert.strictEqual(
      (checkObjects(signed) as { reason: string }).reason,
      'header'
    );
    assert.isTrue(validRefName('refs/heads/main'));
    for (const bad of [
      'main',
      'refs/heads/a..b',
      'refs/notes/x',
      'refs/heads/x.zrdt-1',
      'refs/heads/.x',
    ]) {
      assert.isFalse(validRefName(bad), bad);
    }
  });

  it('runs the beat: P1, forced P2, views, OLD_OBJECT, GATE, share, ROOT', async () => {
    const channel = channelIdOf(SG, utf8(APP_GIT), utf8(CHANNEL_GIT));
    const a = await desk(alice, channel);
    const b = await desk(bob, channel);
    const c = await desk(carol, channel);
    const founders = [alice, bob, carol];
    const audience = await audienceOf(a.stub, founders);
    const helds = new Map<Desk, Array<ServeHeld>>([
      [a, []],
      [b, []],
      [c, []],
    ]);
    const hold = (d: Desk, p: Published) =>
      helds.get(d)?.push({ digest: p.digest, opening: p.opening });

    const prepare = (
      d: Desk,
      q: Partial<{
        share: boolean;
        expect: ReadonlyArray<AppSeat>;
        updates: ReadonlyArray<GitUpdate>;
        stream: Bytes;
        audience: Bytes;
        pointers: Bytes;
      }>
    ) =>
      call(d.stub, {
        op: AppOp.GIT_PREPARE,
        signalGroup: SG,
        channelKey: d.channelKey,
        author: d.me.aci,
        nonce: filled(32, 0x42),
        exp: TEST_PIECE_EXP,
        audience: q.audience ?? audience,
        share: q.share ?? false,
        expect: q.expect ?? [],
        repo: 'demo',
        updates: q.updates ?? [],
        helds: helds.get(d) ?? [],
        pointers: q.pointers ?? utf8('ptrs'),
        stream: q.stream ?? new Uint8Array(0),
      });

    // 1. Alice pushes c0, c1 (her table is complete: the channel is empty).
    const p1 = await prepare(a, {
      updates: [{ name: 'refs/heads/main', new: oidOf(c1), forced: false }],
      stream: streamOf([blob0, tree0, c0, blob1, tree1, c1]),
    });
    assert.strictEqual(p1.kind, 'ok');
    if (p1.kind !== 'ok') {
      return;
    }
    const P1 = await publish(a, channel, p1.message, 0x11);
    hold(a, P1);
    for (const d of [b, c]) {
      await receive(d, channel, P1);
      hold(d, P1);
    }

    // 2. Bob binds P1 and lists its objects.
    assert.strictEqual((await bind(b, P1, APP_GIT)).kind, 'ok');
    const p1Stream = streamOf([blob0, tree0, c0, blob1, tree1, c1]);
    for (const [i, piece] of slicePieces(p1Stream, TEST_PIECE_EXP).entries()) {
      await b.stub.pieceAccept(toHex(P1.digest), i, piece);
    }
    const objects = await call(b.stub, {
      op: AppOp.GIT_OBJECTS,
      pieceKey: toHex(P1.digest),
      stream: p1Stream,
    });
    assert.strictEqual(objects.kind, 'ok');
    if (objects.kind === 'ok') {
      assert.strictEqual(objects.objects.length, 6);
      const first = objects.objects[0];
      if (first) {
        assert.strictEqual(
          toHex(
            oidOf(p1Stream.slice(first.offset, first.offset + first.length))
          ),
          toHex(first.oid)
        );
      }
    }
    assert.deepEqual(
      await call(b.stub, { op: AppOp.BT_FILE, pieceKey: toHex(P1.digest) }),
      { kind: 'badApp', reason: 'wrongApp' }
    );

    // A re-push of history the table holds: OLD_OBJECT.
    const again = await prepare(b, {
      updates: [{ name: 'refs/heads/other', new: oidOf(c1), forced: false }],
      stream: streamOf([blob1, tree1, c1]),
    });
    assert.strictEqual(again.kind, 'pushRefused');
    if (again.kind === 'pushRefused') {
      assert.strictEqual(again.reason, 'oldObject');
      assert.strictEqual(again.oids.length, 3);
    }

    // 3. Bob force-pushes c2 (parent c0): the gate passes.
    const p2 = await prepare(b, {
      updates: [
        {
          name: 'refs/heads/main',
          old: oidOf(c1),
          new: oidOf(c2),
          forced: true,
        },
      ],
      stream: streamOf([blob2, tree2, c2]),
    });
    assert.strictEqual(p2.kind, 'ok');
    if (p2.kind !== 'ok') {
      return;
    }
    const P2 = await publish(b, channel, p2.message, 0x12, [P1.digest]);
    hold(b, P2);
    for (const d of [a, c]) {
      await receive(d, channel, P2);
      hold(d, P2);
    }

    // 4. The logs agree, and main = c2 on every screen.
    const views = new Array<unknown>();
    for (const d of [a, b, c]) {
      const v = await call(d.stub, {
        op: AppOp.GIT_VIEW,
        signalGroup: SG,
        channelKey: d.channelKey,
        repo: 'demo',
        helds: helds.get(d) ?? [],
      });
      assert.strictEqual(v.kind, 'ok');
      if (v.kind === 'ok') {
        assert.strictEqual(v.log.length, 2);
        assert.deepEqual(
          v.refs.map(r => [r.name, toHex(r.value ?? new Uint8Array())]),
          [['refs/heads/main', toHex(oidOf(c2))]]
        );
        assert.isTrue(v.log.some(x => x.update.forced));
      }
      views.push(v);
    }
    assert.deepEqual(views[0], views[1]);
    assert.deepEqual(views[1], views[2]);
    // A view without the openings: OPENINGS_MISSING.
    const noOpenings = await call(c.stub, {
      op: AppOp.GIT_VIEW,
      signalGroup: SG,
      channelKey: c.channelKey,
      repo: 'demo',
      helds: [],
    });
    assert.strictEqual(noOpenings.kind, 'openingsMissing');

    // 6. Carol's push to an audience with Dave (new): GATE, Dave marked new.
    const withDave = await audienceOf(c.stub, [...founders, dave]);
    const p3 = {
      updates: [
        {
          name: 'refs/heads/main',
          old: oidOf(c2),
          new: oidOf(c3),
          forced: false,
        },
      ],
      stream: streamOf([blob3, tree3, c3]),
      audience: withDave,
    };
    const gate = await prepare(c, p3);
    assert.strictEqual(gate.kind, 'pushRefused');
    if (gate.kind === 'pushRefused') {
      assert.strictEqual(gate.reason, 'gate');
      assert.deepEqual(gate.seats, [{ seat: dave.seat, mark: 'new' }]);
      assert.deepEqual(gate.refs, ['refs/heads/main']);
    }

    // 7. Alice shares main@c2 with Dave: COVERS_CHANGED [Dave], then OK.
    const share = {
      share: true,
      updates: [
        {
          name: 'refs/heads/main',
          old: oidOf(c2),
          new: oidOf(c2),
          forced: false,
        },
      ],
      stream: streamOf([blob2, tree2, c2]),
      audience: withDave,
    };
    const first = await prepare(a, share);
    assert.strictEqual(first.kind, 'pushRefused');
    if (first.kind === 'pushRefused') {
      assert.strictEqual(first.reason, 'coversChanged');
      assert.deepEqual(first.seats, [{ seat: dave.seat, mark: 'covered' }]);
    }
    const confirmed = await prepare(a, {
      ...share,
      expect: sortSeats([dave.seat]),
    });
    assert.strictEqual(confirmed.kind, 'ok');
    if (confirmed.kind !== 'ok') {
      return;
    }
    assert.deepEqual(confirmed.covers, [dave.seat]);
    const S = await publish(a, channel, confirmed.message, 0x13, [P2.digest]);
    hold(a, S);
    await receive(c, channel, S);
    hold(c, S);
    // 8. Carol's P3 passes now: Dave holds c2 through S, which assigned main := c2.
    assert.strictEqual((await prepare(c, p3)).kind, 'ok');

    // A share that carries a commit it does not name: BAD_SHARE.
    const badShare = await prepare(a, {
      ...share,
      stream: streamOf([blob1, tree1, c1, blob2, tree2, c2]),
      expect: [dave.seat],
    });
    assert.deepEqual(
      badShare.kind === 'pushRefused' ? badShare.reason : badShare.kind,
      'badShare'
    );

    // A newcomer's relative store (a boundary digest): a root commit is ROOT.
    const d = await desk(dave, channel, true);
    await d.stub.acceptView(
      d.channelKey,
      alice.aci,
      false,
      'catchup',
      [{ kind: 'boundary', digest: P1.digest }],
      []
    );
    const blobX = rawObject('blob', utf8('new history\n'));
    const treeX = treeOf([{ mode: '100644', name: 'x', oid: oidOf(blobX) }]);
    const cX = commitOf(oidOf(treeX), [], 'root');
    const root = await call(d.stub, {
      op: AppOp.GIT_PREPARE,
      signalGroup: SG,
      channelKey: d.channelKey,
      author: dave.aci,
      nonce: filled(32, 0x43),
      exp: TEST_PIECE_EXP,
      audience: withDave,
      share: false,
      expect: [],
      repo: 'other',
      updates: [{ name: 'refs/heads/main', new: oidOf(cX), forced: false }],
      helds: [],
      pointers: new Uint8Array(0),
      stream: streamOf([blobX, treeX, cX]),
    });
    assert.strictEqual(root.kind, 'pushRefused');
    if (root.kind === 'pushRefused') {
      assert.strictEqual(root.reason, 'root');
      assert.deepEqual(root.oids.map(toHex), [toHex(oidOf(cX))]);
    }

    // The wrong Signal group: BAD_APP 1.
    const wrong = await call(a.stub, {
      op: AppOp.GIT_VIEW,
      signalGroup: filled(32, 0x52),
      channelKey: a.channelKey,
      repo: 'demo',
      helds: helds.get(a) ?? [],
    });
    assert.deepEqual(wrong, { kind: 'badApp', reason: 'notStored' });
  });
});
