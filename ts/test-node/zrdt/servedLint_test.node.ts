// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// JOIN_PLAN §4.3 step 5, §8.2: nothing but ts/zrdt/served.preload.ts builds a
// ZrdtServed, so every SERVE reply goes out sealed to the key SERVE checked.
// And no zrdt path re-sends from the sendLog any more.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { assert } from 'chai';

const ROOT = join(process.cwd(), 'ts');
const ALLOWED = new Set(['ts/zrdt/served.preload.ts']);

function sources(dir: string): Array<string> {
  const out = new Array<string>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test-node' && name !== 'test-mock' && name !== 'protobuf') {
        out.push(...sources(path));
      }
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('zrdt: one constructor for ZrdtServed (JOIN_PLAN §4.3)', () => {
  const files = sources(ROOT);

  it('only served.preload.ts builds a ZrdtServed', () => {
    const offenders = files
      .map(file => relative(process.cwd(), file))
      .filter(file => !ALLOWED.has(file))
      .filter(file => /\bzrdtServed\s*:/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(offenders, []);
  });

  it('no zrdt module re-sends from the sendLog', () => {
    const offenders = files
      .map(file => relative(process.cwd(), file))
      .filter(file => file.startsWith('ts/zrdt/'))
      .filter(file =>
        /getSentProtoByRecipient|SavedProto/.test(readFileSync(file, 'utf8'))
      );
    assert.deepEqual(offenders, []);
  });
});
