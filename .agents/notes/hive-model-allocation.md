# Hive batch #44–#63 模型分配策略（用户给定）

> 来源：用户 2026-09-23 会话指令。四个槽位只是别名挂载点，**不代表能力排序**。

## 槽位 → 后端模型

| 槽位 | 实际模型 |
|---|---|
| haiku | `k2.8-preview[1M]`（Kimi-K2.8） |
| sonnet | `mimo-v2.6-flash[1M]` |
| opus | `deepseek-v4.1-flash[1M]` |
| fable | `glm-5.3-flash[1M]` |

传参：`herdr agent start <name> --kind claude --pane <pane> -- --model <slot>`

## 按任务类型分配（用户口径）

| 任务类型 | 指派模型 | 依据 |
|---|---|---|
| 长程多步 / 长任务 | **GLM-5.3-Flash**（fable） | 长程稳定性 |
| 契约语义 / 重推理 | **GLM-5.3-Flash**（fable）或 K2.8（haiku，需实测） | GLM 幻觉率 28%，K2.8 无数据 |
| 短程 agentic 编码 / 大 patch | **DeepSeek v4.1 Flash**（opus） | 384K 输出 + TB2.1 第 1 |
| 前端 | 默认 **DeepSeek v4.1 Flash**（opus）；需视觉闭环才用 GLM（fable） | 出分优先，视觉闭环另论 |
| 低成本大批量 | **mimo-v2.6-flash**（sonnet） | 实际表现优于预期，保留 |

## 本批映射

- 已在跑的 #46/#47/#48 用 opus 槽（deepseek）——短程 agentic 编码，符合口径，不打断。
- 后续长程/契约类（#50 目标冻结、#51 派遣编排、#54 交接、#55 守卫、#58 持久化、#62 验收）→ fable（GLM）。
- 前端类（#52 机库、#57 网络图）→ 默认 opus（deepseek），确需视觉闭环再换 fable。
- 轻量纯函数（#60）→ sonnet（mimo）。
