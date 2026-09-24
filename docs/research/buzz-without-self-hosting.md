# Buzz（block/buzz）在「零自托管 + 不碰 Rust」前提下的可行性核查

调研日期：2026-XX（本次会话）。方法：官方 support 页（已抓到全文）、block/buzz 的 NOSTR.md、GitHub Releases API、npm registry API、官方文档站；部分站点 DNS/SSL 不稳，凡未拿到一手证据处均标「未找到证据」。

---

## Q3. buzz-cli / buzz-acp 怎么获取？（先说这条，因为它最不依赖网络）

**结论：只有「从源码 cargo 构建」这一条官方路径；没有 npm 包，也没有 CLI/ACP 的预编译 release 资产。**

- **Release 资产只有桌面 App + sprig（Linux CLI 工具），没有 buzz-cli / buzz-acp 二进制。**
  实测 `GET https://api.github.com/repos/block/buzz/releases?per_page=30`：30 个 tag 里除了 `sprig-latest`（sprig-aarch64/x86_64-unknown-linux-musl.tar.gz）外，全部是 `desktop-v0.5.x`，资产固定为 `Buzz_<ver>_aarch64.dmg / _x64.dmg / _amd64.AppImage / _amd64.deb / _x64-setup_alpha-unsigned.exe / _x64.app.tar.gz / updater-manifest.json`。**没有** 任何 `buzz-cli`、`buzz-acp` 命名的资产。
  出处：[block/buzz releases API](https://api.github.com/repos/block/buzz/releases)（本会话直连核对）
- **npm 上不存在 Buzz 的 CLI/ACP 包。** `https://registry.npmjs.org/buzz-acp` → `{"error":"Not found"}`；`@block/buzz-cli` → Not found。npm 上确有一个叫 `buzz-cli` 的包（latest 4.1.33，描述「基于 Vue + Webpack 工具」），**与 Buzz 无关，是同名撞车**。`nostr-tools` 存在但是通用 Nostr 客户端库，不是 Buzz 工具链。
  出处：[registry.npmjs.org/buzz-acp](https://registry.npmjs.org/buzz-acp)、[registry.npmjs.org/buzz-cli](https://registry.npmjs.org/buzz-cli)（本会话直连核对）
- **官方/半官方文档给的安装方式都是源码 cargo：**`cargo install --path crates/buzz-cli`（在 clone 下来的 Buzz 仓库里执行）；另有第三方文档写 `cargo build --release -p buzz-cli`。
  出处：[flaviocopes 的 Buzz 上手文（含该命令原文）](https://flaviocopes.com/buzz/)、[Hermes Agent 文档「build it from the Buzz repo with cargo build --release -p buzz-cli」](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/buzz)（**二手，置信中**；仓库 README 本次直连抓取失败，未能拿到一手原文）
- **平台可得性：**
  - **macOS**：桌面 App 有 `aarch64.dmg` / `x64.dmg`（现成可用）；但 CLI/ACP 仍需 cargo（本机装了 Rust 才行）。
  - **Windows**：桌面 App 有 `Buzz_0.5.23_x64-setup_alpha-unsigned.exe`（**未签名 alpha**，且必须是 x64）；CLI/ACP 在 Windows 上要 cargo + Rust 工具链。**没有找到任何 buzz-cli 的 Windows 预编译产物**（置信高：release 资产清单里没有）。
- 一个附带发现（对 Q2 很关键）：`buzz-acp` 的模型是「**spawn 子进程**」——它把 ACP 兼容 agent（Claude Code / Goose / Codex 等）作为 subprocess 拉起来，通过 stdin/stdout 用 ACP 通信，而不是让 agent 自己当 Nostr 客户端。
  出处：[darrenjrobinson 集成文](https://blog.darrenjrobinson.com/block-buzz-agent-integration-with-openclaw-claude-code-agents/)、[block/buzz issue #2663「Buzz's agent model currently requires agents to run as ACP subprocesses spawned by buzz-acp」](https://github.com/block/buzz/issues/2663)（issue 标题为官方仓库一手，正文未逐字核；置信中高）

---

## Q4. 不跑 relay + 不碰 Rust 的最短路径与三个坑

**前提澄清（来自官方 support 页原文）**：Buzz 桌面 App 可以「按 URL 添加 relay 并在多个 relay 间切换」；relay 之间**不联邦**，消息留在发送所在的 relay。
出处：[Buzz Support](https://block.github.io/buzz/support.html)

### 最短步骤（假设有别人运营的 relay + 邀请）
1. 在目标 relay 上，由**社区 owner** 把你和你的 agent 的 **pubkey** 加入（invite）；你自己建不了别人的 relay 成员列表。
2. 让 owner 给你 relay URL（`wss://...`）+ 你 agent 的 pubkey 加进成员表（Block 托管的要走 Settings → Relay access 邀请）。
3. 你的机器装 Buzz 桌面 App（macOS .dmg / Windows .exe），用「Join a Community」填 relay URL（纯本机 relay 用 `ws://`，公网用 `wss://`）。
4. 你的 agent 侧要能连上同一个 relay 当 Nostr 客户端：实现 NIP-42 认证 + NIP-29 群组（kind:9 发消息、`#h <channel-uuid>` 标记频道）+ 订阅 `#p` 提到自己的事件。
5. 「别人能 @ 它」= 订阅里过滤指向自己 pubkey 的 mention 事件，收到后用 kind:9 + `#h` 回帖。
6. 想要现成的 harness（buzz-acp 的「@ 即触发」语义）就**必须** cargo 构建 buzz-cli/buzz-acp ⇒ 这条与「不碰 Rust」冲突，只能改走第 4 步的自研路径。

### 三个最可能卡住的坑
1. **成员资格不是自助的**：官方 support 原文「A user cannot join by entering the relay URL without an invitation.」（Block 托管 relay。）你**必须**依赖某个 relay 运营者/owner 主动加你的 pubkey —— 这是「零自托管」路线的真正单点依赖，不是技术问题是权限问题。
2. **relay 必须是 Buzz 那套实现才有的语义**：Buzz relay 除 NIP-29 外还发 relay 签名的 kind:39000/39001/39002，以及 Buzz 私有的 kind:44100/44101（成员变更通知）、kind:20001（presence）、kind:40002/40003（富文本/编辑，标注为「Buzz-only，标准 NIP-29 客户端不渲染」）。任意第三方 NIP-29 relay 不会给你这些，agent 与客户端的体验会退化/错位。
   出处：[NOSTR.md](https://github.com/block/buzz/blob/main/NOSTR.md)（本会话直连抓到该文件正文，见下 Q2）
3. **桌面 App 的「agent」入口与自研 agent 是两套东西**：桌面 App 里配 agent 走的是 buzz-acp harness（spawn ACP 子进程），而你要的是「一个自研的、长期在线的第三方成员进程」。官方目前没有把「裸 Nostr 客户端 agent」当作受支持的一等路径（issue #2663 正是这个诉求），所以链路要自己打通并经 relay 侧 NIP-42 认证。

---
