#!/usr/bin/env node
// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// PROTOTYPE (apps-map, docs/zrdt/FORK_MAP.md section 8): a stand-in for zbt
// and git-remote-zrdt. It talks to one desktop's local endpoint, found the
// way the M1 tools will find it:
//
//   ZRDT_SOCKET=<userData>/zrdt-apps.sock   (or ZRDT_URL=http://127.0.0.1:PORT)
//   ZRDT_TOKEN_FILE=<userData>/zrdt-apps-probe.token
//
//   node demo/app-probe-cli.mjs GET /received
//   node demo/app-probe-cli.mjs POST /send '{"groupId": "...", ...}'
//   node demo/app-probe-cli.mjs POST /send @file.json
//
// Prints the JSON reply; exits 1 on an HTTP error. No dependencies.

import http from 'node:http';
import { readFileSync } from 'node:fs';

const [method = 'GET', path = '/received', bodyArg] = process.argv.slice(2);
const { ZRDT_SOCKET, ZRDT_URL, ZRDT_TOKEN_FILE, ZRDT_NO_TOKEN } = process.env;
if (!ZRDT_SOCKET && !ZRDT_URL) {
  console.error('set ZRDT_SOCKET or ZRDT_URL');
  process.exit(2);
}
const token =
  ZRDT_NO_TOKEN === '1' || !ZRDT_TOKEN_FILE
    ? undefined
    : readFileSync(ZRDT_TOKEN_FILE, 'utf8').trim();
const body =
  bodyArg == null
    ? undefined
    : bodyArg.startsWith('@')
      ? readFileSync(bodyArg.slice(1), 'utf8')
      : bodyArg;

const url = ZRDT_URL ? new URL(ZRDT_URL) : undefined;
const req = http.request(
  {
    method,
    path,
    ...(ZRDT_SOCKET
      ? { socketPath: ZRDT_SOCKET }
      : { host: url.hostname, port: url.port }),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(process.env.ZRDT_ORIGIN ? { origin: process.env.ZRDT_ORIGIN } : {}),
      'content-type': 'application/json',
    },
  },
  res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      process.stdout.write(Buffer.concat(chunks).toString('utf8') + '\n');
      process.exitCode = res.statusCode === 200 ? 0 : 1;
    });
  }
);
req.on('error', error => {
  console.error(String(error));
  process.exitCode = 3;
});
req.end(body);
