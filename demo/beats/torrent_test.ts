// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for demo/beats/torrent.ts. Run from the repository root:
//   node --import tsx --test demo/beats/torrent_test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ASKED_ALICE,
  CORRUPTED_FOR_CAROL,
  DELETED,
  EXPECTED,
  FILE_PIECES,
  FILE_SIZE,
  TAMPERED_BY_DAVE,
  dirCdnVillain,
  fileContent,
  sha256Hex,
} from './torrent.ts';

void test('the script matches BUILD_M1 §A.1', () => {
  assert.deepEqual(DELETED, [3, 7, 12]);
  assert.equal(CORRUPTED_FOR_CAROL, 15);
  assert.equal(TAMPERED_BY_DAVE, 7);
  assert.ok(DELETED.includes(ASKED_ALICE));
  assert.ok(DELETED.includes(TAMPERED_BY_DAVE));
  assert.ok(
    [...DELETED, CORRUPTED_FOR_CAROL].every(n => n >= 1 && n <= FILE_PIECES)
  );
  assert.equal(FILE_SIZE, 20 * 2 ** 20);
  assert.equal(
    EXPECTED.question,
    'Share trip.mp4 (20 MiB) with Camping (4 members)?'
  );
  assert.equal(EXPECTED.carolResent, 'pieces 3, 7, 12 and 15 resent by Bob');
  assert.equal(EXPECTED.carolNotice, 'piece 7 from Dave failed its check');
});

void test('fileContent is the same on every run', () => {
  const a = fileContent(4096);
  assert.equal(sha256Hex(a), sha256Hex(fileContent(4096)));
  assert.notEqual(sha256Hex(a), sha256Hex(new Uint8Array(4096)));
});

void test('the CDN villain goes by upload order, ignores metadata, keeps numbers', async () => {
  const cdn3 = await fs.mkdtemp(path.join(os.tmpdir(), 'zrdt-villain-'));
  try {
    const dir = path.join(cdn3, 'attachments');
    const villain = dirCdnVillain(cdn3);
    // No folder yet: nothing uploaded.
    await villain.arm();
    assert.deepEqual(await villain.uploads(), []);
    await fs.mkdir(dir);
    const put = async (key: string) => {
      await fs.writeFile(path.join(dir, key), new Uint8Array(32).fill(1));
      await fs.writeFile(path.join(dir, `${key}.json`), '{}');
      await new Promise(resolve => {
        setTimeout(resolve, 15);
      });
    };
    await put('old');
    await villain.arm();
    for (const key of ['z', 'y', 'x']) {
      // oxlint-disable-next-line no-await-in-loop
      await put(key);
    }
    assert.deepEqual(
      (await villain.uploads()).map(f => path.basename(f)),
      ['z', 'y', 'x']
    );
    assert.equal(path.basename(await villain.remove(2)), 'y');
    // A deleted upload keeps its number: number 3 is still x.
    assert.deepEqual(
      (await villain.uploads()).map(f => path.basename(f)),
      ['z', 'y', 'x']
    );
    await assert.rejects(villain.remove(2));
    const corrupted = await villain.corrupt(3);
    assert.equal(path.basename(corrupted), 'x');
    const bytes = await fs.readFile(corrupted);
    assert.equal(bytes.filter(b => b !== 1).length, 1);
    await assert.rejects(villain.remove(9), /no upload number 9/);
  } finally {
    await fs.rm(cdn3, { recursive: true, force: true });
  }
});
