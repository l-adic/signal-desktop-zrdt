// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// smoke.ts: the F2 go/no-go test (PLAN.md §4 Phase E/F, APP.md §9 beats 1–5).
//
// Brings up the demo world (demo/harness.ts), links Alice, Bob and Carol,
// warms up, then drives beats 1–5 the way the presenter would, with the
// villain armed through the panel's HTTP API (so the panel is tested too):
//
//   beat 1  three messages; every desktop shows each one with the SAME
//           zrdtDigest, and its opening commits the author's audience
//           (DataMessage field 201): the four members, each under the tag of
//           its identity key; Bob's compare code pasted at Carol reads
//           "Identical".
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
//   beat 5  Erin's desktop is linked (a member from the start, no store
//           yet): it catches up (JOIN_PLAN §6.1) into a closed store with
//           Alice's heads. Bob exports for Erin (SERVE for Erin, sealed to
//           her key, §4.5); doctor.ts appends two fakes by Bob on top of the
//           genuine head, in a section sealed to her key; Erin imports: the
//           fakes in the collapsed section, unconfirmed, without text. Alice
//           writes: the genuine history stays vouched for, the fakes
//           unconfirmed. Bob writes: Bob's genuine ones confirmed, the fakes
//           "not confirmed by Bob".
//   rules   hold(carol) / release(carol) (no zrdt needed).
//   beat 6  JOIN (zrdt docs/JOIN_PLAN.md): the old desktops' stores are
//           closed. Alice adds Dave to "Camping" (a
//           real add through the mock, after everything above); Bob and
//           Carol write; Dave links his desktop, which has no store: it asks
//           Alice (the adder) for a catch-up, and SERVE's sealed reply gives
//           it the messages sent to Dave, with content, and the older heads
//           as boundary digests. The server holds everything for Alice, Bob
//           and Carol while Dave links and writes "hi all, dave here" before
//           any reply: his store is relative from that send on, and after
//           the release nothing stays pending and his heads equal Alice's.
//           Dave holds every post-join message, shows a
//           boundary row, and holds no pre-join content anywhere (messages
//           table, zrdt tables, window); his heads equal Alice's. Live
//           messages flow both ways. Dave asks Alice and Bob for a pre-join
//           digest by itself: each reply is that digest, as a boundary
//           digest only, and Dave's heads still equal Alice's. Bob's own
//           export holds no text in the clear (its content is sealed to his
//           key); Dave's import of it is refused, even with its account
//           rewritten to Dave's; Bob restores it himself with every opening
//           kept. Bob's export for Dave gives him no pre-join content and no
//           pre-join record. A reaction and a pin
//           by Bob on a pre-join message do not address Dave. Alice, Bob and
//           Carol still hold everything.
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

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Locator, Page } from 'playwright';

import { getTimelineMessageWithText } from '../ts/test-mock/helpers.node.ts';
import { sleep } from '../ts/util/sleep.std.ts';
import {
  ASK_AGAIN,
  BOUNDARY_ROW_TEXT,
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
  appendSealedFakes,
  asServedExport,
  checkOpen,
  encodeBlob,
  hex,
  locateBlob,
  parseBlob,
  removeLinkedRecord,
  tag,
} from './doctor.ts';
import type { Analysed } from './doctor.ts';
import { formatEntry, hold } from './evil.ts';
import { startPanel } from './panel.ts';
import {
  DELIVERY_MS,
  REPO,
  absent,
  addToGroup,
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
// The old desktops apply a group change (beat 6).
const GROUP_UPDATE_MS = 30_000;

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
  // base64: nonce ‖ the committed DataMessage (only from the T3 hooks).
  zrdtOpening?: string;
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

/**
 * The values of the top-level fields 201 of a DataMessage, or undefined if
 * it does not parse (varint, 64-bit, length-delimited and 32-bit fields).
 */
function field201Values(
  message: Buffer<ArrayBuffer>
): Array<Buffer<ArrayBuffer>> | undefined {
  const out = new Array<Buffer<ArrayBuffer>>();
  let at = 0;
  const varint = (): number | undefined => {
    let value = 0;
    for (let shift = 0; shift < 64 && at < message.length; shift += 7) {
      const byte = message[at] ?? 0;
      at += 1;
      value += (byte % 0x80) * 2 ** shift;
      if (byte < 0x80) {
        return value;
      }
    }
    return undefined;
  };
  while (at < message.length) {
    const key = varint();
    if (key === undefined) {
      return undefined;
    }
    const wire = key % 8;
    if (wire === 0) {
      if (varint() === undefined) {
        return undefined;
      }
    } else if (wire === 1) {
      at += 8;
    } else if (wire === 5) {
      at += 4;
    } else if (wire === 2) {
      const n = varint();
      if (n === undefined || at + n > message.length) {
        return undefined;
      }
      if (Math.floor(key / 8) === 201) {
        out.push(message.subarray(at, at + n));
      }
      at += n;
    } else {
      return undefined;
    }
  }
  return at === message.length ? out : undefined;
}

/**
 * The field-201 value the group's messages must carry: every member's ACI
 * and the tag of its identity key (SHA-256("zrdtK1" ‖ key), 16 bytes),
 * sorted by ACI (JOIN_PLAN §3.2).
 */
async function expectedAudience(
  members: ReadonlyArray<Member>
): Promise<string> {
  const entries = await Promise.all(
    members.map(async m => {
      const { device } = m.boot.phone;
      const key = (await device.getIdentityKey()).serialize();
      const keyTag = createHash('sha256')
        .update('zrdtK1')
        .update(key)
        .digest()
        .subarray(0, 16);
      return Buffer.concat([aciBytes(device.aci), keyTag]);
    })
  );
  entries.sort(Buffer.compare);
  return Buffer.concat(entries).toString('hex');
}

/**
 * zrdt: on every desktop in `on`, the message's opening commits exactly one
 * field 201, and it is `expected` (an audience is required: zrdtd refuses an
 * opening without one).
 */
async function audienceCommitted(
  id: string,
  sent: Sent,
  on: ReadonlyArray<Member>,
  expected: string
): Promise<boolean> {
  return attempt(id, 'zrdt', async () => {
    const seen = await Promise.all(
      on.map(async m => {
        const opening = (await messageAt(m, sent))?.zrdtOpening;
        if (opening === undefined) {
          return 'no opening';
        }
        const values = field201Values(
          Buffer.from(opening, 'base64').subarray(32)
        );
        if (values === undefined) {
          return 'unreadable';
        }
        if (values.length !== 1) {
          return `${values.length} fields 201`;
        }
        const value = values[0]?.toString('hex') ?? '';
        return value === expected
          ? `${value.length / 64} seats`
          : `other audience ${value.slice(0, 16)}`;
      })
    );
    const ok = seen.every(x => x === `${expected.length / 64} seats`);
    const detail = on.map((m, i) => `${m.name}=${seen[i]}`).join(' ');
    return { ok, detail: `"${sent.text}": ${detail}` };
  });
}

/** The members of the group from its creation (not the late joiner). */
function founders(demo: Demo): Array<Member> {
  return demo.members.filter(m => m.name !== LATE);
}

// Beat 6's late joiner.
const LATE = 'dave';

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
  const audience = await expectedAudience(founders(demo));
  for (const sent of sentAll) {
    // oxlint-disable-next-line no-await-in-loop
    await audienceCommitted(
      `beat1 field 201 seats the four members "${sent.text}"`,
      sent,
      trio,
      audience
    );
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
  button: 'Export store' | 'Import file',
  forAci = ''
): Promise<string> {
  const p = page(m);
  const before = await internalResult(m);
  await p.getByRole('tab', { name: 'Settings' }).click({ timeout: UI_MS });
  const settings = p.getByRole('tabpanel', { name: 'Settings' });
  await settings
    .getByRole('button', { name: 'Internal', exact: true })
    .click({ timeout: UI_MS });
  if (button === 'Export store') {
    // "this account" (own export) or another member (JOIN_PLAN §4.5).
    await settings
      .getByLabel('Export for')
      .selectOption(forAci, { timeout: UI_MS });
  }
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

/**
 * Export through Settings → Internal, else the hook: `m`'s own export, or
 * (with `forMember`) the export for that member, sealed to its key. Returns
 * the file.
 */
async function exportVia(
  demo: Demo,
  m: Member,
  forMember?: Member
): Promise<{ file: string | undefined } & Via> {
  const file = await dumpPath(demo, m);
  // The option values are ACIs as Signal writes them (lowercase).
  const forAci = forMember?.boot.phone.device.aci.toLowerCase() ?? '';
  try {
    const line = await clickInternal(demo, m, 'Export store', forAci);
    if (line.startsWith('Exported')) {
      return { file, how: 'settings', note: line };
    }
    throw new Error(line);
  } catch (error) {
    const note = `Settings path failed: ${String(error).split('\n')[0]}`;
    say(`${m.display}: ${note}; using the export hook`);
    const conv = await conversationId(demo, m);
    const r = forMember
      ? await hook<string | undefined>(m, 'exportStoreFor', conv, forAci)
      : await hook<string | undefined>(m, 'exportStore', conv);
    if (r.missing) {
      throw new Error('no export hook');
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
  const { alice, bob, erin } = demo.byName;
  const aciOf = (m: Member) => m.boot.phone.device.aci.toLowerCase();
  const nameByAuthorHex = new Map(
    demo.members.map(m => [aciOf(m).replace(/-/g, ''), m.name])
  );

  const linkedOk = await attempt(
    "beat5 Erin's desktop links (no store yet)",
    'harness',
    async () => {
      await linkDesktop(demo, 'erin');
      await tile(linked(demo));
      await openGroup(erin, demo.group);
      return { ok: true, detail: 'linked' };
    }
  );
  if (!linkedOk) {
    return;
  }
  const four = linked(demo);

  // JOIN_PLAN §6.1: a device with no store catches up, whatever the join
  // revision says. Erin is a member from the start: every record was sent to
  // her, so the reply has no boundary digest and her store is closed.
  let relayer: string | undefined;
  await attempt(
    "beat5 Erin catches up (no store): a closed store with Alice's heads",
    'zrdt',
    async () =>
      until(CATCH_UP_MS, async () => {
        const state = await hookValue<CatchUpView>(demo, erin, 'catchUpState');
        const [a, e] = await Promise.all([
          sortedHeads(demo, alice),
          sortedHeads(demo, erin),
        ]);
        relayer = state.answeredBy?.toLowerCase();
        return {
          ok:
            state.hasStore &&
            !state.relative &&
            state.replies > 0 &&
            a === e &&
            a.length > 0,
          detail:
            `reason=${state.reason} relative=${state.relative} ` +
            `answeredBy=${state.answeredBy?.slice(0, 8)} replies=${state.replies}; ` +
            `alice [${a.split(',').map(tag).join(' ')}] erin [${e
              .split(',')
              .map(tag)
              .join(' ')}]`,
        };
      })
  );

  // Bob exports for Erin (SERVE for Erin, sealed to her key, JOIN_PLAN
  // §4.5); doctor.ts appends two fakes by Bob in a sealed section. Bob's own
  // export tells the doctor the genuine records and heads.
  let genuine: Array<Analysed> = [];
  let fakes: ReadonlyArray<string> = [];
  const vias5: Array<string> = [];
  const doctored = await attempt(
    'beat5 Bob exports for Erin (sealed to her key); doctor appends two fakes by Bob on the genuine head',
    'zrdt',
    async () => {
      const own = await exportVia(demo, bob);
      vias5.push(`own export: ${own.how}`);
      if (own.file === undefined) {
        return { ok: false, detail: `Bob could not export (${own.note})` };
      }
      genuine = analyse(
        parseBlob(locateBlob(await fs.readFile(own.file)).blob)
      );
      const heads = genuine
        .filter(g => g.linkedBy.length === 0)
        .map(g => g.digest)
        .sort();
      const forErin = await exportVia(demo, bob, erin);
      vias5.push(`export for Erin: ${forErin.how}`);
      if (forErin.file === undefined) {
        return {
          ok: false,
          detail: `Bob could not export for Erin (${forErin.note})`,
        };
      }
      const file = await fs.readFile(forErin.file);
      const sealed =
        asServedExport(file) !== undefined &&
        !file.toString('utf8').includes("who's bringing the tent?");
      const result = appendSealedFakes(
        file,
        aciBytes(aciOf(bob)),
        heads.map(h => Buffer.from(h, 'hex'))
      );
      fakes = result.fakes;
      const out = await dumpPath(demo, erin);
      await fs.writeFile(out, result.file);
      const bobHeads = await sortedHeads(demo, bob);
      return {
        ok: fakes.length === 2 && sealed && heads.join(',') === bobHeads,
        detail:
          `${genuine.length} genuine records; the export for Erin is ` +
          `${sealed ? 'sealed (no plaintext)' : 'NOT sealed'}; fakes ` +
          `${fakes.map(tag).join(' ')} on ${heads.map(tag).join(' ')}; -> ${out}`,
      };
    }
  );
  if (!doctored) {
    return;
  }
  const authorName = (a: Analysed) =>
    nameByAuthorHex.get(hex(a.parts.author)) ?? hex(a.parts.author).slice(0, 8);
  const fakeSet = new Set(fakes);

  const imported = await attempt(
    'beat5 Erin imports it: the fakes collapsed and unconfirmed',
    'zrdt',
    async () => {
      const imp = await importVia(demo, erin);
      vias5.push(`import: ${imp.how}`);
      const res = await until(CLASSIFY_MS, async () => {
        const state = await convState(demo, erin);
        const items = state?.unconfirmed ?? [];
        const onlyFakes =
          items.length === fakes.length &&
          items.every(i => fakeSet.has(i.digest));
        const allUnconfirmed = items.every(
          i => i.status.kind === 'unconfirmed'
        );
        return {
          ok: onlyFakes && allUnconfirmed,
          detail:
            `section holds ${items.length} (${items.filter(i => fakeSet.has(i.digest)).length} ` +
            `fakes), all unconfirmed=${allUnconfirmed}`,
        };
      });
      const title = unconfirmedSectionTitle(fakes.length);
      const onScreen = await visible(page(erin), title, UI_MS);
      return {
        ok: imp.status === 'ok' && res.ok && onScreen,
        detail: `import status=${imp.status} (${imp.note}); ${res.detail}; "${title}" ${onScreen ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  check(
    'beat5 presenter path: Settings → Internal buttons',
    'zrdt',
    vias5.length === 3 && vias5.every(v => v.endsWith('settings')),
    vias5.join(', ') || 'not reached'
  );
  // Open the section so the labels are on screen (one click in the demo).
  try {
    await page(erin)
      .locator('.ZrdtUnconfirmed__toggle')
      .first()
      .click({ timeout: UI_MS });
  } catch {
    say('could not expand the unconfirmed section on Erin');
  }
  await attempt(
    "beat5 Erin's history (caught up) shows its text; the fakes have none",
    'zrdt',
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const state = await convState(demo, erin);
      const items = state?.unconfirmed ?? [];
      const fakeText = items.filter(i => fakeSet.has(i.digest) && i.text);
      const rows = new Set(
        (await allMessages(demo, erin)).flatMap(m =>
          m.zrdtDigest ? [m.zrdtDigest] : []
        )
      );
      const shownGenuine = genuine.filter(g => rows.has(g.digest));
      const onScreen = await visible(
        page(erin),
        "who's bringing the tent?",
        UI_MS
      );
      return {
        ok:
          shownGenuine.length === genuine.length &&
          fakeText.length === 0 &&
          onScreen,
        detail:
          `${shownGenuine.length}/${genuine.length} genuine as messages, ` +
          `${fakeText.length} fakes with text; ` +
          `"who's bringing the tent?" ${onScreen ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  await screenshots(demo, four, 'beat5-imported');

  // Who vouches for the genuine history: its authors (author copies) or the
  // member who answered the catch-up. Never the fakes.
  const genuineOk = (s: { kind: string } | undefined, g: Analysed) =>
    s?.kind === 'confirmedByAuthor' ||
    (s?.kind === 'heldBy' && authorName(g) !== 'alice');

  // Alice writes.
  const fromAlice = {
    from: alice,
    text: 'welcome Erin! bring a headlamp',
    ts: 0,
  };
  fromAlice.ts = await send(alice, fromAlice.text);
  const erinGotAlice = await shown(erin, fromAlice.ts, fromAlice.text);
  check(
    "beat5 Alice's message reaches Erin",
    'harness',
    erinGotAlice,
    `erin=${erinGotAlice}`
  );
  await attempt(
    'beat5 Alice writes: the genuine history is vouched for, the fakes stay unconfirmed',
    'zrdt',
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const res = await until(CLASSIFY_MS, async () => {
        const state = await convState(demo, erin);
        const statuses = state?.statuses ?? {};
        const bad = [
          ...genuine
            .filter(g => !genuineOk(statuses[g.digest], g))
            .map(
              g =>
                `${tag(g.digest)}(${authorName(g)}) is ${statusText(statuses[g.digest])}`
            ),
          ...mismatches(
            statuses,
            fakes.map(f => ({ digest: f, who: 'fake', want: 'unconfirmed' }))
          ),
        ];
        return {
          ok: bad.length === 0,
          detail:
            bad.length === 0
              ? `${genuine.length + fakes.length} records as expected ` +
                `(caught up from ${relayer?.slice(0, 8) ?? '?'})`
              : `${bad.length} wrong: ${bad.slice(0, 4).join('; ')}`,
        };
      });
      const title = unconfirmedSectionTitle(fakes.length);
      const titled = await visible(page(erin), title, UI_MS);
      return {
        ok: res.ok && titled,
        detail: `${res.detail}; "${title}" ${titled ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  await screenshots(demo, four, 'beat5-alice');

  // Bob writes.
  const fromBob = { from: bob, text: "I'll drive Erin", ts: 0 };
  fromBob.ts = await send(bob, fromBob.text);
  const erinGotBob = await shown(erin, fromBob.ts, fromBob.text);
  check(
    "beat5 Bob's message reaches Erin",
    'harness',
    erinGotBob,
    `erin=${erinGotBob}`
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
        const state = await convState(demo, erin);
        const statuses = state?.statuses ?? {};
        const bad = mismatches(statuses, want);
        // Carol's: confirmed by her author copy, or held by a member.
        const notVouched = others.filter(
          g => !genuineOk(statuses[g.digest], g)
        );
        return {
          ok: bad.length === 0 && notVouched.length === 0,
          detail:
            (bad.length === 0
              ? `${want.length} Alice/Bob/fake records as expected`
              : `${bad.length} wrong: ${bad.slice(0, 4).join('; ')}`) +
            `; ${others.length - notVouched.length}/${others.length} others vouched for`,
        };
      });
      const notConfirmed = await visible(
        page(erin),
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

// --- beat 6: a member joins later (JOIN_PLAN) ------------------------------------

type CIMessage = MessageView & {
  type: string;
  sent_at: number;
  zrdtGap?: { state: string; missingDigests: Array<string> };
};

async function allMessages(demo: Demo, m: Member): Promise<Array<CIMessage>> {
  const r = await hook<Array<CIMessage>>(
    m,
    'allMessages',
    await conversationId(demo, m)
  );
  if (r.missing) {
    throw new Error('no allMessages hook');
  }
  return r.value;
}

type CatchUpView = {
  hasStore: boolean;
  relative: boolean;
  waiting: boolean;
  reason?: string;
  asked: Array<string>;
  answeredBy?: string;
  replies: number;
};

type ServedView = {
  responderAci: string;
  mode: string;
  wanted: Array<string>;
  entries: Array<{
    kind: string;
    digest?: string;
    hasOpening: boolean;
    authorCopy: boolean;
    result: string;
  }>;
};

type TablesView = {
  relative: boolean;
  records: Array<string>;
  pending: Array<string>;
  boundary: Array<{ digest: string; voucherAci: string }>;
};

async function hookValue<T>(
  demo: Demo,
  m: Member,
  name: string,
  ...args: ReadonlyArray<unknown>
): Promise<T> {
  const r = await hook<T>(m, name, await conversationId(demo, m), ...args);
  if (r.missing) {
    throw new Error(`no ${name} hook`);
  }
  return r.value;
}

const CATCH_UP_MS = 90_000;

async function beat6(demo: Demo): Promise<void> {
  const { alice, bob, carol, dave } = demo.byName;
  // The desktops linked so far (Erin's only if beat 5 ran).
  const old = linked(demo).filter(m => m !== dave);
  const aciOf = (m: Member) => m.boot.phone.device.aci.toLowerCase();

  // What the group holds before Dave joins: every message with a digest, at
  // Alice (who holds them all), Bob and Carol.
  const before = new Map<string, string>();
  for (const m of [alice, bob, carol]) {
    // oxlint-disable-next-line no-await-in-loop
    for (const msg of await allMessages(demo, m)) {
      if (msg.zrdtDigest && msg.body) {
        before.set(msg.zrdtDigest, msg.body);
      }
    }
  }
  const preDigests = new Set(before.keys());
  const preTexts = [...new Set(before.values())];
  check(
    'beat6 pre-join history to protect',
    'harness',
    preDigests.size >= 3,
    `${preDigests.size} messages (${preTexts.length} texts) before the add`
  );

  // Every desktop so far is a member's from the start: whatever opened its
  // store before its first catch-up reply, that reply (no boundary digest)
  // left it closed (JOIN_PLAN §6.1).
  await attempt(
    "beat6 the old desktops' stores are closed, none still waiting",
    'zrdt',
    async () =>
      until(CATCH_UP_MS, async () => {
        const states = await Promise.all(
          old.map(m => hookValue<CatchUpView>(demo, m, 'catchUpState'))
        );
        return {
          ok: states.every(st => st.hasStore && !st.relative && !st.waiting),
          detail: old
            .map(
              (m, i) =>
                `${m.name}: ${states[i]?.relative ? 'relative' : 'closed'}` +
                (states[i]?.waiting ? ' (waiting)' : '')
            )
            .join(', '),
        };
      })
  );

  // The add: Alice's phone adds Dave; every old desktop applies it.
  const added = await attempt(
    'beat6 Alice adds Dave; every old desktop sees him as a member',
    'harness',
    async () => {
      const revision = await addToGroup(demo, 'alice', 'dave');
      const res = await until(GROUP_UPDATE_MS, async () => {
        const seen = await Promise.all(
          old.map(async m =>
            (await hookValue<Array<string>>(demo, m, 'memberAcis'))
              .map(a => a.toLowerCase())
              .includes(aciOf(dave))
          )
        );
        return {
          ok: seen.every(Boolean),
          detail: old.map((m, i) => `${m.name}=${seen[i]}`).join(' '),
        };
      });
      return { ok: res.ok, detail: `revision ${revision}; ${res.detail}` };
    }
  );
  if (!added) {
    return;
  }

  // Post-join messages written before Dave's desktop exists: only the
  // catch-up can bring them to it.
  const postJoin: Array<Sent> = [];
  for (const [from, text] of [
    [bob, 'Dave is coming too'],
    [carol, 'great, two tents then'],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    const ts = await send(from, text);
    const sent = { from, text, ts };
    postJoin.push(sent);
    const others = old.filter(o => o !== from);
    // oxlint-disable-next-line no-await-in-loop
    const ok = await Promise.all(others.map(o => shown(o, ts, text)));
    check(
      `beat6 delivered "${text}"`,
      'harness',
      ok.every(Boolean),
      others.map((o, i) => `${o.name}=${ok[i]}`).join(' ')
    );
  }
  const five = await expectedAudience([...founders(demo), dave]);
  for (const sent of postJoin) {
    // oxlint-disable-next-line no-await-in-loop
    await audienceCommitted(
      `beat6 field 201 seats the five members "${sent.text}"`,
      sent,
      old,
      five
    );
  }

  // Dave links his desktop: no store, so it catches up from the adder. The
  // server holds everything for Alice, Bob and Carol meanwhile, his
  // catch-up request included, and Dave writes before any reply: the store
  // his send opens must still take the reply's boundary (the race the
  // fix-wave verifier found: it was closed, and his records linking older
  // history stayed pending for good).
  for (const name of ['alice', 'bob', 'carol']) {
    demo.server.arm(hold(name));
  }
  const linkedOk = await attempt(
    "beat6 Dave's desktop links and shows Camping",
    'harness',
    async () => {
      await linkDesktop(demo, 'dave');
      // Four windows at most side by side: five leave no room for the
      // composer. Erin's window stays where it is, under the others.
      await tile([alice, bob, carol, dave]);
      await openGroup(dave, demo.group);
      return { ok: true, detail: 'linked' };
    }
  );
  if (!linkedOk) {
    await demo.server.clear();
    return;
  }
  const four = linked(demo).filter(m => m !== dave);
  const early = { from: dave, text: 'hi all, dave here', ts: 0 };
  await attempt(
    'beat6 Dave writes before his catch-up has a reply (founders held): a relative store',
    'zrdt',
    async () => {
      const first = await hookValue<CatchUpView>(demo, dave, 'catchUpState');
      early.ts = await send(dave, early.text);
      const res = await until(UI_MS, async () => {
        const state = await hookValue<CatchUpView>(demo, dave, 'catchUpState');
        return {
          ok:
            first.replies === 0 &&
            state.replies === 0 &&
            state.hasStore &&
            state.relative &&
            state.waiting,
          detail:
            `before the send: replies=${first.replies} store=${first.hasStore}; ` +
            `after: store=${state.hasStore} relative=${state.relative} ` +
            `waiting=${state.waiting} replies=${state.replies}; ` +
            `held ${JSON.stringify(demo.server.heldCounts())}`,
        };
      });
      return res;
    }
  );
  const released = await demo.server.clear();
  say(`beat6: released ${released} held envelope(s)`);
  const caughtUp = await attempt(
    'beat6 catch-up: Dave asks Alice (the adder); her sealed SERVE reply fills a relative store',
    'zrdt',
    async () => {
      const res = await until(CATCH_UP_MS, async () => {
        const state = await hookValue<CatchUpView>(demo, dave, 'catchUpState');
        const ok =
          state.relative &&
          state.replies > 0 &&
          state.answeredBy?.toLowerCase() === aciOf(alice);
        return {
          ok,
          detail:
            `reason=${state.reason} relative=${state.relative} ` +
            `asked=${state.asked.map(a => a.slice(0, 8)).join(',')} ` +
            `answeredBy=${state.answeredBy?.slice(0, 8)} replies=${state.replies}`,
        };
      });
      const state = await hookValue<CatchUpView>(demo, dave, 'catchUpState');
      const firstAsked = state.asked[0]?.toLowerCase();
      return {
        ok: res.ok && firstAsked === aciOf(alice),
        detail: `${res.detail}; first asked ${firstAsked === aciOf(alice) ? 'Alice' : firstAsked}`,
      };
    }
  );

  await attempt(
    "beat6 Dave's early message reaches everyone; nothing pending, his heads equal Alice's",
    'zrdt',
    async () => {
      const got = await Promise.all(
        four.map(o => shown(o, early.ts, early.text, CATCH_UP_MS))
      );
      const res = await until(CATCH_UP_MS, async () => {
        const [a, d, tables, state] = await Promise.all([
          sortedHeads(demo, alice),
          sortedHeads(demo, dave),
          hookValue<TablesView>(demo, dave, 'tables'),
          hookValue<CatchUpView>(demo, dave, 'catchUpState'),
        ]);
        return {
          ok:
            a === d &&
            a.length > 0 &&
            tables.pending.length === 0 &&
            tables.relative &&
            tables.boundary.length > 0 &&
            !state.waiting,
          detail:
            `relative=${tables.relative} records=${tables.records.length} ` +
            `pending=${tables.pending.length} boundary=${tables.boundary.length} ` +
            `waiting=${state.waiting}; alice [${a.split(',').map(tag).join(' ')}] ` +
            `dave [${d.split(',').map(tag).join(' ')}]`,
        };
      });
      return {
        ok: got.every(Boolean) && res.ok,
        detail: `${four.map((o, i) => `${o.name}=${got[i]}`).join(' ')}; ${res.detail}`,
      };
    }
  );

  await attempt(
    'beat6 Dave holds every post-join message, with content and the same digest',
    'zrdt',
    async () => {
      const results = await Promise.all(
        postJoin.map(async sent => {
          const ok = await shown(dave, sent.ts, sent.text, CATCH_UP_MS);
          const [mine, alices] = await Promise.all([
            messageAt(dave, sent),
            messageAt(alice, sent),
          ]);
          return {
            ok:
              ok &&
              mine?.zrdtDigest !== undefined &&
              mine.zrdtDigest === alices?.zrdtDigest &&
              mine.zrdtOpening !== undefined,
            what: `"${sent.text}" ${ok ? 'shown' : 'missing'} ${mine?.zrdtDigest?.slice(0, 8)}/${alices?.zrdtDigest?.slice(0, 8)} ${mine?.label ?? ''}`,
          };
        })
      );
      return {
        ok: results.every(r => r.ok),
        detail: results.map(r => r.what).join('; '),
      };
    }
  );

  await attempt('beat6 Dave shows the boundary row', 'zrdt', async () => {
    const onScreen = await visible(page(dave), BOUNDARY_ROW_TEXT, UI_MS * 2);
    const rows = (
      await hookValue<Array<CIMessage>>(demo, dave, 'getGapRows')
    ).filter(r => r.zrdtGap?.state === 'boundary');
    const tables = await hookValue<TablesView>(demo, dave, 'tables');
    const boundaryPre = tables.boundary.filter(b => preDigests.has(b.digest));
    return {
      ok:
        onScreen &&
        rows.length === 1 &&
        tables.relative &&
        tables.boundary.length > 0 &&
        boundaryPre.length === tables.boundary.length,
      detail:
        `"${BOUNDARY_ROW_TEXT}" ${onScreen ? 'shown' : 'NOT shown'}; ` +
        `${rows.length} boundary row(s); ${tables.boundary.length} boundary digest(s), ` +
        `${boundaryPre.length} of them pre-join, vouched by ` +
        [...new Set(tables.boundary.map(b => b.voucherAci.slice(0, 8)))].join(
          ','
        ),
    };
  });
  await screenshots(demo, [...four, dave], 'beat6-caught-up');

  // Live messages, both ways (Dave's early one included).
  const live: Array<Sent> = [early];
  const fromAlice = { from: alice, text: 'Dave, bring a headlamp', ts: 0 };
  fromAlice.ts = await send(alice, fromAlice.text);
  live.push(fromAlice);
  const daveGot = await shown(dave, fromAlice.ts, fromAlice.text);
  check(
    "beat6 Alice's live message reaches Dave",
    'harness',
    daveGot,
    `dave=${daveGot}`
  );
  const fromDave = { from: dave, text: 'thanks, see you there', ts: 0 };
  fromDave.ts = await send(dave, fromDave.text);
  live.push(fromDave);
  const got = await Promise.all(
    four.map(o => shown(o, fromDave.ts, fromDave.text))
  );
  check(
    "beat6 Dave's message reaches everyone",
    'harness',
    got.every(Boolean),
    four.map((o, i) => `${o.name}=${got[i]}`).join(' ')
  );
  for (const sent of live) {
    // oxlint-disable-next-line no-await-in-loop
    await sameDigest(`beat6 same zrdtDigest "${sent.text}"`, sent, [
      ...four,
      dave,
    ]);
  }
  await attempt("beat6 Dave's heads equal Alice's", 'zrdt', async () => {
    const res = await until(CLASSIFY_MS, async () => {
      const [a, d] = await Promise.all([
        sortedHeads(demo, alice),
        sortedHeads(demo, dave),
      ]);
      return {
        ok: a === d && a.length > 0,
        detail: `alice [${a.split(',').map(tag).join(' ')}] dave [${d.split(',').map(tag).join(' ')}]`,
      };
    });
    return res;
  });

  // The adversarial request: Dave asks for a pre-join digest by itself.
  const [target] = [...before.entries()].filter(
    ([, text]) => text === "who's bringing the tent?"
  );
  const preDigest = target?.[0] ?? [...preDigests][0];
  for (const responder of [alice, bob]) {
    // oxlint-disable-next-line no-await-in-loop
    await attempt(
      `beat6 Dave asks ${responder.display} for a pre-join digest: a boundary digest only`,
      'zrdt',
      async () => {
        if (!caughtUp || preDigest === undefined) {
          return { ok: false, detail: 'skipped: no catch-up or no digest' };
        }
        const conv = await conversationId(demo, dave);
        const r = await hook(
          dave,
          'requestDigests',
          conv,
          responder.boot.phone.device.aci,
          [preDigest]
        );
        if (r.missing) {
          throw new Error('no requestDigests hook');
        }
        const res = await until(COMPARE_MS, async () => {
          const log = await hookValue<Array<ServedView>>(
            demo,
            dave,
            'servedLog'
          );
          const reply = log.find(
            item =>
              item.mode === 'perDigest' &&
              item.wanted.includes(preDigest) &&
              item.responderAci.toLowerCase() === aciOf(responder)
          );
          if (!reply) {
            return { ok: false, detail: 'no reply yet' };
          }
          const kinds = reply.entries.map(
            e =>
              `${e.kind}${e.hasOpening ? '+opening' : ''}:${e.digest ? tag(e.digest) : '?'}`
          );
          const ok =
            reply.entries.length === 1 &&
            reply.entries[0]?.kind === 'boundary' &&
            reply.entries[0]?.digest === preDigest &&
            !reply.entries.some(e => e.hasOpening || e.kind !== 'boundary');
          return {
            ok,
            detail: `asked ${tag(preDigest)}; reply [${kinds.join(' ')}]`,
          };
        });
        return res;
      }
    );
  }

  // The per-digest replies' boundary digests must not stick as heads: a
  // digest no record of Dave's links is not taken (JOIN_PLAN §4.4, §6.2).
  const headsEqual = (label: string) =>
    attempt(
      `beat6 Dave's heads still equal Alice's ${label}`,
      'zrdt',
      async () =>
        until(CLASSIFY_MS, async () => {
          const [a, d] = await Promise.all([
            sortedHeads(demo, alice),
            sortedHeads(demo, dave),
          ]);
          return {
            ok: a === d && a.length > 0,
            detail: `alice [${a.split(',').map(tag).join(' ')}] dave [${d.split(',').map(tag).join(' ')}]`,
          };
        })
    );
  await headsEqual('after the per-digest asks');

  // Exports (JOIN_PLAN §4.5). Bob's own export is his alone: its content is
  // sealed to his key, and Dave's import of it is refused, even with the
  // file's account rewritten to Dave's. Bob restores it himself. Bob's
  // export for Dave is SERVE for Dave, sealed to his key: only what Dave
  // was sent.
  const davePath = await dumpPath(demo, dave);
  // Texts long enough not to occur by chance (Bob's "me" would).
  const clearTexts = (bytes: Buffer<ArrayBuffer>): Array<string> =>
    preTexts.filter(t => t.length >= 8 && bytes.toString('utf8').includes(t));
  let ownExport: Buffer<ArrayBuffer> | undefined;
  await attempt(
    "beat6 Bob's own export: its content is sealed to his key (no text in the clear)",
    'zrdt',
    async () => {
      const own = await hook<string | undefined>(
        bob,
        'exportStore',
        await conversationId(demo, bob)
      );
      if (own.missing || own.value === undefined) {
        return { ok: false, detail: 'Bob could not export' };
      }
      ownExport = await fs.readFile(own.value);
      const plain = clearTexts(ownExport);
      const doc = JSON.parse(ownExport.toString('utf8')) as {
        zrdtDump?: number;
        account?: string;
        content?: { sealed?: string };
      };
      return {
        ok:
          doc.zrdtDump === 1 &&
          doc.account === aciOf(bob) &&
          typeof doc.content?.sealed === 'string' &&
          plain.length === 0,
        detail:
          `account ${doc.account === aciOf(bob) ? 'Bob' : String(doc.account)}; ` +
          `content ${typeof doc.content?.sealed === 'string' ? 'sealed' : 'NOT sealed'}; ` +
          `${plain.length} of ${preTexts.length} pre-join texts in the clear`,
      };
    }
  );
  const ownBytes = ownExport;
  for (const [what, rewrite] of [
    ["Bob's own export", false],
    ["Bob's own export with the account rewritten to Dave's", true],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    await attempt(
      `beat6 Dave imports ${what}: refused (another account's store)`,
      'zrdt',
      async () => {
        if (ownBytes === undefined) {
          return { ok: false, detail: 'no own export of Bob' };
        }
        const doc = JSON.parse(ownBytes.toString('utf8')) as Record<
          string,
          unknown
        >;
        if (rewrite) {
          doc.account = aciOf(dave);
        }
        await fs.writeFile(
          davePath,
          rewrite ? `${JSON.stringify(doc)}\n` : ownBytes
        );
        const status = await hookValue<string | undefined>(
          demo,
          dave,
          'importStore'
        );
        const line = await internalResult(dave);
        const tables = await hookValue<TablesView>(demo, dave, 'tables');
        const stored = tables.records.filter(d => preDigests.has(d));
        return {
          ok:
            status === undefined &&
            line.includes('refused') &&
            stored.length === 0,
          detail: `status=${String(status)}; "${line}"; pre-join records stored ${stored.length}`,
        };
      }
    );
  }
  await attempt(
    'beat6 Bob restores his own export: every opening kept',
    'zrdt',
    async () => {
      const status = await hookValue<string | undefined>(
        demo,
        bob,
        'importStore'
      );
      const line = await internalResult(bob);
      const m = /content: (\d+) kept, (\d+) refused/.exec(line);
      const kept = Number(m?.[1] ?? -1);
      const refused = Number(m?.[2] ?? -1);
      return {
        ok: status === 'ok' && kept >= preTexts.length && refused === 0,
        detail: `status=${String(status)}; "${line}"`,
      };
    }
  );
  await attempt(
    "beat6 Dave imports Bob's export for Dave: no pre-join content, no pre-join record",
    'zrdt',
    async () => {
      const exp = await exportVia(demo, bob, dave);
      if (exp.file === undefined) {
        return {
          ok: false,
          detail: `Bob could not export for Dave (${exp.note})`,
        };
      }
      const bytes = await fs.readFile(exp.file);
      const plain = clearTexts(bytes);
      await fs.writeFile(davePath, bytes);
      const imp = await importVia(demo, dave);
      const tables = await hookValue<TablesView>(demo, dave, 'tables');
      const stored = tables.records.filter(d => preDigests.has(d));
      const pending = tables.pending.filter(d => preDigests.has(d));
      const state = await convState(demo, dave);
      const items = state?.unconfirmed ?? [];
      const preItems = items.filter(
        i => preDigests.has(i.digest) || (i.text && preTexts.includes(i.text))
      );
      return {
        ok:
          asServedExport(bytes) !== undefined &&
          plain.length === 0 &&
          imp.status === 'ok' &&
          stored.length === 0 &&
          pending.length === 0 &&
          preItems.length === 0,
        detail:
          `export: ${exp.how}, ${plain.length} pre-join texts in the clear` +
          `${plain.length ? ` (${plain.join(', ')})` : ''}; ` +
          `import: ${imp.how} status=${imp.status} (${imp.note}); ` +
          `pre-join records ${stored.length}, pending ${pending.length}; ` +
          `unconfirmed section ${items.length} (pre-join ${preItems.length})`,
      };
    }
  );
  await headsEqual('after the import');

  // The target rule (JOIN_PLAN §8.3): a reaction or a pin names its target's
  // author and sent time, so one aimed at a pre-join message goes only to
  // that message's audience. The villain's server sees whom each send
  // addresses.
  const preSentAt = (await allMessages(demo, bob)).find(
    m => m.zrdtDigest === preDigest
  )?.sent_at;
  for (const [what, name, args] of [
    ['reacts to', 'react', ['👍']],
    ['pins', 'pin', []],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    await attempt(
      `beat6 Bob ${what} a pre-join message after the add: Dave is not addressed`,
      'zrdt',
      async () => {
        if (preSentAt === undefined) {
          return { ok: false, detail: 'no pre-join message at Bob' };
        }
        const r = await hook<number | undefined>(
          bob,
          name,
          await conversationId(demo, bob),
          preSentAt,
          ...args
        );
        if (r.missing || r.value === undefined) {
          return { ok: false, detail: `no ${name}` };
        }
        const ts = r.value;
        return until(DELIVERY_MS, async () => {
          const sends = demo.server.addressedAt(ts);
          const all = new Set(sends.flat());
          return {
            ok: all.has('alice') && all.has('carol') && !all.has('dave'),
            detail: `${sends.length} send(s) at ${ts}: [${sends
              .map(s => s.join(','))
              .join('] [')}]`,
          };
        });
      }
    );
  }

  // No pre-join content anywhere on Dave's desktop.
  await attempt(
    'beat6 Dave holds no pre-join content: messages table, zrdt tables, window',
    'zrdt',
    async () => {
      const scan = await hook<{
        scanned: number;
        hits: Array<{ text: string; type: string; where: string }>;
      }>(dave, 'scanMessages', preTexts);
      if (scan.missing) {
        throw new Error('no scanMessages hook');
      }
      const tables = await hookValue<TablesView>(demo, dave, 'tables');
      const stored = tables.records.filter(d => preDigests.has(d));
      const pending = tables.pending.filter(d => preDigests.has(d));
      const msgs = await allMessages(demo, dave);
      const withPreDigest = msgs.filter(
        m => m.zrdtDigest !== undefined && preDigests.has(m.zrdtDigest)
      );
      const onScreen = new Array<string>();
      for (const text of preTexts) {
        // oxlint-disable-next-line no-await-in-loop
        const n = await page(dave).getByText(text, { exact: true }).count();
        if (n > 0) {
          onScreen.push(text);
        }
      }
      const ok =
        scan.value.hits.length === 0 &&
        stored.length === 0 &&
        pending.length === 0 &&
        withPreDigest.length === 0 &&
        onScreen.length === 0;
      return {
        ok,
        detail:
          `scanned ${scan.value.scanned} message rows for ${preTexts.length} texts: ` +
          `${scan.value.hits.length} hits${scan.value.hits.length ? ` (${scan.value.hits.map(h => `"${h.text}" in ${h.where}`).join(', ')})` : ''}; ` +
          `zrdt_records ${tables.records.length} (pre-join ${stored.length}), ` +
          `zrdt_pending ${tables.pending.length} (pre-join ${pending.length}), ` +
          `boundary ${tables.boundary.length}; messages with a pre-join digest ${withPreDigest.length}; ` +
          `pre-join texts on screen ${onScreen.length}${onScreen.length ? ` (${onScreen.join(', ')})` : ''}`,
      };
    }
  );

  // Alice, Bob and Carol still hold everything.
  await attempt(
    'beat6 Alice, Bob and Carol still hold every message, before and after the add',
    'zrdt',
    async () => {
      const wanted = [
        ...preTexts,
        ...postJoin.map(x => x.text),
        ...live.map(x => x.text),
      ];
      const lacking = new Array<string>();
      for (const m of [alice, bob, carol]) {
        // oxlint-disable-next-line no-await-in-loop
        const scan = await hook<{
          hits: Array<{ text: string; where: string }>;
        }>(m, 'scanMessages', wanted);
        if (scan.missing) {
          throw new Error('no scanMessages hook');
        }
        const held = new Set(
          scan.value.hits.filter(h => h.where === 'body').map(h => h.text)
        );
        const missing = wanted.filter(t => !held.has(t));
        if (missing.length > 0) {
          lacking.push(
            `${m.name} lacks ${missing.map(t => `"${t}"`).join(', ')}`
          );
        }
      }
      return {
        ok: lacking.length === 0,
        detail:
          lacking.length === 0
            ? `${wanted.length} texts held by each`
            : lacking.join('; '),
      };
    }
  );
  await screenshots(demo, [...four, dave], 'beat6-done');
}

async function main(): Promise<void> {
  const onlyHarness = process.argv.includes('--only-harness');
  say(configureEnv());
  const artifacts = path.resolve(
    process.env.ZRDT_SMOKE_OUT ?? path.join(REPO, 'demo', 'artifacts', 'smoke')
  );
  const t0 = Date.now();
  // Erin is in the group from the start (beat 5); Dave joins in beat 6.
  const demo = await setUp({
    artifacts,
    founders: ['alice', 'bob', 'carol', 'erin'],
    late: [LATE],
  });
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
      (process.env.ZRDT_SMOKE_BEATS ?? '1,2,3,4,5,6')
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
    if (!onlyHarness && only.has('6')) {
      await timed('beat 6', () => beat6(demo));
    }
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
