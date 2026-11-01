// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The zrdt receive path (APP.md §5): accept every in-scope group DataMessage
// as a record, place gap rows for what its links reveal, drain the pending
// buffer, and re-enter relayed messages into Desktop.
//
// The host never hashes and never decides acceptance: zrdtService (the Lean
// daemon, or the stub) does. This module routes bytes and keeps the timeline
// in step. Nothing here may break Signal's own receive path: every entry point
// catches and logs, and a message is then processed as if zrdt were absent.

import lodash from 'lodash';

import * as Bytes from '../Bytes.std.ts';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import { MessageModel } from '../models/messages.preload.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { handleDataMessage } from '../messages/handleDataMessage.preload.ts';
import { saveAndNotify } from '../messages/saveAndNotify.preload.ts';
import { processDataMessage } from '../textsecure/processDataMessage.preload.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { generateMessageId } from '../util/generateMessageId.node.ts';
import { incrementMessageCounter } from '../util/incrementMessageCounter.preload.ts';
import { cleanupMessages } from '../util/cleanup.preload.ts';
import { drop } from '../util/drop.std.ts';
import { isNotNil } from '../util/isNotNil.std.ts';
import { uuidToBytes } from '../util/uuidToBytes.std.ts';
import { fromAciUuidBytes } from '../util/ServiceId.node.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { makeZrdtGapMessageAttributes } from '../types/Zrdt.std.ts';
import type {
  ZrdtGapStateType,
  ZrdtStatusAttributesType,
} from '../types/Zrdt.std.ts';
import { isZrdtRecordMessage } from './scope.std.ts';
import type { ZrdtReceiveInfo } from './receiveInfo.std.ts';
import { decideRelayAction, relayProvenance } from './resendLogic.std.ts';
import { zrdtEvents, zrdtService } from './service.preload.ts';
import type { ZrdtAcceptOutcome, ZrdtProvenance } from './service.preload.ts';
import { requestAuthorCopy, zrdtResendScheduler } from './resend.preload.ts';

const { isEqual } = lodash;

const log = createLogger('zrdt/receive');

const NONCE_BYTES = 32;

// Bytes as the service contract passes them (any backing buffer).
// oxlint-disable-next-line typescript/no-unnecessary-type-arguments
export type ZrdtBytes = Uint8Array<ArrayBufferLike>;

// The UI listens for this (conversationId, hexDigest): "Someone linked a
// message in your name that you did not send."
export const ZRDT_OWN_NAME_ALARM_EVENT = 'ownNameAlarm';

// --- small helpers ----------------------------------------------------------------

export function toHex(bytes: ZrdtBytes): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function own(bytes: ZrdtBytes): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function aciFromBytes(bytes: ZrdtBytes): AciString | undefined {
  try {
    return fromAciUuidBytes(own(bytes));
  } catch {
    return undefined;
  }
}

function getOurAci(): AciString {
  return itemStorage.user.getCheckedAci();
}

// Forward-compatible read of fields a later service may add to an outcome
// (the record's own digest and bytes on MISSING; see TODO below).
function optionalBytes(value: object, key: string): ZrdtBytes | undefined {
  const field = (value as Record<string, unknown>)[key];
  return field instanceof Uint8Array ? field : undefined;
}

function getGroupConversation(
  groupId: ZrdtBytes
): ConversationModel | undefined {
  return window.ConversationController.get(Bytes.toBase64(own(groupId)));
}

// --- pending buffer ---------------------------------------------------------------

// TODO(zrdt T0): the service's MISSING outcome carries only the missing links.
// With the record's own digest and bytes (`digest`, `record`) the pending row
// can be persisted as STORE designed it (zrdt_pending) and a pending record can
// be excluded from later gaps. Until then pending entries live in memory, so a
// restart loses them; the links then show as gaps and are fetched again.
type PendingInput =
  | Readonly<{
      kind: 'incoming';
      groupId: ZrdtBytes;
      authorAci: ZrdtBytes;
      nonce: ZrdtBytes;
      dataMessageBytes: ZrdtBytes;
      links: Array<ZrdtBytes>;
      disown: Array<ZrdtBytes>;
    }>
  | Readonly<{
      kind: 'record';
      record: ZrdtBytes;
      opening?: ZrdtBytes;
      responderAci: AciString;
    }>;

type PendingEntry = {
  key: string;
  conversationId: string;
  input: PendingInput;
  provenance: ZrdtProvenance;
  messageId?: string;
  dbDigest?: Uint8Array<ArrayBuffer>;
};

const pendingByConversation = new Map<string, Map<string, PendingEntry>>();
const drainChains = new Map<string, Promise<void>>();

function getPending(conversationId: string): Map<string, PendingEntry> {
  let map = pendingByConversation.get(conversationId);
  if (!map) {
    map = new Map();
    pendingByConversation.set(conversationId, map);
  }
  return map;
}

// Returns the key the entry is stored under.
async function addPending(
  entry: PendingEntry,
  outcome: ZrdtAcceptOutcome
): Promise<string> {
  const digest = optionalBytes(outcome, 'digest');
  const record = optionalBytes(outcome, 'record');
  const keyed = { ...entry, key: digest ? toHex(digest) : entry.key };
  getPending(entry.conversationId).set(keyed.key, keyed);
  if (digest && record) {
    keyed.dbDigest = own(digest);
    await DataWriter.insertZrdtPending({
      conversationId: entry.conversationId,
      digest: own(digest),
      record: own(record),
      messageId: entry.messageId ?? null,
    });
  }
  return keyed.key;
}

// Retry every pending record until no more go in (APP.md §5 step 2).
export function drainPending(conversationId: string): Promise<void> {
  const previous = drainChains.get(conversationId);
  const next = (async () => {
    await previous;
    await doDrain(conversationId);
  })();
  drainChains.set(
    conversationId,
    (async () => {
      try {
        await next;
      } catch (error) {
        log.error('drainPending failed', Errors.toLogFormat(error));
      }
    })()
  );
  return next;
}

async function doDrain(conversationId: string): Promise<void> {
  const pending = getPending(conversationId);
  let progress = true;
  while (progress && pending.size > 0) {
    progress = false;
    for (const entry of [...pending.values()]) {
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await retryPending(entry);
      if (outcome.status === 'missing') {
        continue;
      }
      pending.delete(entry.key);
      if (entry.dbDigest) {
        // oxlint-disable-next-line no-await-in-loop
        await DataWriter.deleteZrdtPending(conversationId, [entry.dbDigest]);
      }
      if (outcome.status !== 'accepted') {
        log.warn(`drain: pending record refused: ${outcome.status}`);
        continue;
      }
      progress = true;
      // oxlint-disable-next-line no-await-in-loop
      await onPendingAccepted(entry, outcome);
    }
  }
}

function retryPending(entry: PendingEntry): Promise<ZrdtAcceptOutcome> {
  const { input, conversationId, provenance } = entry;
  if (input.kind === 'incoming') {
    return zrdtService.acceptIncoming(conversationId, {
      groupId: input.groupId,
      authorAci: input.authorAci,
      nonce: input.nonce,
      dataMessageBytes: input.dataMessageBytes,
      links: input.links,
      provenance,
    });
  }
  return zrdtService.acceptRecord(conversationId, {
    record: input.record,
    opening: input.opening,
    provenance,
  });
}

async function onPendingAccepted(
  entry: PendingEntry,
  outcome: Extract<ZrdtAcceptOutcome, { status: 'accepted' }>
): Promise<void> {
  const { conversationId, input } = entry;
  const digest = toHex(outcome.digest);
  log.info(`drain: accepted ${digest.slice(0, 8)}`);
  if (input.kind === 'record') {
    await onRelayAccepted({
      conversationId,
      outcome,
      responderAci: input.responderAci,
      opening: input.opening,
    });
    return;
  }
  zrdtResendScheduler.resolved(conversationId, digest);
  const authorAci = aciFromBytes(input.authorAci);
  if (authorAci) {
    await recordDisown(conversationId, authorAci, input.disown);
  }
  if (entry.messageId) {
    const message = await getMessageById(entry.messageId);
    if (message) {
      message.set({
        zrdtDigest: digest,
        zrdtOpening: outcome.opening
          ? Bytes.toBase64(own(outcome.opening))
          : message.get('zrdtOpening'),
        zrdtProvenance: { kind: 'live' },
      });
      await window.MessageCache.saveMessage(message.attributes);
    }
  }
  // Another message's gap may have been waiting for this one.
  for (const gap of await findGapsFor(conversationId, digest)) {
    // oxlint-disable-next-line no-await-in-loop
    await resolveGapRow(gap, digest, { kind: 'content' });
  }
  scheduleStatusRefresh(conversationId);
}

// --- the live step (MessageReceiver) ----------------------------------------------

export type ZrdtLiveStepResult = Readonly<{
  info: ZrdtReceiveInfo;
  receivedAtCounter: number;
  receivedAtDate: number;
}>;

// APP.md §5 steps 1-5. Called by MessageReceiver for a decrypted group
// DataMessage (and for SyncMessage.sent, with isSync), after the group data
// check and before the local-policy drops. `dataMessageBytes` are the bytes
// as sent (ts/zrdt/wire.std.ts). Returns undefined if the message is not a
// record for us; MessageReceiver then goes on as stock Desktop.
export async function zrdtReceiveLive({
  logId,
  groupId,
  senderAci,
  isSync,
  dataMessage,
  dataMessageBytes,
  receivedAtCounter,
  receivedAtDate,
}: Readonly<{
  logId: string;
  groupId: ZrdtBytes | undefined;
  senderAci: AciString;
  isSync: boolean;
  dataMessage: Proto.DataMessage;
  dataMessageBytes: ZrdtBytes | undefined;
  receivedAtCounter: number;
  receivedAtDate: number;
}>): Promise<ZrdtLiveStepResult | undefined> {
  const meta = dataMessage.zrdt;
  if (meta == null || groupId == null || !isZrdtRecordMessage(dataMessage)) {
    return undefined;
  }
  try {
    if (!dataMessageBytes) {
      log.warn(`${logId}: zrdt present but no DataMessage bytes; skipped`);
      return undefined;
    }
    if (meta.nonce == null || meta.nonce.byteLength !== NONCE_BYTES) {
      log.warn(`${logId}: zrdt without a 32-byte nonce; skipped`);
      return undefined;
    }
    const conversation = getGroupConversation(groupId);
    if (!conversation || !conversation.areWeAGroupMember()) {
      return undefined;
    }
    const ourAci = getOurAci();
    // Sync transcripts are ours (APP.md §5: live = this account sent it).
    const authorAci = isSync ? ourAci : senderAci;
    if (!conversation.hasMember(authorAci)) {
      log.warn(`${logId}: zrdt record from a non-member; skipped`);
      return undefined;
    }
    const conversationId = conversation.id;
    await zrdtService.ensureConversation(conversationId, groupId);

    const input: PendingInput = {
      kind: 'incoming',
      groupId,
      authorAci: uuidToBytes(authorAci),
      nonce: meta.nonce,
      dataMessageBytes,
      links: meta.links,
      disown: meta.disown,
    };
    const outcome = await zrdtService.acceptIncoming(conversationId, {
      groupId: input.groupId,
      authorAci: input.authorAci,
      nonce: input.nonce,
      dataMessageBytes: input.dataMessageBytes,
      links: input.links,
      provenance: { kind: 'live' },
    });

    if (outcome.status === 'accepted') {
      const digest = toHex(outcome.digest);
      log.info(`${logId}: zrdt accepted ${digest.slice(0, 8)}`);
      zrdtResendScheduler.resolved(conversationId, digest);
      await recordDisown(conversationId, authorAci, meta.disown);
      // A gap row waiting for this digest: the message takes its place.
      const gaps = await findGapsFor(conversationId, digest);
      const first = gaps[0];
      drop(drainPending(conversationId));
      return {
        info: {
          conversationId,
          digest,
          opening: outcome.opening
            ? Bytes.toBase64(own(outcome.opening))
            : undefined,
          resolvesGapIds: gaps.map(gap => gap.id),
        },
        receivedAtCounter: first?.get('received_at') ?? receivedAtCounter,
        receivedAtDate: first?.get('received_at_ms') ?? receivedAtDate,
      };
    }

    if (outcome.status === 'missing') {
      const missing = outcome.digests.map(toHex);
      log.info(
        `${logId}: zrdt missing ${missing.map(d => d.slice(0, 8)).join(',')}`
      );
      const key = await addPending(
        {
          key: `nonce:${toHex(meta.nonce)}`,
          conversationId,
          input,
          provenance: { kind: 'live' },
        },
        outcome
      );
      // Ask the member whose message referenced them, after the delay; a
      // sync transcript of ours goes to the group.
      zrdtResendScheduler.schedule(
        conversationId,
        missing,
        isSync ? undefined : senderAci
      );
      return {
        info: {
          conversationId,
          missing,
          gapReceivedAt: receivedAtCounter,
          gapReceivedAtMs: receivedAtDate,
          pendingKey: key,
        },
        // Restamp: the gap row takes the old counter, so the message sorts
        // below it and recovered messages land in between.
        receivedAtCounter: incrementMessageCounter(),
        receivedAtDate,
      };
    }

    // COLLISION, WRONG_CHAT, TOO_LARGE, MALFORMED: drop the record and log.
    // TODO(zrdt): COLLISION should show the message with its digest instead
    // of as a normal message (APP.md §5 step 4); it never fires with SHA-256.
    log.warn(`${logId}: zrdt record refused: ${outcome.status}`);
    return undefined;
  } catch (error) {
    log.error(`${logId}: zrdt step failed`, Errors.toLogFormat(error));
    return undefined;
  }
}

// A live message's ZrdtMeta.disown: digests of records in the author's name
// it did not create. Only the author's own records count (the SQL layer
// leaves that check to the caller).
async function recordDisown(
  conversationId: string,
  authorAci: AciString,
  disown: ReadonlyArray<ZrdtBytes>
): Promise<void> {
  if (disown.length === 0) {
    return;
  }
  const authorBytes = uuidToBytes(authorAci);
  for (const digest of disown) {
    // oxlint-disable-next-line no-await-in-loop
    const held = await zrdtService.get(conversationId, digest);
    if (held && Bytes.areEqual(own(held.authorAci), authorBytes)) {
      // oxlint-disable-next-line no-await-in-loop
      await zrdtService.markDisowned(conversationId, digest, authorAci);
    }
  }
}

// --- handleDataMessage hooks -------------------------------------------------------

// Before the message is saved: copy the zrdt attributes, place the gap row,
// resolve the gaps it answers. Skipped for relayed messages (they carry their
// attributes already).
export async function zrdtApplyBeforeSave(
  message: MessageModel,
  conversation: ConversationModel,
  info: ZrdtReceiveInfo | undefined
): Promise<void> {
  if (!info) {
    return;
  }
  try {
    message.set({
      zrdtDigest: info.digest,
      zrdtOpening: info.opening,
      zrdtProvenance: { kind: 'live' },
    });
    if (info.missing && info.missing.length > 0) {
      const entry = info.pendingKey
        ? getPending(info.conversationId).get(info.pendingKey)
        : undefined;
      if (entry) {
        entry.messageId = message.id;
      }
      if (info.gapReceivedAt != null) {
        await createGapRow(conversation, message, info);
      }
    }
    if (info.digest) {
      for (const id of info.resolvesGapIds ?? []) {
        // oxlint-disable-next-line no-await-in-loop
        const gap = await getMessageById(id);
        if (gap) {
          // oxlint-disable-next-line no-await-in-loop
          await resolveGapRow(gap, info.digest, { kind: 'content' });
        }
      }
    }
    scheduleStatusRefresh(info.conversationId);
  } catch (error) {
    log.error('zrdtApplyBeforeSave failed', Errors.toLogFormat(error));
  }
}

// handleDataMessage found a message with the same (sent_at, author).
// - same digest: the author's live copy of a relayed or pending message.
//   Upgrade it (APP.md §5 step 10) and drop the copy;
// - different digests: never drop silently. 'keep' saves it as its own
//   message (TODO(zrdt): fork marker, cut from the demo).
export async function zrdtOnDuplicate(
  existing: MessageModel,
  info: ZrdtReceiveInfo | undefined
): Promise<'drop' | 'keep'> {
  if (!info?.digest) {
    return 'drop';
  }
  try {
    const existingDigest = existing.get('zrdtDigest');
    if (existingDigest != null && existingDigest !== info.digest) {
      log.warn(
        `duplicate (sent_at, author) with a different digest: ${existingDigest.slice(0, 8)} vs ${info.digest.slice(0, 8)}; keeping both`
      );
      return 'keep';
    }
    const wasRelayed = existing.get('zrdtProvenance')?.kind === 'relayed';
    const status = existing.get('zrdtStatus');
    existing.set({
      zrdtDigest: info.digest,
      zrdtOpening: existing.get('zrdtOpening') ?? info.opening,
      zrdtProvenance: { kind: 'live' },
      zrdtStatus: wasRelayed
        ? { ...(status ?? { kind: 'unconfirmed' }), wasRelayed: true }
        : status,
    });
    await window.MessageCache.saveMessage(existing.attributes);
    log.info(`live copy upgrades ${info.digest.slice(0, 8)}`);
    scheduleStatusRefresh(info.conversationId);
  } catch (error) {
    log.error('zrdtOnDuplicate failed', Errors.toLogFormat(error));
  }
  return 'drop';
}

// --- gap rows -------------------------------------------------------------------------

async function loadGapRows(
  conversationId: string
): Promise<Array<MessageModel>> {
  const ids = await DataReader.getZrdtGapMessageIds(conversationId);
  const rows = await Promise.all(ids.map(id => getMessageById(id)));
  return rows.filter(isNotNil);
}

export async function findGapsFor(
  conversationId: string,
  digest: string
): Promise<Array<MessageModel>> {
  const rows = await loadGapRows(conversationId);
  return rows.filter(row =>
    row.get('zrdtGap')?.missingDigests.includes(digest)
  );
}

async function createGapRow(
  conversation: ConversationModel,
  message: MessageModel,
  info: ZrdtReceiveInfo
): Promise<void> {
  strictNumber(info.gapReceivedAt);
  const attributes = makeZrdtGapMessageAttributes({
    id: generateMessageId(info.gapReceivedAt).id,
    conversationId: conversation.id,
    referencing: {
      id: message.id,
      received_at: info.gapReceivedAt,
      received_at_ms: info.gapReceivedAtMs,
      sent_at: message.get('sent_at'),
      sourceServiceId: message.get('sourceServiceId'),
    },
    missingDigests: info.missing ?? [],
  });
  const gap = new MessageModel(attributes);
  await window.MessageCache.saveMessage(gap, { forceSave: true });
  window.MessageCache.register(gap);
  drop(conversation.onNewMessage(gap));
  log.info(`gap row ${gap.id} for ${info.missing?.length ?? 0} digest(s)`);
}

function strictNumber(value: number | undefined): asserts value is number {
  if (typeof value !== 'number') {
    throw new Error('expected a number');
  }
}

// Used by the resend scheduler: 'requested' / 'still-missing'. A gap row
// whose content is unavailable keeps that state.
export async function setGapState(
  conversationId: string,
  digests: ReadonlyArray<string>,
  state: ZrdtGapStateType
): Promise<void> {
  const wanted = new Set(digests);
  for (const row of await loadGapRows(conversationId)) {
    const gap = row.get('zrdtGap');
    if (
      !gap ||
      gap.state === 'content-unavailable' ||
      !gap.missingDigests.some(digest => wanted.has(digest))
    ) {
      continue;
    }
    row.set({
      zrdtGap: {
        ...gap,
        state,
        lastRequestedAt:
          state === 'requested' ? Date.now() : gap.lastRequestedAt,
      },
    });
    // oxlint-disable-next-line no-await-in-loop
    await window.MessageCache.saveMessage(row.attributes);
  }
}

type GapResolution =
  | Readonly<{ kind: 'content' }>
  | Readonly<{ kind: 'unavailable'; authorAci: AciString }>;

async function resolveGapRow(
  row: MessageModel,
  digest: string,
  how: GapResolution
): Promise<void> {
  const gap = row.get('zrdtGap');
  if (!gap) {
    return;
  }
  const remaining = gap.missingDigests.filter(d => d !== digest);
  if (remaining.length === 0 && how.kind === 'content') {
    log.info(`gap row ${row.id} resolved`);
    await DataWriter.removeMessageById(row.id, { cleanupMessages });
    return;
  }
  if (remaining.length === 0 && how.kind === 'unavailable') {
    row.set({
      zrdtGap: {
        ...gap,
        missingDigests: [digest],
        state: 'content-unavailable',
        contentUnavailableAuthorAci: how.authorAci,
      },
    });
  } else {
    // TODO(zrdt): a multi-digest gap where one digest resolves structure-only
    // loses the "content unavailable" note for it.
    row.set({ zrdtGap: { ...gap, missingDigests: remaining } });
  }
  await window.MessageCache.saveMessage(row.attributes);
}

// --- relays (ZrdtResend) --------------------------------------------------------------

// APP.md §5 step 7. Called by resend.preload.ts for a ZrdtResend from a
// current member. ACCEPT_RECORD checks the opening against the record's
// commit; a bad opening falls back to structure only.
export async function acceptRelayedRecord({
  groupId,
  responderAci,
  record,
  opening,
}: Readonly<{
  groupId: ZrdtBytes;
  responderAci: AciString;
  record: ZrdtBytes;
  opening: ZrdtBytes | undefined;
}>): Promise<void> {
  const conversation = getGroupConversation(groupId);
  if (
    !conversation ||
    !conversation.areWeAGroupMember() ||
    !conversation.hasMember(responderAci)
  ) {
    log.warn('relay: not a group we share with the responder; ignored');
    return;
  }
  const conversationId = conversation.id;
  await zrdtService.ensureConversation(conversationId, groupId);
  const provenance: ZrdtProvenance = { kind: 'relayed', byAci: responderAci };
  let usedOpening = opening;
  let outcome = await zrdtService.acceptRecord(conversationId, {
    record,
    opening,
    provenance,
  });
  if (outcome.status === 'badOpening') {
    log.warn('relay: opening does not match the record; structure only');
    usedOpening = undefined;
    outcome = await zrdtService.acceptRecord(conversationId, {
      record,
      provenance,
    });
  }
  if (outcome.status === 'missing') {
    const missing = outcome.digests.map(toHex);
    log.info(
      `relay: record links ${missing.length} more missing digest(s); pending`
    );
    await addPending(
      {
        key: `relay:${toHex(record)}`,
        conversationId,
        input: { kind: 'record', record, opening: usedOpening, responderAci },
        provenance,
      },
      outcome
    );
    await zrdtResendScheduler.ask(conversationId, missing, responderAci);
    return;
  }
  if (outcome.status !== 'accepted') {
    log.warn(`relay: record refused: ${outcome.status}`);
    return;
  }
  await onRelayAccepted({
    conversationId,
    outcome,
    responderAci,
    opening: usedOpening,
  });
  drop(drainPending(conversationId));
}

async function onRelayAccepted({
  conversationId,
  outcome,
  responderAci,
  opening,
}: Readonly<{
  conversationId: string;
  outcome: Extract<ZrdtAcceptOutcome, { status: 'accepted' }>;
  responderAci: AciString;
  opening: ZrdtBytes | undefined;
}>): Promise<void> {
  const conversation = window.ConversationController.get(conversationId);
  if (!conversation) {
    return;
  }
  const digest = toHex(outcome.digest);
  const held = await zrdtService.get(conversationId, outcome.digest);
  const authorAci = held ? aciFromBytes(held.authorAci) : undefined;
  if (!authorAci) {
    log.warn(`relay: accepted ${digest.slice(0, 8)} but cannot read author`);
    return;
  }
  const provenance = relayProvenance(responderAci, authorAci);
  if (provenance.kind === 'live') {
    // The author relayed its own record: upgrade (idempotent accept).
    await zrdtService.acceptRecord(conversationId, {
      record: outcome.record,
      provenance,
    });
    await upgradeShownMessage(conversationId, digest);
  }

  const ourAci = getOurAci();
  const gaps = await findGapsFor(conversationId, digest);
  const ownLive =
    authorAci === ourAci ? await isLive(conversationId, outcome.digest) : true;
  const action = decideRelayAction({
    authorAci,
    ourAci,
    hasOpening: opening != null,
    wasRequested:
      zrdtResendScheduler.isOutstanding(conversationId, digest) ||
      gaps.length > 0,
    ownLive,
  });
  zrdtResendScheduler.resolved(conversationId, digest);
  log.info(`relay: ${digest.slice(0, 8)} by ${responderAci}: ${action}`);

  if (action === 'ownNameAlarm') {
    await raiseOwnNameAlarm(conversationId, outcome.digest);
  } else if (action === 'show' && opening) {
    const gap = gaps[0];
    const shown = await showRelayedMessage({
      conversation,
      digest,
      opening,
      authorAci,
      provenance,
      receivedAt: gap?.get('received_at'),
      receivedAtMs: gap?.get('received_at_ms'),
    });
    for (const row of gaps) {
      // oxlint-disable-next-line no-await-in-loop
      await resolveGapRow(
        row,
        digest,
        shown ? { kind: 'content' } : { kind: 'unavailable', authorAci }
      );
    }
  } else if (action === 'structureOnly' || action === 'show') {
    for (const row of gaps) {
      // oxlint-disable-next-line no-await-in-loop
      await resolveGapRow(row, digest, { kind: 'unavailable', authorAci });
    }
  }

  // Author fast path (step 9): ask the author for its live copy.
  if (
    (action === 'show' || action === 'structureOnly') &&
    provenance.kind === 'relayed'
  ) {
    drop(requestAuthorCopy(conversationId, digest, authorAci));
  }
  scheduleStatusRefresh(conversationId);
}

async function isLive(
  conversationId: string,
  digest: ZrdtBytes
): Promise<boolean> {
  const rows = await DataReader.getZrdtProvenance(conversationId);
  const row = rows.find(r => Bytes.areEqual(r.digest, own(digest)));
  return row?.kind === 'live';
}

async function upgradeShownMessage(
  conversationId: string,
  digest: string
): Promise<void> {
  const rows = await DataReader.getMessageIdsByZrdtDigest(conversationId, [
    digest,
  ]);
  for (const { messageId } of rows) {
    // oxlint-disable-next-line no-await-in-loop
    const message = await getMessageById(messageId);
    if (message && message.get('zrdtProvenance')?.kind !== 'live') {
      const status = message.get('zrdtStatus');
      message.set({
        zrdtProvenance: { kind: 'live' },
        zrdtStatus: {
          ...(status ?? { kind: 'unconfirmed' }),
          wasRelayed: true,
        },
      });
      // oxlint-disable-next-line no-await-in-loop
      await window.MessageCache.saveMessage(message.attributes);
    }
  }
}

// Step 12: never refuse a record in our name; alarm and disown it. The send
// path puts the whole disown set (zrdtService.disownSet) on every message.
export async function raiseOwnNameAlarm(
  conversationId: string,
  digest: ZrdtBytes
): Promise<void> {
  const hex = toHex(digest);
  log.warn(`own-name alarm: ${hex.slice(0, 8)} is in our name, not ours`);
  await zrdtService.markDisowned(conversationId, digest, getOurAci());
  zrdtEvents.emit(ZRDT_OWN_NAME_ALARM_EVENT, conversationId, hex);
  scheduleStatusRefresh(conversationId);
}

// Re-enter Desktop at handleDataMessage with the opened DataMessage and the
// conversation's own group context. Side-effect fields are removed here, and
// the flag makes handleDataMessage skip group updates, profile keys and the
// zrdt step (step 8). Returns false if the opening is not a showable message.
async function showRelayedMessage({
  conversation,
  digest,
  opening,
  authorAci,
  provenance,
  receivedAt,
  receivedAtMs,
}: Readonly<{
  conversation: ConversationModel;
  digest: string;
  opening: ZrdtBytes;
  authorAci: AciString;
  provenance: ZrdtProvenance;
  receivedAt: number | undefined;
  receivedAtMs: number | undefined;
}>): Promise<boolean> {
  try {
    const masterKey = conversation.get('masterKey');
    if (!masterKey || opening.byteLength <= NONCE_BYTES) {
      return false;
    }
    const decoded = Proto.DataMessage.decode(
      own(opening.subarray(NONCE_BYTES))
    );
    const timestamp = Number(decoded.timestamp ?? 0);
    if (!timestamp) {
      return false;
    }
    const safe: Proto.DataMessage = {
      ...decoded,
      groupV2: {
        $unknown: [],
        masterKey: Bytes.fromBase64(masterKey),
        revision: null,
        groupChange: null,
      },
      profileKey: null,
      flags: 0,
      expireTimerVersion: null,
      zrdt: null,
    };
    if (!isZrdtRecordMessage(safe)) {
      log.warn(`relay: ${digest.slice(0, 8)} is not a plain group message`);
      return false;
    }
    const processed = processDataMessage(safe, timestamp);
    const counter = receivedAt ?? incrementMessageCounter();
    const now = Date.now();
    const message = new MessageModel({
      ...generateMessageId(counter),
      conversationId: conversation.id,
      readStatus: ReadStatus.Unread,
      seenStatus: SeenStatus.Unseen,
      received_at_ms: receivedAtMs ?? now,
      sent_at: timestamp,
      timestamp,
      sourceServiceId: authorAci,
      type: 'incoming',
      zrdtDigest: digest,
      zrdtOpening: Bytes.toBase64(own(opening)),
      zrdtProvenance:
        provenance.kind === 'relayed'
          ? { kind: 'relayed', byAci: provenance.byAci as AciString }
          : { kind: provenance.kind },
    });
    await handleDataMessage(
      message,
      processed,
      () => undefined,
      { zrdtRelayed: true },
      { saveAndNotify }
    );
    return true;
  } catch (error) {
    log.error(
      `relay: could not show ${digest.slice(0, 8)}`,
      Errors.toLogFormat(error)
    );
    return false;
  }
}

// --- statuses (CLASSIFY) -------------------------------------------------------------

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const STATUS_REFRESH_DELAY_MS = 500;

// Debounced: the message being received is saved by a batcher, so wait a
// little before reading message rows by digest.
export function scheduleStatusRefresh(conversationId: string): void {
  const existing = refreshTimers.get(conversationId);
  if (existing) {
    clearTimeout(existing);
  }
  refreshTimers.set(
    conversationId,
    setTimeout(() => {
      refreshTimers.delete(conversationId);
      drop(refreshStatuses(conversationId));
    }, STATUS_REFRESH_DELAY_MS)
  );
}

// Stores the CLASSIFY result on every message with a digest (the UI renders
// stored values, APP.md §7).
export async function refreshStatuses(conversationId: string): Promise<void> {
  try {
    const statuses = await zrdtService.classify(conversationId);
    const rows = await DataReader.getMessageIdsByZrdtDigest(conversationId, [
      ...statuses.keys(),
    ]);
    for (const { digest, messageId } of rows) {
      const status = statuses.get(digest);
      // oxlint-disable-next-line no-await-in-loop
      const message = status ? await getMessageById(messageId) : undefined;
      if (!status || !message) {
        continue;
      }
      const previous = message.get('zrdtStatus');
      const wasRelayed =
        previous?.wasRelayed === true ||
        message.get('zrdtProvenance')?.kind === 'relayed';
      const next: ZrdtStatusAttributesType = {
        kind: status.kind,
        ...(status.kind === 'heldBy'
          ? { heldByAci: status.aci as AciString }
          : {}),
        ...(wasRelayed ? { wasRelayed: true } : {}),
      };
      if (!isEqual(previous, next)) {
        message.set({ zrdtStatus: next });
        // oxlint-disable-next-line no-await-in-loop
        await window.MessageCache.saveMessage(message.attributes);
      }
    }
  } catch (error) {
    log.error('refreshStatuses failed', Errors.toLogFormat(error));
  }
}
