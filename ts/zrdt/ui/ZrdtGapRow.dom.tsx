// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import type { ZrdtGapState } from './labels.std.ts';
import type { ZrdtDigestHex } from './words.std.ts';
import {
  ASK_AGAIN,
  contentUnavailableText,
  gapStatus,
  gapTitle,
} from './labels.std.ts';
import { formatTagList } from './words.std.ts';

export type ZrdtGapRowProps = Readonly<{
  state: ZrdtGapState;
  /** How many digests this row stands for (the MISSING list). */
  count: number;
  /** Display name of the member whose message linked the missing one(s). */
  replierName: string;
  /** Display name of the author, once a structure-only relay names it. */
  authorName?: string;
  /** Missing digests, shown as tags; optional. */
  digests?: ReadonlyArray<ZrdtDigestHex>;
  onAskAgain?: () => void;
}>;

const ROOT_CLASS_NAMES: Record<ZrdtGapState, string> = {
  waiting: 'ZrdtGapRow ZrdtGapRow--waiting',
  requested: 'ZrdtGapRow ZrdtGapRow--requested',
  'still-missing': 'ZrdtGapRow ZrdtGapRow--still-missing',
  'content-unavailable': 'ZrdtGapRow ZrdtGapRow--content-unavailable',
};

/**
 * The timeline row for a zrdt-gap message (APP.md §5 step 3, §7). It never
 * says the server or a member is at fault.
 */
export function ZrdtGapRow(props: ZrdtGapRowProps): ReactElement {
  const { state, count, replierName, authorName, digests, onAskAgain } = props;
  const tags =
    digests != null && digests.length > 0 ? formatTagList(digests) : undefined;

  if (state === 'content-unavailable') {
    return (
      <div className={ROOT_CLASS_NAMES[state]} role="status">
        <span className="ZrdtGapRow__title">
          {contentUnavailableText(authorName ?? 'a member')}
        </span>
        {tags != null && <span className="ZrdtGapRow__tags">{tags}</span>}
      </div>
    );
  }

  const status = gapStatus(state);
  const showSpinner = state === 'waiting' || state === 'requested';
  return (
    <div className={ROOT_CLASS_NAMES[state]} role="status">
      {showSpinner && <span className="ZrdtSpinner" aria-hidden="true" />}
      <span className="ZrdtGapRow__title">{gapTitle(count, replierName)}</span>
      {tags != null && <span className="ZrdtGapRow__tags">{tags}</span>}
      {status != null && <span className="ZrdtGapRow__status">{status}</span>}
      {state === 'still-missing' && onAskAgain != null && (
        <button type="button" className="ZrdtButton" onClick={onAskAgain}>
          {ASK_AGAIN}
        </button>
      )}
    </div>
  );
}
