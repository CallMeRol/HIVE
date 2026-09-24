# Liquid Neural Space

Liquid Neural Space 是一个用于 Multi-Agent 系统的 3D 可视化工作空间：它把 Agent 的感知/行动、具体/抽象、局部/全局等工作属性映射到一个可探索的液态神经空间，而不是宣传动画或传统节点图。

## 运行

项目使用 React 19、Vite 7、TypeScript strict、`@react-three/fiber` 9.7、`@react-three/drei` 10.7.8、`@react-three/postprocessing` 3.1.1、Three.js 0.180.0 和 Zustand 5.0.15。

```powershell
# 安装依赖（项目固定使用 pnpm 11.25.0）
node D:\dsh\.corepack\v1\pnpm\11.25.0\bin\pnpm.cjs install

# 启动开发服务器
node node_modules\vite\bin\vite.js --port 5199 --strictPort

# 类型检查
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.json

# 生产构建
node node_modules\vite\bin\vite.js build
```

开发服务器地址为 `http://localhost:5199/`。在本机上它可能只绑定 IPv6 回环地址；若 `127.0.0.1` 无法访问，请使用 `http://[::1]:5199/`。

## 设计红线

下面的约束共同决定 Liquid Neural Space 的视觉语义。修改相关实现时，必须同时检查对应文件、常量和回归脚本。

1. **空间位置只表达工作属性。** `src/lib/semanticSpace.ts` 固定使用三条等权语义轴：X 为感知（-1）到行动（+1），Y 为具体（-1）到抽象（+1），Z 为局部（-1）到全局（+1）。父子层级不能参与坐标计算，也不能映射到 Y/Z 分层或球体大小。Strategy Agent 因为抽象而位于球体上方，与它是第几代无关。

2. **方向由语义决定，半径只表示语义极端程度。** `semanticToWorld` 将语义立方体弯成球壳，`SHELL_INNER = 5.4`、`SHELL_OUTER = 9.2`。方向不能被组织关系或随机布局覆盖，半径仅表达该角色距离语义中心的程度。

3. **三条语义轴必须等权。** `SEMANTIC_SCALE` 在 `src/lib/semanticSpace.ts` 中固定为 `{ x: 8, y: 8, z: 8 }`。给某条轴额外加权会压扁球体，并破坏语义空间的可读性。

4. **13 个角色必须覆盖全部 8 个语义卦限。** `ROLE_PRESETS` 是手工策展并经过带弹簧约束的球面斥力松弛得到的分布。修改预设时必须保持 8/8 卦限覆盖、轴向不翻转、最小两两夹角至少 40°；当前基线为最小夹角约 44°、最大漂移约 24°。

5. **节点大小只表达 weight。** `src/store/useAgentGraph.ts` 的 `AGENT_RADIUS = 0.34`，Agent 的 weight 在 store 中限制为 `0.85–1.30`。大小与层级、代数和角色分类无关。

6. **突触必须是直线段。** `src/lib/tubeGeometry.ts` 的 `makeSynapseCurve` 只回缩端点，使管身停在胞体表面；控制点保持共线，因此几何上是直线。弯曲、大圆航线或侧向顶出会把球壳读成毛线团。

7. **拓扑必须配合直线和 Agent 血缘。** `src/store/useAgentGraph.ts` 从空间近邻中挑选协作边，按 `1 / distance` 加权并从最近约 30% 的候选池取样；每个胞体通常连接 2 条突触。`collaboration/context` 横向边禁止连接祖先与后代，父子关系只通过 `spawn/return` 表达。性能不足时可以把连接数降回 1，但不能恢复随机长边或跨代横连。

8. **数据包必须表现为流动。** `src/three/AgentLink.tsx` 中，包半径为局部管半径的 `1.7` 倍；位置由 `dt` 累加，不能从时钟取模而瞬移；速度使用世界单位 `0.9–2.1 / s`；包通过 `sin(πu)` 的开方包络淡入淡出，中间保留静止间隙；每个包带更暗、更短的彗尾；材质保持 `depthTest: true`，避免穿过胞体。

9. **流光相位必须绑定世界尺度。** 管身流光在 `src/three/AgentLink.tsx` 中使用 `along * uSpan` 计算相位，而不是归一化的 `[0, 1]` 参数。这样长短不同的突触仍然像同一种流体。

10. **直线突触依靠表面蠕动保持液态感。** 管身顶点沿法线做低频 `linkFlow` 位移，并在两端渐隐为零。位移幅度必须按局部管半径缩放，即 `uTubeR * 0.3`，不能使用绝对距离；否则细管会被压扁。

11. **颜色表达负担，不表达角色。** 每个神经元代表一个 agent，本体为白色半透明液态材质；表面、内芯和外缘状态光按上下文窗口占用量显示 PRD 五档：空闲蓝 `#58a6ff`、轻松绿 `#3fb950`、有点忙黄 `#d29922`、过载橙 `#f0883e`、快炸了红 `#f85149`。阈值分别是无运行会话或无数据、`<10%`、`≥10%`、`≥20%`、`≥40%`。每条突触在两端使用各自神经元的状态光颜色，中段平滑渐变；流动的数据包也取所在位置的渐变色。背景接近黑色 `#050608`，使用微弱雾效；场景不显示坐标轴、网格或星空。

12. **负空间和选择性信息优先。** 胞体应保持小而稀疏，负空间是主要材料；`src/three/AgentLabel.tsx` 的标签只在 hover 或 selected 时渲染。画布占比至少 70%，右侧 Inspector 固定在约 300–360px。idle、thinking、running、spawning、returning、error 等状态通过运动、流光和生命周期行为表达，而不是堆叠常显文字。

13. **渲染架构必须避免每帧 React 重渲染。** `src/lib/positions.ts` 中的 `nodePositions` 和 `linkHandles` 是 React 外部的帧级注册表；`useFrame` 直接读取 `useAgentGraph.getState()`。静态突触不应产生每帧 React 开销，只有端点移动或流量换档时才重建几何。返回新数组/对象的 Zustand selector 必须用 `useShallow` 包裹，避免 `getSnapshot should be cached` 无限循环。

14. **每次空间或视觉改动都要做回归。** 坐标映射改动后运行 `D:\dsh\.lins-smoke\axes-check.mjs`，三条轴的 `corr(semantic, world)` 均需至少 `0.96`；同时检查 8/8 卦限、最小夹角、球壳厚度比和三轴跨度。当前基线是相关性 `0.973 / 0.976 / 0.973`、球壳厚度比 `0.042`、三轴跨度 `14.6 / 14.5 / 14.2`。视觉改动还必须用截图脚本复核，不能只依赖指标。

## 交互

- 使用鼠标拖拽旋转空间，滚轮缩放；相机由 `src/three/CameraController.tsx` 控制，距离范围为 `2.2–72`。
- 进入空间后就会以每秒约 4° 的慢速自动水平旋转展示；用户开始旋转、缩放、平移或点击后立即暂停，解除操作后恢复。
- Hover 或点击胞体时显示标签并更新右侧 Inspector；未交互时不显示标签墙。
- 选中 Agent 会进入聚焦模式：选中节点与一跳邻居保持清晰，邻居之间的上下文连接半透明，其余组织退到暗部；左上角 Focus HUD 显示当前对象、邻居数和清除按钮。点击空白处或按 `Escape` 可退出聚焦。
- Inspector 的 Semantic Position 显示 X/Y/Z 三条带数值的语义轴，并列出可直接跳转的相邻 Agent；`SHOW LINEAGE` 可以暂时只保留当前 Agent 的祖先与后代闭包。
- 相机会根据首批 Agent 的包围盒自动构图；模拟扩展时只向外适配并轻微跟随组织重心，不持续覆盖用户的旋转角度。
- 生命周期状态会驱动胞体的生成、合并、吸收、运行和返回动画。关键时长为 `SPAWN_MS = 7000`、`MERGE_MS = 900`、`ABSORB_MS = 900`。
- 生成飞行段使用 `easeMass`：`x^2.2 / (x^2.2 + (1-x)^2.6)`，以获得慢速分离、加速、减速的有质量手感。
- 组织还共享一个克制的双相生命节律：`src/lib/util.ts` 的 `heartbeatPulse` 驱动胞体轮廓、内芯和突触微弱搏动；宏观收缩—舒张使用同一拍点，空间流场保留差异，避免齐刷刷的机械感。突触尾波仍按世界尺度运行，数据包仍由 `dt` 累加推进。
- 数据包在 `src/three/AgentLink.tsx` 中保留线性世界速度和 `dt` 推进；只有处于隐藏等待段的包会在心跳上升沿从源节点释放，因此每次组织收缩都会推出一波同步信息流，不会把已经可见的包瞬移回起点。
- 心跳峰值会同步抬高胞体内芯、突触流光、数据包和 Bloom；亮度集中在搏动峰值与活跃路径，舒张段仍然回到暗部。
- 视觉层在 `src/three/NeuralCanvas.tsx` 提供组织级悬浮、呼吸和指针视差；`src/three/AgentNode.tsx` 的低频弹簧偏移围绕语义锚点运行，`src/lib/positions.ts` 的 `visualOffsets` 由突触 shader 消费，因此不需要每帧重建管身。远景突触还会按相机距离自动退暗，近景和聚焦态恢复细节。
- 当系统启用 `prefers-reduced-motion` 时，持续表面流动和数据包动画会降级，CSS 动画也会停止。
- `src/lib/audio.ts` 提供可关闭的界面声音：心跳上升沿播放真实心跳片段，Agent 选中播放短选择音。音频首次需要用户指针动作解锁；本地音效来自 [小森平的人体音效页](https://taira-komori.net/human01cn.html)，按页面说明允许项目内使用、加工和商业使用，项目不重新分发音效站点地址。

## 组件结构

```text
src/
├─ three/
│  ├─ NeuralCanvas.tsx      画布：雾、尘埃、Bloom、暗角；相机初始位置 [17,10.5,19]，fov 44
│  ├─ AgentNode.tsx         液态球体与 Spawn/Merge/Absorb 状态机
│  ├─ AgentMaterial.ts      球体、内芯、突触 shader
│  ├─ AgentLink.tsx         直线突触、数据包与彗尾
│  ├─ SpawnEffect.tsx       分裂颈部效果
│  ├─ AgentLabel.tsx        仅 hover/selected 时显示的标签
│  ├─ CameraController.tsx  Orbit 相机控制
│  └─ SceneDust.tsx         使用 CanvasTexture 软精灵的尘埃
├─ store/useAgentGraph.ts   Zustand 图状态与生命周期模拟
├─ lib/semanticSpace.ts     语义空间与 13 个 ROLE_PRESETS
├─ lib/tubeGeometry.ts      变径直线管几何
├─ lib/positions.ts         帧级位置注册表
├─ lib/util.ts              clamp、lerp、ease、hash01、easeMass
├─ ui/                      Inspector、TopBar、Timeline、NavRail
└─ types.ts                 共享类型
```

## 性能

性能必须使用真机 GPU 测量：headless 模式的 SwiftShader FPS 只有参考价值，不能用于性能结论。`D:\dsh\.lins-smoke\perf-real.mjs` 和 `perf-load.mjs` 应使用 headful + `--enable-gpu`；当前测试机为 Intel Iris Xe 集显。

| 场景 | Agent | 突触 | FPS |
|---|---:|---:|---:|
| 常规负载 | 36 | 72 | 60 |
| 压力负载 | 50 | 105–119 | 57–60 |

生产构建和类型检查基线均为通过，控制台无运行时错误（仅允许 favicon 404）。

## 调试开关

在 URL 后追加以下参数可隔离场景问题：

| 参数 | 作用 |
|---|---|
| `?nolinks=1` | 隐藏突触 |
| `?nonecks=1` | 隐藏胞体连接颈部 |
| `?nocore=1` | 隐藏胞体内芯 |

`src/main.tsx` 暴露了以下自动化接口：

```ts
window.__linsSelect(id)
window.__linsSpawn(parentId)
window.__linsReset()
window.__linsState()
window.__linsPos(id)
window.__linsLoad(id, pct) // 演示指定 agent 的窗口占用率；null 表示无数据
```

验证脚本位于 `D:\dsh\.lins-smoke\`：`smoke.mjs` 用于基础冒烟，`stress.mjs` 用于 50 Agent 压测，`axes-check.mjs` 用于语义轴回归，`shape-check.mjs` 用于球壳形状，`cover-check.mjs` 用于方向覆盖，`envelope.mjs` 与 `flow-macro.mjs` 用于结构截图，`dir-check.mjs` 用于方向分布和角色计数。
