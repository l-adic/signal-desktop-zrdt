// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable no-await-in-loop, no-loop-func

// Rung 7 (zrdt docs/PLAN.md section 6): the TypeScript stub against the Lean
// reference. Three comparisons:
//
// 1. zrdt/vectors/vectors.json (written by the Lean code): the static
//    encodings, and every session step run on a fresh stub, through
//    codec.decodeRequest -> StubBackend -> codec.encodeReply, compared byte
//    for byte with Lean's reply.
// 2. The same sessions on zrdtd: raw frames (rung 6, here in TypeScript),
//    and through the typed DaemonBackend (its request encoders and reply
//    decoders).
// 3. A randomized differential: the same random op sequence on the stub and
//    on zrdtd, typed replies compared.
//
// zrdtd: $ZRDTD, else zrdt/core/.lake/build/bin/zrdtd (cd zrdt/core && lake
// build). Without it, parts 2 and 3 are skipped.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assert } from 'chai';

import {
  PROTOCOL_VERSION,
  ZrdtBackendError,
} from '../../zrdt/ZrdtBackend.std.ts';
import type {
  Bytes,
  Digest,
  ProvenanceFact,
  RecordParts,
  ZrdtBackend,
} from '../../zrdt/ZrdtBackend.std.ts';
import {
  Code,
  Op,
  concatBytes,
  decodeReply,
  decodeRequest,
  encodeReply,
  encodeRequestBody,
} from '../../zrdt/backends/codec.std.ts';
import type {
  ReplyOptions,
  Request,
  ResultOf,
} from '../../zrdt/backends/codec.std.ts';
import { DaemonBackend } from '../../zrdt/backends/daemon.node.ts';
import {
  StubBackend,
  commitWithOpening,
  decodeBlob,
  decodeRecord,
  encodeRecord,
  hashRecord,
  makeRecord,
  sha256,
} from '../../zrdt/backends/stub.node.ts';

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

type Step = Readonly<{
  name: string;
  op: string;
  status: string;
  request: string;
  reply: string;
  buildDependent?: boolean;
}>;

type Vectors = Readonly<{
  protocol: number;
  build: string;
  sha256: ReadonlyArray<{
    name: string;
    input?: string;
    repeatByte?: string;
    count?: string;
    digest: string;
  }>;
  records: ReadonlyArray<{
    name: string;
    group: string;
    commit: string;
    linksGiven: ReadonlyArray<string>;
    links: ReadonlyArray<string>;
    author: string;
    encoding: string;
    digest: string;
  }>;
  recordDecode: ReadonlyArray<{
    name: string;
    bytes: string;
    decodes: boolean;
  }>;
  blobs: ReadonlyArray<{
    name: string;
    group: string;
    records: ReadonlyArray<string>;
    blob: string;
  }>;
  blobDecode: ReadonlyArray<{ name: string; bytes: string; decodes: boolean }>;
  commit: ReadonlyArray<{
    name: string;
    group: string;
    author: string;
    nonce: string;
    dataMessage: string;
    committedBytes: string | null;
    commit: string | null;
  }>;
  sessions: ReadonlyArray<{ name: string; steps: ReadonlyArray<Step> }>;
}>;

const VECTORS_PATH = join(process.cwd(), 'zrdt', 'vectors', 'vectors.json');
const ZRDTD =
  process.env.ZRDTD ??
  join(process.cwd(), 'zrdt', 'core', '.lake', 'build', 'bin', 'zrdtd');

function fromHex(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

function hex(bytes: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(bytes).toString('hex');
}

function loadVectors(): Vectors {
  return JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;
}

/** Whether the vectors carry the lead's extended ACCEPT and COMMIT replies. */
function replyOptions(vectors: Vectors): ReplyOptions {
  for (const session of vectors.sessions) {
    for (const step of session.steps) {
      if (step.op === 'ACCEPT' && step.status === 'OK') {
        return { extended: step.reply.length > 2 + 64 };
      }
    }
  }
  return { extended: false };
}

function hasAcceptRecord(vectors: Vectors): boolean {
  return vectors.sessions.some(s =>
    s.steps.some(step => step.op === 'ACCEPT_RECORD')
  );
}

// ---------------------------------------------------------------------------
// Running a typed request on a backend
// ---------------------------------------------------------------------------

async function runTyped(
  backend: ZrdtBackend,
  req: Request
): Promise<ResultOf[Op]> {
  switch (req.op) {
    case Op.VERSION:
      return backend.version();
    case Op.NEW:
      await backend.create(req.chat, req.group);
      return undefined;
    case Op.OPEN:
      return backend.open(req.chat, req.group, req.input);
    case Op.SALVAGE:
      return backend.salvage(req.chat, req.group, req.input);
    case Op.COMMIT:
      return backend.commit(req.group, req.author, req.nonce, req.dataMessage);
    case Op.HASH:
      return backend.hash(req.parts);
    case Op.ACCEPT:
      return backend.accept(req.chat, req.parts, req.opening);
    case Op.HEADS:
      return backend.heads(req.chat);
    case Op.HAS:
      return backend.has(req.chat, req.digest);
    case Op.GET:
      return backend.get(req.chat, req.digest);
    case Op.REACH_SET:
      return backend.reachSet(req.chat, req.from);
    case Op.MERGE:
      return backend.merge(req.chat, req.blob);
    case Op.CLASSIFY:
      return backend.classify(req.chat, req.facts);
    case Op.ENCODE:
      return backend.encode(req.chat);
    case Op.CLOSE:
      await backend.close(req.chat);
      return undefined;
    case Op.ACCEPT_RECORD:
      return backend.acceptRecord(req.chat, req.record, req.opening);
    case Op.AUDIENCE:
      return backend.audience(req.members);
    case Op.SERVE:
      return backend.serve(req);
    case Op.ADDRESSED:
      return backend.addressed(req.chat, req.aci, req.key);
    default:
      throw new Error('unknown op');
  }
}

/** A request payload in, a reply payload out, as zrdtd would answer. */
async function serve(
  backend: ZrdtBackend,
  payload: Bytes,
  options: ReplyOptions & { withAcceptRecord: boolean; protocol?: number }
): Promise<Bytes> {
  const req = decodeRequest(payload, options);
  if (typeof req === 'number') {
    return Uint8Array.of(req);
  }
  try {
    const result = await runTyped(backend, req);
    return encodeReply(req.op, result, options);
  } catch (error) {
    if (error instanceof ZrdtBackendError) {
      if (error.code === 'unknownChat') {
        return Uint8Array.of(Code.NO_CHAT);
      }
      if (error.code === 'chatOpen') {
        return Uint8Array.of(Code.CHAT_OPEN);
      }
      if (error.code === 'badInput') {
        return Uint8Array.of(Code.BAD_REQUEST);
      }
    }
    throw error;
  }
}

/**
 * Steps where the Lean of these vectors differs from a decision the lead
 * made after wave 1, which the stub already follows and lane T5 is putting
 * into Lean: step name -> the reply the decision gives. Once vectors.json
 * from build/t5-core gives these replies, the entries are inert.
 */
const PENDING_T5: ReadonlyMap<string, string> = new Map([
  // Lead decision (3): a blob count >= 2^24 is TOO_LARGE, checked first.
  [
    'OPEN a blob whose header claims 2^32 - 1 records: malformed, nothing allocated',
    '04',
  ],
  ['SALVAGE the same blob', '04'],
]);

/** Compares a reply, or only status and protocol for build-dependent steps. */
function expectReply(step: Step, actual: Bytes, label: string): void {
  const decided = PENDING_T5.get(step.name);
  if (
    decided !== undefined &&
    label === 'stub' &&
    hex(actual) === decided &&
    step.reply !== decided
  ) {
    // eslint-disable-next-line no-console
    console.log(
      `      (pending T5) ${step.name}: Lean ${step.reply}, stub ${decided}`
    );
    return;
  }
  if (step.buildDependent) {
    assert.strictEqual(
      hex(actual).slice(0, 10),
      step.reply.slice(0, 10),
      `${label}: ${step.name} (status and protocol)`
    );
    return;
  }
  assert.strictEqual(hex(actual), step.reply, `${label}: ${step.name}`);
}

// ---------------------------------------------------------------------------
// A small deterministic PRNG for the randomized differential
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  // Park-Miller: state stays below 2^31, products below 2^53.
  let state = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('zrdt rung 7: stub vs Lean (vectors.json, zrdtd)', function (this: Mocha.Suite) {
  this.timeout(120_000);

  const vectors = loadVectors();
  const options = {
    ...replyOptions(vectors),
    withAcceptRecord: hasAcceptRecord(vectors),
    protocol: vectors.protocol,
  };
  // The sessions pin frames of one protocol. Vectors of an older protocol
  // (the zrdt submodule before the join core lands) cannot run on a
  // protocol-3 stub, and that checkout's zrdtd speaks the older protocol too.
  const sameProtocol = vectors.protocol === PROTOCOL_VERSION;
  const describeSessions = sameProtocol ? describe : () => undefined;
  if (!sameProtocol) {
    // eslint-disable-next-line no-console
    console.log(
      `      vectors.json is protocol ${vectors.protocol}, the host ` +
        `${PROTOCOL_VERSION}: sessions skipped until the vectors are regenerated`
    );
  }

  describe('static encodings on the stub', () => {
    it('sha256', () => {
      for (const v of vectors.sha256) {
        const input =
          v.input !== undefined
            ? fromHex(v.input)
            : new Uint8Array(Number(v.count)).fill(
                parseInt(v.repeatByte ?? '00', 16)
              );
        assert.strictEqual(hex(sha256(input)), v.digest, v.name);
      }
    });

    it('records: encoding and digest', () => {
      for (const v of vectors.records) {
        const record = makeRecord({
          group: fromHex(v.group),
          commit: fromHex(v.commit),
          links: v.linksGiven.map(fromHex),
          author: fromHex(v.author),
        });
        assert.deepEqual(record.links.map(hex), [...v.links], v.name);
        assert.strictEqual(hex(encodeRecord(record)), v.encoding, v.name);
        assert.strictEqual(hex(hashRecord(record)), v.digest, v.name);
      }
    });

    it('records: strict decode', () => {
      for (const v of vectors.recordDecode) {
        assert.strictEqual(
          decodeRecord(fromHex(v.bytes)) !== undefined,
          v.decodes,
          v.name
        );
      }
    });

    it('blobs: decode', () => {
      for (const v of vectors.blobDecode) {
        assert.strictEqual(
          decodeBlob(fromHex(v.bytes)).kind === 'ok',
          v.decodes,
          v.name
        );
      }
    });

    it('blobs: the stub encodes the same blob', async () => {
      for (const v of vectors.blobs) {
        const stub = new StubBackend({ env: {} });
        const group = fromHex(v.group);
        const result = await stub.open('blob', group, v.records.map(fromHex));
        if (result.kind !== 'ok') {
          // A doctored blob: Lean's encoder still wrote it; the stub must
          // refuse to open it the same way OPEN does.
          assert.strictEqual(result.kind, 'unverifiable', v.name);
          continue;
        }
        assert.strictEqual(hex(await stub.encode('blob')), v.blob, v.name);
      }
    });

    it('commit: committed bytes and commitment', () => {
      for (const v of vectors.commit) {
        const result = commitWithOpening(
          fromHex(v.group),
          fromHex(v.author),
          fromHex(v.nonce),
          fromHex(v.dataMessage)
        );
        if (v.commit == null || v.committedBytes == null) {
          assert.strictEqual(result.kind, 'malformed', v.name);
          continue;
        }
        assert.strictEqual(result.kind, 'ok', v.name);
        if (result.kind === 'ok') {
          assert.strictEqual(
            hex(result.opening),
            v.nonce + v.committedBytes,
            v.name
          );
          assert.strictEqual(hex(result.commit), v.commit, v.name);
        }
      }
    });
  });

  describeSessions('sessions on the stub', () => {
    for (const session of vectors.sessions) {
      it(`session ${session.name}`, async () => {
        const stub = new StubBackend({ env: {} });
        for (const step of session.steps) {
          // oxlint-disable-next-line no-await-in-loop
          const reply = await serve(stub, fromHex(step.request), options);
          expectReply(step, reply, 'stub');
        }
      });
    }
  });

  const haveDaemon = existsSync(ZRDTD) && sameProtocol;
  const describeDaemon = haveDaemon ? describe : () => undefined;

  describeDaemon(`sessions on zrdtd (${ZRDTD})`, () => {
    let daemon: DaemonBackend | undefined;
    afterEach(() => {
      daemon?.dispose();
      daemon = undefined;
    });

    for (const session of vectors.sessions) {
      it(`raw frames: session ${session.name}`, async () => {
        daemon = new DaemonBackend({ path: ZRDTD });
        for (const step of session.steps) {
          // oxlint-disable-next-line no-await-in-loop
          const frame = await daemon.callRaw(fromHex(step.request));
          const reply = concatBytes([Uint8Array.of(frame.tag), frame.body]);
          expectReply(step, reply, 'zrdtd raw');
        }
      });

      it(`typed DaemonBackend: session ${session.name}`, async () => {
        daemon = new DaemonBackend({ path: ZRDTD });
        const backend = daemon;
        for (const step of session.steps) {
          // oxlint-disable-next-line no-await-in-loop
          const reply = await serve(backend, fromHex(step.request), options);
          expectReply(step, reply, 'zrdtd typed');
        }
      });
    }
  });

  describeDaemon('randomized differential: stub vs zrdtd', () => {
    let daemon: DaemonBackend | undefined;
    afterEach(() => {
      daemon?.dispose();
      daemon = undefined;
    });
    // Which (op, reply status) pairs the random runs reached.
    const coverage = new Map<string, number>();
    after(() => {
      const line = [...coverage.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, n]) => `${k}: ${n}`)
        .join(', ');
      // eslint-disable-next-line no-console
      console.log(`      coverage: ${line}`);
    });

    // ZRDT_DIFF_SEEDS=n runs seeds 1..n (default 4).
    const seedCount = Number(process.env.ZRDT_DIFF_SEEDS ?? 4);
    for (let seed = 1; seed <= seedCount; seed += 1) {
      it(`seed ${seed}: 400 random ops give the same replies`, async () => {
        daemon = new DaemonBackend({ path: ZRDTD });
        const stub = new StubBackend({ env: {} });
        const lean: ZrdtBackend = daemon;
        const random = prng(seed);
        const pick = <T>(items: ReadonlyArray<T>): T => {
          const item = items[Math.floor(random() * items.length)];
          if (item === undefined) {
            throw new Error('empty');
          }
          return item;
        };
        const bytes = (n: number, fill?: number): Bytes => {
          const out = new Uint8Array(n);
          for (let i = 0; i < n; i += 1) {
            out[i] = fill ?? Math.floor(random() * 256);
          }
          return out;
        };

        const groups = [bytes(32, 0x67), bytes(32, 0x68)];
        const authors = [bytes(16, 0xa1), bytes(16, 0xb0), bytes(16, 0xc0)];
        const chats = ['camping', 'other', 'third'];
        const known = new Array<Digest>();
        const records = new Array<Bytes>();
        const blobs = new Array<Bytes>();
        const extended = { extended: true, withAcceptRecord: true };

        const both = async (req: Request, label: string): Promise<void> => {
          const payload = concatBytes([
            Uint8Array.of(req.op),
            encodeRequestBody(req),
          ]);
          const [a, b] = await Promise.all([
            serve(stub, payload, extended),
            serve(lean, payload, extended),
          ]);
          assert.strictEqual(hex(a), hex(b), `seed ${seed}: ${label}`);
          const k = `${Op[req.op]} ${Code[a[0] ?? 0] ?? a[0]}`;
          coverage.set(k, (coverage.get(k) ?? 0) + 1);
          // Learn digests and records from accepted replies.
          if (
            (req.op === Op.ACCEPT || req.op === Op.ACCEPT_RECORD) &&
            a[0] === Code.OK
          ) {
            known.push(a.slice(1, 33));
            records.push(a.slice(37));
          }
          if (req.op === Op.ENCODE && a[0] === Code.OK) {
            blobs.push(a.slice(5));
          }
        };

        for (const chat of chats) {
          // oxlint-disable-next-line no-await-in-loop
          await both({ op: Op.NEW, chat, group: pick(groups) }, `NEW ${chat}`);
        }

        for (let i = 0; i < 400; i += 1) {
          const chat = pick(chats);
          const roll = random();
          let req: Request;
          if (roll < 0.35) {
            const links = new Array<Digest>();
            const n = Math.floor(random() * 4);
            for (let j = 0; j < n; j += 1) {
              links.push(
                known.length > 0 && random() < 0.9 ? pick(known) : bytes(32)
              );
            }
            const parts: RecordParts = {
              group: random() < 0.9 ? (groups[0] ?? bytes(32)) : pick(groups),
              commit: bytes(32),
              links,
              author: pick(authors),
            };
            req = { op: Op.ACCEPT, chat, parts };
          } else if (roll < 0.45) {
            req = { op: Op.HEADS, chat };
          } else if (roll < 0.5) {
            req = {
              op: Op.HAS,
              chat,
              digest: known.length > 0 ? pick(known) : bytes(32),
            };
          } else if (roll < 0.55) {
            req = {
              op: Op.GET,
              chat,
              digest:
                known.length > 0 && random() < 0.8 ? pick(known) : bytes(32),
            };
          } else if (roll < 0.6) {
            req = {
              op: Op.REACH_SET,
              chat,
              from: known.length > 0 ? [pick(known), bytes(32)] : [],
            };
          } else if (roll < 0.65) {
            req = { op: Op.ENCODE, chat };
          } else if (roll < 0.7 && blobs.length > 0) {
            req = { op: Op.MERGE, chat, blob: pick(blobs) };
          } else if (roll < 0.75 && records.length > 0) {
            // OPEN or SALVAGE of a random subset of records under a fresh key.
            const subset = records.filter(() => random() < 0.6);
            const key = `scratch-${i}`;
            req = {
              op: random() < 0.5 ? Op.OPEN : Op.SALVAGE,
              chat: key,
              group: pick(groups),
              input:
                random() < 0.5 || blobs.length === 0 ? subset : pick(blobs),
            };
          } else if (roll < 0.85) {
            const facts = new Array<ProvenanceFact>();
            for (const digest of known) {
              const r = random();
              if (r < 0.4) {
                facts.push({
                  digest,
                  provenance: { kind: 'live' },
                  disown:
                    random() < 0.2 && known.length > 0 ? [pick(known)] : [],
                });
              } else if (r < 0.5) {
                facts.push({
                  digest,
                  provenance: { kind: 'relayed', by: pick(authors) },
                  disown: [],
                });
              } else if (r < 0.6) {
                facts.push({
                  digest,
                  provenance: { kind: 'imported' },
                  disown: [],
                });
              }
            }
            req = { op: Op.CLASSIFY, chat, facts };
          } else if (roll < 0.9) {
            // A DataMessage: body (field 1), field 15, field 200, or junk.
            const dm = pick([
              fromHex('0a0568656c6c6f'),
              fromHex('0a0268697a020000c20c00'),
              fromHex('0f'),
              bytes(Math.floor(random() * 8)),
            ]);
            req = {
              op: Op.COMMIT,
              group: pick(groups),
              author: pick(authors),
              nonce: bytes(32),
              dataMessage: dm,
            };
          } else if (roll < 0.93 && records.length > 0) {
            // ACCEPT_RECORD: a known record (maybe from another chat), cut
            // short, or with a junk opening.
            const record = pick(records);
            const r = random();
            req = {
              op: Op.ACCEPT_RECORD,
              chat,
              record: r < 0.1 ? record.subarray(1) : record,
              opening:
                r > 0.7 ? bytes(32 + Math.floor(random() * 6)) : undefined,
            };
          } else if (roll < 0.96 && records.length > 0) {
            req = {
              op: Op.HASH,
              parts: makeRecord(
                decodeRecord(pick(records)) ?? {
                  group: bytes(32),
                  commit: bytes(32),
                  links: [],
                  author: bytes(16),
                }
              ),
            };
          } else {
            req = {
              op: Op.CLOSE,
              chat: `scratch-${Math.floor(random() * i)}`,
            };
          }
          // oxlint-disable-next-line no-await-in-loop
          await both(req, `step ${i} ${Op[req.op]}`);
        }
        // Finally the whole stores must agree.
        for (const chat of chats) {
          // oxlint-disable-next-line no-await-in-loop
          await both({ op: Op.ENCODE, chat }, `final ENCODE ${chat}`);
        }
        assert.isAbove(known.length, 10, 'the run accepted records');
      });
    }
  });

  // Protocol 3 (JOIN_PLAN §3.2, §5): records with audiences, then AUDIENCE,
  // ACCEPT with an opening, SERVE and ADDRESSED with random queries, on the
  // stub and on zrdtd, replies compared byte for byte.
  describeDaemon('randomized SERVE differential: stub vs zrdtd', () => {
    let daemon: DaemonBackend | undefined;
    afterEach(() => {
      daemon?.dispose();
      daemon = undefined;
    });

    const seedCount = Number(process.env.ZRDT_DIFF_SEEDS ?? 4);
    for (let seed = 1; seed <= seedCount; seed += 1) {
      it(`seed ${seed}: 150 records and queries give the same replies`, async () => {
        daemon = new DaemonBackend({ path: ZRDTD });
        const stub = new StubBackend({ env: {} });
        const lean: ZrdtBackend = daemon;
        const random = prng(1000 + seed);
        const pick = <T>(items: ReadonlyArray<T>): T => {
          const item = items[Math.floor(random() * items.length)];
          if (item === undefined) {
            throw new Error('empty');
          }
          return item;
        };
        const some = <T>(items: ReadonlyArray<T>, p: number): Array<T> =>
          items.filter(() => random() < p);
        const fill = (n: number, b: number): Bytes => new Uint8Array(n).fill(b);
        const group = fill(32, 0x67);
        const chat = 'camping';
        const members = [0xa1, 0xb0, 0xc0, 0xd0].map(b => fill(16, b));
        const keys = [0x05, 0x06, 0x07, 0x08, 0x09].map(b => fill(33, b));
        const known = new Array<Digest>();
        const openings = new Array<{ digest: Digest; opening: Bytes }>();
        let nonceByte = 0;
        // What the SERVE replies held, so the run is known to reach content.
        let served = 0;
        let content = 0;
        let structure = 0;

        const both = async (req: Request, label: string): Promise<Bytes> => {
          const payload = concatBytes([
            Uint8Array.of(req.op),
            encodeRequestBody(req),
          ]);
          const opts = { extended: true, withAcceptRecord: true };
          const [a, b] = await Promise.all([
            serve(stub, payload, opts),
            serve(lean, payload, opts),
          ]);
          assert.strictEqual(hex(a), hex(b), `seed ${seed}: ${label}`);
          return a;
        };

        await both({ op: Op.NEW, chat, group }, 'NEW');
        for (let i = 0; i < 150; i += 1) {
          // A record: its author's audience, committed, accepted with it.
          const author = pick(members);
          const audienceMembers = some(members, 0.7).map(aci =>
            random() < 0.8 ? { aci, key: pick(keys) } : { aci }
          );
          // oxlint-disable-next-line no-await-in-loop
          const aud = await both(
            { op: Op.AUDIENCE, members: audienceMembers },
            `step ${i} AUDIENCE`
          );
          const body = new TextEncoder().encode(`m${i}`);
          const field201 =
            aud[0] === Code.OK && random() < 0.9
              ? [0xca, 0x0c, aud.length - 5, ...aud.subarray(5)]
              : [];
          const ephemeral = random() < 0.15 ? [0x28, 60] : [];
          const dataMessage = new Uint8Array([
            0x0a,
            body.length,
            ...body,
            ...ephemeral,
            ...field201,
          ]);
          nonceByte = (nonceByte + 1) % 256;
          const nonce = fill(32, nonceByte);
          // oxlint-disable-next-line no-await-in-loop
          const committed = await stub.commit(
            group,
            author,
            nonce,
            dataMessage
          );
          if (committed.kind !== 'ok') {
            continue;
          }
          const links = some(known, 0.2).slice(0, 3);
          const opening = random() < 0.9 ? committed.opening : undefined;
          // oxlint-disable-next-line no-await-in-loop
          const accepted = await both(
            {
              op: Op.ACCEPT,
              chat,
              parts: { group, commit: committed.commit, links, author },
              opening,
            },
            `step ${i} ACCEPT`
          );
          if (accepted[0] === Code.OK) {
            const digest = accepted.slice(1, 33);
            known.push(digest);
            if (opening !== undefined && random() < 0.8) {
              openings.push({ digest, opening });
            }
          }

          if (random() < 0.4 && known.length > 0) {
            const perDigest = random() < 0.4;
            // oxlint-disable-next-line no-await-in-loop
            const reply = await both(
              {
                op: Op.SERVE,
                chat,
                ownAci: pick(members),
                requesterAci: pick(members),
                key: pick(keys),
                requestId: fill(16, i % 256),
                since: some(known, 0.1),
                ownSince: some(known, 0.05),
                mode: perDigest ? 'perDigest' : 'catchup',
                wanted: perDigest ? some(known, 0.3) : [],
                forExport: random() < 0.3,
                strict: random() < 0.2,
                live: some(known, 0.5),
                disown: some(known, 0.1),
                held: some(openings, 0.7),
              },
              `step ${i} SERVE`
            );
            const decoded = decodeReply(
              Op.SERVE,
              reply[0] ?? 0,
              reply.slice(1)
            );
            served += 1;
            for (const entry of decoded?.entries ?? []) {
              if (entry.kind === 'addressed' && entry.opening) {
                content += 1;
              } else if (entry.kind !== 'boundary') {
                structure += 1;
              }
            }
          }
          if (random() < 0.2) {
            // oxlint-disable-next-line no-await-in-loop
            await both(
              { op: Op.ADDRESSED, chat, aci: pick(members), key: pick(keys) },
              `step ${i} ADDRESSED`
            );
          }
        }
        assert.isAbove(known.length, 10, 'the run accepted records');
        assert.isAbove(served, 10, 'the run served');
        assert.isAbove(content, 0, 'some replies carried content');
        assert.isAbove(structure, 0, 'some replies carried structure');
      });
    }
  });
});
