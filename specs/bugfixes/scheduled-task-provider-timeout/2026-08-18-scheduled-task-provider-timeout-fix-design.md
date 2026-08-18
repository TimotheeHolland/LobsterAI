# 定时任务外部模型空闲超时修复汇总

## 1. 问题与根因

用户反馈复杂定时任务经常失败，日志中同一类 Cron 任务多次以
`model idle timeout` 结束：

- 定时任务正常触发，失败发生在 Agent 执行阶段，不是调度器漏触发。
- 失败任务使用 DeepSeek 等外部 provider，执行复杂情报检索、历史读取、去重和长报告生成。
- LobsterAI 只为 `lobsterai-server` 写入了显式 provider `timeoutSeconds`，外部 provider
  未写入该配置，因而回落到 OpenClaw 默认约 4 分钟的模型空闲超时。
- 当长任务在单次模型请求中超过默认空闲窗口仍未产出响应时，OpenClaw 将该次 Cron run
  标记为失败，并累加连续失败次数。

该问题影响长耗时、长输出的定时任务稳定性，不涉及 Cron 触发时间、任务存储、运行历史或
IM 投递路由。

## 2. 修复方案

- 增加外部 provider 默认模型空闲超时常量 `OPENCLAW_DEFAULT_MODEL_TIMEOUT_SECONDS`，当前值为
  `600` 秒。
- 在 OpenClaw 配置生成时，为所有 provider 写入 `timeoutSeconds`：
  - `lobsterai-server` 继续使用既有的 `330` 秒保护；
  - 其他外部 provider 使用新的 `600` 秒默认值。
- 保持 `agents.defaults.timeoutSeconds` 仍为 `3600` 秒，不放宽整个 Agent run 的上限。
- 不修改 Cron 调度、重试、禁用策略、运行状态映射或任务 payload schema。
- 测试覆盖生成后的 provider 配置，确保 DeepSeek 等外部 provider 会带上显式
  `timeoutSeconds`。

## 3. 兼容性与验收

- 已有 `lobsterai-server` 任务的模型空闲超时保持不变。
- 外部 provider 的长定时任务不应再因约 4 分钟默认 idle timeout 被过早截断。
- 外部 provider 如果真实卡死，最长等待时间从约 4 分钟增加到 10 分钟，但仍受 Agent run
  总超时保护。
- Cron 任务的触发时间、下一次运行时间、连续失败计数和运行历史展示保持原流程。
- `openclawConfigSync.runtime` 测试覆盖外部 provider timeout 输出；touched-file lint 和
  Electron main/preload TypeScript 编译应通过。
