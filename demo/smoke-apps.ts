// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// smoke-apps.ts: the apps go/no-go test (zrdt docs/apps/BUILD_M1.md §E.2,
// gate 9), one check per step of each beat.
//
//   node --import tsx demo/smoke-apps.ts [--plan] [--beats torrent,git]
//                                       [--background] [--port N]
//
//   (default)     links Alice, Bob, Carol and Dave in group "Camping" on the
//                 mock server with the real zrdtd, then plays the torrent
//                 beat (demo/beats/torrent.ts). Needs lane transport's
//                 endpoint, dialog wiring and setVillain hook; until then
//                 its first check fails and says what is missing.
//   --plan        no desktops: checks the beat's own parts. The CDN villain
//                 on a scratch folder laid out like the mock's tus store,
//                 and a dress rehearsal of Carol's repair on the torrent
//                 manager with a scripted transport (its row must read
//                 exactly what the live beat checks). Runs in seconds.
//   --beats       which beats (default torrent; the git beat is not
//                 written yet and fails its check).
//   --background  windows do not wait to become visible.
//   --port N      the villain's panel port (default: any free port).
//
// Before a run on the shared Mac it refuses to start while another demo,
// smoke or beat runs (`pgrep -fl 'demo/(smoke|launch|beat)|run-demo'`).
// Writes demo/artifacts/smoke-apps/run.json. Exit 0 only when every check
// passes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BtManager, statusText } from '../ts/zrdt/apps/bt/manager.std.ts';
import type { BtMember } from '../ts/zrdt/apps/bt/manager.std.ts';
import { FakeBtApi } from '../ts/test-node/zrdt/apps/bt/fakeBtApi.std.ts';
import { MemoryWriter } from '../ts/test-node/zrdt/apps/bt/memoryWriter.std.ts';
import type {
  CdnFate,
  MemberFate,
} from '../ts/test-node/zrdt/apps/bt/fakeBtApi.std.ts';
import {
  ASKED_ALICE,
  CORRUPTED_FOR_CAROL,
  DELETED,
  EXPECTED,
  FILE_NAME,
  FILE_PIECES,
  MEMBERS,
  REPAIR_TIMEOUT_MS,
  STEPS,
  TAMPERED_BY_DAVE,
  dirCdnVillain,
  fileContent,
  torrentBeat,
} from './beats/torrent.ts';
import {
  REPO,
  configureEnv,
  linkDesktop,
  openGroup,
  say,
  screenshots,
  setUp,
  tearDown,
  tile,
} from './harness.ts';
import { startPanel } from './panel.ts';

type CheckRecord = { id: string; ok: boolean; detail: string; ms: number };

const checks: Array<CheckRecord> = [];
const t0 = Date.now();

function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail, ms: Date.now() - t0 });
  say(`${ok ? 'PASS' : 'FAIL'} ${id}${ok ? '' : `: ${detail}`}`);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --- --plan ----------------------------------------------------------------

/** The CDN villain on a folder laid out like the mock's tus store. */
async function planVillain(): Promise<void> {
  const cdn3 = await fs.mkdtemp(path.join(os.tmpdir(), 'zrdt-apps-plan-'));
  try {
    const dir = path.join(cdn3, 'attachments');
    await fs.mkdir(dir);
    const put = async (key: string, size: number) => {
      await fs.writeFile(path.join(dir, key), new Uint8Array(size).fill(7));
      await fs.writeFile(path.join(dir, `${key}.json`), '{}');
      // Distinct creation times, as sequential uploads have.
      await new Promise(resolve => {
        setTimeout(resolve, 15);
      });
    };
    await put('before-1', 10);
    await put('before-2', 10);
    const villain = dirCdnVillain(cdn3);
    await villain.arm();
    // Keys sort differently from their order: the villain goes by time.
    const keys = Array.from(
      { length: FILE_PIECES },
      (_, i) => `${(FILE_PIECES - i).toString(36)}-${i}`
    );
    for (const key of keys) {
      // oxlint-disable-next-line no-await-in-loop
      await put(key, 64);
    }
    const uploads = await villain.uploads();
    check(
      'plan: the villain sees the uploads in order',
      uploads.length === FILE_PIECES &&
        uploads.every((u, i) => path.basename(u) === keys[i]),
      `${uploads.length} uploads`
    );
    for (const n of DELETED) {
      // oxlint-disable-next-line no-await-in-loop
      await villain.remove(n);
    }
    const corrupted = await villain.corrupt(CORRUPTED_FOR_CAROL);
    const left = new Set(await fs.readdir(dir));
    check(
      `plan: the villain deletes pieces ${DELETED.join(', ')}`,
      DELETED.every(n => !left.has(keys[n - 1] ?? '')) &&
        left.has('before-1') &&
        left.size === 2 * (FILE_PIECES + 2) - DELETED.length,
      [...left].sort().join(' ')
    );
    const bytes = await fs.readFile(corrupted);
    check(
      `plan: the villain corrupts piece ${CORRUPTED_FOR_CAROL}`,
      path.basename(corrupted) === keys[CORRUPTED_FOR_CAROL - 1] &&
        bytes.filter(b => b !== 7).length === 1,
      path.basename(corrupted)
    );
  } finally {
    await fs.rm(cdn3, { recursive: true, force: true });
  }
}

/** Carol's side of the beat on the manager, with transport scripted. */
async function planCarol(): Promise<void> {
  const member = (name: string): BtMember => ({
    aci: name.toLowerCase(),
    name,
  });
  const alice = member('Alice');
  const bob = member('Bob');
  const dave = member('Dave');
  const api = new FakeBtApi();
  const cdn = new Map<number, CdnFate>(DELETED.map(n => [n - 1, 'notFound']));
  cdn.set(CORRUPTED_FOR_CAROL - 1, 'badMac');
  // Who Carol asks for each missing piece, and what they do (§A.1 step 5):
  // Alice quit (no answer), Dave tampers with piece 7, Bob's replies pass.
  const asks = new Map<number, Array<readonly [BtMember, MemberFate]>>();
  for (const n of [...DELETED, CORRUPTED_FOR_CAROL]) {
    asks.set(n - 1, [[bob, 'good']]);
  }
  asks.set(ASKED_ALICE - 1, [
    [alice, 'silent'],
    [bob, 'good'],
  ]);
  asks.set(TAMPERED_BY_DAVE - 1, [
    [dave, 'tamper'],
    [bob, 'good'],
  ]);
  const a = api.addFile({
    name: FILE_NAME,
    bytes: fileContent(),
    author: alice,
    cdn,
    repair: asks,
  });
  const writer = new MemoryWriter();
  const manager = new BtManager({
    api,
    writer,
    confirmShare: async () => true,
  });
  await manager.onAnnouncement({
    conversationId: 'camping',
    announcement: a,
    author: alice,
    confirmedByAuthor: true,
  });
  const t = manager.transfer(a);
  const resent = t?.resent.map(r => `${r.member.name}:${r.pieces.join(',')}`);
  check(
    "plan: Carol's row ends checked",
    t?.phase === 'checked' && t.checked === FILE_PIECES,
    t === undefined ? 'no row' : statusText(t)
  );
  check(
    `plan: Carol's row reads "${EXPECTED.carolResent}"`,
    t !== undefined &&
      t.resent.length === 1 &&
      resent?.[0] ===
        `Bob:${[...DELETED, CORRUPTED_FOR_CAROL].map(n => n - 1).join(',')}`,
    JSON.stringify(resent)
  );
  check(
    `plan: Carol's row reads "${EXPECTED.carolNotice}"`,
    JSON.stringify(t?.notices) === JSON.stringify([EXPECTED.carolNotice]),
    JSON.stringify(t?.notices)
  );
  check(
    'plan: Carol saved the bytes Alice shared',
    t?.savedTo !== undefined &&
      writer.files.get(t.savedTo)?.byteLength === fileContent().byteLength,
    String(t?.savedTo)
  );
  check(
    'plan: the dialog question',
    EXPECTED.question ===
      `Share ${FILE_NAME} (20 MiB) with Camping (${MEMBERS.length} members)?`,
    EXPECTED.question
  );
}

// --- the run ---------------------------------------------------------------

/** Another demo, smoke or beat on this Mac (other than us). */
function othersRunning(): Array<string> {
  try {
    return execFileSync('pgrep', ['-fl', 'demo/(smoke|launch|beat)|run-demo'])
      .toString()
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .filter(line => Number(line.split(' ')[0]) !== process.pid)
      .filter(line => Number(line.split(' ')[0]) !== process.ppid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

async function live(beats: ReadonlySet<string>): Promise<void> {
  const others = othersRunning();
  if (others.length > 0) {
    check('no other demo running', false, others.join('; '));
    return;
  }
  if (process.argv.includes('--background')) {
    process.env.SIGNAL_MOCK_TESTS_BACKGROUND = '1';
    delete process.env.ZRDT_FOREGROUND;
  }
  process.env.ZRDT_REPAIR_TIMEOUT_MS ??= String(REPAIR_TIMEOUT_MS);
  process.env.ZRDT_APPS ??= '1';
  say(configureEnv());
  const artifacts = path.join(REPO, 'demo', 'artifacts', 'smoke-apps');
  const demo = await setUp({ artifacts, founders: [...MEMBERS] });
  const port = Number(argValue('--port') ?? process.env.ZRDT_PANEL_PORT ?? 0);
  const panel = await startPanel({ villain: demo.server, port });
  say(`panel on ${panel.url}`);
  try {
    const four = MEMBERS.map(name => demo.byName[name]);
    for (const m of four) {
      // oxlint-disable-next-line no-await-in-loop
      await linkDesktop(demo, m.name);
    }
    await tile(four);
    for (const m of four) {
      // oxlint-disable-next-line no-await-in-loop
      await openGroup(m, demo.group);
    }
    if (beats.has('torrent')) {
      await torrentBeat(demo, check);
      await screenshots(
        demo,
        four.filter(m => m.page),
        'torrent'
      );
    }
    if (beats.has('git')) {
      check('git beat', false, 'demo/beats/git.ts is not written yet');
    }
  } catch (error) {
    check('harness', false, String((error as Error)?.stack ?? error));
    try {
      await screenshots(
        demo,
        demo.members.filter(m => m.page),
        'failure'
      );
    } catch {
      // windows may be gone
    }
  } finally {
    await panel.close();
    await tearDown(demo);
  }
}

async function main(): Promise<void> {
  const plan = process.argv.includes('--plan');
  const beats = new Set(
    (argValue('--beats') ?? 'torrent').split(',').map(b => b.trim())
  );
  for (const [id, what] of STEPS) {
    say(`torrent step ${id}: ${what}`);
  }
  try {
    if (plan) {
      await planVillain();
      await planCarol();
    } else {
      await live(beats);
    }
  } catch (error) {
    check('smoke-apps', false, String((error as Error)?.stack ?? error));
  }
  const failed = checks.filter(c => !c.ok);
  const out = path.join(
    REPO,
    'demo',
    'artifacts',
    plan ? 'smoke-apps-plan' : 'smoke-apps'
  );
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(
    path.join(out, 'run.json'),
    `${JSON.stringify(
      {
        totalMs: Date.now() - t0,
        passed: checks.length - failed.length,
        failed: failed.length,
        checks,
      },
      null,
      2
    )}\n`
  );
  say(
    failed.length === 0 && checks.length > 0
      ? `GO: all ${checks.length} checks passed`
      : `NO-GO: ${failed.length} of ${checks.length} checks failed`
  );
  for (const c of failed) {
    say(`  FAILED ${c.id}: ${c.detail}`);
  }
  process.exitCode = failed.length === 0 && checks.length > 0 ? 0 : 1;
}

void main();
