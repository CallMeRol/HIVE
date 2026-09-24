# 23: [品牌] Hive 品牌改造——去 teahouse 名与绿

GitHub: #64（原文已不可读取；正文由 git 与本地笔记还原）

Status: resolved
Implementation: merged b317754
Blocked by:
- None (can start immediately)

## What to build

见下方正文重建。

## Acceptance criteria

把产品身份从 teahouse（茶话间/绿色）改为 Hive（红色蜂巢标），使界面与美术交付的视觉规范一致。

## Acceptance criteria

- [ ] 界面、主进程、托盘、窗口、通知、autostart、诊断与导出文件名中的品牌字符串改为 Hive
- [ ] i18n en.ts 的 Teahouse → Hive（含颜色名词条）
- [ ] package.json productName → Hive
- [ ] 视觉遵循 docs/design-drafts/HIVE-VISUAL-SPEC.md：Hive 红 #e94560 + 深蓝底 #0a0e17，禁 teahouse 绿
- [ ] 新增品牌资产逐条记账进 patch-allowlist，provenance.json 补条目
- [ ] pnpm run check:vendor 0 violations，typecheck 通过

> 正文由 commit 879e301 / b317754 还原，非 GitHub 原文。

## Recovery note

879e301 Hive 品牌改造；合并总结 b317754（75 文件 +414/-459）

## Comments

- [迁移] 2026-09-24 恢复。非本会话发布脚本产物，正文为推断重建，权威度低于 #42–#63。
