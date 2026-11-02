// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The git ops of the protocol-5 stub (zrdt docs/apps/BUILD_M1.md §B.7):
// raw objects and their checks, the push body, the pusher's table and its
// checks (GIT_PREPARE), the receiver's object list (GIT_OBJECTS) and the
// push log and register (GIT_VIEW). Written from BUILD_M1 §B.7 only; the
// Lean lane git's code (core/Zrdt/Git.lean) is authoritative once it lands.
//
// Provisional where BUILD_M1 leaves a choice (the vectors will pin them):
// a git announcement's app manifest (226) is empty; BAD_OBJECTS reason NAME
// covers a bad repository name and a bad or repeated ref name, LIMITS more
// than 512 objects, and LIST a delete in a share or an object list that is
// not the stream's; a failing GATE seat that is neither new nor key-changed
// is marked new.

import type {
  AppSeat,
  BadAppReason,
  BadObjects,
  BadObjectsReason,
  Bytes,
  Digest,
  GitLogEntry,
  GitObjectEntry,
  GitObjectKind,
  GitObjectsResult,
  GitPrepareRequest,
  GitPrepareResult,
  GitRefEntry,
  GitViewResult,
  Oid,
  PushRefused,
  SeatMark,
  ServeHeld,
} from '../ZrdtBackend.std.ts';
import { parseAudience } from '../audience.std.ts';
import type { Seat } from '../audience.std.ts';
import {
  APP_GIT,
  CHANNEL_GIT,
  appMessageBytes,
  appOfOpening,
  concat,
  equalBytes,
  fromUtf8,
  toHex,
  utf8,
  writeDescriptor,
} from '../apps/appMessage.std.ts';
import type { AppHeader } from '../apps/appMessage.std.ts';
import type { GitBody } from '../apps/gitBody.std.ts';
import {
  parseBody,
  validRefName,
  validRepoName,
  writeBody,
} from '../apps/gitBody.std.ts';
import type { PieceCtx } from './pieceStub.node.ts';
import {
  authorCtx,
  authorLimitsOk,
  channelIdOf,
  firstBadSlice,
} from './pieceStub.node.ts';
import { compareBytes, opens, sha256 } from './stub.node.ts';
import type { StubStore } from './stub.node.ts';

/** At most 512 objects per push (BUILD_M1 §B.3). */
export const MAX_OBJECTS = 512;

const OID_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Objects (§B.7 "Objects")
// ---------------------------------------------------------------------------

export type GitObj = Readonly<{
  kind: GitObjectKind;
  id: Oid;
  /** Where the raw object starts in the stream, and its length. */
  offset: number;
  length: number;
  /** The ids it references: a commit's tree and parents, a tree's entries. */
  refs: ReadonlyArray<Oid>;
  /** A commit's parents. */
  parents: ReadonlyArray<Oid>;
}>;

function bad(reason: BadObjectsReason, oid?: Oid): BadObjects {
  return oid === undefined
    ? { kind: 'badObjects', reason }
    : { kind: 'badObjects', reason, oid };
}

/** The raw form of an object: `"<type> <len>\0" ‖ content`. */
export function rawObject(kind: GitObjectKind | 'tag', content: Bytes): Bytes {
  return concat([utf8(`${kind} ${content.length}\0`), content]);
}

const TREE_MODES = new Set(['100644', '100755', '120000', '40000']);

/** Git's tree order: names compare as bytes, a tree's name with '/' appended. */
function treeKey(name: Bytes, isTree: boolean): Bytes {
  return isTree ? concat([name, Uint8Array.of(0x2f)]) : name;
}

function parseTree(content: Bytes): Array<Oid> | BadObjectsReason {
  const refs = new Array<Oid>();
  let offset = 0;
  let previous: Bytes | undefined;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) {
      return 'malformed';
    }
    const mode = fromUtf8(content.slice(offset, space));
    if (mode === '160000') {
      return 'gitlink';
    }
    if (mode === undefined || !TREE_MODES.has(mode)) {
      return 'malformed';
    }
    const nul = content.indexOf(0, space + 1);
    if (nul < 0 || nul + 1 + OID_BYTES > content.length) {
      return 'malformed';
    }
    const name = content.slice(space + 1, nul);
    const text = fromUtf8(name);
    if (
      name.length === 0 ||
      name.includes(0x2f) ||
      text === '.' ||
      text === '..'
    ) {
      return 'malformed';
    }
    const key = treeKey(name, mode === '40000');
    if (previous !== undefined && compareBytes(previous, key) >= 0) {
      return 'malformed';
    }
    previous = key;
    refs.push(content.slice(nul + 1, nul + 1 + OID_BYTES));
    offset = nul + 1 + OID_BYTES;
  }
  return refs;
}

function oidOfHex(hex: string): Oid {
  const out = new Uint8Array(OID_BYTES);
  for (let i = 0; i < OID_BYTES; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * A commit's header: exactly `tree <hex>`, `parent <hex>`*, `author`,
 * `committer`, an optional `encoding`, then a blank line. Anything else
 * (gpgsig, mergetag, continuation lines, unknown headers) is HEADER.
 */
function parseCommit(
  content: Bytes
): { tree: Oid; parents: Array<Oid> } | BadObjectsReason {
  const end = (() => {
    for (let i = 0; i + 1 < content.length; i += 1) {
      if (content[i] === 0x0a && content[i + 1] === 0x0a) {
        return i;
      }
    }
    return -1;
  })();
  if (end < 0) {
    return 'header';
  }
  const header = fromUtf8(content.slice(0, end));
  if (header === undefined) {
    return 'header';
  }
  const lines = header.split('\n');
  let i = 0;
  const treeLine = lines[i] ?? '';
  if (!treeLine.startsWith('tree ') || !HEX64.test(treeLine.slice(5))) {
    return 'header';
  }
  const tree = oidOfHex(treeLine.slice(5));
  i += 1;
  const parents = new Array<Oid>();
  while ((lines[i] ?? '').startsWith('parent ')) {
    const hex = (lines[i] ?? '').slice(7);
    if (!HEX64.test(hex)) {
      return 'header';
    }
    parents.push(oidOfHex(hex));
    i += 1;
  }
  if (!(lines[i] ?? '').startsWith('author ')) {
    return 'header';
  }
  i += 1;
  if (!(lines[i] ?? '').startsWith('committer ')) {
    return 'header';
  }
  i += 1;
  if ((lines[i] ?? '').startsWith('encoding ')) {
    i += 1;
  }
  return i === lines.length ? { tree, parents } : 'header';
}

/**
 * The checked objects of a stream (Lean `checkObjects`): raw objects back to
 * back, ids strictly increasing, each id recomputed, only commits, trees and
 * blobs, trees and commit headers as §B.7 allows.
 */
export function checkObjects(stream: Bytes): Array<GitObj> | BadObjects {
  const out = new Array<GitObj>();
  let offset = 0;
  while (offset < stream.length) {
    if (out.length >= MAX_OBJECTS) {
      return bad('limits');
    }
    const space = stream.indexOf(0x20, offset);
    const nul = stream.indexOf(0, offset);
    if (space < 0 || nul < 0 || nul < space || space - offset > 6) {
      return bad('malformed');
    }
    const type = fromUtf8(stream.slice(offset, space));
    const lenText = fromUtf8(stream.slice(space + 1, nul)) ?? '';
    if (!/^(0|[1-9][0-9]{0,15})$/.test(lenText)) {
      return bad('malformed');
    }
    const len = Number(lenText);
    const start = nul + 1;
    const stop = start + len;
    if (stop > stream.length) {
      return bad('malformed');
    }
    const raw = stream.slice(offset, stop);
    const id = sha256(raw);
    if (type === 'tag') {
      return bad('kind', id);
    }
    if (type !== 'commit' && type !== 'tree' && type !== 'blob') {
      return bad('malformed', id);
    }
    const previous = out.at(-1);
    if (previous !== undefined && compareBytes(previous.id, id) >= 0) {
      return bad('order', id);
    }
    const content = stream.slice(start, stop);
    let refs: Array<Oid> = [];
    let parents: Array<Oid> = [];
    if (type === 'tree') {
      const tree = parseTree(content);
      if (typeof tree === 'string') {
        return bad(tree, id);
      }
      refs = tree;
    } else if (type === 'commit') {
      const commit = parseCommit(content);
      if (typeof commit === 'string') {
        return bad(commit, id);
      }
      parents = commit.parents;
      refs = [commit.tree, ...commit.parents];
    }
    out.push({ kind: type, id, offset, length: stop - offset, refs, parents });
    offset = stop;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The table (§B.7 "The table")
// ---------------------------------------------------------------------------

export type TableEntry = Readonly<{
  digest: Digest;
  author: Bytes;
  seats: ReadonlyArray<Seat>;
  body: GitBody;
  links: ReadonlyArray<Digest>;
}>;

export type GitTable = Readonly<{
  entries: ReadonlyArray<TableEntry>;
  complete: boolean;
}>;

type TableOrRefusal =
  | { kind: 'table'; table: GitTable }
  | { kind: 'badOpening' }
  | { kind: 'openingsMissing'; digests: Array<Digest> };

/** The pusher's table from the channel store and the openings the host holds. */
export function tableOf(
  store: StubStore,
  helds: ReadonlyArray<ServeHeld>
): TableOrRefusal {
  const held = new Map<string, Bytes>();
  for (const h of helds) {
    held.set(toHex(h.digest), h.opening);
  }
  const entries = new Array<TableEntry>();
  const missing = new Array<Digest>();
  let allAudiences = true;
  for (const e of store.entries()) {
    const key = toHex(e.digest);
    const opening = held.get(key);
    const recorded = store.audienceOf(e.digest) !== undefined;
    allAudiences &&= recorded;
    if (opening === undefined) {
      if (recorded) {
        missing.push(new Uint8Array(e.digest));
      }
      continue;
    }
    if (!opens(e.record, opening)) {
      return { kind: 'badOpening' };
    }
    const h = appOfOpening(opening);
    if (
      h === undefined ||
      fromUtf8(h.app) !== APP_GIT ||
      fromUtf8(h.channel) !== CHANNEL_GIT
    ) {
      continue;
    }
    const body = parseBody(h.body);
    const seats = parseAudience(h.audience);
    if (body === undefined || seats === undefined) {
      continue;
    }
    entries.push({
      digest: new Uint8Array(e.digest),
      author: new Uint8Array(e.record.author),
      seats,
      body,
      links: e.record.links,
    });
  }
  if (missing.length > 0) {
    return {
      kind: 'openingsMissing',
      digests: missing.sort(compareBytes),
    };
  }
  return {
    kind: 'table',
    table: {
      entries,
      complete: store.boundaryDigests().length === 0 && allAudiences,
    },
  };
}

function seatKey(s: AppSeat): string {
  return toHex(concat([s.aci, s.tag]));
}

function isZero(bytes: Bytes): boolean {
  return bytes.every(b => b === 0);
}

/** The entry's audience seats `s`: same ACI and tag, the tag not zero. */
function seated(e: TableEntry, s: AppSeat): boolean {
  return (
    !isZero(s.tag) &&
    e.seats.some(x => equalBytes(x.aci, s.aci) && equalBytes(x.tag, s.tag))
  );
}

function lists(e: TableEntry, oid: Oid): boolean {
  return e.body.oids.some(o => equalBytes(o, oid));
}

function entitled(t: GitTable, s: AppSeat, oid: Oid): boolean {
  return t.entries.some(e => lists(e, oid) && seated(e, s));
}

function keyChanged(t: GitTable, s: AppSeat): boolean {
  return t.entries.some(e =>
    e.seats.some(
      x => x.seated && equalBytes(x.aci, s.aci) && !equalBytes(x.tag, s.tag)
    )
  );
}

function sameOpt(a: Oid | undefined, b: Oid | undefined): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined && equalBytes(a, b);
}

function assigns(
  e: TableEntry,
  repo: string,
  name: string,
  value: Oid | undefined
): boolean {
  return (
    e.body.repo === repo &&
    e.body.updates.some(u => u.name === name && sameOpt(u.new, value))
  );
}

function uniqueOids(oids: Iterable<Oid>): Array<Oid> {
  const map = new Map<string, Oid>();
  for (const o of oids) {
    map.set(toHex(o), o);
  }
  return [...map.values()].sort(compareBytes);
}

// ---------------------------------------------------------------------------
// GIT_PREPARE (§B.7)
// ---------------------------------------------------------------------------

function refused(
  reason: PushRefused['reason'],
  seats: ReadonlyArray<{ seat: AppSeat; mark: SeatMark }> = [],
  refs: ReadonlyArray<string> = [],
  oids: ReadonlyArray<Oid> = []
): PushRefused {
  return { kind: 'pushRefused', reason, seats, refs, oids };
}

function badApp(reason: BadAppReason): {
  kind: 'badApp';
  reason: BadAppReason;
} {
  return { kind: 'badApp', reason };
}

function gitChannelOk(store: StubStore, signalGroup: Bytes): boolean {
  return equalBytes(
    store.group,
    channelIdOf(signalGroup, utf8(APP_GIT), utf8(CHANNEL_GIT))
  );
}

/** GIT_PREPARE on the channel store (NO_CHAT checked by the caller). */
export function gitPrepare(
  store: StubStore,
  q: GitPrepareRequest
): GitPrepareResult {
  if (!gitChannelOk(store, q.signalGroup)) {
    return badApp('notStored');
  }
  const audience = parseAudience(q.audience);
  if (
    audience === undefined ||
    !authorLimitsOk(q.exp, q.audience, q.pointers, q.stream.length, true)
  ) {
    return badApp('limits');
  }
  const t = tableOf(store, q.helds);
  if (t.kind !== 'table') {
    return t;
  }
  const { table } = t;

  // 5. The objects, the names, a delete in a share.
  const objects = checkObjects(q.stream);
  if (!Array.isArray(objects)) {
    return objects;
  }
  if (!validRepoName(q.repo)) {
    return bad('name');
  }
  const names = new Set<string>();
  for (const u of q.updates) {
    if (!validRefName(u.name) || names.has(u.name)) {
      return bad('name');
    }
    names.add(u.name);
  }
  if (q.share && q.updates.some(u => u.new === undefined)) {
    return bad('list');
  }

  const carried = new Set(objects.map(o => toHex(o.id)));
  const refsOut = uniqueOids(
    [
      ...objects.flatMap(o => o.refs),
      ...q.updates.flatMap(u => [
        ...(u.old === undefined ? [] : [u.old]),
        ...(u.new === undefined ? [] : [u.new]),
      ]),
    ].filter(o => !carried.has(toHex(o)))
  );
  const own = toHex(q.author);
  const checked = audience
    .filter(s => s.seated && toHex(s.aci) !== own)
    .map(s => ({ aci: s.aci, tag: s.tag }));

  if (!q.share) {
    // 6. Root rule (G-F1).
    const roots = objects.filter(
      o => o.kind === 'commit' && o.parents.length === 0
    );
    if (roots.length > 0 && !table.complete) {
      return refused(
        'root',
        [],
        [],
        roots.map(o => o.id)
      );
    }
    // 7. Freshness (G-M6).
    const old = objects.filter(o => table.entries.some(e => lists(e, o.id)));
    if (old.length > 0) {
      return refused(
        'oldObject',
        [],
        [],
        old.map(o => o.id)
      );
    }
    // 8. The gate (G-M1) and the name rule.
    const failing = new Array<{ seat: AppSeat; mark: SeatMark }>();
    const badRefs = new Set<string>();
    const missing = new Map<string, Oid>();
    for (const s of checked) {
      let fails = false;
      for (const x of refsOut) {
        if (!entitled(table, s, x)) {
          fails = true;
          missing.set(toHex(x), x);
        }
      }
      for (const u of q.updates) {
        if (
          u.old !== undefined &&
          !table.entries.some(
            e => seated(e, s) && assigns(e, q.repo, u.name, u.old)
          )
        ) {
          fails = true;
          badRefs.add(u.name);
        }
      }
      if (fails) {
        failing.push({
          seat: s,
          mark: keyChanged(table, s) ? 'keyChanged' : 'new',
        });
      }
    }
    if (failing.length > 0) {
      return refused(
        'gate',
        failing,
        [...badRefs].sort(),
        uniqueOids(missing.values())
      );
    }
  }

  let covers = new Array<AppSeat>();
  if (q.share) {
    // 9. Shares (G-M7).
    const commits = objects.filter(o => o.kind === 'commit');
    const newValues = uniqueOids(
      q.updates.flatMap(u => (u.new === undefined ? [] : [u.new]))
    );
    const commitIds = uniqueOids(commits.map(o => o.id));
    const parents = new Set(commits.flatMap(o => o.parents.map(toHex)));
    const exact =
      commitIds.length === newValues.length &&
      commitIds.every((c, i) => {
        const v = newValues[i];
        return v !== undefined && equalBytes(c, v);
      });
    if (
      !exact ||
      !refsOut.every(x => parents.has(toHex(x))) ||
      q.updates.some(
        u =>
          u.new === undefined ||
          (u.old !== undefined && !equalBytes(u.old, u.new))
      )
    ) {
      return refused('badShare');
    }
    covers = checked
      .filter(s =>
        objects.some(
          o =>
            table.entries.some(e => lists(e, o.id)) && !entitled(table, s, o.id)
        )
      )
      .sort((a, b) =>
        compareBytes(concat([a.aci, a.tag]), concat([b.aci, b.tag]))
      );
    const changed = covers.filter(s => keyChanged(table, s));
    if (changed.length > 0) {
      return refused(
        'keyChanged',
        changed.map(seat => ({ seat, mark: 'keyChanged' as const }))
      );
    }
    const expect = new Set(q.expect.map(seatKey));
    if (
      expect.size !== covers.length ||
      !covers.every(s => expect.has(seatKey(s)))
    ) {
      return refused(
        'coversChanged',
        covers.map(seat => ({ seat, mark: 'covered' as const }))
      );
    }
  }

  const body = writeBody({
    share: q.share,
    repo: q.repo,
    updates: q.updates,
    oids: objects.map(o => o.id),
    covers,
  });
  const header: AppHeader = {
    audience: q.audience,
    app: utf8(APP_GIT),
    channel: utf8(CHANNEL_GIT),
    body,
  };
  if (q.stream.length === 0) {
    return {
      kind: 'ok',
      message: appMessageBytes(header),
      ordered: [],
      covers,
    };
  }
  const ctx = authorCtx({
    channel: store.group,
    author: q.author,
    nonce: q.nonce,
    exp: q.exp,
    header,
    stream: q.stream,
    manifest: new Uint8Array(0),
  });
  return {
    kind: 'ok',
    message: appMessageBytes({
      ...header,
      descriptor: writeDescriptor(ctx.desc),
      ...(q.pointers.length > 0 ? { pointers: q.pointers } : {}),
    }),
    ordered: [...ctx.desc.ordered],
    covers,
  };
}

// ---------------------------------------------------------------------------
// GIT_OBJECTS (§B.7)
// ---------------------------------------------------------------------------

export function gitObjects(ctx: PieceCtx, stream: Bytes): GitObjectsResult {
  if (fromUtf8(ctx.header.app) !== APP_GIT) {
    return badApp('wrongApp');
  }
  const badIndex = firstBadSlice(ctx, stream);
  if (badIndex !== undefined) {
    return { kind: 'badPiece', index: badIndex };
  }
  const objects = checkObjects(stream);
  if (!Array.isArray(objects)) {
    return objects;
  }
  const body = parseBody(ctx.header.body);
  if (
    body === undefined ||
    body.oids.length !== objects.length ||
    !objects.every((o, i) => {
      const listed = body.oids[i];
      return listed !== undefined && equalBytes(listed, o.id);
    })
  ) {
    return bad('list');
  }
  return {
    kind: 'ok',
    objects: objects.map(
      (o): GitObjectEntry => ({
        kind: o.kind,
        oid: o.id,
        offset: o.offset,
        length: o.length,
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// GIT_VIEW (§B.7)
// ---------------------------------------------------------------------------

export function gitView(
  store: StubStore,
  signalGroup: Bytes,
  repo: string,
  helds: ReadonlyArray<ServeHeld>
): GitViewResult {
  if (!gitChannelOk(store, signalGroup)) {
    return badApp('notStored');
  }
  const t = tableOf(store, helds);
  if (t.kind !== 'table') {
    return t;
  }
  const entries = t.table.entries.filter(e => e.body.repo === repo);
  const log = entries
    .flatMap(e =>
      e.body.updates.map(
        (update): GitLogEntry => ({
          digest: e.digest,
          author: e.author,
          share: e.body.share,
          update,
        })
      )
    )
    .sort(
      (a, b) =>
        compareBytes(a.digest, b.digest) ||
        compareBytes(utf8(a.update.name), utf8(b.update.name))
    );
  const reachOf = new Map<string, Set<string>>();
  const reach = (e: TableEntry): Set<string> => {
    const key = toHex(e.digest);
    let r = reachOf.get(key);
    if (r === undefined) {
      r = store.reach(e.links);
      reachOf.set(key, r);
    }
    return r;
  };
  const refs = new Array<GitRefEntry>();
  for (const d of entries) {
    for (const u of d.body.updates) {
      const superseded = entries.some(
        f =>
          f.body.updates.some(
            x => x.name === u.name && sameOpt(x.old, u.new)
          ) && reach(f).has(toHex(d.digest))
      );
      if (!superseded) {
        refs.push(
          u.new === undefined
            ? { name: u.name, digest: d.digest }
            : { name: u.name, digest: d.digest, value: u.new }
        );
      }
    }
  }
  refs.sort(
    (a, b) =>
      compareBytes(utf8(a.name), utf8(b.name)) ||
      compareBytes(a.digest, b.digest)
  );
  return { kind: 'ok', log, refs };
}

/** The view's oids as hex, for messages and tests. */
export function oidHex(oid: Oid): string {
  return toHex(oid);
}
