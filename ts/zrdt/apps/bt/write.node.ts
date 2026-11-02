// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Safe writes of a received file (BUILD_M1 §B.9 receiver step 5, TORRENT_PLAN
// T-M5): every file goes into a folder created for it, under the downloads
// folder, opened with O_CREAT | O_EXCL | O_NOFOLLOW, so a write never
// replaces or follows anything that was there. The manager then reads the
// file back and has ASSEMBLE check it.
//
// Node has no mkdirat: the folder is created with mkdir (which never
// follows a symlink at its last component) and checked again with lstat and
// realpath after the write, so a folder swapped for a link in between is
// detected and the file discarded.

import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { BtWriter, Bytes } from './manager.std.ts';
import { safeComponent } from './manager.std.ts';

/** How many "name 2", "name 3", ... folders to try before giving up. */
const MAX_FOLDER_TRIES = 100;

// O_NOFOLLOW is not expressible as a string flag ('wx'), hence the bits.
/* oxlint-disable no-bitwise */
const WRITE_FLAGS =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  (constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
/* oxlint-enable no-bitwise */

/** "trip.mp4" -> "trip"; ".bashrc" -> ".bashrc"; "a.tar.gz" -> "a.tar". */
export function folderStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

async function realDirectory(dir: string): Promise<string> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${dir} is not a directory`);
  }
  return fs.realpath(dir);
}

/** Creates `<base>/<stem>`, or `<stem> 2`, `<stem> 3`, ...; never reuses one. */
async function newFolder(base: string, stem: string): Promise<string> {
  for (let n = 1; n <= MAX_FOLDER_TRIES; n += 1) {
    const folder = path.join(base, n === 1 ? stem : `${stem} ${n}`);
    try {
      // oxlint-disable-next-line no-await-in-loop
      await fs.mkdir(folder, { mode: 0o700 });
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new Error(`no free folder name for ${stem} in ${base}`);
}

/**
 * A writer into `downloadsDir`, which must exist and be a real directory
 * (not a symlink).
 */
export function createBtWriter({
  downloadsDir,
}: Readonly<{ downloadsDir: string }>): BtWriter {
  return {
    async write(name: string, bytes: Bytes): Promise<{ file: string }> {
      if (!safeComponent(name)) {
        throw new Error('refusing to write an unsafe file name');
      }
      const base = await realDirectory(downloadsDir);
      const folder = await newFolder(base, folderStem(name));
      const file = path.join(folder, name);
      const handle = await fs.open(file, WRITE_FLAGS, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      // The folder is still the one we made, where we made it.
      const after = await realDirectory(folder);
      if (after !== folder) {
        await fs.rm(file, { force: true });
        throw new Error('the download folder moved while writing');
      }
      return { file };
    },

    async readBack(file: string): Promise<Bytes> {
      const handle = await fs.open(file, READ_FLAGS);
      try {
        // A copy with its own ArrayBuffer.
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },

    async discard(file: string): Promise<void> {
      await fs.rm(file, { force: true });
      try {
        await fs.rmdir(path.dirname(file));
      } catch {
        // not empty, or already gone: leave it
      }
    },
  };
}
