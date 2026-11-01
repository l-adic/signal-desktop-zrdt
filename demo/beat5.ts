// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The --beat5 check of demo/launch.ts: beat 5 of the live demo (DEMO.md),
// played the way the presenter plays it, with what Dave's window must show
// checked at each step.
//
// After launch.ts is READY (Alice, Bob and Carol linked, warm-ups sent, the
// panel and the auto-doctor running), it types the script's messages of
// beats 1 to 3 (no villain: they only make the history), then:
//
//   1. the panel's "Link Dave's desktop" (POST /actions/link-dave, what the
//      button sends); Dave is a member from the group's creation, so his new
//      desktop catches up from Alice by itself (zrdt JOIN_PLAN §6.1);
//   2. Bob: Settings → Internal → Export for: Dave → Export store, then the
//      Chats tab (SERVE for Dave, sealed to Dave's key, JOIN_PLAN §4.5);
//   3. the auto-doctor appends two fakes by Bob, sealed to Dave's key, and
//      writes Dave's import path;
//   4. Dave: Settings → Internal → Import file (the app goes back to the chat
//      by itself): accepted, not refused; the two fakes wait, unconfirmed,
//      in the collapsed section; the genuine history is confirmed;
//   5. Dave: one click opens the section;
//   6. Alice types: it reaches Dave; the fakes stay unconfirmed;
//   7. Bob types: the fakes read "not confirmed by Bob".
//
// Writes beat5.json (checks and step timings) and screenshots (beat5-*.png)
// to the run's artifacts folder. Returns true only if every check passes.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Page } from 'playwright';

import { sleep } from '../ts/util/sleep.std.ts';
import { unconfirmedSectionTitle } from '../ts/zrdt/ui/labels.std.ts';
import { asServedExport } from './doctor.ts';
import {
  conversationId,
  dumpPath,
  hook,
  linked,
  page,
  say,
  screenshots,
  send,
  shown,
} from './harness.ts';
import type { Demo, Member, MemberName } from './harness.ts';

/** What the auto-doctor did (demo/launch.ts). */
export type DoctorEvent = Readonly<{
  beat: 4 | 5;
  ok: boolean;
  what: string;
  summary: string;
}>;

const FIRST_LINE = "who's bringing the tent?";
// The script's typed messages of beats 1 to 3 (DEMO.md), in order.
const HISTORY: ReadonlyArray<readonly [MemberName, string]> = [
  ['alice', FIRST_LINE],
  ['bob', 'me'],
  ['carol', 'I have the stove'],
  ['alice', 'actually I lost the tent poles'],
  ['bob', "I'll bring spares"],
  ['alice', 'meet at 9 at the trailhead'],
];
const ALICE_LINE = 'found the poles!';
const BOB_LINE = 'great, see you at 9';
const FAKES = 2;

// How long a zrdt control may take to show up.
const UI_MS = 5_000;
// Settings → Internal's result line after Export or Import.
const RESULT_MS = 15_000;
// Dave's catch-up: the first member asked has 15 s, then two more.
const CATCH_UP_MS = 45_000;
// The auto-doctor polls once a second.
const DOCTOR_MS = 10_000;
// CLASSIFY after an import or a live message, reaching the UI.
const CLASSIFY_MS = 20_000;

type Check = { id: string; ok: boolean; detail: string; ms: number };

type MessageView = {
  body?: string;
  zrdtDigest?: string;
};

type ConvState = {
  statuses: Record<string, { kind: string; aci?: string }>;
  unconfirmed: Array<{
    digest: string;
    status: { kind: string };
    hasMessage: boolean;
    text?: string;
    attributedToAci?: string;
  }>;
};

type CatchUpView = {
  hasStore: boolean;
  relative: boolean;
  asked: Array<string>;
  answeredBy?: string;
  replies: number;
};

const VOUCHED = new Set(['confirmedByAuthor', 'heldBy']);

function tag(digest: string): string {
  return `·${digest.slice(0, 4)}`;
}

async function value<T>(
  m: Member,
  name: string,
  ...args: Array<unknown>
): Promise<T> {
  const r = await hook<T>(m, name, ...args);
  if (r.missing) {
    throw new Error(`${m.display}: no window.SignalCI.zrdt.${name} hook`);
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

async function visible(
  p: Page,
  text: string,
  timeout = UI_MS
): Promise<boolean> {
  try {
    await p.getByText(text).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function post(panelUrl: string, route: string): Promise<string> {
  const res = await fetch(`${panelUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json()) as { ok: boolean; result?: string };
  if (!body.ok) {
    throw new Error(`panel ${route}: ${JSON.stringify(body)}`);
  }
  return body.result ?? '';
}

/** Settings → Internal in `m`'s window; returns the settings panel. */
async function openInternal(m: Member) {
  const p = page(m);
  await p.getByRole('tab', { name: 'Settings' }).click({ timeout: UI_MS });
  const settings = p.getByRole('tabpanel', { name: 'Settings' });
  await settings
    .getByRole('button', { name: 'Internal', exact: true })
    .click({ timeout: UI_MS });
  return settings;
}

/** Waits for Settings → Internal's result line to change from `before`. */
async function nextResult(m: Member, before: string): Promise<string> {
  const deadline = Date.now() + RESULT_MS;
  let line = (await value<string | undefined>(m, 'getInternalResult')) ?? '';
  while (line === before && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await sleep(100);
    // oxlint-disable-next-line no-await-in-loop
    line = (await value<string | undefined>(m, 'getInternalResult')) ?? '';
  }
  if (line === before) {
    throw new Error(`no new result line within ${RESULT_MS} ms`);
  }
  return line;
}

/** True once `m`'s window shows the chat again (no Settings, composer on). */
async function backInChat(m: Member, timeout: number): Promise<boolean> {
  const p = page(m);
  try {
    await p
      .getByRole('tabpanel', { name: 'Settings' })
      .waitFor({ state: 'detached', timeout });
    // As waitForEnabledComposer (ts/test-mock/helpers.node.ts), with a timeout.
    await p
      .locator('.ConversationView__composition-area')
      .locator('[data-testid=CompositionInput][data-enabled=true]')
      .waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

export async function checkBeat5({
  demo,
  panelUrl,
  doctorEvents,
}: Readonly<{
  demo: Demo;
  panelUrl: string;
  doctorEvents: ReadonlyArray<DoctorEvent>;
}>): Promise<boolean> {
  const { alice, bob, carol, dave } = demo.byName;
  const trio = [alice, bob, carol];
  const aciOf = (m: Member) => m.boot.phone.device.aci.toLowerCase();
  const checks: Array<Check> = [];
  const steps: Array<{ step: string; ms: number }> = [];
  const t0 = Date.now();

  const run = async (
    id: string,
    body: () => Promise<{ ok: boolean; detail: string }>
  ): Promise<boolean> => {
    const start = Date.now();
    let result: { ok: boolean; detail: string };
    try {
      result = await body();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      result = { ok: false, detail: `threw: ${text.split('\n')[0]}` };
    }
    const ms = Date.now() - start;
    checks.push({ id, ok: result.ok, detail: result.detail, ms });
    say(
      `${result.ok ? 'PASS' : 'FAIL'} beat5 ${id} (${(ms / 1000).toFixed(1)} s): ${result.detail}`
    );
    return result.ok;
  };
  const step = (name: string, start: number) => {
    steps.push({ step: name, ms: Date.now() - start });
  };
  const finish = async (): Promise<boolean> => {
    const failed = checks.filter(c => !c.ok);
    await fs.writeFile(
      path.join(demo.artifacts, 'beat5.json'),
      `${JSON.stringify({ ms: Date.now() - t0, checks, steps }, null, 2)}\n`
    );
    for (const s of steps) {
      say(`beat5 timing: ${s.step}: ${(s.ms / 1000).toFixed(1)} s`);
    }
    say(
      failed.length === 0
        ? `BEAT5 GO: all ${checks.length} checks passed`
        : `BEAT5 NO-GO: ${failed.length} of ${checks.length} checks failed: ` +
            failed.map(c => c.id).join('; ')
    );
    return failed.length === 0 && checks.length > 0;
  };

  const daveState = async () =>
    value<ConvState | undefined>(
      dave,
      'getConversationState',
      await conversationId(demo, dave)
    );
  const daveRows = async () =>
    (
      await value<Array<MessageView>>(
        dave,
        'getMessages',
        await conversationId(demo, dave)
      )
    ).filter(m => m.zrdtDigest);
  const sortedHeads = async (m: Member) =>
    [...(await value<Array<string>>(m, 'heads', await conversationId(demo, m)))]
      .sort()
      .join(',');

  // The chat as it stands before beat 5: the warm-ups and the typed lines of
  // beats 1 to 3.
  const historyOk = await run(
    'history: the typed lines of beats 1 to 3 reach Alice, Bob and Carol',
    async () => {
      const missing: Array<string> = [];
      for (const [name, text] of HISTORY) {
        const from = demo.byName[name];
        // oxlint-disable-next-line no-await-in-loop
        const ts = await send(from, text);
        const others = trio.filter(o => o !== from);
        // oxlint-disable-next-line no-await-in-loop
        const got = await Promise.all(others.map(o => shown(o, ts, text)));
        others.forEach((o, i) => {
          if (!got[i]) {
            missing.push(`${o.name} lacks "${text}"`);
          }
        });
      }
      return {
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `${HISTORY.length} messages`
            : missing.join('; '),
      };
    }
  );
  // Three warm-ups and the typed lines.
  const genuineCount = trio.length + HISTORY.length;

  // 1. The panel's "Link Dave's desktop" button; Dave catches up by himself.
  const linkStart = Date.now();
  const linkedOk = await run("panel: Link Dave's desktop", async () => {
    const result = await post(panelUrl, 'actions/link-dave');
    return { ok: dave.app !== undefined, detail: result };
  });
  step("link Dave's desktop", linkStart);
  if (!historyOk || !linkedOk) {
    return finish();
  }
  await run(
    `Dave's new desktop catches up from Alice by itself: ${genuineCount} messages, Alice's heads`,
    async () => {
      const res = await until(CATCH_UP_MS, async () => {
        const conv = await conversationId(demo, dave);
        const cu = await value<CatchUpView>(dave, 'catchUpState', conv);
        const [a, d, rows] = await Promise.all([
          sortedHeads(alice),
          sortedHeads(dave),
          daveRows(),
        ]);
        return {
          ok:
            cu.hasStore &&
            !cu.relative &&
            cu.replies > 0 &&
            a.length > 0 &&
            a === d &&
            rows.length === genuineCount,
          detail:
            `answered by ${cu.answeredBy === aciOf(alice) ? 'Alice' : cu.answeredBy} ` +
            `(${cu.replies} replies), ${rows.length} messages, ` +
            `heads ${a === d ? 'equal to' : 'NOT equal to'} Alice's`,
        };
      });
      step('Dave caught up (since the link click)', linkStart);
      const onScreen = await visible(page(dave), FIRST_LINE);
      return {
        ok: res.ok && onScreen,
        detail: `${res.detail}; "${FIRST_LINE}" ${onScreen ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  const genuine = new Set((await daveRows()).map(m => m.zrdtDigest ?? ''));
  await screenshots(demo, linked(demo), 'beat5-linked');

  // 2. Bob: Settings → Internal → Export for: Dave → Export store → Chats.
  const bobFile = await dumpPath(demo, bob);
  const doctorSeen = doctorEvents.filter(e => e.beat === 5).length;
  const exportStart = Date.now();
  const exported = await run(
    'Bob: Settings → Internal → Export for: Dave → Export store, back to Chats',
    async () => {
      const before =
        (await value<string | undefined>(bob, 'getInternalResult')) ?? '';
      const settings = await openInternal(bob);
      await settings
        .getByLabel('Export for')
        .selectOption({ label: dave.display }, { timeout: UI_MS });
      await settings
        .getByRole('button', { name: 'Export store', exact: true })
        .click({ timeout: UI_MS });
      const line = await nextResult(bob, before);
      await page(bob).getByRole('tab', { name: 'Chats' }).click();
      const chat = await backInChat(bob, UI_MS);
      const file = await fs.readFile(bobFile);
      const doc = asServedExport(file);
      const text = file.toString('utf8');
      // The longer lines only: "me" is in every file.
      const plaintext = HISTORY.filter(
        ([, t]) => t.length > 4 && text.includes(t)
      ).length;
      let kind = "Bob's own export";
      if (doc) {
        kind = `an export for ${doc.to.toLowerCase() === aciOf(dave) ? 'Dave' : doc.to}`;
      }
      return {
        ok:
          line.startsWith(`Exported for ${dave.display}:`) &&
          doc?.to.toLowerCase() === aciOf(dave) &&
          plaintext === 0 &&
          chat,
        detail:
          `"${line.replace(/ to \/.*$/, '')}"; the file is ${kind}` +
          ` with ${plaintext} typed lines in the clear; ` +
          `Bob ${chat ? 'is back in the chat' : 'is NOT back in the chat'}`,
      };
    }
  );
  step('Bob exports for Dave (clicks to result)', exportStart);

  // 3. The auto-doctor: two fakes by Bob, sealed to Dave's key.
  const doctored = await run(
    "auto-doctor appends two fakes by Bob to the export for Dave, at Dave's import path",
    async () => {
      if (!exported) {
        return { ok: false, detail: 'skipped: no export for Dave' };
      }
      const deadline = Date.now() + DOCTOR_MS;
      let event: DoctorEvent | undefined;
      while (event === undefined && Date.now() < deadline) {
        event = doctorEvents.filter(e => e.beat === 5)[doctorSeen];
        if (event === undefined) {
          // oxlint-disable-next-line no-await-in-loop
          await sleep(200);
        }
      }
      step('auto-doctor (after the export)', exportStart);
      if (!event) {
        return {
          ok: false,
          detail: `no beat-5 doctoring within ${DOCTOR_MS} ms`,
        };
      }
      const [original, out] = await Promise.all([
        fs.readFile(bobFile),
        fs.readFile(await dumpPath(demo, dave)),
      ]);
      const before = asServedExport(original)?.sections.length ?? 0;
      const after = asServedExport(out);
      return {
        ok:
          event.ok &&
          after?.to.toLowerCase() === aciOf(dave) &&
          after.sections.length === before + 1,
        detail: `${event.summary.replace(/; wrote .*$/, '')}; Dave's file: ${after?.sections.length ?? 'no'} sealed sections (Bob's: ${before})`,
      };
    }
  );

  // 4. Dave: Settings → Internal → Import file; back to the chat by itself.
  const importStart = Date.now();
  const imported = await run(
    'Dave: Settings → Internal → Import file: accepted (not refused), back in the chat',
    async () => {
      if (!doctored) {
        return { ok: false, detail: 'skipped: no doctored file' };
      }
      const before =
        (await value<string | undefined>(dave, 'getInternalResult')) ?? '';
      const settings = await openInternal(dave);
      await settings
        .getByRole('button', { name: 'Import file', exact: true })
        .click({ timeout: UI_MS });
      const line = await nextResult(dave, before);
      const chat = await backInChat(dave, UI_MS);
      return {
        ok: line.includes(': ok (') && !line.includes(' refused: ') && chat,
        detail:
          `"${line.replace(/^Import of \S+/, 'Import')}"; ` +
          `Dave ${chat ? 'is back in the chat by itself' : 'is NOT back in the chat'}`,
      };
    }
  );
  step('Dave imports (clicks to result)', importStart);

  let fakes: Array<string> = [];
  const section = page(dave).locator('.ZrdtUnconfirmed');
  await run(
    'after the import: the two fakes by Bob are unconfirmed, in the collapsed section; the genuine history is confirmed',
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const res = await until(CLASSIFY_MS, async () => {
        const state = await daveState();
        const items = state?.unconfirmed ?? [];
        fakes = items.map(i => i.digest);
        const fakeOk =
          items.length === FAKES &&
          items.every(
            i =>
              i.status.kind === 'unconfirmed' &&
              i.attributedToAci?.toLowerCase() === aciOf(bob) &&
              !i.hasMessage &&
              i.text === undefined &&
              !genuine.has(i.digest)
          );
        const notVouched = [...genuine].filter(
          d => !VOUCHED.has(state?.statuses[d]?.kind ?? '')
        );
        return {
          ok: fakeOk && notVouched.length === 0,
          detail: `section: ${items.length} (${items
            .map(i => `${tag(i.digest)} ${i.status.kind}`)
            .join(
              ', '
            )}); genuine confirmed ${genuine.size - notVouched.length}/${genuine.size}`,
        };
      });
      step('import classified (since the Import click)', importStart);
      const title = unconfirmedSectionTitle(FAKES);
      const titled = await visible(page(dave), title);
      const collapsed =
        (await section
          .locator('.ZrdtUnconfirmed__toggle')
          .getAttribute('aria-expanded', { timeout: UI_MS })) === 'false';
      return {
        ok: res.ok && titled && collapsed,
        detail: `${res.detail}; "${title}" ${titled ? 'shown' : 'NOT shown'}, ${collapsed ? 'collapsed' : 'NOT collapsed'}`,
      };
    }
  );

  // 5. Dave: one click opens the section.
  await run(
    "Dave: one click opens the section: two entries attributed to Bob, '(content unavailable)'",
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      await section
        .locator('.ZrdtUnconfirmed__toggle')
        .click({ timeout: UI_MS });
      const items = section.locator('.ZrdtUnconfirmed__item');
      await items.first().waitFor({ timeout: UI_MS });
      const texts = await items.allInnerTexts();
      const ok =
        texts.length === FAKES &&
        texts.every(
          t =>
            t.includes(`attributed to ${bob.display}`) &&
            t.includes('(content unavailable)')
        );
      return {
        ok,
        detail: texts.map(t => t.replace(/\s+/g, ' ').trim()).join(' | '),
      };
    }
  );
  await screenshots(demo, linked(demo), 'beat5-imported');

  // 6. Alice types.
  const aliceStart = Date.now();
  await run(
    `Alice types "${ALICE_LINE}": it reaches Dave, confirmed; the fakes stay unconfirmed`,
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const ts = await send(alice, ALICE_LINE);
      const got = await shown(dave, ts, ALICE_LINE);
      const res = await until(CLASSIFY_MS, async () => {
        const state = await daveState();
        const rows = await daveRows();
        const hers = rows.find(r => r.body === ALICE_LINE)?.zrdtDigest;
        const hersKind = hers ? state?.statuses[hers]?.kind : undefined;
        const fakeKinds = fakes.map(f => state?.statuses[f]?.kind);
        const notVouched = [...genuine].filter(
          d => !VOUCHED.has(state?.statuses[d]?.kind ?? '')
        );
        return {
          ok:
            hersKind === 'confirmedByAuthor' &&
            fakes.length === FAKES &&
            fakeKinds.every(k => k === 'unconfirmed') &&
            notVouched.length === 0,
          detail:
            `her message ${hersKind ?? 'not there'}; fakes ${fakeKinds.join(', ')}; ` +
            `genuine confirmed ${genuine.size - notVouched.length}/${genuine.size}`,
        };
      });
      step("Alice's message classified on Dave (since Enter)", aliceStart);
      const title = unconfirmedSectionTitle(FAKES);
      const titled = await visible(page(dave), title);
      return {
        ok: got && res.ok && titled,
        detail: `${got ? 'reached Dave' : 'did NOT reach Dave'}; ${res.detail}; "${title}" ${titled ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  await screenshots(demo, linked(demo), 'beat5-alice');

  // 7. Bob types.
  const bobStart = Date.now();
  await run(
    `Bob types "${BOB_LINE}": the two fakes read "not confirmed by Bob"`,
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const ts = await send(bob, BOB_LINE);
      const got = await shown(dave, ts, BOB_LINE);
      const res = await until(CLASSIFY_MS, async () => {
        const state = await daveState();
        const fakeKinds = fakes.map(f => state?.statuses[f]?.kind);
        const notVouched = [...genuine].filter(
          d => !VOUCHED.has(state?.statuses[d]?.kind ?? '')
        );
        return {
          ok:
            fakes.length === FAKES &&
            fakeKinds.every(k => k === 'notConfirmedByAuthor') &&
            notVouched.length === 0,
          detail: `fakes ${fakeKinds.join(', ')}; genuine confirmed ${genuine.size - notVouched.length}/${genuine.size}`,
        };
      });
      step("Bob's message classified on Dave (since Enter)", bobStart);
      const pills = section.getByText(`not confirmed by ${bob.display}`);
      let shownPills = 0;
      const deadline = Date.now() + UI_MS;
      while (shownPills < FAKES && Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop
        shownPills = await pills.count();
        if (shownPills < FAKES) {
          // oxlint-disable-next-line no-await-in-loop
          await sleep(200);
        }
      }
      const title = `Imported history: ${FAKES} messages`;
      const titled = await visible(page(dave), title);
      return {
        ok: got && res.ok && shownPills === FAKES && titled,
        detail:
          `${got ? 'reached Dave' : 'did NOT reach Dave'}; ${res.detail}; ` +
          `${shownPills} "not confirmed by ${bob.display}" on screen; "${title}" ${titled ? 'shown' : 'NOT shown'}`,
      };
    }
  );
  await screenshots(demo, linked(demo), 'beat5-bob');

  return finish();
}
