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

import { ZrdtBackendError } from '../../zrdt/ZrdtBackend.std.ts';
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
      return backend.accept(req.chat, req.parts);
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
    default:
      throw new Error('unknown op');
  }
}

/** A request payload in, a reply payload out, as zrdtd would answer. */
async function serve(
  backend: ZrdtBackend,
  payload: Bytes,
  options: ReplyOptions & { withAcceptRecord: boolean }
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
  };

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

  describe('sessions on the stub', () => {
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

  const haveDaemon = existsSync(ZRDTD);
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

    for (const seed of [1, 2, 3, 4]) {
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
});
