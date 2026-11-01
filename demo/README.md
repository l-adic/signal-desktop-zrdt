<!-- Copyright 2026 zrdt contributors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# demo/: the villain, the launch harness, the doctor, the smoke test

Everything here runs from the repository root with Node 24 and `tsx`. Build
`zrdtd` first: `cd zrdt/core && lake build` (the harness finds
`zrdt/core/.lake/build/bin/zrdtd`; set `ZRDT_DAEMON` to use another one).

| File         | What it does                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rules.ts`   | the villain's rules as pure functions: `dropGroupMsg(from, to)` (once, sends to ≥ 2 accounts from the inferred sender), `blackhole(to)`, `hold(to)`                |
| `evil.ts`    | `EvilServer`: Signal's mock server with the rules in front of the linked desktops (`handleMessage` + `prepareMultiDeviceMessage`); `arm`, `release(to)`, `clear()` |
| `panel.ts`   | the control panel: HTTP on 127.0.0.1 and a one-page HTML front end                                                                                                 |
| `harness.ts` | the demo world: four phones (Alice, Bob, Carol, Dave), group "Camping", link, tile, warm-up, restart, teardown                                                     |
| `launch.ts`  | the live demo: links Alice, Bob, Carol; warms up; starts the panel; links Dave on demand                                                                           |
| `doctor.ts`  | beats 4 and 5: edits an exported store                                                                                                                             |
| `smoke.ts`   | the F2 go/no-go test: beats 1–3 through the harness and the panel                                                                                                  |

## Live demo

```sh
node --import tsx demo/launch.ts          # add --link-dave to link Dave at once
# open the panel URL it prints (default http://127.0.0.1:7357/)
```

It sets `SIGNAL_MOCK_TESTS_BACKGROUND=1`, `ZRDT_DAEMON`,
`ZRDT_RESEND_DELAY_MS=4000` and `ZRDT_AUTHOR_FASTPATH_DELAY_MS=3000` (beat 2:
"relayed by Bob" shows about 3 s before "confirmed by Alice") for the desktops
(an existing value wins). Startup to READY takes about 7 s on the Mac mini.
Ctrl-C closes everything.

Panel routes (also usable with curl):

```sh
P=http://127.0.0.1:7357
curl -X POST "$P/rules/dropGroupMsg?from=alice&to=carol"   # beat 2
curl -X POST "$P/rules/blackhole?to=carol"                 # beat 3
curl -X POST "$P/rules/hold?to=carol"; curl -X POST "$P/rules/release?to=carol"
curl -X POST "$P/clear"                                    # villain off, held mail delivered
curl "$P/rules"; curl "$P/log?n=50"
curl -X POST "$P/actions/link-dave"                        # just before beat 5
curl -X POST "$P/actions/export" -d '{"member":"carol"}'    # rehearsal: the T3 export hook
curl -X POST "$P/actions/doctor-remove"                    # beat 4, on Carol's export, in place
curl -X POST "$P/actions/import" -d '{"member":"carol"}'
curl -X POST "$P/actions/export" -d '{"member":"bob"}'
curl -X POST "$P/actions/doctor-append"                    # beat 5: Bob's export -> Dave's import path
curl -X POST "$P/actions/import" -d '{"member":"dave"}'
curl -X POST "$P/actions/send" -d '{"member":"alice","text":"hi"}'
curl -X POST "$P/actions/restart" -d '{"member":"carol"}'  # app.close(); app.start()
curl -X POST "$P/actions/quit"
```

Exports follow lane T3: a raw store blob at
`<profile>/zrdt-export-<conversation id>.bin`, and Import reads the same path
for the importing desktop. So `doctor-remove` edits Carol's export in place
(the original is kept as `.orig`), and `doctor-append` reads Bob's export and
writes Dave's import path (Dave must be linked first). Both take an explicit
`file` instead (`~/` allowed).

## Doctor

```sh
node --import tsx demo/doctor.ts show   Camping.zrdt
node --import tsx demo/doctor.ts remove Camping.zrdt [out] [--digest 9ac1]   # beat 4
node --import tsx demo/doctor.ts append Camping.zrdt [out] --author <Bob's ACI>   # beat 5
```

`remove` parses only the blob framing and records, drops one linked, non-head
record (by default one a head links), and fixes the count; OPEN then fails
with that digest in `missing`. `append` drives `zrdtd`: OPEN under a scratch
chat key, ACCEPT two records by the author whose links are the current heads
(random commits), ENCODE, and a check that the result passes OPEN.

`doctor.ts` accepts a raw store blob (what lane T3 exports), a JSON file
holding it as base64, or a binary container holding it (a u32 length right
before it is fixed up). TODO(zrdt T4): drop the removed record's content entry
once exports carry a content section.

## Tests

```sh
node --import tsx --test demo/*_test.ts          # rules, panel, doctor (+ zrdtd)
node --import tsx demo/smoke.ts                  # launches three desktops
```

`smoke.ts` tags each check `harness` or `zrdt`, writes
`demo/artifacts/smoke/run.json` and screenshots, and exits 0 only when every
check passes (GO).
