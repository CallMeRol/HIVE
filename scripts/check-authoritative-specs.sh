#!/usr/bin/env bash
# Issue #42 验收检查：权威规格收口 + 并行开发契约（父 SPEC #41）
# 断言 AC1–AC4 的机器可查项。任何一条失败即非零退出。
set -u
cd "$(dirname "$0")/.."

CONTRACT="docs/contracts/parallel-development.md"
fails=0

ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

contains() { # file pattern label
  if [ ! -f "$1" ]; then bad "$3（文件缺失: $1）"; return; fi
  if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3（$1 中未找到: $2）"; fi
}

not_contains() { # file pattern label
  if [ ! -f "$1" ]; then bad "$3（文件缺失: $1）"; return; fi
  if grep -qF -- "$2" "$1"; then bad "$3（$1 中仍存在旧口径: $2）"; else ok "$3"; fi
}

echo "== AC1: 单次越界立即派遣 + 旧口径标记 =="
contains CONTEXT.md "单次越界" "CONTEXT 越界 = 单次越界"
not_contains CONTEXT.md "连续两次越界" "CONTEXT 无「连续两次越界」旧口径"
not_contains docs/handoff/RULES.md "连续两次越界" "RULES 无「连续两次越界」旧口径"
contains docs/handoff/RULES.md "单次越界" "RULES 派单草案 = 单次越界"
not_contains docs/PRD.md "塔奇克马方形头像" "PRD 无「塔奇克马方形头像」旧口径"
contains docs/PRD.md "名字头像" "PRD 头像 = 名字头像 + 状态点"
not_contains docs/handoff/sprite-and-network-contract.md "资源归还 + 成员表置灰" "sprite 契约回收不再是置灰"
not_contains docs/handoff/sprite-and-network-contract.md "可以**进头像位" "sprite 契约无「精灵进头像位」现行口径"
not_contains docs/handoff/sprite-and-network-contract.md "现在**可以**放精灵" "sprite 契约无另一种「精灵进头像位」旧表述"
not_contains docs/handoff/sprite-and-network-contract.md "filter:grayscale(1)" "sprite 契约无回收去饱和遗迹"
not_contains docs/handoff/sprite-and-network-contract.md "回收额外\"退群 HH:MM\"" "sprite 契约无回收时间遗迹"
not_contains docs/handoff/windows-verification.md "任务信封 + 交接文档" "windows-verification 旧类型已标记"
not_contains docs/demo/emergence-ab.md "交接工件" "emergence-ab 无「交接工件」旧词"
contains "$CONTRACT" "| 旧口径" "契约含旧口径登记表"
contains "$CONTRACT" "连续两次越界" "登记表收录：连续两次越界"
contains "$CONTRACT" "回收遗迹" "登记表收录：回收遗迹"
contains "$CONTRACT" "塔奇克马精灵作为头像" "登记表收录：精灵作为头像"
contains "$CONTRACT" "JSON envelope" "登记表收录：JSON envelope"
contains "$CONTRACT" "任务信封" "登记表收录：任务信封"
contains "$CONTRACT" "手写 NDJSON" "登记表收录：手写 NDJSON"

echo "== AC2: Mac Product Complete vs Original MVP Complete =="
contains "$CONTRACT" "Mac Product Complete" "契约定义 Mac Product Complete"
contains "$CONTRACT" "Original MVP Complete" "契约定义 Original MVP Complete"
contains "$CONTRACT" "本轮仅交付 Mac Product Complete" "契约声明本轮仅交付前者"
contains "$CONTRACT" "#62" "契约锚定验收票 #62"
contains "$CONTRACT" "#63" "契约锚定延期票 #63"

echo "== AC3: 共享事件 / 状态所有者 / 迁移规则 / 模块所有权 =="
contains "$CONTRACT" "## 共享事件" "契约含共享事件章节"
contains "$CONTRACT" "## 状态所有者" "契约含状态所有者章节"
contains "$CONTRACT" "## 迁移规则" "契约含迁移规则章节"
contains "$CONTRACT" "## 模块所有权" "契约含模块所有权章节"
for ev in "message.new" "acp.update" "guard.verdict" "member.lifecycle" \
          "pending.updated" "dispatch.event" "burden.updated" "error"; do
  contains "$CONTRACT" "$ev" "冻结事件类型 $ev"
done
contains "$CONTRACT" "schemaVersion" "迁移规则含 schemaVersion"
contains "$CONTRACT" "#43" "模块所有权锚定 #43"
contains "$CONTRACT" "#58" "模块所有权锚定 #58"

echo "== AC4: 复用清单与禁止重复实现 =="
for reuse in "teahouse" "@agentclientprotocol/sdk" "markdown-it" "DOMPurify" "Claude Code" "Codex" "@vue-flow/core"; do
  contains "$CONTRACT" "$reuse" "复用清单含 $reuse"
done
contains "$CONTRACT" "禁止重复实现" "契约含禁止重复实现声明"
for no in "群协议" "身份系统" "ACP client" "Markdown parser" "通用图引擎"; do
  contains "$CONTRACT" "$no" "禁止清单含 $no"
done

echo "== AC5: #42 契约对齐 #43 实现 =="
ADR3="docs/adr/0003-snapshot-vendor-with-patch-whitelist.md"
not_contains "$CONTRACT" "UPSTREAMS.md" "契约无旧记账名 UPSTREAMS.md"
not_contains "$CONTRACT" "check-patch-face.sh" "契约无旧守卫名 check-patch-face.sh"
contains "$CONTRACT" "check-vendor-patches.mjs" "契约引用 check-vendor-patches.mjs"
contains "$CONTRACT" "provenance.json" "契约引用 provenance.json"
contains "$CONTRACT" "patch-allowlist.txt" "契约引用 patch-allowlist.txt"
not_contains "$CONTRACT" "#43 → #44" "headless/local-api/smoke 不再归 #43→#44"
contains "$CONTRACT" "不实现 headless/local-api/smoke" "契约声明 headless 归 #44"
not_contains "$ADR3" "UPSTREAMS.md" "ADR-0003 无 UPSTREAMS.md"
not_contains "$ADR3" "check-patch-face.sh" "ADR-0003 无 check-patch-face.sh"
not_contains "$ADR3" "vendor/baselines/" "ADR-0003 无入库 baseline tar 路径"
contains "$ADR3" "check-vendor-patches.mjs" "ADR-0003 引用 check-vendor-patches.mjs"
contains "$ADR3" "baseline.sha256" "ADR-0003 引用 baseline.sha256"
contains "$ADR3" "provenance.json" "ADR-0003 引用 provenance.json"
contains "$ADR3" "archive tar 不入库" "ADR-0003 声明 tar 不入库"
contains "$ADR3" "覆盖 \`package-lock.json\`" "ADR-0003 guard 覆盖 package-lock"
not_contains "$ADR3" "排除 \`package-lock.json\`" "ADR-0003 不再排除 package-lock"
contains "$ADR3" "归 **#44**" "ADR-0003 headless 归 #44"

echo
if [ "$fails" -gt 0 ]; then
  echo "check-authoritative-specs: ${fails}项失败"
  exit 1
fi
echo "check-authoritative-specs: 全部通过"
