// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import type { ZrdtDigestHex } from './words.std.ts';
import { OWN_NAME_ALARM_TEXT } from './labels.std.ts';
import { formatTagList } from './words.std.ts';

export type ZrdtOwnNameAlarmProps = Readonly<{
  /** Records in our name that we did not create (our disown set). */
  digests: ReadonlyArray<ZrdtDigestHex>;
  onDismiss?: () => void;
}>;

/**
 * Conversation-level alarm (APP.md §5 step 12). The digests are already in
 * the disown set that every later message carries; dismissing only hides it.
 */
export function ZrdtOwnNameAlarm(
  props: ZrdtOwnNameAlarmProps
): ReactElement | null {
  const { digests, onDismiss } = props;
  if (digests.length === 0) {
    return null;
  }
  return (
    <div className="ZrdtBanner ZrdtBanner--error" role="alert">
      <span className="ZrdtBanner__text">{OWN_NAME_ALARM_TEXT}</span>
      <span className="ZrdtBanner__detail">{formatTagList(digests)}</span>
      {onDismiss != null && (
        <button type="button" className="ZrdtButton" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
