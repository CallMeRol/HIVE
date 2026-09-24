# 候选 (c)：teahouse 内新面板 —— 上游文件级改动清单

> 轮廓级；评估「最少改几个上游文件」，不实现。

## 最小改动集（2 上游文件 + 1 新组件）

1. `src/renderer/src/components/GroupPanel.vue`
   - 成员 `<li>`（L308-345 一带）加 `@click="openMemberDetail(id)"`。
   - 引入新组件 `<MemberProcessCard>`（新文件，不改 GroupPanel 行数只加引用 + 事件）。
2. `src/renderer/src/components/App.vue`（或路由/面板注册处，按上游实际结构）
   - 注册 `MemberProcessCard` 的全局或路由挂载点。
3. 新文件：`src/renderer/src/components/MemberProcessCard.vue`（成员详情卡：状态列表 + 过程流；样式可复用 ChatPane 基础）。

## 连带必须解决（→ 归「成员身份标识」另一张票）

- `GroupPanel.vue:308-345` 成员列表当前**纯人形渲染**（`AvatarMark` + 人名 + 群主/管理员徽章），`CAPS`（`shared/protocol.ts`）**无 agent 位**。
- 若过程卡挂在成员点击上，agent 成员当前在人形列表里**不可区分**，入口会混淆。
- 按 #33 既定规则：本票不解决身份标识；该决策归「成员身份标识」票（尚未创建）。

## 数据路径（对比 (a)/(b) 多一层桥）

- 过程数据在 main 进程（local-api / sessions 目录）；renderer 要经 `preload` 暴露的 IPC 读取，比 local-api 直连 HTTP+SSE 多一层桥。
- 上游 `renderer 永不直接碰网络/磁盘/DB`（landmines 卡 8 铁律）→ 必须新增 IPC 通道，本身也是一处上游 `preload` 改动。

## 结论

- 最少 **2 个上游文件**（GroupPanel.vue + App.vue/路由）+ 1 新组件 + preload IPC 通道。
- 比 (b) 多触 renderer 面，且触发「成员身份标识」连带决策。
