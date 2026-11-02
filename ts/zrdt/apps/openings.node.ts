// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// App openings, kept for good (zrdt docs/apps/BUILD_M1.md §H: "keep app
// openings for good"; docs/zrdt/FORK_MAP.md §5, O4). Chat openings live on
// message rows; app records have no message row, so their openings go to an
// append-only file, `<userData>/zrdt-apps/openings.jsonl` (0600), one JSON
// line per (store key, digest, opening). The zrdt service re-sends them after
// a restart (heldOpenings), the git table reads them, and SERVE gets them as
// `held`. M1 keeps them here rather than in SQL: a migration is deferred.

import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Bytes, Digest, ServeHeld } from '../ZrdtBackend.std.ts';
import { fromHex, toHex } from './appMessage.std.ts';
import type { OpeningStore } from './host.node.ts';

type Line = Readonly<{ key: string; digest: string; opening: string }>;

/** An opening store over one append-only file. */
export class FileOpeningStore implements OpeningStore {
  readonly #path: string;
  #loaded: Promise<Map<string, Map<string, Bytes>>> | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  #load(): Promise<Map<string, Map<string, Bytes>>> {
    this.#loaded ??= (async () => {
      const out = new Map<string, Map<string, Bytes>>();
      let text = '';
      try {
        text = await readFile(this.#path, 'utf8');
      } catch {
        return out;
      }
      for (const raw of text.split('\n')) {
        if (raw.trim() === '') {
          continue;
        }
        try {
          const line = JSON.parse(raw) as Line;
          const opening = fromHex(line.opening);
          if (opening === undefined || !/^[0-9a-f]{64}$/.test(line.digest)) {
            continue;
          }
          const m = out.get(line.key) ?? new Map<string, Bytes>();
          m.set(line.digest, opening);
          out.set(line.key, m);
        } catch {
          // A torn last line after a crash: skip it.
        }
      }
      return out;
    })();
    return this.#loaded;
  }

  async put(key: string, digest: Digest, opening: Bytes): Promise<void> {
    const all = await this.#load();
    const hex = toHex(digest);
    const m = all.get(key) ?? new Map<string, Bytes>();
    if (m.has(hex)) {
      return;
    }
    m.set(hex, new Uint8Array(opening));
    all.set(key, m);
    const line: Line = { key, digest: hex, opening: toHex(opening) };
    // One append at a time, in order.
    const previous = this.#writes;
    const write = async (): Promise<void> => {
      await previous;
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, `${JSON.stringify(line)}\n`, {
        mode: 0o600,
      });
      await chmod(this.#path, 0o600);
    };
    this.#writes = write();
    await this.#writes;
  }

  async all(key: string): Promise<Array<ServeHeld>> {
    const all = await this.#load();
    return [...(all.get(key)?.entries() ?? [])].map(([digest, opening]) => ({
      digest: fromHex(digest) ?? new Uint8Array(32),
      opening: new Uint8Array(opening),
    }));
  }
}
