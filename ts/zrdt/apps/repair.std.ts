// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Piece repair (zrdt docs/apps/BUILD_M1.md §B.9 "Repair", §A.1 step 5): the
// requester's plan and the responder's request check. Pure: the transport
// sends the requests (per-digest ZrdtServeRequest with `announcement`), and
// reports replies and timeouts.
//
// The requester asks only current members that A seats, the author first,
// at most 3 requests at once, each for at most 8 pieces, every piece asked
// of one member at a time (disjoint). A piece moves to another member when
// its request times out, when the member does not have it, or when its bytes
// fail PIECE_ACCEPT; after a bad piece the member is never asked again, and
// only this user is told ("piece 7 from Dave failed its check").

import { MAX_REPAIR_PIECES } from './appMessage.std.ts';

/** How long a repair request waits for its reply (ZRDT_REPAIR_TIMEOUT_MS). */
export const DEFAULT_REPAIR_TIMEOUT_MS = 30_000;

/** At most this many repair requests in flight per announcement. */
export const MAX_REPAIR_IN_FLIGHT = 3;

/** ZRDT_REPAIR_TIMEOUT_MS: a positive number of ms, else the default. */
export function readRepairTimeoutMs(
  env: Readonly<Record<string, string | undefined>>
): number {
  const raw = env.ZRDT_REPAIR_TIMEOUT_MS;
  const value = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_REPAIR_TIMEOUT_MS;
}

export type RepairAsk = Readonly<{
  /** The plan's own id for the request (the transport maps it to a rid). */
  id: number;
  member: string;
  indices: ReadonlyArray<number>;
  sentAt: number;
}>;

/** What became of one asked piece in a reply. */
export type RepairPieceOutcome = 'ok' | 'bad' | 'absent';

type PieceStatus =
  | { state: 'wanted' }
  | { state: 'asked'; member: string; id: number }
  | { state: 'ok'; member: string }
  | { state: 'failed' };

/** One announcement's repair. */
export class RepairPlan {
  readonly #members: ReadonlyArray<string>;
  readonly #maxInFlight: number;
  readonly #maxPerRequest: number;
  readonly #timeoutMs: number;
  readonly #pieces = new Map<number, PieceStatus>();
  /** Members a piece was already tried with (and did not come from). */
  readonly #tried = new Map<number, Set<string>>();
  readonly #inFlight = new Map<number, RepairAsk>();
  readonly #dropped = new Set<string>();
  readonly #failedChecks = new Array<{ index: number; member: string }>();
  #nextId = 1;

  /**
   * `members`: the current members A seats that may be asked, the author
   * first, without this device's account.
   */
  constructor({
    needed,
    members,
    timeoutMs,
    maxInFlight = MAX_REPAIR_IN_FLIGHT,
    maxPerRequest = MAX_REPAIR_PIECES,
  }: Readonly<{
    needed: ReadonlyArray<number>;
    members: ReadonlyArray<string>;
    timeoutMs: number;
    maxInFlight?: number;
    maxPerRequest?: number;
  }>) {
    this.#members = [...new Set(members)];
    this.#timeoutMs = timeoutMs;
    this.#maxInFlight = maxInFlight;
    this.#maxPerRequest = Math.min(maxPerRequest, MAX_REPAIR_PIECES);
    for (const i of [...new Set(needed)].sort((a, b) => a - b)) {
      this.#pieces.set(i, { state: 'wanted' });
    }
  }

  #eligible(index: number, busy: ReadonlySet<string>): Array<string> {
    const tried = this.#tried.get(index) ?? new Set<string>();
    return this.#members.filter(
      m => !this.#dropped.has(m) && !tried.has(m) && !busy.has(m)
    );
  }

  /**
   * The requests to send now: each wanted piece goes to the eligible member
   * with the fewest pieces in this round (ties: the earlier member, so the
   * author first), at most one request per member, at most `maxInFlight`
   * requests in flight. A piece no member is left for fails.
   */
  next(now: number): Array<RepairAsk> {
    const busy = new Set([...this.#inFlight.values()].map(a => a.member));
    const plan = new Map<string, Array<number>>();
    for (const [index, status] of this.#pieces) {
      if (status.state !== 'wanted') {
        continue;
      }
      const eligibleAll = this.#eligible(index, new Set());
      if (eligibleAll.length === 0) {
        this.#pieces.set(index, { state: 'failed' });
        continue;
      }
      const slots = this.#maxInFlight - this.#inFlight.size;
      const free = this.#eligible(index, busy).filter(
        m =>
          (plan.has(m) || plan.size < slots) &&
          (plan.get(m)?.length ?? 0) < this.#maxPerRequest
      );
      if (free.length === 0) {
        continue;
      }
      let best = free[0] ?? '';
      for (const m of free) {
        if ((plan.get(m)?.length ?? 0) < (plan.get(best)?.length ?? 0)) {
          best = m;
        }
      }
      const list = plan.get(best) ?? [];
      list.push(index);
      plan.set(best, list);
    }
    const out = new Array<RepairAsk>();
    for (const member of this.#members) {
      const indices = plan.get(member);
      if (indices === undefined) {
        continue;
      }
      const ask: RepairAsk = { id: this.#nextId, member, indices, sentAt: now };
      this.#nextId += 1;
      this.#inFlight.set(ask.id, ask);
      for (const index of indices) {
        this.#pieces.set(index, { state: 'asked', member, id: ask.id });
      }
      out.push(ask);
    }
    return out;
  }

  #release(index: number, member: string): void {
    const tried = this.#tried.get(index) ?? new Set<string>();
    tried.add(member);
    this.#tried.set(index, tried);
    this.#pieces.set(index, { state: 'wanted' });
  }

  /**
   * A reply to request `id`: per asked piece, `ok` (PIECE_ACCEPT took it),
   * `bad` (its bytes failed: the member is dropped and the failure noted),
   * or absent from the map (the member did not send it: ask someone else).
   */
  onReply(id: number, outcomes: ReadonlyMap<number, RepairPieceOutcome>): void {
    const ask = this.#inFlight.get(id);
    if (ask === undefined) {
      return;
    }
    this.#inFlight.delete(id);
    for (const index of ask.indices) {
      const outcome = outcomes.get(index) ?? 'absent';
      if (outcome === 'ok') {
        this.#pieces.set(index, { state: 'ok', member: ask.member });
      } else {
        if (outcome === 'bad') {
          this.#dropped.add(ask.member);
          this.#failedChecks.push({ index, member: ask.member });
        }
        this.#release(index, ask.member);
      }
    }
  }

  /** A piece arrived another way (the CDN, another reply): stop asking for it. */
  onChecked(index: number): void {
    if (this.#pieces.has(index)) {
      this.#pieces.set(index, { state: 'ok', member: '' });
    }
  }

  /**
   * Requests older than the timeout: their pieces go back to `wanted`, and
   * their members are not asked again (a member that does not answer is
   * likely offline). Returns the expired requests.
   */
  expire(now: number): Array<RepairAsk> {
    const out = new Array<RepairAsk>();
    for (const ask of [...this.#inFlight.values()]) {
      if (now - ask.sentAt >= this.#timeoutMs) {
        this.#inFlight.delete(ask.id);
        this.#dropped.add(ask.member);
        for (const index of ask.indices) {
          if (this.#pieces.get(index)?.state === 'asked') {
            this.#release(index, ask.member);
          }
        }
        out.push(ask);
      }
    }
    return out;
  }

  /** The time the next request expires, if any is in flight. */
  nextDeadline(): number | undefined {
    let best: number | undefined;
    for (const ask of this.#inFlight.values()) {
      const at = ask.sentAt + this.#timeoutMs;
      best = best === undefined ? at : Math.min(best, at);
    }
    return best;
  }

  get done(): boolean {
    return [...this.#pieces.values()].every(s => s.state === 'ok');
  }

  /** Every piece is either checked or has no member left. */
  get settled(): boolean {
    return [...this.#pieces.values()].every(
      s => s.state === 'ok' || s.state === 'failed'
    );
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  failedChecks(): Array<{ index: number; member: string }> {
    return [...this.#failedChecks];
  }

  dropped(): Array<string> {
    return [...this.#dropped];
  }

  pieces(): Array<{
    index: number;
    state: 'wanted' | 'asked' | 'ok' | 'failed';
    member?: string;
  }> {
    return [...this.#pieces.entries()].map(([index, s]) =>
      s.state === 'asked' || s.state === 'ok'
        ? { index, state: s.state, member: s.member }
        : { index, state: s.state }
    );
  }
}

/**
 * The responder's check of a piece repair request (BUILD_M1 §B.9
 * "Responder"): the requester is a current member of the channel's Signal
 * group (T-m11), the announcement digest is 32 bytes, and it wants 1 to 8
 * digests. The piece store is then found by A's digest (T-m10); SERVE does
 * the rest (only seated requesters get content).
 */
export function checkRepairRequest({
  isMember,
  announcement,
  wanted,
}: Readonly<{
  isMember: boolean;
  announcement: Uint8Array<ArrayBuffer> | undefined;
  wanted: ReadonlyArray<Uint8Array<ArrayBuffer>>;
}>):
  | { ok: true }
  | { ok: false; reason: 'notMember' | 'noAnnouncement' | 'wanted' } {
  if (!isMember) {
    return { ok: false, reason: 'notMember' };
  }
  if (announcement?.length !== 32) {
    return { ok: false, reason: 'noAnnouncement' };
  }
  if (
    wanted.length < 1 ||
    wanted.length > MAX_REPAIR_PIECES ||
    wanted.some(w => w.length !== 32)
  ) {
    return { ok: false, reason: 'wanted' };
  }
  return { ok: true };
}
