// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// PLACEHOLDER (lane T1). Lane T0 owns this module and implements it. This
// file only carries the shared contract so the T1 send path compiles before
// T0 lands. On merge, take T0's version of this file wholesale.
//
// Every method rejects: with this placeholder, in-scope group sends fail
// closed (APP.md §2 "Fail closed") instead of going out unlinked.

/* oxlint-disable signal-desktop/enforce-file-suffix -- placeholder; T0 replaces this file */

import { EventEmitter } from 'node:events';

type Bytes = Uint8Array<ArrayBuffer>;

export type ZrdtStatus =
  | { kind: 'confirmedByAuthor' }
  | { kind: 'heldBy'; aci: string }
  | { kind: 'unconfirmed' }
  | { kind: 'notConfirmedByAuthor' };
export type ZrdtProvenance =
  | { kind: 'live' }
  | { kind: 'relayed'; byAci: string }
  | { kind: 'imported' };
export type ZrdtAcceptOutcome =
  | { status: 'accepted'; digest: Bytes; record: Bytes; opening?: Bytes }
  | { status: 'missing'; digests: Array<Bytes> }
  | { status: 'collision'; digest: Bytes }
  | { status: 'wrongChat' }
  | { status: 'tooLarge' }
  | { status: 'malformed' }
  | { status: 'badOpening' };
export type ZrdtOpenOutcome =
  | { status: 'ok' }
  | {
      status: 'unverifiable';
      unverifiable: Array<Bytes>;
      missing: Array<Bytes>;
    }
  | { status: 'malformed' | 'tooLarge' | 'wrongChat' }
  | { status: 'collision'; digest: Bytes };

export type ZrdtServiceType = {
  init(): Promise<void>;
  backendInfo(): { kind: 'lean' | 'stub'; version: string; available: boolean };
  ensureConversation(conversationId: string, groupId: Bytes): Promise<void>;
  heads(conversationId: string): Promise<Array<Bytes>>;
  disownSet(conversationId: string): Promise<Array<Bytes>>;
  acceptOwn(
    conversationId: string,
    a: {
      groupId: Bytes;
      authorAci: Bytes;
      nonce: Bytes;
      dataMessageBytes: Bytes;
      links: Array<Bytes>;
    }
  ): Promise<{ digest: Bytes; record: Bytes; opening: Bytes }>;
  acceptIncoming(
    conversationId: string,
    a: {
      groupId: Bytes;
      authorAci: Bytes;
      nonce: Bytes;
      dataMessageBytes: Bytes;
      links: Array<Bytes>;
      provenance: ZrdtProvenance;
    }
  ): Promise<ZrdtAcceptOutcome>;
  acceptRecord(
    conversationId: string,
    a: { record: Bytes; opening?: Bytes; provenance: ZrdtProvenance }
  ): Promise<ZrdtAcceptOutcome>;
  has(conversationId: string, digest: Bytes): Promise<boolean>;
  get(
    conversationId: string,
    digest: Bytes
  ): Promise<
    | { record: Bytes; authorAci: Bytes; links: Array<Bytes>; commit: Bytes }
    | undefined
  >;
  reachSet(conversationId: string, from: Array<Bytes>): Promise<Array<Bytes>>;
  classify(conversationId: string): Promise<Map<string, ZrdtStatus>>;
  markDisowned(
    conversationId: string,
    digest: Bytes,
    byAci: string
  ): Promise<void>;
  exportBlob(conversationId: string): Promise<Bytes>;
  importBlob(conversationId: string, blob: Bytes): Promise<ZrdtOpenOutcome>;
  salvageBlob(
    conversationId: string,
    blob: Bytes
  ): Promise<
    { dropped: Array<Bytes>; missing: Array<Bytes> } | ZrdtOpenOutcome
  >;
};

function notImplemented(): Promise<never> {
  return Promise.reject(
    new Error('zrdtService: placeholder, lane T0 implements this module')
  );
}

export const zrdtService: ZrdtServiceType = {
  init: notImplemented,
  backendInfo: () => ({ kind: 'stub', version: 'none', available: false }),
  ensureConversation: notImplemented,
  heads: notImplemented,
  disownSet: notImplemented,
  acceptOwn: notImplemented,
  acceptIncoming: notImplemented,
  acceptRecord: notImplemented,
  has: notImplemented,
  get: notImplemented,
  reachSet: notImplemented,
  classify: notImplemented,
  markDisowned: notImplemented,
  exportBlob: notImplemented,
  importBlob: notImplemented,
  salvageBlob: notImplemented,
};

export const zrdtEvents = new EventEmitter();
