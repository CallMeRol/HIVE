# 任务漂移检测路线调研报告

> 日期: 2026-09-21 | 调研人: BrightCastle
> 需求: 毫秒级、零边际成本、离线、可解释地判断"输入是否在本会话目标范围内"，不在则 handoff。

## 路线一: Claude Code auto mode / 危险命令判定

**结论: 独立模型分类器（非规则、非主模型自判），云端 Sonnet 调用，不可离线；架构思路可复刻，模型本身拿不到。** — 「确认」

一手来源: [How we built Claude Code auto mode (anthropic.com, 2026-03-25)](https://www.anthropic.com/engineering/claude-code-auto-mode)；文档 [permission-modes](https://code.claude.com/docs/en/permission-modes)、[auto-mode-config](https://code.claude.com/docs/en/auto-mode-config)。

- **架构（确认）**: 三层流水线——Tier 1 内置白名单 + 用户 allow/deny 规则（纯规则）；Tier 2 项目内文件操作直接放行；Tier 3 其余动作进 **transcript classifier**。另有独立的 prompt-injection probe 扫工具结果；PreToolUse hook 在用户侧规则层，与分类器正交。
- **用什么模型（确认）**: transcript classifier 跑 **Sonnet 4.6**，两阶段：Stage 1 单 token (yes/no) 快筛（倾向误拦），Stage 2 仅对 Stage 1 标记项跑 CoT 复核（prompt 几乎全部命中 Stage 1 缓存以省成本）。
- **判定输入（确认）**: 刻意 reasoning-blind——只看 user messages + tool call 原文，剥掉 assistant 推理与工具输出，防 agent 花言巧语说服分类器。
- **性能（确认，官方自报）**: Stage 1 FPR 8.5% → 全流水线 FPR 0.4%；真实"过度热心"场景 FNR 17%（官方自认的诚实数字）；合成数据外泄 FNR 5.7%。
- **延迟/成本（存疑）**: 官方未公布毫秒数；社区（HN）称 auto mode 增 ~15-28% token 消耗。Stage 1 刻意压低延迟，但**本质是云端大模型调用**，非毫秒级本地判定。
- **可迁移性**: 「规则先行 → 小判定模型兜底 → 只看 user intent + 动作、不信 agent 自辩」的架构完全可复刻；但其意图对齐判定依赖 Sonnet 级模型，不满足"零边际成本 + 离线"。

## 路线二: JEV / System One models + laya

**结论: JEV 是 TypeSafe AI 闭源 API（无本地权重）；laya 是第三方独立复刻，Apache-2.0、HF 权重可下载、可离线，但极不成熟。** — 部分确认/部分存疑

### JEV（TypeSafe AI）— [官方博客, 2026-09-15](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- **是什么（确认）**: "System One Model"——非自回归**判定模型**，输入非结构化 state，输出带校准概率的类型化答案（classify/route/score/guardrail）。训练法自称 RLCD。符合"非 LLM 判定器"定位，是模型不是方法。
- **声称指标（厂商声称，存疑）**: 比前沿 LLM 快 193.6x、便宜 444.6x；$0.042/MTok 输入、输出免费；~100ms。官方自承数字"偏收益高端"且评测参考是 GPT/Astra/Fable 平均，有偏差。
- **开源情况（确认）**: **闭源 API（early access），无权重，不能离线。**

### laya（开源替代）— [GitHub](https://github.com/NandhaKishorM/laya) / [HF](https://huggingface.co/convaiinnovations/laya)
- **与 JEV 关系（确认）**: **不是同一东西的开源实现**，是个人开发者的独立复刻（自称早于 Jev 一年做了同类模型），借用 System-1/RLCD 叙事对标。
- **可验证事实**: Apache-2.0；Python；checkpoint 为 ModernBERT-large 421M / mmBERT-base 322M，HF safetensors 可下载离线跑。仓库 2026-09-18 创建，3 天内 7777 star ——「存疑，高度疑似营销冲榜」。
- **README 声称 vs 实际**: 声称 33ms 单问 (T4) / 193-464ms (CPU)——「声称，未独立验证」；自承 Banking77 0.425 远逊 Jev 0.870；自承非拉丁语系崩坏（Khmer 准确率 0.000 但置信 0.952，校准失效）。
- **成熟度（确认）**: 单人、3 天新仓库、无生产记录。**能跑，但不能当可信组件直接用。**

## 路线三: 现成开源"意图漂移 / 会话目标守卫"

**结论: 未找到任何现成的"任务漂移检测"开源实现；只有相邻组件，需自行组装。** — 「确认（未找到直接证据）」

- **NeMo Guardrails topic control**（[NVIDIA](https://github.com/NVIDIA-NeMo/Guardrails), Apache-2.0）: 判 "on-topic/off-topic" 但默认靠**主 LLM 加 system prompt 判定**，非毫秒级；可接自定义小模型。「确认」
- **Llama Prompt Guard 2**（[HF](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M), 86M/22M, Llama license）: 本地可跑、毫秒级，但只判 prompt injection/jailbreak，**不判目标漂移**。「确认」
- **NLI / cross-encoder 小模型**（如 [tasksource/ModernBERT-base-nli](https://huggingface.co/tasksource) 系、sentence-transformers CrossEncoder，~150-400M, Apache/MIT 系）: premise=新消息, hypothesis=会话目标，本地 CPU 毫秒级、输出 entailment 概率、完全可打印。这是最接近需求的现成积木，但**没有人为"agent 任务漂移"场景微调过**，需自建阈值+少量标注。「确认可跑 / 存疑开箱效果」
- **"claude -p 做小分类器"实践**: 有社区用 headless LLM 调用做守卫的写法，但为 API 调用、非毫秒级、非零成本，不满足约束。「确认不适用」

## 三路线对比表

| 维度 | 一: CC auto mode | 二: JEV / laya | 三: 开源相邻组件 |
|---|---|---|---|
| 延迟 | 百 ms-秒级（云端） | JEV ~100ms(API) / laya 33ms GPU、193-464ms CPU | NLI 小模型 CPU <50ms |
| 边际成本 | ~15-28% token 上浮 | JEV 付费 API / laya 0 | 0 |
| 需额外模型 | 需（Sonnet，不可得） | JEV 需其 API / laya 421M 本地 | 需（~150-400M，本地） |
| 离线可用 | ✗ | JEV ✗ / laya ✓ | ✓ |
| 可复刻难度 | 架构易、模型不可复刻 | laya 可直接跑但不可信 | 中（需微调+阈值） |
| 证据强度 | 高（官方工程文） | 低-中（厂商声称+单人项目） | 中（成熟库，无现成场景） |

## 明确推荐

**先做路线三的"NLI/cross-encoder 小模型 + 规则"自组装**——四条硬约束（毫秒级/零边际成本/离线/可解释）下唯一全部满足的路线；**避免**直接上 laya（3 天新仓库、star 异常、自承校准失效）和依赖 JEV/CC auto mode 这类云端 API（违反离线+零成本）。

## 混合判定器合理形态（要点）

1. **第一层 规则短路**: 同话题关键词/文件路径/工具白名单直接判"在范围内"（照抄 CC auto mode Tier 1-2 思路）。
2. **第二层 小模型语义判定**: cross-encoder/NLI（premise=新消息，hypothesis=当前任务目标陈述）输出 entailment 分数；分数带打印给评委。
3. **第三层 置信度门控**: 高分放行、低分 handoff、中间灰区升级主模型仲裁（照抄 CC 两阶段思路，成本只在灰区产生）。
4. **reasoning-blind 原则**: 判定输入只取用户原始消息+目标声明，不采信 agent 自己的解释。
5. **可解释性**: 每条判定输出 `{层, 输入摘要, 分数, 阈值, 决定}` 结构化日志，天然满足"打印给评委看"。
