// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// zrdt UI state (APP.md §7). The service (ts/zrdt/service.preload.ts) holds
// the truth; this slice mirrors what the UI shows: the backend badge, CLASSIFY
// statuses per conversation, the disown set (own-name alarm), the rejected
// banner, the unconfirmed section and the compare screen.
//
// Fed by zrdtEvents ('backend', 'accepted', 'classify', and 'rejected' if the
// service emits it) through initZrdtRedux (ts/state/smart/ZrdtRoot).

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import lodash from 'lodash';
import type { ReadonlyDeep } from 'type-fest';
import type { Store } from 'redux';
import type { ThunkAction, ThunkDispatch } from 'redux-thunk';

import { createLogger } from '../../logging/log.std.ts';
import * as Errors from '../../types/errors.std.ts';
import * as Bytes from '../../Bytes.std.ts';
import { bytesToUuid, uuidToBytes } from '../../util/uuidToBytes.std.ts';
import { DataReader } from '../../sql/Client.preload.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import type { BoundActionCreatorsMapObject } from '../../hooks/useBoundActions.std.ts';
import { useBoundActions } from '../../hooks/useBoundActions.std.ts';
import type { StateType as RootStateType } from '../reducer.preload.ts';
import { getSelectedConversationId } from '../selectors/nav.std.ts';
import { getConversationSelector } from '../selectors/conversations.dom.ts';
import { getUserACI } from '../selectors/user.std.ts';
import type {
  ZrdtOpenOutcome,
  ZrdtStatus,
} from '../../zrdt/service.preload.ts';
import {
  rejectionOf,
  restartZrdt,
  salvageStored,
  zrdtEvents,
  zrdtService,
} from '../../zrdt/service.preload.ts';
import {
  loadHeldOpenings,
  loadServeHostState,
  requestMissing,
} from '../../zrdt/resend.preload.ts';
import { isEphemeralOpening } from '../../zrdt/audience.std.ts';
import { signalProtocolStore } from '../../SignalProtocolStore.preload.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { drop } from '../../util/drop.std.ts';
import type { ZrdtRejectReason } from '../../zrdt/ui/labels.std.ts';
import { rejectedText } from '../../zrdt/ui/labels.std.ts';
import type { ZrdtCompareOutcome } from '../../zrdt/ui/ZrdtCompareModal.dom.tsx';
import {
  classifyCompare,
  encodeCompareCode,
  headsFingerprintWords,
  parseCompareCode,
} from '../../zrdt/ui/compareCode.std.ts';

const log = createLogger('zrdt-ui');

// --- Helpers --------------------------------------------------------------------

/** Hex for any byte array (the service may hand out ArrayBufferLike views). */
export function zrdtHex(bytes: Iterable<number>): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export function zrdtFromHex(hex: string): Uint8Array<ArrayBuffer> {
  return Bytes.fromHex(hex);
}

/** Store blob: "zrdtS2" ‖ group(32) ‖ u32 count (big-endian) ‖ … (PLAN.md §3.4). */
export function zrdtBlobRecordCount(
  blob: ArrayLike<number>
): number | undefined {
  const offset = 6 + 32;
  if (blob.length < offset + 4) {
    return undefined;
  }
  let count = 0;
  for (let i = 0; i < 4; i += 1) {
    count = count * 256 + (blob[offset + i] ?? 0);
  }
  return count;
}

export function zrdtRejectReasonFromOutcome(
  outcome: ZrdtOpenOutcome
): ZrdtRejectReason | undefined {
  switch (outcome.status) {
    case 'ok':
      return undefined;
    case 'unverifiable':
      return { kind: 'unverifiable', missing: outcome.missing.map(zrdtHex) };
    case 'malformed':
      return { kind: 'malformed' };
    case 'tooLarge':
      return { kind: 'too-large' };
    case 'wrongChat':
      return { kind: 'wrong-chat' };
    case 'collision':
      return { kind: 'collision', digest: zrdtHex(outcome.digest) };
    default:
      return { kind: 'malformed' };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Delay before a compare's "Asked; no answer." (APP.md §7, beat 3). Explicit,
// not derived from handleRetry's ciMode unit.
function getCompareTimeoutMs(): number {
  const env =
    typeof process !== 'undefined'
      ? (process.env.ZRDT_COMPARE_TIMEOUT_MS ??
        process.env.ZRDT_RESEND_DELAY_MS)
      : undefined;
  const value = env != null ? Number(env) : NaN;
  // Resend delay plus the group fallback round: about 3x.
  return Number.isFinite(value) && value > 0 ? value * 3 : 10_000;
}

/** Where Settings → Internal exports to and imports from by default. */
export function getZrdtDumpPath(conversationId: string): string {
  return join(
    window.SignalContext.getPath('userData'),
    `zrdt-export-${conversationId}.bin`
  );
}

// --- Dump file (RESTORE_PLAN.md §3) --------------------------------------------
//
// JSON: { "zrdtDump": 1, "blob": base64 store blob,
//         "content": { <hex digest>: base64 opening } }.
// An opening is `nonce(32) ‖ DataMessage bytes without fields 15 and 200`
// (message attribute zrdtOpening), so the file never holds the group master
// key. A raw store blob (older exports) is read too. doctor.ts edits the
// blob inside the JSON (its `locateBlob`).

type ZrdtDumpType = ReadonlyDeep<{
  blob: Uint8Array<ArrayBuffer>;
  content: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}>;

const NONCE_BYTES = 32;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function zrdtParseDump(bytes: Uint8Array<ArrayBuffer>): ZrdtDumpType {
  // 0x7b is "{"
  if (bytes[0] !== 0x7b) {
    return { blob: bytes, content: new Map() };
  }
  const doc = JSON.parse(Bytes.toString(bytes)) as {
    blob?: unknown;
    content?: Record<string, unknown>;
  };
  if (typeof doc.blob !== 'string') {
    throw new Error('not a zrdt dump (no "blob")');
  }
  const content = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [hex, opening] of Object.entries(doc.content ?? {})) {
    if (HEX_DIGEST.test(hex) && typeof opening === 'string') {
      content.set(hex, Bytes.fromBase64(opening));
    }
  }
  return { blob: Bytes.fromBase64(doc.blob), content };
}

function zrdtEncodeDump(dump: ZrdtDumpType): Uint8Array<ArrayBuffer> {
  const content: Record<string, string> = {};
  for (const [hex, opening] of dump.content) {
    content[hex] = Bytes.toBase64(opening);
  }
  return Bytes.fromString(
    `${JSON.stringify({
      zrdtDump: 1,
      warning:
        "Do not share: this file is outside Signal's encryption. It holds " +
        'message text and who linked what.',
      blob: Bytes.toBase64(dump.blob),
      content,
    })}\n`
  );
}

/** The DataMessage inside an opening, or undefined if it does not decode. */
function decodeOpening(
  opening: Uint8Array<ArrayBuffer>
): Proto.DataMessage | undefined {
  if (opening.byteLength <= NONCE_BYTES) {
    return undefined;
  }
  try {
    return Proto.DataMessage.decode(opening.subarray(NONCE_BYTES));
  } catch {
    return undefined;
  }
}

// Content left out of exports and refused on import (RESTORE_PLAN.md §3):
// disappearing, view-once (deleted-for-everyone rows are checked on export).
function isExcludedContent(decoded: Proto.DataMessage): boolean {
  return (decoded.expireTimer ?? 0) > 0 || decoded.isViewOnce === true;
}

/**
 * Openings of the conversation's messages, by hex digest, for an export:
 * exactly the openings in SERVE's reply to our own account, under our own
 * identity key, with the export flag (JOIN_PLAN §4.5): SERVE refuses
 * disappearing and view-once content (`serve_export`). Deleted-for-everyone
 * rows hold no opening.
 */
async function getExportContent(
  conversationId: string
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const ourAci = itemStorage.user.getCheckedAci();
  const ourKeys = signalProtocolStore.getIdentityKeyPair(ourAci);
  if (!ourKeys) {
    throw new Error('no identity key pair of our own');
  }
  const [held, hostState] = await Promise.all([
    loadHeldOpenings(conversationId, undefined),
    loadServeHostState(conversationId),
  ]);
  const reply = await zrdtService.serve(conversationId, {
    ownAci: uuidToBytes(ourAci),
    requesterAci: uuidToBytes(ourAci),
    key: new Uint8Array(ourKeys.publicKey.serialize()),
    requestId: globalThis.crypto.getRandomValues(new Uint8Array(16)),
    since: [],
    mode: 'catchup',
    wanted: [],
    forExport: true,
    strict: false,
    live: hostState.live,
    disown: hostState.disown,
    held,
  });
  const digestOfOpening = new Map<string, string>();
  for (const item of held) {
    if (item.opening) {
      digestOfOpening.set(Bytes.toBase64(item.opening), zrdtHex(item.digest));
    }
  }
  const content = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const entry of reply.entries) {
    if (entry.kind !== 'addressed' || entry.opening === undefined) {
      continue;
    }
    const digest = digestOfOpening.get(Bytes.toBase64(entry.opening));
    if (digest !== undefined) {
      content.set(digest, entry.opening);
    }
  }
  return content;
}

// Verified imported content, by conversation and hex digest: the text the
// unconfirmed section shows for records without a message row. In memory
// only. TODO(zrdt): persist it (a restart shows "content unavailable" again).
const importedContent = new Map<
  string,
  Map<string, { text: string; sentAt?: number }>
>();

/**
 * Keeps a content entry only if its record is in the store and
 * COMMIT(opening) == record.commit: ACCEPT_RECORD with the opening (zrdtd
 * checks the opening before it touches the store; the record is already
 * held, so the accept is idempotent and its provenance is never lowered).
 */
async function verifyImportedContent(
  conversationId: string,
  content: ReadonlyMap<string, Uint8Array<ArrayBuffer>>
): Promise<{ kept: number; refused: number }> {
  let kept = 0;
  let refused = 0;
  let byDigest = importedContent.get(conversationId);
  if (byDigest == null) {
    byDigest = new Map();
    importedContent.set(conversationId, byDigest);
  }
  for (const [hex, opening] of content) {
    try {
      const decoded = decodeOpening(opening);
      // oxlint-disable-next-line no-await-in-loop
      const held = await zrdtService.get(conversationId, zrdtFromHex(hex));
      // Import refuses ephemeral content (JOIN_PLAN §4.5): by the committed
      // bytes, as SERVE's export flag does, and by the decoded message.
      if (
        decoded == null ||
        isEphemeralOpening(opening) ||
        isExcludedContent(decoded) ||
        held == null
      ) {
        refused += 1;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const check = await zrdtService.acceptRecord(conversationId, {
        record: held.record,
        opening,
        provenance: { kind: 'imported' },
      });
      if (check.status !== 'accepted') {
        refused += 1;
        continue;
      }
      const timestamp = Number(decoded.timestamp ?? 0);
      byDigest.set(hex, {
        text: decoded.body ?? '',
        sentAt: timestamp > 0 ? timestamp : undefined,
      });
      kept += 1;
    } catch (error) {
      log.warn('verifyImportedContent', Errors.toLogFormat(error));
      refused += 1;
    }
  }
  return { kept, refused };
}

// Import dumps that failed MERGE, kept for "Keep what verifies". Not in
// Redux: bytes do not belong in the store.
const failedImportBlobs = new Map<string, ZrdtDumpType>();

// --- State ----------------------------------------------------------------------

export type ZrdtBackendInfoType = ReadonlyDeep<{
  kind: 'lean' | 'stub';
  version: string;
  available: boolean;
}>;

export type ZrdtUnconfirmedItemType = ReadonlyDeep<{
  digest: string;
  status: ZrdtStatus;
  attributedToAci?: string;
  text?: string;
  sentAt?: number;
  /** A message row carries this digest (then it is also in the timeline). */
  hasMessage: boolean;
}>;

export type ZrdtConversationStateType = ReadonlyDeep<{
  /** hex digest -> CLASSIFY status */
  statuses: Record<string, ZrdtStatus>;
  /** Our disown set (records in our name we did not create), hex. */
  disown: Array<string>;
  alarmDismissed: Array<string>;
  rejected?: { reason: ZrdtRejectReason; source: 'startup' | 'import' };
  salvage?: { kept: number; dropped: Array<string> };
  busy?: boolean;
  /**
   * The collapsed section: imported records no member has confirmed, plus
   * imported records without a message row (structure only), which have no
   * other place to show their label (beat 5).
   */
  unconfirmed: Array<ZrdtUnconfirmedItemType>;
}>;

export type ZrdtCompareStateType = ReadonlyDeep<{
  conversationId: string;
  chat: string;
  ourCode: string;
  ourWords: Array<string>;
  pastedCode?: string;
  theirOwner?: string;
  theirName?: string;
  theirWords?: Array<string>;
  outcome?: ZrdtCompareOutcome;
  askedAt?: number;
}>;

export type ZrdtStateType = ReadonlyDeep<{
  backend?: ZrdtBackendInfoType;
  unavailableDetail?: string;
  byConversation: Record<string, ZrdtConversationStateType>;
  compare?: ZrdtCompareStateType;
  /** Last result line of Settings → Internal (export/import/salvage). */
  internalResult?: string;
}>;

export function getEmptyState(): ZrdtStateType {
  return { byConversation: {} };
}

function getEmptyConversationState(): ZrdtConversationStateType {
  return { statuses: {}, disown: [], alarmDismissed: [], unconfirmed: [] };
}

// --- Actions --------------------------------------------------------------------

const SET_BACKEND = 'zrdt/SET_BACKEND';
const PATCH_CONVERSATION = 'zrdt/PATCH_CONVERSATION';
const SET_COMPARE = 'zrdt/SET_COMPARE';
const SET_INTERNAL_RESULT = 'zrdt/SET_INTERNAL_RESULT';

type SetBackendActionType = ReadonlyDeep<{
  type: typeof SET_BACKEND;
  payload: { info: ZrdtBackendInfoType; detail?: string };
}>;
type PatchConversationActionType = ReadonlyDeep<{
  type: typeof PATCH_CONVERSATION;
  payload: {
    conversationId: string;
    patch: Partial<ZrdtConversationStateType>;
    // Explicitly clear these optional keys.
    clear?: Array<'rejected' | 'salvage' | 'busy'>;
  };
}>;
type SetCompareActionType = ReadonlyDeep<{
  type: typeof SET_COMPARE;
  payload: ZrdtCompareStateType | undefined;
}>;
type SetInternalResultActionType = ReadonlyDeep<{
  type: typeof SET_INTERNAL_RESULT;
  payload: string | undefined;
}>;

export type ZrdtActionType = ReadonlyDeep<
  | SetBackendActionType
  | PatchConversationActionType
  | SetCompareActionType
  | SetInternalResultActionType
>;

// oxlint-disable-next-line signal-desktop/enforce-type-alias-readonlydeep
type ZrdtThunk<R = void> = ThunkAction<
  R,
  RootStateType,
  unknown,
  ZrdtActionType
>;

function setBackend(
  info: ZrdtBackendInfoType,
  detail?: string
): SetBackendActionType {
  return { type: SET_BACKEND, payload: { info, detail } };
}

function patchConversation(
  conversationId: string,
  patch: Partial<ZrdtConversationStateType>,
  clear?: Array<'rejected' | 'salvage' | 'busy'>
): PatchConversationActionType {
  return {
    type: PATCH_CONVERSATION,
    payload: { conversationId, patch, clear },
  };
}

function setInternalResult(
  text: string | undefined
): SetInternalResultActionType {
  return { type: SET_INTERNAL_RESULT, payload: text };
}

function nameOf(state: RootStateType, aci: string | undefined): string {
  if (aci == null) {
    return 'A member';
  }
  const conversation = getConversationSelector(state)(aci);
  return conversation.firstName || conversation.title || aci.slice(0, 8);
}

function getGroupChatId(
  state: RootStateType,
  conversationId: string
): string | undefined {
  const conversation = state.conversations.conversationLookup[conversationId];
  if (conversation?.groupId == null) {
    return undefined;
  }
  return Bytes.toHex(Bytes.fromBase64(conversation.groupId));
}

/**
 * A conversation whose rows did not OPEN at start: the service emitted
 * 'rejected' possibly before the UI listened, so ask it (T0's rejectionOf).
 */
function checkStartupRejection(conversationId: string): ZrdtThunk {
  return (dispatch, getState) => {
    const current = getState().zrdt.byConversation[conversationId];
    if (current?.rejected?.source === 'import') {
      return;
    }
    let outcome: ZrdtOpenOutcome | undefined;
    try {
      outcome = rejectionOf(conversationId);
    } catch (error) {
      log.warn('rejectionOf failed', Errors.toLogFormat(error));
      return;
    }
    if (outcome != null) {
      dispatch(markRejected(conversationId, outcome, 'startup'));
    } else if (current?.rejected?.source === 'startup') {
      dispatch(patchConversation(conversationId, {}, ['rejected']));
    }
  };
}

/** Re-reads CLASSIFY, the disown set and the unconfirmed section. */
function refreshConversation(conversationId: string): ZrdtThunk<Promise<void>> {
  return async dispatch => {
    try {
      const [statusMap, disown, provenance] = await Promise.all([
        zrdtService.classify(conversationId),
        zrdtService.disownSet(conversationId),
        DataReader.getZrdtProvenance(conversationId),
      ]);
      const statuses: Record<string, ZrdtStatus> = {};
      for (const [hex, status] of statusMap) {
        statuses[hex] = status;
      }
      const imported = new Set(
        provenance
          .filter(row => row.kind === 'imported')
          .map(row => zrdtHex(row.digest))
      );
      const unconfirmed: Array<ZrdtUnconfirmedItemType> = [];
      for (const [hex, status] of Object.entries(statuses)) {
        if (!imported.has(hex)) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const item = await getUnconfirmedItem(conversationId, hex, status);
        if (status.kind === 'unconfirmed' || !item.hasMessage) {
          unconfirmed.push(item);
        }
      }
      // Causal order (a record after the ones it links), then time, then
      // digest: the two fakes of beat 5 sit on top of the genuine head.
      const depth = new Map<string, number>();
      for (const item of unconfirmed) {
        // oxlint-disable-next-line no-await-in-loop
        depth.set(item.digest, await getDepth(conversationId, item.digest));
      }
      unconfirmed.sort(
        (a, b) =>
          (depth.get(a.digest) ?? 0) - (depth.get(b.digest) ?? 0) ||
          (a.sentAt ?? 0) - (b.sentAt ?? 0) ||
          a.digest.localeCompare(b.digest)
      );
      dispatch(
        patchConversation(conversationId, {
          statuses,
          disown: disown.map(zrdtHex).sort(),
          unconfirmed,
        })
      );
      dispatch(checkStartupRejection(conversationId));
    } catch (error) {
      log.warn(
        `refreshConversation(${conversationId}) failed`,
        Errors.toLogFormat(error)
      );
    }
  };
}

// Records are immutable, so a digest's author, links and depth never change.
const authorByDigest = new Map<string, string>();
const depthByDigest = new Map<string, number>();

/** Longest link path from a root (a record without links) to `hex`. */
async function getDepth(conversationId: string, hex: string): Promise<number> {
  const known = depthByDigest.get(hex);
  if (known != null) {
    return known;
  }
  // Iterative post-order walk over links (stores can be deep).
  const stack: Array<{ hex: string; links?: Array<string> }> = [{ hex }];
  const visiting = new Set<string>([hex]);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top == null) {
      break;
    }
    if (top.links == null) {
      // oxlint-disable-next-line no-await-in-loop
      const parts = await zrdtService.get(conversationId, zrdtFromHex(top.hex));
      top.links = (parts?.links ?? []).map(zrdtHex);
    }
    const next = top.links.find(l => !depthByDigest.has(l) && !visiting.has(l));
    if (next != null) {
      visiting.add(next);
      stack.push({ hex: next });
      continue;
    }
    const d =
      top.links.length === 0
        ? 0
        : 1 + Math.max(...top.links.map(l => depthByDigest.get(l) ?? 0));
    depthByDigest.set(top.hex, d);
    visiting.delete(top.hex);
    stack.pop();
  }
  return depthByDigest.get(hex) ?? 0;
}

async function getUnconfirmedItem(
  conversationId: string,
  hex: string,
  status: ZrdtStatus
): Promise<ZrdtUnconfirmedItemType> {
  const item: {
    -readonly [K in keyof ZrdtUnconfirmedItemType]: ZrdtUnconfirmedItemType[K];
  } = { digest: hex, status, hasMessage: false };
  try {
    item.attributedToAci = authorByDigest.get(hex);
    if (item.attributedToAci == null) {
      const parts = await zrdtService.get(conversationId, zrdtFromHex(hex));
      if (parts != null && parts.authorAci.byteLength === 16) {
        item.attributedToAci = bytesToUuid(new Uint8Array(parts.authorAci));
        if (item.attributedToAci != null) {
          authorByDigest.set(hex, item.attributedToAci);
        }
      }
    }
    const rows = await DataReader.getMessageIdsByZrdtDigest(conversationId, [
      hex,
    ]);
    const id = rows[0]?.messageId;
    const message =
      id != null ? await DataReader.getMessageById(id) : undefined;
    if (message != null) {
      item.hasMessage = true;
      item.text = message.body;
      item.sentAt = message.sent_at;
    } else {
      const content = importedContent.get(conversationId)?.get(hex);
      if (content != null) {
        item.text = content.text;
        item.sentAt = content.sentAt;
      }
    }
  } catch (error) {
    log.warn('getUnconfirmedItem failed', Errors.toLogFormat(error));
  }
  return item;
}

function dismissOwnNameAlarm(conversationId: string): ZrdtThunk {
  return (dispatch, getState) => {
    const current = getState().zrdt.byConversation[conversationId];
    dispatch(
      patchConversation(conversationId, {
        alarmDismissed: [...(current?.disown ?? [])],
      })
    );
  };
}

function markRejected(
  conversationId: string,
  outcome: ZrdtOpenOutcome,
  source: 'startup' | 'import'
): ZrdtThunk {
  return dispatch => {
    const reason = zrdtRejectReasonFromOutcome(outcome);
    if (reason == null) {
      dispatch(patchConversation(conversationId, {}, ['rejected']));
      return;
    }
    dispatch(
      patchConversation(conversationId, { rejected: { reason, source } }, [
        'salvage',
      ])
    );
  };
}

/** "Keep what verifies" (SALVAGE) for a failed import. */
function keepWhatVerifies(conversationId: string): ZrdtThunk<Promise<void>> {
  return async dispatch => {
    const dump = failedImportBlobs.get(conversationId);
    if (dump == null) {
      await dispatch(keepWhatVerifiesStored(conversationId));
      return;
    }
    const { blob } = dump;
    dispatch(patchConversation(conversationId, { busy: true }));
    try {
      const result = await zrdtService.salvageBlob(conversationId, blob);
      if ('status' in result) {
        dispatch(markRejected(conversationId, result, 'import'));
        dispatch(patchConversation(conversationId, {}, ['busy']));
        return;
      }
      failedImportBlobs.delete(conversationId);
      await verifyImportedContent(conversationId, dump.content);
      const count = zrdtBlobRecordCount(blob) ?? result.dropped.length;
      const dropped = result.dropped.map(zrdtHex);
      dispatch(
        patchConversation(
          conversationId,
          { salvage: { kept: Math.max(0, count - dropped.length), dropped } },
          ['rejected', 'busy']
        )
      );
      dispatch(
        setInternalResult(
          `Salvage: kept ${Math.max(0, count - dropped.length)}, dropped ${dropped.length}`
        )
      );
      await dispatch(refreshConversation(conversationId));
    } catch (error) {
      log.error('keepWhatVerifies failed', Errors.toLogFormat(error));
      dispatch(patchConversation(conversationId, {}, ['busy']));
      dispatch(setInternalResult(`Salvage failed: ${errorText(error)}`));
    }
  };
}

/** "Keep what verifies" after a startup rejection: SALVAGE the own rows. */
function keepWhatVerifiesStored(
  conversationId: string
): ZrdtThunk<Promise<void>> {
  return async dispatch => {
    dispatch(patchConversation(conversationId, { busy: true }));
    try {
      const before = (await DataReader.getZrdtRecords(conversationId)).length;
      const result = await salvageStored(conversationId);
      if ('status' in result) {
        dispatch(markRejected(conversationId, result, 'startup'));
        dispatch(patchConversation(conversationId, {}, ['busy']));
        return;
      }
      const dropped = result.dropped.map(zrdtHex);
      const kept = Math.max(0, before - dropped.length);
      dispatch(
        patchConversation(conversationId, { salvage: { kept, dropped } }, [
          'rejected',
          'busy',
        ])
      );
      dispatch(
        setInternalResult(`Salvage: kept ${kept}, dropped ${dropped.length}`)
      );
      await dispatch(refreshConversation(conversationId));
    } catch (error) {
      log.error('keepWhatVerifiesStored failed', Errors.toLogFormat(error));
      dispatch(patchConversation(conversationId, {}, ['busy']));
      dispatch(setInternalResult(`Salvage failed: ${errorText(error)}`));
    }
  };
}

/** The unavailable banner's "Restart" (T0's restartZrdt). */
function restartBackend(): ZrdtThunk<Promise<void>> {
  return async dispatch => {
    try {
      await restartZrdt();
    } catch (error) {
      log.error('restartZrdt failed', Errors.toLogFormat(error));
      dispatch(setInternalResult(`Restart failed: ${errorText(error)}`));
    }
  };
}

function dismissSalvageReport(
  conversationId: string
): PatchConversationActionType {
  return patchConversation(conversationId, {}, ['salvage']);
}

function exportConversation(
  conversationId: string,
  path?: string
): ZrdtThunk<Promise<string | undefined>> {
  return async dispatch => {
    const target = path || getZrdtDumpPath(conversationId);
    try {
      const blob = await zrdtService.exportBlob(conversationId);
      const content = await getExportContent(conversationId);
      const file = zrdtEncodeDump({ blob, content });
      await writeFile(target, file);
      const count = zrdtBlobRecordCount(blob);
      dispatch(
        setInternalResult(
          `Exported ${count ?? '?'} records, ${content.size} with content ` +
            `(${file.byteLength} bytes) to ${target}`
        )
      );
      return target;
    } catch (error) {
      log.error('exportConversation failed', Errors.toLogFormat(error));
      dispatch(setInternalResult(`Export failed: ${errorText(error)}`));
      return undefined;
    }
  };
}

/** Import (MERGE). On failure the conversation shows the rejected banner. */
function importConversation(
  conversationId: string,
  path?: string
): ZrdtThunk<Promise<ZrdtOpenOutcome | undefined>> {
  return async dispatch => {
    const source = path || getZrdtDumpPath(conversationId);
    try {
      const dump = zrdtParseDump(new Uint8Array(await readFile(source)));
      const outcome = await zrdtService.importBlob(conversationId, dump.blob);
      if (outcome.status === 'ok') {
        failedImportBlobs.delete(conversationId);
        const { kept, refused } = await verifyImportedContent(
          conversationId,
          dump.content
        );
        dispatch(patchConversation(conversationId, {}, ['rejected']));
        dispatch(
          setInternalResult(
            `Import of ${source}: ok (content: ${kept} kept, ${refused} refused)`
          )
        );
        await dispatch(refreshConversation(conversationId));
      } else {
        failedImportBlobs.set(conversationId, dump);
        dispatch(markRejected(conversationId, outcome, 'import'));
        const reason = zrdtRejectReasonFromOutcome(outcome);
        dispatch(
          setInternalResult(
            `Import of ${source}: ${reason ? rejectedText(reason) : outcome.status}`
          )
        );
      }
      return outcome;
    } catch (error) {
      log.error('importConversation failed', Errors.toLogFormat(error));
      dispatch(setInternalResult(`Import failed: ${errorText(error)}`));
      return undefined;
    }
  };
}

/** Salvage a file directly (Settings → Internal), without importing first. */
function salvageFile(
  conversationId: string,
  path?: string
): ZrdtThunk<Promise<void>> {
  return async dispatch => {
    const source = path || getZrdtDumpPath(conversationId);
    try {
      failedImportBlobs.set(
        conversationId,
        zrdtParseDump(new Uint8Array(await readFile(source)))
      );
    } catch (error) {
      dispatch(setInternalResult(`Salvage failed: ${errorText(error)}`));
      return;
    }
    await dispatch(keepWhatVerifies(conversationId));
  };
}

// Compare (APP.md §7 "Compare screen logic")

let compareTimer: ReturnType<typeof setTimeout> | undefined;

function clearCompareTimer(): void {
  if (compareTimer != null) {
    clearTimeout(compareTimer);
    compareTimer = undefined;
  }
}

function openCompare(conversationId: string): ZrdtThunk<Promise<void>> {
  return async (dispatch, getState) => {
    clearCompareTimer();
    const state = getState();
    const chat = getGroupChatId(state, conversationId);
    const ourAci = getUserACI(state);
    if (chat == null || ourAci == null) {
      log.warn('openCompare: not a group or no ACI');
      return;
    }
    try {
      const heads = (await zrdtService.heads(conversationId)).map(zrdtHex);
      const ourCode = encodeCompareCode({ chat, owner: ourAci, heads });
      const ourWords = await headsFingerprintWords(heads);
      dispatch({
        type: SET_COMPARE,
        payload: { conversationId, chat, ourCode, ourWords },
      });
    } catch (error) {
      log.error('openCompare failed', Errors.toLogFormat(error));
      dispatch(setInternalResult(`Compare failed: ${errorText(error)}`));
    }
  };
}

function closeCompare(): SetCompareActionType {
  clearCompareTimer();
  return { type: SET_COMPARE, payload: undefined };
}

/** Our code is recomputed too, so "identical" follows new messages. */
function comparePasted(
  pastedCode: string,
  options: { autoAsk?: boolean } = {}
): ZrdtThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const compare = getState().zrdt.compare;
    if (compare == null) {
      return;
    }
    const { conversationId, chat } = compare;
    const autoAsk = options.autoAsk ?? true;
    const parsed = parseCompareCode(pastedCode, chat);
    if (!parsed.ok) {
      clearCompareTimer();
      dispatch({
        type: SET_COMPARE,
        payload: {
          ...compare,
          pastedCode,
          theirOwner: undefined,
          theirName: undefined,
          theirWords: undefined,
          outcome: { kind: 'invalid-code', error: parsed.error },
        },
      });
      return;
    }
    const { owner, heads: theirs } = parsed.code;
    try {
      const oursRaw = (await zrdtService.heads(conversationId)).map(zrdtHex);
      const ourAci = getUserACI(getState()) ?? compare.chat;
      const ourCode = encodeCompareCode({
        chat,
        owner: ourAci,
        heads: oursRaw,
      });
      const ourWords = await headsFingerprintWords(oursRaw);
      const oursSet = new Set(oursRaw);
      const notInStore: Array<string> = [];
      for (const head of theirs) {
        if (oursSet.has(head)) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const has = await zrdtService.has(conversationId, zrdtFromHex(head));
        if (!has) {
          notInStore.push(head);
        }
      }
      const kind = classifyCompare(oursRaw, theirs, notInStore);
      const theirWords = await headsFingerprintWords(theirs);
      const theirName = nameOf(getState(), owner);
      let outcome: ZrdtCompareOutcome;
      const current = getState().zrdt.compare;
      if (current?.conversationId !== conversationId) {
        // Closed (or reopened for another chat) while we were asking HAS.
        return;
      }
      const wasAsking =
        current?.outcome?.kind === 'you-are-behind' && current.outcome.asking;
      const wasWithheld = current?.outcome?.kind === 'withheld';
      if (kind.kind === 'you-are-behind') {
        if (wasWithheld && !autoAsk) {
          outcome = { kind: 'withheld', missing: kind.missing };
        } else {
          outcome = {
            kind: 'you-are-behind',
            missing: kind.missing,
            asking: autoAsk || wasAsking,
          };
        }
      } else {
        clearCompareTimer();
        outcome = kind;
      }
      dispatch({
        type: SET_COMPARE,
        payload: {
          ...current,
          ourCode,
          ourWords,
          pastedCode,
          theirOwner: owner,
          theirName,
          theirWords,
          outcome,
        },
      });
      if (kind.kind === 'you-are-behind' && autoAsk) {
        await dispatch(askCompare());
      }
    } catch (error) {
      log.error('comparePasted failed', Errors.toLogFormat(error));
      dispatch(setInternalResult(`Compare failed: ${errorText(error)}`));
    }
  };
}

/** "Ask for it" / "Ask again": request the missing digests, then time out. */
function askCompare(): ZrdtThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const compare = getState().zrdt.compare;
    const outcome = compare?.outcome;
    if (
      compare == null ||
      outcome == null ||
      (outcome.kind !== 'you-are-behind' && outcome.kind !== 'withheld')
    ) {
      return;
    }
    const missing = [...outcome.missing];
    dispatch({
      type: SET_COMPARE,
      payload: {
        ...compare,
        askedAt: Date.now(),
        outcome: { kind: 'you-are-behind', missing, asking: true },
      },
    });
    // The timeout starts now: requestMissing may only resolve after its own
    // 1:1 and group rounds.
    clearCompareTimer();
    compareTimer = setTimeout(() => {
      compareTimer = undefined;
      const now = getState().zrdt.compare;
      if (now?.outcome?.kind === 'you-are-behind' && now.pastedCode != null) {
        // Re-check what is still missing; anything left is "Asked; no answer."
        dispatch({
          type: SET_COMPARE,
          payload: {
            ...now,
            outcome: { kind: 'withheld', missing: [...now.outcome.missing] },
          },
        });
        void dispatch(comparePasted(now.pastedCode, { autoAsk: false }));
      }
    }, getCompareTimeoutMs());
    // Not awaited: the compare screen (and the CI hook) return at once.
    drop(
      (async () => {
        try {
          await requestMissing(
            compare.conversationId,
            missing.map(zrdtFromHex),
            compare.theirOwner
          );
        } catch (error) {
          log.warn(
            'askCompare: requestMissing failed',
            Errors.toLogFormat(error)
          );
        }
      })()
    );
  };
}

/** T2 gave up on some digests: an open compare that asked for them says so. */
function onResendStillMissing(
  conversationId: string,
  digests: ReadonlyArray<string>
): ZrdtThunk {
  return (dispatch, getState) => {
    const compare = getState().zrdt.compare;
    const outcome = compare?.outcome;
    if (
      compare?.conversationId !== conversationId ||
      outcome?.kind !== 'you-are-behind'
    ) {
      return;
    }
    const given = new Set(digests.map(d => d.toLowerCase()));
    if (!outcome.missing.some(d => given.has(d))) {
      return;
    }
    clearCompareTimer();
    dispatch({
      type: SET_COMPARE,
      payload: {
        ...compare,
        outcome: { kind: 'withheld', missing: [...outcome.missing] },
      },
    });
  };
}

/** Called on every 'accepted' event: an open compare re-checks its outcome. */
function onAccepted(conversationId: string): ZrdtThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const compare = getState().zrdt.compare;
    if (
      compare?.conversationId === conversationId &&
      compare.pastedCode != null &&
      compare.outcome != null &&
      compare.outcome.kind !== 'invalid-code'
    ) {
      await dispatch(comparePasted(compare.pastedCode, { autoAsk: false }));
    }
  };
}

export const actions = {
  setBackend,
  patchConversation,
  setInternalResult,
  refreshConversation,
  dismissOwnNameAlarm,
  markRejected,
  keepWhatVerifies,
  restartBackend,
  dismissSalvageReport,
  exportConversation,
  importConversation,
  salvageFile,
  openCompare,
  closeCompare,
  comparePasted,
  askCompare,
  onAccepted,
  onResendStillMissing,
};

export const useZrdtActions = (): BoundActionCreatorsMapObject<
  typeof actions
> => useBoundActions(actions);

// --- Reducer --------------------------------------------------------------------

export function reducer(
  state: Readonly<ZrdtStateType> = getEmptyState(),
  action: Readonly<ZrdtActionType>
): ZrdtStateType {
  switch (action.type) {
    case SET_BACKEND:
      return {
        ...state,
        backend: action.payload.info,
        unavailableDetail: action.payload.detail,
      };
    case PATCH_CONVERSATION: {
      const { conversationId, patch, clear } = action.payload;
      const merged = {
        ...(state.byConversation[conversationId] ??
          getEmptyConversationState()),
        ...patch,
      };
      const next = clear?.length ? lodash.omit(merged, [...clear]) : merged;
      return {
        ...state,
        byConversation: { ...state.byConversation, [conversationId]: next },
      };
    }
    case SET_COMPARE:
      return { ...state, compare: action.payload };
    case SET_INTERNAL_RESULT:
      return { ...state, internalResult: action.payload };
    default:
      return state;
  }
}

// --- Wiring ---------------------------------------------------------------------

/** Runs a zrdt thunk against a store (the thunk middleware is installed). */
export function runZrdtThunk<R>(
  thunk: ZrdtThunk<R>,
  store: Store<RootStateType> = window.reduxStore
): R {
  return thunk(
    store.dispatch as ThunkDispatch<RootStateType, unknown, ZrdtActionType>,
    store.getState,
    undefined
  );
}

let wired = false;

/**
 * Subscribes the slice to zrdtEvents and to conversation selection. Called
 * once from initializeRedux. Events: 'backend' (info), 'accepted'
 * (conversationId, hexDigest), 'classify' (conversationId); 'rejected'
 * (conversationId, ZrdtOpenOutcome) is optional (startup OPEN failure).
 */
export function initZrdtRedux(store: Store<RootStateType>): void {
  if (wired) {
    return;
  }
  wired = true;
  const { getState } = store;
  const dispatch = <R>(action: ZrdtActionType | ZrdtThunk<R>): unknown =>
    typeof action === 'function'
      ? runZrdtThunk(action, store)
      : store.dispatch(action);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleRefresh = (conversationId: string) => {
    const existing = timers.get(conversationId);
    if (existing != null) {
      clearTimeout(existing);
    }
    timers.set(
      conversationId,
      setTimeout(() => {
        timers.delete(conversationId);
        void dispatch(refreshConversation(conversationId));
      }, 100)
    );
  };

  const readBackend = () => {
    try {
      dispatch(setBackend(zrdtService.backendInfo()));
    } catch (error) {
      log.warn('backendInfo failed', Errors.toLogFormat(error));
    }
  };
  readBackend();

  zrdtEvents.on('backend', (info?: ZrdtBackendInfoType, detail?: unknown) => {
    if (info != null && typeof info === 'object' && 'kind' in info) {
      dispatch(
        setBackend(info, typeof detail === 'string' ? detail : undefined)
      );
    } else {
      readBackend();
    }
  });
  zrdtEvents.on('accepted', (conversationId: unknown) => {
    if (typeof conversationId !== 'string') {
      return;
    }
    scheduleRefresh(conversationId);
    void dispatch(onAccepted(conversationId));
  });
  zrdtEvents.on('classify', (conversationId: unknown) => {
    if (typeof conversationId === 'string') {
      scheduleRefresh(conversationId);
    }
  });
  // T2's resend scheduler: (conversationId, hexDigests, 'requested' |
  // 'still-missing'). "still-missing" is the compare screen's "Asked; no
  // answer." without waiting for our own timeout.
  zrdtEvents.on(
    'resendState',
    (conversationId: unknown, digests: unknown, state: unknown) => {
      if (
        typeof conversationId === 'string' &&
        Array.isArray(digests) &&
        state === 'still-missing'
      ) {
        dispatch(onResendStillMissing(conversationId, digests.map(String)));
      }
    }
  );
  zrdtEvents.on(
    'rejected',
    (conversationId: unknown, outcome?: ZrdtOpenOutcome) => {
      if (typeof conversationId === 'string' && outcome != null) {
        dispatch(markRejected(conversationId, outcome, 'startup'));
      }
    }
  );

  let lastSelected: string | undefined;
  store.subscribe(() => {
    const selected = getSelectedConversationId(getState());
    if (selected === lastSelected) {
      return;
    }
    lastSelected = selected;
    const conversation =
      selected != null
        ? getState().conversations.conversationLookup[selected]
        : undefined;
    if (selected != null && conversation?.type === 'group') {
      scheduleRefresh(selected);
    }
  });
}
