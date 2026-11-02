// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Picks the zrdt backend (zrdt docs/PLAN.md section 3.3, host side). JOIN
// (zrdt docs/JOIN_PLAN.md) gates content with SERVE, which is proved only in
// the Lean daemon, so the app requires it:
// - $ZRDT_DAEMON set: the Lean daemon (zrdtd at that path), failing closed
//   if it does not answer within $ZRDT_DAEMON_TIMEOUT_MS (default 10 s);
// - otherwise the TypeScript stub only for tests: NODE_ENV=test, or
//   ZRDT_ALLOW_STUB=1 (the demo harness on the stub). ZRDT_REQUIRE_LEAN=1
//   refuses the stub even then.
// Throws a ZrdtBackendError('unavailable') when no backend may be used.

import { ZrdtBackendError } from './ZrdtBackend.std.ts';
import type { BackendKind, ZrdtBackend } from './ZrdtBackend.std.ts';
import { DaemonBackend, readDaemonTimeoutMs } from './backends/daemon.node.ts';
import { AppsStubBackend } from './backends/appsStub.node.ts';

export type BackendEnv = Readonly<Record<string, string | undefined>>;

/** The stub may run: a test, and the Lean daemon is not required. */
function stubAllowed(env: BackendEnv): boolean {
  if (env.ZRDT_REQUIRE_LEAN === '1') {
    return false;
  }
  return env.NODE_ENV === 'test' || env.ZRDT_ALLOW_STUB === '1';
}

/** The kind the factory will try, for the badge when it fails. */
export function intendedBackendKind(
  env: BackendEnv = process.env
): BackendKind {
  if (env.ZRDT_DAEMON || !stubAllowed(env)) {
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
  if (!stubAllowed(env)) {
    throw new ZrdtBackendError(
      'unavailable',
      'zrdt needs the Lean daemon: ZRDT_DAEMON is not set ' +
        '(the TypeScript stub runs only in tests)'
    );
  }
  // The protocol-5 stub: protocol 4 plus the app ops.
  return new AppsStubBackend({ env });
}
