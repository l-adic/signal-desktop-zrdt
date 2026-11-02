// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Bytes } from '../../../../zrdt/apps/bt/manager.std.ts';

/** A writer in memory, for tests that do not touch the disk. */
export class MemoryWriter {
  readonly files = new Map<string, Bytes>();
  readonly discarded: Array<string> = [];
  /** readBack returns these bytes instead, once (a disk that lies). */
  lie: Bytes | undefined;

  readonly write = async (
    name: string,
    bytes: Bytes
  ): Promise<{ file: string }> => {
    let n = 1;
    while (this.files.has(`/downloads/${n}/${name}`)) {
      n += 1;
    }
    const file = `/downloads/${n}/${name}`;
    this.files.set(file, bytes.slice());
    return { file };
  };

  readonly readBack = async (file: string): Promise<Bytes> => {
    if (this.lie !== undefined) {
      const lie = this.lie;
      this.lie = undefined;
      return lie;
    }
    const bytes = this.files.get(file);
    if (bytes === undefined) {
      throw new Error(`ENOENT ${file}`);
    }
    return bytes.slice();
  };

  readonly discard = async (file: string): Promise<void> => {
    this.files.delete(file);
    this.discarded.push(file);
  };
}
