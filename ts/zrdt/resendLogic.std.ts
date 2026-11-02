// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The decisions of the resend protocol (APP.md §5 steps 3, 7, 11), without
// Signal: the preload modules (resend.preload.ts, receive.preload.ts) supply
// the effects. Digests are lowercase hex here. What a responder sends is
// SERVE's decision (zrdtd), not this module's.

import { drop } from '../util/drop.std.ts';

export type Hex = string;

// --- requester: scheduling ------------------------------------------------------

export type ResendTarget =
  | Readonly<{ kind: 'direct'; aci: string }>
  | Readonly<{ kind: 'group' }>;

export type GapState = 'requested' | 'still-missing';

export type ResendSchedulerDeps = Readonly<{
  now: () => number;
  setTimer: (fn: () => void, ms: number) => void;
  // Whether the store now holds this digest.
  has: (conversationId: string, digest: Hex) => Promise<boolean>;
  sendRequest: (
    conversationId: string,
    target: ResendTarget,
    digests: ReadonlyArray<Hex>
  ) => Promise<void>;
  setGapState: (
    conversationId: string,
    digests: ReadonlyArray<Hex>,
    state: GapState
  ) => Promise<void>;
  onError?: (error: unknown) => void;
}>;

export type ResendSchedulerOptions = Readonly<{
  // ZRDT_RESEND_DELAY_MS: the gap row shows this long before the first ask.
  delayMs: number;
  // After a 1:1 ask: how long until the still-missing digests go to the group.
  groupAfterMs: number;
  // After the group ask: how long until the gap row says "still missing".
  giveUpAfterMs: number;
  // Automatic asks: one per digest per this window (handleRetry's dedupe).
  dedupeMs: number;
  // ZRDT_AUTHOR_FASTPATH_DELAY_MS: after a relayed message is shown, how
  // long until we ask its author for the live copy (step 9). 0 in the app;
  // the demo sets 3000 so "relayed by Bob" shows before "confirmed by Alice".
  authorFastPathDelayMs: number;
}>;

export function readResendOptions(
  env: Readonly<Record<string, string | undefined>>
): ResendSchedulerOptions {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    delayMs: num('ZRDT_RESEND_DELAY_MS', 4000),
    groupAfterMs: num('ZRDT_RESEND_GROUP_AFTER_MS', 5000),
    giveUpAfterMs: num('ZRDT_RESEND_GIVE_UP_AFTER_MS', 5000),
    dedupeMs: num('ZRDT_RESEND_DEDUPE_MS', 60_000),
    authorFastPathDelayMs: num('ZRDT_AUTHOR_FASTPATH_DELAY_MS', 0),
  };
}

type Outstanding = {
  // The member asked 1:1, if any; a NotFound from them escalates at once.
  directAci?: string;
  stage: 'direct' | 'group';
};

export class ResendScheduler {
  readonly #deps: ResendSchedulerDeps;
  readonly #options: ResendSchedulerOptions;
  // `${conversationId}:${digest}` -> last automatic ask
  readonly #lastAsked = new Map<string, number>();
  readonly #outstanding = new Map<string, Outstanding>();

  constructor(deps: ResendSchedulerDeps, options: ResendSchedulerOptions) {
    this.#deps = deps;
    this.#options = options;
  }

  get options(): ResendSchedulerOptions {
    return this.#options;
  }

  // Whether we asked for this digest and are still waiting (relay check).
  isOutstanding(conversationId: string, digest: Hex): boolean {
    return this.#outstanding.has(`${conversationId}:${digest}`);
  }

  // MISSING: ask after `delayMs` (the gap row is visible meanwhile).
  schedule(
    conversationId: string,
    digests: ReadonlyArray<Hex>,
    firstAskAci?: string
  ): void {
    this.#deps.setTimer(() => {
      this.#run(this.ask(conversationId, digests, firstAskAci));
    }, this.#options.delayMs);
  }

  // Ask now: 1:1 to `firstAskAci` if given, else to the group. `force` (the
  // UI's "Ask again") skips the per-minute dedupe.
  async ask(
    conversationId: string,
    digests: ReadonlyArray<Hex>,
    firstAskAci?: string,
    { force = false }: { force?: boolean } = {}
  ): Promise<void> {
    const now = this.#deps.now();
    const wanted: Array<Hex> = [];
    for (const digest of new Set(digests)) {
      const key = `${conversationId}:${digest}`;
      const last = this.#lastAsked.get(key);
      if (
        !force &&
        last != null &&
        now - last < this.#options.dedupeMs &&
        this.#outstanding.has(key)
      ) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      if (await this.#deps.has(conversationId, digest)) {
        this.#outstanding.delete(key);
        continue;
      }
      wanted.push(digest);
    }
    if (wanted.length === 0) {
      return;
    }
    for (const digest of wanted) {
      const key = `${conversationId}:${digest}`;
      this.#lastAsked.set(key, now);
      this.#outstanding.set(key, {
        directAci: firstAskAci,
        stage: firstAskAci ? 'direct' : 'group',
      });
    }
    await this.#deps.sendRequest(
      conversationId,
      firstAskAci ? { kind: 'direct', aci: firstAskAci } : { kind: 'group' },
      wanted
    );
    await this.#deps.setGapState(conversationId, wanted, 'requested');
    if (firstAskAci) {
      this.#deps.setTimer(() => {
        this.#run(this.escalate(conversationId, wanted));
      }, this.#options.groupAfterMs);
    } else {
      this.#armGiveUp(conversationId, wanted);
    }
  }

  // ZrdtNotFound from `fromAci`: if we asked that member 1:1, go to the group
  // now for those digests. Not decisive (APP.md §5 step 11).
  async onNotFound(
    conversationId: string,
    fromAci: string,
    digests: ReadonlyArray<Hex>
  ): Promise<void> {
    const escalate = digests.filter(digest => {
      const entry = this.#outstanding.get(`${conversationId}:${digest}`);
      return entry?.stage === 'direct' && entry.directAci === fromAci;
    });
    if (escalate.length > 0) {
      await this.escalate(conversationId, escalate);
    }
  }

  // Send the still-missing digests to the group (once per ask).
  async escalate(
    conversationId: string,
    digests: ReadonlyArray<Hex>
  ): Promise<void> {
    const still: Array<Hex> = [];
    for (const digest of digests) {
      const key = `${conversationId}:${digest}`;
      const entry = this.#outstanding.get(key);
      if (!entry || entry.stage !== 'direct') {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      if (await this.#deps.has(conversationId, digest)) {
        this.#outstanding.delete(key);
        continue;
      }
      entry.stage = 'group';
      still.push(digest);
    }
    if (still.length === 0) {
      return;
    }
    await this.#deps.sendRequest(conversationId, { kind: 'group' }, still);
    this.#armGiveUp(conversationId, still);
  }

  // The record arrived (by any path).
  resolved(conversationId: string, digest: Hex): void {
    this.#outstanding.delete(`${conversationId}:${digest}`);
  }

  #armGiveUp(conversationId: string, digests: ReadonlyArray<Hex>): void {
    this.#deps.setTimer(() => {
      this.#run(this.#giveUp(conversationId, digests));
    }, this.#options.giveUpAfterMs);
  }

  async #giveUp(
    conversationId: string,
    digests: ReadonlyArray<Hex>
  ): Promise<void> {
    const still: Array<Hex> = [];
    for (const digest of digests) {
      const key = `${conversationId}:${digest}`;
      // oxlint-disable-next-line no-await-in-loop
      if (await this.#deps.has(conversationId, digest)) {
        this.#outstanding.delete(key);
        continue;
      }
      // Keep it outstanding: a late answer is still welcome.
      still.push(digest);
    }
    if (still.length > 0) {
      await this.#deps.setGapState(conversationId, still, 'still-missing');
    }
  }

  #run(promise: Promise<void>): void {
    drop(this.#safely(promise));
  }

  async #safely(promise: Promise<void>): Promise<void> {
    try {
      await promise;
    } catch (error) {
      this.#deps.onError?.(error);
    }
  }
}

// --- receiver of a relay -------------------------------------------------------

// JOIN_PLAN §4.4: live only if the entry is marked author copy and the reply
// came from the record's author; otherwise relayed by the responder, even
// when the responder is the author (A8 confirmation then upgrades it).
export function relayProvenance(
  responderAci: string,
  authorAci: string | undefined,
  authorCopy: boolean
): Readonly<{ kind: 'live' }> | Readonly<{ kind: 'relayed'; byAci: string }> {
  return authorCopy && authorAci != null && authorAci === responderAci
    ? { kind: 'live' }
    : { kind: 'relayed', byAci: responderAci };
}

export type RelayAction =
  // Show the content (opening checked by ACCEPT_RECORD) at the gap's place.
  | 'show'
  // No opening: the gap row becomes "a message from A (content unavailable)".
  | 'structureOnly'
  // A record in our name that we did not create: accept, alarm, disown.
  | 'ownNameAlarm'
  // Nothing to show (we had it already, or nobody asked for it).
  | 'none';

// `wasRequested`: we asked for this digest and it had not arrived yet (so we
// did not hold it). `ownLive`: for a record in our name, whether our
// provenance for it is live (we created it, or a sync transcript of ours).
export function decideRelayAction({
  authorAci,
  ourAci,
  hasOpening,
  wasRequested,
  ownLive,
}: Readonly<{
  authorAci: string;
  ourAci: string;
  hasOpening: boolean;
  wasRequested: boolean;
  ownLive: boolean;
}>): RelayAction {
  if (authorAci === ourAci) {
    // Single zrdt device per account (APP.md §6): every record we created was
    // accepted live at send time, so one in our name that is not live is not
    // ours. Never refuse it (step 12).
    return ownLive ? 'none' : 'ownNameAlarm';
  }
  if (!wasRequested) {
    return 'none';
  }
  return hasOpening ? 'show' : 'structureOnly';
}

// --- timeline placement (APP.md §6) ---------------------------------------------

export type Placement = Readonly<{
  // The message's received_at (and _ms).
  receivedAtCounter: number;
  receivedAtDate: number;
  // Where a new gap row for its missing links goes (only if some are missing).
  gapReceivedAt?: number;
  gapReceivedAtMs?: number;
  // Gap rows the message answers.
  resolvesGapIds: ReadonlyArray<string>;
}>;

// A message M whose own digest some gap rows were waiting for takes the first
// one's place; a new gap for M's missing links shares that received_at and
// sorts above M by sent_at (M.sent_at - 1). Otherwise, if links are missing,
// the gap row takes M's counter and M is restamped with a new one, so
// recovered messages land between them.
export function planPlacement({
  gaps,
  missingCount,
  receivedAtCounter,
  receivedAtDate,
  nextCounter,
}: Readonly<{
  gaps: ReadonlyArray<{
    id: string;
    receivedAt: number;
    receivedAtMs?: number;
  }>;
  missingCount: number;
  receivedAtCounter: number;
  receivedAtDate: number;
  nextCounter: () => number;
}>): Placement {
  const place = gaps[0];
  const resolvesGapIds = gaps.map(gap => gap.id);
  if (place) {
    const date = place.receivedAtMs ?? receivedAtDate;
    return {
      receivedAtCounter: place.receivedAt,
      receivedAtDate: date,
      ...(missingCount > 0
        ? { gapReceivedAt: place.receivedAt, gapReceivedAtMs: date }
        : {}),
      resolvesGapIds,
    };
  }
  if (missingCount > 0) {
    return {
      receivedAtCounter: nextCounter(),
      receivedAtDate,
      gapReceivedAt: receivedAtCounter,
      gapReceivedAtMs: receivedAtDate,
      resolvesGapIds,
    };
  }
  return { receivedAtCounter, receivedAtDate, resolvesGapIds };
}
