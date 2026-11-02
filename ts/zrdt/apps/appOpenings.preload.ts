// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// This desktop's app openings (./openings.node.ts), in userData. Used by the
// zrdt service (heldOpenings for channel keys) and the app transport.

import { join } from 'node:path';

import { FileOpeningStore } from './openings.node.ts';

let store: FileOpeningStore | undefined;

export function appOpenings(): FileOpeningStore {
  store ??= new FileOpeningStore(
    join(
      window.SignalContext.getPath('userData'),
      'zrdt-apps',
      'openings.jsonl'
    )
  );
  return store;
}
