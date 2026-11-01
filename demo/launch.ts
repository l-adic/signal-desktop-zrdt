// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The live demo harness (APP.md §8a, §9; AMENDMENTS A11).
//
// Brings up one EvilServer, four phones (Alice, Bob, Carol, Dave) in a group
// "Camping", links Alice's, Bob's and Carol's desktops, tiles them, sends one
// warm-up message from each (sender keys), and starts the villain's panel.
// No rule is armed. Dave's desktop is linked on demand, just before beat 5:
// the panel's "Link Dave's desktop" button, `POST /actions/link-dave`, or
// `--link-dave` (link right after the warm-up, for rehearsals).
//
// Run from the repository root (build zrdtd first: cd zrdt/core && lake build):
//   node --import tsx demo/launch.ts [--link-dave] [--port 7357] [--verbose]
//
// Then open the panel URL it prints. Ctrl-C (or POST /actions/quit) closes
// every desktop and the server. Artifacts (villain log, screenshots, desktop
// logs) go to artifacts/demo/ (ZRDT_DEMO_OUT to change).
//
// Environment: see demo/harness.ts (SIGNAL_MOCK_TESTS_BACKGROUND,
// ZRDT_DAEMON, ZRDT_RESEND_DELAY_MS); ZRDT_PANEL_PORT for the panel port.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getTimelineMessageWithText } from '../ts/test-mock/helpers.node.ts';
import { formatEntry } from './evil.ts';
import { startPanel } from './panel.ts';
import type { PanelAction } from './panel.ts';
import { doctorAppend, doctorRemove } from './doctor.ts';
import {
  REPO,
  configureEnv,
  linkDesktop,
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
  port: number;
  verbose: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): Options {
  const opts: Options = {
    linkDave: false,
    port: Number(process.env.ZRDT_PANEL_PORT ?? DEFAULT_PORT),
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--link-dave') {
      opts.linkDave = true;
    } else if (a === '--verbose') {
      opts.verbose = true;
    } else if (a === '--port') {
      opts.port = Number(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
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

// The newest *.zrdt file in the usual places, for an empty "file" field.
// TODO(zrdt T4): use the export lane's real default path once it lands.
async function latestExport(demo: Demo): Promise<string> {
  const dirs = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    demo.artifacts,
    os.tmpdir(),
  ];
  let best: { file: string; mtime: number } | undefined;
  for (const dir of dirs) {
    let names: Array<string> = [];
    try {
      // oxlint-disable-next-line no-await-in-loop
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names.filter(x => x.endsWith('.zrdt'))) {
      const file = path.join(dir, n);
      // oxlint-disable-next-line no-await-in-loop
      const { mtimeMs } = await fs.stat(file);
      if (!best || mtimeMs > best.mtime) {
        best = { file, mtime: mtimeMs };
      }
    }
  }
  if (!best) {
    throw new Error(`no .zrdt export found in ${dirs.join(', ')}`);
  }
  return best.file;
}

async function fileParam(
  demo: Demo,
  value: string | undefined
): Promise<string> {
  const v = value?.trim();
  if (!v) {
    return latestExport(demo);
  }
  return v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v;
}

function actions(demo: Demo, quit: () => void): Record<string, PanelAction> {
  const { byName } = demo;
  return {
    'link-dave': {
      label: "Link Dave's desktop (before beat 5)",
      run: async () => {
        const dave = await linkDesktop(demo, 'dave');
        await tile(linked(demo));
        await openGroup(dave, demo.group);
        return "Dave's desktop is linked and shows Camping";
      },
    },
    'doctor-remove': {
      label: 'Beat 4: remove a linked record from an export',
      fields: ['file', 'digest'],
      run: async p =>
        doctorRemove(
          await fileParam(demo, p.file),
          undefined,
          p.digest?.trim() || undefined
        ),
    },
    'doctor-append': {
      label: "Beat 5: append two fakes by Bob to Bob's export",
      fields: ['file'],
      run: async p =>
        doctorAppend(
          await fileParam(demo, p.file),
          byName.bob.boot.phone.device.aci
        ),
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
    process.env.ZRDT_DEMO_OUT ?? path.join(REPO, 'artifacts', 'demo')
  );

  let quit: () => void = () => undefined;
  const quitting = new Promise<void>(resolve => {
    quit = resolve;
  });
  process.once('SIGINT', () => quit());
  process.once('SIGTERM', () => quit());

  const demo = await setUp({ artifacts, verbose: opts.verbose });
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
    await quitting;
  } catch (error) {
    say(`FAILED: ${String((error as Error)?.stack ?? error)}`);
    process.exitCode = 1;
  } finally {
    say('closing');
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
