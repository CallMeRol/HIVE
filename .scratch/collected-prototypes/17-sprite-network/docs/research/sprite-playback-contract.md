# 状态精灵与派发网络的技术契约 · 事实底稿

> wayfinder #17「状态精灵与派发网络的技术契约（交付美术）」的**事实底稿**（不是契约本身；契约文档由后续 ticket 产出）。
> 调查日期：2026-09-22。调查者：JadeIce。
> 调查对象：宿主产品 teahouse = 仓库 `pantry` v0.60.2（只读 clone：`/tmp/teahouse-recon`，HEAD `f6607ff`）。
> 方法：只用一手来源——Aseprite 官方 CLI 文档 + 官方 gist + 上游 issue、Chromium 108 分支源码 + MDN/BCD + web.dev/Lighthouse + W3C、Electron 22 版本化仓库文件、ACP 官方 RFD/schema、Claude Agent SDK 类型参考、openai/codex 源码与 issue。
> 纪律：每个结论给可点来源或文件行号；明确区分「确认」与「未确认」。本文件**不含实现**，代码片段合计 <20 行且仅用于说明写法。

---

## 0. 环境锚点（后面所有结论的前提）

| 事实 | 值 | 证据 | 置信 |
|---|---|---|---|
| Electron | 22.3.27 | `package.json:build.electronVersion`；`node_modules/electron/package.json` `"version":"22.3.27"`（`/tmp/teahouse-recon`） | 确认 |
| Electron 22 → Chromium | 108 | [electron-to-chromium `versions.js:107-110`](https://github.com/kilian/electron-to-chromium/blob/master/versions.js)（`"22.0":"108"`…`"22.3":"108"`）；[Electron 22.0.0 发布公告](https://www.electronjs.org/blog/electron-22-0) | 确认 |
| Chromium 108 源码分支 | `refs/branch-heads/5359` | [chrome/VERSION @ branch-heads/5359](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/5359/chrome/VERSION) = `MAJOR=108 BUILD=5359` | 确认 |
| 仓内已有 sprite 先例 | 有（静态、非动画） | `src/renderer/src/components/FileTypeIcon.vue:66-96`：4×4 PNG atlas + `background-position` 取图 + `image-rendering: auto` | 确认 |

**结论（硬）**：本契约面对的运行时是 **Chromium 108**。凡"某个 CSS/格式在 Chrome 148 才有"的特性一律**不可用**（下文 §2、§4 各有实例）。

---

## 1. Aseprite CLI 导出

### 1.1 参数语义（官方文档逐条）

来源：[Aseprite Docs — CLI](https://www.aseprite.org/docs/cli/)（本章所有引号内文字均出自该页）。

| 参数 | 官方语义 | 对我们的意义 |
|---|---|---|
| `--sheet <png>` / `--data <json>` | 导出精灵表图片 / 元数据 JSON；`--data=""` 可写 stdout | 交付物就是这一对 |
| `--format json-hash\|json-array` | 数据文件格式，**默认 `json-hash`** | 我方指定 `json-array`（顺序稳定、按 index 取帧） |
| `--list-tags` | "List tags of the next given sprite **or include frame tags in JSON data**" | **关键开关**：不加它，JSON 里没有 `meta.frameTags` |
| `--list-layers` / `--list-slices` / `--list-layer-hierarchy` | 同理，把图层/切片信息写进 JSON | 不需要，但说明这套 `--list-*` 就是"把结构信息带进 JSON"的开关 |
| `--sheet-type horizontal\|vertical\|rows\|columns\|packed` | 排版算法；`packed` 等价 `--sheet-pack` | 横向一行最省心（帧序 = x 偏移递增） |
| `--sheet-pack` / `--sheet-columns` / `--sheet-rows` / `--sheet-width` / `--sheet-height` | 打包与固定尺寸 | 帧数少时不需要；用了 packed 必须读 JSON 的 `frame.x/y` |
| `--tag <name>` | "Exports the frames inside the given tag only"（v1.1 起对 `--sheet` 生效） | **不要加**：加了就只有那一个 tag |
| `--frame-tag <name>` | "Include tagged frames in the sheet" | 同上，按需 |
| `--frame-range from,to` | 只导帧区间 | 兜底 |
| `--split-tags` | v1.2-beta8 起，"splits next document tags into different files。**It affects the `--save-as` option**" | 见 §1.3 的坑 |
| `--filename-format <fmt>` | 占位符 `{tag}` `{innertag}` `{outertag}` `{layer}` `{frame}` `{frame001}` `{tagframe}` `{duration}` `{title}`… | 命名与 json-hash 键名都受它影响 |
| `--scale <factor>` | "Resize all previously opened sprites"，**只作用于它之前出现的精灵** | 不要在导出时缩放（见 §2：缩放应在美术侧定稿） |
| `--trim` / `--extrude` / `--shape-padding` / `--inner-padding` / `--border-padding` | 裁切/外扩/内边距 | **必须确保它们是关闭/0**，否则帧尺寸与坐标会被改掉，播放器算帧偏移出 bug |

### 1.2 核心问题：一条命令能否拿到「一张 sheet + 一份记录每个 tag 帧范围与帧时长的 JSON」

**能 —— 确认（两源交叉）**：

1. 官方文档 `--list-tags`：把 frame tags 写进 JSON 数据，并给出形状（[CLI 文档](https://www.aseprite.org/docs/cli/)，原文片段）：
   `{ "frames": [...], "meta": { "frameTags": [ { "name": "Walk", "from": 0, "to": 3 }, { "name": "Run", "from": 4, "to": 6 } ] } }`
2. 真实用户输出（Aseprite 1.2.40，命令里带 `--list-tags`，用的是 `--format json-array`）——[aseprite#3611](https://github.com/aseprite/aseprite/issues/3611)：
   `"frameTags": [ { "name": "king_idle", "from": 0, "to": 7, "direction": "forward" }, … ]`
   → **`frameTags` 还带 `direction` 字段**（未带 `repeat`）。
3. 每帧时长在 `frames[]` 的 `duration`（毫秒）——官方示例 gist [json-array](https://gist.github.com/dacap/a32adb9248320326733a) / [json-hash](https://gist.github.com/dacap/db18e5747a4b6e208d3c)：`"duration": 100`，帧坐标 `frame:{x,y,w,h}`，数组格式另带 `filename`。

**因此：一张 sheet 装下所有 tag 的所有帧是天然行为（不加 `--tag`/`--frame-tag` 就是全导），JSON 用 `from`/`to`（**闭区间、全局帧下标**，按 `duration` 累计切帧）+ 每帧 `duration` 就能还原全部 tag 的帧范围与时长。不需要每个 tag 单独导出。**

### 1.3 已知坑与未确认项

- **确认**：`--split-tags` **不能**用来把 `--sheet/--data` 拆成"每 tag 一套文件"。社区实测（[Aseprite Community：CLI export sprite sheets and --split-tags](https://community.aseprite.org/t/command-line-interface-help-to-export-sprite-sheets-and-split-tags/16460)）：用户加了 `--split-tags --sheet … --data …`，结果"only one sheet png file and one json file"；他最终自己写 Aseprite 脚本解决，且一年后仍有用户在同一帖追问"只能对每个 tag 反复调 `--tag` 吗"（无人给出纯 CLI 答案）。文档侧旁证：`--split-tags` 明写只影响 `--save-as`。
- **确认**：多文件合并进一张表时 `frameTags` 会错——#3611 里 `king_idle from 0..7` 与 `silver_knight_idle from 0..10` **帧区间重叠**，无法按 tag 取帧。**我们只导单个 `.aseprite` 时不受影响**（单文件内 tag 不重叠），但"把多个角色/多个状态文件拼一张 atlas"的做法**必须禁止**。
- **确认**：不加 `--list-tags` 就没有 `frameTags`（文档语义 + #3611 的可用输出两者一致）。
- **未确认**：`--split-tags` 与 `--sheet/--data` 同时使用时的确切行为（报错 vs 静默忽略 vs 只导最后一个 tag）。文档没写，社区只有一个"仍是一张图"的样本 → **需实测**。
- **未确认**：`direction` 在 1.2 各小版本是否都输出、`repeat` 字段是否存在（官方文档的 `frameTags` 示例里两者都没有）。
- **未确认**：`--filename-format` 里 `{tag}`/`{tagframe}` 对 **json-hash 键名**的确切影响（官方 gist 的键是 `file 0.ase`、`file 1.ase`，即默认带原文件名与序号；#3611 用了 `--filename-format {tag}_{tagframe}` 但只贴了 `frameTags` 段，没贴 `frames` 键名）→ **需实测**，因此契约里**不要**依赖 JSON 的键名，只用 `json-array` 的**下标 + `frameTags.from/to`**。

### 1.4 可复制的命令（建议写进契约）

```bash
# A. 交付格式：一张 sheet + 一份 JSON（所有 tag 一次到位）
aseprite -b status.aseprite \
  --list-tags \
  --sheet status.png --data status.json \
  --format json-array \
  --sheet-type horizontal \
  --shape-padding 0 --inner-padding 0 --border-padding 0
# → status.json: frames[ i ].{frame:{x,y,w,h}, duration} , meta.frameTags[ {name,from,to,direction} ]

# B. 美术自检用（每 tag 一个 gif，不是交付格式）
aseprite -b status.aseprite --save-as 'status-{tag}.gif'
```

（B 的写法来自官方文档 `--split-tags` 条目给出的等价命令 `aseprite.exe -b animations.ase --save-as animations-{tag}.gif`。）

### 1.5 播放器读 JSON 的最小算法（契约要写清的一句话）

对 tag `t`：取 `i ∈ [t.from, t.to]`（**含两端**，#3611 的伪码即为 `for i = from; i <= to; i++`），第 k 帧的显示时长 = `frames[i].duration` 毫秒；累计时长取模得到循环时间轴。帧矩形用 `frames[i].frame{x,y,w,h}` 从 atlas 取图。

---

## 2. 像素完美播放（`image-rendering`）

### 2.1 Chromium 108 里能用的值只有 `pixelated`

| 值 | Chromium 首次支持 | 在 108 可用？ | 来源 |
|---|---|---|---|
| `pixelated` | **41** | ✅ | [MDN BCD `image-rendering/pixelated`](https://github.com/mdn/browser-compat-data/blob/main/css/properties/image-rendering.json)（`chrome: {version_added: "41"}`） |
| `crisp-edges` | **148** | ❌ | 同上（`chrome: {version_added: "148"}`；108 里只有别名 `-webkit-optimize-contrast`） |
| `auto` / `smooth` | 13 | 可用但会糊 | 同上 |

**硬结论**：契约里只准写 `image-rendering: pixelated`。写 `crisp-edges` 在 Chromium 108 上**无效果**（148 才支持）——这是最容易踩的坑。置信：确认。

### 2.2 规范怎么定义 `pixelated`（决定"为什么必须整数倍"）

[MDN `image-rendering`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/image-rendering) 逐字：

> **pixelated** — The image is scaled with the "nearest neighbor" or similar algorithm **to the nearest integer multiple of the original image size, then uses smooth interpolation to bring the image to the final desired size.** This is intended to preserve a "pixelated" look without introducing scaling artifacts when the upscaled resolution isn't an integer multiple of the original.

同页另两条有用的：

> This property has no effect on non-scaled images.（1:1 显示时无所谓）
> Scaling may also occur due to user interaction (zooming).

**由此可推出的硬约束（置信：确认——规范语义直接推出）**：

1. **整数倍缩放 = 纯最近邻**：32×32 图显示成 32/64/96/128 设备像素时，每个源像素映射成 1×1/2×2/3×3/4×4 方块，边界干净。
2. **非整数倍缩放 = "最近邻到整数倍 + 平滑插值到目标"**：例如 1.25×，浏览器先按 2×（≥1.25 的最小整数倍）最近邻放大，再平滑缩到 1.25× → **边缘被插值糊掉**，等于像素风被破坏。
   - 具体瑕疵（置信：**推断**，由上述算法直接推出，未找到逐字描述它的权威文档）：源像素被采样次数不均（有的 2 个、有的 1 个设备像素宽）→ 线条粗细不匀；1px 的描边/轮廓可能整条消失；帧与帧之间格点错位 → 静止时看不出来、播放时"抖"。
3. **`image-rendering: pixelated` 不能把"非整数缩放"修好**，它只是把插值算法固定成上面这套。

### 2.3 我们具体要不要"64×64 母版缩到 32×32"

- **推荐做法（写进契约）**：**母版就按显示尺寸画**（32×32）。需要更大像素块时由 CSS 整数倍放大（×2 → 64、×3 → 96），不是把 64×64 图缩到 32×32。
- 如果美术坚持 64×64 母版：**只能整体 ×0.5 或整体 ×1.0**，即显示尺寸只能是 32 或 64（整数比）。0.5 是"每 2 个源像素取 1 个"，在**无半像素偏移**时是干净的；但一旦容器尺寸/位置落在半像素上（布局常见），采样格点错位 → 糊（置信：推断）。所以契约应直接禁止"缩放到 32 以外的分数尺寸"。
- **真正的风险在 DPR**（这条会咬人，置信：确认的推理链 + 推断结论）：
  - DPR = 1：32 CSS px = 32 设备 px → 1:1，**根本不需要缩放**；
  - DPR = 2（macOS Retina）：32 CSS px = 64 设备 px → 2× 整数放大 → **干净**；
  - **DPR = 1.25 / 1.5（Windows 125% / 150% 显示缩放，极常见）**：32 CSS px = 40 / 48 设备 px → **1.25× / 1.5× 非整数** → 按 §2.2 会被"最近邻到 2× 再平滑缩回" → **糊，且是规范行为，CSS 修不掉**。
  - 可行的缓解只有两种：(a) 接受轻度发糊并降级视觉要求；(b) 让**容器尺寸本身**取"设备像素整数倍"的值（用 `devicePixelRatio` 计算整设备像素的 CSS 尺寸，例如 DPR1.25 时给 32 device px 的元素 = 25.6 CSS px —— 会出现小数 CSS 尺寸，需要 JS 参与且与现有 32/30px 固定布局冲突）。**这一条必须人类拍板**（见 §9 第 3 条）。
- 另有一个易忽略的非整数缩放来源：用户触控板双指缩放/页面缩放。仓内 `src/main/` 未发现 `zoomLevel` / `zoomFactor` / `role:'zoomIn'` 等设置（grep 无命中）→ 应用没接管缩放；Electron/Chromium 的视觉缩放是否仍生效**未确认**，但契约里应显式禁用缩放以保证像素完美。

### 2.4 仓内既有约束（写契约必须先解决的冲突）

- `src/renderer/src/components/MessageRow.vue:281-283`：`.msg-avatar { width:30px; height:30px; border-radius:50% }`
- `src/renderer/src/components/PeerList.vue:242-245`：`.peer-avatar { width:32px; height:32px; border-radius:50% }`（行 `height:38px`，见 `:176`, `:207`）
- 两个冲突（置信：确认）：
  1. **尺寸不统一 30 vs 32**：一个母版无法同时整数倍贴合两处（30 需要 30/60/90，32 需要 32/64/96）。
  2. **圆形裁切**：`border-radius:50%` 会切掉精灵四角，且圆边是**抗锯齿**的（不是像素对齐的圆）→ 像素精灵放进圆形容器会显得"边缘发毛"。要么去掉圆形裁切，要么美术把形象画进一个自带圆边、且外圈留白的方形母版。

---

## 3. CSS 精灵动画的合成代价

### 3.1 `background-position` 动画**不可能**走 GPU 合成（源码级证据）

Chromium 108（branch-heads/5359）[`third_party/blink/renderer/core/animation/compositor_animations.cc:74-78`](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/5359/third_party/blink/renderer/core/animation/compositor_animations.cc)：

```cpp
constexpr CSSPropertyID kCompositableProperties[] = {
    CSSPropertyID::kBackdropFilter, CSSPropertyID::kFilter,
    CSSPropertyID::kOpacity,        CSSPropertyID::kRotate,
    CSSPropertyID::kScale,          CSSPropertyID::kTransform,
    CSSPropertyID::kTranslate,
};
```

**`background-position` 不在这张表里** → 用 `@keyframes` 动 `background-position` + `animation-timing-function: steps(n)` 时，浏览器只能走主线程渲染管线（Style → Paint → Composite），**不是合成器动画**。`steps()` 只是把时间轴量化成离散帧，**不改变"动的是哪条属性"**，因此不改变合成结论。置信：**确认**（源码 + 文档双重）。

配套文档证据（同一结论的官方表述）：

- [web.dev — How to create high-performance CSS animations](https://web.dev/articles/animations-guide)："Avoid properties that trigger layout or paint … Before using any CSS property for animation (other than `transform` and `opacity`), determine the property's impact on the rendering pipeline"；"If you must use a property that triggers layout or paint, you probably won't be able to keep the animation smooth or high-performing."
- [web.dev — Stick to Compositor-Only Properties](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)："Today there are only two properties for which that is true — `transform`s and `opacity`"（该文写于 2015，**比 Chromium 108 保守**；108 的权威清单以上面源码为准，共 7 项）。
- [Chrome for Developers — Avoid non-composited animations (Lighthouse)](https://developer.chrome.com/docs/lighthouse/performance/non-composited-animations)："A non-composited animation is any animation that triggers one of the earlier steps in the rendering pipeline (Style, Layout, or Paint) … When an animation can't be composited, Chrome reports the failure reasons to the DevTools trace, which is what Lighthouse reads."
- 反向提醒（避免过度承诺）：源码里 `transform` 虽然**在**可合成列表内，但仍可能因其它原因被拒绝（如 `kTransformRelatedPropertyCannotBeAcceleratedOnTarget`、`kUnsupportedCSSProperty`，同文件 `:281`、`:164`）。所以「用 transform 就一定合成」**不是保证**，只是"唯一有可能走到合成器的那一类"，最终要用 DevTools/Lighthouse 实测确认。置信：确认（源码存在这些失败原因），结论按"需实测"处理。

### 3.2 四种播放实现对比

| 方案 | 合成器动画？ | 帧率/时长可控？ | 主线程成本 | 备注 |
|---|---|---|---|---|
| CSS `steps()` + `background-position` | ❌ 主线程重绘 | ✅ 完全由 CSS 时长 + `steps(n)` 决定 | 每帧对该元素的失效矩形做 style+paint+commit | **与仓内既有 `FileTypeIcon.vue` 同构**（`background-position` 取 atlas 已在用）；零 JS；tag 切换 = 换 class |
| 单 `<img>` + JS 定时器切换（`src` 或 `background-position`） | ❌（若是 `transform` 位移则可合成） | ✅（需自己按 `duration` 累加） | 每帧有 JS 回调（`setTimeout`/`rAF`）；10 个 32×32 的量级很小 | 需要一套 JS 播放器（含 `duration` 累加、页面不可见时暂停）；比 CSS 版多代码 |
| CSS `steps()` + `transform: translateY(-k*32px)`（外层 `overflow:hidden`） | ✅ 有可能（`transform` 在 108 可合成列表内） | ✅ 同样精确 | 首帧光栅化后逐帧几乎零主线程**（若真被合成）** | atlas 需要排成**竖条**；整像素位移；必须实测确认真的走了合成（Lighthouse 审计）；`translate` 若无独立层仍会退化 |
| `<canvas>` + `drawImage` | ❌（canvas 在主线程，除非 OffscreenCanvas） | ✅ | 每帧 JS + 绘制命令 | 10 个 32×32 canvas 的绘制开销理论很小，但引入 DPR/尺寸/清屏管理，且失去 CSS 的"声明式"降级 |
| APNG / animated WebP / GIF 放 `<img>` | 图片动画由浏览器推进 | ❌ **不可控**（无暂停/改帧率 API，见 §4） | 低 | 无法实现"更累 = 更急促"，也无法在 `prefers-reduced-motion` 下暂停（只能换图） |
| `<video>` + mp4/webm | 视频管线（独立解码器） | ✅（`playbackRate`、`currentTime`） | 低（解码在其他线程） | 为 4–8 帧循环上视频管线过重（首帧延迟、解码器常驻、编码链路、alpha 麻烦）——**推断**，无 bench 支撑 |

### 3.3 ~10 个同时运行的精灵在 60fps 下的实际风险

- **算得出的事实**：10 个 32×32 元素 = 每帧约 `10 × 1024 = 10,240` 设备像素² 的重绘区域（DPR2 时 40,960）。这在 Chromium 里是**极小的 paint 量**，单纯吞吐不是瓶颈。置信：推断（算术，非测量）。
- **真实风险是"耦合"而不是"吞吐"**（置信：推断，依据 §3.1 的机制）：`background-position` 动画的每帧推进只能发生在主线程的帧循环里。teahouse 主线程同时要跑 Vue 渲染、群消息 IPC 回灌、`better-sqlite3` 之外的 JSON 解析等；**主线程卡一帧，精灵动画就掉一帧**（甚至会整段卡住）。而合成器动画（`transform`/`opacity`）由 compositor 线程按 vsync 独立推进，主线程卡顿时动画仍能继续。
- **缓解措施（无实测数据，按机制推导，需 demo 页实测）**：① 优先保证数量不超过"同时可见的状态精灵 ≈ 一行的人数"；② 给动画元素加 `will-change: transform`（若改走 transform 版）；③ 用 DevTools Performance/Lighthouse 的 *Avoid non-composited animations* 审计确认；④ 窗口不可见时不动画（见下条）。
- **桌面端的额外注意**（置信：确认，文档级）：Electron `webPreferences.backgroundThrottling` 默认 `true` —— "Whether to throttle animations and timers when the page becomes background. This also affects the Page Visibility API … Defaults to `true`。"（[Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)）。即窗口被遮挡/最小化时动画会被节流，**这不是 bug**，契约里应写明"不可见时不保证动画推进"。

---

## 4. Chromium 108 支持的动图/视频格式

### 4.1 支持矩阵（Chromium 108）

| 格式 | 在 Chromium 108 | 证据 | 可控播放？ |
|---|---|---|---|
| APNG（`<img>`） | ✅ Chrome **59+** | [caniuse `apng`](https://caniuse.com/apng)（chrome 58=`n`，59=`y`，108=`y`）；note："Where support for APNG is missing, only the first frame is displayed" | ❌ |
| animated WebP（`<img>`） | ✅ Chrome **32+**（caniuse 把 animated 计入 full） | [caniuse `webp`](https://caniuse.com/webp)：chrome 31=`a #2`（不支持 animated）→ **32=`y`**；`#1` = 不支持 lossless/alpha/animated，`#2` = 仅不支持 animated | ❌ |
| GIF（`<img>`） | ✅ 全版本 | 同上（无版本门槛） | ❌ |
| `<video>` + MP4/H.264+AAC | ✅ Electron 侧可用 | Electron 22 构建参数 [`build/args/all.gn`](https://github.com/electron/electron/blob/v22.3.27/build/args/all.gn)：`proprietary_codecs = true`、`ffmpeg_branding = "Chrome"`；Chromium 文档把 H.264 列为"Proprietary Video Codecs (Limited to Google Chrome)"（[chromium.org/audio-video](https://www.chromium.org/audio-video/)）——Electron 正是以 Chrome branding 编 ffmpeg，故含专有编解码器 | ✅ |
| `<video>` + WebM/VP8/VP9/AV1 | ✅ 原生 | [chromium.org/audio-video](https://www.chromium.org/audio-video/)：容器 MP4/Ogg/WebM/WAV/Matroska/HLS；视频 AV1/VP8/VP9（列在 "Video" 非专有组） | ✅ |
| WebM/VPx + alpha（透明视频） | ✅ 可行 | [Jake Archibald — Video with alpha transparency on the web](https://jakearchibald.com/2024/video-with-transparency/)（讲 VP8/VP9 alpha 与 WebM 的取舍） | ✅ |
| `ImageDecoder`（WebCodecs，逐帧取 `ImageBitmap`） | ✅ Chrome 94+ | [ImageDecoder API extension for WebCodecs（blink-dev）](https://groups.google.com/a/chromium.org/g/blink-dev/c/w1F8UGwTjZo/m/rrwylKubAwAJ)；[MDN WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) | ✅（但等于自己写 canvas 播放器） |

### 4.2 动图的坑：**没有 API 控制播放**

- Chromium 目前**没有**暂停/恢复/定位动图的标准方式，只有仍在评审的提案：[chromestatus "CSS Image Animation"](https://chromestatus.com/feature/5078177326170112)（提议 `image-animation: normal|running|paused` + `:animated-image` 伪类；我方 2026-09-22 抓取该页，`web_feature: "Missing feature"`、`is_official_web_feature: false`，即**未发布**）。
- Chromium 的对应需求单仍在讨论：[issues.chromium.org — Support pausing animated images (429459566)](https://issues.chromium.org/issues/429459566)。
- **对我们意味着**：GIF/APNG/WebP 方案**无法**实现"越累 = 循环越快"（帧率写死在文件里），**也无法**在 `prefers-reduced-motion` 下暂停（只能换成静态图）。用 `<video>` 或 `ImageDecoder`+canvas 才能控制帧率。
- **未确认（不写进契约）**：animated WebP 的 alpha 在 Chromium **108** 是否有已知实现 bug（只找到 2026 年的第三方性能对比文章，非一手 issue）；`<img>` 动图是否在首帧即预解码全部帧/内存占用（未找到权威出处）。

### 4.3 结论建议

**交付格式用 PNG atlas + JSON，不用 APNG/WebP/GIF/`<video>`。** 依据：① 只有 atlas + CSS/JS 才能让"帧率与帧时长"由我们的数据（JSON）而非美术的导出设置决定；② 只有它能匹配四档状态的"快慢差异"；③ 只有它能在 reduce-motion 下无成本降级为静态第 0 帧；④ atlas 取图在仓内已有先例（`FileTypeIcon.vue`）。GIF/APNG/WebP/video 保留在"美术自检/演示录屏"用途。

---

## 5. `prefers-reduced-motion` 与循环动效的无障碍义务

### 5.1 义务（WCAG）

[WCAG 2.2 SC 2.2.2 Pause, Stop, Hide（Level A）](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) 原文条件：

> For any **moving, blinking or scrolling information** that (1) **starts automatically**, (2) **lasts more than five seconds**, and (3) is presented **in parallel with other content**, there is a **mechanism for the user to pause, stop, or hide it** unless the movement … is part of an activity where it is **essential**; and
> **Auto-updating**: For any auto-updating information that (1) starts automatically and (2) is presented in parallel with other content, there is a mechanism for the user to pause, stop, or hide it **or to control the frequency of the update** unless the auto-updating is part of an activity where it is essential.

我们的精灵：自动开始 ✅、无限循环（>5s）✅、与消息列表并列 ✅ → **默认需要"暂停/停止/隐藏"机制或频率控制**。置信：确认（逐字条款）。

### 5.2 惯用降级写法

- W3C 推荐技术：[C39: Using the CSS `prefers-reduced-motion` query to prevent motion](https://www.w3.org/WAI/WCAG21/Techniques/css/C39)（JS 版 = SCR40）。
- 浏览器支持：Chrome **74**+ / Edge 79 / Firefox 63 / Safari 10.1（[web.dev — prefers-reduced-motion](https://web.dev/articles/prefers-reduced-motion) 支持表；MDN 标注该特性 "Baseline … Widely available since January 2020"）→ Chromium 108 可用。
- **要不要把循环精灵降级为静态帧？建议要**，且**不能只做这一件事**：`prefers-reduced-motion` 是用户偏好，WCAG 2.2.2 要求的是**页面提供**机制；只靠 media query 等于把责任推给用户设置（这一批评来自二手来源 [ProperAccess: SC 2.2.2 解读](https://www.properaccess.nl/en/blog/wcag-2-2-2-pause-stop-hide/)，置信：中；但"双保险"成本极低）→ 建议：**media query 降级为静态帧 + 应用内一个全局"动画"开关/设置项**。

写法（合计 8 行，仅为说明风格）：

```css
.status-sprite { animation: sprite-idle 3s steps(6) infinite; image-rendering: pixelated; }
.app-no-motion .status-sprite { animation: none; background-position: 0 0; } /* 静态第 0 帧 */
@media (prefers-reduced-motion: reduce) {
  .status-sprite { animation: none; background-position: 0 0; }
}
```

---

## 6. 阈值/占用数据从哪儿来（Claude Code / Codex）

**结论先行**：**两个 runtime 都能拿到"当前上下文占用"的数值**，但**没有一个是"跨 runtime 的统一现成接口"**；且我们经 ACP 接入时，是否送上 `usage_update` **取决于具体适配器实现，必须实测**。若实测不到，契约只能走"未知档"，**不要估算**。

### 6.1 ACP 层（我们的接入面）：协议已标准化 `usage_update`（确认）

- ACP RFD [**Session Context Size and Cost**](https://agentclientprotocol.com/rfds/session-usage)（状态页标注 **Completed**；作者 @ahmedhesham6，champion @benbrandt）提出并经协议落地的通知：

```json
{ "method": "session/update",
  "params": { "sessionId": "sess_abc123",
    "update": { "sessionUpdate": "usage_update", "used": 53000, "size": 200000 } } }
```

- 字段语义（同页逐字）：`used`（必填，Tokens currently in context）、`size`（必填，Total context window size in tokens）、`cost`（可选，累计成本）。"Clients can compute `remaining` as `size - used` and **`percentage` as `used / size * 100`**"。
- 已进入协议 schema：[ACP Protocol — Schema](https://agentclientprotocol.com/protocol/schema) 中存在 `UsageUpdate` 对象（"Context window and cost update for a session"）与 `usage_update` 判别值。
- **关键坑（RFD 逐字）**："If an agent **cannot** provide a meaningful context window size, it **should not** send `usage_update`; this RFD does not define a `null` or omitted `size` state." → **"没有收到 usage_update" 是合法且必须支持的 UI 状态（未知档）**。
- 现实分布（说明"协议有≠适配器会发"）：Cursor 论坛帖 [CLI: emit ACP usage_update so clients like Zed can show a context window indicator](https://forum.cursor.com/t/cli-emit-acp-usage-update-so-clients-like-zed-can-show-a-context-window-indicator/165358) 与 [QwenLM/qwen-code#8513](https://github.com/QwenLM/qwen-code/issues/8513)（"bundled ACP schema already knows `usage_update`, but the session updates actually emitted are only user_message_chunk…"）显示：**schema 支持、实现未发** 是常见状态。→ 我方必须**探测+降级**。

### 6.2 Claude Code：能拿到（含现成的 `percentage`）

来源：[Claude Agent SDK — TypeScript 参考](https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript)（同页原文）：

- `getContextUsage()` 返回 `SDKControlGetContextUsageResponse`，字段含 **`totalTokens`**、**`maxTokens`**、`rawMaxTokens`、**`percentage`**，另有 `categories[]`、`messageBreakdown`、`apiUsage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` 等。
  逐字："**`totalTokens` is the session's current context usage, and `maxTokens` is the window that usage is measured against.** That window is the model's context window, or the lower auto-compaction window when one applies." / "`percentage` is `totalTokens` as a rounded percentage of that window."
- 版本门槛（同页）：`detail` 参数需 Agent SDK **v0.3.257+**；把 `/context` 当 prompt 发时，Claude Code 会把 `SDKContextUsage` 挂在 assistant 消息的 **`context_usage`** 字段（需 **v0.3.232+**）。
- 另有 `ModelUsage`（`SDKResultMessage.modelUsage[model]`）含 **`contextWindow: number`**、`inputTokens`/`cacheReadInputTokens`… （同页）→ 即使不用 `getContextUsage()`，也能用 `输入token/contextWindow` 近似占用（但 cache 语义会让"占用"定义变得微妙：见 [Claude Code 提示缓存文档](https://code.claude.com/docs/en/prompt-caching)）。

**结论**：Claude Code 侧**能拿到百分比**（走 Agent SDK/CLI 协议，或注入 prompt 拿 `context_usage`），但**不代表 teahouse 经 ACP 就能收到**（ACP 适配器是否把 `getContextUsage()` 映射成 `usage_update` 未验证）。置信：确认（字段存在），未确认（适配器行为）。

### 6.3 Codex：分两个面，`codex exec --json` **不可用**，`codex app-server` 可用

- **`codex exec` JSONL（不可用）**：`turn.completed` 只带**累计** token。源码 [`codex-rs/exec/src/event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs)：`fn usage_from_last_total()` 里取的是 `usage.total.input_tokens / .cached_input_tokens / .output_tokens …`（第 118-127 行，`turn.completed` 在 `:534` 使用）。
  上游 issue [openai/codex#17539](https://github.com/openai/codex/issues/17539)（**Closed**）作者逐字："the `turn.completed` JSONL event reports **cumulative session token totals**. This makes it **impossible to determine current context window utilization** … the interactive CLI doesn't have this problem because it uses the per-request data from `ThreadTokenUsage.last` internally. But that field is **discarded** when converting to the exec JSONL output … only `.total` is emitted."
- **`codex app-server` 协议 v2（可用于拿到占用）**：官方生成类型 [`ThreadTokenUsage.ts`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsage.ts)：

  `type ThreadTokenUsage = { total: TokenUsageBreakdown, last: TokenUsageBreakdown, modelContextWindow: number | null }`

  以及 [`ThreadTokenUsageUpdatedNotification.ts`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts)：`{ threadId, turnId, tokenUsage: ThreadTokenUsage }`。
  → **`last.totalTokens ÷ modelContextWindow` 就是我们要的占用百分比**；`modelContextWindow` 可为 `null` → 仍需"未知档"。
- 交互式侧佐证：[Codex CLI 斜杠命令文档](https://developers.openai.com/codex/cli/slash-commands) 中 `/status` = "Display session configuration and token usage … Confirm the active model, approval policy, writable roots, and **remaining context capacity**"；`/statusline` 可选字段含 "model/context/limits/git/tokens/session"。

**结论**：Codex 侧**能拿到占用**，但**只能走 app-server 协议**（`modelContextWindow` 可能为 null）。置信：确认（schema + 源码 + issue 三方一致）。

### 6.4 给契约的写法（不写实现）

- 契约把"上下文占用"定义为 **`used / size`（ACP `usage_update`）**，四舍五入成整数百分比后再套四档阈值（`<10% / ≥10% / ≥20% / ≥40%`，见 §7）。
- **必须记录窗口大小**（窗口是 200K 还是 1M 会改变同一百分比的绝对含义）——见 wayfinder #9 决议："必须记录窗口大小"。
- 拿不到的 runtime → **渲染"未知档"**（不估算、不猜）。如果人类要求"任何情况下都要有数字"，就必须为每个 runtime 写专用探针（Claude Code：`getContextUsage()`；Codex：app-server `ThreadTokenUsage`），成本显著更高 → **需人类拍板**（§9 第 6 条）。

---

## 7. 仓库现状（契约必须贴合的既有约束）

**证据**（本地 `/tmp/teahouse-recon`）：

| 事实 | 位置 | 对契约的影响 |
|---|---|---|
| 已有 atlas + `background-position` 取图先例，静态、`image-rendering: auto` | `src/renderer/src/components/FileTypeIcon.vue:66-96`（`backgroundSize: ${size*4}px`、`backgroundPosition: -col*size, -row*size`） | ① "atlas 取图"不是新技术；② 但它是**静态**的，且用 `auto` —— 我们要新增的是 `steps()` 动画 + `pixelated` |
| 头像 32×32、圆形裁切；行高 38px | `PeerList.vue:242-245`、`:176`、`:207` | 尺寸基准点 |
| 头像 30×30、圆形裁切、`flex: 0 0 30px` | `MessageRow.vue:281-287` | 与 32 冲突；圆形裁切与像素美术冲突 |
| 状态四档阈值与命名（wayfinder #9 决议） | GitHub issue #9 评论 | `<10% 轻松 / ≥10% 累了 / ≥20% 超累 / ≥40% 要累死了`；"可调，且必须记录窗口大小（1M 是主流默认）" |
| 只做循环小动（呼吸、眨眼），不做状态切换的一次性动画 | GitHub issue #9 评论 | 契约只需覆盖"循环"一类动效 |
| 素材方向建议 Kenney.nl（CC0） | `docs/research/reuse-first-inventory.md:117-120` | 若不自研像素画，走 CC0 包（需逐包核对授权） |

---

## 8. 可直接写进契约的硬数字（清单）

| # | 项 | 值 | 依据（确认/推断） |
|---|---|---|---|
| 1 | 目标运行时 | **Chromium 108**（Electron 22.3.27） | 确认（electron-to-chromium + Chromium 分支 VERSION） |
| 2 | 母版画布 | **32×32**（1 画布像素 = 1 CSS px）；若需 2× 资源则 **64×64**（整数倍） | 确认（§2.2 规范）+ 推断（32 是仓内基准，30/32 冲突需拍板） |
| 3 | 禁止的尺寸 | 30 / 40 / 48 / 96 等非 32 的整数倍（作为"缩放到显示尺寸"的母版） | 推断（§2.2） |
| 4 | 唯一可用的渲染关键字 | `image-rendering: pixelated`（**禁止** `crisp-edges`：Chromium 148 才有） | 确认（MDN BCD） |
| 5 | 帧数 | 每个动作 **4–8 帧**；单文件总帧数 ≤ 32（横向一行时宽 ≤ 1024px） | 推断（像素风惯例 + atlas 尺寸预算） |
| 6 | 单帧时长 | **100–200ms**（Aseprite 默认 100ms） | 确认（官方 gist `duration: 100`）+ 推断（区间） |
| 7 | 循环周期 | 呼吸 2.4–3.6s / 眨眼 3–5s（= 帧数 × 帧时长，写进 Aseprite tag 的帧时长） | 推断（"只做循环小动"的可见性上限） |
| 8 | 有效帧率上限 | **≤ 12fps**（不要 60fps；像素风惯用 8–12fps） | 推断 |
| 9 | 交付格式 | `PNG` atlas（横向一行，`--sheet-type horizontal`，padding 全 0/关）+ `JSON`（`--format json-array` **且必带 `--list-tags`**） | 确认（§1.2） |
| 10 | 文件名 | `status@1x.png` / `status@1x.json`（+ `status@2x.*`）；tag 名 = 状态名白名单 `idle` / `tired` / `exhausted` / `critical`（可选 `blink`） | 推断（契合仓内 `@2x` 习惯未见先例，需拍板） |
| 11 | 播放方式（首选） | CSS `animation: <tag>-cycle <duration> steps(<n>) infinite` + `background-position`（对齐 `FileTypeIcon.vue` 的做法） | 确认（§3.1 机制）+ 推断（选型） |
| 12 | 播放方式（备选） | 同一份 JSON 驱动 `transform: translateY()`（竖条 atlas + `overflow:hidden`），仅当出现 jank 或数量超限 | 推断（`transform` 在 108 可合成列表内；需 DevTools 实测确认） |
| 13 | 同时运行动画上限 | **≤ 12 个**（超出改用备选方案或只对"当前 hover/选中"的节点动画） | 推断（**无 bench**，需 demo 页实测） |
| 14 | reduce-motion | `prefers-reduced-motion: reduce` → 停动画、显示静态第 0 帧；另加应用内"动画"开关 | 确认（WCAG 2.2.2 + C39 + Chrome 74 支持） |
| 15 | 不可见窗口 | 动画不保证推进（`backgroundThrottling` 默认 true） | 确认（Electron 文档） |
| 16 | 调色板 | 单精灵 ≤ 16 色 + 透明；需与 naive-ui 主题变量（`--primary`、`--text-2` 等）共存 | 推断（需美术/人类确认） |
| 17 | 阈值映射 | `<10%` 轻松 / `≥10%` 累了 / `≥20%` 超累 / `≥40%` 要累死了（数值可调）+ 窗口大小记录 | 确认（wayfinder #9 决议） |
| 18 | 占用数据来源 | ACP `session/update → usage_update{used,size}`；百分比 = `used/size*100` | 确认（ACP RFD + schema） |
| 19 | 数据缺失时的 UI | **未知档**（不估算、不猜） | 确认（RFD：拿不到 size 就不发 usage_update） |

---

## 9. 需要人类拍板（按"卡住多少下游工作"排序）

1. **显示尺寸统一 30 还是 32？**（`MessageRow.vue` 30 vs `PeerList.vue` 32）——决定母版唯一尺寸，不拍板美术无法开工。
2. **圆形裁切怎么办？**（两处头像都是 `border-radius:50%`）——像素精灵进圆形容器会被切角 + 圆边抗锯齿。选项：(a) 精灵自带圆边留白；(b) 该处改方形/去裁切；(c) 不用像素精灵做头像位。
3. **Windows 125%/150% DPI 下必然发糊，接受吗？**（§2.3，规范行为，CSS 修不掉）——决定"像素完美"是不是硬指标。若必须完美，只能限制在 DPR∈{1,2} 环境，或改用设备像素对齐方案（与现有 32/30px 布局冲突）。
4. **要不要 2× 资源？**（DPR2 下 32CSS=64 设备 px；1× 也能整数放大到 64，但 2× 母版细节更多）——直接决定美术工作量。
5. **拿不到占用数据时显示什么？**（未知档 / 隐藏精灵 / 显示上一次值）——影响 UI 设计与演示叙事。
6. **是否为 Codex 单独走 `app-server` 探针？**（`exec --json` 拿不到，只有 app-server 的 `ThreadTokenUsage` 能拿到）——决定工程成本。
7. **是否加应用内"动画"全局开关？**（除了 `prefers-reduced-motion` 之外，用于同时满足 WCAG 2.2.2 的"机制"要求）——合规双保险 vs 多一个设置项。
8. **帧率是否真的分档**（四档状态用不同速度/不同帧数）——表现力 vs 美术与验收成本。
9. **素材来源**：自研像素画 vs Kenney CC0（`reuse-first-inventory.md` 已建议 Kenney）——影响授权与风格一致性。
10. **调色板上限**（≤16 色？是否强制与主题色协调）——影响与群落界面的视觉统一。

---

## 10. 未确认 / 待实测清单（不要在契约里当事实写）

**Aseprite（本机未安装 Aseprite，未跑任何导出）**

1. `--list-tags` + `--data` 组合是否**一定**输出 `meta.frameTags`（文档说会、#3611 的真实输出有，但无本机可运行证据）。
2. `--split-tags` 与 `--sheet/--data` 同时使用时的确切行为（报错/静默忽略/只导最后一个 tag）。
3. `--filename-format` 的 `{tag}`/`{tagframe}` 对 json-hash 键名的确切影响（官方 gist 默认键为 `file 0.ase` 这类）。
4. `direction`、`repeat` 字段在 1.2.x 各版本是否稳定输出（官方文档的 `frameTags` 示例里都没有）。
5. `--scale` 是否会影响 `duration` 或 `frame` 坐标（文档未说明，需实测；契约建议直接禁用 `--scale`）。

**前端性能**

6. 10–12 个 CSS `steps()+background-position` 精灵在 60fps 下的实测开销与掉帧率（**无 bench**；只有机制推导）。
7. `transform: translateY()` 版在 Chromium 108 里**是否真的**被合成（需 DevTools / Lighthouse *Avoid non-composited animations* 实测；源码里存在多种"不可加速"失败原因）。
8. 非整数 DPR 下发糊的**实际观感**程度（需在 Windows 125%/150% 上肉眼验证）。
9. teahouse 是否允许视觉缩放（grep 未发现 `zoomLevel`/`zoomFactor`/`role:'zoomIn'`，但 Chromium 默认视觉缩放策略未验证）。
10. `<img>` 动图（APNG/WebP）在 Chromium 的内存/解码行为，以及 animated WebP alpha 在 **108** 是否有已知 bug（未找到权威一手出处）。

**协议侧**

11. Claude Code 的 ACP 适配器、Codex 的 ACP 适配器**是否真的发** `usage_update`（协议支持 ≠ 实现发送；已有第三方案例显示"schema 有、实际不发"）。→ 需要一次真实 ACP 会话抓包。
12. Claude Code `getContextUsage()` 的调用是否在 ACP 模式下可行（它属于 Agent SDK/CLI 控制协议，适配器可能不暴露）。
13. Codex `ThreadTokenUsage.modelContextWindow` 为 `null` 的实际频率。

**其他**

14. Electron v22.3.27 版本化文档中的 `autoplayPolicy`（默认 `no-user-gesture-required`）、`backgroundThrottling`（默认 `true`）**未取到 v22 钉版页面**（GitHub raw 与 electronjs.org 版本化 URL 均 404；见 §11 说明）——默认值在 latest 文档确认，行为长期稳定，但"v22 完全一致"未逐字验证。
15. 契约里 `status@2x` 命名是否有仓内先例（未搜到 `@2x` 约定）。

---

## 11. 来源与拒用说明

**保留（一手 / 权威）**

- [Aseprite — CLI 文档](https://www.aseprite.org/docs/cli/)：全部 CLI 参数语义、`--list-tags`/`--split-tags`/`--filename-format` 逐字定义与示例。
- [Aseprite — Sprite sheets 文档](https://www.aseprite.org/docs/sprite-sheet/)：确认 GUI 导出可"select the frames based on tags"，CLI 自动化章节标注 work-in-progress（解释了为何社区要自己写脚本）。
- 官方示例 gist：[json-hash](https://gist.github.com/dacap/db18e5747a4b6e208d3c) / [json-array](https://gist.github.com/dacap/a32adb9248320326733a)（作者 = Aseprite 作者 dacap）：`frames[].{frame,duration,filename}` 实际形状。
- [aseprite#3611](https://github.com/aseprite/aseprite/issues/3611)：真实 `--list-tags` + `--format json-array` 输出，含 `direction`；多文件合并时 `frameTags` 重叠的真实缺陷。
- [Aseprite 社区帖：CLI … --split-tags](https://community.aseprite.org/t/command-line-interface-help-to-export-sprite-sheets-and-split-tags/16460)：`--split-tags` 不拆 sheet/data 的实测。
- [Chromium 108 `compositor_animations.cc`](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/5359/third_party/blink/renderer/core/animation/compositor_animations.cc)（+ [chrome/VERSION 校验 = 108](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/5359/chrome/VERSION)）：`kCompositableProperties` 权威清单。
- [MDN `image-rendering`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/image-rendering) + [MDN BCD 原始数据](https://github.com/mdn/browser-compat-data/blob/main/css/properties/image-rendering.json)：`pixelated` Chrome 41 / `crisp-edges` Chrome 148；`pixelated` 规范语义逐字。
- [web.dev — High-performance CSS animations](https://web.dev/articles/animations-guide) / [Stick to compositor-only properties](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count) / [Lighthouse: Avoid non-composited animations](https://developer.chrome.com/docs/lighthouse/performance/non-composited-animations)：非合成动画 = 触发 Style/Layout/Paint。
- [caniuse apng](https://caniuse.com/apng) / [caniuse webp](https://caniuse.com/webp)（含原始 JSON）：APNG Chrome 59+，animated WebP Chrome 32+。
- [chromium.org/audio-video](https://www.chromium.org/audio-video/)：容器与编解码器清单（H.264 属专有组）。
- [Electron 22 `build/args/all.gn`](https://github.com/electron/electron/blob/v22.3.27/build/args/all.gn)：`proprietary_codecs = true`、`ffmpeg_branding = "Chrome"`。
- [Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)：`autoplayPolicy` 默认 `no-user-gesture-required`、`backgroundThrottling` 默认 `true`。
- [electron-to-chromium versions.js](https://github.com/kilian/electron-to-chromium/blob/master/versions.js) + [Electron 22 公告](https://www.electronjs.org/blog/electron-22-0)：Electron 22 = Chromium 108。
- [WCAG 2.2 SC 2.2.2 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) + [Technique C39](https://www.w3.org/WAI/WCAG21/Techniques/css/C39) + [web.dev prefers-reduced-motion](https://web.dev/articles/prefers-reduced-motion)：无障碍义务与支持版本。
- [ACP RFD: Session Context Size and Cost](https://agentclientprotocol.com/rfds/session-usage) + [ACP Schema](https://agentclientprotocol.com/protocol/schema)：`usage_update{used,size,cost}`。
- [Claude Agent SDK TypeScript 参考](https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript)：`getContextUsage()` / `SDKControlGetContextUsageResponse`（含 `percentage`）/ `SDKContextUsage` / `ModelUsage.contextWindow`。
- [openai/codex `ThreadTokenUsage.ts`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsage.ts) + [`ThreadTokenUsageUpdatedNotification.ts`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts) + [`event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs) + [codex#17539](https://github.com/openai/codex/issues/17539)：Codex 两个面的可用性差异。
- [Codex CLI 斜杠命令文档](https://developers.openai.com/codex/cli/slash-commands)：`/status` = token usage + remaining context capacity。
- [chromestatus "CSS Image Animation"](https://chromestatus.com/feature/5078177326170112) + [Chromium issue 429459566](https://issues.chromium.org/issues/429459566)：动图播放控制**尚无**标准 API。

**拒用 / 降级（不作为结论依据）**

- 各类博客与教程（teamtreehouse、pmichaels、leanrada、css-tricks、w3schools、salivity.github.io、dev.to、properaccess、getunblocked 等）：内容与官方文档一致或属于二手转述；仅 "prefers-reduced-motion 不能替代 2.2.2 机制" 一条被标为二手来源引用。
- [ceramic-engine 的 AsepriteJson 文档](https://ceramic-engine.com/api-docs/clay-native/ceramic/AsepriteJson/)：第三方引擎解析器，只用于旁证 "array 格式" 的通用性。
- YouTube 视频（拆分 tag 导出教程等）：无法逐字引用，弃用。
- Stack Overflow / Reddit：仅用于发现 issue/一手页面的线索，未直接引用。
- Chromium 源码的 **main 分支**：与 108 可能不同，一律改用 `branch-heads/5359`。

---

## 附：本地文件索引（写契约时可直接引用）

| 文件:行 | 内容 |
|---|---|
| `src/renderer/src/components/FileTypeIcon.vue:66-96` | 4×4 PNG atlas + `background-position` 取图（现状：静态、`image-rendering: auto`） |
| `src/renderer/src/components/PeerList.vue:176,207` | 列表行 `height: 38px` / `min-height: 38px` |
| `src/renderer/src/components/PeerList.vue:242-245` | `.peer-avatar` 32×32 + `border-radius: 50%` |
| `src/renderer/src/components/MessageRow.vue:281-287` | `.msg-avatar` 30×30 + `border-radius: 50%` + `flex: 0 0 30px` |
| `package.json`（pantry v0.60.2） | `build.electronVersion = "22.3.27"` |
| `node_modules/electron/package.json` | `"version": "22.3.27"` |
| `docs/research/reuse-first-inventory.md:117-120` | 像素风素材方向：Kenney.nl（CC0）等 |
| GitHub issue #9（评论） | 状态四档命名/阈值、只做循环小动、形象归美术 |
| GitHub issue #17 | 本契约的验收问题清单（7 项） |
