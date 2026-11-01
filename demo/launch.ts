// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Launch harness, day-1 spike (PLAN §4 Phase E, APP.md §8a).
//
// One EvilServer, three Bootstraps (Alice, Bob, Carol) sharing it, a group
// "Camping" with all three, three linked desktops tiled side by side. Each
// desktop sends one warm-up message so sender keys are distributed. Then:
//
//   1. baseline   Alice sends; Bob's and Carol's desktops both show it.
//   2. drop       dropGroupMsg('alice', 'carol'); Alice sends; Bob gets it,
//                 Carol does not. Bob replies; Carol gets the reply.
//   3. blackhole  blackhole('carol'); Alice sends; Bob gets it, Carol not.
//   4. hold       hold('carol'); Alice sends; Carol gets it only after
//                 release('carol').
//
// Each check reads the receiving app's database through SignalCI and its
// timeline through Playwright. Screenshots, the villain's log, the desktops'
// logs and a run summary go to artifacts/h3/.
//
// Run from the repository root:
//   node --import tsx demo/launch.ts
//
// Environment:
//   H3_FOREGROUND=1  do not set SIGNAL_MOCK_TESTS_BACKGROUND (reproduces the
//                    ~30 s start-up wait when the Mac's screen is locked)
//   H3_KEEP_OPEN=1   keep the desktops open until Ctrl-C
//   H3_VERBOSE=1     print every villain decision
//   H3_OUT=dir       write artifacts to `dir` instead of artifacts/h3

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { PNG } from 'pngjs';
import { StorageState } from '@signalapp/mock-server';
import type { Group } from '@signalapp/mock-server';
import type { Page } from 'playwright';

import { Bootstrap } from '../ts/test-mock/bootstrap.node.ts';
import type { App } from '../ts/test-mock/playwright.node.ts';
import {
  getTimelineMessageWithText,
  typeIntoInput,
  waitForEnabledComposer,
} from '../ts/test-mock/helpers.node.ts';
import { MAX_READ_KEYS } from '../ts/services/storageConstants.std.ts';
import { sleep } from '../ts/util/sleep.std.ts';
import {
  EvilServer,
  blackhole,
  dropGroupMsg,
  formatEntry,
  hold,
} from './evil.ts';

// Demo timeouts. ciMode 'full' shortens Signal's own retry backoff tenfold,
// so the harness sets its own generous values.
const GROUP_VISIBLE_MS = 60_000;
const DELIVERY_MS = 30_000;
// How long a message counts as "not delivered" after another member got it.
const ABSENT_MS = 6_000;

const REPO = path.resolve(__dirname, '..');
const ARTIFACTS = path.resolve(
  process.env.H3_OUT ?? path.join(REPO, 'artifacts', 'h3')
);

type Member = {
  name: string; // rule name, e.g. 'alice'
  display: string; // profile name, e.g. 'Alice'
  boot: Bootstrap;
  app?: App;
  page?: Page;
  storagePath?: string;
};

type StepResult = { step: string; ok: boolean; detail: string };

const timings: Record<string, number> = {};
const results: Array<StepResult> = [];
// Every profile directory a desktop of ours used.
const profiles = new Set<string>();
const t0 = Date.now();

function since(start: number): number {
  return Date.now() - start;
}

function say(text: string): void {
  // oxlint-disable-next-line no-console
  console.log(`[launch +${(since(t0) / 1000).toFixed(1)}s] ${text}`);
}

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
}

function app(m: Member): App {
  if (!m.app) {
    throw new Error(`${m.display}'s desktop is not running`);
  }
  return m.app;
}

function page(m: Member): Page {
  if (!m.page) {
    throw new Error(`${m.display}'s window is not open`);
  }
  return m.page;
}

// Every phone gets the group, the other members as whitelisted contacts, and
// typing indicators off. (helpers.createGroup only writes the creator's state.
// Typing indicators are sender-key sends to the whole group; a real server
// tells them apart by their `online` flag, which the mock does not pass on,
// so the harness turns them off to keep dropGroupMsg aimed at messages.)
async function writeStorageStates(
  members: ReadonlyArray<Member>,
  group: Group
): Promise<void> {
  for (const m of members) {
    const { phone } = m.boot;
    let state = StorageState.getEmpty().updateAccount({
      profileKey: phone.profileKey.serialize(),
      givenName: m.display,
      typingIndicators: false,
    });
    state = state.addGroup(group, { whitelisted: true }).pinGroup(group);
    for (const other of members) {
      if (other === m) {
        continue;
      }
      const o = other.boot.phone;
      state = state.addContact(o, {
        whitelisted: true,
        e164: o.device.number,
        identityKey: o.publicKey.serialize(),
        profileKey: o.profileKey.serialize(),
        givenName: other.display,
      });
    }
    // oxlint-disable-next-line no-await-in-loop
    await phone.setStorageState(state);
  }
}

async function openGroup(m: Member, group: Group): Promise<void> {
  const p = page(m);
  await p
    .locator('#LeftPane')
    .locator(`[data-testid="${group.id}"]`)
    .click({ timeout: GROUP_VISIBLE_MS });
  await waitForEnabledComposer(p);
}

// Types `text` into the open conversation, sends it, and returns its sent_at
// timestamp once the sender's UI shows it as sent.
async function send(m: Member, text: string): Promise<number> {
  const input = await waitForEnabledComposer(page(m));
  await typeIntoInput(input, text, '');
  await input.press('Enter');
  const { timestamp } = await app(m).waitForMessageSend();
  return timestamp;
}

// Waits until `m`'s desktop has the message in its database and timeline.
async function shown(m: Member, ts: number, text: string): Promise<boolean> {
  try {
    await app(m).waitForMessage({
      timestamp: ts,
      predicate: msg => msg.body === text,
      timeout: DELIVERY_MS,
    });
    await getTimelineMessageWithText(page(m), text).waitFor({
      timeout: DELIVERY_MS,
    });
    return true;
  } catch (error) {
    say(`${m.display} did not show "${text}": ${String(error)}`);
    return false;
  }
}

// True when `m`'s desktop has neither the message nor its text right now.
async function absent(m: Member, ts: number, text: string): Promise<boolean> {
  const inDb = await app(m).getMessagesBySentAt(ts);
  const inTimeline = await getTimelineMessageWithText(page(m), text).count();
  return inDb.length === 0 && inTimeline === 0;
}

async function screenshots(
  members: ReadonlyArray<Member>,
  label: string
): Promise<string> {
  const pngs: Array<PNG> = [];
  for (const m of members) {
    // oxlint-disable-next-line no-await-in-loop
    const buf = await page(m).screenshot();
    const file = path.join(ARTIFACTS, `${label}-${m.name}.png`);
    // oxlint-disable-next-line no-await-in-loop
    await fs.writeFile(file, buf);
    pngs.push(PNG.sync.read(buf));
  }
  // One side-by-side image of all windows, in tile order.
  const width = pngs.reduce((w, p) => w + p.width, 0);
  const height = Math.max(...pngs.map(p => p.height));
  const all = new PNG({ width, height });
  let x = 0;
  for (const p of pngs) {
    PNG.bitblt(p, all, 0, 0, p.width, p.height, x, 0);
    x += p.width;
  }
  const file = path.join(ARTIFACTS, `${label}.png`);
  await fs.writeFile(file, PNG.sync.write(all));
  say(`screenshot ${path.relative(REPO, file)}`);
  return file;
}

async function tile(members: ReadonlyArray<Member>): Promise<void> {
  const [first] = members;
  if (!first) {
    return;
  }
  const area = await app(first).getScreenWorkArea();
  const width = Math.floor(area.width / members.length);
  for (const [i, m] of members.entries()) {
    // oxlint-disable-next-line no-await-in-loop
    await app(m).setWindowBounds({
      x: area.x + i * width,
      y: area.y,
      width,
      height: area.height,
    });
  }
  say(`tiled ${members.length} windows across ${area.width}x${area.height}`);
}

// Kills Electron processes still using one of our profiles.
function killLeftovers(storagePaths: ReadonlyArray<string>): number {
  let killed = 0;
  for (const dir of storagePaths) {
    let pids: Array<string> = [];
    try {
      pids = execFileSync('pgrep', ['-f', dir]).toString().trim().split('\n');
    } catch {
      continue; // pgrep exits 1 when nothing matches
    }
    for (const pid of pids.filter(Boolean)) {
      if (Number(pid) === process.pid) {
        continue;
      }
      try {
        process.kill(Number(pid), 'SIGKILL');
        killed += 1;
      } catch {
        // already gone
      }
    }
  }
  return killed;
}

async function main(): Promise<void> {
  if (!process.env.H3_FOREGROUND) {
    // Show windows without waiting for them to become visible: on a locked
    // Mac screen the `show` event, and with it provisioning, waits ~30 s.
    process.env.SIGNAL_MOCK_TESTS_BACKGROUND = '1';
  }
  await fs.rm(ARTIFACTS, { recursive: true, force: true });
  await fs.mkdir(ARTIFACTS, { recursive: true });

  const cdn3Path = await fs.mkdtemp(path.join(os.tmpdir(), 'zrdt-h3-cdn3-'));
  const server = new EvilServer({
    maxStorageReadKeys: MAX_READ_KEYS,
    cdn3Path,
    updates2Path: path.join(REPO, 'ts', 'test-mock', 'updates-data'),
  });
  server.verbose = Boolean(process.env.H3_VERBOSE);
  await server.listen(0);
  say(`EvilServer listening on port ${server.address().port}`);

  const member = (name: string, display: string): Member => ({
    name,
    display,
    boot: new Bootstrap({ server, contactCount: 0, phoneName: display }),
  });
  const alice = member('alice', 'Alice');
  const bob = member('bob', 'Bob');
  const carol = member('carol', 'Carol');
  const members: ReadonlyArray<Member> = [alice, bob, carol];

  try {
    for (const m of members) {
      // oxlint-disable-next-line no-await-in-loop
      await m.boot.init();
      m.storagePath = path.dirname(m.boot.logsDir);
      profiles.add(m.storagePath);
      const { aci, pni } = m.boot.phone.device;
      server.addMember(m.name, pni ? [aci, pni] : [aci]);
    }

    const group = await alice.boot.phone.createGroup({
      title: 'Camping',
      members: members.map(m => m.boot.phone),
    });
    await writeStorageStates(members, group);
    timings.setupMs = since(t0);
    say(`group "Camping" ${group.id} with ${members.length} members`);

    // Link one after another; the mock's provisioning queue is shared.
    for (const m of members) {
      const start = Date.now();
      // oxlint-disable-next-line no-await-in-loop
      m.app = await m.boot.link();
      timings[`${m.name}.linkMs`] = since(start);
      // link() starts afresh in a new profile if a start attempt failed.
      m.storagePath = path.dirname(m.boot.logsDir);
      profiles.add(m.storagePath);
      // oxlint-disable-next-line no-await-in-loop
      const loaded = await m.app.waitUntilLoaded();
      timings[`${m.name}.appLoadedMs`] = loaded.loadTime;
      timings[`${m.name}.connectMs`] = loaded.connectTime;
      // oxlint-disable-next-line no-await-in-loop
      m.page = await m.app.getWindow();
      say(
        `${m.display} linked in ${timings[`${m.name}.linkMs`]} ms ` +
          `(app loaded after ${loaded.loadTime} ms)`
      );
    }
    timings.allLinkedMs = since(t0);

    await tile(members);

    for (const m of members) {
      const start = Date.now();
      // oxlint-disable-next-line no-await-in-loop
      await openGroup(m, group);
      timings[`${m.name}.groupVisibleMs`] = since(start);
    }
    say('group open in every window');

    // Warm-up: one message per desktop, so sender keys are distributed
    // before any rule is armed.
    for (const m of members) {
      const text = `warm-up from ${m.display}`;
      const start = Date.now();
      // oxlint-disable-next-line no-await-in-loop
      const ts = await send(m, text);
      const others = members.filter(o => o !== m);
      // oxlint-disable-next-line no-await-in-loop
      const ok = await Promise.all(others.map(o => shown(o, ts, text)));
      timings[`${m.name}.warmupMs`] = since(start);
      record(
        `warm-up ${m.name}`,
        ok.every(Boolean),
        others
          .map((o, i) => `${o.name}=${ok[i] ? 'shown' : 'missing'}`)
          .join(' ')
      );
    }
    await screenshots(members, '0-warmup');

    // 1. Baseline: no rules.
    {
      const text = 'Who brings the tent?';
      const ts = await send(alice, text);
      const [b, c] = await Promise.all([
        shown(bob, ts, text),
        shown(carol, ts, text),
      ]);
      record('1 baseline', b && c, `bob=${b} carol=${c}`);
      await screenshots(members, '1-baseline');
    }

    // 2. dropGroupMsg(alice, carol): Bob gets Alice's next message, Carol
    // does not; Bob's plain reply still reaches Carol.
    {
      server.arm(dropGroupMsg('alice', 'carol'));
      const logStart = server.log.length;
      const text = "I'll bring the stove";
      const ts = await send(alice, text);
      const b = await shown(bob, ts, text);
      await sleep(ABSENT_MS);
      const c = await absent(carol, ts, text);
      const drops = server.log
        .slice(logStart)
        .filter(e => e.verdict === 'drop');
      const dropOk =
        drops.length === 1 &&
        drops[0]?.seen.to === 'carol' &&
        drops[0]?.seen.ts === BigInt(ts);
      record(
        '2 dropGroupMsg(alice, carol)',
        b && c && dropOk,
        `bob shown=${b} carol absent=${c} drops=${drops.length}` +
          (drops[0] ? ` [${formatEntry(drops[0])}]` : '')
      );

      const reply = 'Great, thanks';
      const rts = await send(bob, reply);
      const [ra, rc] = await Promise.all([
        shown(alice, rts, reply),
        shown(carol, rts, reply),
      ]);
      const stillAbsent = await absent(carol, ts, text);
      record(
        '2b plain reply after the drop',
        ra && rc && stillAbsent,
        `alice=${ra} carol=${rc} carol still lacks the dropped one=${stillAbsent}`
      );
      await screenshots(members, '2-drop');
      server.clearRules();
    }

    // 3. blackhole(carol): nothing reaches Carol's desktop.
    {
      server.arm(blackhole('carol'));
      const text = 'Meet at the trailhead at 9';
      const ts = await send(alice, text);
      const b = await shown(bob, ts, text);
      await sleep(ABSENT_MS);
      const c = await absent(carol, ts, text);
      record('3 blackhole(carol)', b && c, `bob shown=${b} carol absent=${c}`);
      await screenshots(members, '3-blackhole');
      server.clearRules();
    }

    // 4. hold(carol) then release(carol).
    {
      server.arm(hold('carol'));
      const text = 'Bring snacks';
      const ts = await send(alice, text);
      const b = await shown(bob, ts, text);
      await sleep(ABSENT_MS / 2);
      const heldOk = await absent(carol, ts, text);
      const released = await server.release('carol');
      const c = await shown(carol, ts, text);
      record(
        '4 hold(carol) / release(carol)',
        b && heldOk && c,
        `bob shown=${b} carol absent while held=${heldOk} ` +
          `released=${released} carol shown after release=${c}`
      );
      await screenshots(members, '4-hold-release');
      server.clearRules();
    }

    if (process.env.H3_KEEP_OPEN) {
      say('H3_KEEP_OPEN: desktops stay open; press Ctrl-C to close them');
      await new Promise<void>(resolve => process.once('SIGINT', resolve));
    }
  } catch (error) {
    record('harness', false, String((error as Error)?.stack ?? error));
    try {
      await screenshots(
        members.filter(m => m.page),
        'failure'
      );
    } catch {
      // windows may be gone
    }
  } finally {
    for (const m of members) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        await m.app?.close();
      } catch (error) {
        say(`closing ${m.display}'s desktop: ${String(error)}`);
      }
    }
    // Keep the desktops' logs, then remove their profiles.
    for (const m of members) {
      if (!m.storagePath) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop
        await fs.cp(
          path.join(m.storagePath, 'logs'),
          path.join(ARTIFACTS, 'logs', m.name),
          { recursive: true }
        );
      } catch {
        // no logs yet
      }
      // oxlint-disable-next-line no-await-in-loop
      await m.boot.teardown();
    }
    const killed = killLeftovers([...profiles]);
    await server.close();
    await fs.rm(cdn3Path, { recursive: true, force: true });

    await fs.writeFile(
      path.join(ARTIFACTS, 'evil-log.txt'),
      `${server.log.map(formatEntry).join('\n')}\n`
    );
    timings.totalMs = since(t0);
    const summary = { timings, results, leftoverProcessesKilled: killed };
    await fs.writeFile(
      path.join(ARTIFACTS, 'run.json'),
      `${JSON.stringify(summary, null, 2)}\n`
    );
    say(`timings ${JSON.stringify(timings)}`);
    say(`killed ${killed} leftover processes`);
    const failed = results.filter(r => !r.ok);
    say(
      failed.length === 0
        ? `ALL ${results.length} CHECKS PASSED`
        : `${failed.length} OF ${results.length} CHECKS FAILED`
    );
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

void main();
