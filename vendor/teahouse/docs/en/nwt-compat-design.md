# Neiwangtong compatibility-mode design

> [简体中文](../nwt-compat-design.md) · **English**

> **Status: paused, design only.** Decisions #194–#196 define this isolated compatibility approach. Decision #199 pauses implementation and scheduling because protocol research and VM validation are substantial. No compatibility code should be added until the product decision is reopened.

The [Chinese design](../nwt-compat-design.md) is the canonical research record, including packet evidence and unresolved product choices. This document translates the intended current architecture and resumption criteria.

## 1. Goal

Allow a Teahouse client, after explicit local configuration, to discover and exchange basic private text messages with Neiwangtong/IP Messenger-style peers on an internal network. Compatibility must not change Teahouse identity, its UTF-8 JSON protocol, normal discovery ports, group semantics, or file-transfer data plane.

The primary product remains Teahouse-to-Teahouse communication. Compatibility peers appear as a distinct capability-limited class.

## 2. Research basis

The design uses:

- the IP Messenger text-frame format and command options;
- reference behavior from local IP Messenger/iptux sources;
- observed Neiwangtong UDP behavior on port 2425;
- packet-level tests for discovery, presence, text encoding, acknowledgements, and attachment declarations;
- explicit gaps where real VM captures are still required.

Observed compatibility behavior must be treated as implementation evidence. Assumptions that have not been reproduced in a VM stay marked unresolved in the canonical design.

## 3. Design principles

1. **Explicit opt-in:** default off. The user enables compatibility and supplies target IP/CIDR ranges.
2. **Strict isolation:** separate socket, codec, service, configuration, identity mapping, and renderer projection.
3. **Capability downgrade:** expose only operations proved safe and interoperable for the selected peer.
4. **No main-protocol leakage:** never pass compatibility frames through Teahouse `UdpChannel` or JSON codec.
5. **No automatic LAN-wide scanning:** configured ranges only, with rate limits and visible status.
6. **Bounded untrusted input:** strict lengths, command/option allowlists, source checks, rate limits, and safe encoding conversion.
7. **Progressive delivery:** text discovery/messaging first; file/image experiments only after a verified TCP pull loop.

## 4. Scope

### 4.1 Stable first release

- Enable/disable compatibility mode locally.
- Bind a separate UDP socket, normally port 2425.
- Probe manually entered IPs and explicit CIDRs.
- Parse and emit a bounded IP Messenger subset for entry, answer, exit, private text, and send acknowledgement.
- Decode common GBK/UTF-8 fields safely.
- Display compatibility contacts in a dedicated section with badge, IP/port, hostname/nickname, and online state.
- Open a capability-limited private conversation.
- Send/receive plain text and expose accurate delivery/failure state.
- Persist a local mapping and minimal history without merging the peer into a Teahouse Node ID.

### 4.2 Mapped but disabled by default

- Experimental IP Messenger attachment announcements.
- Clipboard/image attachment options after verified byte retrieval.
- Window nudge or Neiwangtong-specific private commands only after capture-based identification.

### 4.3 Excluded

- Compatibility groups, Teahouse group roles, mentions, PK, media recall, stickers, cabinet, updater, organization metadata, avatars, and offline Teahouse queue semantics.
- Transparent identity merge between a compatibility peer and a Teahouse peer at the same IP.
- Unconfigured network scanning or Internet relay.
- Replacing the Teahouse protocol with IP Messenger.
- Claiming broad FeiQ/Neiwangtong compatibility from the IP Messenger subset alone.

## 5. IP Messenger subset

### 5.1 Frame model

A compatibility UDP packet follows the bounded text structure:

```text
version:packetNo:user:host:command:body
```

The parser splits only the required prefix fields and treats remaining bytes according to the command/encoding flags. It must preserve raw bounded evidence for diagnostics without logging private message text.

All numeric fields are parsed as bounded integers. User/host/body lengths are capped before decoding. Embedded NUL and malformed multibyte sequences follow an explicit replacement/rejection policy.

### 5.2 Command subset

The initial allowlist maps these IP Messenger concepts:

| Concept | Compatibility behavior |
|---|---|
| Entry (`BR_ENTRY`) | Add/probe an online compatibility peer |
| Answer entry (`ANSENTRY`) | Return bounded local compatibility identity |
| Exit (`BR_EXIT`) | Mark compatibility peer offline |
| Send message (`SENDMSG`) | Plain private text only |
| Send check / receive message | Acknowledgement when requested |
| UTF-8 option | Prefer UTF-8 when the peer advertises it |
| Absence / nickname-related fields | Project only evidence-backed display state |

Unknown commands and unsupported options are ignored without an error reply. Compatibility messages never enter the Teahouse envelope/ACK path.

### 5.3 Attachments

Attachment metadata may use IP Messenger file-attachment option fields. Any implementation must validate entry count, IDs, names, sizes, times, attributes, separators, and path safety before showing UI.

The standard TCP `GETFILEDATA` request/response must be completed and tested against target Neiwangtong versions before enabling file/image actions. Until then, attachment declarations can be captured in bounded diagnostic metadata and hidden from ordinary users.

### 5.4 Capability projection

Every conversation receives an explicit capability object. A compatibility conversation starts with:

| Capability | Value |
|---|---|
| Private text | Enabled after handshake |
| Reliable send status | Only if the selected command/options support acknowledgement |
| Offline queue | Disabled |
| Image/file | Disabled until verified attachment phase |
| Group/mention/roles | Disabled |
| Recall/forward/sticker/PK/nudge | Disabled unless separately mapped and approved |
| Cabinet/update/avatar | Disabled |

Renderer actions derive from this object instead of checking peer type throughout the component tree.

## 6. Encoding

- Keep raw packet bytes until command/options determine decoding.
- Prefer validated UTF-8 when the peer advertises the UTF-8 option.
- Use a precisely pinned pure-JavaScript GBK decoder if evidence requires it; check Node 16 compatibility and package size first.
- Bound input before decoding and use a deterministic replacement policy.
- Encode outgoing nickname/hostname/text according to the peer's observed/negotiated capability.
- Do not write raw private body bytes or decoded text to logs.

Adding an encoding dependency requires the normal exact-version and no-native-module review.

## 7. Proposed modules

```text
src/main/net/compat/
├─ ipmsg-codec.ts        # Byte parser/encoder and exact command allowlist
├─ compat-udp.ts         # Separate 2425 UDP socket and source/rate controls
├─ compat-discovery.ts   # Entry/answer/exit and configured scans
├─ compat-messenger.ts   # Private text and acknowledgement waiters
├─ compat-registry.ts    # Compatibility endpoint identities and liveness
└─ compat-attachments.ts # Future, disabled until verified

src/main/services/
└─ compat.ts             # Orchestration and renderer projection
```

The compatibility directory remains Electron-free. Main assembly owns lifecycle and IPC wiring. Existing `net/`, `store/`, and Teahouse services remain unchanged except for a clearly bounded parallel projection/event route.

## 8. Identity, configuration, and storage

### 8.1 Configuration

Proposed local settings:

```jsonc
{
  "compat": {
    "enabled": false,
    "udpPort": 2425,
    "ranges": ["10.1.0.0/24"],
    "manualPeers": ["10.2.0.8"],
    "experimentalAttachments": false
  }
}
```

Port conflict disables only compatibility mode and reports status in Settings. It must not disrupt Teahouse UDP 17878/TCP 17879.

### 8.2 Peer identity

Without a stable remote Node ID, a compatibility peer uses a namespaced local key derived from bounded endpoint and observed identity data. The design must define how DHCP/IP reuse affects old history before implementation. A compatibility key can never equal or alias a Teahouse Node ID automatically.

### 8.3 Storage

Persist minimal compatibility peer/contact/conversation information with a clear type discriminator. Message records may reuse general history structures only if service/repository contracts prevent them from entering Teahouse retry, group, recall, file, or capability paths.

Any database migration is append-only and requires import/export policy plus Electron-ABI self-test coverage.

## 9. UI design

### 9.1 Settings

Network Settings reserves a Compatibility section:

- enable switch, default off;
- local compatibility UDP port;
- explicit CIDR table with last scan, peer count, Scan, and Remove;
- manual peer entries;
- status: off, listening, port occupied, scanning, or last discovery count.

Experimental attachments remain hidden until the TCP phase is accepted.

### 9.2 Contacts and conversations

Compatibility peers appear under a fixed “Neiwangtong compatibility” group between Discussion groups and the organization tree. A row shows display nickname/hostname, `Neiwangtong · IP:port`, status dot, and a small outline badge. Offline rows are gray.

A simplified profile shows only reliable fields. The chat header retains the badge and IP. Unsupported composer actions are hidden through conversation capabilities, with a concise explanation when needed. Compatibility sessions never show cabinet, group, recall, game, sticker, avatar, update, or organization actions.

## 10. Presence and reliability

- Probe only configured manual peers/ranges.
- Apply jitter and bounded scan rate.
- Use evidence-backed entry/answer behavior and conservative liveness expiry.
- Bind acknowledgements to expected source endpoint and packet number.
- Keep retries bounded.
- Do not place compatibility messages into the Teahouse seven-day offline queue. Show failure and offer explicit retry when the peer is unavailable.
- Treat endpoint identity changes conservatively and avoid silently attaching new traffic to historical identity.

## 11. Security boundaries

- Separate socket prevents text compatibility packets from reaching the JSON codec.
- Exact command and option allowlist; bounded field lengths and packet sizes.
- Per-source rate limits and a total inbound queue budget.
- No broadcast/scan outside explicitly configured targets.
- Message bodies omitted from logs; raw packet capture requires explicit diagnostic action and redaction.
- Attachment names/paths use the same traversal and destination rules as Teahouse files.
- File retrieval remains disabled until authorization, size, connection timeout, stream, and hash/terminal-state behavior is designed and tested.
- Compatibility cannot gain access to file cabinet, updater, managed avatar/media schemes, or Teahouse group metadata.

## 12. Dependency policy

The protocol adapter should use Node 16 built-ins wherever possible. Any GBK decoder must be pure JavaScript, exact-pinned, offline at runtime, license-reviewed, and tested with malformed/boundary input. No additional native module is allowed.

## 13. Test plan

### 13.1 Unit tests

- Parse/encode every allowed command and option combination.
- Reject or ignore malformed version, packet number, command, lengths, NUL, separators, and unknown commands.
- UTF-8/GBK valid, invalid, truncated, and boundary sequences.
- Identity key normalization and endpoint-change rules.
- Capability projection and action hiding.
- Range validation and scan-rate scheduling.
- ACK source/packet binding, retry, timeout, and duplicate receipt.
- Attachment declaration fuzz cases before any experimental UI.

### 13.2 Loopback integration

Bind only `127.0.0.1` with explicit ports and no broadcast target. Run entry/answer, text/ACK, duplicate, timeout, exit, port-conflict isolation, and lifecycle restart. Tests must never scan or broadcast to the real LAN.

### 13.3 VM validation

Required before release:

- target Neiwangtong versions on Windows VMs;
- Chinese nickname/text across UTF-8/GBK observations;
- discovery and direct configured probing;
- acknowledgement/delivery semantics;
- app restart, DHCP/IP change, duplicate identities, port conflict;
- packet captures tied to findings;
- later, the exact attachment TCP pull loop and cancellation/timeout behavior.

## 14. Delivery phases

| Phase | Delivery gate |
|---|---|
| A | Isolated codec/socket with evidence-backed unit and loopback tests |
| B | Settings, configured scan, registry, distinct contact projection |
| C | Capability-limited private text and acknowledgements |
| D | Experimental file/image only after verified TCP retrieval and user approval |
| E | Further private commands only after packet evidence and product review |

Each phase requires canonical document updates, a new decision, tests, the repository version increment, and the standard five checks.

## 15. Decisions required before resuming

The user must reopen and decide at least:

- which exact Neiwangtong versions are in scope;
- the intended environment/VM matrix and acceptance captures;
- how compatibility identity behaves under IP reuse and hostname/nickname change;
- whether text-only delivery has sufficient product value;
- whether an encoding dependency is acceptable;
- whether attachment work is required and which file/image operations are acceptable;
- release labeling that accurately describes a tested subset.

Until those choices are explicit, implementation remains paused.

## 16. Change record

- **2026-08-10, decision #285:** added the English current-state translation and preserved the #199 pause. No compatibility implementation, protocol, dependency, setting, or UI behavior changed.
