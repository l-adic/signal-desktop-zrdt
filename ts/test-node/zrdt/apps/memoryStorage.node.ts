// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// An in-memory stand-in for the zrdt SQL functions (as in
// ../service_test.node.ts), for the apps tests that run the real zrdt
// service on the protocol-5 stub.

import type {
  UpsertZrdtProvenanceOptionsType,
  ZrdtPendingRowType,
  ZrdtProvenanceRowType,
  ZrdtRecordRowType,
  ZrdtBoundaryRowType,
  ZrdtStoreModeType,
} from '../../../types/Zrdt.std.ts';
import { toHex } from '../../../zrdt/serviceCore.node.ts';
import type { ZrdtServiceStorage } from '../../../zrdt/serviceCore.node.ts';

type B = Uint8Array<ArrayBuffer>;

export class MemoryStorage implements ZrdtServiceStorage {
  records = new Array<ZrdtRecordRowType>();
  pending = new Array<ZrdtPendingRowType>();
  provenance = new Array<ZrdtProvenanceRowType>();
  modes = new Map<string, ZrdtStoreModeType>();
  boundary = new Array<ZrdtBoundaryRowType>();
  // The openings the host holds (message rows), for the re-OPEN.
  held = new Array<{ digest: B; opening: B }>();

  async getZrdtConversationIds(): Promise<Array<string>> {
    return [
      ...new Set([
        ...this.records.map(r => r.conversationId),
        ...this.pending.map(r => r.conversationId),
        ...this.modes.keys(),
        ...this.boundary.map(r => r.conversationId),
      ]),
    ];
  }

  async getZrdtStoreMode(id: string): Promise<ZrdtStoreModeType> {
    return this.modes.get(id) ?? 'closed';
  }

  async setZrdtStoreMode(id: string, mode: ZrdtStoreModeType): Promise<void> {
    if (mode === 'closed') {
      this.modes.delete(id);
    } else {
      this.modes.set(id, mode);
    }
  }

  async getZrdtBoundary(id: string): Promise<Array<ZrdtBoundaryRowType>> {
    return this.boundary.filter(r => r.conversationId === id);
  }

  async insertZrdtBoundary(
    rows: ReadonlyArray<ZrdtBoundaryRowType>
  ): Promise<number> {
    let n = 0;
    for (const row of rows) {
      if (
        !this.boundary.some(
          r =>
            r.conversationId === row.conversationId &&
            toHex(r.digest) === toHex(row.digest)
        )
      ) {
        this.boundary.push(row);
        n += 1;
      }
    }
    return n;
  }

  async archiveZrdtConversation(id: string, archiveId: string): Promise<void> {
    const move = <T extends { conversationId: string }>(rows: Array<T>) =>
      rows.map(r =>
        r.conversationId === id ? { ...r, conversationId: archiveId } : r
      );
    this.records = move(this.records);
    this.pending = move(this.pending);
    this.provenance = move(this.provenance);
    this.boundary = move(this.boundary);
    const mode = this.modes.get(id);
    if (mode !== undefined) {
      this.modes.delete(id);
      this.modes.set(archiveId, mode);
    }
  }

  async getZrdtRecords(id: string): Promise<Array<ZrdtRecordRowType>> {
    return this.records.filter(r => r.conversationId === id);
  }

  async insertZrdtRecords(
    rows: ReadonlyArray<ZrdtRecordRowType>
  ): Promise<number> {
    let n = 0;
    for (const row of rows) {
      if (
        !this.records.some(
          r =>
            r.conversationId === row.conversationId &&
            toHex(r.digest) === toHex(row.digest)
        )
      ) {
        this.records.push(row);
        n += 1;
      }
    }
    return n;
  }

  async deleteZrdtRecords(
    id: string,
    digests: ReadonlyArray<B>
  ): Promise<number> {
    const drop = new Set(digests.map(toHex));
    const before = this.records.length;
    this.records = this.records.filter(
      r => !(r.conversationId === id && drop.has(toHex(r.digest)))
    );
    return before - this.records.length;
  }

  async getZrdtPending(id: string): Promise<Array<ZrdtPendingRowType>> {
    return this.pending.filter(r => r.conversationId === id);
  }

  async insertZrdtPending(row: ZrdtPendingRowType): Promise<void> {
    if (
      !this.pending.some(
        r =>
          r.conversationId === row.conversationId &&
          toHex(r.digest) === toHex(row.digest)
      )
    ) {
      this.pending.push(row);
    }
  }

  async deleteZrdtPending(
    id: string,
    digests: ReadonlyArray<B>
  ): Promise<number> {
    const drop = new Set(digests.map(toHex));
    const before = this.pending.length;
    this.pending = this.pending.filter(
      r => !(r.conversationId === id && drop.has(toHex(r.digest)))
    );
    return before - this.pending.length;
  }

  async getZrdtProvenance(id: string): Promise<Array<ZrdtProvenanceRowType>> {
    return this.provenance.filter(r => r.conversationId === id);
  }

  async upsertZrdtProvenance(
    rows: ReadonlyArray<ZrdtProvenanceRowType>,
    { mode = 'upgrade' }: UpsertZrdtProvenanceOptionsType = {}
  ): Promise<void> {
    const rank = { imported: 1, relayed: 2, live: 3 };
    for (const row of rows) {
      const i = this.provenance.findIndex(
        r =>
          r.conversationId === row.conversationId &&
          toHex(r.digest) === toHex(row.digest)
      );
      const old = this.provenance[i];
      if (old === undefined) {
        this.provenance.push(row);
        continue;
      }
      const take = mode === 'replace' || rank[row.kind] > rank[old.kind];
      this.provenance[i] = {
        ...old,
        kind: take ? row.kind : old.kind,
        byAci: take ? row.byAci : old.byAci,
        disownedBy: row.disownedBy ?? old.disownedBy,
      };
    }
  }

  async markZrdtDisowned(
    id: string,
    digests: ReadonlyArray<B>,
    by: string
  ): Promise<number> {
    const set = new Set(digests.map(toHex));
    let n = 0;
    this.provenance = this.provenance.map(r => {
      if (r.conversationId === id && set.has(toHex(r.digest))) {
        n += 1;
        return { ...r, disownedBy: by as ZrdtProvenanceRowType['disownedBy'] };
      }
      return r;
    });
    return n;
  }
}
