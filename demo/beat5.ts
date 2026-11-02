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
//      button sends): it first arms the villain's "Alice, Bob and Carol
//      offline: hold Dave's catch-up" (demo/rules.ts holdCatchUp), then
//      links. Dave is a member from the group's creation, so his new desktop
//      asks for the chat by itself (zrdt JOIN_PLAN §6.1); the villain holds
//      the request, and Dave's chat stays empty;
//   2. Bob: Settings → Internal → Export for: Dave → Export store, then the
//      Chats tab (SERVE for Dave, sealed to Dave's key, JOIN_PLAN §4.5);
//   3. the auto-doctor appends two fakes by Bob, sealed to Dave's key, and
//      writes Dave's import path;
//   4. Dave: Settings → Internal → Import file (the app goes back to the chat
//      by itself): accepted, not refused; all eleven imported messages (nine
//      genuine, two fakes by Bob) wait, unconfirmed, in the collapsed
//      section;
//   5. Dave: one click opens the section;
//   6. Alice types: it reaches Dave; the nine genuine messages are confirmed
//      (Alice holds them); the fakes stay unconfirmed;
//   7. Bob types: the fakes read "not confirmed by Bob";
//   8. the panel's "clear (villain off)" (POST /clear) releases the rule; it
//      drops what the rule held (the catch-up requests), so Dave's window
//      does not change: the fakes still read "not confirmed by Bob".
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
// Dave's new desktop asks for the chat within seconds of the link.
const CATCH_UP_MS = 20_000;
// After the release: time for anything delivered to show on Dave's screen.
const RELEASE_MS = 3_000;
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

type PanelRules = {
  rules: Array<{ id: string }>;
  held: Record<string, number>;
};

async function panelRules(panelUrl: string): Promise<PanelRules> {
  const res = await fetch(`${panelUrl}rules`);
  return (await res.json()) as PanelRules;
}

function heldTotal(held: Record<string, number>): number {
  return Object.values(held).reduce((a, b) => a + b, 0);
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

  // 1. The panel's "Link Dave's desktop" button: it arms "hold Dave's
  // catch-up" first.
  const linkStart = Date.now();
  let ruleId = '';
  const linkedOk = await run(
    'panel: Link Dave\'s desktop, after arming "hold Dave\'s catch-up"',
    async () => {
      const result = await post(panelUrl, 'actions/link-dave');
      const { rules } = await panelRules(panelUrl);
      ruleId = rules.find(r => r.id.includes("hold Dave's catch-up"))?.id ?? '';
      return {
        ok: dave.app !== undefined && ruleId !== '' && rules.length === 1,
        detail: `${result}; panel rules: ${rules.map(r => `"${r.id}"`).join(', ') || 'none'}`,
      };
    }
  );
  step("link Dave's desktop", linkStart);
  if (!historyOk || !linkedOk) {
    return finish();
  }
  await run(
    "Dave's new desktop asks for the chat; the villain holds it: Dave's chat stays empty",
    async () => {
      const res = await until(CATCH_UP_MS, async () => {
        const conv = await conversationId(demo, dave);
        const cu = await value<CatchUpView | undefined>(
          dave,
          'catchUpState',
          conv
        );
        const [{ held }, rows] = await Promise.all([
          panelRules(panelUrl),
          daveRows(),
        ]);
        const n = heldTotal(held);
        return {
          ok:
            cu !== undefined &&
            cu.asked.length > 0 &&
            cu.replies === 0 &&
            n > 0 &&
            rows.length === 0,
          detail:
            `asked ${cu?.asked.length ?? 0} member(s), ${cu?.replies ?? 0} replies; ` +
            `the villain holds ${n} envelope(s) (${JSON.stringify(held)}); ` +
            `Dave has ${rows.length} messages`,
        };
      });
      step("Dave's catch-up held (since the link click)", linkStart);
      const onScreen = await visible(page(dave), FIRST_LINE, 500);
      return {
        ok: res.ok && !onScreen,
        detail: `${res.detail}; "${FIRST_LINE}" ${onScreen ? 'SHOWN' : 'not shown'}`,
      };
    }
  );
  // The genuine history: what Alice holds (warm-ups and typed lines).
  const genuine = new Set(
    (
      await value<Array<MessageView>>(
        alice,
        'getMessages',
        await conversationId(demo, alice)
      )
    )
      .map(m => m.zrdtDigest ?? '')
      .filter(d => d !== '')
  );
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
  const importedCount = genuineCount + FAKES;
  await run(
    `after the import: all ${importedCount} messages unconfirmed in the collapsed section (${genuineCount} genuine with text, two fakes by Bob without)`,
    async () => {
      if (!imported) {
        return { ok: false, detail: 'skipped: the import failed' };
      }
      const res = await until(CLASSIFY_MS, async () => {
        const state = await daveState();
        const items = state?.unconfirmed ?? [];
        const fakeItems = items.filter(i => !genuine.has(i.digest));
        fakes = fakeItems.map(i => i.digest);
        const fakeOk =
          fakeItems.length === FAKES &&
          fakeItems.every(
            i =>
              i.attributedToAci?.toLowerCase() === aciOf(bob) &&
              !i.hasMessage &&
              i.text === undefined
          );
        const genuineItems = items.filter(i => genuine.has(i.digest));
        const genuineOk =
          genuine.size === genuineCount &&
          genuineItems.length === genuineCount &&
          genuineItems.every(i => i.text !== undefined);
        const allUnconfirmed = items.every(
          i => i.status.kind === 'unconfirmed'
        );
        return {
          ok:
            items.length === importedCount &&
            fakeOk &&
            genuineOk &&
            allUnconfirmed,
          detail:
            `section: ${items.length} (${genuineItems.length} genuine, ` +
            `${fakeItems.length} fakes ${fakeItems.map(i => tag(i.digest)).join(' ')}); ` +
            `statuses ${[...new Set(items.map(i => i.status.kind))].join(', ')}`,
        };
      });
      step('import classified (since the Import click)', importStart);
      const title = unconfirmedSectionTitle(importedCount);
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
    "Dave: one click opens the section: the history, and two entries attributed to Bob, '(content unavailable)'",
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
      const fakeTexts = texts.filter(t => t.includes('(content unavailable)'));
      const ok =
        texts.length === importedCount &&
        fakeTexts.length === FAKES &&
        fakeTexts.every(t => t.includes(`attributed to ${bob.display}`)) &&
        texts.some(t => t.includes(FIRST_LINE));
      return {
        ok,
        detail:
          `${texts.length} entries; ` +
          fakeTexts.map(t => t.replace(/\s+/g, ' ').trim()).join(' | '),
      };
    }
  );
  await screenshots(demo, linked(demo), 'beat5-imported');

  // 6. Alice types.
  const aliceStart = Date.now();
  await run(
    `Alice types "${ALICE_LINE}": it reaches Dave, confirmed; the genuine history is confirmed; the fakes stay unconfirmed`,
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
      const title = `Imported history: ${importedCount} messages`;
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

  // 8. The panel's "clear (villain off)": the rule is released, and what it
  // held is dropped.
  const releaseStart = Date.now();
  await run(
    `panel: clear (villain off) releases "${ruleId}"; Dave's window does not change`,
    async () => {
      const rowsBefore = (await daveRows()).length;
      const result = await post(panelUrl, 'clear');
      const after = await panelRules(panelUrl);
      await sleep(RELEASE_MS);
      const conv = await conversationId(demo, dave);
      const cu = await value<CatchUpView | undefined>(
        dave,
        'catchUpState',
        conv
      );
      const rowsAfter = (await daveRows()).length;
      const state = await daveState();
      const fakeKinds = fakes.map(f => state?.statuses[f]?.kind);
      const notVouched = [...genuine].filter(
        d => !VOUCHED.has(state?.statuses[d]?.kind ?? '')
      );
      const pills = await section
        .getByText(`not confirmed by ${bob.display}`)
        .count();
      const title = `Imported history: ${importedCount} messages`;
      const titled = await visible(page(dave), title);
      step('release (since the click)', releaseStart);
      return {
        ok:
          after.rules.length === 0 &&
          heldTotal(after.held) === 0 &&
          (cu?.replies ?? 0) === 0 &&
          rowsAfter === rowsBefore &&
          fakes.length === FAKES &&
          fakeKinds.every(k => k === 'notConfirmedByAuthor') &&
          notVouched.length === 0 &&
          pills === FAKES &&
          titled,
        detail:
          `"${result}"; panel: ${after.rules.length} rules, ` +
          `${heldTotal(after.held)} held; Dave: ${cu?.replies ?? 0} catch-up ` +
          `replies, ${rowsBefore} -> ${rowsAfter} messages in the timeline; ` +
          `fakes ${fakeKinds.join(', ')}; genuine confirmed ` +
          `${genuine.size - notVouched.length}/${genuine.size}; ` +
          `${pills} "not confirmed by ${bob.display}"; "${title}" ` +
          (titled ? 'shown' : 'NOT shown'),
      };
    }
  );
  await screenshots(demo, linked(demo), 'beat5-released');

  return finish();
}
