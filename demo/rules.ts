// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The villain's rules, as pure functions over what a real Signal server sees.
//
// A rule may only use: the recipient account and device, the envelope type,
// the timestamp, the ciphertext size, and the set of accounts addressed by the
// same multi-recipient send. The sender of a sealed-sender group message is
// not on the envelope, but the server can infer it: the group minus the
// addressed accounts. Nothing here reads plaintext or keys.
//
// Two adapters use this module: EvilServer (demo/evil.ts) and, if the
// fallback client is ever built, its websocket relay.

/** A member's short name, e.g. 'alice'. */
export type Name = string;

/**
 * One envelope on its way to one linked device, as the server sees it.
 *
 * Example: Alice's group message to Carol's desktop looks like
 * `{ to: 'carol', toDevice: 2, type: 'sealed', ts: 1730000000000n,
 *    size: 1234, sendId: '1730000000000:9f3a…', recipients: {bob, carol},
 *    from: 'alice' }`.
 */
export type Seen = Readonly<{
  to: Name;
  toDevice: number;
  type: string;
  ts: bigint;
  size: number;
  // Identifies one send request: every envelope of one multi-recipient send
  // shares it, and two different sends never do.
  sendId: string;
  // Every account the same send addressed (just `to` for a 1:1 send).
  recipients: ReadonlySet<Name>;
  // The sender, if the server knows it or can infer it.
  from: Name | undefined;
}>;

/** What to do with one envelope. */
export type Verdict = 'pass' | 'drop' | 'hold';

/**
 * A rule. `once` rules bind to the first send they match and then only
 * affect envelopes of that same send (all of the recipient's devices).
 *
 * Example: `dropGroupMsg('alice', 'carol')` is a `once` drop rule.
 */
export type Rule = Readonly<{
  id: string;
  verdict: Exclude<Verdict, 'pass'>;
  once: boolean;
  match: (seen: Seen) => boolean;
  // Set when a `once` rule has fired: the send it is bound to.
  boundTo?: string;
  // A hold rule whose envelopes the villain drops, not delivers, when it is
  // cleared (holdCatchUp).
  dropHeldOnClear?: boolean;
}>;

/** True when the envelope is part of a send to two or more accounts. */
export function isGroupSend(seen: Seen): boolean {
  return seen.recipients.size >= 2;
}

/**
 * Drop one group message from `from` to `to`, then do nothing more.
 * Receipts, typing indicators and 1:1 sender-key distributions do not match:
 * they are not sends to two or more accounts, or not from `from`.
 *
 * Example: `dropGroupMsg('alice', 'carol')`.
 */
export function dropGroupMsg(from: Name, to: Name): Rule {
  return {
    id: `dropGroupMsg(${from}, ${to})`,
    verdict: 'drop',
    once: true,
    match: seen => seen.to === to && seen.from === from && isGroupSend(seen),
  };
}

/**
 * Discard everything sent to `to`'s linked devices until cleared.
 *
 * Example: `blackhole('carol')`.
 */
export function blackhole(to: Name): Rule {
  return {
    id: `blackhole(${to})`,
    verdict: 'drop',
    once: false,
    match: seen => seen.to === to,
  };
}

/**
 * Queue everything sent to `to`'s linked devices until `release(to)`.
 *
 * Example: `hold('carol')`.
 */
export function hold(to: Name): Rule {
  return {
    id: `hold(${to})`,
    verdict: 'hold',
    once: false,
    match: seen => seen.to === to,
  };
}

/** "alice" -> "Alice". */
function title(name: Name): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** ['alice', 'bob', 'carol'] -> "Alice, Bob and Carol". */
function titles(names: ReadonlyArray<Name>): string {
  const t = names.map(title);
  return t.length < 2
    ? (t[0] ?? 'nobody')
    : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
}

/**
 * Beat 5's villain: "Alice, Bob and Carol offline: hold Dave's catch-up".
 * Queues every 1:1 envelope to the linked desktops of `offline` until the
 * villain is cleared. A new desktop's catch-up request (JOIN_PLAN §6.1) is
 * such an envelope: a sealed 1:1 message the server cannot read, so it holds
 * them all, receipts too. Nobody answers `joiner`'s catch-up meanwhile, and
 * `joiner`'s new desktop stays empty. Group sends pass, and so does a
 * member's own sync (`from` is `to`): the chat goes on, and live messages
 * reach everyone. Clearing the villain (POST /clear) drops what this rule
 * held instead of delivering it: delivered late, the catch-up's answers
 * would add the restored history again, as new messages under the live
 * ones.
 *
 * Example: `holdCatchUp('dave', ['alice', 'bob', 'carol'])`.
 */
export function holdCatchUp(joiner: Name, offline: ReadonlyArray<Name>): Rule {
  const them = offline.filter(n => n !== joiner);
  return {
    id:
      `${titles(them)} offline: hold ${title(joiner)}'s catch-up ` +
      '(1:1 messages to their desktops wait; clear drops them)',
    verdict: 'hold',
    once: false,
    dropHeldOnClear: true,
    match: seen =>
      them.includes(seen.to) && !isGroupSend(seen) && seen.from !== seen.to,
  };
}

/** The result of applying the rule list to one envelope. */
export type Decision = Readonly<{
  verdict: Verdict;
  ruleId: string | undefined;
  rules: ReadonlyArray<Rule>;
}>;

/**
 * Applies the first matching rule. A `once` rule that fires is bound to this
 * send; afterwards it only matches envelopes with the same `sendId`.
 *
 * Example: with `[dropGroupMsg('alice', 'carol')]`, the first group envelope
 * from Alice to Carol is dropped, and so is the same send to Carol's other
 * linked devices; Alice's next group message passes.
 */
export function decide(rules: ReadonlyArray<Rule>, seen: Seen): Decision {
  for (const rule of rules) {
    const applies =
      rule.boundTo === undefined
        ? rule.match(seen)
        : rule.boundTo === seen.sendId && rule.match(seen);
    if (!applies) {
      continue;
    }
    const next =
      rule.once && rule.boundTo === undefined
        ? rules.map(r => (r === rule ? { ...r, boundTo: seen.sendId } : r))
        : rules;
    return { verdict: rule.verdict, ruleId: rule.id, rules: next };
  }
  return { verdict: 'pass', ruleId: undefined, rules };
}

/**
 * Infers the sender of a send the server cannot attribute directly: the one
 * group member the send did not address.
 *
 * Example: group {alice, bob, carol}, recipients {bob, carol} gives 'alice';
 * recipients {carol} gives undefined.
 */
export function inferSender(
  group: ReadonlySet<Name>,
  recipients: ReadonlySet<Name>
): Name | undefined {
  if (recipients.size < 2) {
    return undefined;
  }
  for (const r of recipients) {
    if (!group.has(r)) {
      return undefined;
    }
  }
  const missing = [...group].filter(m => !recipients.has(m));
  return missing.length === 1 ? missing[0] : undefined;
}
