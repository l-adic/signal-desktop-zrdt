// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert } from 'chai';

import {
  createBtWriter,
  folderStem,
} from '../../../../zrdt/apps/bt/write.node.ts';
import { fileBytes } from './fakeBtApi.std.ts';

describe('zrdt/apps/bt/write', () => {
  let root: string;
  let downloads: string;

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'zrdt-bt-write-'))
    );
    downloads = path.join(root, 'Downloads');
    await fs.mkdir(downloads);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes into a new folder and reads the same bytes back', async () => {
    const writer = createBtWriter({ downloadsDir: downloads });
    const bytes = fileBytes(5000);
    const { file } = await writer.write('trip.mp4', bytes);
    assert.strictEqual(file, path.join(downloads, 'trip', 'trip.mp4'));
    assert.deepEqual(await writer.readBack(file), bytes);
    const mode = (await fs.stat(file)).mode % 0o1000;
    assert.strictEqual(mode, 0o600);
  });

  it('never reuses a folder or overwrites a file', async () => {
    const writer = createBtWriter({ downloadsDir: downloads });
    await fs.mkdir(path.join(downloads, 'trip'));
    await fs.writeFile(path.join(downloads, 'trip', 'trip.mp4'), 'mine');
    const first = await writer.write('trip.mp4', fileBytes(10));
    const second = await writer.write('trip.mp4', fileBytes(10, 3));
    assert.strictEqual(first.file, path.join(downloads, 'trip 2', 'trip.mp4'));
    assert.strictEqual(second.file, path.join(downloads, 'trip 3', 'trip.mp4'));
    assert.strictEqual(
      await fs.readFile(path.join(downloads, 'trip', 'trip.mp4'), 'utf8'),
      'mine'
    );
  });

  it('does not follow a symlink where its folder would go', async () => {
    const writer = createBtWriter({ downloadsDir: downloads });
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(downloads, 'trip'));
    const { file } = await writer.write('trip.mp4', fileBytes(10));
    assert.strictEqual(file, path.join(downloads, 'trip 2', 'trip.mp4'));
    assert.deepEqual(await fs.readdir(elsewhere), []);
  });

  it('refuses a downloads folder that is a symlink', async () => {
    const link = path.join(root, 'link');
    await fs.symlink(downloads, link);
    const writer = createBtWriter({ downloadsDir: link });
    let error: unknown;
    try {
      await writer.write('trip.mp4', fileBytes(10));
    } catch (e) {
      error = e;
    }
    assert.instanceOf(error, Error);
    assert.deepEqual(await fs.readdir(downloads), []);
  });

  it('refuses unsafe names before touching the disk', async () => {
    const writer = createBtWriter({ downloadsDir: downloads });
    for (const name of ['../x', 'a/b', '..', 'CON', '.hidden', 'x ']) {
      let error: unknown;
      try {
        // oxlint-disable-next-line no-await-in-loop
        await writer.write(name, fileBytes(10));
      } catch (e) {
        error = e;
      }
      assert.instanceOf(error, Error, name);
    }
    assert.deepEqual(await fs.readdir(downloads), []);
  });

  it('readBack does not follow a symlink', async () => {
    const writer = createBtWriter({ downloadsDir: downloads });
    const target = path.join(root, 'target');
    await fs.writeFile(target, 'x');
    const link = path.join(downloads, 'link.bin');
    await fs.symlink(target, link);
    let error: unknown;
    try {
      await writer.readBack(link);
    } catch (e) {
      error = e;
    }
    assert.instanceOf(error, Error);
  });

  it('discard removes the file and its folder', async () => {
    const writer = createBtWriter({ downloadsDir: downloads });
    const { file } = await writer.write('trip.mp4', fileBytes(10));
    await writer.discard(file);
    assert.deepEqual(await fs.readdir(downloads), []);
  });

  it('folderStem', () => {
    assert.strictEqual(folderStem('trip.mp4'), 'trip');
    assert.strictEqual(folderStem('a.tar.gz'), 'a.tar');
    assert.strictEqual(folderStem('.bashrc'), '.bashrc');
    assert.strictEqual(folderStem('README'), 'README');
  });
});
