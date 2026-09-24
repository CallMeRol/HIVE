# Teahouse technical design

> [简体中文](../tech-design.md) · **English**

| Field | Value |
|---|---|
| Current design | v1.85; v0.60.1 contact profile revisions and refresh (#316) |
| Runtime baseline | Electron 22.3.27 / Node 16.17 / Chrome 108 |
| Upstream | [Requirements](requirements.md), [Protocol](protocol.md), and [UI design](ui-design.md) |
| Authority | [tech-design.md](../tech-design.md) is the canonical technical design record |

## 1. Technology decisions

| Area | Decision | Rationale |
|---|---|---|
| Language | TypeScript across main, preload, renderer, and shared code | One strict contract language for wire, IPC, and storage models |
| Build | electron-vite 2 and Vite 5 | Separate bundles with enforced Node 16 / Chrome 108 targets |
| Renderer | Vue 3 and Pinia | Component/state model fits the three-column desktop UI |
| Styling | Native CSS variables plus selective Naive UI 2.43.2 | Mature forms with project-owned messenger surfaces |
| Storage | better-sqlite3 9.6.0, WAL, FTS5 | Synchronous main-process access with one audited native module |
| Images | Chromium canvas and `createImageBitmap` | Avoid additional native image dependencies |
| OCR | PaddleOCR PP-OCRv6 tiny through onnxruntime-web 1.20.1 | Fully local model and WASM runtime |
| Configuration | Atomic JSON writes through temporary file + rename | Small, dependency-free, and Node 16 compatible |
| Logging | Lightweight daily files, seven-day retention | Metadata-only logs without a new dependency |
| Packaging | electron-builder 24.13.3 | Windows, Linux, and macOS output matrix |
| Unit tests | Vitest 2 | Direct coverage of Electron-free modules |

Dependencies use exact versions. Electron remains exactly 22.3.27. `better-sqlite3` is the only permitted native module and is rebuilt for Electron ABI 110.

### 1.1 Naive UI boundary

- Keep `naive-ui@2.43.2`; 2.44.x requires Node 20 and violates the toolchain/runtime matrix.
- Import it only from renderer roots/components. Do not move it into the common `main.ts` startup closure.
- Use `renderer/src/ui/naive-theme.ts` to map design tokens.
- Keep named imports and tree shaking; do not add vfonts, xicons, CDN assets, or remote resources.
- Reuse the root provider for Group Creator and Profile Card. Dense selection lists remain lightweight project nodes.

### 1.2 Renderer performance profile

Structural panes use CSS surfaces, inset borders, and controlled shadows. Blur is limited to true overlays. Main process computes `softwareRendering` for Windows 7/Linux and renderer roots use solid overlay surfaces and shorter shadows. Image OCR is manually triggered on every platform (#304).

Decision #305 restores the existing expanded detection box for both recognition and selection: DB contours describe a shrunken region, so the separate raw textBox output is removed without changing inference thresholds or crop pixels. It calibrates native text selection boxes to OCR line bounds with offsets and two-axis scaling. Measure only during result layout construction, in batches of at most 128 lines with event-loop yields and stale-result cleanup; preserve one node per line and the memoized zoom subtree. Clear an owned selection on non-Shift left pointerdown before native caret placement to prevent text drag-and-drop. Track text-origin gestures at pointerdown and release them on pointerup/cancel, blur or cleanup; the parent canvas keeps a text cursor during selection without pointermove scanning.

The image viewer reuses bounded OCR caches and runs uncached PaddleOCR work in one local Worker with one WASM thread. Preprocessing is serialized; image changes cancel active work and closing releases the worker. Each recognized line becomes one transparent native text node fitted to its existing expanded detection box (#305 corrects the use of raw shrunken contours). Browser selection handles partial and cross-line copying; zoom reuses the line subtree and updates its parent transform. Empty results remain retryable. Input limits, local models, cache IPC and strict CSP are preserved.

Static and common renderer bundle sizes are checked after every build. Four renderer roots remain independently reachable. The main App static closure budget accounts for File Cabinet and selected Naive UI controls; the common startup closure stays bounded.

## 2. Process and window model

```text
Main process — Node 16.17
├─ Network I/O: UDP 17878 and TCP 17879
├─ SQLite repositories and configuration
├─ Services that orchestrate network + storage
├─ Tray, notifications, shortcuts, startup, single-instance lock
└─ Window management
   ├─ Main window, 960×640 minimum, frameless
   ├─ Settings, 640×480, lazy singleton
   ├─ Capture window(s), one per display, ephemeral
   └─ Image viewer, lazy/managed

Renderer processes — Chromium 108 sandbox
└─ Vue roots whose state is projected through IPC
```

The app requests a single-instance lock and focuses the existing main window on a second launch. Main window starts hidden and appears after `ready-to-show`.

Security settings are fixed for every renderer window:

```text
contextIsolation: true
sandbox: true
nodeIntegration: false
```

All navigation is blocked, `setWindowOpenHandler` denies new windows, and renderer CSP permits only required local schemes/resources. Main process adds `no-proxy-server` before networking starts.

macOS uses hidden-inset traffic lights. Windows/Linux draw client controls and use IPC for minimize, maximize/restore, and close. Renderer DOM never calls `window.close()` for the main window because that can bypass the hide-to-tray close path.

## 3. Module boundaries

```text
src/
├─ shared/    dependency-free types, constants, protocol and IPC contracts
├─ preload/   the contextBridge implementation of PantryApi
├─ main/
│  ├─ net/       Electron-free discovery, codec, messaging, transfer
│  ├─ store/     Electron-free SQLite repositories and migration logic
│  ├─ services/  use-case orchestration
│  ├─ util/      pure filesystem/data helpers
│  └─ windows/   Electron window and tray integration
└─ renderer/  Vue UI, Pinia projections, project components, local assets
```

Dependency rules:

1. Renderer imports no Node or Electron module.
2. `net/` and `store/` remain independent and Electron-free.
3. IPC handlers validate and forward; business decisions live in services.
4. Shared code has no runtime dependency.
5. Network and storage modules receive configuration and collaborators through constructors or explicit methods.

<a id="remote-view"></a>

### 3.1 Remote desktop viewing (#310, v0.58.0)

Scope follows [requirements](requirements.md#remote-view); wire fields and hard limits live in [protocol §8.3](protocol.md#remote-view), and presentation in [UI behavior](ui-design.md#remote-view). Reuse Electron 22 display capture, Canvas JPEG, and the existing TCP listener. No runtime upgrade, new dependency, server, or listening port.

#### 3.1.1 Responsibilities

| Location | Responsibility |
|---|---|
| `shared/protocol.ts`, `net/codec.ts`, `net/frame.ts` | Constants/types, exact control/frame allowlists, existing raw-byte FrameReader |
| `net/transfer.ts`, `net/screen-stream.ts` | First-frame routing, independent screen connection without file slots, one-frame backpressure, deadlines and pacing; no Electron or storage |
| `net/messenger.ts` | Non-queued control, actual UDP/TCP source validation before dedup/address refresh, bounded memory-only screen dedup, abortable request/accept retries |
| `services/remote-view.ts` | One authoritative session, role/peer/grant/state, terminal cache, injected sample/display operations; no Electron |
| `windows/remote-view-window.ts` | Restricted independent window, selected-screen grant, media permission, IPC identity, lock/suspend and forced destruction |
| `util/linux-screen-lock.ts` | Existing DDE/UKUI lock-state reads and monitoring through system gdbus |
| `RemoteViewApp.vue`, `#/remote-view` | Fifth dynamic renderer root for local selection/capture/encoding or image decoding/viewing; no Node/Electron/remote URL |
| `shared/image-metadata.ts` | Reused JPEG type/dimension inspection |

The fifth root has a 128 KiB JS / 16 KiB CSS budget. Retain all four existing root budgets and the 200 KiB common bootstrap budget. No database or persistent setting is added.

#### 3.1.2 Capture and permission

1. Receipt displays consent only. Enumerate local screen thumbnails after Choose screen, under the original request deadline. Never transmit source IDs, names, or thumbnails to the peer.
2. Bind the current session, window main frame and locally selected source. Use `setDisplayMediaRequestHandler` and `getDisplayMedia({audio:false,video:...})` in a separate memory-only session. Permission checks deny by default. Real Electron 22 reports display permission as `media` with an empty `mediaTypes`; the request handler grants this once for the consenting preparing window, then the display handler consumes the selected source. Camera/microphone requests have nonempty types and are denied.
3. Keep one MediaStream/video/Canvas and asynchronously encode JPEG only when next requests a sample. Do not use repeated full-screen thumbnail enumeration, main-process encoding, or MediaStream IPC cloning.
4. Check session generation after awaits, fit current source dimensions proportionally and stop on removed source/ended track. Never switch sources automatically.
5. Main validates bounded bytes and JPEG metadata before IPC. The viewer decodes a local JPEG Blob with createImageBitmap, checks dimensions, and transfers ownership through bitmaprenderer (Canvas 2D fallback when unavailable). It closes the bitmap in finally and acknowledges consumption after replacement. Keep one canvas and one in-flight bitmap without per-frame Blob URLs or HTML image caches. No animation-frame dependency when minimized. Enlargement cannot recover lost source detail.

Retain sandbox/contextIsolation, disabled Node integration, navigation/window-open blocks and the existing strict CSP. `video.srcObject` works with this CSP in the synthetic Electron test. Reference: [Electron 22 display-media handler](https://github.com/electron/electron/blob/v22.3.27/docs/api/session.md#sessetdisplaymediarequesthandlerhandler). API availability alone does not prove physical desktop compatibility.

#### 3.1.3 Defaults and load

| Item | Current implementation |
|---|---|
| Rate | Auto starts at 10 and selects 10/5/3 fps; manual Economy 3, Standard 5, Smooth 10 |
| Dimensions | Long edge ≤1600, preserve aspect ratio, do not enlarge small screens; also enforce protocol pixel bounds |
| JPEG | Quality 0.60; when oversized retry 0.50, then long edge ≤1280 at 0.50, at most two retries within the original deadline |
| Resources | One current frame, one encode/write, one display; no historical queue, file cache, tile encoder or worker pool |
| Byte budget | JPEG ≤5 MiB/s, one frame of credit; consume actual byte size |

Measure between sampling starts, waiting only the remaining interval/byte budget. Auto times the full next → consumed cycle, including capture, encoding, network, decoding and IPC, excluding deliberate pacing. Three consecutive cycles exceeding 80% of the current interval lower one tier. A downshift blocks upgrades for ten seconds; ten seconds continuously below 60% of the next faster interval permit one upgrade. Hysteresis is covered by deterministic tests; target hardware calibration is still pending.

Only the viewer can change mode. Changes reset rate counters and affect subsequent requests without reconnecting, recapturing or changing image quality. Real throughput may be below the selected target. Minimized viewers temporarily request 3 fps, then restore the selected mode. Media capture starts at 10 fps and uses a 1600-pixel maximum on both dimensions. Local sampling cadence reduces track constraints after three intervals of at least 160ms / 280ms to 5 / 3 fps, increasing promptly when requests speed up. Apply constraints only on changes, retain working capture if unsupported, and never reacquire permission. This bounded heuristic adds no wire fields or CPU telemetry; OS capture savings require physical testing. Preserve Win7/Linux software rendering.

#### 3.1.4 State, IPC and cleanup

One session follows requesting/awaiting-consent → preparing/connecting → active → ended. Phase changes clear prior timers; preparation retains the invitation deadline. End invalidates grants/bytes and retains terminal metadata for chat feedback; a later request replaces the session. Renderer claims alone never authorize a socket.

| IPC | Caller and purpose |
|---|---|
| `screen:request` | Main window; recheck online status, capabilities, busy state and rate limits |
| `screen:sources`, `screen:respond` | Current sharer window; consent and a source belonging to this local enumeration |
| `screen:ready`, `screen:fail` | Sharer capture readiness/failure; viewer reports subscriptions ready before main delivers the one buffered first frame |
| `screen:availability`, `screen:get-state`, `screen:state` | Main/assistance projections, revision-checked subscription followed by snapshot |
| `screen:sample` → `screen:frame` | One requested JPEG from the authorized sharer window; main validates again |
| `screen:image` → `screen:consumed` | Decode/draw before next; only the current viewer can acknowledge |
| `screen:set-mode` | Current viewer only, `auto/economy/standard/smooth` allowlist |
| `screen:stop` | Related window or local main entry; idempotent, no network wait |

Exact types live in `shared/ipc.ts` and `shared/remote-view.ts`. Tokens remain in main, outside renderer state/URLs/logs. End invalidates generation and grant, aborts retries, destroys sockets and the entire assistance window, and rejects pending capture/display work. Renderer cleanup stops tracks and releases video/Canvas/Blob references; main destruction also covers unresponsive or crashed renderers. Main handles close, crash, unresponsive and quit. Chat shows the localized terminal reason after the assistance window closes.

#### 3.1.5 Platform gates

| Environment | Required physical checks / current boundary |
|---|---|
| Win7 SP1 x64 and ia32 | Capture, software-rendering CPU/memory, DPI, lock and VM display changes; each architecture separately |
| Win10/11 | Permission, multiple displays/DPI, lock, minimize and protected content |
| UOS/Kylin X11 x64/arm64 | Sustained capture and real desktop lock interface; screenshots do not establish compatibility |
| Linux x64 Wayland | Portal/PipeWire, consent cancellation, repeated authorization, source loss and lock per desktop |
| Linux ARM64 Wayland | Preserve #289 pre-enumeration sharing block; receiving needs separate verification |
| macOS arm64 | Physical screen permission grant/deny/revoke, lock/suspend and multi-display changes |

Electron 22 native lock/unlock signals cover Windows/macOS ([versioned documentation](https://github.com/electron/electron/blob/v22.3.27/docs/api/power-monitor.md)). Linux uses existing `gdbus` to read/monitor DDE `com.deepin.SessionManager.Locked` or UKUI `org.ukui.ScreenSaver.GetLockState` / `lock` / `unlock`. Startup checks both the method and monitor name ownership; request/consent refresh state. Initialization runs asynchronously without delaying chat. Support the newer org.deepin.dde.SessionManager1 Locked property as well. Signals plus five-second active / sixty-second idle polling detect changes; ignore unrelated properties. Retry missing or lost monitoring every sixty seconds, restoring capabilities only, never the terminated session. Command timeout, unknown state, owner loss or monitor exit disables capability and ends the session. Do not install tools/services or infer lock from idle time. References: [DDE property](https://github.com/linuxdeepin/startdde/blob/5.8.17/session.go), [DDE service](https://github.com/linuxdeepin/startdde/blob/5.8.17/session_stub.go), [UKUI interface](https://github.com/ukui/ukui-screensaver/blob/master/src/org.ukui.ScreenSaver.xml).

UKUI uses object path `/`, as defined by its [upstream constants](https://github.com/ukui/ukui-screensaver/blob/master/src/types.h). A delayed property reply cannot overwrite a newer lock signal.

Advertise roles only after UDP/TCP readiness and usable lock detection; block ARM64 Wayland sharing independently. Recheck availability before authorization/connection. Unlock, resume and restored connectivity never resume an ended session automatically.

#### 3.1.6 Validation and target acceptance

Run `npm test`, `npm run test:db`, `npm run typecheck`, `npm run build`, and `npm run smoke`. After build, `npm run test:screen` launches real Electron 22 with synthetic office content, actual media/Canvas/IPC/TCP/decode, consent/stop, four modes, chat coexistence and lock-triggered destruction. `PANTRY_SCREEN_TEST_MS=600000 npm run test:screen` extends viewing to ten minutes. All test binds/sends are `127.0.0.1`, with broadcasts disabled and no capture of the user's desktop.

Protocol/service tests cover malformed controls/metadata/JPEG, source and token binding, simultaneous requests, cancellation before invitation, late accepts, phase deadlines, one-frame consumption, five-second slow/stuck frames, file-port coexistence, 30 service lifecycle cycles and simulated Linux lock failure. Bundle checks retain existing roots and add the fifth.

**Local results, 2026-09-16:** 120 test files / 776 tests passed, plus the real Electron-ABI database check, type checks, build and startup smoke. Synthetic-page viewing on macOS ran for 600,169ms at about 9.45 fps. Reverse `getDisplayMedia` → Canvas → IPC → TCP → decode delivered at least five frames before successful lock-triggered termination. Chinese/English and dark-theme switching, a 480×360 viewer, fit/100%, stale-frame feedback and recovery also passed. This loopback rate measures synthetic-page serving and does not establish Win7/UOS throughput.

**Acceptance boundaries:** synthetic capture replaces OS enumeration/permission results. It does not validate physical screens, cursor, real lock desktop, DPI/multi-screen or Win7/UOS/Kylin performance. Thirty service cycles do not substitute for thirty physical capture sessions. On target machines, inspect real office menus/errors/tables at 100%, run ≥10 minutes and ≥30 capture cycles, record actual fps, both-side CPU/memory/bandwidth, first frame, and p50/p95 end-to-end latency. Initial wired-LAN targets are ≤3 seconds to first frame after capture is ready and p95 ≤1.5 seconds; record failures before making platform claims. Verify stop leaves no active socket/track/timer and no growing queue or per-cycle memory trend. Do not remove runtime or capture guards to make an unsupported environment appear available.

## 4. IPC contract

`src/shared/ipc.ts` defines `PantryApi`, the single type source for `window.pantry`. Preload implements the bridge explicitly. Main handlers use narrow channel names and validate every argument before service invocation.

Major capability families include:

- app/profile/settings and platform information;
- peer discovery, ranges, refresh, contacts, notes;
- conversations, messages, search, groups, recall, forward, nudge, PK;
- file/image/folder selection, path grants, offers, transfer actions;
- cabinet configuration, grants, browse, download, upload, recent uploads;
- backup/export/import;
- capture, image viewer, OCR, clipboard, and open-location;
- window controls and Settings modal state.

Main process sends event projections to the relevant windows. It does not expose raw Electron objects, filesystem handles, sockets, or SQLite access.

## 5. Network architecture

- `codec.ts` performs exact envelope/payload allowlist validation and bounded decoding.
- `udp.ts` owns socket/broadcast behavior and rate limits.
- `discovery.ts` coordinates entry, heartbeat, offline state, probing, and gossip.
- `messenger.ts` owns ACK waiters, retry, TCP fallback, and persistent-queue callbacks.
- `transfer.ts` owns framed TCP control and receiver-pull byte streams.
- `frame.ts` terminates malformed streams after the first parse error.
- `peer-registry.ts` tracks online endpoints; `peer-clock.ts` estimates display-time offsets.
- `range-sync.ts` handles bounded, low-rate CIDR sharing.

The transfer server allows three active data streams, 256 sockets, a 15-second first-frame deadline, and a 60-second active idle timeout. Queue and wait behavior is tied to a validated authorized pull.

Protocol changes follow: canonical protocol document → shared types/constants → codec validator → network/service implementation → tests.

## 6. Storage design

SQLite runs in WAL mode. The schema is migration-driven through `PRAGMA user_version`; released migrations are append-only.

Logical repositories cover:

| Repository/data | Purpose |
|---|---|
| Peers and notes | Persistent peer profile, address, local display note, last seen |
| Conversations | Private/group conversation metadata, unread, pin, mute, sequence |
| Messages | Message ID, sender, kind, timestamps, status, payload/file reference |
| Reliable queue | Sender-side offline retry envelopes and expiry |
| Deduplication | Recently received envelope IDs |
| Groups | Metadata, roles, revisions, avatar hash, member state |
| Transfers | Direction, purpose, file tree, progress, state, paths, expiry |
| Stickers | Managed local media metadata and order |
| Share grants | Per-peer cabinet permission override |
| FTS | Search projection for message text and supported metadata |

Configuration remains in atomically written JSON, including identity, network ports/ranges, UI preferences, directories, receive behavior, shortcuts, and file-cabinet root/default permission.

Database tests run through Electron's embedded Node via `ELECTRON_RUN_AS_NODE=1` because the native SQLite binary targets Electron ABI 110. Vitest runs pure repository logic that does not load the native module.

Decision #297 reduces global message search to one MATCH aggregation: text/PK rows contribute counts and ordering timestamps; all matching kinds contribute the maximum seq. Fetch summaries through `idx_messages_conv_seq`, falling back to the original lookup for non-unique seq values. Tokenization, file LIKE, limits, ordering, and conversation search remain unchanged; no schema migration is added.

## 7. Data directories and authorization

Application-managed data contains configuration, databases, logs, avatars, image media, stickers, thumbnails, OCR assets/cache state, update packages, and partial transfers.

Renderer input cannot name arbitrary filesystem paths. A main-process file/folder picker creates a window-scoped, one-time authorization. Sticker import uses a separate grant store, consumes each selected path once, then applies extension, real-image, pixel, and source-size gates before reusing the existing WebP/GIF collection pipeline. Managed schemes (`pantry-img`, `pantry-sticker`, `pantry-avatar`, and thumbnail equivalents) validate identifier, record state, type, and managed-directory containment before returning bytes.

Path policy rejects absolute remote paths, traversal, drive prefixes, reserved names/characters, and canonical paths escaping an approved root. Cabinet access additionally rechecks `realpath` beneath the owner root.

## 8. Renderer architecture

`renderer/src/main.ts` dispatches by URL hash to five roots:

- `App.vue`: main window with Chat, Contacts, and File Cabinet tabs;
- `SettingsApp.vue`;
- `CaptureApp.vue`;
- `ImageViewerApp.vue`;
- `RemoteViewApp.vue`.

Pinia stores are projections of main-process state. They do not implement authoritative network/storage behavior. Explicit conversation navigation receives a monotonic generation; asynchronous IPC results verify generation and target conversation before committing, preventing stale navigation results from replacing the current view.

Decision #298 keeps at most 10 inactive conversation snapshots totaling 3000 messages, evicting whole oldest snapshots and indexes. Active reading and pending removal undo are protected; late pages cannot recreate an evicted/reloaded view. Existing latest/history reload and forwarding objects remain intact. Transfer cards retain their states for their component lifetime; offering/accepted states stay resident. Up to 200 unused terminal states remain, with speed samples released immediately. In-flight reads defer eviction until completion so realtime events keep precedence. No IPC, database, configuration, or transfer state-machine changes.

Media rendering uses validated image metadata, near-viewport observation, a bounded 320px WebP derivative cache, and native lazy/async image behavior. The cache is rebuildable, capped at 128 MiB, and never included in backup.

Decision #299 bounds thumbnail cache checks, source reads, decode, and writes to 4 hardware or 2 software/unknown-profile jobs. Queue entries coalesce same-ID demand. The shared observer keeps tracking waiting elements; viewport exit, rebinding, and unmount release only that element, dropping unstarted jobs with no demand. Running work completes and releases its slot. Completed URLs use the existing 512-entry `BoundedLruCache`; running work remains independently shared until completion. Existing original/animated/small-image fallbacks, cache parameters, dimensions, disk limits, viewer, and OCR gates stay intact.

Windows 7 uses the tested system-font contenteditable composition path. Other systems use the textarea/mirror path. WebContents zoom replaces renderer CSS body zoom so IME/screen coordinates remain in Chromium's native transform chain.

Decision #296 makes the existing message-index container and per-conversation ID maps shallow-reactive for quote lookup. Message objects keep their existing reactivity; index replacement and per-ID changes remain observable. Historical-message and transfer reads coalesce only in-flight promises, released on every outcome. Transfer results fill only absent projections so newer push events win; failed/missing reads can be retried.

## 9. Export and import

`.pantry-bak` is a ZIP-compatible migration archive:

```text
manifest.json
messages.jsonl
peers.json
groups.json
stickers.json
media/transfers/...
media/stickers/...
media/avatars/...
```

Import rewrites prior local `is_mine` senders to the current Node ID, merges newer peer metadata, and uses message IDs for deduplication. Only media present in the archive is restored into managed locations. Ordinary transferred files remain filename/history references and are not copied into the archive.

Readable export supports self-contained HTML and plain text. The custom archive reader/writer uses store/deflate and adds no runtime dependency.

## 10. Risks and controls

| Risk | Control |
|---|---|
| Electron 22 age | Strict local-only renderer, sandbox/isolation, blocked navigation, allowlisted inbound data |
| Windows 7 / UOS glyph differences | Project icons, local Twemoji, platform-specific composer paths |
| Debian 10 glibc 2.28 | Build native module inside Buster container and inspect GLIBC symbols in final package |
| Linux arm64 packaging | Native arm64 runner inside Buster container; pinned ffi/fpm; final architecture and GLIBC checks |
| Weak/old GPU drivers | Disable hardware acceleration by default on Windows 7 and Linux; software-rendering UI profile |
| Wayland and Linux desktop capture differences | Detect Wayland from `XDG_SESSION_TYPE` (falling back to `WAYLAND_DISPLAY`) and merge-enable Electron 22's `WebRTCPipeWireCapturer`, but still probe `desktopCapturer` instead of returning early. Wait for the main-window hide signal plus compositor settling and verify invisibility before capture. Restore and provide in-app or system-notification guidance for empty sources, empty images, or exceptions, including the system-capture + `Ctrl+V` fallback. |
| Broadcast isolation | Manual IP, rate-limited CIDR probe, gossip, persisted peer cache |
| Large files/images | Streaming file I/O, bounded metadata/decode, pixel limits, bounded thumbnail/OCR caches |
| Malformed/slow TCP peers | Exact frame allowlists, per-socket failure isolation, connection/stream/time budgets |
| Unsolicited update package | Source/version/platform/architecture-bound one-time gate and exact package/size/version checks |
| Arbitrary local path read | Picker authorization, managed schemes, record-state checks, canonical containment |
| Clock skew | Local monotonic sequence plus bounded peer-clock correction for display |
| 1,000-peer bursts | Jitter, rate limits, bounded inbound queues, aggregation before renderer projection |
| Compatibility-mode leakage | Separate socket/codec/service/projection; default off; implementation paused |

## 11. Build and CI

electron-builder settings:

| Platform | Targets | Architecture/baseline |
|---|---|---|
| Windows | NSIS and portable | x64 and ia32; Windows 7 SP1+ |
| Linux | deb and AppImage | x64 and arm64; Debian 10 / UOS 20 glibc baseline |
| macOS | dmg and zip | Apple Silicon arm64 |

`productName` is ASCII `Teahouse` for safe installation paths while platform display/shortcut names use 茶话间. Linux packaging disables hard-link copy optimization and validates that the deb archive has no cross-directory hard link or Chinese installation path.

GitHub Actions runs five platform jobs. Each validates package/tag versions, installs exact dependencies, rebuilds/checks native binaries, runs the standard five checks, builds artifacts, and emits SHA-256 manifests. A tag-triggered publish job downloads all artifacts, verifies artifact versions, generates bilingual release headings and package guidance, and creates/updates the GitHub Release with write permission limited to that job.

`package.json` is the version source. `package-lock.json`, `v<version>` tag, and every `Teahouse-<version>-...` artifact must match. Documentation/refinement increments patch; user-visible features increment minor and reset patch.

## 12. Test strategy

- Vitest for codec allowlists, pure utilities, service behavior, queueing, UI source/logic, and loopback network integration.
- Electron-ABI database self-test for migrations, repositories, and FTS.
- Type checks for Node 16 and Chrome 108 targets.
- Production build plus renderer bundle/reachability budgets.
- Electron launch smoke test.
- Real target-system validation for installation, startup, discovery, messaging, files, cabinet, tray, notifications, shortcuts, capture, and input methods.

Network integration binds `127.0.0.1` and uses empty broadcast targets. It must not contact the actual LAN.

## 13. Current milestone map

| Milestone   | Main delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|-------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| v0.1–v0.5   | Discovery, reliable private/group chat, files, media, capture, history/search, settings, export/import                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| v0.17–v0.18 | Scan-range sharing and global refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| v0.27+      | Peer-update discovery and package request/transfer foundation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| v0.28–v0.30 | Direct private files and media recall                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| v0.32+      | 200-member groups and UI/reliability hardening                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| v0.42–v0.44 | Content-addressed custom avatars and resilience                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| v0.45–v0.46 | File expiry, IME/composition, table paste, group creation recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| v0.47–v0.49 | Shared file cabinet permissions, browsing, download, upload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| v0.50–v0.51 | First-class cabinet navigation, finalized as the third main-window tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| v0.51.1     | Maintained English documentation, locale validation, bilingual release headings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| v0.51.2     | Capability-first Wayland capture, verified main-window hiding, visible failure feedback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.52.0     | Native multi-image sticker import, stable scrolling grid, group sticker delivery to online members                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| v0.53.0     | Group-text reply-to (decision #288): optional `replyTo` source message ID on `group-text`; codec rejects empty strings and objects; receiver looks up source in local group conversation to populate `ReplyMeta`; stores raw ID in `messages.reply_to`; missing target is handled gracefully by the renderer. Protocol v0.51, SQLite advances to v15                                                                                                                                                                                                                                                                     |
| v0.53.1     | ARM64 Wayland capture skips Electron 22's unsafe native screen enumeration and uses the existing system-capture paste fallback; x64 Wayland, ARM64 X11, and other platforms keep their existing path (decision #289)                                                                                                                                                                                                                                                                                                                                                                                                     |
| v0.54.0     | Group description and announcement (decision #290): `GroupMeta` gains backward-compatible `description` (≤ 200 chars) and `announce` (≤ 1024 chars); owners, administrators, or password-authorized members may set or clear them. The codec validates present fields, service normalization preserves values omitted by old peers, and inbound metadata rejects unauthorized or mixed changes. SQLite v16 adds both columns and migration backups preserve them. `GroupPanel` routes one shared `GroupTextDialog` through the existing password-aware update path. Protocol v0.51, SQLite v16, version **0.53.1 → 0.54.0** |
| Paused      | Neiwangtong compatibility and experimental attachment interoperability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| v1.0 work   | Target-platform polish, updater completion, release documentation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 14. Change record

- **2026-09-16, v1.79, #308, documentation only:** add remote-view architecture, restricted capture/IPC, trial settings, cleanup, platform gates, and acceptance. No implementation; application remains **v0.57.0**.

- **2026-09-16, v1.80, #309, documentation only:** set the default target to 10 fps with 100ms sampling scheduling, a 5 MiB/s JPEG budget, and achieved-fps/CPU acceptance. Retain one-frame backpressure and load-driven reduction; application remains **v0.57.0**.

- **2026-09-16, proposal supplement:** describe Auto/3/5/10 request pacing and timing/hysteresis candidates without new wire fields. Product defaults and performance thresholds remain pending confirmation/validation.
- **2026-08-10, v1.61, decision #285:** introduced the maintained English technical reference, document-pair validation, and bilingual release headings; corrected the public development guide to the actual PaddleOCR/onnxruntime-web stack. Runtime architecture, protocol, database, and dependencies are unchanged. Repository version 0.51.0 → 0.51.1.
- **2026-08-26, v1.62, decision #286:** merge-enabled Electron 22's `WebRTCPipeWireCapturer` for Wayland while retaining capability probing through `desktopCapturer`; extracted hide-signal/compositor settling with a final visibility check; and added a main-to-renderer `capture:failed` path plus system-notification fallback. Protocol v0.50, SQLite v14, dependencies, and network behavior are unchanged. Repository version 0.51.1 → 0.51.2.
- **2026-08-27, v1.63, decision #287:** reused the existing sticker compression/store action for a separately authorized native multi-image picker, fixed the grid with native implicit-row sizing, and routed group stickers through the existing `offerGroupPaths(..., 'sticker')` path. Protocol v0.50, SQLite v14, dependencies, and ports are unchanged. Repository version 0.51.2 → 0.52.0.
- **2026-08-29, v1.64, decision #288:** group-text reply-to. The `group-text` payload gains an optional `replyTo` source-message-ID string. The codec accepts only bounded non-empty strings and rejects empty strings or objects with `senderName`/`text`. Receivers look up the source ID in the local group conversation, populate `ReplyMeta` with sender name and first-line text summary, and store the raw ID in `messages.reply_to`. If the target is absent locally, receipt succeeds and the renderer handles the unavailable-target prompt. Protocol advances to v0.51; SQLite advances to v15. Repository version 0.52.0 → **0.53.0**.
- **2026-08-29, v1.65, decision #289:** Issue #34's Kylin ARM64 Wayland crash occurs during Electron 22 native screen enumeration, outside JavaScript recovery. The shared `startCapture` entry skips that call only for ARM64 Wayland and reuses the existing visible system-capture paste fallback. Protocol v0.51, SQLite v15, dependencies, and network behavior are unchanged. Repository version 0.53.0 → **0.53.1**.
- **2026-08-31, v1.66, decision #290:** group description and announcement. `GroupMeta` gains `description` (≤ 200 characters) and `announce` (≤ 1024 characters). The codec accepts legacy omission, `GroupsService` preserves local known values and isolates each authorized metadata operation, and owners, administrators, or password-authorized members may set or clear either field. SQLite v16 adds both columns and migration backups preserve them. The renderer uses one `GroupTextDialog` through the existing password-aware update path. Wire protocol remains v0.51; SQLite advances to v16. Repository version 0.53.1 → **0.54.0**.
- **2026-09-05, v1.67, decision #291:** hardened PR #39 at the shared boundaries. `GroupsService` enforces one independently authorized remote description or announcement change and preserves omitted legacy fields through the same normalization path. `GroupPanel` reuses `prepareGroupAdminPatch` / `runUpdate`; one shared `GroupTextDialog` owns input and accessible interaction only. Backup import/export preserves both fields. Protocol v0.51, SQLite v16, dependencies, and ports are unchanged. Repository version 0.54.0 → **0.54.1**.
- **2026-09-05, v1.68, decision #292:** `GroupsService.canApplyRemoteInfo` uses the revision gap to distinguish adjacent operations from cumulative snapshots, independently authorizes text, and reuses the existing structural checks. Regression checks use snapshots generated by the sender and cover `need/info` catch-up, high-revision unauthorized edits, and invalid mixed operations. Protocol v0.51, SQLite v16, dependencies, and ports are unchanged. Repository version 0.54.1 → **0.54.2**.
- **2026-09-05, v1.69, decision #296:** reuse reactive quote indexes and coalesce in-flight message/transfer reads with realtime transfer precedence. Protocol, database, and dependencies stay unchanged. Repository version 0.54.5 → **0.54.6**.
- **2026-09-05, v1.70, decision #297:** one global FTS aggregation with existing indexed summary lookup and legacy fallback for non-unique seq values. Protocol, schema version, and dependencies remain unchanged. Repository version 0.54.6 → **0.54.7**.
- **2026-09-05, v1.71, decision #298:** bound inactive conversation snapshots/indexes and unused terminal transfer states, protecting active references and pending reads. Repository version 0.54.7 → **0.54.8**.
- **2026-09-05, v1.72, decision #299:** schedule thumbnail pipelines at 2/4 concurrency and drop undemanded queued work, reusing the existing LRU. Repository version 0.54.8 → **0.54.9**.

- **2026-09-05, v1.73, decision #300:** Linux uses `scripts/ci-install-linux.sh` to run npm ci without hooks, restore electron/esbuild/protobufjs/vue-demi setup, and source-build better-sqlite3 exactly once. Tests check the lifecycle list against the lockfile. Each job builds once and directly runs smoke/packaging; local smoke/dist scripts remain self-contained. Cache only downloads, separated by job, with lockfile keys and same-platform fallback; do not cache node_modules/native/out. Keep the existing download sources and upload compressed installers at compression level 0. All triggers, platform/asset coverage, GLIBC checks, and validation remain. Repository version 0.54.9 → **0.54.10**.

- **2026-09-06, v1.74, decision #303:** `MsgRepo` pages image candidates in each direction using the existing `(conv_id, seq)` index. `services/image-navigation.ts` derives the conversation from the validated transfer and message, checks each message once using its primary/fallback transfer IDs and the existing managed-image validator, and stops at the nearest available image. The read-only navigation IPC validates input/window and returns only the name and adjacent transfer IDs. The viewer switches a reactive transfer ID, serializes requests and invalidates stale image/OCR work; only initial loading resizes the window. No wire protocol, schema or dependency changes. Version **0.54.12 → 0.55.0**.

- **2026-09-06, v1.75, decision #304:** use a same-origin local single-threaded Worker for PaddleOCR model loading, detection, recognition and pixel loops. Create it on demand; serialize from preprocessing, terminate active work on cancel/image change/close, and reuse the idle model. Transfer buffers and retain the 2200px input/960px detection limits. Copy crops per row and expose unpadded detection boxes for text positioning; align whole-line token cache validation with the existing 2000-character line bound. ImageTextLayer uses one transparent node per line, measures once, transforms only its parent on zoom, and extracts native Range text per line on copy. Preserve existing cache IPC, wire/schema/dependencies and strict CSP; verify the worker under real Electron22. Version **0.55.0 → 0.56.0**.

- **2026-09-06, v1.76, decision #305:** calibrate text selection geometry and keep the gesture cursor stable. Version **0.56.0 → 0.56.1**.

- **2026-09-07, decision #306, v0.56.2:** built-in emoji retain transparent Unicode text beneath local SVGs for native selection/copy without extra line breaks; whole-message copy retains original text. The Win7 editor copies/cuts its existing logical draft selection. Linux text inputs use native insertText only for explicit NumLock-on Numpad digits or matching navigation keys, without modifiers or composition; consume events only on successful insertion. Readonly/disabled fields, NumLock-off navigation, Windows and macOS keep native behavior. No protocol, schema, IPC or dependency changes. UOS native event-chain verification remains a target-platform check.

## Decision #307: Offline localization

Persist validated `config.language` (zh-CN / en) through existing settings IPC. Load the bundled English dictionary on demand before mounting and propagate changes through reactive locale state. Keep the existing four dynamic entries and bootstrap budget. Chinese source templates are the fallback. New system messages attach versioned, validated metadata to `messages.file_ref`, retaining readable Chinese content; views expose optional systemRef. No wire-protocol or SQLite schema change.

- 2026-09-16, decision #310: v0.58.0 implements view-only remote assistance, independent windows, Auto (10/5/3 fps) and manual Economy/Standard/Smooth modes. Consent, one-frame backpressure, bounded deadlines, lock detection and forced window cleanup are covered by local tests. Physical target-platform permission and performance checks remain pending; this iteration is not a release.

- 2026-09-17, v1.82, #311: native bitmap ownership transfer and explicit release, bounded capture constraints, retained pre-connection minimized state, asynchronous and recoverable Linux lock detection including newer DDE. No wire change or dependency; application **0.58.1**.

Local validation: **121 test files / 790 tests**, Electron-ABI database checks, type checks, build, startup smoke and version consistency passed. Actual Electron software-rendering tests cover native bitmap transfer and forced Canvas 2D fallback; 120-second viewing averaged **9.30 fps**. In one same-host 30-second comparison, viewer CPU was **2.053% → 0.757%** and working set **645 → 188 MiB**; these figures do not establish target-platform savings. Capture constraints at 10/5/3/10 fps, bounded high-resolution output, unsupported-constraint fallback and lock-triggered cleanup passed. Physical permissions, DPI and long-term memory still require Win7/UOS/Kylin/macOS target machines.

## Assistance interaction refinement (#312)

Decision #312 (v0.59.0): RemoteViewService emits history only at lifecycle transitions; ChatService reuses system messages and versioned file_ref.screen metadata with peer/session-scoped IDs. No new table, migration or wire fields. Metadata parsing is validated; corrupt records retain readable fallback text. A message-update event merges existing cards without duplicate notifications, unread increments or scrolling. Deleted conversations are not recreated by later updates. Startup changes unfinished cards to interrupted, leaving unknown end/duration blank. Wall-clock timestamps are local; duration uses a monotonic clock and starts at connection readiness. No per-frame/per-second storage, images, tokens or source IDs. Reuse the same renderer and capture stream for the compact sharing strip.

Imported unfinished cards are also marked interrupted, without invented end times or duration. Metadata exports retain start/end and duration, while screen images and grants remain memory-only.

Terminal cards cannot be rewound by late events. Capture-window cleanup precedes history persistence so slow storage cannot hold up Stop.

## Local diagnostic implementation (#315)

DiagnosticsService accepts explicit allowlisted event metadata, never arbitrary console/business objects or Error.message. Chromium uncaught-error notifications supply only a known error type and line number; Electron 22 isolated-world DOM listeners cannot observe page errors. Shutdown waits up to two seconds for pending writes and an active export. Persist salted node/address aliases and correlation UUIDs. Read at most 65 bytes of salt synchronously at startup so early events use the same aliases as later snapshots. Daily JSONL is limited to seven days/10 MiB, 1 MiB fragments, a 256 KiB async queue and 2 KiB records; repeated events are counted. A run marker records possible previous abnormal exits. Disk failures keep bounded in-memory evidence and must not break business operations. Capture start is flushed before native enumeration. Collect environment from the app itself without prompting permissions, network scans or external requests. Transfer phase/error codes and lifecycle summaries avoid per-frame/packet/progress writes. Thin IPC delegates to the service; Node Worker reuses zip-store with bounded regular-file reads, symlink rejection, a same-directory temporary ZIP, atomic replacement, timeout and single export at a time. Bundles contain summary.txt, environment.json and logs/*.jsonl; optional real-address mapping covers the current run only. Reveal uses only the last successful path. Node 16.17/Electron 22, no new dependencies, migrations or wire changes. Validate redaction, budgets, abnormal exit, disk errors, loopback errors and real Electron UI/IPC/Worker; physical target-platform acceptance remains pending.

- 2026-09-17: Decision #315, application **0.60.0**; diagnostics design recorded before implementation.

Validation: 123 files / 801 tests, Electron ABI database checks, typecheck, build and isolated smoke all passed. `npm run test:diagnostics` exercises real Electron 22 IPC/Worker, redacted bundles, disk errors, abnormal restart and light/dark/English 125% UI. A local ~9 MiB fixture exported in 221 ms with a 17 ms maximum main-thread heartbeat interval; this is a local sample only. The synthetic-screen regression also passed. Win7/UOS/Kylin hardware acceptance remains pending. No new dependencies, migrations or wire changes.

## Contact profile synchronization (#316)

App-state advances the maximum of the stored and runtime profile revisions on profile or capability changes, persists it atomically and updates the shared runtime object. Capability changes persist only the revision and preserve onboarding state; identical capabilities do not write. PeerRegistry compares accepted full profiles by value, including same-revision changes, and emits the existing updated event for UI projection and contact persistence. Identical profiles, heartbeats and chat activity do not emit extra updates; lower revisions and invalid source changes remain rejected. Validate independent field saves after revision drift, capability changes across restart, duplicate/stale profiles and discovery loopback on 127.0.0.1 with empty broadcast targets. Application **0.60.1**, no wire/schema/dependency changes.

## Discovery and scan reliability (decision #317, v0.60.2)

Unknown heartbeats trigger throttled full-profile handshakes. Optional `probeId` in entry/alive and capability `dp1` correlate fresh replies; directed replies bypass discovery jitter with a one-second per-peer limit. Active probes use a two-second deadline with one retry for dp1 peers, or twenty seconds with a retry at ten seconds for legacy peers. Equal profile revisions use sender timestamps to reject delayed data; a matching fresh reply resolves clock rollback/ties. Legacy peers without correlation retain best-effort timestamp ordering.

Global, single-range and background scans share one queue: manual work takes priority while background progress is retained. Minimum address delays remain 8ms/62ms. Completion records the scan time and schedules the next round after twelve hours plus thirty-to-ninety-minute jitter; restart, deletion, eligibility and shutdown are checked. Range advertisements require an online peer and matching source IP/UDP port. Gossip sends at most one packet per target per 50ms and coalesces duplicate requests. Bridges distribute addresses; endpoints still require direct UDP/TCP reachability. No dependencies or database migrations are added.
