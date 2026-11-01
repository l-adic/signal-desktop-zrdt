// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// EvilServer: Signal's mock server with a villain in front of the linked
// desktops. It overrides two methods (APP.md §8a):
//
// - `prepareMultiDeviceMessage` runs once per addressed account, before any
//   delivery, for every send route (websocket 1:1, gRPC multi-recipient,
//   gRPC sync). It records which accounts one send addressed.
// - `handleMessage` runs once per delivery to one device. Deliveries to the
//   fake phones (device 1) pass untouched; deliveries to linked desktops go
//   through the rules in demo/rules.ts.
//
// `send()` is NOT overridden: it also carries the fake phones' own traffic
// and sees neither the source nor the recipient set.
//
// The mock process holds every key. The rules only look at what a real
// server sees (demo/rules.ts); that is a policy, not a property of the mock.

import { createHash } from 'node:crypto';

import { Server } from '@signalapp/mock-server';
import type {
  Config,
  Device,
  EnvelopeType,
  ServiceIdKind,
} from '@signalapp/mock-server';

import { decide, inferSender, hold, blackhole, dropGroupMsg } from './rules.ts';
import type { Name, Rule, Seen, Verdict } from './rules.ts';

export { hold, blackhole, dropGroupMsg };

/** One line of the villain's log: what it saw and what it did. */
export type EvilLogEntry = Readonly<{
  at: number;
  seen: Seen;
  verdict: Verdict;
  ruleId: string | undefined;
}>;

type SendRecord = { at: number; recipients: Set<Name> };

// Sends older than this are forgotten (they have long been delivered).
const SEND_MEMORY_MS = 10 * 60 * 1000;

// Bytes from the end of a per-recipient payload used to recognise one send.
const TAIL_BYTES = 32;

// A sealed-sender v2 payload for one recipient is: version, that recipient's
// key material, then the bytes shared by every recipient of the send. So the
// tail identifies the multi-recipient send, the way a real server knows which
// request an envelope came from. Separately encrypted 1:1 sends (sender-key
// distributions, receipts) have different tails even with equal timestamps.
function tailOf(payload: Uint8Array<ArrayBuffer>): string {
  const start = Math.max(0, payload.length - TAIL_BYTES);
  return createHash('sha256')
    .update(payload.subarray(start))
    .digest('hex')
    .slice(0, 16);
}

export class EvilServer extends Server {
  // Every decision on a delivery to a linked desktop, oldest first.
  public readonly log: Array<EvilLogEntry> = [];
  // When set, each decision is also printed.
  public verbose = false;

  readonly #names = new Map<string, Name>();
  readonly #group = new Set<Name>();
  #rules: ReadonlyArray<Rule> = [];
  readonly #held: Array<{ to: Name; deliver: () => Promise<void> }> = [];
  readonly #sendIdByKey = new Map<string, string>();
  readonly #sends = new Map<string, SendRecord>();
  #nextSend = 0;

  constructor(config: Config = {}) {
    super(config);
  }

  /** Names an account (its ACI and PNI) and adds it to the demo group. */
  public addMember(name: Name, serviceIds: ReadonlyArray<string>): void {
    for (const id of serviceIds) {
      this.#names.set(id, name);
    }
    this.#group.add(name);
  }

  /** The active rules, first match wins. */
  public get rules(): ReadonlyArray<Rule> {
    return this.#rules;
  }

  /** Adds a rule after the existing ones. */
  public arm(rule: Rule): void {
    this.#rules = [...this.#rules, rule];
  }

  /** Removes every rule; held envelopes stay held until `release`. */
  public clearRules(): void {
    this.#rules = [];
  }

  /**
   * Turns the villain off: removes every rule and delivers everything still
   * held. Returns the number of envelopes delivered. Dropped (blackholed)
   * envelopes are gone for good; the app has to ask for them again.
   */
  public async clear(): Promise<number> {
    this.#rules = [];
    const all = this.#held.splice(0);
    for (const h of all) {
      // oxlint-disable-next-line no-await-in-loop
      await h.deliver();
    }
    return all.length;
  }

  /** How many envelopes are held, per recipient. */
  public heldCounts(): Record<Name, number> {
    const counts: Record<Name, number> = {};
    for (const h of this.#held) {
      counts[h.to] = (counts[h.to] ?? 0) + 1;
    }
    return counts;
  }

  /** The demo group's members, by short name. */
  public get members(): ReadonlyArray<Name> {
    return [...this.#group];
  }

  /** Removes `to`'s hold rule and delivers what was held for `to`. */
  public async release(to: Name): Promise<number> {
    this.#rules = this.#rules.filter(r => r.id !== hold(to).id);
    const mine = this.#held.filter(h => h.to === to);
    for (const h of mine) {
      this.#held.splice(this.#held.indexOf(h), 1);
    }
    for (const h of mine) {
      // oxlint-disable-next-line no-await-in-loop
      await h.deliver();
    }
    return mine.length;
  }

  #name(serviceId: string): Name {
    return this.#names.get(serviceId) ?? serviceId;
  }

  #forgetOldSends(now: number): void {
    for (const [id, rec] of this.#sends) {
      if (now - rec.at > SEND_MEMORY_MS) {
        this.#sends.delete(id);
      }
    }
    for (const [key, id] of this.#sendIdByKey) {
      if (!this.#sends.has(id)) {
        this.#sendIdByKey.delete(key);
      }
    }
  }

  public override async prepareMultiDeviceMessage(
    ...args: Parameters<Server['prepareMultiDeviceMessage']>
  ): ReturnType<Server['prepareMultiDeviceMessage']> {
    const [, targetServiceId, messages, timestamp] = args;
    const now = Date.now();
    this.#forgetOldSends(now);

    // Must stay synchronous up to `super`: the gRPC multi-recipient route
    // calls this for every recipient before it delivers to any of them.
    const keys = [
      ...new Set(
        messages.map(
          m => `${timestamp}:${tailOf(Buffer.from(m.content, 'base64'))}`
        )
      ),
    ];
    let sendId = keys
      .map(k => this.#sendIdByKey.get(k))
      .find(id => id !== undefined);
    if (sendId === undefined) {
      this.#nextSend += 1;
      sendId = `${timestamp}#${this.#nextSend}`;
      this.#sends.set(sendId, { at: now, recipients: new Set() });
    }
    for (const k of keys) {
      this.#sendIdByKey.set(k, sendId);
    }
    this.#sends.get(sendId)?.recipients.add(this.#name(targetServiceId));

    return super.prepareMultiDeviceMessage(...args);
  }

  public override async handleMessage(
    source: Device | undefined,
    serviceIdKind: ServiceIdKind,
    envelopeType: EnvelopeType,
    target: Device,
    encrypted: Buffer<ArrayBuffer>,
    timestamp: bigint
  ): Promise<void> {
    const deliver = () =>
      super.handleMessage(
        source,
        serviceIdKind,
        envelopeType,
        target,
        encrypted,
        timestamp
      );
    if (target.deviceId === 1) {
      return deliver();
    }

    const to = this.#name(target.aci);
    const sendId =
      this.#sendIdByKey.get(`${timestamp}:${tailOf(encrypted)}`) ??
      `${timestamp}#unrecorded`;
    const recipients: ReadonlySet<Name> =
      this.#sends.get(sendId)?.recipients ?? new Set([to]);
    const from =
      source !== undefined
        ? this.#name(source.aci)
        : inferSender(this.#group, recipients);
    const seen: Seen = {
      to,
      toDevice: target.deviceId,
      type: envelopeType,
      ts: timestamp,
      size: encrypted.length,
      sendId,
      recipients,
      from,
    };

    const decision = decide(this.#rules, seen);
    this.#rules = decision.rules;
    const entry: EvilLogEntry = {
      at: Date.now(),
      seen,
      verdict: decision.verdict,
      ruleId: decision.ruleId,
    };
    this.log.push(entry);
    if (this.verbose) {
      // oxlint-disable-next-line no-console
      console.log(`[evil] ${formatEntry(entry)}`);
    }

    if (decision.verdict === 'drop') {
      return;
    }
    if (decision.verdict === 'hold') {
      this.#held.push({ to, deliver });
      return;
    }
    return deliver();
  }
}

/** One log entry as a line, e.g. `alice -> carol.2 group[bob,carol] drop`. */
export function formatEntry(e: EvilLogEntry): string {
  const { seen } = e;
  const group =
    seen.recipients.size >= 2
      ? ` group[${[...seen.recipients].sort().join(',')}]`
      : '';
  return (
    `${new Date(e.at).toISOString()} ${seen.from ?? '?'} -> ` +
    `${seen.to}.${seen.toDevice} ${seen.type} ts=${seen.ts} ` +
    `${seen.size}B send=${seen.sendId}${group} ${e.verdict}` +
    (e.ruleId ? ` (${e.ruleId})` : '')
  );
}
