// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// zrdt storage (APP.md §6, AMENDMENTS A7). Structure only: no plaintext is
// ever written to these tables.

import type { ReadableDB, WritableDB } from '../Interface.std.ts';
import { sql, sqlFragment } from '../util.std.ts';
import type {
  UpsertZrdtProvenanceOptionsType,
  ZrdtPendingRowType,
  ZrdtProvenanceRowType,
  ZrdtRecordRowType,
} from '../../types/Zrdt.std.ts';

// --- zrdt_records ---------------------------------------------------------------

// Append-only and idempotent: a row that is already present (same
// conversationId and digest) is left unchanged. Returns the number of new rows.
export function insertZrdtRecords(
  db: WritableDB,
  rows: ReadonlyArray<ZrdtRecordRowType>
): number {
  return db.transaction(() => {
    let inserted = 0;
    for (const { conversationId, digest, record } of rows) {
      const [query, params] = sql`
        INSERT INTO zrdt_records (conversationId, digest, record)
        VALUES (${conversationId}, ${digest}, ${record})
        ON CONFLICT (conversationId, digest) DO NOTHING;
      `;
      inserted += db.prepare(query).run(params).changes;
    }
    return inserted;
  })();
}

export function insertZrdtRecord(
  db: WritableDB,
  row: ZrdtRecordRowType
): boolean {
  return insertZrdtRecords(db, [row]) === 1;
}

// In insertion (accept) order, which is a valid order for OPEN.
export function getZrdtRecords(
  db: ReadableDB,
  conversationId: string
): Array<ZrdtRecordRowType> {
  const [query, params] = sql`
    SELECT conversationId, digest, record
    FROM zrdt_records
    WHERE conversationId = ${conversationId}
    ORDER BY rowid ASC;
  `;
  return db.prepare(query).all<ZrdtRecordRowType>(params);
}

// Only for the rewrite after SALVAGE (APP.md §6): drop the rows of the dropped
// digests, in one transaction. Returns the number of rows deleted.
export function deleteZrdtRecords(
  db: WritableDB,
  conversationId: string,
  digests: ReadonlyArray<Uint8Array<ArrayBuffer>>
): number {
  return db.transaction(() => {
    let deleted = 0;
    for (const digest of digests) {
      const [query, params] = sql`
        DELETE FROM zrdt_records
        WHERE conversationId = ${conversationId} AND digest = ${digest};
      `;
      deleted += db.prepare(query).run(params).changes;
    }
    return deleted;
  })();
}

// Conversations that have any zrdt state (for the startup re-OPEN).
export function getZrdtConversationIds(db: ReadableDB): Array<string> {
  const [query, params] = sql`
    SELECT DISTINCT conversationId FROM zrdt_records
    UNION
    SELECT DISTINCT conversationId FROM zrdt_pending;
  `;
  return db.prepare(query, { pluck: true }).all<string>(params);
}

// --- zrdt_pending ---------------------------------------------------------------

// Upsert keyed by (conversationId, digest). A later call with a messageId fills
// in a row that was stored without one; a null messageId never clears it.
export function insertZrdtPending(
  db: WritableDB,
  row: ZrdtPendingRowType
): void {
  const { conversationId, digest, record, messageId } = row;
  const [query, params] = sql`
    INSERT INTO zrdt_pending (conversationId, digest, record, messageId)
    VALUES (${conversationId}, ${digest}, ${record}, ${messageId})
    ON CONFLICT (conversationId, digest) DO UPDATE SET
      messageId = COALESCE(excluded.messageId, zrdt_pending.messageId);
  `;
  db.prepare(query).run(params);
}

export function getZrdtPending(
  db: ReadableDB,
  conversationId: string
): Array<ZrdtPendingRowType> {
  const [query, params] = sql`
    SELECT conversationId, digest, record, messageId
    FROM zrdt_pending
    WHERE conversationId = ${conversationId}
    ORDER BY rowid ASC;
  `;
  return db.prepare(query).all<ZrdtPendingRowType>(params);
}

export function deleteZrdtPending(
  db: WritableDB,
  conversationId: string,
  digests: ReadonlyArray<Uint8Array<ArrayBuffer>>
): number {
  return db.transaction(() => {
    let deleted = 0;
    for (const digest of digests) {
      const [query, params] = sql`
        DELETE FROM zrdt_pending
        WHERE conversationId = ${conversationId} AND digest = ${digest};
      `;
      deleted += db.prepare(query).run(params).changes;
    }
    return deleted;
  })();
}

// --- zrdt_provenance ------------------------------------------------------------

// imported < relayed < live
const NEW_RANK = sqlFragment`
  CASE excluded.kind WHEN 'live' THEN 3 WHEN 'relayed' THEN 2 ELSE 1 END
`;
const OLD_RANK = sqlFragment`
  CASE zrdt_provenance.kind WHEN 'live' THEN 3 WHEN 'relayed' THEN 2 ELSE 1 END
`;

// disownedBy is never cleared: a null in `rows` keeps the stored value.
export function upsertZrdtProvenance(
  db: WritableDB,
  rows: ReadonlyArray<ZrdtProvenanceRowType>,
  { mode = 'upgrade' }: UpsertZrdtProvenanceOptionsType = {}
): void {
  const takeNew =
    mode === 'replace'
      ? sqlFragment`1`
      : sqlFragment`(${NEW_RANK}) > (${OLD_RANK})`;

  db.transaction(() => {
    for (const row of rows) {
      const { conversationId, digest, kind, byAci, disownedBy } = row;
      const [query, params] = sql`
        INSERT INTO zrdt_provenance
          (conversationId, digest, kind, byAci, disownedBy)
        VALUES
          (${conversationId}, ${digest}, ${kind}, ${byAci}, ${disownedBy})
        ON CONFLICT (conversationId, digest) DO UPDATE SET
          kind = CASE WHEN ${takeNew}
            THEN excluded.kind ELSE zrdt_provenance.kind END,
          byAci = CASE WHEN ${takeNew}
            THEN excluded.byAci ELSE zrdt_provenance.byAci END,
          disownedBy = COALESCE(excluded.disownedBy, zrdt_provenance.disownedBy);
      `;
      db.prepare(query).run(params);
    }
  })();
}

// Records the author's disown on rows that already exist. A digest we do not
// hold yet is skipped: every later live message from the author carries the
// full disown set again (APP.md §5 step 12). Precondition, checked by the
// caller: the disowning message is live and `disownedBy` is the record's
// author. Returns the number of rows updated.
export function markZrdtDisowned(
  db: WritableDB,
  conversationId: string,
  digests: ReadonlyArray<Uint8Array<ArrayBuffer>>,
  disownedBy: string
): number {
  return db.transaction(() => {
    let updated = 0;
    for (const digest of digests) {
      const [query, params] = sql`
        UPDATE zrdt_provenance
        SET disownedBy = ${disownedBy}
        WHERE conversationId = ${conversationId} AND digest = ${digest};
      `;
      updated += db.prepare(query).run(params).changes;
    }
    return updated;
  })();
}

export function getZrdtProvenance(
  db: ReadableDB,
  conversationId: string
): Array<ZrdtProvenanceRowType> {
  const [query, params] = sql`
    SELECT conversationId, digest, kind, byAci, disownedBy
    FROM zrdt_provenance
    WHERE conversationId = ${conversationId}
    ORDER BY rowid ASC;
  `;
  return db.prepare(query).all<ZrdtProvenanceRowType>(params);
}

// --- messages lookups -----------------------------------------------------------

// digest (hex, as in `message.zrdtDigest`) -> message ids. Uses the
// messages_zrdtDigest expression index. More than one id per digest is possible
// (a relayed copy and a later live copy before they are merged).
export function getMessageIdsByZrdtDigest(
  db: ReadableDB,
  conversationId: string,
  digests: ReadonlyArray<string>
): Array<{ digest: string; messageId: string }> {
  const result: Array<{ digest: string; messageId: string }> = [];
  for (const digest of digests) {
    const [query, params] = sql`
      SELECT id FROM messages
      WHERE conversationId = ${conversationId}
        AND json_extract(json, '$.zrdtDigest') = ${digest};
    `;
    for (const messageId of db
      .prepare(query, { pluck: true })
      .all<string>(params)) {
      result.push({ digest, messageId });
    }
  }
  return result;
}

// Ids of the `zrdt-gap` rows of one conversation, oldest first.
export function getZrdtGapMessageIds(
  db: ReadableDB,
  conversationId: string
): Array<string> {
  const [query, params] = sql`
    SELECT id FROM messages
    WHERE conversationId = ${conversationId} AND type IS 'zrdt-gap'
    ORDER BY received_at ASC, sent_at ASC;
  `;
  return db.prepare(query, { pluck: true }).all<string>(params);
}

// --- cleanup --------------------------------------------------------------------

// Called when the conversation itself is removed (`_removeConversation`).
// Not called by "Delete chat" (destroyMessages): the structure stays, like the
// structure of expired messages (APP.md §7, "Say plainly").
export function deleteZrdtForConversation(
  db: WritableDB,
  conversationId: string
): void {
  db.transaction(() => {
    for (const table of [
      sqlFragment`zrdt_records`,
      sqlFragment`zrdt_pending`,
      sqlFragment`zrdt_provenance`,
    ]) {
      const [query, params] = sql`
        DELETE FROM ${table} WHERE conversationId = ${conversationId};
      `;
      db.prepare(query).run(params);
    }
  })();
}
