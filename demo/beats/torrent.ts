// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The torrent beat (zrdt docs/apps/BUILD_M1.md §A.1), group "Camping":
// Alice, Bob, Carol, Dave. Played by demo/smoke-apps.ts, and by a presenter
// in the live demo with the same steps.
//
//   1. Alice shares trip.mp4 (20 MiB) with `zbt share`; her desktop asks
//      "Share trip.mp4 (20 MiB) with Camping (4 members)?" and she presses
//      Share. Carol is offline (the server holds what is sent to her).
//   2. Bob and Dave fetch it without a click (it came live from its author,
//      and it is at most 32 MiB), write it into a new folder, and ASSEMBLE
//      checks the written file.
//   3. Alice quits. The server deletes the CDN objects of pieces 3, 7 and 12
//      and corrupts piece 15's (after Bob's and Dave's fetches, before
//      Carol's).
//   4. Carol comes back: 16 pieces pass; 3, 7 and 12 are not found and 15
//      fails Signal's attachment MAC.
//   5. Carol repairs from the members A seats: Alice does not answer (she
//      quit), Dave's reply for piece 7 fails its check (he plays a modified
//      member), Bob's pass. Carol's row: "pieces 3, 7, 12 and 15 resent by
//      Bob" and, for her only, "piece 7 from Dave failed its check".
//
// Signal's MAC catches the server; zrdt's check catches members.
//
// What this needs from lane transport (stubbed until integration, BUILD_M1
// §D.2): each desktop's endpoint file `<userData>/zrdt-apps.json` with the bt
// routes (ts/zrdt/apps/bt/routes.std.ts) mounted; the share dialog
// (ZrdtShareFileDialogHost) and the group's files (ZrdtGroupFiles) mounted
// in the app; the CI hook `setVillain('tamper')` for Dave's desktop
// (FORK_MAP §7.2); ZRDT_REPAIR_TIMEOUT_MS honoured. A missing piece shows as
// a failed check with the reason, never as a hang.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PIECE_BYTES,
  pieceFailedText,
  resentSummaryText,
  shareQuestion,
} from '../../ts/zrdt/apps/bt/manager.std.ts';
import { REPO, app, hook, page, say } from '../harness.ts';
import type { Demo, Member, MemberName } from '../harness.ts';
import { hold } from '../rules.ts';

// ---------------------------------------------------------------------------
// The script

export const GROUP = 'Camping';
export const FILE_NAME = 'trip.mp4';
export const FILE_PIECES = 20;
export const FILE_SIZE = FILE_PIECES * PIECE_BYTES;
/** Piece numbers count from 1, as on screen; the upload order is the same. */
export const DELETED: ReadonlyArray<number> = [3, 7, 12];
export const CORRUPTED_FOR_CAROL = 15;
export const TAMPERED_BY_DAVE = 7;
/** The piece Carol asks Alice (the author, asked first) for; she quit. */
export const ASKED_ALICE = 3;
/** How long Carol waits for one repair answer (the harness's value). */
export const REPAIR_TIMEOUT_MS = 5_000;

/** The members of "Camping", in the order the beat names them. */
export const MEMBERS: ReadonlyArray<MemberName> = [
  'alice',
  'bob',
  'carol',
  'dave',
];

/** One line per step, for narration (DEMO.md) and the smoke's log. */
export const STEPS: ReadonlyArray<readonly [string, string]> = [
  [
    'share',
    `Alice: zbt share ${FILE_NAME} --group ${GROUP}; she presses Share`,
  ],
  ['fetch', 'Bob and Dave fetch it at once; their copies are checked on disk'],
  [
    'villain',
    `Alice quits; the server deletes pieces ${DELETED.join(', ')} and ` +
      `corrupts piece ${CORRUPTED_FOR_CAROL} on its way to Carol`,
  ],
  [
    'repair',
    'Carol comes back: four pieces are missing; she asks the members the ' +
      'announcement seats, author first',
  ],
  [
    'result',
    `Bob resends them; Dave's piece ${TAMPERED_BY_DAVE} fails its check, ` +
      'and only Carol is told',
  ],
];

/** What each desktop's row must say at the end (manager.std.ts wording). */
export const EXPECTED = {
  question: shareQuestion({
    groupTitle: GROUP,
    memberCount: MEMBERS.length,
    name: FILE_NAME,
    size: FILE_SIZE,
  }),
  carolResent: resentSummaryText({
    member: { aci: 'bob', name: 'Bob' },
    pieces: [...DELETED, CORRUPTED_FOR_CAROL]
      .map(n => n - 1)
      .sort((a, b) => a - b),
  }),
  carolNotice: pieceFailedText(TAMPERED_BY_DAVE - 1, 'Dave'),
} as const;

/** Deterministic file content: the same 20 MiB on every run. */
export function fileContent(size = FILE_SIZE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  // MINSTD (Park-Miller): exact in doubles, no bit operations.
  let x = 20_261_102;
  for (let k = 0; k < size; k += 1) {
    x = (x * 48_271) % 2_147_483_647;
    out[k] = x % 256;
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array<ArrayBuffer>): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// The villain on the CDN (FORK_MAP §4.5)
//
// The CDN keys are end-to-end encrypted, so the server picks objects as a
// real server would: by upload order. The mock's tus store keeps each object
// at `<cdn3Path>/attachments/<key>` (with `<key>.json` beside it); the file
// is created when the upload starts, so creation order is upload order as
// long as the desktop starts its uploads in index order. When lane
// transport's EvilServer records `getAttachmentUploadForm` (FORK_MAP O6),
// pass that log in instead (`CdnVillain` is the seam).

export type CdnVillain = Readonly<{
  /** Forgets every object so far: the next upload is number 1. */
  arm: () => Promise<void>;
  /** The objects uploaded since `arm`, oldest first (deleted ones too). */
  uploads: () => Promise<ReadonlyArray<string>>;
  /** Deletes upload number `n` (1-based); returns its path. */
  remove: (n: number) => Promise<string>;
  /** Flips one byte in the middle of upload number `n`; returns its path. */
  corrupt: (n: number) => Promise<string>;
}>;

/** A CDN villain over the mock's tus folder. */
export function dirCdnVillain(cdn3Path: string): CdnVillain {
  const dir = path.join(cdn3Path, 'attachments');
  let before = new Set<string>();
  // Every upload since `arm`, in order; a deleted one keeps its number.
  let known: Array<string> = [];

  const list = async (): Promise<Array<string>> => {
    let names: Array<string>;
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const objects = names.filter(n => !n.endsWith('.json'));
    const stats = await Promise.all(
      objects.map(async n => {
        const file = path.join(dir, n);
        const st = await fs.stat(file);
        return { file, born: st.birthtimeMs || st.ctimeMs };
      })
    );
    return stats
      .sort((a, b) => a.born - b.born || a.file.localeCompare(b.file))
      .map(o => o.file);
  };

  const refresh = async (): Promise<ReadonlyArray<string>> => {
    const seen = new Set(known);
    for (const file of await list()) {
      if (!before.has(file) && !seen.has(file)) {
        known.push(file);
        seen.add(file);
      }
    }
    return known;
  };

  const nth = async (n: number): Promise<string> => {
    const all = await refresh();
    const file = all[n - 1];
    if (file === undefined) {
      throw new Error(`no upload number ${n} (${all.length} since armed)`);
    }
    return file;
  };

  return {
    arm: async () => {
      before = new Set(await list());
      known = [];
    },
    uploads: async () => [...(await refresh())],
    remove: async n => {
      const file = await nth(n);
      await fs.rm(file);
      return file;
    },
    corrupt: async n => {
      const file = await nth(n);
      const handle = await fs.open(file, 'r+');
      try {
        const { size } = await handle.stat();
        const at = Math.floor(size / 2);
        const one = Buffer.alloc(1);
        await handle.read(one, 0, 1, at);
        one[0] = 255 - (one[0] ?? 0);
        await handle.write(one, 0, 1, at);
      } finally {
        await handle.close();
      }
      return file;
    },
  };
}

// ---------------------------------------------------------------------------
// zbt against a desktop

/** BUILD_M1 §B.10: each desktop writes its endpoint file into its userData. */
export function endpointFile(m: Member): string {
  if (m.storagePath === undefined) {
    throw new Error(`${m.display} has no profile`);
  }
  return path.join(m.storagePath, 'zrdt-apps.json');
}

export type ZbtRun = Readonly<{
  code: number;
  json: unknown;
  stdout: string;
  stderr: string;
}>;

/** Runs `zbt <args> --json` against `m`'s desktop. */
export function zbt(
  m: Member,
  args: ReadonlyArray<string>,
  timeoutMs = 180_000
): Promise<ZbtRun> {
  const script = path.join(REPO, 'tools', 'zbt', 'zbt.ts');
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [script, ...args, '--json'],
      {
        env: { ...process.env, ZRDT_ENDPOINT: endpointFile(m) },
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let json: unknown;
        try {
          json = stdout.trim().length > 0 ? JSON.parse(stdout) : undefined;
        } catch {
          json = undefined;
        }
        let code = 0;
        if (error != null) {
          code = typeof error.code === 'number' ? error.code : 3;
        }
        resolve({ code, json, stdout, stderr });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// The run

export type Check = (id: string, ok: boolean, detail: string) => void;

type FileJson = {
  file: string | null;
  state: string;
  status: string;
  pieces: number;
  checked: number;
  resent: Array<{ member: string; pieces: Array<number> }>;
  notices: Array<string>;
  savedTo: string | null;
};

function asFile(value: unknown): FileJson | undefined {
  return typeof value === 'object' && value != null && 'state' in value
    ? (value as FileJson)
    : undefined;
}

async function savedHash(f: FileJson | undefined): Promise<string | undefined> {
  if (f?.savedTo == null) {
    return undefined;
  }
  try {
    return sha256Hex(await fs.readFile(f.savedTo));
  } catch {
    return undefined;
  }
}

/** Waits for `m`'s row of `file` to be checked or failed. */
async function waitFor(
  m: Member,
  file: string,
  seconds: number
): Promise<{ f: FileJson | undefined; run: ZbtRun }> {
  const run = await zbt(m, [
    'status',
    file,
    '--group',
    GROUP,
    '--wait',
    String(seconds),
  ]);
  return { f: asFile(run.json), run };
}

function why(run: ZbtRun): string {
  return run.stderr.trim() || run.stdout.trim() || `exit ${run.code}`;
}

/**
 * Plays the beat on linked desktops (Alice, Bob, Carol and Dave, group
 * open). Every step reports through `check`; a missing piece of lane
 * transport fails its step with the reason and the beat stops there.
 */
export async function torrentBeat(
  demo: Demo,
  check: Check,
  villain: CdnVillain = dirCdnVillain(demo.cdn3Path)
): Promise<void> {
  const { alice, bob, carol, dave } = demo.byName;

  // Preflight: every desktop serves the bt endpoint.
  for (const m of [alice, bob, carol, dave]) {
    // oxlint-disable-next-line no-await-in-loop
    const hello = await zbt(m, ['hello'], 15_000);
    check(
      `torrent: ${m.name}'s endpoint answers`,
      hello.code === 0,
      hello.code === 0 ? JSON.stringify(hello.json) : why(hello)
    );
    if (hello.code !== 0) {
      return;
    }
  }
  const tamper = await hook<unknown>(dave, 'setVillain', 'tamper');
  check(
    "torrent: Dave's desktop plays a modified member",
    !tamper.missing,
    tamper.missing ? 'no window.SignalCI.zrdt.setVillain hook' : 'tamper'
  );

  // 1. Alice shares; Carol is offline.
  const content = fileContent();
  const file = path.join(demo.artifacts, FILE_NAME);
  await fs.writeFile(file, content);
  const want = sha256Hex(content);
  demo.server.arm(hold('carol'));
  await villain.arm();

  say(`torrent: ${STEPS[0]?.[1]}`);
  const sharing = zbt(alice, ['share', file, '--group', GROUP]);
  const dialog = page(alice).getByTestId('ZrdtShareFileDialog');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 30_000 });
    const text = (await dialog.textContent()) ?? '';
    check(
      "torrent: Alice's dialog asks first",
      text.includes(EXPECTED.question),
      text
    );
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  } catch (error) {
    // zbt still waits on the dialog; it exits when the desktops close.
    check("torrent: Alice's dialog asks first", false, String(error));
    return;
  }
  const shared = await sharing;
  const sharedJson = shared.json as
    | { status?: string; file?: string }
    | undefined;
  const announcement = sharedJson?.file;
  check(
    'torrent: Alice shared it',
    shared.code === 0 &&
      sharedJson?.status === 'ok' &&
      announcement !== undefined,
    shared.code === 0 ? JSON.stringify(sharedJson) : why(shared)
  );
  if (announcement === undefined) {
    return;
  }
  const uploads = await villain.uploads();
  check(
    `torrent: ${FILE_PIECES} pieces went to the CDN`,
    uploads.length === FILE_PIECES,
    `${uploads.length} uploads`
  );

  // 2. Bob and Dave fetch without a click.
  say(`torrent: ${STEPS[1]?.[1]}`);
  for (const m of [bob, dave]) {
    // oxlint-disable-next-line no-await-in-loop
    const { f, run } = await waitFor(m, announcement, 120);
    // oxlint-disable-next-line no-await-in-loop
    const got = await savedHash(f);
    check(
      `torrent: ${m.display} has it, checked on disk`,
      f?.state === 'checked' && got === want,
      f === undefined
        ? why(run)
        : `${f.status}; saved ${got === want ? 'equal' : 'DIFFERENT'}`
    );
  }

  // 3. Alice quits; the server deletes and corrupts.
  say(`torrent: ${STEPS[2]?.[1]}`);
  try {
    await app(alice).close();
  } catch (error) {
    say(`closing Alice's desktop: ${String(error)}`);
  }
  alice.app = undefined;
  alice.page = undefined;
  try {
    for (const n of DELETED) {
      // oxlint-disable-next-line no-await-in-loop
      await villain.remove(n);
    }
    await villain.corrupt(CORRUPTED_FOR_CAROL);
    check('torrent: the server deleted and corrupted', true, 'ok');
  } catch (error) {
    check('torrent: the server deleted and corrupted', false, String(error));
    return;
  }

  // 4-5. Carol comes back and repairs.
  say(`torrent: ${STEPS[3]?.[1]}`);
  await demo.server.release('carol');
  const { f: carolRow, run: carolRun } = await waitFor(
    carol,
    announcement,
    120 + (4 * REPAIR_TIMEOUT_MS) / 1000
  );
  const carolGot = await savedHash(carolRow);
  check(
    'torrent: Carol has it, checked on disk',
    carolRow?.state === 'checked' && carolGot === want,
    carolRow === undefined
      ? why(carolRun)
      : `${carolRow.status}; saved ${carolGot === want ? 'equal' : 'DIFFERENT'}`
  );
  const bobResent = carolRow?.resent.find(r => r.member === 'Bob');
  const wantResent = [...DELETED, CORRUPTED_FOR_CAROL].sort((a, b) => a - b);
  check(
    `torrent: Carol's pieces ${wantResent.join(', ')} resent by Bob`,
    JSON.stringify(bobResent?.pieces) === JSON.stringify(wantResent) &&
      carolRow?.resent.length === 1,
    JSON.stringify(carolRow?.resent)
  );
  check(
    `torrent: Carol is told "${EXPECTED.carolNotice}"`,
    JSON.stringify(carolRow?.notices) ===
      JSON.stringify([EXPECTED.carolNotice]),
    JSON.stringify(carolRow?.notices)
  );
  say(`torrent: ${STEPS[4]?.[1]}`);

  // Only Carol is told.
  for (const m of [bob, dave]) {
    // oxlint-disable-next-line no-await-in-loop
    const { f } = await waitFor(m, announcement, 5);
    check(
      `torrent: ${m.display} is not told about Dave's piece`,
      f !== undefined && f.notices.length === 0,
      JSON.stringify(f?.notices)
    );
  }

  // Carol's window shows it.
  try {
    const row = page(carol)
      .getByTestId('ZrdtTransferRow')
      .filter({ hasText: FILE_NAME });
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    const text = (await row.textContent()) ?? '';
    check(
      "torrent: Carol's row shows the resend and the failed check",
      text.includes(EXPECTED.carolResent) &&
        text.includes(EXPECTED.carolNotice),
      text
    );
  } catch (error) {
    check(
      "torrent: Carol's row shows the resend and the failed check",
      false,
      String(error)
    );
  }
}
