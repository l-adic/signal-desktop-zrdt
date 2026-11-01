// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// smoke.ts: the F2 go/no-go test (PLAN.md §4 Phase E/F, APP.md §9 beats 1–5).
//
// Brings up the demo world (demo/harness.ts), links Alice, Bob and Carol,
// warms up, then drives beats 1–5 the way the presenter would, with the
// villain armed through the panel's HTTP API (so the panel is tested too):
//
//   beat 1  three messages; every desktop shows each one with the SAME
//           zrdtDigest; Bob's compare code pasted at Carol reads "Identical".
//   beat 2  dropGroupMsg(alice, carol); Alice sends, Bob replies plainly.
//           Carol shows Bob's reply and a gap row, then recovers Alice's
//           message ("relayed by Bob", then "confirmed by Alice").
//   beat 3  blackhole(carol); Alice sends; nobody replies. Bob's compare code
//           at Carol: "Bob has 1 message you don't … Asked; no answer."
//           Clear; "Ask again" recovers it.
//   beat 4  Carol exports her store; doctor.ts removes one linked, non-head
//           record; Carol imports it: OPEN fails, the red banner names the
//           missing message; "Keep what verifies" reports kept and dropped,
//           and Carol's own chat does not change (she holds every kept one).
//   beat 5  Dave's desktop is linked; Bob exports; doctor.ts appends two
//           fakes by Bob on top of the genuine head; Dave imports: all in
//           the collapsed section, unconfirmed. Alice writes: the genuine
//           history is "held by Alice", Alice's own "confirmed". Bob writes:
//           Bob's genuine ones confirmed, the fakes "not confirmed by Bob".
//   rules   hold(carol) / release(carol) (no zrdt needed).
//
// Each check is tagged `harness` (the mock and the villain) or `zrdt` (needs
// the fork's zrdt lanes: digests on messages, gap rows, resend, compare
// codes). The report lists every check; the exit code is 0 only if all pass.
// Data comes from window.SignalCI.getMessagesBySentAt (message attributes:
// zrdtDigest, zrdtProvenance, zrdtStatus) and from the windows' DOM.
//
// Run from the repository root:
//   node --import tsx demo/smoke.ts [--only-harness]
// Artifacts: demo/artifacts/smoke/ (ZRDT_SMOKE_OUT): run.json, screenshots, logs.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Locator, Page } from 'playwright';

import { getTimelineMessageWithText } from '../ts/test-mock/helpers.node.ts';
import { sleep } from '../ts/util/sleep.std.ts';
import {
  ASK_AGAIN,
  COPY_COMPARE_CODE,
  KEEP_WHAT_VERIFIES,
  PASTE_COMPARE_CODE,
  gapTitle,
  identicalText,
  rejectedText,
  unconfirmedSectionTitle,
} from '../ts/zrdt/ui/labels.std.ts';
import {
  aciBytes,
  analyse,
  appendFakes,
  checkOpen,
  encodeBlob,
  hex,
  locateBlob,
  parseBlob,
  removeLinkedRecord,
  tag,
} from './doctor.ts';
import type { Analysed } from './doctor.ts';
import { formatEntry } from './evil.ts';
import { startPanel } from './panel.ts';
import {
  REPO,
  absent,
  app,
  configureEnv,
  conversationId,
  dumpPath,
  hook,
  linkDesktop,
  linked,
  openGroup,
  page,
  say,
  screenshots,
  send,
  setUp,
  shown,
  tearDown,
  tile,
  warmUp,
} from './harness.ts';
import type { Demo, Member } from './harness.ts';

// How long a message counts as "not delivered" after another member got it.
const ABSENT_MS = 6_000;
// Gap row: ZRDT_RESEND_DELAY_MS (4 s) plus slack.
const GAP_VISIBLE_MS = 15_000;
// Relay from Bob, then the author's resend.
const RECOVER_MS = 45_000;
// Compare at Carol: digest request timeout plus slack.
const COMPARE_MS = 60_000;
// How long to look for a zrdt control before calling it missing.
const UI_MS = 5_000;
// CLASSIFY after a live message, or an import, reaching the UI slice.
const CLASSIFY_MS = 20_000;
// How often the relayed state is sampled in beat 2 (it lasts
// ZRDT_AUTHOR_FASTPATH_DELAY_MS, 3 s).
const RELAY_POLL_MS = 100;

type Kind = 'harness' | 'zrdt';
type Check = {
  id: string;
  kind: Kind;
  ok: boolean;
  detail: string;
  // Since the start of the run, when the check finished.
  atMs: number;
  // How long the check itself took (attempt() only).
  ms?: number;
};

const checks: Array<Check> = [];
const runStart = Date.now();

function check(
  id: string,
  kind: Kind,
  ok: boolean,
  detail: string,
  ms?: number
): boolean {
  const atMs = Date.now() - runStart;
  checks.push({ id, kind, ok, detail, atMs, ms });
  const took = ms !== undefined ? ` (${(ms / 1000).toFixed(1)} s)` : '';
  say(`${ok ? 'PASS' : 'FAIL'} [${kind}] ${id}${took}: ${detail}`);
  return ok;
}

async function attempt(
  id: string,
  kind: Kind,
  body: () => Promise<{ ok: boolean; detail: string }>
): Promise<boolean> {
  const start = Date.now();
  try {
    const { ok, detail } = await body();
    return check(id, kind, ok, detail, Date.now() - start);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return check(
      id,
      kind,
      false,
      `threw: ${message.split('\n')[0]}`,
      Date.now() - start
    );
  }
}

type BeatTiming = { beat: string; ms: number };
const beatTimings: Array<BeatTiming> = [];

async function timed(beat: string, body: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await body();
  } finally {
    const ms = Date.now() - start;
    beatTimings.push({ beat, ms });
    say(`${beat}: ${(ms / 1000).toFixed(1)} s`);
  }
}

type Sent = { from: Member; text: string; ts: number };

type MessageView = {
  body?: string;
  type?: string;
  zrdtDigest?: string;
  zrdtProvenance?: { kind: string; byAci?: string };
  zrdtStatus?: { kind: string; wasRelayed?: boolean };
  // Only from the T3 hooks: the label the UI shows ("relayed by Bob").
  label?: string | null;
};

async function messageAt(
  m: Member,
  sent: Sent
): Promise<MessageView | undefined> {
  const viaHook = await hook<Array<MessageView>>(
    m,
    'getMessagesBySentAt',
    sent.ts
  );
  const all = viaHook.missing
    ? ((await app(m).getMessagesBySentAt(
        sent.ts
      )) as unknown as Array<MessageView>)
    : viaHook.value;
  return all.find(x => x.body === sent.text);
}

const HEX64 = /^[0-9a-f]{64}$/;

/** zrdt: every member in `on` has the message with one shared digest. */
async function sameDigest(
  id: string,
  sent: Sent,
  on: ReadonlyArray<Member>
): Promise<boolean> {
  return attempt(id, 'zrdt', async () => {
    const digests = await Promise.all(
      on.map(async m => (await messageAt(m, sent))?.zrdtDigest)
    );
    const detail = on
      .map((m, i) => `${m.name}=${digests[i]?.slice(0, 8) ?? 'none'}`)
      .join(' ');
    const [first] = digests;
    const ok =
      first !== undefined &&
      HEX64.test(first) &&
      digests.every(d => d === first);
    return { ok, detail: `"${sent.text}": ${detail}` };
  });
}

async function post(
  panelUrl: string,
  route: string,
  params: Record<string, string> = {}
): Promise<string> {
  const res = await fetch(`${panelUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as {
    ok: boolean;
    result?: string;
    error?: string;
  };
  if (!body.ok) {
    throw new Error(`panel ${route}: ${body.error}`);
  }
  say(`panel: ${body.result}`);
  return body.result ?? '';
}

/** A zrdt control by its label: a button or menu item, in a menu if need be. */
async function control(p: Page, name: string): Promise<Locator> {
  const direct = p
    .getByRole('button', { name })
    .or(p.getByRole('menuitem', { name }));
  if ((await direct.count()) > 0) {
    return direct.first();
  }
  // Maybe it sits in the conversation header's "more" menu.
  const more = p.locator('.module-ConversationHeader').getByRole('button', {
    name: /more/i,
  });
  if ((await more.count()) > 0) {
    await more.first().click();
    const inMenu = p
      .getByRole('menuitem', { name })
      .or(p.getByRole('button', { name }));
    try {
      await inMenu.first().waitFor({ timeout: UI_MS });
      return inMenu.first();
    } catch {
      // Close the menu, or it swallows the next keystrokes in this window.
      await p.keyboard.press('Escape');
    }
  }
  throw new Error(`no "${name}" control in the window (not wired yet?)`);
}

/**
 * Bob copies his compare code; Carol pastes it. Uses the T3 hooks when they
 * exist (no clipboard), else the buttons. Returns the outcome, if a hook gave
 * one, as JSON for the report.
 */
async function compare(demo: Demo, from: Member, to: Member): Promise<string> {
  const code = await hook<string | undefined>(
    from,
    'getCompareCode',
    await conversationId(demo, from)
  );
  if (!code.missing) {
    await hook(from, 'closeCompare');
    if (!code.value) {
      throw new Error(`${from.display} has no compare code`);
    }
    const outcome = await hook<unknown>(
      to,
      'comparePaste',
      await conversationId(demo, to),
      code.value
    );
    return outcome.missing
      ? 'no comparePaste hook'
      : JSON.stringify(outcome.value);
  }
  await (await control(page(from), COPY_COMPARE_CODE)).click();
  await (await control(page(to), PASTE_COMPARE_CODE)).click();
  return '(buttons)';
}

async function visible(
  p: Page,
  text: string | RegExp,
  timeout: number
): Promise<boolean> {
  try {
    await p.getByText(text).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function beat1(demo: Demo, trio: ReadonlyArray<Member>): Promise<void> {
  const { alice, bob, carol } = demo.byName;
  const lines: Array<[Member, string]> = [
    [alice, "who's bringing the tent?"],
    [bob, 'me'],
    [carol, 'I have the stove'],
  ];
  const sentAll: Array<Sent> = [];
  for (const [from, text] of lines) {
    // oxlint-disable-next-line no-await-in-loop
    const ts = await send(from, text);
    const sent = { from, text, ts };
    sentAll.push(sent);
    const others = trio.filter(o => o !== from);
    // oxlint-disable-next-line no-await-in-loop
    const ok = await Promise.all(others.map(o => shown(o, ts, text)));
    check(
      `beat1 delivered "${text}"`,
      'harness',
      ok.every(Boolean),
      others.map((o, i) => `${o.name}=${ok[i]}`).join(' ')
    );
  }
  for (const sent of sentAll) {
    // oxlint-disable-next-line no-await-in-loop
    await sameDigest(`beat1 same zrdtDigest "${sent.text}"`, sent, trio);
  }
  await attempt('beat1 compare codes identical', 'zrdt', async () => {
    const outcome = await compare(demo, bob, carol);
    const ok = await visible(page(carol), identicalText('Bob'), UI_MS * 2);
    await hook(carol, 'closeCompare');
    return {
      ok,
      detail: `${ok ? 'Carol reads "Identical"' : 'no "Identical" on screen'}; outcome ${outcome}`,
    };
  });
  await screenshots(demo, trio, 'beat1');
}

async function beat2(
  demo: Demo,
  trio: ReadonlyArray<Member>,
  panelUrl: string
): Promise<void> {
  const { alice, bob, carol } = demo.byName;
  await post(panelUrl, 'rules/dropGroupMsg', { from: 'alice', to: 'carol' });
  const logStart = demo.server.log.length;

  const lost = {
    from: alice,
    text: 'actually I lost the tent poles',
    ts: 0,
  };
  lost.ts = await send(alice, lost.text);
  const bobGot = await shown(bob, lost.ts, lost.text);
  await sleep(ABSENT_MS);
  const carolLacks = await absent(carol, lost.ts, lost.text);
  const drops = demo.server.log
    .slice(logStart)
    .filter(e => e.verdict === 'drop');
  check(
    'beat2 dropGroupMsg drops exactly Alice→Carol',
    'harness',
    bobGot &&
      carolLacks &&
      drops.length === 1 &&
      drops[0]?.seen.to === 'carol' &&
      drops[0]?.seen.ts === BigInt(lost.ts),
    `bob shown=${bobGot} carol absent=${carolLacks} drops=${drops.length}` +
      (drops[0] ? ` [${formatEntry(drops[0])}]` : '')
  );

  const reply = { from: bob, text: "I'll bring spares", ts: 0 };
  reply.ts = await send(bob, reply.text);
  const [ra, rc] = await Promise.all([
    shown(alice, reply.ts, reply.text),
    shown(carol, reply.ts, reply.text),
  ]);
  check(
    "beat2 Bob's plain reply reaches everyone",
    'harness',
    ra && rc,
    `alice=${ra} carol=${rc}`
  );

  // The gap row appears above Bob's reply while Carol waits.
  const gap = page(carol).locator('.ZrdtGapRow');
  const gapText = gapTitle(1, 'Bob');
  await attempt('beat2 Carol shows a gap row', 'zrdt', async () => {
    const carolConv = await conversationId(demo, carol);
    const deadline = Date.now() + GAP_VISIBLE_MS;
    let rows: number | string = 'n/a (no hook)';
    let onScreen = false;
    while (Date.now() < deadline && !onScreen) {
      // oxlint-disable-next-line no-await-in-loop
      const viaHook = await hook<Array<unknown>>(
        carol,
        'getGapRows',
        carolConv
      );
      rows = viaHook.missing ? rows : viaHook.value.length;
      // oxlint-disable-next-line no-await-in-loop
      onScreen = (await page(carol).getByText(gapText).count()) > 0;
      if (!onScreen) {
        // oxlint-disable-next-line no-await-in-loop
        await sleep(250);
      }
    }
    return {
      ok: onScreen,
      detail: `${onScreen ? 'shows' : 'no'} "${gapText}" (gap rows in DB: ${rows})`,
    };
  });
  await screenshots(demo, trio, 'beat2-gap');

  // Recovery: relayed by Bob, then confirmed by Alice. The relayed state
  // lasts ZRDT_AUTHOR_FASTPATH_DELAY_MS (3 s): sample it every 100 ms, in the
  // message attributes, in the label the UI computes, and on screen.
  const relayStart = Date.now();
  const events: Array<string> = [];
  let lastState = '';
  let sawRelayed = false;
  let relayedEvidence = '';
  let wasRelayed = false;
  const note = (state: string) => {
    if (state !== lastState) {
      lastState = state;
      events.push(
        `+${((Date.now() - relayStart) / 1000).toFixed(1)}s ${state}`
      );
    }
  };
  const recovered = await attempt(
    'beat2 Carol recovers the dropped message',
    'zrdt',
    async () => {
      const deadline = Date.now() + RECOVER_MS;
      let inTimelineAt: number | undefined;
      while (Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop
        const [msg, relayedCount] = await Promise.all([
          messageAt(carol, lost),
          page(carol).getByText('relayed by Bob').count(),
        ]);
        const relayedOnScreen = relayedCount > 0;
        if (msg) {
          note(
            `provenance=${msg.zrdtProvenance?.kind ?? '?'} ` +
              `label=${msg.label ?? 'none'} ` +
              `wasRelayed=${msg.zrdtStatus?.wasRelayed === true}` +
              (relayedOnScreen ? ' on-screen="relayed by Bob"' : '')
          );
          wasRelayed ||= msg.zrdtStatus?.wasRelayed === true;
          if (!sawRelayed) {
            if (relayedOnScreen) {
              sawRelayed = true;
              relayedEvidence = 'on screen';
            } else if (msg.label === 'relayed by Bob') {
              sawRelayed = true;
              relayedEvidence = 'label';
            } else if (msg.zrdtProvenance?.kind === 'relayed') {
              sawRelayed = true;
              relayedEvidence = 'provenance';
            }
            if (sawRelayed) {
              // The moment the audience sees "relayed by Bob".
              // oxlint-disable-next-line no-await-in-loop
              await screenshots(demo, [carol], 'beat2-relayed');
            }
          }
          if (inTimelineAt === undefined) {
            // oxlint-disable-next-line no-await-in-loop
            const onScreen = await getTimelineMessageWithText(
              page(carol),
              lost.text
            ).count();
            if (onScreen > 0) {
              inTimelineAt = Date.now();
            }
          }
          // Keep sampling briefly after it shows, to catch the relayed state.
          if (
            inTimelineAt !== undefined &&
            (sawRelayed || Date.now() - inTimelineAt > 1_000)
          ) {
            return { ok: true, detail: 'in DB and timeline' };
          }
        }
        // oxlint-disable-next-line no-await-in-loop
        await sleep(RELAY_POLL_MS);
      }
      return { ok: false, detail: `not in Carol's DB within ${RECOVER_MS} ms` };
    }
  );
  check(
    'beat2 recovered copy was "relayed by Bob" first',
    'zrdt',
    sawRelayed,
    sawRelayed
      ? `seen (${relayedEvidence})`
      : `never saw provenance relayed / "relayed by Bob" ` +
          `(wasRelayed=${wasRelayed}; ZRDT_AUTHOR_FASTPATH_DELAY_MS=` +
          `${process.env.ZRDT_AUTHOR_FASTPATH_DELAY_MS ?? 'unset'})`
  );
  await attempt('beat2 then "confirmed by Alice"', 'zrdt', async () => {
    if (!recovered) {
      return { ok: false, detail: 'not recovered' };
    }
    const ok = await visible(page(carol), 'confirmed by Alice', RECOVER_MS);
    const msg = await messageAt(carol, lost);
    if (msg) {
      note(
        `provenance=${msg.zrdtProvenance?.kind ?? '?'} label=${msg.label ?? 'none'} ` +
          `wasRelayed=${msg.zrdtStatus?.wasRelayed === true}`
      );
    }
    return {
      ok: ok || msg?.label === 'confirmed by Alice',
      detail:
        `on screen=${ok} label=${msg?.label} zrdtStatus=${JSON.stringify(msg?.zrdtStatus)} ` +
        `provenance=${JSON.stringify(msg?.zrdtProvenance)}; events: ${events.join(' | ')}`,
    };
  });
  await attempt('beat2 gap row gone after recovery', 'zrdt', async () => {
    const n = await gap.count();
    return { ok: recovered && n === 0, detail: `gap rows=${n}` };
  });
  await sameDigest('beat2 same zrdtDigest for the dropped one', lost, trio);
  await sameDigest("beat2 same zrdtDigest for Bob's reply", reply, trio);
  await screenshots(demo, trio, 'beat2-recovered');
  await post(panelUrl, 'clear');
}

async function beat3(
  demo: Demo,
  trio: ReadonlyArray<Member>,
  panelUrl: string
): Promise<void> {
  const { alice, bob, carol } = demo.byName;
  await post(panelUrl, 'rules/blackhole', { to: 'carol' });
  const withheld = {
    from: alice,
    text: 'meet at 9 at the trailhead',
    ts: 0,
  };
  withheld.ts = await send(alice, withheld.text);
  const bobGot = await shown(bob, withheld.ts, withheld.text);
  await sleep(ABSENT_MS);
  const carolLacks = await absent(carol, withheld.ts, withheld.text);
  check(
    'beat3 blackhole(carol) withholds it',
    'harness',
    bobGot && carolLacks,
    `bob shown=${bobGot} carol absent=${carolLacks}`
  );

  const behind = await attempt(
    'beat3 compare: "Bob has 1 message you don\'t"',
    'zrdt',
    async () => {
      const outcome = await compare(demo, bob, carol);
      const ok = await visible(
        page(carol),
        /Bob has 1 message you don't/,
        UI_MS * 2
      );
      return {
        ok,
        detail: `${ok ? 'shown' : 'not shown'}; outcome ${outcome}`,
      };
    }
  );
  await attempt('beat3 then "Asked; no answer."', 'zrdt', async () => {
    if (!behind) {
      return { ok: false, detail: 'skipped: the compare step failed' };
    }
    const ok = await visible(page(carol), /Asked; no answer\./, COMPARE_MS);
    return { ok, detail: ok ? 'shown' : `not within ${COMPARE_MS} ms` };
  });
  await screenshots(demo, trio, 'beat3-withheld');

  await post(panelUrl, 'clear');
  await attempt(
    'beat3 "Ask again" recovers it after clear',
    'zrdt',
    async () => {
      if (!behind) {
        return { ok: false, detail: 'skipped: the compare step failed' };
      }
      let how = 'button';
      try {
        await (await control(page(carol), ASK_AGAIN)).click();
      } catch {
        how = 'askCompare hook';
        const asked = await hook(carol, 'askCompare');
        if (asked.missing) {
          throw new Error(`no "${ASK_AGAIN}" control and no askCompare hook`);
        }
      }
      const ok = await shown(carol, withheld.ts, withheld.text, RECOVER_MS);
      await hook(carol, 'closeCompare');
      return { ok, detail: `${ok ? 'recovered' : 'not recovered'} (${how})` };
    }
  );
  await sameDigest('beat3 same zrdtDigest after recovery', withheld, trio);
  await screenshots(demo, trio, 'beat3-recovered');
}

type ZrdtConvState = {
  statuses: Record<string, { kind: string; aci?: string }>;
  rejected?: { reason: { kind: string; missing?: Array<string> } };
  salvage?: { kept: number; dropped: Array<string> };
  unconfirmed: Array<{
    digest: string;
    status: { kind: string; aci?: string };
    hasMessage: boolean;
    text?: string;
  }>;
};

async function convState(
  demo: Demo,
  m: Member
): Promise<ZrdtConvState | undefined> {
  const r = await hook<ZrdtConvState | undefined>(
    m,
    'getConversationState',
    await conversationId(demo, m)
  );
  if (r.missing) {
    throw new Error('no getConversationState hook');
  }
  return r.value;
}

/** Polls `probe` until it returns ok or `timeout` passes; the last result. */
async function until(
  timeout: number,
  probe: () => Promise<{ ok: boolean; detail: string }>
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeout;
  let last = await probe();
  while (!last.ok && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await sleep(250);
    // oxlint-disable-next-line no-await-in-loop
    last = await probe();
  }
  return last;
}

async function sortedHeads(demo: Demo, m: Member): Promise<string> {
  const r = await hook<Array<string>>(
    m,
    'heads',
    await conversationId(demo, m)
  );
  if (r.missing) {
    throw new Error('no heads hook');
  }
  return [...r.value].sort().join(',');
}

// --- Settings → Internal, the presenter's path for beats 4 and 5 ----------------

async function internalResult(m: Member): Promise<string> {
  const r = await hook<string | undefined>(m, 'getInternalResult');
  return r.missing ? '' : (r.value ?? '');
}

/**
 * Clicks Settings → Internal → `button` in `m`'s window, waits for the
 * result line to change, and goes back to the chat. Returns the line.
 */
async function clickInternal(
  demo: Demo,
  m: Member,
  button: 'Export store' | 'Import file'
): Promise<string> {
  const p = page(m);
  const before = await internalResult(m);
  await p.getByRole('tab', { name: 'Settings' }).click({ timeout: UI_MS });
  const settings = p.getByRole('tabpanel', { name: 'Settings' });
  await settings
    .getByRole('button', { name: 'Internal', exact: true })
    .click({ timeout: UI_MS });
  await settings
    .getByRole('button', { name: button, exact: true })
    .click({ timeout: UI_MS });
  const deadline = Date.now() + UI_MS * 2;
  let after = await internalResult(m);
  while (after === before && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await sleep(100);
    // oxlint-disable-next-line no-await-in-loop
    after = await internalResult(m);
  }
  // "Import file" returns to the chat by itself; Export stays in Settings.
  if ((await p.getByRole('tabpanel', { name: 'Settings' }).count()) > 0) {
    await p.getByRole('tab', { name: 'Chats' }).click({ timeout: UI_MS });
  }
  await openGroup(m, demo.group);
  if (after === before) {
    throw new Error(`no new result line after "${button}" (still "${before}")`);
  }
  return after;
}

type Via = { how: 'settings' | 'hook'; note: string };

/** Export through Settings → Internal, else the hook. Returns the file. */
async function exportVia(
  demo: Demo,
  m: Member
): Promise<{ file: string | undefined } & Via> {
  const file = await dumpPath(demo, m);
  try {
    const line = await clickInternal(demo, m, 'Export store');
    if (line.startsWith('Exported')) {
      return { file, how: 'settings', note: line };
    }
    throw new Error(line);
  } catch (error) {
    const note = `Settings path failed: ${String(error).split('\n')[0]}`;
    say(`${m.display}: ${note}; using the exportStore hook`);
    const r = await hook<string | undefined>(
      m,
      'exportStore',
      await conversationId(demo, m)
    );
    if (r.missing) {
      throw new Error('no exportStore hook');
    }
    return { file: r.value, how: 'hook', note };
  }
}

/** Import through Settings → Internal, else the hook. Returns the status. */
async function importVia(
  demo: Demo,
  m: Member
): Promise<{ status: string | undefined } & Via> {
  try {
    const line = await clickInternal(demo, m, 'Import file');
    if (/: ok\b/.test(line)) {
      return { status: 'ok', how: 'settings', note: line };
    }
    if (line.includes('does not verify')) {
      return { status: 'unverifiable', how: 'settings', note: line };
    }
    throw new Error(line);
  } catch (error) {
    const note = `Settings path failed: ${String(error).split('\n')[0]}`;
    say(`${m.display}: ${note}; using the importStore hook`);
    const r = await hook<string | undefined>(
      m,
      'importStore',
      await conversationId(demo, m)
    );
    if (r.missing) {
      throw new Error('no importStore hook');
    }
    return { status: r.value, how: 'hook', note };
  }
}

async function beat4(demo: Demo, trio: ReadonlyArray<Member>): Promise<void> {
  const { carol } = demo.byName;
  const conv = await conversationId(demo, carol);
  const headsBefore = await sortedHeads(demo, carol);
  let file: string | undefined;
  let count = 0;
  let removed: string | undefined;
  let unverifiable: ReadonlyArray<string> = [];
  const vias: Array<string> = [];

  const exported = await attempt(
    'beat4 Carol exports her store',
    'zrdt',
    async () => {
      const r = await exportVia(demo, carol);
      vias.push(`export: ${r.how}`);
      file = r.file;
      if (file === undefined) {
        return { ok: false, detail: `export failed (${r.note})` };
      }
      count = parseBlob(locateBlob(await fs.readFile(file)).blob).records
        .length;
      return {
        ok: count >= 2,
        detail: `${count} records -> ${file} (via ${r.how})`,
      };
    }
  );
  const doctored =
    exported &&
    (await attempt(
      'beat4 doctor removes a linked, non-head record',
      'zrdt',
      async () => {
        if (file === undefined) {
          return { ok: false, detail: 'no export' };
        }
        const located = locateBlob(await fs.readFile(file));
        const result = removeLinkedRecord(parseBlob(located.blob));
        const blob = encodeBlob(result.blob);
        await fs.copyFile(file, `${file}.orig`);
        await fs.writeFile(file, located.replace(blob));
        removed = result.removed;
        unverifiable = result.unverifiable;
        const open = await checkOpen(blob, process.env.ZRDT_DAEMON);
        return {
          ok: open.startsWith('UNVERIFIABLE') && open.includes(tag(removed)),
          detail:
            `removed ${tag(removed)} (linked by ${result.linkedBy.map(tag).join(' ')}); ` +
            `zrdtd OPEN: ${open}`,
        };
      }
    ));

  const rejected =
    doctored &&
    (await attempt(
      'beat4 import: OPEN fails, red banner names the missing message',
      'zrdt',
      async () => {
        if (removed === undefined) {
          return { ok: false, detail: 'nothing removed' };
        }
        const imp = await importVia(demo, carol);
        vias.push(`import: ${imp.how}`);
        const r = { value: imp.status };
        const text = rejectedText({ kind: 'unverifiable', missing: [removed] });
        const banner = page(carol).locator('.ZrdtBanner--error');
        const onScreen = await visible(page(carol), text, UI_MS * 2);
        const state = await convState(demo, carol);
        return {
          ok: r.value === 'unverifiable' && onScreen,
          detail:
            `import status=${r.value}; "${text}" ${onScreen ? 'shown' : 'NOT shown'}` +
            ` (error banners: ${await banner.count()}); ` +
            `missing=${JSON.stringify(state?.rejected?.reason.missing?.map(tag))}`,
        };
      }
    ));
  await screenshots(demo, trio, 'beat4-rejected');
  check(
    'beat4 presenter path: Settings → Internal buttons',
    'zrdt',
    vias.length === 2 && vias.every(v => v.endsWith('settings')),
    vias.join(', ') || 'not reached'
  );

  await attempt(
    'beat4 "Keep what verifies" reports kept and dropped',
    'zrdt',
    async () => {
      if (!rejected) {
        return { ok: false, detail: 'skipped: the import step failed' };
      }
      let how = 'banner button';
      const button = page(carol)
        .locator('[data-testid="zrdt-banners"]')
        .getByRole('button', { name: KEEP_WHAT_VERIFIES });
      try {
        await button.first().click({ timeout: UI_MS });
      } catch {
        how = 'keepWhatVerifies hook';
        await hook(carol, 'keepWhatVerifies', conv);
      }
      const expectKept = count - 1 - unverifiable.length;
      const res = await until(CLASSIFY_MS, async () => {
        const state = await convState(demo, carol);
        const salvage = state?.salvage;
        const dropped = [...(salvage?.dropped ?? [])].sort();
        const ok =
          salvage !== undefined &&
          state?.rejected === undefined &&
          salvage.kept === expectKept &&
          dropped.join(',') === [...unverifiable].sort().join(',');
        return {
          ok,
          detail:
            `kept=${salvage?.kept} (expected ${expectKept}) ` +
            `dropped=[${dropped.map(tag).join(' ')}] ` +
            `(expected [${unverifiable.map(tag).join(' ')}])`,
        };
      });
      const onScreen =
        res.ok &&
        (await visible(
          page(carol),
          /^Kept \d+ messages? that verify\./,
          UI_MS
        ));
      return {
        ok: res.ok && onScreen,
        detail: `${res.detail}; report ${onScreen ? 'shown' : 'NOT shown'} (${how})`,
      };
    }
  );
  await attempt("beat4 Carol's own chat does not change", 'zrdt', async () => {
    const state = await convState(demo, carol);
    const headsAfter = await sortedHeads(demo, carol);
    const section = (state?.unconfirmed ?? []).length;
    const ok = headsAfter === headsBefore && section === 0;
    return {
      ok,
      detail:
        `heads ${headsAfter === headsBefore ? 'unchanged' : 'CHANGED'}; ` +
        `unconfirmed section ${section}; ` +
        `${Object.keys(state?.statuses ?? {}).length} statuses`,
    };
  });
  await screenshots(demo, trio, 'beat4-salvaged');
  // Dismiss the salvage report (the presenter clicks OK).
  try {
    await page(carol)
      .locator('[data-testid="zrdt-banners"]')
      .getByRole('button', { name: 'OK' })
      .first()
      .click({ timeout: 2_000 });
  } catch {
    // cosmetic
  }
}

function statusText(s: { kind: string; aci?: string } | undefined): string {
  if (s === undefined) {
    return 'none';
  }
  return s.aci ? `${s.kind}(${s.aci.toLowerCase().slice(0, 4)})` : s.kind;
}

/** Counts records whose status is not `want(record)`; lists a few. */
function mismatches(
  statuses: Record<string, { kind: string; aci?: string }>,
  items: ReadonlyArray<{ digest: string; want: string; who: string }>
): Array<string> {
  return items
    .filter(i => statusText(statuses[i.digest]) !== i.want)
    .map(
      i =>
        `${tag(i.digest)}(${i.who}) is ${statusText(statuses[i.digest])}, want ${i.want}`
    );
}

async function beat5(demo: Demo): Promise<void> {
  const { alice, bob, dave } = demo.byName;
  const aciOf = (m: Member) => m.boot.phone.device.aci.toLowerCase();
  const nameByAuthorHex = new Map(
    demo.members.map(m => [aciOf(m).replace(/-/g, ''), m.name])
  );

  const linkedOk = await attempt(
    "beat5 Dave's desktop links (empty store)",
    'harness',
    async () => {
      await linkDesktop(demo, 'dave');
      await tile(linked(demo));
      await openGroup(dave, demo.group);
      let heads: string;
      try {
        heads = await sortedHeads(demo, dave);
      } catch (error) {
        heads = `(heads: ${String(error).split('\n')[0]})`;
      }
      return { ok: true, detail: `Dave's heads: [${heads}]` };
    }
  );
  if (!linkedOk) {
    return;
  }
  const four = linked(demo);

  // Bob exports; doctor.ts appends two fakes by Bob; Dave's import path.
  let genuine: Array<Analysed> = [];
  let fakes: ReadonlyArray<string> = [];
  const vias5: Array<string> = [];
  const doctored = await attempt(
    'beat5 Bob exports; doctor appends two fakes by Bob on the genuine head',
    'zrdt',
    async () => {
      const r = await exportVia(demo, bob);
      vias5.push(`export: ${r.how}`);
      if (r.file === undefined) {
        return { ok: false, detail: `Bob could not export (${r.note})` };
      }
      const located = locateBlob(await fs.readFile(r.file));
      genuine = analyse(parseBlob(located.blob));
      const result = await appendFakes(located.blob, aciBytes(aciOf(bob)), {
        daemon: process.env.ZRDT_DAEMON,
      });
      fakes = result.fakes;
      const out = await dumpPath(demo, dave);
      await fs.writeFile(out, located.replace(result.blob));
      const bobHeads = await sortedHeads(demo, bob);
      return {
        ok:
          fakes.length === 2 && [...result.heads].sort().join(',') === bobHeads,
        detail:
          `${genuine.length} genuine records; fakes ${fakes.map(tag).join(' ')} ` +
          `on ${result.heads.map(tag).join(' ')}; passes OPEN; -> ${out}`,
      };
    }
  );
  if (!doctored) {
    return;
  }
  const authorName = (a: Analysed) =>
    nameByAuthorHex.get(hex(a.parts.author)) ?? hex(a.parts.author).slice(0, 8);
  const total = genuine.length + fakes.length;

  const imported = await attempt(
    'beat5 Dave imports: everything collapsed and unconfirmed',
    'zrdt',
    async () => {
      const imp = await importVia(demo, dave);
      vias5.push(`import: ${imp.how}`);
      const r = { value: imp.status };
      const res = await until(CLASSIFY_MS, async () => {
        const state = await convState(demo, dave);
        const items = state?.unconfirmed ?? [];
        const allUnconfirmed = items.every(
          i => i.status.kind === 'unconfirmed'
        );
        return {
          ok: items.length === total && allUnconfirmed,
          detail: `section holds ${items.length}/${total}, all unconfirmed=${allUnconfirmed}`,
        };
      });
      const title = unconfirmedSectionTitle(total);
      const onScreen = await visible(page(dave), title, UI_MS);
      return {
        ok: r.value === 'ok' && res.ok && onScreen,
        detail: `import status=${r.value}; ${res.detail}; "${title}" ${onScreen ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  check(
    'beat5 presenter path: Settings → Internal buttons',
    'zrdt',
    vias5.length === 2 && vias5.every(v => v.endsWith('settings')),
    vias5.join(', ') || 'not reached'
  );
  // Open the section so the labels are on screen (one click in the demo).
  try {
    await page(dave)
      .locator('.ZrdtUnconfirmed__toggle')
      .first()
      .click({ timeout: UI_MS });
  } catch {
    say('could not expand the unconfirmed section on Dave');
  }
  await attempt(
    'beat5 imported history shows its verified text; the fakes have none',
    'zrdt',
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const state = await convState(demo, dave);
      const items = state?.unconfirmed ?? [];
      const fakeSet = new Set(fakes);
      const withText = items.filter(i => !fakeSet.has(i.digest) && i.text);
      const fakeText = items.filter(i => fakeSet.has(i.digest) && i.text);
      const last = items.at(-1)?.digest;
      const fakesLast =
        items.length >= 2 &&
        fakeSet.has(items.at(-1)?.digest ?? '') &&
        fakeSet.has(items.at(-2)?.digest ?? '');
      const onScreen = await visible(
        page(dave),
        "who's bringing the tent?",
        UI_MS
      );
      return {
        ok:
          withText.length === genuine.length &&
          fakeText.length === 0 &&
          onScreen,
        detail:
          `${withText.length}/${genuine.length} genuine with text, ` +
          `${fakeText.length} fakes with text; fakes listed last=${fakesLast} ` +
          `(last ${last ? tag(last) : 'none'}); ` +
          `"who's bringing the tent?" ${onScreen ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  await screenshots(demo, four, 'beat5-imported');

  // Alice writes.
  const fromAlice = {
    from: alice,
    text: 'welcome Dave! bring a headlamp',
    ts: 0,
  };
  fromAlice.ts = await send(alice, fromAlice.text);
  const daveGotAlice = await shown(dave, fromAlice.ts, fromAlice.text);
  check(
    "beat5 Alice's message reaches Dave",
    'harness',
    daveGotAlice,
    `dave=${daveGotAlice}`
  );
  await attempt(
    'beat5 Alice writes: genuine history "held by Alice", her own "confirmed"',
    'zrdt',
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const want = [
        ...genuine.map(g => ({
          digest: g.digest,
          who: authorName(g),
          want:
            authorName(g) === 'alice'
              ? 'confirmedByAuthor'
              : `heldBy(${aciOf(alice).slice(0, 4)})`,
        })),
        ...fakes.map(f => ({ digest: f, who: 'fake', want: 'unconfirmed' })),
      ];
      const res = await until(CLASSIFY_MS, async () => {
        const state = await convState(demo, dave);
        const bad = mismatches(state?.statuses ?? {}, want);
        return {
          ok: bad.length === 0,
          detail:
            bad.length === 0
              ? `${want.length} records as expected`
              : `${bad.length} wrong: ${bad.slice(0, 4).join('; ')}`,
        };
      });
      const title = unconfirmedSectionTitle(fakes.length);
      const [held, titled] = await Promise.all([
        visible(page(dave), 'held by Alice', UI_MS),
        visible(page(dave), title, UI_MS),
      ]);
      return {
        ok: res.ok && held && titled,
        detail: `${res.detail}; "held by Alice" ${held ? 'shown' : 'NOT shown'}; "${title}" ${titled ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  await screenshots(demo, four, 'beat5-alice');

  // Bob writes.
  const fromBob = { from: bob, text: "I'll drive Dave", ts: 0 };
  fromBob.ts = await send(bob, fromBob.text);
  const daveGotBob = await shown(dave, fromBob.ts, fromBob.text);
  check(
    "beat5 Bob's message reaches Dave",
    'harness',
    daveGotBob,
    `dave=${daveGotBob}`
  );
  await attempt(
    'beat5 Bob writes: his genuine ones confirmed, the fakes "not confirmed by Bob"',
    'zrdt',
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const want = [
        ...genuine
          .filter(g => authorName(g) === 'alice' || authorName(g) === 'bob')
          .map(g => ({
            digest: g.digest,
            who: authorName(g),
            want: 'confirmedByAuthor',
          })),
        ...fakes.map(f => ({
          digest: f,
          who: 'fake',
          want: 'notConfirmedByAuthor',
        })),
      ];
      const others = genuine.filter(
        g => authorName(g) !== 'alice' && authorName(g) !== 'bob'
      );
      const res = await until(CLASSIFY_MS, async () => {
        const state = await convState(demo, dave);
        const statuses = state?.statuses ?? {};
        const bad = mismatches(statuses, want);
        // Carol's stay "held by" someone until Carol writes.
        const notHeld = others.filter(
          g => statuses[g.digest]?.kind !== 'heldBy'
        );
        return {
          ok: bad.length === 0 && notHeld.length === 0,
          detail:
            (bad.length === 0
              ? `${want.length} Alice/Bob/fake records as expected`
              : `${bad.length} wrong: ${bad.slice(0, 4).join('; ')}`) +
            `; ${others.length - notHeld.length}/${others.length} others held`,
        };
      });
      const notConfirmed = await visible(
        page(dave),
        'not confirmed by Bob',
        UI_MS
      );
      return {
        ok: res.ok && notConfirmed,
        detail: `${res.detail}; "not confirmed by Bob" ${notConfirmed ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  await screenshots(demo, four, 'beat5-bob');
}

async function holdRelease(demo: Demo, panelUrl: string): Promise<void> {
  const { alice, bob, carol } = demo.byName;
  await post(panelUrl, 'rules/hold', { to: 'carol' });
  const text = 'bring snacks';
  const ts = await send(alice, text);
  const b = await shown(bob, ts, text);
  await sleep(ABSENT_MS / 2);
  const held = await absent(carol, ts, text);
  await post(panelUrl, 'rules/release', { to: 'carol' });
  const c = await shown(carol, ts, text);
  check(
    'rules hold(carol) / release(carol)',
    'harness',
    b && held && c,
    `bob=${b} carol absent while held=${held} carol after release=${c}`
  );
  await post(panelUrl, 'clear');
}

async function main(): Promise<void> {
  const onlyHarness = process.argv.includes('--only-harness');
  say(configureEnv());
  const artifacts = path.resolve(
    process.env.ZRDT_SMOKE_OUT ?? path.join(REPO, 'demo', 'artifacts', 'smoke')
  );
  const t0 = Date.now();
  const demo = await setUp({ artifacts });
  const panel = await startPanel({ villain: demo.server, port: 0 });
  try {
    const { alice, bob, carol } = demo.byName;
    const trio = [alice, bob, carol];
    for (const m of trio) {
      // oxlint-disable-next-line no-await-in-loop
      await linkDesktop(demo, m.name);
    }
    await tile(trio);
    for (const m of trio) {
      // oxlint-disable-next-line no-await-in-loop
      await openGroup(m, demo.group);
    }
    const warm = await warmUp(trio);
    check('warm-up', 'harness', warm.length === 0, warm.join('; ') || 'ok');
    for (const m of trio) {
      // oxlint-disable-next-line no-await-in-loop
      await attempt(`zrdt backend on ${m.name}`, 'zrdt', async () => {
        const info = await hook<{
          kind: string;
          version: string;
          available: boolean;
        }>(m, 'backendInfo');
        if (info.missing) {
          return { ok: false, detail: 'no window.SignalCI.zrdt hooks' };
        }
        return {
          ok: info.value.available,
          detail: JSON.stringify(info.value),
        };
      });
    }

    const only = new Set(
      (process.env.ZRDT_SMOKE_BEATS ?? '1,2,3,4,5')
        .split(',')
        .map(x => x.trim())
    );
    await timed('beat 1', () => beat1(demo, trio));
    if (only.has('2')) {
      await timed('beat 2', () => beat2(demo, trio, panel.url));
    }
    if (!onlyHarness && only.has('3')) {
      await timed('beat 3', () => beat3(demo, trio, panel.url));
    }
    if (!onlyHarness && only.has('4')) {
      await timed('beat 4', () => beat4(demo, trio));
    }
    if (!onlyHarness && only.has('5')) {
      await timed('beat 5', () => beat5(demo));
    }
    await timed('rules', () => holdRelease(demo, panel.url));
  } catch (error) {
    check(
      'harness',
      'harness',
      false,
      String((error as Error)?.stack ?? error)
    );
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
    await fs.writeFile(
      path.join(artifacts, 'evil-log.txt'),
      `${demo.server.log.map(formatEntry).join('\n')}\n`
    );
    await tearDown(demo);
    const failed = checks.filter(c => !c.ok);
    const summary = {
      totalMs: Date.now() - t0,
      passed: checks.length - failed.length,
      failed: failed.length,
      failedHarness: failed.filter(c => c.kind === 'harness').map(c => c.id),
      failedZrdt: failed.filter(c => c.kind === 'zrdt').map(c => c.id),
      beatTimings,
      checks,
    };
    await fs.writeFile(
      path.join(artifacts, 'run.json'),
      `${JSON.stringify(summary, null, 2)}\n`
    );
    say(
      failed.length === 0
        ? `GO: all ${checks.length} checks passed`
        : `NO-GO: ${failed.length} of ${checks.length} checks failed ` +
            `(harness ${summary.failedHarness.length}, zrdt ${summary.failedZrdt.length})`
    );
    for (const c of failed) {
      say(`  FAILED [${c.kind}] ${c.id}: ${c.detail}`);
    }
    say(
      `beat timings: ${beatTimings
        .map(b => `${b.beat} ${(b.ms / 1000).toFixed(1)} s`)
        .join(', ')}`
    );
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

void main();
