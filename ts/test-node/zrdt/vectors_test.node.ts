// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable no-await-in-loop, no-loop-func

// Rung 7 (zrdt docs/PLAN.md section 6): the TypeScript stub against the Lean
// reference. Three comparisons:
//
// 1. zrdt/vectors/vectors.json (written by the Lean code): the static
//    encodings (records, blobs, commitments and the audience each opening
//    carries, key tags, reply bytes), and every session step run on a fresh
//    stub, through codec.decodeRequest -> StubBackend -> codec.encodeReply,
//    compared byte for byte with Lean's reply.
// 2. The same sessions on zrdtd: raw frames (rung 6, here in TypeScript),
//    and through the typed DaemonBackend (its request encoders and reply
//    decoders). On zrdtd the VERSION reply must match too: the binary is the
//    build the vectors were written from.
// 3. Randomized differentials: the same random op sequence on the stub and
//    on zrdtd, replies compared byte for byte.
//
// Protocol 4 only (greenfield): no step may differ, and vectors of another
// protocol fail the run.
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
  ServeEntry,
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
import type { Request, ResultOf } from '../../zrdt/backends/codec.std.ts';
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
  stubKeyTag,
} from '../../zrdt/backends/stub.node.ts';
import { audienceOfOpening } from '../../zrdt/audience.std.ts';
import { keyTag } from '../../zrdt/seal.node.ts';

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
    opening: string | null;
    audience: string | null;
  }>;
  keyTag: ReadonlyArray<{ name: string; key: string; tag: string }>;
  replies: ReadonlyArray<{ name: string; reply: string }>;
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
    case Op.ACCEPT_VIEW:
      return backend.acceptView(
        req.chat,
        req.voucher,
        req.forImport,
        req.mode,
        req.entries,
        req.pending
      );
    case Op.LINKABLE:
      return backend.linkable(req.chat, req.live);
    case Op.NEW_RELATIVE:
      await backend.createRelative(req.chat, req.group);
      return undefined;
    default:
      throw new Error('unknown op');
  }
}

/** A request payload in, a reply payload out, as zrdtd would answer. */
async function serve(backend: ZrdtBackend, payload: Bytes): Promise<Bytes> {
  const req = decodeRequest(payload);
  if (typeof req === 'number') {
    return Uint8Array.of(req);
  }
  try {
    const result = await runTyped(backend, req);
    return encodeReply(req.op, result);
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
 * Compares a reply byte for byte. A build-dependent step (VERSION) on the
 * stub compares status and protocol only: the stub's build text is "stub".
 */
function expectReply(step: Step, actual: Bytes, label: string): void {
  if (step.buildDependent && label === 'stub') {
    assert.strictEqual(
      hex(actual).slice(0, 10),
      step.reply.slice(0, 10),
      `${label}: ${step.name} (status and protocol)`
    );
    return;
  }
  assert.strictEqual(hex(actual), step.reply, `${label}: ${step.name}`);
}

/** The reply of a `replies` vector, by the op its name starts with. */
function replyOp(name: string): Op.ACCEPT | Op.OPEN | Op.SALVAGE {
  if (name.startsWith('ACCEPT')) {
    return Op.ACCEPT;
  }
  if (name.startsWith('SALVAGE')) {
    return Op.SALVAGE;
  }
  if (name.startsWith('OPEN')) {
    return Op.OPEN;
  }
  throw new Error(`no op for reply vector "${name}"`);
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

  it('vectors.json is protocol 4, the protocol the host speaks', () => {
    assert.strictEqual(vectors.protocol, PROTOCOL_VERSION);
  });

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
        // ENCODE writes zrdtS3: a closed store with no boundary and no
        // recorded audiences, then the records blob (the vector).
        assert.strictEqual(
          hex(await stub.encode('blob')),
          `${hex(new TextEncoder().encode('zrdtS3'))}00${'00000000'.repeat(2)}${v.blob}`,
          v.name
        );
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
          assert.strictEqual(hex(result.opening), v.opening, v.name);
        }
      }
    });

    it('commit: the audience each opening carries (field 201)', () => {
      let withAudience = 0;
      for (const v of vectors.commit) {
        if (v.opening == null) {
          continue;
        }
        const seats = audienceOfOpening(fromHex(v.opening));
        const actual =
          seats === undefined
            ? null
            : seats.map(seat => hex(seat.aci) + hex(seat.tag)).join('');
        assert.strictEqual(actual, v.audience, v.name);
        if (seats !== undefined) {
          withAudience += 1;
        }
      }
      assert.isAbove(withAudience, 0, 'some opening carries an audience');
    });

    it('keyTag: the stub and the sealing code give the tags', () => {
      assert.isAbove(vectors.keyTag.length, 0);
      for (const v of vectors.keyTag) {
        assert.strictEqual(hex(stubKeyTag(fromHex(v.key))), v.tag, v.name);
        assert.strictEqual(hex(keyTag(fromHex(v.key))), v.tag, v.name);
      }
    });

    it('replies no request can produce: read and written again', () => {
      assert.isAbove(vectors.replies.length, 0);
      for (const v of vectors.replies) {
        const op = replyOp(v.name);
        const bytes = fromHex(v.reply);
        const result = decodeReply(op, bytes[0] ?? 0, bytes.slice(1));
        assert.isDefined(result, v.name);
        assert.strictEqual(hex(encodeReply(op, result)), v.reply, v.name);
      }
    });
  });

  describe('sessions on the stub', () => {
    for (const session of vectors.sessions) {
      it(`session ${session.name}`, async () => {
        const stub = new StubBackend({ env: {} });
        for (const step of session.steps) {
          // oxlint-disable-next-line no-await-in-loop
          const reply = await serve(stub, fromHex(step.request));
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
          const reply = await serve(backend, fromHex(step.request));
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

        const both = async (req: Request, label: string): Promise<void> => {
          const payload = concatBytes([
            Uint8Array.of(req.op),
            encodeRequestBody(req),
          ]);
          const [a, b] = await Promise.all([
            serve(stub, payload),
            serve(lean, payload),
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
          // The third chat is a relative store (JOIN_PLAN §6.2).
          const op = chat === 'third' ? Op.NEW_RELATIVE : Op.NEW;
          // oxlint-disable-next-line no-await-in-loop
          await both({ op, chat, group: pick(groups) }, `${Op[op]} ${chat}`);
        }

        // An ACCEPT_VIEW entry: a boundary digest (known or made up), a
        // record's structure (maybe cut short), or an addressed record with
        // no opening or a junk one.
        const viewEntry = (): ServeEntry => {
          const r = random();
          if (r < 0.4 || records.length === 0) {
            return {
              kind: 'boundary',
              digest:
                known.length > 0 && random() < 0.5 ? pick(known) : bytes(32),
            };
          }
          const record = pick(records);
          if (r < 0.75) {
            return {
              kind: 'after',
              record: random() < 0.1 ? record.subarray(1) : record,
            };
          }
          return random() < 0.5
            ? { kind: 'addressed', record, authorCopy: random() < 0.5 }
            : {
                kind: 'addressed',
                record,
                authorCopy: false,
                opening: bytes(32 + Math.floor(random() * 6)),
              };
        };

        for (let i = 0; i < 400; i += 1) {
          const chat = pick(chats);
          const special = random();
          const roll = random();
          let req: Request;
          if (special < 0.08) {
            const entries = new Array<ServeEntry>();
            const n = 1 + Math.floor(random() * 4);
            for (let j = 0; j < n; j += 1) {
              entries.push(viewEntry());
            }
            // Protocol 4: the request's mode and the host's pending records.
            const pending = new Array<ServeEntry>();
            const np = Math.floor(random() * 3);
            for (let j = 0; j < np; j += 1) {
              const entry = viewEntry();
              if (entry.kind !== 'boundary') {
                pending.push(entry);
              }
            }
            req = {
              op: Op.ACCEPT_VIEW,
              chat,
              voucher: pick(authors),
              forImport: random() < 0.3,
              mode: random() < 0.5 ? 'perDigest' : 'catchup',
              entries,
              pending,
            };
          } else if (special < 0.12) {
            req = {
              op: Op.LINKABLE,
              chat,
              live: known.filter(() => random() < 0.5),
            };
          } else if (roll < 0.35) {
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
            // Protocol 4: ACCEPT always takes an opening (a random one here
            // never matches: BAD_OPENING); structure goes in with
            // ACCEPT_RECORD.
            req =
              random() < 0.1
                ? {
                    op: Op.ACCEPT,
                    chat,
                    parts,
                    opening: bytes(32 + Math.floor(random() * 6)),
                  }
                : {
                    op: Op.ACCEPT_RECORD,
                    chat,
                    record: encodeRecord(makeRecord(parts)),
                  };
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

  // Protocol 3 (JOIN_PLAN §3.2, §5): AUDIENCE (members in any order, too
  // many, an ACI twice), COMMIT, ACCEPT and ACCEPT_RECORD with openings (their
  // own, another record's, none; field 201 once, twice, malformed, missing),
  // SERVE and ADDRESSED with random queries and held openings (some not the
  // record's), and restarts (ENCODE, CLOSE, OPEN, the held openings sent
  // again with ACCEPT_RECORD), on the stub and on zrdtd, replies compared
  // byte for byte.
  describeDaemon('randomized SERVE differential: stub vs zrdtd', () => {
    let daemon: DaemonBackend | undefined;
    afterEach(() => {
      daemon?.dispose();
      daemon = undefined;
    });
    // Which (op, reply status) pairs the random runs reached.
    const coverage = new Map<string, number>();

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
        const shuffle = <T>(items: ReadonlyArray<T>): Array<T> => {
          const out = [...items];
          for (let i = out.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            const x = out[i] as T;
            out[i] = out[j] as T;
            out[j] = x;
          }
          return out;
        };
        const fill = (n: number, b: number): Bytes => new Uint8Array(n).fill(b);
        const varint = (value: number): Array<number> => {
          const out = new Array<number>();
          let n = value;
          while (n >= 0x80) {
            out.push((n % 0x80) + 0x80);
            n = Math.floor(n / 0x80);
          }
          out.push(n);
          return out;
        };
        // Field 201 (key 1610: the varint ca 0c) holding `value`.
        const field201 = (value: Bytes): Array<number> => [
          0xca,
          0x0c,
          ...varint(value.length),
          ...value,
        ];
        // `n` distinct ACIs, none of them a member's.
        const crowd = (n: number): Array<{ aci: Bytes }> =>
          Array.from({ length: n }, (_, i) => {
            const aci = new Uint8Array(16);
            aci[0] = 0xe0;
            aci[1] = Math.floor(i / 256);
            aci[2] = i % 256;
            return { aci };
          });

        const group = fill(32, 0x67);
        const chat = 'camping';
        // Not in byte order: AUDIENCE sorts.
        const members = [0xd0, 0xa1, 0xc0, 0xb0, 0x07].map(b => fill(16, b));
        const keys = [0x05, 0x06, 0x07, 0x08, 0x09].map(b => fill(33, b));
        const known = new Array<Digest>();
        const recordOf = new Map<string, Bytes>();
        const openings = new Array<{ digest: Digest; opening: Bytes }>();
        // Every opening COMMIT gave, accepted or not.
        const allOpenings = new Array<Bytes>();
        let nonceByte = 0;
        let served = 0;
        let content = 0;
        let structure = 0;
        let restarts = 0;

        const both = async (req: Request, label: string): Promise<Bytes> => {
          const payload = concatBytes([
            Uint8Array.of(req.op),
            encodeRequestBody(req),
          ]);
          const [a, b] = await Promise.all([
            serve(stub, payload),
            serve(lean, payload),
          ]);
          assert.strictEqual(hex(a), hex(b), `seed ${seed}: ${label}`);
          const k = `${Op[req.op]} ${Code[a[0] ?? 0] ?? a[0]}`;
          coverage.set(k, (coverage.get(k) ?? 0) + 1);
          return a;
        };

        await both({ op: Op.NEW, chat, group }, 'NEW');
        for (let i = 0; i < 150; i += 1) {
          // The author's audience.
          const author = pick(members);
          const roll = random();
          let audienceMembers: Array<{ aci: Bytes; key?: Bytes }>;
          if (roll < 0.04) {
            audienceMembers = crowd(257);
          } else if (roll < 0.07) {
            audienceMembers = shuffle([
              ...crowd(255),
              { aci: author, key: pick(keys) },
            ]);
          } else if (roll < 0.1) {
            const twice = pick(members);
            audienceMembers = shuffle([
              { aci: twice, key: pick(keys) },
              { aci: twice },
              ...some(members, 0.5)
                .filter(m => m !== twice)
                .map(aci => ({ aci })),
            ]);
          } else {
            audienceMembers = shuffle(
              some(members, 0.7).map(aci =>
                random() < 0.8 ? { aci, key: pick(keys) } : { aci }
              )
            );
          }
          // oxlint-disable-next-line no-await-in-loop
          const aud = await both(
            { op: Op.AUDIENCE, members: audienceMembers },
            `step ${i} AUDIENCE`
          );
          const audience =
            aud[0] === Code.OK
              ? decodeReply(Op.AUDIENCE, Code.OK, aud.slice(1))
              : undefined;
          const value =
            audience?.kind === 'ok' ? audience.audience : fill(32, 0xe1);

          // The DataMessage: field 201 once (mostly), twice, out of order,
          // or missing.
          const body = new TextEncoder().encode(`m${i}`);
          const shape = random();
          let audienceFields: Array<number>;
          if (shape < 0.82) {
            audienceFields = field201(value);
          } else if (shape < 0.88) {
            audienceFields = [...field201(value), ...field201(value)];
          } else if (shape < 0.94) {
            // Two entries swapped (or one cut short): not an audience.
            audienceFields =
              value.length >= 64
                ? field201(
                    concatBytes([value.slice(32, 64), value.slice(0, 32)])
                  )
                : field201(value.slice(0, 31));
          } else {
            audienceFields = [];
          }
          const ephemeral = random() < 0.15 ? [0x28, 60] : [];
          const dataMessage = new Uint8Array([
            0x0a,
            body.length,
            ...body,
            ...ephemeral,
            ...audienceFields,
          ]);
          nonceByte = (nonceByte + 1) % 256;
          // oxlint-disable-next-line no-await-in-loop
          const committedReply = await both(
            {
              op: Op.COMMIT,
              group,
              author,
              nonce: fill(32, nonceByte),
              dataMessage,
            },
            `step ${i} COMMIT`
          );
          const committed = decodeReply(
            Op.COMMIT,
            committedReply[0] ?? 0,
            committedReply.slice(1)
          );
          if (committed?.kind !== 'ok') {
            continue;
          }
          allOpenings.push(committed.opening);
          const links = some(known, 0.2).slice(0, 3);
          const parts: RecordParts = {
            group,
            commit: committed.commit,
            links,
            author,
          };

          // ACCEPT with its opening or another one's; ACCEPT_RECORD with
          // one, or none (structure only: ACCEPT always takes an opening,
          // protocol 4).
          const how = random();
          let opening: Bytes | undefined;
          if (how < 0.08) {
            opening = undefined;
          } else if (how < 0.15 && allOpenings.length > 1) {
            opening = pick(allOpenings);
          } else {
            opening = committed.opening;
          }
          const asRecord = opening === undefined || random() < 0.15;
          // oxlint-disable-next-line no-await-in-loop
          let accepted = await both(
            asRecord || opening === undefined
              ? {
                  op: Op.ACCEPT_RECORD,
                  chat,
                  record: encodeRecord(makeRecord(parts)),
                  opening,
                }
              : { op: Op.ACCEPT, chat, parts, opening },
            `step ${i} ${asRecord ? 'ACCEPT_RECORD' : 'ACCEPT'}`
          );
          if (accepted[0] === Code.NO_AUDIENCE && random() < 0.5) {
            // Stored without an opening (structure, ACCEPT_RECORD): nothing
            // is recorded for it, and the host may still hold the opening.
            // oxlint-disable-next-line no-await-in-loop
            accepted = await both(
              {
                op: Op.ACCEPT_RECORD,
                chat,
                record: encodeRecord(makeRecord(parts)),
              },
              `step ${i} ACCEPT_RECORD without the opening`
            );
            opening = committed.opening;
          }
          if (accepted[0] === Code.OK) {
            const digest = accepted.slice(1, 33);
            known.push(digest);
            recordOf.set(hex(digest), accepted.slice(37));
            if (opening !== undefined && random() < 0.8) {
              openings.push({ digest, opening });
            }
          }

          if (random() < 0.03 && known.length > 0) {
            // A restart: zrdtd keeps audiences only while the store is open,
            // so the host sends the openings it holds again.
            // oxlint-disable-next-line no-await-in-loop
            const encoded = await both({ op: Op.ENCODE, chat }, 'ENCODE');
            // MERGE of the blob into a new store records the blob's
            // audiences where none is recorded (protocol 4,
            // run_merge_audiences): ADDRESSED and ENCODE of the copy agree.
            const copy = 'copy';
            // oxlint-disable-next-line no-await-in-loop
            await both({ op: Op.CLOSE, chat: copy }, 'CLOSE copy');
            // oxlint-disable-next-line no-await-in-loop
            await both({ op: Op.NEW, chat: copy, group }, 'NEW copy');
            for (const held of some(openings, 0.2)) {
              const record = recordOf.get(hex(held.digest));
              if (record !== undefined) {
                // oxlint-disable-next-line no-await-in-loop
                await both(
                  { op: Op.ACCEPT_RECORD, chat: copy, record },
                  'ACCEPT_RECORD into the copy before MERGE'
                );
              }
            }
            // oxlint-disable-next-line no-await-in-loop
            await both(
              { op: Op.MERGE, chat: copy, blob: encoded.slice(5) },
              'MERGE into the copy'
            );
            for (const [m, member] of members.entries()) {
              // oxlint-disable-next-line no-await-in-loop
              await both(
                {
                  op: Op.ADDRESSED,
                  chat: copy,
                  aci: member,
                  key: keys[m] ?? pick(keys),
                },
                'ADDRESSED in the copy after MERGE'
              );
            }
            // oxlint-disable-next-line no-await-in-loop
            await both({ op: Op.ENCODE, chat: copy }, 'ENCODE the copy');
            // oxlint-disable-next-line no-await-in-loop
            await both({ op: Op.CLOSE, chat }, 'CLOSE');
            // oxlint-disable-next-line no-await-in-loop
            await both(
              { op: Op.OPEN, chat, group, input: encoded.slice(5) },
              'OPEN after a restart'
            );
            for (const held of some(openings, 0.8)) {
              const record = recordOf.get(hex(held.digest));
              if (record !== undefined) {
                // oxlint-disable-next-line no-await-in-loop
                await both(
                  {
                    op: Op.ACCEPT_RECORD,
                    chat,
                    record,
                    opening: held.opening,
                  },
                  'ACCEPT_RECORD after a restart'
                );
              }
            }
            restarts += 1;
          }

          if (random() < 0.4 && known.length > 0) {
            const perDigest = random() < 0.4;
            // Held openings, and now and then one that is not the record's.
            const held = some(openings, 0.7);
            if (random() < 0.15 && allOpenings.length > 0) {
              held.push({ digest: pick(known), opening: pick(allOpenings) });
            }
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
                held,
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
        coverage.set('restarts', (coverage.get('restarts') ?? 0) + restarts);
      });
    }

    it('the runs reached every protocol-3 reply', () => {
      if (seedCount === 0) {
        return;
      }
      const line = [...coverage.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, n]) => `${k}: ${n}`)
        .join(', ');
      // eslint-disable-next-line no-console
      console.log(`      coverage: ${line}`);
      for (const k of [
        'AUDIENCE OK',
        'AUDIENCE TOO_LARGE',
        'AUDIENCE MALFORMED',
        'COMMIT OK',
        'ACCEPT OK',
        'ACCEPT NO_AUDIENCE',
        'ACCEPT BAD_OPENING',
        'ACCEPT_RECORD OK',
        'ACCEPT_RECORD NO_AUDIENCE',
        'OPEN OK',
        'SERVE OK',
        'ADDRESSED OK',
        'restarts',
      ]) {
        assert.isAbove(coverage.get(k) ?? 0, 0, k);
      }
    });
  });
});
