# FORK_MAP: where zrdt apps plug into the fork

Status: map and prototype, 2026-11-02 (lane apps-map, local branch `apps-map` from fork `zrdt` =
3eae9af, zrdt submodule 22c65a3). It serves zrdt's `docs/apps/BUILD_M1.md` (an uncommitted
draft on zrdt's `apps` branch, not in the submodule yet) and
[TRANSPORT](../../zrdt/docs/apps/TRANSPORT.md). Line numbers are
at 3eae9af, before the prototype's edits. The prototype (§8) ran green on the Mac mini: 22/22 checks,
three desktops, mock server.

## 0. Summary

- **App records need no change to the chat path.** Content 205 (`ZrdtAppMessage`) is a sibling of
  the control messages 202-204. It never reaches `handleDataMessage`, the scope predicate, the
  freeze in `sendNormalMessage`, or the attachment download jobs. The prototype sent and received
  one 205 with two CDN pieces between desktops, and no message row appeared on any of them.
- **Send:** `sendContentMessageToGroup` (`ts/util/sendToGroup.preload.ts:191`), the call the chat
  freeze already makes (`sendNormalMessage.preload.ts:432`). Use a new send type `zrdtApp` that
  the sendLog does not keep.
- **Receive:** a branch in `MessageReceiver.#innerHandleContentMessage`
  (`ts/textsecure/MessageReceiver.preload.ts:2693`), next to the 202-204 branch (`:2726`). Take the
  bytes as sent with `findLengthDelimitedField(plaintext, 205)` (`ts/zrdt/wire.std.ts`). Checked:
  decode, then encode, gives the same bytes.
- **Pieces:** upload with `encryptAndUploadAttachment` (`ts/util/uploadAttachment.preload.ts:163`)
  and a fresh `getRandomBytes(64)` key. Never use `uploadAttachment` (`:56`), which reuses a CDN
  object for 3 days. Download with `getAttachment` (`ts/textsecure/WebAPI.preload.ts:4148`), then
  `decryptAttachmentV2ToSink` (`ts/AttachmentCrypto.node.ts:366`), in memory. Checked on the mock:
  - 1 MiB and 300 KiB pieces round-trip;
  - the same bytes uploaded twice get a new CDN object;
  - a deleted object gives `HTTPError 404`;
  - a flipped ciphertext byte gives `Bad MAC`.
- **Local endpoint:** an HTTP server in the main window's preload (the renderer). Measured on the
  mock: socket path 82 bytes, mode 0600; the token file is 0600; a request without the token, or
  with an `Origin` header, is refused. A child-process CLI drove a desktop over TCP and over the
  socket.
- **Three changes outside the apps code that M1 must make together** (§1.3, §5):
  - `PROTOCOL_VERSION` 4 → 5 (`ts/zrdt/ZrdtBackend.std.ts:54`). The fork compares exactly, so a
    protocol-5 `zrdtd` makes chat fail closed until the fork is bumped too.
  - The service's chat keys must also name channel stores (`serviceCore.node.ts:444, 593, 799`).
  - The harness supports only one group (`demo/harness.ts` `setUp`), and the git beat needs a
    second one.

## 1. Integration points at a glance

| Concern       | Where (3eae9af)                                                                                                                                                                    | M1 change                                                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire          | `protos/SignalService.proto` Content oneof (202-204), `ZrdtServeRequest`, `ZrdtServed`                                                                                             | `ZrdtAppMessage zrdtApp = 205` and `ZrdtPointers` (prototype §8.1). `ZrdtServeRequest` gains 7 `announcement` and 8 `channel`; `ZrdtServed` gains 5 `sealedOnCdn` (`AttachmentPointer`)                             |
| Send          | `sendContentMessageToGroup` `sendToGroup.preload.ts:191`; chat freeze `sendNormalMessage.preload.ts:381-445`                                                                       | New job type in `conversationJobQueue` (enum `ts/jobs/conversationJobQueue.preload.ts:73`, dispatch `:1020`), handler `ts/jobs/helpers/sendZrdtApp.preload.ts`, freeze logic in `ts/zrdt/apps/transport.preload.ts` |
| Send type     | `sendTypesEnum` `ts/util/handleMessageSend.preload.ts:26`, `shouldSaveProto` `:93`                                                                                                 | `'zrdtApp'`, not saved (prototype). T-M2: CDN pointers are bearer tokens                                                                                                                                            |
| Receive       | `#innerHandleContentMessage` `MessageReceiver.preload.ts:2693`; 202-204 branch `:2726`; fallthrough throws `Unsupported content message` `:2776`                                   | A 205 branch before 202-204 (prototype). `handleZrdtAppMessage` must persist before it returns (§3.2)                                                                                                               |
| Bytes as sent | `ts/zrdt/wire.std.ts` (`getDataMessageBytes` slices field 1)                                                                                                                       | `findLengthDelimitedField(plaintext, 205)` (prototype)                                                                                                                                                              |
| Upload        | `encryptAndUploadAttachment` `uploadAttachment.preload.ts:163`; reuse cache `:52, :261-316`                                                                                        | Call it directly with fresh keys; skip the cache                                                                                                                                                                    |
| Download      | `getAttachment` `WebAPI.preload.ts:4148`; `decryptAttachmentV2ToSink` `AttachmentCrypto.node.ts:366`; `splitKeys` `:624`                                                           | Direct and in memory. Cap the bytes (§4.4). Do not use `downloadAttachment` (`downloadAttachment.preload.ts:122`), which writes to the attachments folder and needs `downloadPath` to resume                        |
| Backend       | `PROTOCOL_VERSION` `ZrdtBackend.std.ts:54`; `Op` `backends/codec.std.ts:52` (last is `0x16`); `daemon.node.ts` framing                                                             | 4 → 5; ops `0x17`-`0x2F` and statuses `0x0C`-`0x12` in the codec; the stub answers `UNKNOWN_OP` or replays vectors                                                                                                  |
| Service       | `ZrdtServiceCore` keyed by `ChatKey` strings (`ZrdtBackend.std.ts:20`); `init` re-opens every `getZrdtConversationIds()` through `groupIdOf` (`serviceCore.node.ts:444, 593, 799`) | Channel keys (§5)                                                                                                                                                                                                   |
| SQL           | migrations `1850-zrdt`, `1860-zrdt-relative`; `zrdt_records/pending/provenance (conversationId TEXT, digest)`                                                                      | `1870-zrdt-apps` (§5)                                                                                                                                                                                               |
| `SERVE`       | `onServeRequest` `ts/zrdt/resend.preload.ts:395`, `onServed` `:513`; the only builder of `ZrdtServed` is `ts/zrdt/served.preload.ts` (enforced by `servedLint_test`)               | Branch on `announcement` and `channel`; upload a reply over 48 KiB as `sealedOnCdn` inside `served.preload.ts`                                                                                                      |
| Endpoint      | none (the demo panel `demo/panel.ts` runs in the harness, not in a desktop)                                                                                                        | `ts/zrdt/apps/socket.preload.ts`, started from `ts/background.preload.ts` next to `zrdtService.init()` (`:1245`) (§6)                                                                                               |
| Test hooks    | `ts/zrdt/ci.preload.ts` and the name list `ZRDT_CI_HOOK_NAMES` in `ts/CI.preload.ts`                                                                                               | Both lists, always together (§7.4)                                                                                                                                                                                  |
| Harness       | `demo/harness.ts` (one group, `Demo.group`), `demo/evil.ts` (envelopes only)                                                                                                       | Groups as a list, a CDN upload log, CLI runners, `demo/smoke-apps.ts` (§7)                                                                                                                                          |

### 1.1 Not touched

- `ts/zrdt/scope.std.ts`: the chat predicate never sees Content 205.
- `ts/zrdt/receive.preload.ts`, `#zrdtStep` (`MessageReceiver.preload.ts:2609`), and the
  `zrdtApplyBeforeSave` and `zrdtOnDuplicate` hooks in `ts/messages/handleDataMessage.preload.ts`.
- DataMessage fields 200 and 201, and the quote's 201.
- `ts/zrdt/send.preload.ts`'s freeze for chat. Apps reuse its pattern and its audience helper (§2.2).

### 1.2 Chat today, for orientation

- **Send.** The path is `sendNormalMessage` (`:102`), then uploads (`uploadSingleAttachment`
  `:855`), then `applyZrdtQuoteRule` (`:259`), then the group branch inside
  `conversationQueue/sendNormalMessage/group` (`:381`):
  - `isZrdtGroupSend` (`:408`);
  - `getZrdtGroupSendContent` (`:413`, in `send.preload.ts`), which runs `freezeZrdtSend`: LINKABLE,
    nonce, disown, AUDIENCE, then `messaging.getContentMessage` with `zrdt`. It persists
    `message.zrdt.contentBytes` first, then `acceptOwn`;
  - `splitRecipientsByAudience`;
  - `sendContentMessageToGroup` with the frozen Content (`:432`).

  The freeze persists on the message row (`message.zrdt`). Apps have no message row, so they need
  their own outbox (§2.3).

- **Receive.** `#handleDataMessage` (`:2473`) and `#handleSentMessage` (`:2097`) call `#zrdtStep`
  (`:2609`) with the bytes from `wire.std.ts`. That calls `zrdtReceiveLive`
  (`receive.preload.ts:235`), then `zrdtService.acceptIncoming`. `handleDataMessage` then copies
  digest and opening onto the message.
- **Control.** Content 202-204 are dispatched at `:2726` to `handleZrdtControlMessage`
  (`resend.preload.ts:296`), with `#removeFromCache` in a `finally`. They are sent 1:1 with
  `messageSender.sendIndividualProto` (`resend.preload.ts:177-205`; `SendMessage.preload.ts:1468`).

### 1.3 The protocol bump is a coordination point

`serviceCore.#init` refuses a backend whose `VERSION` is not `PROTOCOL_VERSION` (fail closed,
`serviceCore.node.ts:466`). If `zrdtd` replies 5 (BUILD_M1 §2.4) while the fork is still at 4,
every chat send fails. Bump both in one integrate step, together with the codec's new ops. The
submodule pointer and `ZrdtBackend.std.ts:54` change in the same fork commit.

## 2. Sending an app record

### 2.1 What the prototype proved

- `sendContentMessageToGroup` takes any Content: `{content: {zrdtApp}}`, with
  `messageId: undefined`.
- Run inside `conversation.queueJob(...)`, as `sendNormalMessage` does, so sender-key state changes
  are serialized with chat sends.
- With three members, the server saw one multi-recipient send: one `sendId`, recipients
  {bob, carol}, one 975-byte `SealedSender` envelope per desktop.
- Below two sender-key recipients, Desktop sends 1:1 instead (`sendToGroup.preload.ts:424`). With
  two members, the probe's send was a 1:1 sealed-sender `PUT /v1/messages/<aci>`. Every app smoke
  needs at least three members to exercise the real route.

### 2.2 M1 send pipeline (fork side)

1. **Socket request** `publish` (§6), or the share dialog's confirm.
2. **Uploads**, before the freeze (no audience needed yet). Each of the N pieces goes through
   `encryptAndUploadAttachment` with `keys: getRandomBytes(64)`, `needIncrementalMac: false`,
   `plaintext: {data}` and `uploadType: 'standard'`, then into an `AttachmentPointer.Params`.
   Prototype: `ts/zrdt/apps/probe.preload.ts` `appProbeSend`. The `Params` type needs every
   field, null when unset.
3. **A queue job** on the group conversation (a new `conversationQueueJobEnum` member, `ZrdtApp`):
   1. `AUDIENCE`. Reuse `loadAudienceMembers` and `planAudience` from `send.preload.ts`; they are
      private now, so export them or move them to `ts/zrdt/audienceMembers.preload.ts`.
   2. `BT_BUILD` or `GIT_PREPARE`.
   3. `APP_MESSAGE`, which returns the committed bytes (201, 210-216).
   4. `COMMIT` and `ACCEPT` into the channel store.
   5. The Content is `205 { 15 groupV2, 200 ZrdtMeta, <committed bytes> }`.
4. **Freeze once.** Persist the Content bytes before the first send. Every retry sends the same
   bytes, as `freezeZrdtSend` does for chat, including its decode-then-encode check
   (`send.preload.ts` "froze the second").
5. **Send** to `recipients ⊆ seats` (`splitRecipientsByAudience`, `audiencePlan.std.ts`). Use
   `sendType: 'zrdtApp'` and `contentHint: ContentHint.Implicit`. Wrap the send in
   `handleMessageSend(..., {messageIds: [], sendType: 'zrdtApp'})` so errors and key refresh
   behave as stock. The prototype calls `sendContentMessageToGroup` bare.
6. **Own devices.** A sync transcript carries only a DataMessage, so also send the Content 1:1 to
   our own ACI (`sendIndividualProto({serviceId: ourAci})`, which reaches our other devices). The
   demo has one desktop per account and the fake phones ignore it. **Not tested.**

### 2.3 What changes, file by file

- `protos/SignalService.proto`: 205, `ZrdtPointers`, and the two extended control messages.
- `ts/util/handleMessageSend.preload.ts`: `'zrdtApp'` in the enum, and `false` in
  `shouldSaveProto` (prototype).
- `ts/jobs/conversationJobQueue.preload.ts`: a `ZrdtApp` job (enum `:73`, dispatch `:1020`).
- New `ts/jobs/helpers/sendZrdtApp.preload.ts`: the job, built like `sendNormalMessage`'s group
  branch.
- New `ts/zrdt/apps/transport.preload.ts`: the freeze and the outbox.
- New SQL table `zrdt_app_outbox (jobId, storeKey, contentBytes, digest)`, the app analogue of
  `message.zrdt` (§5).
- The 64 KiB Content limit: the host checks `Proto.Content.encode(c).byteLength` before the freeze
  (BUILD_M1 §2.3). Measured: one pointer adds about 180 bytes (a 2-pointer 205 was 437 bytes, a
  1-pointer one 257), so 64 pointers take about 11.5 KiB, under the 16 KiB cap on field 216.

## 3. Receiving an app record

### 3.1 What the prototype proved

The branch in `#innerHandleContentMessage`:

```ts
if (content.content?.zrdtApp) {
  try {
    await handleZrdtAppMessage({ senderAci: envelope.sourceServiceId,
      senderDevice: envelope.sourceDevice, timestamp: envelope.timestamp,
      message: content.content.zrdtApp, plaintext });
  } finally {
    this.#removeFromCache(envelope);
  }
  return;
}
```

- The bytes as sent are `findLengthDelimitedField(plaintext, 205)`, 433 bytes here.
  `Proto.ZrdtAppMessage.encode(decoded)` gave the same bytes. Field 205 is length-delimited, so a
  message-typed field and a `bytes` field are the same on the wire.
- The group is `deriveGroupFields(groupV2.masterKey).id`. The sender's membership is checked with
  `conversation.hasMember(senderAci)`. `envelope.sourceServiceId` is the unsealed sender ACI.
- Pieces are fetched after the handler returns (not awaited), so the receive queue never waits on
  the CDN. Downloads took 2 to 6 ms per piece on loopback.
- No message row, no timeline item, no `AttachmentDownloadManager` job: `getMessagesBySentAt`
  returned `[]` on both desktops.

### 3.2 M1 receive pipeline

1. The 205 branch, before 202-204.
2. **Before returning**, so that the envelope may leave the unprocessed cache:
   1. `CHANNEL` (group, app, name), then the channel store (open it, or start relative and catch
      up, JOIN §6).
   2. `acceptIncoming` with `dataMessageBytes` = the 205 bytes. `COMMIT`'s committed bytes strip
      fields 15 and 200 by number, so the chat code path works as is.
   3. Persist the opening in `zrdt_app_openings` and a "to fetch" row.

   The prototype keeps state in memory; M1 must not. Signal deletes the envelope after the
   `finally`, so a crash after it loses the record.

3. **After returning**, from a queue the app manager owns: `PIECES_BIND`, fetch each pointer,
   `PIECE_ACCEPT`, `PIECES_COMPLETE`, then the app op (`BT_FILE`, `GIT_OBJECTS`). Blame `BAD_PIECE`
   on the carrier's source. A 404 or `Bad MAC` goes to repair.
4. Our own copies arrive as 1:1 Content 205 from our own ACI: author = us, provenance `live` (A8).
5. Ignore, and log only: a 205 for a group we are not in, from a non-member, or for an app this
   client does not run.

### 3.3 Stock clients

- Stock Desktop removes a 205 from the cache, then throws `Unsupported content message` (`:2776`).
  It decrypted fine, so it sends no retry request. Android logs "Got unrecognized message!".
- The mock's fake phones (device 1 of every account) ignore unknown Content. The 202-204 smoke has
  relied on this since JOIN, and the probe confirms it for 205.

## 4. Attachments on the mock server

### 4.1 Upload

1. The client asks for an upload form over gRPC:
   `org.signal.chat.attachments.Attachments/GetUploadForm`
   (`packages/mock-server/src/server/grpc.ts:450`). That calls
   `Server.getAttachmentUploadForm('attachments', uuid)` (`base.ts:860`), which returns
   `cdn: 3`, `key` (a v4 UUID), unchecked `headers`, and the `signedUploadLocation`
   `https://localhost:PORT/cdn3/attachments/<key>`.
2. `uploadFile` (`uploadAttachment.preload.ts:231`) runs tus for CDN 3 (`tusUpload`). The mock
   serves it with `@tus/server` on `/cdn3` and stores `<cdn3Path>/attachments/<key>`. The harness
   creates `cdn3Path` (`demo/harness.ts` `setUp`, `zrdt-demo-cdn3-*` in `os.tmpdir()`), so the
   harness can read it as `demo.cdn3Path`.
3. Measured object sizes (padded ciphertext with IV and MAC): 1 MiB → 1,093,888 bytes (+4.3%);
   300 KiB → 307,680.

### 4.2 Download

- `GET /cdn3/attachments/:key` (`http.ts:177`) is **unauthenticated**, as on a real CDN, and
  ignores `Range`.
- Desktop's resume (`downloadOffset`) sends `Range` and expects 206 (`WebAPI.preload.ts` around
  `:4243-4278`), so **resume does not work on the mock**. With 1 MiB pieces, refetch the whole
  piece.
- The integrity check is the pointer's `digest` (`integrityCheck: {type: 'encrypted'}`). A
  plaintext-hash check is possible only when the sender put `plaintextHash` in the pointer.

### 4.3 Pointers

- Each piece is a full `AttachmentPointer`: `cdnKey` (oneof `attachmentIdentifier`), `cdnNumber`
  3, `key` (64 bytes), `digest` (32), `size` (plaintext), `uploadTimestamp`, `contentType`.
- These are bearer tokens. Never log them; WebAPI's redactor hides `cdnKey` in its own logs, and
  the prototype logs only an 8-character prefix in `idForLogging`. Keep them only in openings
  (BUILD_M1 puts field 216 inside the commitment).
- CDN copies expire after about 30 days on real servers.

### 4.4 Size limits

- **Outgoing.** `global.attachments.maxBytes`, default 100 MiB, compared against the padded
  ciphertext (`AttachmentSize.std.ts`, `isAttachmentTooLargeToSend`). That check is in the UI path
  only; `encryptAndUploadAttachment` does none, and the mock's tus has no limit. Real servers answer
  413, and `encryptAndUploadAttachment` then refreshes remote config. M1 pieces are 1 MiB, far
  below the limit.
- **Incoming.** `getMaximumIncomingAttachmentSize` is applied only by `AttachmentDownloadManager`
  (`:295`). The direct path has **no cap**, so M1 must:
  - refuse a pointer whose `size` disagrees with the descriptor (k = 20, so at most 2^20, and the
    last piece exactly L mod 2^20);
  - cap the stream at `getAttachmentCiphertextSize` of `size` with `mediaTier: STANDARD`
    (`ts/util/AttachmentCrypto.std.ts:26`), as `downloadAttachment`'s `checkSize` does
    (`downloadAttachment.preload.ts:421`).
- **Frames.** `MAX_FRAME_BYTES` = 256 MiB (`daemon.node.ts`). A 64 MiB stream in `BT_BUILD` fits.
  zrdtd answers in order, so hashing 64 MiB (about 1.3 s at 50 MiB/s) delays chat ops by that
  much, inside the 10 s `ZRDT_DAEMON_TIMEOUT_MS`.

### 4.5 How the smoke drives attachments

- **Chat attachments:** the stock helper `sendMessageWithAttachments`
  (`ts/test-mock/helpers.node.ts`; `ts/test-mock/messaging/attachments_test.node.ts`) sets the file
  input from the UI.
- **App pieces:** through the desktop's endpoint (the CLI) or a CI hook (`appProbeSend`). Both are
  in the prototype.
- **The villain on the CDN:** the harness owns `cdn3Path`. The prototype deleted
  `<cdn3Path>/attachments/<key>` (Bob's refetch: `HTTPError 404`) and flipped one byte in the middle
  of another (`decryptAttachmentV2(...): Bad MAC`).
- **Choosing objects, as a server would.** The CDN keys are end-to-end encrypted, so `EvilServer`
  cannot read them from messages. Override `getAttachmentUploadForm` (public on `Server`; the gRPC
  route calls it on every upload) to record `{key, at}` in issue order. Then "delete pieces 3, 7,
  12" means the 3rd, 7th and 12th uploads after arming; the fork uploads in index order. The
  route does not pass the requesting device, though a real server knows it.
- **"Corrupt piece 15 on its way to Carol"** (BUILD_M1 §1 step 3): GETs are anonymous, so corrupt
  the object after Bob's fetch and before Carol's. Corrupting one request in flight would need a
  patch to `packages/mock-server`'s HTTP handler, which `EvilServer` cannot override.

## 5. Storage and the service

- **Today.** `ZrdtServiceCore` keys stores by `ChatKey` = conversation id. `init` reads
  `getZrdtConversationIds()` and re-opens each one with `groupIdOf(conversationId)`
  (`service.preload.ts`, which looks up the conversation's `groupId`). A synthetic key would get no
  group id and fail to re-open.
- **Channel stores.**
  - Key: `app:<conversationId>:<channelIdHex>`.
  - Reuse `zrdt_records`, `zrdt_pending` and `zrdt_provenance`; their `conversationId TEXT` column
    holds any key.
  - Add `zrdt_app_channels (key PK, conversationId, app, name, channelId BLOB)`, and make
    `groupIdOf` return `channelId` for `app:` keys.
  - `heldOpenings` (`service.preload.ts`) reads openings from message rows by `zrdtDigest`. For
    `app:` keys it must read `zrdt_app_openings (key, digest, opening)` instead; BUILD_M1 keeps app
    openings for good.
- **Piece stores** (BUILD_M1 §2.2, their own table in `zrdtd`):
  - key `piece:<storeIdHex>`;
  - piece bytes on disk under `<userData>/zrdt-apps/<storeIdHex>/<i>`;
  - an index table `zrdt_app_pieces (storeKey, idx, digest, path, source)`;
  - not re-opened by `init`: after a restart the host binds again and re-runs `PIECE_ACCEPT` over
    the kept bytes.
- **Migration** `ts/sql/migrations/1870-zrdt-apps.std.ts` and `index.node.ts`. `pnpm run generate`
  rewrites `DATABASE_SCHEMA.md` (its `build:db-schema` step).
- **UI and badge.** `zrdtEvents` `accepted` and `classify` would fire for `app:` keys. The chat
  slice (`ts/state/ducks/zrdt.preload.ts`) must ignore keys that are not conversations, or the app
  events need their own emitter.

## 6. The local endpoint (desktop process)

### 6.1 Main process or preload

|              | Preload (main window renderer)                                                                                                      | Main process                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Reaches zrdt | Directly: `zrdtService`, `MessageSender`, `ConversationController`, the uploads. `zrdtd` is already spawned here (`daemon.node.ts`) | Over IPC (`ipcMain.handle` / `ipcRenderer.invoke`) for every call |
| Node APIs    | Yes: `sandbox: false` for the main window (`app/main.main.ts:727`)                                                                  | Yes                                                               |
| Lifetime     | The renderer's. Signal hides the window rather than destroying it; a reload closes the server                                       | The app's; survives a renderer reload                             |
| Extra code   | none                                                                                                                                | IPC channels, plus queueing while the window loads                |

**Pick the preload for M1.** The prototype's `/whoami` reported `{type: 'renderer'}`, and
`http.createServer().listen(<path>)` and `listen(7470, '127.0.0.1')` both worked from there.
`demo/panel.ts` is a model for routing and parameters only: it runs in the harness process, not in
a desktop.

### 6.2 Shape (BUILD_M1 §5), and what the prototype checked

- **Socket** `<userData>/zrdt-apps.sock`, `chmod 0600` after `listen`, and `rm` before `listen` (a
  crash leaves the file; Signal's single-instance lock means no live owner).
  `window.SignalContext.getPath('userData')` gives the folder, which is also the harness's
  `m.storagePath`.
- **Path length.** The macOS `sun_path` limit is 104 bytes. The harness path measured 82
  (`/var/folders/.../T/mock-signal-XXXXXX/zrdt-apps.sock`); the production
  `~/Library/Application Support/Signal/zrdt-apps.sock` is about 60. Over the limit, `listen`
  fails, so a custom `--user-data-dir` needs a short-path fallback, e.g. `os.tmpdir()` plus a
  pointer file.
- **Token** `<userData>/zrdt-apps-<app>.token` (0600), one per app, so a client sees only its own
  app's channels. The prototype has one `probe` token, checked as `Authorization: Bearer`.
- **TCP** (the prototype's optional `127.0.0.1:7470`) is for debugging only. Browsers can reach
  loopback (CSRF, DNS rebinding), so the TCP listener refuses any `Origin` header and any `Host`
  but loopback, and requires the token. Checked: no token gives 401, `Origin` gives 403.
- **Framing.** BUILD_M1 says JSON lines over `net`; the prototype used HTTP over the socket for
  brevity. JSON lines suits `subscribe` (one long-lived stream; HTTP would need chunked or SSE).
  Keep JSON lines, with `{app, token}` as the first line. The transport facts above hold for both.
- **Startup.** In M1 the endpoint starts on its own, not from a CI hook: in
  `ts/background.preload.ts` after `ConversationController.load()` and `zrdtService.init()`
  (`:1242-1248`), gated by `ZRDT_APPS=1` (or a setting), and closed on `beforeunload`. In the
  prototype it starts only through `SignalCI.zrdt.appProbeListen`.
- **Consent.** `share` (TRANSPORT §5.6) and torrent "share" need the fork's dialog: a redux action
  and a modal like `ZrdtCompareModal`. The socket request waits on the user's answer; the harness
  clicks the button with Playwright.
- **Never over the socket:** pointers, openings, nonces, `SERVE` (BUILD_M1 §5).

## 7. The harness and the CLI

### 7.1 Driving a CLI against a desktop (prototype)

- `demo/appProbe.ts` runs `demo/app-probe-cli.mjs` as a child process (`execFile` of
  `process.execPath`) with the environment the M1 tools will read:
  - `ZRDT_SOCKET=<userData>/zrdt-apps.sock`, or `ZRDT_URL=http://127.0.0.1:7470`;
  - `ZRDT_TOKEN_FILE=<userData>/zrdt-apps-probe.token`.
- Alice was driven over TCP, Bob and Carol over their sockets.
- In M1 the endpoint starts with the app, so the harness derives both paths from `m.storagePath`
  and waits for the socket file. The CI hook is not needed.
- **git.** `git-remote-zrdt` inherits git's environment, so `ZRDT_SOCKET` works, as does
  `git -c zrdt.socket=<path>` or `git config zrdt.socket` in the member's repository.
  - The harness makes one working tree per member: `git init --object-format=sha256` (the Mac's
    git is 2.54.0, which has SHA-256).
  - `PATH` gets `tools/git-remote-zrdt/bin` prepended.
- **Live demo (visible windows).** `demo/launch.ts` writes
  `demo/artifacts/apps-env/<member>.sh` (`export ZRDT_SOCKET=...; export ZRDT_TOKEN_FILE=...`).
  The presenter runs `source` on it in one Terminal per member, then `zbt share ...` or
  `git push team main`.

### 7.2 Harness changes for M1

- **Groups.**
  - `setUp` creates one group "Camping" and `Demo.group` is singular. `addToGroup` and
    `openGroup` use it.
  - `EvilServer` keeps one membership set (`#group`) for its rules.
  - The git beat needs "Code" (Alice, Bob, Carol; Dave added later). Make groups a list
    (`groups: [{title, founders, late}]`) and add a group argument to `addToGroup`.
    `writeStorageState` already takes one group per phone; it needs a list.
- **CDN villain** (§4.5): `EvilServer.getAttachmentUploadForm` override, `uploads[]`,
  `deleteUpload(i)`, `corruptUpload(i)`; panel actions for the live demo.
- **Withhold a 1:1 message:** the existing `hold` and `blackhole` rules (`demo/rules.ts`).
- **Dave as the tampering member.** Every desktop gets the harness's environment
  (`ts/test-mock/playwright.node.ts:88` passes `...process.env`), so `ZRDT_DEMO_VILLAIN=tamper`
  would affect all of them. Use a CI hook on Dave's desktop after linking
  (`SignalCI.zrdt.setVillain('tamper')`). It exists only in CI builds, so the shipped app keeps no
  villain code path.
- **Size.** At least three members per group, so group sends are multi-recipient (§2.1).
- **New files:** `demo/smoke-apps.ts`, `demo/beats/{torrent,git}.ts`. Use the panel port given to
  the run (`ZRDT_PANEL_PORT`).
- **Timing on the Mac mini:** a desktop links in about 3 s; the whole three-desktop probe takes
  13 s.

### 7.3 Before any smoke on the shared Mac

`pgrep -fl 'demo/(smoke|launch|beat)|run-demo'`, and wait while another run is up. The probe's
runner does this (§8.3).

### 7.4 CI hooks: a trap

`start.preload.ts` copies `window.SignalCI` into the page with `contextBridge` before
`installZrdtCIHooks` runs. A hook missing from `ZRDT_CI_HOOK_NAMES` (`ts/CI.preload.ts`) therefore
never reaches the page. The list `satisfies Record<keyof ZrdtCIHooks, true>`, so `tsc` catches a
hook in the type but missing from the list. Hooks return plain JSON; Playwright clones the
arguments.

## 8. The prototype

### 8.1 What it is (commit on `apps-map`, local)

| File                                        | What                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protos/SignalService.proto`                | Content `zrdtApp = 205`; `ZrdtAppMessage {15 groupV2, 200 zrdt, 201 zrdtAudience, 210 app, 211 channel, 212 body, 215 descriptor, 216 pointers}`; `ZrdtPointers {repeated AttachmentPointer pieces = 1}`                                                    |
| `ts/util/handleMessageSend.preload.ts`      | Send type `zrdtApp`; `shouldSaveProto` false                                                                                                                                                                                                                |
| `ts/textsecure/MessageReceiver.preload.ts`  | The 205 branch (§3.1)                                                                                                                                                                                                                                       |
| `ts/zrdt/apps/probe.preload.ts`             | `appProbeSend` (fresh-key uploads, Content 205, `sendContentMessageToGroup` in the conversation queue), `handleZrdtAppMessage` (slice, round-trip check, membership, in-memory fetch), `appProbeRefetch`, `appProbeListen` (socket and TCP endpoint, token) |
| `ts/zrdt/ci.preload.ts`, `ts/CI.preload.ts` | Hooks `appProbeListen`, `appProbeSend`, `appProbeReceived`, `appProbeRefetch`                                                                                                                                                                               |
| `demo/appProbe.ts`                          | The run: three desktops, 22 checks, `demo/artifacts/app-probe/result.json`                                                                                                                                                                                  |
| `demo/app-probe-cli.mjs`                    | The stand-in CLI (no dependencies)                                                                                                                                                                                                                          |

It makes no zrdt record (no `COMMIT`, `ACCEPT` or audience), keeps received state in memory, and
starts its endpoint only through a CI hook. `ts/` passes `tsc` and `oxlint`. The demo scripts pass
`tsc -p demo` but not `oxlint` (non-null assertions, a CLI's `console`); they are not meant to
merge.

### 8.2 Result (Mac mini, 2026-11-02, real `zrdtd`, `ZRDT_REQUIRE_LEAN=1`)

22/22 checks passed:

1. A chat message is still delivered (the zrdt record path is untouched).
2. Alice's endpoint is on `127.0.0.1:7470`.
3. Bob's socket is a socket with mode 0600 (path 82 bytes).
4. The token file has mode 0600.
5. A request without the token is refused (401).
6. A request with an `Origin` header is refused (403).
7. The endpoint runs in the renderer (preload).
8. Alice uploaded and sent.
9. The Content 205 is 437 bytes.
10. The mock CDN objects exist, with the ciphertext sizes (1,093,888 and 307,680).
11. Bob received the app message and fetched its pieces.
12. App, channel and body are as sent.
13. The sender is Alice, a member.
14. The bytes as sent (433) re-encode identically.
15. Both pieces decrypt to Alice's bytes (SHA-256 equal).
16. Carol received it and fetched both pieces.
17. The server saw one multi-recipient send that reached Bob and Carol (one `sendId`, 975-byte
    envelopes).
18. Neither desktop has a message row.
19. The same plaintext gets a new CDN object.
20. A second app message is received too.
21. A deleted CDN object gives `HTTPError 404`.
22. A corrupted CDN object gives `Bad MAC`.

### 8.3 How to run it

From the fork root, after `make install` (or `pnpm install`, `pnpm run generate`, and `lake build
zrdtd` in `zrdt/core`):

```sh
ZRDT_REQUIRE_LEAN=1 SIGNAL_MOCK_TESTS_BACKGROUND=1 node --import tsx demo/appProbe.ts --port 7470
```

After a change under `ts/`, run `pnpm run generate` again; the desktops load `bundles/`.

### 8.4 Not covered

- The real freeze: `APP_MESSAGE`, `COMMIT`, `ACCEPT`, and the audience.
- Own-device copies.
- Retries and the job queue.
- Sealed `SERVE` replies on the CDN (`sealedOnCdn`).
- JSON-lines framing.
- Real-server limits: Content size, upload 413, rate limits.
- Resumed downloads, which the mock cannot do (§4.2).
- More than two pieces per message.

## 9. Open issues

- **O1 (coordination).** Land `PROTOCOL_VERSION` 5 with the submodule bump (§1.3); otherwise chat
  fails closed. Alternatively, accept {4, 5} until the switch.
- **O2.** Received state must be persisted before `#removeFromCache` (§3.2). The prototype does not
  do this.
- **O3.** The direct download path has no size cap. Enforce the descriptor's sizes (§4.4).
- **O4.** Channel keys in `ZrdtServiceCore.init` and `groupIdOf`, and app openings outside message
  rows (§5).
- **O5.** Multi-group harness, and a per-desktop villain through a CI hook rather than the
  environment (§7.2).
- **O6.** The CDN villain picks objects by upload order, since the mock does not pass the
  requester to `getAttachmentUploadForm` (§4.5).
- **O7.** No sendLog copy (`zrdtApp`). A member who fails to decrypt a 205 gets no copy from
  Signal and must rely on zrdt repair (by design, T-M2). Say so in the beat's narration if it
  shows.
