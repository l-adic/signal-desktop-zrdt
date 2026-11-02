<!-- Copyright 2026 zrdt contributors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# DEMO.md: the live demo on the MacBook

Five beats in 3 min 55 s, plus a 30 s intro and a 30 s close: 4 min 55 s in
all. Sources: `zrdt/docs/APP.md` §9, `RESTORE_PLAN.md` §6 and
`docs/review-2026-11-01/AMENDMENTS.md` A11, A12. This file is the presenter's
copy. Read it once with the kit running before the demo.

**From a fork checkout** (no kit): `make install` once, then use `make run`,
`make smoke` and `make stop` where this file says `~/zrdt-demo-kit/run-demo.sh`,
`run-demo.sh --smoke` and `run-demo.sh --stop`; pass flags with `RUN_ARGS`,
e.g. `make run RUN_ARGS="--link-dave --port 7400"` (`SMOKE_ARGS`, `STOP_ARGS`
likewise). See `demo/README.md`, "Quick start".

| Part                        | Time | Clock        |
| --------------------------- | ---- | ------------ |
| Intro                       | 30 s | 0:00 to 0:30 |
| Beat 1, codes match         | 30 s | 0:30 to 1:00 |
| Beat 2, a dropped message   | 60 s | 1:00 to 2:00 |
| Beat 3, a withheld message  | 45 s | 2:00 to 2:45 |
| Beat 4, a doctored backup   | 40 s | 2:45 to 3:25 |
| Beat 5, restore from anyone | 60 s | 3:25 to 4:25 |
| Close                       | 30 s | 4:25 to 4:55 |

## The kit

Everything runs on the MacBook from one folder. Nothing is built there and no
network is needed: the Signal server is a mock, on 127.0.0.1. It needs an
Apple-silicon Mac with macOS 13.5 or later (Node's minimum; Electron and the
native modules need 13.0). It was tested on macOS 27.0.1 (Mac mini M4).

- **Build** (on the Mac mini, in a fully built fork tree): `demo/pack.sh`.
  It writes `~/demo-kit-build/zrdt-demo-kit.tar.gz` (about 560 MB; 1.8 GB
  unpacked), which holds Node 24.22.0, the built fork with Electron 44.9.1,
  and `zrdtd`, the Lean daemon. `zrdtd` links only macOS system libraries.
  `KIT-INFO.txt` lists the versions, the commits and the checksums.
- **Copy** the tarball to the MacBook (scp, AirDrop or a USB stick).
- **Unpack** it into your home folder, not into Downloads, Desktop or
  Documents (macOS asks for permission there):
  `tar -xzf zrdt-demo-kit.tar.gz -C ~`
- **Run** `~/zrdt-demo-kit/run-demo.sh`. On the first run it clears the macOS
  quarantine flag on the kit, which takes up to a minute. It also checks that
  node, `zrdtd` and Electron start, and re-signs any of them ad hoc if macOS
  kills it.

`run-demo.sh` flags:

| Command               | What it does                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `run-demo.sh`         | The live demo: Alice, Bob and Carol linked, warm-ups sent, the villain panel opened in the browser             |
| `run-demo.sh --smoke` | The automatic test of beats 1 to 5 (about 60 s); prints GO or NO-GO                                            |
| `run-demo.sh --beat5` | Plays beat 5 of the live demo, clicking as you will, and checks Dave's window (about 30 s); prints GO or NO-GO |
| `run-demo.sh --stop`  | Closes a demo that is still running, then kills leftover desktops                                              |
| `--link-dave`         | Links Dave at once (for rehearsals)                                                                            |
| `--no-open`           | Does not open the panel                                                                                        |
| `--port N`            | Panel port (default 7357)                                                                                      |
| `--resign`            | Re-signs `zrdtd`, node and Electron ad hoc first                                                               |
| `--background`        | Windows do not wait to become visible (only for a locked screen or SSH)                                        |

The script sets these variables:

- `ZRDT_DAEMON`: the kit's `zrdtd`.
- `ZRDT_REQUIRE_LEAN=1`: the demo never falls back to the TypeScript stub.
- `ZRDT_RESEND_DELAY_MS=4000`: the gap row stays for 4 s.
- `ZRDT_AUTHOR_FASTPATH_DELAY_MS=3000`: "relayed by Bob" stays for 3 s
  before it becomes "confirmed by Alice".

A value already set in the environment wins for the last two (for timing
rehearsals).

## Pre-demo checklist

**The day before, or at least an hour before:**

1. [ ] Unpack the kit, then run `~/zrdt-demo-kit/run-demo.sh --smoke`. You
       should see `GO: all 73 checks passed` after about 60 s. Then run
       `~/zrdt-demo-kit/run-demo.sh --beat5`. You should see
       `BEAT5 GO: all 11 checks passed` after about 30 s. Any failure: stop
       and read _If something fails_.
2. [ ] Click away every macOS prompt this first run raises: firewall
       ("accept incoming connections" for node or Electron): **Allow**;
       notifications: **Don't Allow**.
3. [ ] Copy the smoke screenshots aside for the fallback:
       `cp -R ~/zrdt-demo-kit/app/demo/artifacts/smoke ~/zrdt-fallback`.
4. [ ] Do one full rehearsal of beats 1 to 5 with `run-demo.sh`. At the end of
       beats 4 and 5, press the panel's **Screenshot all windows** button. Then
       copy `~/zrdt-demo-kit/app/demo/artifacts/demo/*.png` to `~/zrdt-fallback`,
       because the next run deletes that folder.

**At T−10 minutes:**

5. [ ] Plug in power. Turn on Do Not Disturb (Focus). Quit other apps. Run
       `caffeinate -d &` so the screen does not sleep.
6. [ ] Displays:
   - **With a projector or second screen:** make the screen the audience sees
     the **main display** (System Settings → Displays → Use as Main Display).
     The harness tiles the Signal windows across the main display. Keep the
     terminal and the panel on the other screen.
   - **Mirrored or laptop only:** use System Settings → Displays → **More
     Space**. Three windows across a 1512 px laptop screen are about 500 px
     each, and four windows are about 380 px each.
7. [ ] Start the demo: `~/zrdt-demo-kit/run-demo.sh`. Wait for
       `READY. Villain panel: http://127.0.0.1:7357/` (10 to 20 s). The panel
       opens in the browser. Make the browser window small and put it where it
       covers no composer (with a single screen, the bottom-right corner over
       Carol's chat list works).
8. [ ] In each of the three windows, check:
   - the green badge at the top reads `zrdt: lean zrdt-core 0.1.0 … (protocol 2)`;
   - "Camping" is open, with the three warm-up messages;
   - each message has a short code next to its time (`·48fa`).
     Click **Not now** on any "Donate Today" card, and **Dismiss** on any "New
     ways to connect" card.
9. [ ] The panel's rule list is empty: no rule armed.
10. [ ] Keep a terminal window and `~/zrdt-fallback` (in Finder) one click
        away.

Window order, left to right: **Alice, Bob, Carol** (then **Dave**, after he
is linked in beat 5). "Click in Alice's window" means the composer at the
bottom of her chat ("Message"). The **compare button** is the shield with a
tick in the chat header, to the left of the magnifier (tooltip "Compare this
chat"). The **panel** is the dark "zrdt villain" page: red buttons arm the
villain, and "clear (villain off)" disarms it.

## The script

Each beat lists what you do, what the audience sees, and one line to say.
Type the messages live. If typing goes wrong, use the panel's **Send as member
(rehearsal)** action (fields `member`, `text`).

### Intro (30 s)

Say: "Signal already stops the server from reading your messages. But the
server still decides who gets which message, and when. It could quietly drop
one message for one person, and nobody would ever know. We added a small
layer, whose core checks are proven in the Lean proof assistant, that makes
every app notice. Here are Alice, Bob and Carol planning a camping trip. The dark page
is the villain: it controls the server."

### Beat 1: codes match (30 s)

| Do                                                                      | The audience sees                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Alice types `who's bringing the tent?`, then Enter                      | The message appears in all three windows, with the same short code (`·6383`) next to it everywhere |
| Bob types `me`; Carol types `I have the stove`                          | The same: one code per message, identical on every screen                                          |
| Bob: compare button → **Copy compare code**                             | Bob's "Compare this chat" dialog, with his code and 12 words                                       |
| Carol: compare button → click in the **Paste compare code** box → Cmd-V | Carol: "Identical: you and Bob hold the same set of messages."                                     |
| Close both compare dialogs (**Close**)                                  |                                                                                                    |

Say: "Every message gets a short fingerprint, and it is the same on every
screen. Bob and Carol swap one code: identical. They hold exactly the same
conversation."

### Beat 2: a dropped message (60 s)

| Do                                                                                                         | The audience sees                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Panel: red **dropGroupMsg(alice, carol)**                                                                  | The rule appears in the panel's list                                                                                   |
| Alice types `actually I lost the tent poles`                                                               | It reaches Bob. Carol's window does not change                                                                         |
| Bob types `I'll bring spares` as a plain message. Do **not** use Reply, which would quote the dropped text | Carol sees Bob's message, and above it a grey row with a spinner: "1 message you haven't received. Bob replied to it." |
| Wait about 4 s                                                                                             | Alice's message appears in its place in Carol's chat, labelled "relayed by Bob"…                                       |
| Wait about 3 s                                                                                             | …and then "confirmed by Alice". The grey row is gone                                                                   |
| Panel: **clear (villain off)**                                                                             | The rule list is empty                                                                                                 |

Say: "Now the server turns villain and quietly drops Alice's message to
Carol. Normally Carol would never find out. But Bob's reply points at the
message he answered, so Carol's app sees the hole, asks Bob for a copy, and
Alice's app confirms it is hers. Carol never had to trust the server."

### Beat 3: a withheld message (45 s)

| Do                                                       | The audience sees                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Panel: red **blackhole(carol)**                          | The rule appears                                                                                                                          |
| Alice types `meet at 9 at the trailhead`. Nobody replies | Alice and Bob have it. Carol's screen shows nothing at all                                                                                |
| Say the first line below                                 |                                                                                                                                           |
| Bob: compare button → **Copy compare code**              |                                                                                                                                           |
| Carol: compare button → click in the paste box → Cmd-V   | Bob's words "(different from yours)", a spinner, and about 10 s later a red box: "Bob has 1 message you don't (·eef3). Asked; no answer." |
| Panel: **clear (villain off)**                           |                                                                                                                                           |
| Carol: **Ask again**                                     | "meet at 9 at the trailhead" appears in Carol's chat                                                                                      |
| Close both compare dialogs                               |                                                                                                                                           |

Say, while Alice's message sits unseen: "Now the server blocks everything to
Carol. The newest message leaves no trace, because nothing comes after it yet
that points at it."

Say, at the red box: "One code from Bob shows Carol that she is missing a
message. Her app asks for it, nothing comes back, and she is told plainly,
without blaming anyone. Switch the villain off, ask again, and it arrives."

### Beat 4: a doctored backup (40 s)

| Do                                                                                                                                                                                                                                  | The audience sees                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Carol: Settings (the gear at the bottom of the left rail) → **Internal** (the last item) → the section "zrdt (demo)" at the top, Chat "Camping" → **Export store**                                                                  | "Exported N records … to …" under the section                                                                                                                                                                                                                              |
| Wait for the terminal line `auto-doctor, beat 4 (Carol's export): removed ·xxxx …` (1 to 2 s). Do **not** click the panel's Beat 4 doctor button: run-demo.sh already doctors the export, and a second pass removes another message | Nothing on screen. The terminal names the removed message: with the script's messages it is Bob's `I'll bring spares`, linked by Alice's `meet at 9 at the trailhead`                                                                                                      |
| Carol: **Import file**                                                                                                                                                                                                              | Carol is back in the chat, under a red banner: "This copy of the chat does not verify: message ·xxxx is missing" (the one the terminal named), with **Keep what verifies** and **Import a copy**                                                                           |
| Carol: **Keep what verifies** (in the banner)                                                                                                                                                                                       | A blue banner: "Kept 7 messages that verify. Dropped 1 message: ·yyyy." The dropped message (`meet at 9 at the trailhead`) is the one that built on the missing message. Carol's chat does not change, because she already holds every message that was kept. Click **OK** |

Say: "Backups are another weak spot. Someone deletes one message from the
middle of Carol's backup file. Her app refuses the file, names exactly which
message is missing, and keeps only what still checks out."

Present this as "a tampered backup is caught", not as a server attack.

Transition into beat 5: while you say the beat-4 line, click **Link Dave's
desktop (before beat 5; first arms "hold Dave's catch-up")** in the panel.
It first arms the villain rule **"Alice, Bob and Carol offline: hold Dave's
catch-up (1:1 messages to their desktops wait; clear drops them)"**: the
panel lists it under the rules, and the terminal prints `villain: armed
"Alice, Bob and Carol offline: hold Dave's catch-up …"`. Then Dave's window
appears on the right within a few seconds, and the four windows re-tile.
Dave's desktop is a new laptop with no chat. Dave has been in the group from
the start, so his app asks Alice for the chat by itself. The server holds
that request (the panel shows `held: alice: …`), so Dave's chat stays empty.
What the rule does: the server holds every 1:1 message to Alice's, Bob's and
Carol's desktops. Dave's request is a sealed 1:1 message the server cannot
read, so it holds them all, receipts too. Group messages pass.

### Beat 5: restore from anyone (60 s)

| Do                                                                                                                                                                                                | The audience sees                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bob: Settings → **Internal** → **Export for**: pick **Dave** (the menu under "File") → **Export store**, then back to the chat (the speech-bubble Chats icon at the top of the left rail)         | "Exported for Dave: 9 entries, sealed to their key …" under the section                                                                                                                                                   |
| Wait for the terminal line `auto-doctor, beat 5 (Bob's export for Dave -> Dave): appended ·xxxx ·yyyy …` (1 to 2 s; Dave must be linked first). Do **not** click the panel's Beat 5 doctor button | Nothing on screen                                                                                                                                                                                                         |
| Dave: Settings → **Internal** → **Import file**. Dave's app goes back to the chat by itself                                                                                                       | At the top of Dave's chat, a grey collapsed row: "▸ 11 messages not yet confirmed by any member"                                                                                                                          |
| Dave: click that row once to open it. It stays open from now on                                                                                                                                   | Eleven grey entries: the chat's nine messages with their text and no label, then two entries "·xxxx · attributed to Bob" with no time and "(content unavailable)": the two fakes                                          |
| Alice types `found the poles!`                                                                                                                                                                    | It reaches Dave like any message. The nine messages turn green: Alice's read "confirmed by Alice", Bob's and Carol's "held by Alice". The row reads "2 messages not yet confirmed by any member": the fakes have no label |
| Bob types `great, see you at 9`                                                                                                                                                                   | The row becomes "Imported history: 11 messages". Bob's messages read "confirmed by Bob". Both fakes read **"not confirmed by Bob"** (red)                                                                                 |
| Panel: **clear (villain off)**                                                                                                                                                                    | The panel's rules read "none: everything passes"; the terminal prints `… dropped N (held by a rule that drops on clear)`. Nothing changes in the windows                                                                  |

Say: "Dave gets a new laptop. The server plays dead: it holds back his app's
request for the chat, as if Alice, Bob and Carol were offline. So Bob hands
him a copy of the chat, made for Dave and sealed to Dave's key. But someone
slipped two fake 'Bob' messages into it. Dave's app takes the file but
trusts none of it yet: all eleven messages wait in grey, confirmed by
nobody. Alice writes, and everything she holds is confirmed. The two fakes
are not: she never had them. One message from Bob exposes the two fakes in
his name."

The export for Dave holds only the messages Dave was sent, sealed to Dave's
key. Bob's own export ("Export for: this account", the default) would not
work: only Bob's account can import it, and Dave's app refuses it. If you
exported it by mistake, the terminal says `… is Bob's own export, not one for
Dave …`: pick Dave under **Export for** and click **Export store** again. The
doctor cannot read the sealed copy. It appends the two fakes in a new section
sealed to Dave's key, on top of Bob's newest message. The fakes have no text
that matches a commitment, so they show "(content unavailable)".

Why the rule: without it, Dave's app fetches the chat from Alice about 1.5 s
after the link, and the import would add only the two fakes. The rule is the
server's doing, and the panel names it. The clear at the end drops what the
rule held (Dave's catch-up requests and some receipts) instead of delivering
it: answered late, the catch-up would add the nine messages again, as new
messages under Alice's and Bob's. With four windows on a laptop screen,
Dave's window is narrow: point at the red "not confirmed by Bob" pills.

### Close (30 s)

Say: "Signal already stops the server from reading or forging messages. With
this layer, the server also cannot slip a hole into your chat history: if a
later message builds on one you lack, your app tells you and fetches it. Two
people can check with one code that they hold the same messages. The server
can still delay messages, and hold back the very newest ones until someone
replies or you compare. The checks run in a program built from Lean code
whose proofs a machine has checked; the green badge shows which build is
running."

To stop afterwards: the panel's **Quit**, or Ctrl-C once in the terminal.

## If something fails

Decide quickly: losing more than 20 s means switching to the fallback.

| Symptom                                                                        | Do                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "cannot be opened", "damaged" or "unidentified developer" at start             | `~/zrdt-demo-kit/run-demo.sh --resign`; else run `xattr -dr com.apple.quarantine ~/zrdt-demo-kit` and use System Settings → Privacy & Security → Open Anyway                                       |
| `ERROR: port 7357 is in use`                                                   | `~/zrdt-demo-kit/run-demo.sh --stop`, then start again                                                                                                                                             |
| `FAILED:` in the terminal at start, or a window stays blank for more than 60 s | Ctrl-C, `run-demo.sh --stop`, start again (startup takes 10 to 20 s)                                                                                                                               |
| A message does not arrive within about 10 s                                    | Panel: **clear (villain off)**. If it is still stuck, panel: **Restart a member's desktop** (member, about 10 s)                                                                                   |
| Badge says `stub` or "zrdt unavailable"                                        | Stop. The kit's `zrdtd` did not start: `run-demo.sh --stop`, then `run-demo.sh` and read its `zrdtd:` line                                                                                         |
| Beat 2: no gap row after 10 s                                                  | Narrate from `~/zrdt-fallback/beat2-gap.png` and `beat2-recovered.png`                                                                                                                             |
| Beat 3: no red box after 20 s                                                  | Narrate from `beat3-withheld.png`; panel **clear**, then go on                                                                                                                                     |
| Settings → Internal is missing, or a button does nothing                       | Use the panel's rehearsal actions instead: **Export a member's store** (beat 4: `member` carol; beat 5: `member` bob, `for` dave) and **Import into a member's chat** (`member` carol or dave)     |
| Beat 5: Dave's chat fills with nine messages right after the link              | The rule was not armed (no `villain: armed` line). Go on: the import then adds only the two fakes, and Alice's and Bob's messages work as in the script. Say "Dave's app already fetched the chat" |
| Beat 5: the terminal says `… is Bob's own export, not one for Dave …`          | Bob: Settings → Internal → **Export for**: **Dave** → **Export store** again                                                                                                                       |
| Panel buttons do nothing                                                       | Use curl from the terminal, for example `curl -X POST 'http://127.0.0.1:7357/rules/dropGroupMsg?from=alice&to=carol'` (more in `app/demo/README.md`)                                               |
| Anything worse                                                                 | Fallback below                                                                                                                                                                                     |

**Fallback.**

1. Press Ctrl-C once, then run `~/zrdt-demo-kit/run-demo.sh --stop`.
2. Either run `~/zrdt-demo-kit/run-demo.sh --smoke` and narrate beats 1 to 5
   while it plays them on screen, in about 60 s with visible windows; the
   villain's moves show in its log. Or open `~/zrdt-fallback` in Quick Look
   (select all, then Space) and narrate from the screenshots, in order:
   `ready` (from the rehearsal), `beat1`, `beat2-gap`, `beat2-relayed`,
   `beat2-recovered`, `beat3-withheld`, `beat3-recovered`, `beat4-rejected`,
   `beat4-salvaged`, `beat5-imported`, `beat5-alice`, `beat5-bob`.
3. Then go to the close. The claims do not change.

## Notes

- Ctrl-C ends the run through Playwright's own handler, which kills the
  desktops at once (exit status 130). `run-demo.sh` then kills any leftover
  desktop. The panel's **Quit** closes them cleanly.
- Every run starts from new profiles. Startup deletes
  `app/demo/artifacts/demo` (screenshots, villain log) of the previous run.
- Window size: the harness tiles the main display's work area. If the Dock
  takes space, hide it (System Settings → Desktop & Dock → Automatically hide).
- TODO(F3): trim `libsignal-client` and `ringrtc` prebuilds for other
  platforms from the kit (about 200 MB); remove the `mock-signal-*` profile
  folders that runs leave in `$TMPDIR`.
