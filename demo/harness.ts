// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The demo world, shared by demo/launch.ts (the live demo) and demo/smoke.ts
// (the F2 go/no-go test). APP.md §8a, AMENDMENTS A11.
//
// One EvilServer; four Bootstraps sharing it (Alice, Bob, Carol, Dave), each
// with contactCount 0 and its own phone name; a group "Camping" with all four
// from creation, written into every phone's storage state. Desktops are
// linked one after another (the mock's provisioning queue is shared).
//
// Environment for the fork (set by `configureEnv`, kept if already set):
//   SIGNAL_MOCK_TESTS_BACKGROUND=1  windows do not wait to become visible
//                                   (a locked Mac screen delays each ~30 s);
//                                   ZRDT_FOREGROUND=1 turns this off
//   ZRDT_DAEMON                     zrdt/core/.lake/build/bin/zrdtd, if built
//   ZRDT_RESEND_DELAY_MS=4000       how long a gap row waits before asking
//   ZRDT_AUTHOR_FASTPATH_DELAY_MS=3000  how long "relayed by Bob" shows
//                                   before the app asks the author (beat 2)

import { existsSync } from 'node:fs';
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
import { EvilServer } from './evil.ts';

export const REPO = path.resolve(__dirname, '..');

// Demo timeouts. ciMode 'full' shortens Signal's own retry backoff tenfold,
// so the harness sets its own generous values.
export const GROUP_VISIBLE_MS = 60_000;
export const DELIVERY_MS = 30_000;

export type MemberName = 'alice' | 'bob' | 'carol' | 'dave';

export type Member = {
  name: MemberName; // rule name, e.g. 'alice'
  display: string; // profile and phone name, e.g. 'Alice'
  boot: Bootstrap;
  app?: App;
  page?: Page;
  storagePath?: string;
};

export type Demo = {
  server: EvilServer;
  members: ReadonlyArray<Member>;
  byName: Readonly<Record<MemberName, Member>>;
  group: Group;
  artifacts: string;
  // Every profile directory a desktop of ours used.
  profiles: Set<string>;
  cdn3Path: string;
};

const t0 = Date.now();

export function say(text: string): void {
  // oxlint-disable-next-line no-console
  console.log(`[demo +${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`);
}

export function defaultDaemonPath(): string {
  return path.join(REPO, 'zrdt', 'core', '.lake', 'build', 'bin', 'zrdtd');
}

/** Sets the fork's environment; returns a one-line summary. */
export function configureEnv(): string {
  if (!process.env.ZRDT_FOREGROUND) {
    process.env.SIGNAL_MOCK_TESTS_BACKGROUND ??= '1';
  }
  const daemon = process.env.ZRDT_DAEMON ?? defaultDaemonPath();
  // The demo must run on the verified Lean core: never fall back to the TS stub silently.
  // Set ZRDT_REQUIRE_LEAN=0 explicitly to run the harness on the stub.
  process.env.ZRDT_REQUIRE_LEAN ??= '1';
  if (existsSync(daemon)) {
    process.env.ZRDT_DAEMON = daemon;
  } else if (process.env.ZRDT_REQUIRE_LEAN === '1') {
    throw new Error(
      `no zrdtd at ${daemon}: build it with \`cd zrdt/core && lake build\`, ` +
        'or set ZRDT_REQUIRE_LEAN=0 to run on the stub'
    );
  } else {
    say(
      `no zrdtd at ${daemon}: running on the TypeScript stub (ZRDT_REQUIRE_LEAN=0)`
    );
  }
  process.env.ZRDT_RESEND_DELAY_MS ??= '4000';
  process.env.ZRDT_AUTHOR_FASTPATH_DELAY_MS ??= '3000';
  return (
    `SIGNAL_MOCK_TESTS_BACKGROUND=${process.env.SIGNAL_MOCK_TESTS_BACKGROUND ?? ''} ` +
    `ZRDT_DAEMON=${process.env.ZRDT_DAEMON ?? '(unset)'} ` +
    `ZRDT_RESEND_DELAY_MS=${process.env.ZRDT_RESEND_DELAY_MS} ` +
    `ZRDT_AUTHOR_FASTPATH_DELAY_MS=${process.env.ZRDT_AUTHOR_FASTPATH_DELAY_MS} ` +
    `ZRDT_REQUIRE_LEAN=${process.env.ZRDT_REQUIRE_LEAN ?? '(unset)'}`
  );
}

export function app(m: Member): App {
  if (!m.app) {
    throw new Error(`${m.display}'s desktop is not running`);
  }
  return m.app;
}

export function page(m: Member): Page {
  if (!m.page) {
    throw new Error(`${m.display}'s window is not open`);
  }
  return m.page;
}

export function linked(demo: Demo): Array<Member> {
  return demo.members.filter(m => m.app !== undefined);
}

// Every phone gets the group (pinned), the other members as whitelisted
// contacts, and typing indicators off. helpers.createGroup only writes the
// creator's state. Typing indicators are sender-key sends to the whole group;
// a real server tells them apart by their `online` flag, which the mock does
// not pass on, so they stay off to keep dropGroupMsg aimed at messages.
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

/** The server, four phones and the group; no desktop yet. */
export async function setUp({
  artifacts,
  verbose = false,
}: {
  artifacts: string;
  verbose?: boolean;
}): Promise<Demo> {
  await fs.rm(artifacts, { recursive: true, force: true });
  await fs.mkdir(artifacts, { recursive: true });

  const cdn3Path = await fs.mkdtemp(path.join(os.tmpdir(), 'zrdt-demo-cdn3-'));
  const server = new EvilServer({
    maxStorageReadKeys: MAX_READ_KEYS,
    cdn3Path,
    updates2Path: path.join(REPO, 'ts', 'test-mock', 'updates-data'),
  });
  server.verbose = verbose;
  await server.listen(0);
  say(`EvilServer listening on port ${server.address().port}`);

  const member = (name: MemberName, display: string): Member => ({
    name,
    display,
    boot: new Bootstrap({ server, contactCount: 0, phoneName: display }),
  });
  const byName = {
    alice: member('alice', 'Alice'),
    bob: member('bob', 'Bob'),
    carol: member('carol', 'Carol'),
    dave: member('dave', 'Dave'),
  };
  const members = [byName.alice, byName.bob, byName.carol, byName.dave];
  const profiles = new Set<string>();

  for (const m of members) {
    // oxlint-disable-next-line no-await-in-loop
    await m.boot.init();
    m.storagePath = path.dirname(m.boot.logsDir);
    profiles.add(m.storagePath);
    const { aci, pni } = m.boot.phone.device;
    server.addMember(m.name, pni ? [aci, pni] : [aci]);
  }

  const group = await byName.alice.boot.phone.createGroup({
    title: 'Camping',
    members: members.map(m => m.boot.phone),
  });
  await writeStorageStates(members, group);
  say(`group "Camping" ${group.id} with ${members.length} members`);

  return { server, members, byName, group, artifacts, profiles, cdn3Path };
}

/** Links `name`'s desktop and waits until it is loaded. */
export async function linkDesktop(
  demo: Demo,
  name: MemberName
): Promise<Member> {
  const m = demo.byName[name];
  if (m.app) {
    throw new Error(`${m.display}'s desktop is already linked`);
  }
  const start = Date.now();
  m.app = await m.boot.link();
  // link() starts afresh in a new profile if a start attempt failed.
  m.storagePath = path.dirname(m.boot.logsDir);
  demo.profiles.add(m.storagePath);
  const loaded = await m.app.waitUntilLoaded();
  m.page = await m.app.getWindow();
  say(
    `${m.display} linked in ${Date.now() - start} ms ` +
      `(app loaded after ${loaded.loadTime} ms)`
  );
  return m;
}

/**
 * Restarts `m`'s desktop in the same profile: `app.close(); app.start()`.
 * Never `bootstrap.startApp()`: after one failed start it deletes the
 * profile and silently relaunches unlinked.
 */
export async function restartDesktop(
  demo: Demo,
  name: MemberName
): Promise<void> {
  const m = demo.byName[name];
  const a = app(m);
  try {
    await a.close();
  } catch (error) {
    say(`closing ${m.display}'s desktop: ${String(error)}`);
  }
  await a.start();
  await a.waitUntilLoaded();
  m.page = await a.getWindow();
  await openGroup(m, demo.group);
  say(`${m.display}'s desktop restarted`);
}

export async function openGroup(m: Member, group: Group): Promise<void> {
  const p = page(m);
  // Signal's "New ways to connect" card takes screen space; dismiss it.
  const dismiss = p.locator('#LeftPane').getByRole('button', {
    name: 'Dismiss',
  });
  try {
    if ((await dismiss.count()) > 0) {
      await dismiss.first().click({ timeout: 2_000 });
    }
  } catch {
    // cosmetic only
  }
  await p
    .locator('#LeftPane')
    .locator(`[data-testid="${group.id}"]`)
    .click({ timeout: GROUP_VISIBLE_MS });
  await waitForEnabledComposer(p);
}

/** Tiles the windows side by side, in member order. */
export async function tile(members: ReadonlyArray<Member>): Promise<void> {
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

/**
 * Types `text` into `m`'s open conversation, sends it, and returns its sent_at
 * timestamp once the sender's app reports it sent.
 */
export async function send(m: Member, text: string): Promise<number> {
  const input = await waitForEnabledComposer(page(m));
  await typeIntoInput(input, text, '');
  await input.press('Enter');
  const { timestamp } = await app(m).waitForMessageSend();
  return timestamp;
}

/** Waits until `m`'s desktop has the message in its database and timeline. */
export async function shown(
  m: Member,
  ts: number,
  text: string,
  timeout = DELIVERY_MS
): Promise<boolean> {
  try {
    await app(m).waitForMessage({
      timestamp: ts,
      predicate: msg => msg.body === text,
      timeout,
    });
    await getTimelineMessageWithText(page(m), text).waitFor({ timeout });
    return true;
  } catch (error) {
    say(`${m.display} did not show "${text}": ${String(error)}`);
    return false;
  }
}

/** True when `m`'s desktop has neither the message nor its text right now. */
export async function absent(
  m: Member,
  ts: number,
  text: string
): Promise<boolean> {
  const inDb = await app(m).getMessagesBySentAt(ts);
  const inTimeline = await getTimelineMessageWithText(page(m), text).count();
  return inDb.length === 0 && inTimeline === 0;
}

/**
 * One warm-up message per desktop, so sender keys are distributed before any
 * rule is armed. Returns the members that did not see every warm-up.
 */
export async function warmUp(
  members: ReadonlyArray<Member>
): Promise<Array<string>> {
  const problems: Array<string> = [];
  for (const m of members) {
    const text = `warm-up from ${m.display}`;
    // oxlint-disable-next-line no-await-in-loop
    const ts = await send(m, text);
    const others = members.filter(o => o !== m);
    // oxlint-disable-next-line no-await-in-loop
    const ok = await Promise.all(others.map(o => shown(o, ts, text)));
    others.forEach((o, i) => {
      if (!ok[i]) {
        problems.push(`${o.name} lacks "${text}"`);
      }
    });
  }
  say(
    problems.length === 0
      ? `warm-up done (${members.map(m => m.name).join(', ')})`
      : `warm-up problems: ${problems.join('; ')}`
  );
  return problems;
}

/** Screenshots each window and one side-by-side image; returns its path. */
export async function screenshots(
  demo: Demo,
  members: ReadonlyArray<Member>,
  label: string
): Promise<string> {
  const pngs: Array<PNG> = [];
  for (const m of members) {
    // oxlint-disable-next-line no-await-in-loop
    const buf = await page(m).screenshot();
    // oxlint-disable-next-line no-await-in-loop
    await fs.writeFile(
      path.join(demo.artifacts, `${label}-${m.name}.png`),
      buf
    );
    pngs.push(PNG.sync.read(buf));
  }
  const width = pngs.reduce((w, p) => w + p.width, 0);
  const height = Math.max(...pngs.map(p => p.height));
  const all = new PNG({ width, height });
  let x = 0;
  for (const p of pngs) {
    PNG.bitblt(p, all, 0, 0, p.width, p.height, x, 0);
    x += p.width;
  }
  const file = path.join(demo.artifacts, `${label}.png`);
  await fs.writeFile(file, PNG.sync.write(all));
  say(`screenshot ${path.relative(REPO, file)}`);
  return file;
}

// --- zrdt test hooks (lane T3, ts/zrdt/ci.preload.ts) ----------------------------

export type HookResult<T> =
  | Readonly<{ missing: true }>
  | Readonly<{ missing: false; value: T }>;

/**
 * Calls `window.SignalCI.zrdt[name](...args)` in `m`'s window; `missing` when
 * the fork has no such hook (yet).
 */
export async function hook<T>(
  m: Member,
  name: string,
  ...args: ReadonlyArray<unknown>
): Promise<HookResult<T>> {
  return page(m).evaluate(
    async ({ n, a }) => {
      type Hooks = Record<string, (...x: ReadonlyArray<unknown>) => unknown>;
      const ci = (globalThis as unknown as { SignalCI?: { zrdt?: Hooks } })
        .SignalCI;
      const fn = ci?.zrdt?.[n];
      if (typeof fn !== 'function') {
        return { missing: true as const };
      }
      return { missing: false as const, value: (await fn(...a)) as T };
    },
    { n: name, a: args }
  );
}

/** `m`'s conversation id for the group (each desktop has its own). */
export async function conversationId(demo: Demo, m: Member): Promise<string> {
  // Only window.SignalCI reaches the page (contextBridge); it looks up by
  // group id too.
  const id = await page(m).evaluate(
    `window.SignalCI.getConversationId(${JSON.stringify(demo.group.id)})`
  );
  if (typeof id !== 'string') {
    throw new Error(`${m.display} has no conversation for the group`);
  }
  return id;
}

/**
 * Where `m`'s desktop exports the group's store and imports it from:
 * `<userData>/zrdt-export-<conversation id>.bin` (lane T3's getZrdtDumpPath).
 */
export async function dumpPath(demo: Demo, m: Member): Promise<string> {
  const conv = await conversationId(demo, m);
  // userData is the profile directory (config storagePath); SignalContext
  // is not reachable from the page.
  const dir = m.storagePath;
  if (!dir) {
    throw new Error(`no profile directory for ${m.display}`);
  }
  return path.join(dir, `zrdt-export-${conv}.bin`);
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

/**
 * Closes every desktop, keeps their logs under artifacts/logs, removes the
 * profiles, kills leftovers, closes the server. Never throws.
 */
export async function tearDown(demo: Demo): Promise<void> {
  for (const m of demo.members) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      await m.app?.close();
    } catch (error) {
      say(`closing ${m.display}'s desktop: ${String(error)}`);
    }
    m.app = undefined;
    m.page = undefined;
  }
  for (const m of demo.members) {
    if (!m.storagePath) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      await fs.cp(
        path.join(m.storagePath, 'logs'),
        path.join(demo.artifacts, 'logs', m.name),
        { recursive: true }
      );
    } catch {
      // no logs yet
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      await m.boot.teardown();
    } catch (error) {
      say(`teardown of ${m.display}: ${String(error)}`);
    }
  }
  const killed = killLeftovers([...demo.profiles]);
  if (killed > 0) {
    say(`killed ${killed} leftover processes`);
  }
  try {
    await demo.server.close();
  } catch (error) {
    say(`closing the server: ${String(error)}`);
  }
  await fs.rm(demo.cdn3Path, { recursive: true, force: true });
}
