# zbt: share a file with a Signal group through zrdt

`zbt` is the torrent app's command line (zrdt `docs/apps/BUILD_M1.md` §A.1). It talks only to
the local endpoint of one running desktop of the fork. The desktop asks the user before anything
is shared, uploads the pieces, and checks every piece it receives. `zbt` never sees a key, a CDN
pointer or a record opening.

```sh
zbt share ~/trip.mp4 --group Camping     # the desktop asks "Share trip.mp4 (20 MiB) with Camping (4 members)?"
zbt ls --group Camping                   # the group's files, one line of pieces each
zbt status <file> --group Camping --wait 60
zbt hello
```

`--json` prints the endpoint's JSON instead. The exit status is 0 when done, 1 when refused,
failed or not done in time, 2 for a usage error, and 3 when the endpoint cannot be used.

In `zbt ls`, each piece is one character: `#` checked, `~` downloading, `^` uploading, `?` being
repaired, `x` nobody had it, `.` waiting.

## Running it

Node 24 runs `zbt.ts` directly (it strips the types), so there is no build step:
`tools/zbt/zbt share ...`, or `node tools/zbt/zbt.ts share ...`.

## Finding the desktop

The first match wins.

- **Endpoint:** `--endpoint`, then `ZRDT_ENDPOINT`, then `ZRDT_SOCKET` (a socket path), then
  `ZRDT_URL`. The value is one of:
  - `http://127.0.0.1:<port>` (loopback only);
  - `unix:<path>`;
  - the path of the desktop's endpoint file, `<userData>/zrdt-apps.json` (BUILD_M1 §B.10). It
    holds `{"endpoint": ..., "tokens": {"bt": ...}}`, or `{"port": N, "tokenFiles": {"bt": path}}`.
- **Token:** `ZRDT_TOKEN`, then the file named by `--token-file` or `ZRDT_TOKEN_FILE`, then the
  endpoint file's `tokens.bt`, then the file its `tokenFiles.bt` names. The token is sent as
  `Authorization: Bearer`.

Each demo desktop has its own `userData`, so `demo/launch.ts` writes one environment file per
member. `source` it in that member's terminal.

## The routes

The routes are in `ts/zrdt/apps/bt/routes.std.ts`. They follow the git endpoint's conventions
(zrdt `tools/git-remote-zrdt/ENDPOINT.md`, version 1): the same `hello`, errors, piece hand-over
and JSON shapes, under `/v1/bt/<group>`.

| Call                                         | What                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/hello`                              | `{"protocol": 1, "app": "bt", "member", "pieceSize", "maxStream"}`                                                                                                                                           |
| `GET /v1/bt/<group>`                         | `{"group", "members", "files": [file]}`                                                                                                                                                                      |
| `GET /v1/bt/<group>/files/<id>`              | one file                                                                                                                                                                                                     |
| `POST /v1/bt/<group>/uploads`                | `{"size": L}` → 201 `{"upload", "pieceSize", "pieces"}`                                                                                                                                                      |
| `PUT /v1/bt/<group>/uploads/<id>/pieces/<i>` | `{"sha256", "data"}` (base64) → `{"ok": true}`                                                                                                                                                               |
| `POST /v1/bt/<group>/shares`                 | `{"upload", "name"}`: waits for the user's answer, then 200 `{"status": "ok", "id", "file", "audience"}` or 409 `{"status": "refused", "reason": "DECLINED" \| "BAD_NAME" \| "TOO_LARGE" \| ..., "message"}` |

A file is `{"id", "file" (A's digest, null before the publish), "name", "size", "from", "self",
"state", "status", "pieces", "checked", "pieceStates", "resent": [{"member", "pieces"}],
"notices", "savedTo", "failure"}`. Piece numbers in `resent` count from 1.

## Tests

From the fork's root:

```sh
node --import tsx --test tools/zbt/zbt_test.ts
```

The tests run `zbt` against the desktop's real bt routes and torrent manager, on a scripted
transport, over TCP and over a Unix socket.
