<!-- Copyright 2014 Signal Messenger, LLC -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Signal Desktop with zrdt

This is a fork of Signal Desktop (v8.33.0), branch `zrdt`, with **zrdt**: a
verified transcript-consistency layer for group chats. Each group message
carries hash links to the messages its sender had seen, and `zrdtd`, a small
daemon compiled from a Lean 4 core whose properties are proved in Lean (the
`zrdt/` submodule, [l-adic/zrdt](https://github.com/l-adic/zrdt)), checks every
record the app sends or receives. A server can then no longer make a member's
app accept a history with a hole in it without the gap showing. The demo runs
three or four desktops against an "evil" mock server driven from a control
panel.

## Quick start

```sh
git clone --recurse-submodules -b zrdt https://github.com/l-adic/signal-desktop-zrdt.git
cd signal-desktop-zrdt
make install && make run
```

Prerequisites: macOS on Apple silicon, git, Node v24.22.0 (`.nvmrc`), pnpm
11.24.0 (`corepack enable`, which ships with Node, or
`npm install -g pnpm@11.24.0`), and elan for Lean
(`curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`). `make install`
checks them first and says what is missing; it builds `zrdtd`, installs
`node_modules` and Electron (about 30 s on our Mac mini).
`make run` opens Alice's, Bob's and Carol's desktops and the villain's panel in
the browser; Ctrl-C (or `make stop`) closes everything. `make smoke` is the
go/no-go test of all five beats (exit 0 only if all 41 checks pass).
`make help` lists the rest.

- [demo/README.md](demo/README.md): the harness, the villain and the panel.
- [demo/DEMO.md](demo/DEMO.md): the five-beat demo script.
- [zrdt/README.md](zrdt/README.md): what is proved, the trusted base,
  `make proofs` (heavy; best on Linux) and Comparator (`make comparator`, Linux
  only).
- `zrdt/docs/APP.md`: how this fork uses `zrdtd`. The fork's own code is in
  `ts/zrdt/`.

The rest of this file is upstream Signal Desktop's README.

# Signal Desktop

Signal Desktop links with Signal on [Android](https://github.com/signalapp/Signal-Android) or [iOS](https://github.com/signalapp/Signal-iOS) and lets you message from your Windows, macOS, and Linux computers.

[Install the production version](https://signal.org/download/) or help us out by [installing the beta version](https://support.signal.org/hc/articles/360007318471-Signal-Beta).

## Got a question?

You can find answers to a number of frequently asked questions on our [support site](https://support.signal.org/).
The [community forum](https://community.signalusers.org/) is another good place for questions.

## Found a Bug?

Please search for any [existing issues](https://github.com/signalapp/Signal-Desktop/issues) that describe your bug in order to avoid duplicate submissions.

## Have a feature request, question, comment?

Please use our community forum: https://community.signalusers.org/

## Contributing to the project

Please see [CONTRIBUTING.md](https://github.com/signalapp/Signal-Desktop/blob/main/CONTRIBUTING.md). There are lots of ways to contribute - many that don't involve code!

## Donate to Signal

You can donate to Signal from inside Signal apps (Desktop, Android, or iOS), or via the web here: [Signal Technology Foundation](https://signal.org/donate). Signal is an independent 501c3 nonprofit.

## Cryptography Notice

This distribution includes cryptographic software. The country in which you currently reside may have restrictions on the import, possession, use, and/or re-export to another country, of encryption software.
BEFORE using any encryption software, please check your country's laws, regulations and policies concerning the import, possession, or use, and re-export of encryption software, to see if this is permitted.
See <http://www.wassenaar.org/> for more information.

The U.S. Government Department of Commerce, Bureau of Industry and Security (BIS), has classified this software as Export Commodity Control Number (ECCN) 5D002.C.1, which includes information security software using or performing cryptographic functions with asymmetric algorithms.
The form and manner of this distribution makes it eligible for export under the License Exception ENC Technology Software Unrestricted (TSU) exception (see the BIS Export Administration Regulations, Section 740.13) for both object code and source code.

## License

Copyright 2013-2024 Signal Messenger, LLC

Licensed under the GNU AGPLv3: https://www.gnu.org/licenses/agpl-3.0.html
