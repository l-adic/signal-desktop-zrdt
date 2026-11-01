// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Picks the zrdt backend (zrdt docs/PLAN.md section 3.3, host side):
// - $ZRDT_DAEMON set: the Lean daemon (zrdtd at that path), failing closed
//   if it does not answer within $ZRDT_DAEMON_TIMEOUT_MS (default 10 s);
// - otherwise the TypeScript stub, unless ZRDT_REQUIRE_LEAN=1, which refuses
//   it (the demo runs with ZRDT_REQUIRE_LEAN=1, so it shows `lean`).
// Throws a ZrdtBackendError('unavailable') when no backend may be used.

import { ZrdtBackendError } from './ZrdtBackend.std.ts';
import type { BackendKind, ZrdtBackend } from './ZrdtBackend.std.ts';
import { DaemonBackend, readDaemonTimeoutMs } from './backends/daemon.node.ts';
import { StubBackend } from './backends/stub.node.ts';

export type BackendEnv = Readonly<Record<string, string | undefined>>;

/** The kind the factory will try, for the badge when it fails. */
export function intendedBackendKind(
  env: BackendEnv = process.env
): BackendKind {
  if (env.ZRDT_DAEMON || env.ZRDT_REQUIRE_LEAN === '1') {
    return 'lean';
  }
  return 'stub';
}

export function createZrdtBackend(env: BackendEnv = process.env): ZrdtBackend {
  const daemon = env.ZRDT_DAEMON;
  if (daemon) {
    return new DaemonBackend({
      path: daemon,
      timeoutMs: readDaemonTimeoutMs(env),
    });
  }
  if (env.ZRDT_REQUIRE_LEAN === '1') {
    throw new ZrdtBackendError(
      'unavailable',
      'ZRDT_REQUIRE_LEAN=1 but ZRDT_DAEMON is not set'
    );
  }
  return new StubBackend({ env });
}
