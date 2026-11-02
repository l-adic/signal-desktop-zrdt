// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// PROTOTYPE (apps-map, docs/zrdt/FORK_MAP.md section 8): three desktops,
// Alice, Bob and Carol, in group "Camping" on the mock server (three, so that
// the group send takes the sender-key multi-recipient route: Desktop sends 1:1
// below two sender-key recipients). Alice's desktop uploads two pieces with
// fresh keys and sends one app-tagged Content 205 to the group; Bob's and
// Carol's desktops receive it outside the chat pipeline and download both
// pieces from the mock CDN. A stand-in CLI (demo/app-probe-cli.mjs) drives the
// desktops over their local endpoints: Alice on 127.0.0.1:7470 (TCP), Bob and
// Carol on <userData>/zrdt-apps.sock. Then the server deletes one CDN object
// and corrupts another, and Bob fetches again.
//
//   node --import tsx demo/appProbe.ts [--port 7470]
//
// Writes demo/artifacts/app-probe/result.json. Exit 0 only if every check passes.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  REPO,
  configureEnv,
  hook,
  linkDesktop,
  openGroup,
  say,
  send,
  setUp,
  shown,
  tearDown,
} from './harness.ts';
import type { Demo, Member } from './harness.ts';

const run = promisify(execFile);

const portArg = process.argv.indexOf('--port');
const PORT =
  portArg > 0
    ? Number(process.argv[portArg + 1])
    : Number(process.env.ZRDT_PANEL_PORT ?? 7470);

type Check = { name: string; ok: boolean; detail?: unknown };
const checks: Array<Check> = [];
function check(name: string, ok: boolean, detail?: unknown): boolean {
  checks.push({ name, ok, detail });
  say(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`
  );
  return ok;
}

type Endpoint = { socketPath: string; tokenPath: string; port?: number };

/** Runs the stand-in CLI as a child process, as zbt or git would run. */
async function cli(
  env: Record<string, string>,
  method: string,
  route: string,
  body?: unknown
): Promise<{ status: 'ok' | 'error'; value: unknown }> {
  const args = [path.join(REPO, 'demo', 'app-probe-cli.mjs'), method, route];
  let bodyFile: string | undefined;
  if (body !== undefined) {
    bodyFile = path.join(
      REPO,
      'demo',
      'artifacts',
      'app-probe',
      `body-${Date.now()}.json`
    );
    await fs.writeFile(bodyFile, JSON.stringify(body));
    args.push(`@${bodyFile}`);
  }
  try {
    const { stdout } = await run(process.execPath, args, {
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 'ok', value: JSON.parse(stdout) };
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    let value: unknown = stdout;
    try {
      value = JSON.parse(stdout);
    } catch {
      // not JSON
    }
    return { status: 'error', value };
  } finally {
    if (bodyFile) {
      await fs.rm(bodyFile, { force: true });
    }
  }
}

function sha(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function listenOn(m: Member, port?: number): Promise<Endpoint> {
  const result = await hook<Endpoint>(
    m,
    'appProbeListen',
    port == null ? {} : { port }
  );
  if (result.missing) {
    throw new Error(
      `${m.display}'s desktop has no appProbeListen hook (rebuild?)`
    );
  }
  return result.value;
}

type Received = {
  timestamp: number;
  senderAci: string;
  app: string;
  channel: string;
  body: string;
  isMember: boolean;
  roundTrip: boolean;
  appMessageBytes: number;
  done: boolean;
  pieces: Array<{
    cdnKey: string;
    ok: boolean;
    sha256?: string;
    error?: string;
    size: number;
    downloadMs: number;
  }>;
};

async function waitReceived(
  env: Record<string, string>,
  timestamp: number,
  timeoutMs = 60_000
): Promise<Received | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop
    const r = await cli(env, 'GET', '/received');
    if (r.status === 'ok') {
      const hit = (r.value as Array<Received>).find(
        x => x.timestamp === timestamp
      );
      if (hit?.done) {
        return hit;
      }
    }
    // oxlint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return undefined;
}

async function main(): Promise<void> {
  say(configureEnv());
  const artifacts = path.join(REPO, 'demo', 'artifacts', 'app-probe');
  let demo: Demo | undefined;
  const result: Record<string, unknown> = {};
  try {
    demo = await setUp({ artifacts, founders: ['alice', 'bob', 'carol'] });
    const { alice, bob, carol } = demo.byName;
    await linkDesktop(demo, 'alice');
    await linkDesktop(demo, 'bob');
    await linkDesktop(demo, 'carol');
    await openGroup(alice, demo.group);
    await openGroup(bob, demo.group);
    await openGroup(carol, demo.group);

    // The chat path still works with the patched receiver.
    const warm = 'warm-up from Alice';
    const warmTs = await send(alice, warm);
    check(
      'chat message still delivered (zrdt record path untouched)',
      await shown(bob, warmTs, warm)
    );

    // 1. The local endpoints: Alice on TCP, Bob on the Unix socket only.
    const aliceEp = await listenOn(alice, PORT);
    const bobEp = await listenOn(bob);
    const carolEp = await listenOn(carol);
    result.endpoints = { alice: aliceEp, bob: bobEp, carol: carolEp };
    check('Alice endpoint on 127.0.0.1', aliceEp.port === PORT, aliceEp);
    const sockStat = await fs.stat(bobEp.socketPath);
    const tokStat = await fs.stat(bobEp.tokenPath);
    check(
      'socket is a socket, mode 0600',
      sockStat.isSocket() && (sockStat.mode & 0o777) === 0o600,
      {
        mode: (sockStat.mode & 0o777).toString(8),
        pathLength: bobEp.socketPath.length,
      }
    );
    check('token file mode 0600', (tokStat.mode & 0o777) === 0o600);

    const aliceEnv = {
      ZRDT_URL: `http://127.0.0.1:${PORT}`,
      ZRDT_TOKEN_FILE: aliceEp.tokenPath,
    };
    const bobEnv = {
      ZRDT_SOCKET: bobEp.socketPath,
      ZRDT_TOKEN_FILE: bobEp.tokenPath,
    };
    const carolEnv = {
      ZRDT_SOCKET: carolEp.socketPath,
      ZRDT_TOKEN_FILE: carolEp.tokenPath,
    };

    const noToken = await cli(
      { ...aliceEnv, ZRDT_NO_TOKEN: '1' },
      'GET',
      '/received'
    );
    check(
      'request without the token refused',
      noToken.status === 'error',
      noToken.value
    );
    const browser = await cli(
      { ...aliceEnv, ZRDT_ORIGIN: 'http://evil.example' },
      'GET',
      '/received'
    );
    check(
      'request with an Origin header refused',
      browser.status === 'error',
      browser.value
    );
    const who = await cli(bobEnv, 'GET', '/whoami');
    check(
      'endpoint runs in the renderer (preload)',
      who.status === 'ok',
      who.value
    );

    // 2. Alice sends: two pieces, 1 MiB and 300 KiB.
    const piece0 = randomBytes(1024 * 1024);
    const piece1 = randomBytes(300 * 1024);
    const groupId = demo.group.id;
    const sendArgs = {
      groupId,
      app: 'bt',
      channel: 'files',
      body: 'probe: trip.bin',
      piecesBase64: [piece0.toString('base64'), piece1.toString('base64')],
    };
    const sent = await cli(aliceEnv, 'POST', '/send', sendArgs);
    result.sent = sent.value;
    if (
      !check(
        'Alice uploaded and sent',
        sent.status === 'ok',
        sent.status === 'ok' ? undefined : sent.value
      )
    ) {
      return;
    }
    const s = sent.value as {
      timestamp: number;
      contentBytes: number;
      pieces: Array<{
        cdnKey: string;
        ciphertextSize: number;
        sha256: string;
        size: number;
      }>;
    };
    check('Content 205 size', s.contentBytes < 64 * 1024, {
      contentBytes: s.contentBytes,
    });

    // The mock CDN holds one object per piece, of the ciphertext size.
    const cdnFiles = await Promise.all(
      s.pieces.map(async p => {
        const file = path.join(demo!.cdn3Path, 'attachments', p.cdnKey);
        const st = await fs.stat(file).catch(() => undefined);
        return { file, size: st?.size, want: p.ciphertextSize };
      })
    );
    result.cdnFiles = cdnFiles;
    check(
      'mock CDN objects exist with the ciphertext sizes',
      cdnFiles.every(f => f.size === f.want),
      cdnFiles
    );

    // 3. Bob receives and downloads, outside the chat pipeline.
    const got = await waitReceived(bobEnv, s.timestamp);
    result.received = got;
    if (
      !check(
        'Bob received the app message and fetched its pieces',
        got !== undefined
      )
    ) {
      return;
    }
    check(
      'app, channel, body as sent',
      got!.app === 'bt' &&
        got!.channel === 'files' &&
        got!.body === sendArgs.body
    );
    check(
      'sender is Alice, a member',
      got!.isMember && got!.senderAci === alice.boot.phone.device.aci
    );
    check(
      'bytes as sent re-encode identically (field 205 slice)',
      got!.roundTrip,
      {
        appMessageBytes: got!.appMessageBytes,
      }
    );
    check(
      'both pieces decrypt to the bytes Alice uploaded',
      got!.pieces.length === 2 &&
        got!.pieces[0]!.ok &&
        got!.pieces[1]!.ok &&
        got!.pieces[0]!.sha256 === sha(piece0) &&
        got!.pieces[1]!.sha256 === sha(piece1),
      got!.pieces
    );
    const gotCarol = await waitReceived(carolEnv, s.timestamp);
    check(
      'Carol received it and fetched both pieces',
      gotCarol !== undefined &&
        gotCarol.roundTrip &&
        gotCarol.pieces.every(p => p.ok) &&
        gotCarol.pieces[0]?.sha256 === sha(piece0)
    );
    // What the server saw: one sender-key multi-recipient send (one sendId,
    // both members addressed), one envelope per device.
    const seen = demo.server.log
      .filter(e => e.seen.ts === BigInt(s.timestamp))
      .map(e => ({
        to: e.seen.to,
        toDevice: e.seen.toDevice,
        type: e.seen.type,
        size: e.seen.size,
        sendId: e.seen.sendId,
        recipients: [...e.seen.recipients],
      }));
    result.serverSaw = seen;
    check(
      'one multi-recipient send reached Bob and Carol (sender key, sealed sender v2)',
      seen.length >= 2 &&
        new Set(seen.map(e => e.sendId)).size === 1 &&
        seen.every(e => e.recipients.length === 2),
      seen
    );
    const bobRows = await hook<Array<unknown>>(
      bob,
      'getMessagesBySentAt',
      s.timestamp
    );
    const aliceRows = await hook<Array<unknown>>(
      alice,
      'getMessagesBySentAt',
      s.timestamp
    );
    check(
      'no message row on either desktop (no timeline, no attachment job)',
      !bobRows.missing &&
        !aliceRows.missing &&
        bobRows.value.length === 0 &&
        aliceRows.value.length === 0
    );

    // 4. Fresh keys: the same bytes again get a new CDN object.
    const again = await cli(aliceEnv, 'POST', '/send', {
      ...sendArgs,
      piecesBase64: [piece1.toString('base64')],
    });
    const a = again.value as {
      timestamp: number;
      pieces: Array<{ cdnKey: string }>;
    };
    check(
      'same plaintext, new CDN object (no 3-day reuse)',
      again.status === 'ok' && a.pieces[0]!.cdnKey !== s.pieces[1]!.cdnKey,
      again.status === 'ok'
        ? { first: s.pieces[1]!.cdnKey, second: a.pieces[0]!.cdnKey }
        : again.value
    );
    if (again.status === 'ok') {
      const got2 = await waitReceived(bobEnv, a.timestamp);
      check('second app message received too', got2?.pieces[0]?.ok === true);
    }

    // 5. The villain: delete piece 0's CDN object, corrupt piece 1's.
    await fs.rm(cdnFiles[0]!.file);
    const blob = await fs.readFile(cdnFiles[1]!.file);
    blob[Math.floor(blob.length / 2)]! ^= 0x01;
    await fs.writeFile(cdnFiles[1]!.file, blob);
    const refetch = await cli(bobEnv, 'POST', '/refetch', {
      timestamp: s.timestamp,
    });
    result.refetch = refetch.value;
    const rf = refetch.value as Array<{ ok: boolean; error?: string }>;
    check(
      'deleted CDN object: download fails (404)',
      refetch.status === 'ok' && !rf[0]!.ok && /404/.test(rf[0]!.error ?? ''),
      rf[0]
    );
    check(
      'corrupted CDN object: Signal MAC/digest check fails',
      refetch.status === 'ok' && !rf[1]!.ok,
      rf[1]
    );
  } catch (error) {
    check('no exception', false, String((error as Error)?.stack ?? error));
  } finally {
    result.checks = checks;
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(
      path.join(artifacts, 'result.json'),
      JSON.stringify(result, null, 2)
    );
    if (demo) {
      await tearDown(demo);
    }
    const failed = checks.filter(c => !c.ok);
    say(`${checks.length - failed.length}/${checks.length} checks passed`);
    process.exitCode = failed.length === 0 && checks.length > 0 ? 0 : 1;
  }
}

void main();
