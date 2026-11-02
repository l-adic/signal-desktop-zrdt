// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The zrdt receive path (APP.md §5): accept every in-scope group DataMessage
// as a record, place gap rows for what its links reveal, and re-enter relayed
// messages into Desktop. The service persists and drains the pending buffer
// (zrdt_pending) itself; this module reacts to its 'accepted' and 'classify'
// events.
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
import {
  makeZrdtBoundaryMessageAttributes,
  makeZrdtGapMessageAttributes,
  makeZrdtUnavailableMessageAttributes,
} from '../types/Zrdt.std.ts';
import type {
  ZrdtGapStateType,
  ZrdtStatusAttributesType,
} from '../types/Zrdt.std.ts';
import { isZrdtRecordMessage } from './scope.std.ts';
import type { ZrdtReceiveInfo } from './receiveInfo.std.ts';
import {
  decideRelayAction,
  planPlacement,
  relayProvenance,
} from './resendLogic.std.ts';
import { zrdtEvents, zrdtService } from './service.preload.ts';
import type {
  ZrdtProvenance,
  ZrdtViewItem,
  ZrdtViewOutcome,
} from './service.preload.ts';
import type { ServeEntry } from './ZrdtBackend.std.ts';
import {
  askLiveAuthorForCatchUp,
  requestAuthorCopy,
  startCatchUp,
  zrdtResendScheduler,
} from './resend.preload.ts';

const { isEqual } = lodash;

const log = createLogger('zrdt/receive');

const NONCE_BYTES = 32;

// Any backing buffer (the UI may pass plain Uint8Arrays).
// oxlint-disable-next-line typescript/no-unnecessary-type-arguments
export type ZrdtBytes = Uint8Array<ArrayBufferLike>;

// The UI listens for this (conversationId, hexDigest): "Someone linked a
// message in your name that you did not send."
/** @knipignore used by the UI lane (T3) */
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

function getGroupConversation(
  groupId: Uint8Array<ArrayBuffer>
): ConversationModel | undefined {
  return window.ConversationController.get(Bytes.toBase64(own(groupId)));
}

// --- pending -------------------------------------------------------------------------

// Relayed records that came back MISSING: the service keeps the record in
// zrdt_pending and drains it later, but not the opening. Kept in memory
// (TODO(zrdt): a restart loses the opening; the record then resolves
// structure-only and the author fast path can still bring the content).
type PendingRelay = Readonly<{
  opening: Uint8Array<ArrayBuffer> | undefined;
  responderAci: AciString;
  // The SERVE entry was marked author copy.
  authorCopy: boolean;
  // Whether we had asked for it (decided when it arrived).
  wasRequested: boolean;
}>;
const pendingRelays = new Map<string, PendingRelay>();

// Disown lists of live messages whose record is pending: applied when the
// service drains it (TODO(zrdt): in memory only; the author's next message
// carries the full set again anyway).
const pendingDisowns = new Map<
  string,
  { authorAci: AciString; disown: Array<Uint8Array<ArrayBuffer>> }
>();

async function getPendingDigests(conversationId: string): Promise<Set<string>> {
  const rows = await DataReader.getZrdtPending(conversationId);
  return new Set(rows.map(row => toHex(row.digest)));
}

// The service emits 'accepted' for every record it stores, including pending
// records it drains after another accept.
function onAcceptedEvent(conversationId: string, digest: string): void {
  const key = `${conversationId}:${digest}`;
  const disown = pendingDisowns.get(key);
  if (disown) {
    pendingDisowns.delete(key);
    drop(
      safely('recordDisown', () =>
        recordDisown(conversationId, disown.authorAci, disown.disown)
      )
    );
  }
  const relay = pendingRelays.get(key);
  if (relay) {
    pendingRelays.delete(key);
    drop(afterDrainedRelay(conversationId, digest, relay));
    return;
  }
  drop(resolveGapsForShownMessage(conversationId, digest));
}

// A relative store took boundary digests (JOIN_PLAN §6.2): gap rows waiting
// for them are answered (the boundary row stands for them), and nobody is
// asked for them again.
function onBoundaryEvent(
  conversationId: string,
  digests: ReadonlyArray<string>
): void {
  drop(
    safely('resolveGapsForBoundary', () =>
      resolveGapsForBoundary(conversationId, digests)
    )
  );
}

async function resolveGapsForBoundary(
  conversationId: string,
  digests: ReadonlyArray<string>
): Promise<void> {
  const boundary = new Set(digests);
  for (const digest of boundary) {
    zrdtResendScheduler.resolved(conversationId, digest);
  }
  for (const row of await loadGapRows(conversationId)) {
    const gap = row.get('zrdtGap');
    if (!gap || gap.state === 'boundary') {
      continue;
    }
    const remaining = gap.missingDigests.filter(d => !boundary.has(d));
    if (remaining.length === gap.missingDigests.length) {
      continue;
    }
    if (remaining.length === 0) {
      log.info(`gap row ${row.id}: its digests are boundary digests`);
      // oxlint-disable-next-line no-await-in-loop
      await DataWriter.removeMessageById(row.id, { cleanupMessages });
    } else {
      row.set({ zrdtGap: { ...gap, missingDigests: remaining } });
      // oxlint-disable-next-line no-await-in-loop
      await window.MessageCache.saveMessage(row.attributes);
    }
  }
}

let listening = false;
// Called at startup (background.preload.ts) and on first use.
export function initZrdtReceive(): void {
  if (listening) {
    return;
  }
  listening = true;
  zrdtEvents.on('accepted', onAcceptedEvent);
  zrdtEvents.on('classify', scheduleStatusRefresh);
  zrdtEvents.on('boundary', onBoundaryEvent);
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
  groupId: Uint8Array<ArrayBuffer> | undefined;
  senderAci: AciString;
  isSync: boolean;
  dataMessage: Proto.DataMessage;
  dataMessageBytes: Uint8Array<ArrayBuffer> | undefined;
  receivedAtCounter: number;
  receivedAtDate: number;
}>): Promise<ZrdtLiveStepResult | undefined> {
  const meta = dataMessage.zrdt;
  if (
    meta == null ||
    groupId == null ||
    !isZrdtRecordMessage({
      isGroupV2: dataMessage.groupV2 != null,
      isEdit: false,
      dataMessage,
    })
  ) {
    return undefined;
  }
  initZrdtReceive();
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
    if (!(await zrdtService.hasStore(conversationId))) {
      // This device has no store: catch up (JOIN_PLAN §6.1). The catch-up
      // waits for its first reply from the moment it starts, so the store
      // this record opens is relative until that reply decides it
      // (catchUp.std.ts); a record that links history waits in zrdt_pending
      // until the boundary arrives.
      const linksHistory = meta.links.length > 0;
      log.info(
        `${logId}: no store${linksHistory ? ', and the record links history' : ''}: catch-up`
      );
      drop(
        startCatchUp(conversation, {
          reason: linksHistory
            ? 'a live record links history'
            : 'a live record arrived',
        })
      );
      if (linksHistory) {
        await zrdtService.startRelative(conversationId, groupId);
      }
    }
    await zrdtService.ensureConversation(conversationId, groupId);

    const outcome = await zrdtService.acceptIncoming(conversationId, {
      groupId,
      authorAci: uuidToBytes(authorAci),
      nonce: meta.nonce,
      dataMessageBytes,
      links: meta.links,
      provenance: { kind: 'live' },
    });

    if (outcome.status !== 'accepted' && outcome.status !== 'missing') {
      // COLLISION, WRONG_CHAT, TOO_LARGE, MALFORMED, NO_AUDIENCE (no field
      // 201: every record must carry its audience, JOIN_PLAN §3.2): drop the
      // record, log.
      // TODO(zrdt): COLLISION should show the message with its digest
      // (APP.md §5 step 4); it never fires with SHA-256.
      log.warn(`${logId}: zrdt record refused: ${outcome.status}`);
      return undefined;
    }

    if (!isSync) {
      // Its author holds a store: ask it too if our catch-up still waits.
      askLiveAuthorForCatchUp(conversationId, authorAci);
    }

    const digest = outcome.digest ? toHex(outcome.digest) : undefined;
    const opening = outcome.opening
      ? Bytes.toBase64(own(outcome.opening))
      : undefined;
    let missing: Array<string> = [];
    if (outcome.status === 'accepted') {
      log.info(`${logId}: zrdt accepted ${digest?.slice(0, 8)}`);
      if (digest) {
        zrdtResendScheduler.resolved(conversationId, digest);
      }
      await recordDisown(conversationId, authorAci, meta.disown);
    } else {
      // Records waiting in zrdt_pending are held here, just not linked up
      // yet: they are not gaps.
      const pending = await getPendingDigests(conversationId);
      missing = outcome.digests.map(toHex).filter(d => !pending.has(d));
      log.info(
        `${logId}: zrdt pending ${digest?.slice(0, 8)}; missing: ${missing.length}`
      );
      if (digest && meta.disown.length > 0) {
        pendingDisowns.set(`${conversationId}:${digest}`, {
          authorAci,
          disown: meta.disown,
        });
      }
      if (missing.length > 0) {
        // Ask the member whose message referenced them, after the delay; a
        // sync transcript of ours goes to the group.
        zrdtResendScheduler.schedule(
          conversationId,
          missing,
          isSync ? undefined : senderAci
        );
        // One gap row per missing message: digests an open gap row already
        // shows get no second row (two replies to one dropped message).
        const shown = await getDigestsInGapRows(conversationId);
        missing = missing.filter(d => !shown.has(d));
      }
    }

    // A gap row waiting for this digest: the message takes its place (and a
    // new gap for its own missing links goes right above it).
    const gaps = digest ? await findGapsFor(conversationId, digest) : [];
    const placement = planPlacement({
      gaps: gaps.map(gap => ({
        id: gap.id,
        receivedAt: gap.get('received_at'),
        receivedAtMs: gap.get('received_at_ms'),
      })),
      missingCount: missing.length,
      receivedAtCounter,
      receivedAtDate,
      nextCounter: incrementMessageCounter,
    });
    return {
      info: {
        conversationId,
        digest,
        opening,
        missing: missing.length > 0 ? missing : undefined,
        gapReceivedAt: placement.gapReceivedAt,
        gapReceivedAtMs: placement.gapReceivedAtMs,
        resolvesGapIds: placement.resolvesGapIds,
      },
      receivedAtCounter: placement.receivedAtCounter,
      receivedAtDate: placement.receivedAtDate,
    };
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
  disown: ReadonlyArray<Uint8Array<ArrayBuffer>>
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
    if (info.missing && info.missing.length > 0 && info.gapReceivedAt != null) {
      await createGapRow(conversation, message, info);
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

// A pending record (its message already shown) was drained: the gaps that
// were waiting for it are answered.
async function resolveGapsForShownMessage(
  conversationId: string,
  digest: string
): Promise<void> {
  try {
    const gaps = await findGapsFor(conversationId, digest);
    if (gaps.length === 0) {
      return;
    }
    const gapIds = new Set(gaps.map(gap => gap.id));
    const rows = await DataReader.getMessageIdsByZrdtDigest(conversationId, [
      digest,
    ]);
    if (!rows.some(row => !gapIds.has(row.messageId))) {
      return;
    }
    for (const gap of gaps) {
      // oxlint-disable-next-line no-await-in-loop
      await resolveGapRow(gap, digest, { kind: 'content' });
    }
  } catch (error) {
    log.error('resolveGapsForShownMessage failed', Errors.toLogFormat(error));
  }
}

// --- gap rows -------------------------------------------------------------------------

async function loadGapRows(
  conversationId: string
): Promise<Array<MessageModel>> {
  const ids = await DataReader.getZrdtGapMessageIds(conversationId);
  const rows = await Promise.all(ids.map(id => getMessageById(id)));
  return rows.filter(isNotNil);
}

async function getDigestsInGapRows(
  conversationId: string
): Promise<Set<string>> {
  const rows = await loadGapRows(conversationId);
  return new Set(rows.flatMap(row => row.get('zrdtGap')?.missingDigests ?? []));
}

async function findGapsFor(
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
      gap.state === 'boundary' ||
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
  | Readonly<{
      kind: 'unavailable';
      authorAci: AciString;
      // The member whose SERVE reply carried no content.
      fromAci?: AciString;
    }>;

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
        contentUnavailableFromAci: how.fromAci,
      },
    });
  } else {
    // TODO(zrdt): a multi-digest gap where one digest resolves structure-only
    // loses the "content unavailable" note for it.
    row.set({ zrdtGap: { ...gap, missingDigests: remaining } });
  }
  await window.MessageCache.saveMessage(row.attributes);
}

// --- relays (SERVE entries) -----------------------------------------------------------

// APP.md §5 step 7, JOIN_PLAN §4.4. Called by resend.preload.ts for each
// addressed or `after` entry of a sealed SERVE reply that passed the §4.4
// checks. ACCEPT_RECORD checks the opening against the record's commit and
// records its audience; a bad opening, or one without an audience, falls
// back to structure only. `authorCopy`: the entry was marked author copy.
async function acceptRelayedRecord({
  groupId,
  responderAci,
  record,
  opening,
  authorCopy,
}: Readonly<{
  groupId: Uint8Array<ArrayBuffer>;
  responderAci: AciString;
  record: Uint8Array<ArrayBuffer>;
  opening: Uint8Array<ArrayBuffer> | undefined;
  authorCopy: boolean;
}>): Promise<void> {
  initZrdtReceive();
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
  if (outcome.status === 'badOpening' || outcome.status === 'noAudience') {
    log.warn(`relay: opening refused (${outcome.status}); structure only`);
    usedOpening = undefined;
    outcome = await zrdtService.acceptRecord(conversationId, {
      record,
      provenance,
    });
  }
  if (outcome.status === 'missing') {
    const digest = outcome.digest ? toHex(outcome.digest) : undefined;
    if (digest) {
      const gaps = await findGapsFor(conversationId, digest);
      pendingRelays.set(`${conversationId}:${digest}`, {
        opening: usedOpening,
        responderAci,
        authorCopy,
        wasRequested:
          zrdtResendScheduler.isOutstanding(conversationId, digest) ||
          gaps.length > 0,
      });
      // Answered; it now waits for its own links.
      zrdtResendScheduler.resolved(conversationId, digest);
    }
    const pending = await getPendingDigests(conversationId);
    const missing = outcome.digests.map(toHex).filter(d => !pending.has(d));
    log.info(
      `relay: ${digest?.slice(0, 8)} pending; asking for ${missing.length} more`
    );
    // TODO(zrdt): add these digests to the gap row that asked for `digest`.
    if (missing.length > 0) {
      await zrdtResendScheduler.ask(conversationId, missing, responderAci);
    }
    return;
  }
  if (outcome.status !== 'accepted') {
    log.warn(`relay: record refused: ${outcome.status}`);
    return;
  }
  // The store is up to date now; the timeline work runs outside the
  // MessageReceiver queue (like onMessageReceived, it must not wait on the
  // conversation queue).
  drop(
    safely('onRelayAccepted', async () => {
      await onRelayAccepted({
        conversationId,
        digest: outcome.digest,
        record: outcome.record,
        responderAci,
        opening: usedOpening,
        authorCopy,
      });
    })
  );
}

// --- SERVE replies (ACCEPT_VIEW, JOIN_PLAN §4.4, §6) ---------------------------------

/** The author of an encoded record: its last 16 bytes. */
function authorOfRecord(
  record: Uint8Array<ArrayBuffer>
): AciString | undefined {
  return record.byteLength >= 16
    ? aciFromBytes(record.subarray(-16))
    : undefined;
}

function viewItem(entry: ServeEntry, responderAci: AciString): ZrdtViewItem {
  if (entry.kind === 'boundary') {
    return { entry, provenance: { kind: 'relayed', byAci: responderAci } };
  }
  return {
    entry,
    provenance: relayProvenance(
      responderAci,
      authorOfRecord(entry.record),
      entry.kind === 'addressed' && entry.authorCopy
    ),
  };
}

/** The DataMessage timestamp an opening commits, or undefined. */
function openingTimestamp(
  opening: Uint8Array<ArrayBuffer> | undefined
): number | undefined {
  if (!opening || opening.byteLength <= NONCE_BYTES) {
    return undefined;
  }
  try {
    const decoded = Proto.DataMessage.decode(
      own(opening.subarray(NONCE_BYTES))
    );
    const timestamp = Number(decoded.timestamp ?? 0);
    return timestamp > 0 ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

/** A summary of one entry, for logs and the CI hooks (no content). */
export type ZrdtServedEntrySummary = Readonly<{
  kind: ServeEntry['kind'];
  // The record's digest (when ACCEPT_VIEW stored it) or the boundary digest.
  digest?: string;
  hasOpening: boolean;
  authorCopy: boolean;
  result: string;
}>;

/**
 * A sealed SERVE reply that passed the §4.4 checks and opened (the caller,
 * resend.preload.ts, did both): ACCEPT_VIEW its entries with the responder
 * as voucher (a closed store ignores boundary entries), then show what came.
 *
 * - A catch-up: the records with content are shown in the order they were
 *   sent, below one boundary row if the store took boundary digests; a
 *   record without content gets a "content not available from <responder>"
 *   row.
 * - A per-digest repair: each record goes on as a relay (gap rows, author
 *   fast path, own-name alarm). A record whose links are still missing goes
 *   to zrdt_pending through ACCEPT_RECORD, and its links are asked for.
 */
export async function takeServedReply({
  conversationId,
  groupId,
  responderAci,
  entries,
  catchUp,
}: Readonly<{
  conversationId: string;
  groupId: Uint8Array<ArrayBuffer>;
  responderAci: AciString;
  entries: ReadonlyArray<ServeEntry>;
  catchUp: boolean;
}>): Promise<Array<ZrdtServedEntrySummary>> {
  initZrdtReceive();
  const conversation = window.ConversationController.get(conversationId);
  if (
    !conversation ||
    !conversation.areWeAGroupMember() ||
    !conversation.hasMember(responderAci)
  ) {
    log.warn('served: not a group we share with the responder; ignored');
    return [];
  }
  // A catch-up reply: the caller (resend.preload.ts, settleCatchUpStore)
  // opened or settled the store first (JOIN_PLAN §6.1, catchUp.std.ts).
  await zrdtService.ensureConversation(conversationId, groupId);
  const items = entries.map(entry => viewItem(entry, responderAci));
  // The request's mode (protocol 4): a per-digest reply's boundary digests
  // stay only if a stored record (ours, or a pending one taken with them)
  // links them, so a digest asked for by name adds no head.
  const outcomes = await zrdtService.acceptView(conversationId, {
    voucherAci: responderAci,
    forImport: false,
    mode: catchUp ? 'catchup' : 'perDigest',
    items,
  });
  const summary = entries.map((entry, i) => summarize(entry, outcomes[i]));
  log.info(
    `served by ${responderAci} (${catchUp ? 'catch-up' : 'per-digest'}): ` +
      summary.map(e => `${e.kind}:${e.result}`).join(' ')
  );

  type Taken = {
    digest: Uint8Array<ArrayBuffer>;
    record: Uint8Array<ArrayBuffer>;
    opening: Uint8Array<ArrayBuffer> | undefined;
    authorCopy: boolean;
    timestamp: number | undefined;
  };
  const taken = new Array<Taken>();
  let tookBoundary = false;
  for (const [i, entry] of entries.entries()) {
    const result = outcomes[i]?.result;
    if (entry.kind === 'boundary') {
      tookBoundary ||= result?.kind === 'ok';
      continue;
    }
    const opening = entry.kind === 'addressed' ? entry.opening : undefined;
    const authorCopy = entry.kind === 'addressed' && entry.authorCopy;
    if (result?.kind === 'ok') {
      taken.push({
        digest: result.digest,
        record: entry.record,
        opening,
        authorCopy,
        timestamp: openingTimestamp(opening),
      });
    } else if (
      result?.kind === 'missing' ||
      result?.kind === 'badOpening' ||
      result?.kind === 'noAudience'
    ) {
      // As a relay: pending with its opening, or structure only.
      // oxlint-disable-next-line no-await-in-loop
      await acceptRelayedRecord({
        groupId,
        responderAci,
        record: entry.record,
        opening: result.kind === 'missing' ? opening : undefined,
        authorCopy,
      });
    } else {
      log.warn(`served: an entry was refused: ${result?.kind ?? 'none'}`);
    }
  }

  if (!catchUp) {
    for (const item of taken) {
      drop(
        safely('onRelayAccepted', async () => {
          await onRelayAccepted({
            conversationId,
            digest: item.digest,
            record: item.record,
            responderAci,
            opening: item.opening,
            authorCopy: item.authorCopy,
          });
        })
      );
    }
    return summary;
  }

  // A catch-up: show in the order the messages were sent.
  const already = new Set(
    (
      await DataReader.getMessageIdsByZrdtDigest(
        conversationId,
        taken.map(item => toHex(item.digest))
      )
    ).map(row => row.digest)
  );
  const fresh = taken.filter(item => !already.has(toHex(item.digest)));
  const withContent = fresh
    .filter(item => item.opening != null)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (tookBoundary && (await zrdtService.isRelative(conversationId))) {
    await ensureBoundaryRow(conversation, withContent[0]?.timestamp);
  }
  for (const item of withContent) {
    // oxlint-disable-next-line no-await-in-loop
    await safely('onRelayAccepted', async () => {
      await onRelayAccepted({
        conversationId,
        digest: item.digest,
        record: item.record,
        responderAci,
        opening: item.opening,
        authorCopy: item.authorCopy,
        wasRequested: true,
      });
    });
  }
  for (const item of fresh.filter(x => x.opening == null)) {
    // oxlint-disable-next-line no-await-in-loop
    await safely('unavailableRow', () =>
      createUnavailableRow(conversation, item.digest, responderAci)
    );
  }
  scheduleStatusRefresh(conversationId);
  return summary;
}

function summarize(
  entry: ServeEntry,
  outcome: ZrdtViewOutcome | undefined
): ZrdtServedEntrySummary {
  const result = outcome?.result;
  let digest: string | undefined;
  if (entry.kind === 'boundary') {
    digest = toHex(entry.digest);
  } else if (result?.kind === 'ok') {
    digest = toHex(result.digest);
  }
  return {
    kind: entry.kind,
    digest,
    hasOpening: entry.kind === 'addressed' && entry.opening != null,
    authorCopy: entry.kind === 'addressed' && entry.authorCopy,
    result: result?.kind ?? 'none',
  };
}

/**
 * One boundary row per conversation (JOIN_PLAN §6.3): "Earlier messages: not
 * available to you", just above the earliest message the catch-up brought.
 */
async function ensureBoundaryRow(
  conversation: ConversationModel,
  earliestSentAt: number | undefined
): Promise<void> {
  const rows = await loadGapRows(conversation.id);
  if (rows.some(row => row.get('zrdtGap')?.state === 'boundary')) {
    return;
  }
  const receivedAt = incrementMessageCounter();
  const sentAt = (earliestSentAt ?? Date.now()) - 1;
  const attributes = makeZrdtBoundaryMessageAttributes({
    id: generateMessageId(receivedAt).id,
    conversationId: conversation.id,
    receivedAt,
    sentAt,
  });
  const row = new MessageModel(attributes);
  await window.MessageCache.saveMessage(row, { forceSave: true });
  window.MessageCache.register(row);
  drop(conversation.onNewMessage(row));
  log.info(`boundary row ${row.id} in ${conversation.idForLogging()}`);
}

/** A catch-up record without content: one row naming author and responder. */
async function createUnavailableRow(
  conversation: ConversationModel,
  digestBytes: Uint8Array<ArrayBuffer>,
  responderAci: AciString
): Promise<void> {
  const digest = toHex(digestBytes);
  const held = await zrdtService.get(conversation.id, digestBytes);
  const authorAci = held ? aciFromBytes(held.authorAci) : undefined;
  if (!authorAci) {
    return;
  }
  const receivedAt = incrementMessageCounter();
  const attributes = makeZrdtUnavailableMessageAttributes({
    id: generateMessageId(receivedAt).id,
    conversationId: conversation.id,
    receivedAt,
    sentAt: Date.now(),
    digest,
    authorAci,
    responderAci,
  });
  const row = new MessageModel(attributes);
  await window.MessageCache.saveMessage(row, { forceSave: true });
  window.MessageCache.register(row);
  drop(conversation.onNewMessage(row));
}

async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.error(`${what} failed`, Errors.toLogFormat(error));
  }
}

// A relayed record that was pending got drained by the service (without the
// opening): check the opening now (idempotent accept), then go on as for a
// direct relay.
async function afterDrainedRelay(
  conversationId: string,
  digest: string,
  relay: PendingRelay
): Promise<void> {
  try {
    const digestBytes = Bytes.fromHex(digest);
    const held = await zrdtService.get(conversationId, digestBytes);
    if (!held) {
      return;
    }
    let { opening } = relay;
    if (opening) {
      const check = await zrdtService.acceptRecord(conversationId, {
        record: held.record,
        opening,
        provenance: { kind: 'relayed', byAci: relay.responderAci },
      });
      if (check.status !== 'accepted') {
        log.warn(`relay: drained ${digest.slice(0, 8)}: ${check.status}`);
        opening = undefined;
      }
    }
    await onRelayAccepted({
      conversationId,
      digest: digestBytes,
      record: held.record,
      responderAci: relay.responderAci,
      opening,
      authorCopy: relay.authorCopy,
      wasRequested: relay.wasRequested,
    });
  } catch (error) {
    log.error('afterDrainedRelay failed', Errors.toLogFormat(error));
  }
}

async function onRelayAccepted({
  conversationId,
  digest: digestBytes,
  record,
  responderAci,
  opening,
  authorCopy,
  wasRequested: knownRequested,
}: Readonly<{
  conversationId: string;
  digest: Uint8Array<ArrayBuffer>;
  record: Uint8Array<ArrayBuffer>;
  responderAci: AciString;
  opening: Uint8Array<ArrayBuffer> | undefined;
  authorCopy: boolean;
  wasRequested?: boolean;
}>): Promise<boolean> {
  const conversation = window.ConversationController.get(conversationId);
  if (!conversation) {
    return false;
  }
  const digest = toHex(digestBytes);
  const held = await zrdtService.get(conversationId, digestBytes);
  const authorAci = held ? aciFromBytes(held.authorAci) : undefined;
  if (!authorAci) {
    log.warn(`relay: accepted ${digest.slice(0, 8)} but cannot read author`);
    return false;
  }
  const provenance = relayProvenance(responderAci, authorAci, authorCopy);
  if (provenance.kind === 'live') {
    // The author's own copy (SERVE marked it so): upgrade (idempotent accept).
    await zrdtService.acceptRecord(conversationId, {
      record,
      provenance,
    });
    await upgradeShownMessage(conversationId, digest);
  }

  const ourAci = getOurAci();
  const gaps = await findGapsFor(conversationId, digest);
  const ownLive =
    authorAci === ourAci ? await isLive(conversationId, digestBytes) : true;
  const action = decideRelayAction({
    authorAci,
    ourAci,
    hasOpening: opening != null,
    wasRequested:
      knownRequested === true ||
      zrdtResendScheduler.isOutstanding(conversationId, digest) ||
      gaps.length > 0,
    ownLive,
  });
  zrdtResendScheduler.resolved(conversationId, digest);
  log.info(`relay: ${digest.slice(0, 8)} by ${responderAci}: ${action}`);

  if (action === 'ownNameAlarm') {
    await raiseOwnNameAlarm(conversationId, digestBytes);
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
        shown
          ? { kind: 'content' }
          : { kind: 'unavailable', authorAci, fromAci: responderAci }
      );
    }
  } else if (action === 'structureOnly' || action === 'show') {
    for (const row of gaps) {
      // oxlint-disable-next-line no-await-in-loop
      await resolveGapRow(row, digest, {
        kind: 'unavailable',
        authorAci,
        fromAci: responderAci,
      });
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
  return action === 'show' && opening != null;
}

async function isLive(
  conversationId: string,
  digest: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  const rows = await DataReader.getZrdtProvenance(conversationId);
  const row = rows.find(r => Bytes.areEqual(r.digest, digest));
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
async function raiseOwnNameAlarm(
  conversationId: string,
  digest: Uint8Array<ArrayBuffer>
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
  opening: Uint8Array<ArrayBuffer>;
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
    if (
      !isZrdtRecordMessage({
        isGroupV2: true,
        isEdit: false,
        dataMessage: safe,
      })
    ) {
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
function scheduleStatusRefresh(conversationId: string): void {
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
async function refreshStatuses(conversationId: string): Promise<void> {
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
