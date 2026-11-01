// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Every user-facing zrdt string, in plain English (APP.md §7, PLAN.md §3.5,
// AMENDMENTS A8, A11). Wording names what differs, never who is at fault:
// no string here mentions the server or accuses a member.
// TODO(zrdt): move to Signal's _locales/ ICU strings after the demo.

import type { ZrdtDigestHex } from './words.std.ts';
import { formatTag, formatTagList } from './words.std.ts';

export function messagesCount(count: number): string {
  return count === 1 ? '1 message' : `${count} messages`;
}

// ---------------------------------------------------------------------------
// Gap row

export type ZrdtGapState =
  /** Before ZRDT_RESEND_DELAY_MS: spinner only. */
  | 'waiting'
  /** A ZrdtResendRequest went out; no answer yet. */
  | 'requested'
  /** NotFound or timeout: "still missing", with "Ask again". */
  | 'still-missing'
  /** A relay without an opening resolved the link: structure only. */
  | 'content-unavailable';

export function gapTitle(count: number, replierName: string): string {
  const pronoun = count === 1 ? 'it' : 'them';
  return `${messagesCount(count)} you haven't received. ${replierName} replied to ${pronoun}.`;
}

export function gapStatus(state: ZrdtGapState): string | undefined {
  switch (state) {
    case 'waiting':
      return undefined;
    case 'requested':
      return 'Requested';
    case 'still-missing':
      return 'Still missing';
    case 'content-unavailable':
      return undefined;
    default:
      throw new Error(`gapStatus: unknown state ${String(state)}`);
  }
}

export function contentUnavailableText(authorName: string): string {
  return `A message from ${authorName} (content unavailable)`;
}

export const ASK_AGAIN = 'Ask again';
export const ASK_FOR_IT = 'Ask for it';

// ---------------------------------------------------------------------------
// Provenance labels (PLAN.md §3.5, AMENDMENTS A8)

/** CLASSIFY's status for one record. */
export type ZrdtClassifyStatus =
  | Readonly<{ kind: 'confirmedByAuthor' }>
  | Readonly<{ kind: 'notConfirmedByAuthor' }>
  | Readonly<{ kind: 'heldBy'; aci: string }>
  | Readonly<{ kind: 'unconfirmed' }>;

/** Host provenance for one record (zrdt_provenance). */
export type ZrdtProvenance =
  | Readonly<{ kind: 'live' }>
  | Readonly<{ kind: 'relayed'; byAci: string }>
  | Readonly<{ kind: 'imported' }>;

/** What the label shows; names are already resolved to display strings. */
export type ZrdtLabel =
  | Readonly<{ kind: 'relayed'; name: string }>
  | Readonly<{ kind: 'confirmed'; name: string }>
  | Readonly<{ kind: 'held'; name: string }>
  | Readonly<{ kind: 'unconfirmed' }>
  | Readonly<{ kind: 'not-confirmed'; name: string }>;

export type ChooseLabelInput = Readonly<{
  status: ZrdtClassifyStatus;
  provenance: ZrdtProvenance;
  authorAci: string;
  /**
   * True when this record first arrived relayed or imported, even if its
   * provenance has since been upgraded to live. Then "confirmed by <author>"
   * is shown instead of no label. Host side: the message attribute
   * `zrdtStatus.wasRelayed` (ts/types/Zrdt.std.ts), kept by the receive
   * path across upgrades.
   */
  arrivedIndirectly: boolean;
  nameOf: (aci: string) => string;
}>;

/**
 * Picks the one label for a message. Order: confirmedByAuthor,
 * notConfirmedByAuthor, relayed, heldBy, unconfirmed. Returns null for a
 * normal live message confirmed by its author (shown like stock Signal).
 */
export function chooseProvenanceLabel(
  input: ChooseLabelInput
): ZrdtLabel | null {
  const { status, provenance, authorAci, arrivedIndirectly, nameOf } = input;
  if (status.kind === 'confirmedByAuthor') {
    return arrivedIndirectly
      ? { kind: 'confirmed', name: nameOf(authorAci) }
      : null;
  }
  if (status.kind === 'notConfirmedByAuthor') {
    return { kind: 'not-confirmed', name: nameOf(authorAci) };
  }
  if (provenance.kind === 'relayed') {
    return { kind: 'relayed', name: nameOf(provenance.byAci) };
  }
  if (status.kind === 'heldBy') {
    return { kind: 'held', name: nameOf(status.aci) };
  }
  return { kind: 'unconfirmed' };
}

export function labelText(label: ZrdtLabel): string {
  switch (label.kind) {
    case 'relayed':
      return `relayed by ${label.name}`;
    case 'confirmed':
      return `confirmed by ${label.name}`;
    case 'held':
      return `held by ${label.name}`;
    case 'unconfirmed':
      return 'unconfirmed';
    case 'not-confirmed':
      return `not confirmed by ${label.name}`;
    default:
      throw new Error('labelText: unknown label');
  }
}

export function labelTooltip(label: ZrdtLabel): string {
  switch (label.kind) {
    case 'relayed':
      return `${label.name} sent you a copy of this message. Its author has not confirmed it yet.`;
    case 'confirmed':
      return `This message reached you indirectly; a later message from ${label.name} confirms it.`;
    case 'held':
      return `A later message from ${label.name} builds on this one, so ${label.name} holds it. That says nothing about who wrote it.`;
    case 'unconfirmed':
      return 'No member has confirmed this message yet.';
    case 'not-confirmed':
      return `${label.name}'s own messages do not confirm this message.`;
    default:
      throw new Error('labelTooltip: unknown label');
  }
}

// ---------------------------------------------------------------------------
// Compare

export const COPY_COMPARE_CODE = 'Copy compare code';
export const PASTE_COMPARE_CODE = 'Paste compare code';

export function identicalText(theirName: string): string {
  return `Identical: you and ${theirName} hold the same set of messages.`;
}

export function theyAreBehindText(theirName: string): string {
  return `${theirName} is behind: you already hold every message in ${theirName}'s code.`;
}

export function youAreBehindText(
  theirName: string,
  missing: ReadonlyArray<ZrdtDigestHex>
): string {
  return `${theirName} has ${messagesCount(missing.length)} you don't (${formatTagList(missing)}).`;
}

export function withheldText(
  theirName: string,
  missing: ReadonlyArray<ZrdtDigestHex>
): string {
  return `${youAreBehindText(theirName, missing)} Asked; no answer.`;
}

export function invalidCodeText(
  error: 'not-a-compare-code' | 'bad-digest' | 'other-chat'
): string {
  switch (error) {
    case 'not-a-compare-code':
      return 'That is not a compare code.';
    case 'bad-digest':
      return 'That compare code is damaged. Copy it again.';
    case 'other-chat':
      return 'That compare code is for a different chat.';
    default:
      throw new Error('invalidCodeText: unknown error');
  }
}

// ---------------------------------------------------------------------------
// Banners

/** OPEN / SALVAGE / MERGE failure reasons (PLAN.md §3.3). */
export type ZrdtRejectReason =
  | Readonly<{ kind: 'unverifiable'; missing: ReadonlyArray<ZrdtDigestHex> }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'too-large' }>
  | Readonly<{ kind: 'wrong-chat' }>
  | Readonly<{ kind: 'collision'; digest: ZrdtDigestHex }>;

const DOES_NOT_VERIFY = 'This copy of the chat does not verify';

export function rejectedText(reason: ZrdtRejectReason): string {
  switch (reason.kind) {
    case 'unverifiable': {
      const n = reason.missing.length;
      if (n === 0) {
        return `${DOES_NOT_VERIFY}: some messages link to each other in a loop`;
      }
      const noun = n === 1 ? 'message' : 'messages';
      const verb = n === 1 ? 'is' : 'are';
      return `${DOES_NOT_VERIFY}: ${noun} ${formatTagList(reason.missing)} ${verb} missing`;
    }
    case 'malformed':
      return `${DOES_NOT_VERIFY}: it is damaged and cannot be read`;
    case 'too-large':
      return `${DOES_NOT_VERIFY}: it is larger than zrdt allows`;
    case 'wrong-chat':
      return `${DOES_NOT_VERIFY}: it belongs to a different chat`;
    case 'collision':
      return `${DOES_NOT_VERIFY}: two different messages share the code ${formatTag(reason.digest)}`;
    default:
      throw new Error('rejectedText: unknown reason');
  }
}

export const KEEP_WHAT_VERIFIES = 'Keep what verifies';
export const IMPORT_A_COPY = 'Import a copy';

export function salvageReportText(
  kept: number,
  dropped: ReadonlyArray<ZrdtDigestHex>
): string {
  const keptText = `Kept ${messagesCount(kept)} that verify.`;
  if (dropped.length === 0) {
    return `${keptText} Nothing was dropped.`;
  }
  return `${keptText} Dropped ${messagesCount(dropped.length)}: ${formatTagList(dropped, 8)}.`;
}

export const UNAVAILABLE_TEXT =
  'zrdt unavailable: new messages are not being checked.';

export const OWN_NAME_ALARM_TEXT =
  'Someone linked a message in your name that you did not send.';

export function unconfirmedSectionTitle(count: number): string {
  return `${messagesCount(count)} not yet confirmed by any member`;
}

export type ZrdtBackendKind = 'lean' | 'stub';

export function backendBadgeText(
  kind: ZrdtBackendKind,
  version: string,
  available: boolean
): string {
  const base = `zrdt: ${kind} ${version}`;
  return available ? base : `${base} (unavailable)`;
}

export function backendBadgeTooltip(kind: ZrdtBackendKind): string {
  return kind === 'lean'
    ? 'Checks run in zrdtd, built from the verified Lean code.'
    : 'Checks run in the TypeScript stub, not the verified Lean code.';
}
