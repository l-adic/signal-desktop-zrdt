// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The git push body (zrdt docs/apps/BUILD_M1.md §B.7, field 212 of a git
// record) and the git names M1 accepts. zrdtd writes the body (GIT_PREPARE)
// and reads it (the table); the host reads it to show a record and to check
// that a prepared push lists exactly the objects the helper named. The
// TypeScript stub (backends/gitStub.node.ts) uses it too.
//
//   body = "zgit1" ‖ flags u8 (bit 0 share) ‖ repo (u8 len ‖ name)
//          ‖ updates (u8 count ‖ refname ‖ old optoid ‖ new optoid ‖ forced)
//          ‖ u16 nO ‖ nO oids (strictly increasing) ‖ u16 nC ‖ nC seats

import type { AppSeat, GitUpdate, Oid } from '../ZrdtBackend.std.ts';
import { concat, equalBytes, fromUtf8, utf8 } from './appMessage.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

const OID_BYTES = 32;

function compareBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// Names (GIT_PLAN §2.3; M1: refs/heads and refs/tags only)
// ---------------------------------------------------------------------------

/** A repository name: 1-64 bytes of [A-Za-z0-9._-], the first alphanumeric. */
export function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** `validRefName` for M1. */
export function validRefName(name: string): boolean {
  const bytes = utf8(name);
  if (bytes.length < 1 || bytes.length > 250) {
    return false;
  }
  if (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/')) {
    return false;
  }
  if (name.startsWith('refs/zrdt/') || name.includes('.zrdt-')) {
    return false;
  }
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    return false;
  }
  if (name.includes('..') || name.includes('@{') || name.includes('//')) {
    return false;
  }
  if (name.endsWith('/') || name.endsWith('.')) {
    return false;
  }
  return name
    .split('/')
    .every(c => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

// ---------------------------------------------------------------------------
// The push body (§B.7 "Push body")
// ---------------------------------------------------------------------------

export type GitBody = Readonly<{
  share: boolean;
  repo: string;
  updates: ReadonlyArray<GitUpdate>;
  oids: ReadonlyArray<Oid>;
  covers: ReadonlyArray<AppSeat>;
}>;

const BODY_TAG = utf8('zgit1');

function u16(value: number): Bytes {
  return Uint8Array.of(Math.floor(value / 256), value % 256);
}

function optOid(oid: Oid | undefined): Bytes {
  return oid === undefined ? Uint8Array.of(0) : concat([Uint8Array.of(1), oid]);
}

/** `"zgit1" ‖ flags ‖ repo ‖ updates ‖ u16 nO ‖ oids ‖ u16 nC ‖ covers`. */
export function writeBody(b: GitBody): Bytes {
  const repo = utf8(b.repo);
  return concat([
    BODY_TAG,
    Uint8Array.of(b.share ? 1 : 0),
    Uint8Array.of(repo.length),
    repo,
    Uint8Array.of(b.updates.length),
    ...b.updates.map(u => {
      const name = utf8(u.name);
      return concat([
        Uint8Array.of(name.length),
        name,
        optOid(u.old),
        optOid(u.new),
        Uint8Array.of(u.forced ? 1 : 0),
      ]);
    }),
    u16(b.oids.length),
    ...b.oids,
    u16(b.covers.length),
    ...b.covers.map(s => concat([s.aci, s.tag])),
  ]);
}

/** Reads a body; it must be exactly what `writeBody` writes for it. */
export function parseBody(bytes: Bytes): GitBody | undefined {
  let offset = 0;
  const take = (n: number): Bytes | undefined => {
    if (offset + n > bytes.length) {
      return undefined;
    }
    const out = bytes.slice(offset, offset + n);
    offset += n;
    return out;
  };
  const byte = (): number | undefined => take(1)?.[0];
  // An `optoid`: absent (undefined), an id, or `false` if malformed.
  const opt = (): Oid | undefined | false => {
    const f = byte();
    if (f === 0) {
      return undefined;
    }
    if (f === 1) {
      return take(OID_BYTES) ?? false;
    }
    return false;
  };
  const tag = take(5);
  if (tag === undefined || !equalBytes(tag, BODY_TAG)) {
    return undefined;
  }
  const flags = byte();
  if (flags !== 0 && flags !== 1) {
    return undefined;
  }
  const repoBytes = take(byte() ?? 0);
  const repo = repoBytes && fromUtf8(repoBytes);
  if (repo === undefined || !repoBytes) {
    return undefined;
  }
  const nU = byte();
  if (nU === undefined || nU > 16) {
    return undefined;
  }
  const updates = new Array<GitUpdate>();
  for (let i = 0; i < nU; i += 1) {
    const nameBytes = take(byte() ?? 0);
    const name =
      nameBytes && nameBytes.length > 0 ? fromUtf8(nameBytes) : undefined;
    const old = opt();
    const next = opt();
    const forced = byte();
    if (
      name === undefined ||
      old === false ||
      next === false ||
      (forced !== 0 && forced !== 1)
    ) {
      return undefined;
    }
    updates.push({
      name,
      ...(old === undefined ? {} : { old }),
      ...(next === undefined ? {} : { new: next }),
      forced: forced === 1,
    });
  }
  const nO = take(2);
  if (nO === undefined) {
    return undefined;
  }
  const oids = new Array<Oid>();
  for (let i = 0; i < (nO[0] ?? 0) * 256 + (nO[1] ?? 0); i += 1) {
    const oid = take(OID_BYTES);
    if (oid === undefined) {
      return undefined;
    }
    const prev = oids.at(-1);
    if (prev !== undefined && compareBytes(prev, oid) >= 0) {
      return undefined;
    }
    oids.push(oid);
  }
  const nC = take(2);
  if (nC === undefined) {
    return undefined;
  }
  const covers = new Array<AppSeat>();
  for (let i = 0; i < (nC[0] ?? 0) * 256 + (nC[1] ?? 0); i += 1) {
    const s = take(32);
    if (s === undefined) {
      return undefined;
    }
    const prev = covers.at(-1);
    if (
      prev !== undefined &&
      compareBytes(concat([prev.aci, prev.tag]), s) >= 0
    ) {
      return undefined;
    }
    covers.push({ aci: s.slice(0, 16), tag: s.slice(16) });
  }
  if (offset !== bytes.length) {
    return undefined;
  }
  const body: GitBody = { share: flags === 1, repo, updates, oids, covers };
  return equalBytes(writeBody(body), bytes) ? body : undefined;
}
