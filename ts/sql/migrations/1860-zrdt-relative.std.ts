// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { WritableDB } from '../Interface.std.ts';
import { sql } from '../util.std.ts';

// zrdt relative stores (zrdt docs/JOIN_PLAN.md §6.2): a store created by a
// catch-up holds a boundary, digests with no record, each vouched for by the
// member whose SERVE reply carried it. Structure only, like the other zrdt
// tables.
export default function updateToSchemaVersion1860(db: WritableDB): void {
  const [query] = sql`
    -- One row per conversation whose store is relative. A conversation with
    -- no row has a closed store (a genesis member's).
    CREATE TABLE zrdt_stores (
      conversationId TEXT NOT NULL PRIMARY KEY,
      mode TEXT NOT NULL
    ) STRICT;

    -- The boundary digests of a relative store, with the ACI that vouched
    -- for each (the first voucher stays). Append-only: the boundary only
    -- grows, and a promoted digest stays.
    CREATE TABLE zrdt_boundary (
      conversationId TEXT NOT NULL,
      digest BLOB NOT NULL,
      voucherAci TEXT NOT NULL,
      PRIMARY KEY (conversationId, digest)
    ) STRICT;
  `;

  db.exec(query);
}
