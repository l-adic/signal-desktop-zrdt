// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import type { ZrdtLabel } from './labels.std.ts';
import { labelText, labelTooltip } from './labels.std.ts';

export type ZrdtProvenanceLabelProps = Readonly<{
  /** From chooseProvenanceLabel; null renders nothing (a normal message). */
  label: ZrdtLabel | null | undefined;
}>;

const CLASS_NAMES: Record<ZrdtLabel['kind'], string> = {
  relayed: 'ZrdtLabel ZrdtLabel--relayed',
  confirmed: 'ZrdtLabel ZrdtLabel--confirmed',
  held: 'ZrdtLabel ZrdtLabel--held',
  unconfirmed: 'ZrdtLabel ZrdtLabel--unconfirmed',
  'not-confirmed': 'ZrdtLabel ZrdtLabel--not-confirmed',
};

/** "relayed by Bob", "confirmed by Alice", "held by Alice", "unconfirmed", "not confirmed by Bob". */
export function ZrdtProvenanceLabel(
  props: ZrdtProvenanceLabelProps
): ReactElement | null {
  const { label } = props;
  if (label == null) {
    return null;
  }
  return (
    <span className={CLASS_NAMES[label.kind]} title={labelTooltip(label)}>
      {labelText(label)}
    </span>
  );
}
