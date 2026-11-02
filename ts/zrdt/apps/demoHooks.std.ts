// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Demo-only switches for the app beats (zrdt docs/apps/BUILD_M1.md §A.1:
// Dave plays a modified member). Every desktop of the demo inherits the
// harness's environment, so the switch is set per desktop through a CI hook
// (`SignalCI.zrdt.appsSetVillain`, ts/zrdt/ci.preload.ts), which exists only
// in CI builds: a shipped app has no way to turn it on.
//
// `tamper`: this desktop flips a byte of every piece opening it serves in a
// repair, after zrdtd built the reply and before the seal. The requester's
// PIECE_ACCEPT refuses the piece ("piece 7 from Dave failed its check").

export type DemoVillain = 'tamper';

let villain: DemoVillain | undefined;

export function setDemoVillain(mode: DemoVillain | undefined): void {
  villain = mode;
}

export function demoVillain(): DemoVillain | undefined {
  return villain;
}

export function isTamperVillain(): boolean {
  return villain === 'tamper';
}
