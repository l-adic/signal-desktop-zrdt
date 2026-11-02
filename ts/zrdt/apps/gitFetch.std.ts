// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The receiver's side of git (zrdt docs/apps/BUILD_M1.md §B.7, §B.9 step 5;
// tools/git-remote-zrdt/ENDPOINT.md §4.2, §4.4). After PIECES_COMPLETE says
// OK, GIT_OBJECTS lists the checked stream's objects; this module keeps them
// by id, per record, and builds the repository view the endpoint reports
// from GIT_VIEW (the push log and the live assignments) and the held
// records. Pure: the transport supplies zrdtd's replies and the bytes.

import type {
  GitLogEntry,
  GitObjectEntry,
  GitRefEntry,
  GitUpdate,
} from '../ZrdtBackend.std.ts';
import type { AppMember } from './api.std.ts';
import { compareStrings, toHex } from './appMessage.std.ts';
import type { GitBody } from './gitBody.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

/** The raw objects of the applied records of one git channel. */
export class GitObjectStore {
  readonly #raw = new Map<string, Bytes>();
  readonly #byRecord = new Map<string, ReadonlyArray<string>>();

  /**
   * Keeps the objects GIT_OBJECTS listed for record `digest` (hex), slicing
   * them from the checked stream. Returns the ids, in stream order.
   */
  addRecord(
    digest: string,
    stream: Uint8Array<ArrayBuffer>,
    objects: ReadonlyArray<GitObjectEntry>
  ): Array<string> {
    const ids = new Array<string>();
    for (const o of objects) {
      if (o.offset < 0 || o.offset + o.length > stream.length) {
        throw new RangeError('zrdt git: an object outside the stream');
      }
      const id = toHex(o.oid);
      this.#raw.set(id, stream.slice(o.offset, o.offset + o.length));
      ids.push(id);
    }
    this.#byRecord.set(digest, ids);
    return ids;
  }

  /** A record with no objects (a pure ref move) is applied at once. */
  addEmptyRecord(digest: string): void {
    this.#byRecord.set(digest, []);
  }

  isApplied(digest: string): boolean {
    return this.#byRecord.has(digest);
  }

  /**
   * The raw objects asked for that some record in `records` carries
   * (ENDPOINT §4.4: no existence oracle, no content-addressed pull of
   * history this member was not given); every other id is missing.
   */
  objectsFor(
    records: Iterable<string>,
    ids: ReadonlyArray<string>
  ): { found: Array<{ id: string; raw: Bytes }>; missing: Array<string> } {
    const allowed = new Set<string>();
    for (const r of records) {
      for (const id of this.#byRecord.get(r) ?? []) {
        allowed.add(id);
      }
    }
    const found = new Array<{ id: string; raw: Bytes }>();
    const missing = new Array<string>();
    for (const id of ids) {
      const raw = allowed.has(id) ? this.#raw.get(id) : undefined;
      if (raw === undefined) {
        missing.push(id);
      } else {
        found.push({ id, raw });
      }
    }
    return { found, missing };
  }
}

/** An update as ENDPOINT.md writes it: `old` is a list (empty for a create). */
export type UpdateJson = Readonly<{
  name: string;
  old: ReadonlyArray<string>;
  new: string | null;
  forced: boolean;
}>;

export function updateJson(u: GitUpdate): UpdateJson {
  return {
    name: u.name,
    old: u.old === undefined ? [] : [toHex(u.old)],
    new: u.new === undefined ? null : toHex(u.new),
    forced: u.forced,
  };
}

export type RecordJson = Readonly<{
  record: string;
  seq: number;
  author: string;
  provenance: 'self' | 'live' | 'relayed' | 'imported';
  share: boolean;
  links: ReadonlyArray<string>;
  objects: ReadonlyArray<string>;
  covers: ReadonlyArray<string>;
  updates: ReadonlyArray<UpdateJson>;
}>;

export type RefJson = Readonly<{
  name: string;
  values: ReadonlyArray<
    Readonly<{ value: string; record: string; forced: boolean; author: string }>
  >;
}>;

/** ENDPOINT §4.2's reply. */
export type RepoStateJson = Readonly<{
  group: string;
  repo: string;
  members: ReadonlyArray<Readonly<{ member: string; self: boolean }>>;
  heads: ReadonlyArray<string>;
  compareCode: string;
  records: ReadonlyArray<RecordJson>;
  notGiven: number;
  pending: ReadonlyArray<Readonly<{ record: string; missingPieces: number }>>;
  refs: ReadonlyArray<RefJson>;
}>;

/** One channel record whose opening this device holds, with its git body. */
export type HeldGitRecord = Readonly<{
  digest: string;
  seq: number;
  /** The author's ACI (uuid string). */
  authorAci: string;
  provenance: RecordJson['provenance'];
  links: ReadonlyArray<string>;
  body: GitBody;
  /** All its pieces are checked and its objects kept (or it has none). */
  applied: boolean;
  /** Pieces still missing, when not applied. */
  missingPieces: number;
}>;

/**
 * The repository as this member holds it (ENDPOINT §4.2), from GIT_VIEW's
 * log and live assignments and the held records. Only applied records are
 * in `records`, and only their assignments in `refs` (so the helper never
 * lists a value it cannot fetch); deletes are not listed, and a name whose
 * live values are all deletes is omitted.
 */
export function repoState({
  group,
  repo,
  members,
  heads,
  compareCode,
  held,
  notGiven,
  view,
  nameOf,
  seatName,
}: Readonly<{
  group: string;
  repo: string;
  members: ReadonlyArray<AppMember>;
  heads: ReadonlyArray<string>;
  compareCode: string;
  held: ReadonlyArray<HeldGitRecord>;
  notGiven: number;
  view: Readonly<{
    log: ReadonlyArray<GitLogEntry>;
    refs: ReadonlyArray<GitRefEntry>;
  }>;
  /** A member's display name by ACI (uuid string). */
  nameOf: (aci: string) => string;
  /** A cover's display name (aci bytes as hex). */
  seatName: (aciHex: string) => string;
}>): RepoStateJson {
  const mine = held
    .filter(r => r.body.repo === repo)
    .sort((a, b) => a.seq - b.seq);
  const applied = mine.filter(r => r.applied);
  const byDigest = new Map(applied.map(r => [r.digest, r]));
  const refs = new Map<string, Array<RefJson['values'][number]>>();
  for (const ref of view.refs) {
    const digest = toHex(ref.digest);
    const r = byDigest.get(digest);
    if (r === undefined || ref.value === undefined) {
      continue;
    }
    const update = r.body.updates.find(u => u.name === ref.name);
    const list = refs.get(ref.name) ?? [];
    list.push({
      value: toHex(ref.value),
      record: digest,
      forced: update?.forced ?? false,
      author: nameOf(r.authorAci),
    });
    refs.set(ref.name, list);
  }
  return {
    group,
    repo,
    members: members.map(m => ({ member: m.name, self: m.self })),
    heads: [...heads].sort(),
    compareCode,
    records: applied.map(r => ({
      record: r.digest,
      seq: r.seq,
      author: nameOf(r.authorAci),
      provenance: r.provenance,
      share: r.body.share,
      links: [...r.links],
      objects: r.body.oids.map(toHex),
      covers: r.body.covers.map(s => seatName(toHex(s.aci))),
      updates: r.body.updates.map(updateJson),
    })),
    notGiven,
    pending: mine
      .filter(r => !r.applied)
      .map(r => ({ record: r.digest, missingPieces: r.missingPieces })),
    refs: [...refs.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([name, values]) => ({
        name,
        values: values.sort(
          (x, y) =>
            compareStrings(x.value, y.value) ||
            compareStrings(x.record, y.record)
        ),
      })),
  };
}
