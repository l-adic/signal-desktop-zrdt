// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// zbt: share a file with a Signal group through zrdt, and watch it arrive
// (BUILD_M1 §A.1). It talks to the desktop's local endpoint only; the
// desktop asks the user before anything is shared.
//
//   zbt share <file> --group <group> [--name <name>]
//   zbt ls --group <group>
//   zbt status <file> --group <group> [--wait <seconds>]
//   zbt hello
//
// Options: --json (machine output), --endpoint <url|unix:path|file>,
// --token-file <path>. See tools/zbt/README.md.
//
// Exit status: 0 done; 1 refused, failed or not done in time; 2 usage;
// 3 the endpoint could not be used.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Discovery, FileJson } from './client.ts';
import {
  ZbtError,
  discover,
  hello,
  list,
  share,
  status,
  waitDone,
} from './client.ts';

export const USAGE = `usage:
  zbt share <file> --group <group> [--name <name>]
  zbt ls --group <group>
  zbt status <file> --group <group> [--wait <seconds>]
  zbt hello
options: --json, --endpoint <url|unix:path|file>, --token-file <path>`;

export type Args = Readonly<{
  command: string;
  positional: ReadonlyArray<string>;
  group?: string;
  name?: string;
  wait?: number;
  json: boolean;
  endpoint?: string;
  tokenFile?: string;
}>;

const VALUE_FLAGS = new Set([
  '--group',
  '--name',
  '--wait',
  '--endpoint',
  '--token-file',
]);

/** Parses argv (without node and the script); throws ZbtError('usage'). */
export function parseArgs(argv: ReadonlyArray<string>): Args {
  const positional: Array<string> = [];
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--json') {
      json = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ZbtError('usage', `${arg} needs a value`);
      }
      values.set(arg, value);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new ZbtError('usage', `unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  if (command === undefined) {
    throw new ZbtError('usage', 'no command');
  }
  const waitText = values.get('--wait');
  const wait = waitText === undefined ? undefined : Number(waitText);
  if (wait !== undefined && !(Number.isFinite(wait) && wait > 0)) {
    throw new ZbtError('usage', '--wait needs a number of seconds');
  }
  const args: Args = {
    command,
    positional: rest,
    group: values.get('--group'),
    name: values.get('--name'),
    wait,
    json,
    endpoint: values.get('--endpoint'),
    tokenFile: values.get('--token-file'),
  };
  const needs: Record<string, number> = {
    share: 1,
    ls: 0,
    status: 1,
    hello: 0,
  };
  const count = needs[command];
  if (count === undefined) {
    throw new ZbtError('usage', `unknown command ${command}`);
  }
  if (rest.length !== count) {
    throw new ZbtError('usage', `${command} takes ${count} argument(s)`);
  }
  if (command !== 'hello' && args.group === undefined) {
    throw new ZbtError('usage', `${command} needs --group`);
  }
  return args;
}

function size(bytes: number | null): string {
  if (bytes == null) {
    return '?';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const mib = bytes / 2 ** 20;
  return mib >= 1
    ? `${Math.round(mib * 10) / 10} MiB`
    : `${Math.round(bytes / 1024)} KiB`;
}

const CELL: Record<string, string> = {
  waiting: '.',
  uploading: '^',
  fetching: '~',
  checked: '#',
  missing: '?',
  asking: '?',
  unavailable: 'x',
};

/** A file in a few lines, for people. */
export function describe(f: FileJson): string {
  const who = f.self ? 'shared by you' : `from ${f.from}`;
  const id = f.file == null ? f.id : f.file.slice(0, 12);
  const lines = [
    `${f.name ?? '(a file)'}  ${size(f.size)}  ${who}  [${id}]`,
    `  ${f.pieceStates.map(s => CELL[s] ?? '?').join('')}  ${f.status}`,
  ];
  for (const r of f.resent) {
    const n = r.pieces.length;
    lines.push(
      `  ${n === 1 ? 'piece' : 'pieces'} ${r.pieces.join(', ')} resent by ${r.member}`
    );
  }
  for (const notice of f.notices) {
    lines.push(`  ! ${notice}`);
  }
  if (f.savedTo != null) {
    lines.push(`  saved to ${f.savedTo}`);
  }
  return lines.join('\n');
}

export type Io = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  out: (text: string) => void;
  err: (text: string) => void;
  readFile: (p: string) => Promise<Uint8Array<ArrayBuffer>>;
}>;

async function run(args: Args, d: Discovery, io: Io): Promise<number> {
  const group = args.group ?? '';
  switch (args.command) {
    case 'hello': {
      const body = await hello(d);
      io.out(
        args.json
          ? JSON.stringify(body)
          : `bt endpoint of ${String(body.member)}`
      );
      return 0;
    }
    case 'ls': {
      const body = await list(d, group);
      if (args.json) {
        io.out(JSON.stringify(body));
      } else if (body.files.length === 0) {
        io.out(`no files in ${body.group}`);
      } else {
        io.out(body.files.map(describe).join('\n'));
      }
      return 0;
    }
    case 'status': {
      const id = args.positional[0] ?? '';
      const f =
        args.wait === undefined
          ? await status(d, group, id)
          : await waitDone(d, group, id, args.wait * 1000);
      io.out(args.json ? JSON.stringify(f) : describe(f));
      return f.state === 'failed' ? 1 : 0;
    }
    case 'share': {
      const file = args.positional[0] ?? '';
      const name = args.name ?? path.basename(file);
      const bytes = await io.readFile(file);
      if (!args.json) {
        io.err(
          `handing ${name} (${size(bytes.byteLength)}) to Signal; confirm in the app`
        );
      }
      const result = await share(d, group, name, bytes);
      if (args.json) {
        io.out(JSON.stringify(result));
      } else if (result.status === 'ok') {
        io.out(
          `shared ${name} with ${result.audience} members [${result.file.slice(0, 12)}]`
        );
      } else {
        io.out(`not shared: ${result.message} (${result.reason})`);
      }
      return result.status === 'ok' ? 0 : 1;
    }
    default:
      throw new ZbtError('usage', `unknown command ${args.command}`);
  }
}

/** The whole CLI; returns the exit status. */
export async function main(
  argv: ReadonlyArray<string>,
  io: Io
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(`zbt: ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    const d = await discover(io.env, args);
    return await run(args, d, io);
  } catch (error) {
    if (error instanceof ZbtError) {
      io.err(`zbt: ${error.message} (${error.code})`);
      return error.code === 'timeout' || error.code === 'not_found' ? 1 : 3;
    }
    io.err(`zbt: ${(error as Error).stack ?? String(error)}`);
    return 3;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

async function cli(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    // oxlint-disable-next-line no-console
    out: text => console.log(text),
    // oxlint-disable-next-line no-console
    err: text => console.error(text),
    readFile: async p => new Uint8Array(await fs.readFile(p)),
  });
}

if (isMain) {
  void cli();
}
