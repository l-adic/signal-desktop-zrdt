// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// A scripted stand-in for lane transport's API (ts/zrdt/apps/api.std.ts),
// used until it lands: by the manager, routes and UI tests, by tools/zbt's
// test, and by demo/smoke-apps.ts --plan (memoryWriter.std.ts is the writer
// that goes with it). It plays one desktop. What the CDN and each member do
// to each piece is scripted; it reports the events lane transport will
// report, in the order it will report them.

import type {
  BtApi,
  BtAssembleResult,
  BtBindResult,
  BtFetchResult,
  BtFileResult,
  BtMember,
  BtPieceEvent,
  BtPublishRequest,
  BtPublishResult,
  Bytes,
  DigestHex,
} from '../../../../zrdt/apps/bt/manager.std.ts';
import {
  PIECE_BYTES,
  pieceCount,
} from '../../../../zrdt/apps/bt/manager.std.ts';

/** What the CDN does with one piece for this desktop. */
export type CdnFate = 'notFound' | 'badMac' | 'badUpload';

/** What one member does when asked for one piece. */
export type MemberFate = 'good' | 'silent' | 'tamper';

export type FakeFile = {
  name: string;
  bytes: Bytes;
  author: BtMember;
  /** BAD_APP 4 for this desktop. */
  notSeated?: boolean;
  /** 0-based index -> what the CDN does; absent: the download works. */
  cdn?: Map<number, CdnFate>;
  /**
   * 0-based index -> who is asked, in order, and what they do. A piece the
   * CDN failed and with no entry here ends up unavailable.
   */
  repair?: Map<number, ReadonlyArray<readonly [BtMember, MemberFate]>>;
  /** Flip a byte of what readStream returns (a host bug). */
  corruptStream?: boolean;
};

export type FakeCall = Readonly<{ op: string; announcement?: string }>;

let nextDigest = 1;

/** A digest-shaped id, distinct per call. */
export function fakeDigest(): DigestHex {
  const n = nextDigest;
  nextDigest += 1;
  return n.toString(16).padStart(64, 'a');
}

function slice(bytes: Bytes, index: number): Bytes {
  return bytes.slice(index * PIECE_BYTES, (index + 1) * PIECE_BYTES);
}

export class FakeBtApi implements BtApi {
  /** The announcements this desktop can bind, by A's digest. */
  readonly files = new Map<DigestHex, FakeFile>();
  readonly calls: Array<FakeCall> = [];
  /** publish refuses with this reason when set. */
  refusePublish: 'badName' | 'tooLarge' | 'notMember' | 'failed' | undefined;
  /** How many members a published A seats. */
  audience = 4;
  // Pieces stored per announcement (PIECE_ACCEPT answered OK).
  readonly #stored = new Map<DigestHex, Set<number>>();
  // Members repair stopped asking, per announcement (after a bad piece).
  readonly #stopped = new Map<DigestHex, Set<string>>();

  /** Adds a file another member shared; returns A's digest. */
  addFile(file: FakeFile): DigestHex {
    const digest = fakeDigest();
    this.files.set(digest, file);
    return digest;
  }

  readonly publish = async (
    request: BtPublishRequest
  ): Promise<BtPublishResult> => {
    this.calls.push({ op: 'publish' });
    if (this.refusePublish !== undefined) {
      return { kind: 'refused', reason: this.refusePublish };
    }
    const n = pieceCount(request.stream.byteLength);
    for (let i = 0; i < n; i += 1) {
      request.onPiece({ kind: 'uploading', index: i });
    }
    for (let i = 0; i < n; i += 1) {
      request.onPiece({ kind: 'checked', index: i, source: { kind: 'local' } });
    }
    const digest = fakeDigest();
    this.#stored.set(digest, new Set(Array.from({ length: n }, (_, i) => i)));
    return { kind: 'published', announcement: digest, audience: this.audience };
  };

  readonly bind = async (
    _conversationId: string,
    announcement: DigestHex
  ): Promise<BtBindResult> => {
    this.calls.push({ op: 'bind', announcement });
    const f = this.files.get(announcement);
    if (f === undefined) {
      return { kind: 'refused', detail: 'NOT_STORED' };
    }
    if (f.notSeated === true) {
      return { kind: 'notSeated' };
    }
    return {
      kind: 'bound',
      size: f.bytes.byteLength,
      pieces: pieceCount(f.bytes.byteLength),
    };
  };

  readonly file = async (announcement: DigestHex): Promise<BtFileResult> => {
    this.calls.push({ op: 'file', announcement });
    const f = this.files.get(announcement);
    return f === undefined
      ? { kind: 'refused', detail: 'NO_CHAT' }
      : { kind: 'file', name: f.name, size: f.bytes.byteLength };
  };

  readonly fetchPieces = async (
    announcement: DigestHex,
    onPiece: (event: BtPieceEvent) => void
  ): Promise<BtFetchResult> => {
    this.calls.push({ op: 'fetchPieces', announcement });
    const f = this.files.get(announcement);
    if (f === undefined) {
      throw new Error('NO_CHAT');
    }
    const stored = this.#stored.get(announcement) ?? new Set<number>();
    this.#stored.set(announcement, stored);
    const stopped = this.#stopped.get(announcement) ?? new Set<string>();
    this.#stopped.set(announcement, stopped);
    const n = pieceCount(f.bytes.byteLength);

    const toRepair: Array<number> = [];
    for (let i = 0; i < n; i += 1) {
      if (stored.has(i)) {
        continue;
      }
      onPiece({ kind: 'fetching', index: i });
      const fate = f.cdn?.get(i);
      if (fate === undefined) {
        stored.add(i);
        onPiece({ kind: 'checked', index: i, source: { kind: 'cdn' } });
      } else if (fate === 'badUpload') {
        onPiece({ kind: 'cdnBadPiece', index: i });
        toRepair.push(i);
      } else {
        onPiece({ kind: 'cdnFailed', index: i, reason: fate });
        toRepair.push(i);
      }
    }

    // Every first ask goes out before any answer, as lane transport's
    // requester sends disjoint requests at once.
    const queues = new Map(
      toRepair.map(i => [
        i,
        [...(f.repair?.get(i) ?? [])].filter(([m]) => !stopped.has(m.aci)),
      ])
    );
    for (;;) {
      const round = [...queues.entries()].filter(([, q]) => q.length > 0);
      if (round.length === 0) {
        break;
      }
      for (const [i, q] of round) {
        const head = q[0];
        if (head !== undefined) {
          onPiece({ kind: 'asking', index: i, member: head[0] });
        }
      }
      for (const [i, q] of round) {
        const head = q.shift();
        if (head === undefined) {
          continue;
        }
        const [member, fate] = head;
        if (fate === 'good') {
          stored.add(i);
          onPiece({
            kind: 'checked',
            index: i,
            source: { kind: 'member', member },
          });
          queues.delete(i);
        } else if (fate === 'silent') {
          onPiece({ kind: 'noAnswer', index: i, member });
        } else {
          onPiece({ kind: 'memberBadPiece', index: i, member });
          stopped.add(member.aci);
          for (const other of queues.values()) {
            for (let k = other.length - 1; k >= 0; k -= 1) {
              if (other[k]?.[0].aci === member.aci) {
                other.splice(k, 1);
              }
            }
          }
        }
      }
    }
    const missing = toRepair.filter(i => !stored.has(i));
    for (const i of missing) {
      onPiece({ kind: 'unavailable', index: i });
    }
    return missing.length === 0
      ? { kind: 'complete' }
      : { kind: 'incomplete', missing };
  };

  readonly readStream = async (announcement: DigestHex): Promise<Bytes> => {
    this.calls.push({ op: 'readStream', announcement });
    const f = this.files.get(announcement);
    if (f === undefined) {
      throw new Error('NO_CHAT');
    }
    const copy = f.bytes.slice();
    if (f.corruptStream === true && copy.length > 0) {
      copy[copy.length - 1] = ((copy[copy.length - 1] ?? 0) + 1) % 256;
    }
    return copy;
  };

  readonly assemble = async (
    announcement: DigestHex,
    stream: Bytes
  ): Promise<BtAssembleResult> => {
    this.calls.push({ op: 'assemble', announcement });
    const f = this.files.get(announcement);
    if (f === undefined) {
      throw new Error('NO_CHAT');
    }
    const n = pieceCount(f.bytes.byteLength);
    if (stream.byteLength !== f.bytes.byteLength) {
      return { kind: 'badPiece', index: n };
    }
    for (let i = 0; i < n; i += 1) {
      const a = slice(stream, i);
      const b = slice(f.bytes, i);
      if (a.some((x, k) => x !== b[k])) {
        return { kind: 'badPiece', index: i };
      }
    }
    return { kind: 'ok' };
  };
}

/** Deterministic bytes: byte k of the file is (k * 31 + seed) mod 251. */
export function fileBytes(size: number, seed = 7): Bytes {
  const out = new Uint8Array(size);
  for (let k = 0; k < size; k += 1) {
    out[k] = (k * 31 + seed) % 251;
  }
  return out;
}

/** Waits until no promise job is pending (the manager's chains settle). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    // oxlint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}
