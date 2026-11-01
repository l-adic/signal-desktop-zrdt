// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The one call groups.preload.ts makes into zrdt after a group update
// (JOIN_PLAN §6.1, §6.5). resend.preload.ts sets it when it loads, so
// groups.preload.ts does not import the zrdt modules.

import type { ConversationModel } from '../models/conversations.preload.ts';

export type ZrdtGroupUpdateType = Readonly<{
  conversation: ConversationModel;
  // The member ACIs before the update.
  previousMemberAcis: ReadonlyArray<string>;
  // Whether we were a member before the update.
  wasMember: boolean;
  // The update came with a group change in a Signal message (from the member
  // who made it), not only from the server's log.
  viaSignalMessage: boolean;
}>;

let hook: ((update: ZrdtGroupUpdateType) => Promise<void>) | undefined;

export function setZrdtGroupUpdateHook(
  fn: (update: ZrdtGroupUpdateType) => Promise<void>
): void {
  hook = fn;
}

export async function runZrdtGroupUpdateHook(
  update: ZrdtGroupUpdateType
): Promise<void> {
  await hook?.(update);
}
