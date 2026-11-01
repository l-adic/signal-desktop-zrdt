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
import { bytesToUuid } from '../../util/uuidToBytes.std.ts';
import { DataReader } from '../../sql/Client.preload.ts';
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
import { zrdtEvents, zrdtService } from '../../zrdt/service.preload.ts';
import { requestMissing } from '../../zrdt/resend.preload.ts';
import type { ZrdtRejectReason } from '../../zrdt/ui/labels.std.ts';
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

// Import blobs that failed MERGE, kept for "Keep what verifies". Not in
// Redux: bytes do not belong in the store.
const failedImportBlobs = new Map<string, Uint8Array<ArrayBuffer>>();

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

export function getEmptyConversationState(): ZrdtConversationStateType {
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
      unconfirmed.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
      dispatch(
        patchConversation(conversationId, {
          statuses,
          disown: disown.map(zrdtHex).sort(),
          unconfirmed,
        })
      );
    } catch (error) {
      log.warn(
        `refreshConversation(${conversationId}) failed`,
        Errors.toLogFormat(error)
      );
    }
  };
}

// Records are immutable, so a digest's author never changes.
const authorByDigest = new Map<string, string>();

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
    const blob = failedImportBlobs.get(conversationId);
    if (blob == null) {
      // TODO(zrdt T0): startup rejection (OPEN of the SQL rows failed) needs a
      // service op that salvages the stored rows; the contract has none yet.
      dispatch(
        setInternalResult(
          'Keep what verifies: no failed import to salvage (startup salvage is not wired yet)'
        )
      );
      return;
    }
    dispatch(patchConversation(conversationId, { busy: true }));
    try {
      const result = await zrdtService.salvageBlob(conversationId, blob);
      if ('status' in result) {
        dispatch(markRejected(conversationId, result, 'import'));
        dispatch(patchConversation(conversationId, {}, ['busy']));
        return;
      }
      failedImportBlobs.delete(conversationId);
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
      await writeFile(target, blob);
      const count = zrdtBlobRecordCount(blob);
      dispatch(
        setInternalResult(
          `Exported ${count ?? '?'} records (${blob.byteLength} bytes) to ${target}`
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
      const blob = new Uint8Array(await readFile(source));
      const outcome = await zrdtService.importBlob(conversationId, blob);
      if (outcome.status === 'ok') {
        failedImportBlobs.delete(conversationId);
        dispatch(patchConversation(conversationId, {}, ['rejected']));
        dispatch(setInternalResult(`Import of ${source}: ok`));
        await dispatch(refreshConversation(conversationId));
      } else {
        failedImportBlobs.set(conversationId, blob);
        dispatch(markRejected(conversationId, outcome, 'import'));
        dispatch(
          setInternalResult(
            `Import of ${source}: ${outcome.status} (see the banner in the chat)`
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
        new Uint8Array(await readFile(source))
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
          ...compare,
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
    try {
      await requestMissing(
        compare.conversationId,
        missing.map(zrdtFromHex),
        compare.theirOwner
      );
    } catch (error) {
      log.warn('askCompare: requestMissing failed', Errors.toLogFormat(error));
    }
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
  dismissSalvageReport,
  exportConversation,
  importConversation,
  salvageFile,
  openCompare,
  closeCompare,
  comparePasted,
  askCompare,
  onAccepted,
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
