<!-- Copyright 2026 zrdt contributors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# demo/: the villain, the launch harness, the doctor, the smoke test

Everything here runs from the repository root with Node 24 and `tsx`. Build
`zrdtd` first: `cd zrdt/core && lake build` (the harness finds
`zrdt/core/.lake/build/bin/zrdtd`; set `ZRDT_DAEMON` to use another one).

## Quick start

```sh
git clone --recurse-submodules <this repo> && cd signal-desktop-zrdt
make install    # zrdtd (Lean), node_modules, Electron, generated files
make run        # the live demo
```

Prerequisites: macOS on Apple silicon, git, Node v24.22.0 (`.nvmrc`), pnpm
11.24.0 (`corepack enable`, or `npm install -g pnpm@11.24.0`), and elan
(`lake`). `make install` checks them first and says what is missing.

`make run` opens three Signal desktops (Alice, Bob, Carol) linked to a local
mock server, sends the warm-up messages to group "Camping", and opens the
villain's control panel in the browser (default http://127.0.0.1:7357/);
then follow [DEMO.md](DEMO.md). Ctrl-C closes everything. Other targets:
`make smoke` (the go/no-go test, exit 0 only if every check passes),
`make stop`, `make proofs` (the Lean proofs in `zrdt/`), `make comparator`,
`make kit` (the MacBook demo kit), `make help`.

| File         | What it does                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rules.ts`   | the villain's rules as pure functions: `dropGroupMsg(from, to)` (once, sends to ≥ 2 accounts from the inferred sender), `blackhole(to)`, `hold(to)`                |
| `evil.ts`    | `EvilServer`: Signal's mock server with the rules in front of the linked desktops (`handleMessage` + `prepareMultiDeviceMessage`); `arm`, `release(to)`, `clear()` |
| `panel.ts`   | the control panel: HTTP on 127.0.0.1 and a one-page HTML front end                                                                                                 |
| `harness.ts` | the demo world: four phones (Alice, Bob, Carol, Dave), group "Camping", link, tile, warm-up, restart, teardown                                                     |
| `launch.ts`  | the live demo: links Alice, Bob, Carol; warms up; starts the panel; links Dave on demand                                                                           |
| `doctor.ts`  | beats 4 and 5: edits an exported store                                                                                                                             |
| `smoke.ts`   | the F2 go/no-go test: beats 1–5 through the harness and the panel                                                                                                  |

## Live demo

```sh
node --import tsx demo/launch.ts          # add --link-dave to link Dave at once
# open the panel URL it prints (default http://127.0.0.1:7357/)
```

It sets `SIGNAL_MOCK_TESTS_BACKGROUND=1`, `ZRDT_DAEMON`,
`ZRDT_RESEND_DELAY_MS=4000` and `ZRDT_AUTHOR_FASTPATH_DELAY_MS=3000` (how long
beat 2's copy reads "relayed by Bob" before "confirmed by Alice") for the
desktops (an existing value wins). Startup to READY takes about 7 s on the Mac
mini. Ctrl-C closes everything.

`doctor.ts` runs by itself on the live exports (`--no-auto-doctor` turns it
off): when Carol clicks Settings → Internal → Export store, one linked,
non-head record is removed from her file in place (beat 4; the original is
kept as `.orig`); when Bob exports and Dave's desktop is linked, two fakes by
Bob are appended and the result is written where Dave's Import file reads
(beat 5). The terminal prints what it did (`auto-doctor, beat 4: removed ·61b5
…`).

### Presenter clicks, beats 4 and 5

- Beat 4: Carol: Settings → Internal → **Export store**; (auto-doctor); Carol:
  **Import file** (back to the chat: red banner "This copy of the chat does not
  verify: message ·xxxx is missing"); **Keep what verifies** ("Kept N messages
  that verify. Dropped 1 message: ·yyyy."); **OK**.
- Beat 5: panel **Link Dave's desktop**; Bob: Settings → Internal → **Export
  store**; (auto-doctor); Dave: Settings → Internal → **Import file**, back to
  Camping; expand "N messages not yet confirmed by any member"; Alice writes;
  Bob writes.

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

Exports go to `<profile>/zrdt-export-<conversation id>.bin`, and Import reads
the same path for the importing desktop. The file is JSON (RESTORE_PLAN.md
§3): `{"zrdtDump": 1, "blob": <base64 store blob>, "content": {<hex digest>:
<base64 opening>}}`; an opening is `nonce ‖ DataMessage bytes` without fields
15 and 200, so no group master key. Import keeps a content entry only if its
record is in the store and `COMMIT(opening) == record.commit` (zrdtd's
ACCEPT_RECORD with the opening); the unconfirmed section shows that text for
records without a message row (in memory only for now). A raw store blob is
still accepted. So `doctor-remove` edits Carol's export in place
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

`doctor.ts` accepts the app's JSON dump (the blob as base64 plus a content
section; `remove` drops the removed record's content entry too), a raw store
blob, or a binary container holding it (a u32 length right before it is fixed
up).

## Tests

```sh
node --import tsx --test demo/*_test.ts          # rules, panel, doctor (+ zrdtd)
node --import tsx demo/smoke.ts                  # launches three desktops
```

`smoke.ts` tags each check `harness` or `zrdt`, writes
`demo/artifacts/smoke/run.json` (every check with `atMs`/`ms`, and
`beatTimings`) and screenshots, and exits 0 only when every check passes (GO).
`ZRDT_SMOKE_BEATS=1,2` runs a subset (beat 1 always runs). It drives beats 4
and 5 through the zrdt hooks (export, import) and doctor.ts in-process, and
clicks the banner's "Keep what verifies".
