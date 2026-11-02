// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The live demo harness (APP.md §8a, §9; AMENDMENTS A11).
//
// Brings up one EvilServer, four phones (Alice, Bob, Carol, Dave) in a group
// "Camping", links Alice's, Bob's and Carol's desktops, tiles them, sends one
// warm-up message from each (sender keys), and starts the villain's panel.
// No rule is armed. Dave's desktop is linked on demand, just before beat 5:
// the panel's "Link Dave's desktop" button (`POST /actions/link-dave`), or
// `--link-dave` (link right after the warm-up, for rehearsals). Dave is a
// member from the group's creation, so his new desktop, which has no store,
// would catch up from Alice by itself (zrdt JOIN_PLAN §6.1) within seconds.
// So the button first arms beat 5's villain rule, "Alice, Bob and Carol
// offline: hold Dave's catch-up" (demo/rules.ts holdCatchUp: every 1:1
// message to their desktops waits; group messages pass), shown on the panel
// and in the terminal: Dave's chat stays empty until he imports Bob's export
// for him. The panel's "clear (villain off)" releases it at the end of the
// beat and drops what it held (delivered late, the catch-up would add the
// history again). `--link-dave` arms nothing: Dave catches up from Alice.
//
// doctor.ts runs on the live exports by itself (RESTORE_PLAN.md §6): when
// Carol exports (Settings → Internal → Export store), one linked, non-head
// record is removed from her file in place (beat 4; the original is kept as
// .orig); when Bob exports for Dave (Settings → Internal → Export for: Dave →
// Export store: SERVE for Dave, sealed to Dave's key, JOIN_PLAN §4.5) and
// Dave's desktop is linked, two fakes by Bob are appended in a section sealed
// to Dave's key, and the result is written where Dave's "Import file" reads
// (beat 5). Bob's own export is not used: only Bob could import it.
// `--no-auto-doctor` turns this off (then use the panel's doctor actions).
//
// Run from the repository root (build zrdtd first: cd zrdt/core && lake build):
//   node --import tsx demo/launch.ts [--link-dave] [--no-auto-doctor]
//        [--port 7357] [--verbose] [--beat5]
//
// Then open the panel URL it prints. Ctrl-C (or POST /actions/quit) closes
// every desktop and the server. Artifacts (villain log, screenshots, desktop
// logs) go to demo/artifacts/demo/ (ZRDT_DEMO_OUT to change).
//
// `--beat5` is a check, not the demo: after READY it types the script's
// messages of beats 1 to 3, then plays beat 5 the way the presenter does
// (the panel's link-dave route, Bob's and Dave's Settings → Internal clicks,
// the auto-doctor, the toggle, Alice and Bob typing), checks what Dave's
// window shows at each step (demo/beat5.ts), and exits 0 only if every check
// passes.
//
// Environment: see demo/harness.ts (SIGNAL_MOCK_TESTS_BACKGROUND,
// ZRDT_DAEMON, ZRDT_RESEND_DELAY_MS); ZRDT_PANEL_PORT for the panel port.

import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getTimelineMessageWithText } from '../ts/test-mock/helpers.node.ts';
import { checkBeat5 } from './beat5.ts';
import type { DoctorEvent } from './beat5.ts';
import { formatEntry, holdCatchUp } from './evil.ts';
import { startPanel } from './panel.ts';
import type { PanelAction } from './panel.ts';
import {
  asServedExport,
  doctorAppend,
  doctorRemove,
  doctoredPath,
} from './doctor.ts';
import {
  REPO,
  configureEnv,
  conversationId,
  dumpPath,
  hook,
  linkDesktop,
  writeAppsEnv,
  linked,
  openGroup,
  page,
  restartDesktop,
  say,
  screenshots,
  send,
  setUp,
  tearDown,
  tile,
  warmUp,
} from './harness.ts';
import type { Demo, Member, MemberName } from './harness.ts';

const DEFAULT_PORT = 7357;

type Options = {
  linkDave: boolean;
  autoDoctor: boolean;
  port: number;
  verbose: boolean;
  beat5: boolean;
  // zrdt apps: each desktop runs its local endpoint (ZRDT_APPS=1), the group
  // "Code" (Alice, Bob, Carol) is made for the git beat, and
  // <artifacts>/apps-env/<member>.sh is written for the presenter.
  apps: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): Options {
  const opts: Options = {
    linkDave: false,
    autoDoctor: true,
    port: Number(process.env.ZRDT_PANEL_PORT ?? DEFAULT_PORT),
    verbose: false,
    beat5: false,
    apps: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--link-dave') {
      opts.linkDave = true;
    } else if (a === '--no-auto-doctor') {
      opts.autoDoctor = false;
    } else if (a === '--verbose') {
      opts.verbose = true;
    } else if (a === '--beat5') {
      opts.beat5 = true;
    } else if (a === '--apps') {
      opts.apps = true;
    } else if (a === '--port') {
      opts.port = Number(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  if (opts.beat5 && (opts.linkDave || !opts.autoDoctor)) {
    throw new Error(
      '--beat5 links Dave through the panel and relies on the auto-doctor: ' +
        'drop --link-dave and --no-auto-doctor'
    );
  }
  return opts;
}

function memberParam(demo: Demo, value: string | undefined): Member {
  const name = (value ?? '').trim().toLowerCase();
  if (!Object.hasOwn(demo.byName, name)) {
    throw new Error(`"${value}" is not a member (alice, bob, carol, dave)`);
  }
  return demo.byName[name as MemberName];
}

/** Throws a presenter-friendly error when `who` has not exported yet. */
async function needExport(file: string, who: string): Promise<string> {
  try {
    await fs.access(file);
  } catch {
    throw new Error(
      `${who} has not exported yet (Settings → Internal → Export); ` +
        `expected ${file}`
    );
  }
  return file;
}

/** A path from the panel; "~/" means the home directory. */
function fileParam(value: string): string {
  const v = value.trim();
  return v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v;
}

/**
 * Beat 5's doctoring: two fakes by Bob appended to Bob's export for Dave (in
 * a section sealed to Dave's key, on Bob's heads), written to `out`. Throws a
 * presenter-friendly error when `file` is not an export for Dave: Bob's own
 * export ("Export for: this account") is sealed to Bob's key and only Bob's
 * account may import it, so Dave's import would be refused.
 */
async function doctorBobsExportForDave(
  demo: Demo,
  file: string,
  out: string
): Promise<string> {
  const { bob, dave } = demo.byName;
  const doc = asServedExport(await fs.readFile(file));
  const daveAci = dave.boot.phone.device.aci.toLowerCase();
  if (doc?.to.toLowerCase() !== daveAci) {
    throw new Error(
      `${file} is ${doc ? `an export for ${doc.to}` : "Bob's own export"}, ` +
        'not one for Dave, who could not import it. Bob: Settings → ' +
        'Internal → Export for: Dave, then Export store again'
    );
  }
  return doctorAppend(file, bob.boot.phone.device.aci, out, {
    links: await bobHeads(demo),
  });
}

type AutoDoctor = Readonly<{
  stop: () => void;
  // What it did, oldest first (the --beat5 check waits on these).
  events: ReadonlyArray<DoctorEvent>;
}>;

/**
 * Watches Carol's and Bob's export files (once a second) and runs doctor.ts
 * on each new export: beat 4 removes a linked record from Carol's file in
 * place; beat 5 appends two fakes by Bob to Bob's export for Dave and writes
 * Dave's import path (only once Dave's desktop is linked; Bob's own export is
 * left alone, with a hint in the terminal).
 */
function startAutoDoctor(demo: Demo): AutoDoctor {
  const { carol, bob, dave } = demo.byName;
  const events = new Array<DoctorEvent>();
  const note = (event: DoctorEvent) => {
    events.push(event);
    say(`auto-doctor, ${event.what}: ${event.summary}`);
  };
  const seen = new Map<string, number>();
  let carolFile: string | undefined;
  let bobFile: string | undefined;
  let busy = false;
  const mtime = async (file: string): Promise<number | undefined> => {
    try {
      return (await fs.stat(file)).mtimeMs;
    } catch {
      return undefined;
    }
  };
  // True once per new version of `file` (and records it as seen).
  const fresh = async (file: string): Promise<boolean> => {
    const t = await mtime(file);
    if (t === undefined || seen.get(file) === t) {
      return false;
    }
    // Let the app finish writing: the same mtime twice, 300 ms apart.
    await new Promise(resolve => setTimeout(resolve, 300));
    if ((await mtime(file)) !== t) {
      return false;
    }
    seen.set(file, t);
    return true;
  };
  const tick = async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      carolFile ??= await dumpPath(demo, carol);
      bobFile ??= await dumpPath(demo, bob);
      if (await fresh(carolFile)) {
        await fs.copyFile(carolFile, `${carolFile}.orig`);
        const summary = await doctorRemove(carolFile, carolFile);
        const t = await mtime(carolFile);
        if (t !== undefined) {
          seen.set(carolFile, t);
        }
        note({ beat: 4, ok: true, what: "beat 4 (Carol's export)", summary });
      }
      if (dave.app && (await fresh(bobFile))) {
        const what = "beat 5 (Bob's export for Dave -> Dave)";
        try {
          const summary = await doctorBobsExportForDave(
            demo,
            bobFile,
            await dumpPath(demo, dave)
          );
          note({ beat: 5, ok: true, what, summary });
        } catch (error) {
          note({ beat: 5, ok: false, what, summary: errorText(error) });
        }
      }
    } catch (error) {
      say(`auto-doctor: ${String(error)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 1_000);
  say(
    "auto-doctor on: Carol's export loses a linked record; Bob's export for " +
      "Dave gains two fakes by Bob, written to Dave's import path"
  );
  return { stop: () => clearInterval(timer), events };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bob's heads (hex): an export for another member is sealed to that member's
 * key, so the doctor cannot read its records and puts the fakes on these.
 */
async function bobHeads(demo: Demo): Promise<Array<string>> {
  const { bob } = demo.byName;
  const r = await hook<Array<string>>(
    bob,
    'heads',
    await conversationId(demo, bob)
  );
  return r.missing ? [] : r.value;
}

/**
 * Beat 5's villain, armed before Dave's desktop links: "Alice, Bob and Carol
 * offline: hold Dave's catch-up" (demo/rules.ts). Says so in the terminal;
 * the panel lists it. Returns the rule's id.
 */
function armHoldCatchUp(demo: Demo): string {
  const rule = holdCatchUp('dave', demo.server.members);
  if (!demo.server.rules.some(r => r.id === rule.id)) {
    demo.server.arm(rule);
  }
  say(
    `villain: armed "${rule.id}" before Dave links; ` +
      'the panel\'s "clear (villain off)" releases it'
  );
  return rule.id;
}

function actions(demo: Demo, quit: () => void): Record<string, PanelAction> {
  const { byName } = demo;
  return {
    'link-dave': {
      label:
        "Link Dave's desktop (before beat 5; first arms \"hold Dave's " +
        'catch-up")',
      run: async () => {
        const rule = armHoldCatchUp(demo);
        const dave = await linkDesktop(demo, 'dave');
        await tile(linked(demo));
        await openGroup(dave, demo.group);
        return `armed ${rule}; Dave's desktop is linked and shows Camping`;
      },
    },
    export: {
      label:
        'Export a member\'s store; with "for", the export for that member ' +
        '(beat 5: member bob, for dave). Rehearsal; the demo clicks ' +
        'Settings → Internal',
      fields: ['member', 'for'],
      run: async p => {
        const m = memberParam(demo, p.member);
        const conv = await conversationId(demo, m);
        const forMember = p.for?.trim() ? memberParam(demo, p.for) : undefined;
        const r = forMember
          ? await hook<unknown>(
              m,
              'exportStoreFor',
              conv,
              forMember.boot.phone.device.aci.toLowerCase()
            )
          : await hook<unknown>(m, 'exportStore', conv);
        if (r.missing) {
          throw new Error('no window.SignalCI.zrdt export hook yet');
        }
        const kind = forMember ? `for ${forMember.name}` : 'own export';
        return `${m.name} (${kind}): ${JSON.stringify(r.value)} (${await dumpPath(demo, m)})`;
      },
    },
    import: {
      label: "Import into a member's chat (rehearsal)",
      fields: ['member'],
      run: async p => {
        const m = memberParam(demo, p.member);
        const r = await hook<unknown>(
          m,
          'importStore',
          await conversationId(demo, m)
        );
        if (r.missing) {
          throw new Error('no window.SignalCI.zrdt.importStore hook yet');
        }
        return `${m.name}: ${JSON.stringify(r.value)}`;
      },
    },
    'doctor-remove': {
      label:
        "Beat 4: remove a linked record from Carol's export (in place; " +
        'the original is kept as .orig). Automatic unless --no-auto-doctor',
      fields: ['file', 'digest'],
      run: async p => {
        const file = p.file?.trim()
          ? fileParam(p.file)
          : await needExport(await dumpPath(demo, byName.carol), 'Carol');
        await fs.copyFile(file, `${file}.orig`);
        return doctorRemove(file, file, p.digest?.trim() || undefined);
      },
    },
    'doctor-append': {
      label:
        "Beat 5: append two fakes by Bob to Bob's export for Dave, written " +
        "where Dave's desktop imports from. Automatic unless --no-auto-doctor",
      fields: ['file'],
      run: async p => {
        const file = p.file?.trim()
          ? fileParam(p.file)
          : await needExport(await dumpPath(demo, byName.bob), 'Bob');
        if (!byName.dave.app) {
          // Rehearsing the doctor alone: any export, next to the file.
          return doctorAppend(
            file,
            byName.bob.boot.phone.device.aci,
            doctoredPath(file),
            { links: await bobHeads(demo) }
          );
        }
        return doctorBobsExportForDave(
          demo,
          file,
          await dumpPath(demo, byName.dave)
        );
      },
    },
    send: {
      label: 'Send as member (rehearsal)',
      fields: ['member', 'text'],
      run: async p => {
        const m = memberParam(demo, p.member);
        const text = p.text?.trim();
        if (!text) {
          throw new Error('missing "text"');
        }
        const ts = await send(m, text);
        return `${m.name} sent "${text}" (ts ${ts})`;
      },
    },
    check: {
      label: "Is the text on a member's screen?",
      fields: ['member', 'text'],
      run: async p => {
        const m = memberParam(demo, p.member);
        const n = await getTimelineMessageWithText(
          page(m),
          p.text ?? ''
        ).count();
        return `${m.name}: ${n > 0 ? 'shown' : 'not shown'}`;
      },
    },
    restart: {
      label: "Restart a member's desktop",
      fields: ['member'],
      run: async p => {
        const m = memberParam(demo, p.member);
        await restartDesktop(demo, m.name);
        await tile(linked(demo));
        return `${m.name} restarted`;
      },
    },
    screenshot: {
      label: 'Screenshot all windows',
      run: async () => screenshots(demo, linked(demo), `shot-${Date.now()}`),
    },
    quit: {
      label: 'Quit (close every desktop)',
      run: async () => {
        setTimeout(quit, 100);
        return 'closing';
      },
    },
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  say(configureEnv());
  const artifacts = path.resolve(
    process.env.ZRDT_DEMO_OUT ?? path.join(REPO, 'demo', 'artifacts', 'demo')
  );

  let quit: () => void = () => undefined;
  const quitting = new Promise<void>(resolve => {
    quit = resolve;
  });
  process.once('SIGINT', () => quit());
  process.once('SIGTERM', () => quit());

  if (opts.apps) {
    // The desktops inherit this process's environment.
    process.env.ZRDT_APPS = '1';
  }
  const demo = await setUp({
    artifacts,
    verbose: opts.verbose,
    extraGroups: opts.apps
      ? [{ title: 'Code', founders: ['alice', 'bob', 'carol'] }]
      : [],
  });
  // Ctrl-C or `make stop`: Playwright's SIGINT handler exits (130) before
  // tearDown runs, so list the temporary folders (profiles, the mock CDN) for
  // run-demo.sh to remove once the desktops are gone.
  process.once('exit', () => {
    try {
      writeFileSync(
        path.join(artifacts, 'tmp-dirs.txt'),
        `${[...demo.profiles, demo.cdn3Path].join('\n')}\n`
      );
    } catch {
      // nothing to list
    }
  });
  let autoDoctor: AutoDoctor | undefined;
  let panel: Awaited<ReturnType<typeof startPanel>> | undefined;
  try {
    const { alice, bob, carol, dave } = demo.byName;
    const first = [alice, bob, carol];
    for (const m of first) {
      // oxlint-disable-next-line no-await-in-loop
      await linkDesktop(demo, m.name);
    }
    await tile(first);
    for (const m of first) {
      // oxlint-disable-next-line no-await-in-loop
      await openGroup(m, demo.group);
    }
    await warmUp(first);
    await screenshots(demo, first, 'ready');
    if (opts.apps) {
      for (const m of first) {
        // oxlint-disable-next-line no-await-in-loop
        const file = await writeAppsEnv(m, path.join(artifacts, 'apps-env'));
        say(`apps env: ${file}`);
      }
    }
    if (opts.autoDoctor) {
      autoDoctor = startAutoDoctor(demo);
    }

    if (opts.linkDave) {
      await linkDesktop(demo, 'dave');
      await tile(linked(demo));
      await openGroup(dave, demo.group);
    }

    panel = await startPanel({
      villain: demo.server,
      actions: actions(demo, quit),
      port: opts.port,
      onChange: what => say(`panel: ${what}`),
    });
    say(`READY. Villain panel: ${panel.url} (no rule armed)`);
    say(
      `ACIs: ${demo.members
        .map(m => `${m.name}=${m.boot.phone.device.aci}`)
        .join(' ')}`
    );
    if (opts.beat5 && autoDoctor) {
      const passed = await checkBeat5({
        demo,
        panelUrl: panel.url,
        doctorEvents: autoDoctor.events,
      });
      process.exitCode = passed ? 0 : 1;
      quit();
    }
    await quitting;
  } catch (error) {
    say(`FAILED: ${String((error as Error)?.stack ?? error)}`);
    process.exitCode = 1;
  } finally {
    say('closing');
    autoDoctor?.stop();
    await panel?.close();
    await fs.writeFile(
      path.join(artifacts, 'evil-log.txt'),
      `${demo.server.log.map(formatEntry).join('\n')}\n`
    );
    await tearDown(demo);
    say('closed');
  }
}

void main();
