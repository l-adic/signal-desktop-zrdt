// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

/* oxlint-disable */
// PLACEHOLDER (lane T2): the shared service contract with the types of lane
// T0's implementation (ts/zrdt/serviceCore.node.ts on zrdt-t0), so the
// receive path compiles before T0 lands. T0 owns this file; on merge take
// T0's version. Every method throws until then.

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
  | {
      status: 'missing';
      digests: Array<Bytes>;
      // T0 extras: the record now in zrdt_pending, its digest, the opening
      digest?: Bytes;
      record?: Bytes;
      opening?: Bytes;
    }
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

export type ZrdtBackendInfo = {
  kind: 'lean' | 'stub';
  version: string;
  available: boolean;
};

type ZrdtAcceptOwnArgs = {
  groupId: Uint8Array<ArrayBuffer>;
  authorAci: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  dataMessageBytes: Uint8Array<ArrayBuffer>;
  links: Array<Uint8Array<ArrayBuffer>>;
};

export type ZrdtServiceType = {
  init(): Promise<void>;
  backendInfo(): ZrdtBackendInfo;
  ensureConversation(
    conversationId: string,
    groupId: Uint8Array<ArrayBuffer>
  ): Promise<void>;
  heads(conversationId: string): Promise<Array<Bytes>>;
  disownSet(conversationId: string): Promise<Array<Bytes>>;
  acceptOwn(
    conversationId: string,
    a: ZrdtAcceptOwnArgs
  ): Promise<{ digest: Bytes; record: Bytes; opening: Bytes }>;
  acceptIncoming(
    conversationId: string,
    a: ZrdtAcceptOwnArgs & { provenance: ZrdtProvenance }
  ): Promise<ZrdtAcceptOutcome>;
  acceptRecord(
    conversationId: string,
    a: {
      record: Uint8Array<ArrayBuffer>;
      opening?: Uint8Array<ArrayBuffer>;
      provenance: ZrdtProvenance;
    }
  ): Promise<ZrdtAcceptOutcome>;
  has(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<boolean>;
  get(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<
    | { record: Bytes; authorAci: Bytes; links: Array<Bytes>; commit: Bytes }
    | undefined
  >;
  reachSet(
    conversationId: string,
    from: Array<Uint8Array<ArrayBuffer>>
  ): Promise<Array<Bytes>>;
  classify(conversationId: string): Promise<Map<string, ZrdtStatus>>;
  markDisowned(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>,
    byAci: string
  ): Promise<void>;
  exportBlob(conversationId: string): Promise<Bytes>;
  importBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtOpenOutcome>;
  salvageBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<
    { dropped: Array<Bytes>; missing: Array<Bytes> } | ZrdtOpenOutcome
  >;
};

function notYet(): never {
  throw new Error('zrdt service: placeholder (lane T0 not merged)');
}

export const zrdtService: ZrdtServiceType = {
  init: async () => notYet(),
  backendInfo: () => ({
    kind: 'stub',
    version: 'placeholder',
    available: false,
  }),
  ensureConversation: async () => notYet(),
  heads: async () => notYet(),
  disownSet: async () => notYet(),
  acceptOwn: async () => notYet(),
  acceptIncoming: async () => notYet(),
  acceptRecord: async () => notYet(),
  has: async () => notYet(),
  get: async () => notYet(),
  reachSet: async () => notYet(),
  classify: async () => notYet(),
  markDisowned: async () => notYet(),
  exportBlob: async () => notYet(),
  importBlob: async () => notYet(),
  salvageBlob: async () => notYet(),
};

// 'backend' (info), 'accepted' (conversationId, hexDigest), 'classify'
// (conversationId); T0 also emits 'rejected'.
export const zrdtEvents: EventEmitter = new EventEmitter();
