// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { WritableDB } from '../Interface.std.ts';
import { sql } from '../util.std.ts';

// zrdt (APP.md §6, AMENDMENTS A7): structure-only storage for the
// transcript-consistency layer. Plaintext never goes here; the opening lives in
// the erasable `zrdtOpening` message attribute.
export default function updateToSchemaVersion1850(db: WritableDB): void {
  const [query] = sql`
    -- Append-only (apart from the rewrite after SALVAGE): one row per ACCEPTED.
    -- The composite primary key also serves "all rows of one conversation".
    CREATE TABLE zrdt_records (
      conversationId TEXT NOT NULL,
      digest BLOB NOT NULL,
      record BLOB NOT NULL,
      PRIMARY KEY (conversationId, digest)
    ) STRICT;

    -- The pending buffer: records whose links did not resolve yet. Must be
    -- persisted, otherwise a message already in the DB has no record.
    CREATE TABLE zrdt_pending (
      conversationId TEXT NOT NULL,
      digest BLOB NOT NULL,
      record BLOB NOT NULL,
      messageId TEXT,
      PRIMARY KEY (conversationId, digest)
    ) STRICT;

    -- Host state per record: live | relayed(byAci) | imported, plus the
    -- author's disown.
    CREATE TABLE zrdt_provenance (
      conversationId TEXT NOT NULL,
      digest BLOB NOT NULL,
      kind TEXT NOT NULL,
      byAci TEXT,
      disownedBy TEXT,
      PRIMARY KEY (conversationId, digest)
    ) STRICT;

    -- digest -> message row (answering ZrdtResendRequest, live-copy upgrade).
    -- An expression index, so no new column on messages.
    CREATE INDEX messages_zrdtDigest
      ON messages (conversationId, json_extract(json, '$.zrdtDigest'))
      WHERE json_extract(json, '$.zrdtDigest') IS NOT NULL;

    -- Open gap rows of one conversation.
    CREATE INDEX messages_zrdtGap
      ON messages (conversationId)
      WHERE type IS 'zrdt-gap';
  `;

  db.exec(query);
}
