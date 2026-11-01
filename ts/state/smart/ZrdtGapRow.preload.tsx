// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, type JSX } from 'react';
import { createLogger } from '../../logging/log.std.ts';
import * as Errors from '../../types/errors.std.ts';
import type { ZrdtGapItemDataType } from '../../components/conversation/TimelineItem.dom.tsx';
import { ZrdtGapRow } from '../../zrdt/ui/ZrdtGapRow.dom.tsx';
import { requestMissing } from '../../zrdt/resend.preload.ts';
import { zrdtFromHex } from '../ducks/zrdt.preload.ts';
import { drop } from '../../util/drop.std.ts';

const log = createLogger('SmartZrdtGapRow');

/** A `zrdt-gap` timeline row; "Ask again" goes to the resend module (T2). */
const SmartZrdtGapRow = memo(function SmartZrdtGapRow(
  props: ZrdtGapItemDataType
): JSX.Element {
  const {
    conversationId,
    state,
    missingDigests,
    replierName,
    referencedByAci,
    authorName,
  } = props;
  const onAskAgain = useCallback(async () => {
    try {
      await requestMissing(
        conversationId,
        missingDigests.map(zrdtFromHex),
        referencedByAci
      );
    } catch (error) {
      log.warn('requestMissing failed', Errors.toLogFormat(error));
    }
  }, [conversationId, missingDigests, referencedByAci]);
  return (
    <div
      className="ZrdtGapRow__container"
      data-zrdt-gap-state={state}
      data-zrdt-missing={missingDigests.join(',')}
    >
      <ZrdtGapRow
        state={state}
        count={Math.max(1, missingDigests.length)}
        replierName={replierName}
        authorName={authorName}
        digests={missingDigests}
        onAskAgain={() => drop(onAskAgain())}
      />
    </div>
  );
});

export function renderZrdtGap(data: ZrdtGapItemDataType): JSX.Element {
  return <SmartZrdtGapRow {...data} />;
}
