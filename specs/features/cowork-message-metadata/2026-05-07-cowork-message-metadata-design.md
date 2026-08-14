# Cowork 消息元数据展示设计与迁移规范

> 修订日期：2026-08-14
>
> LobsterAI 基线：当前功能分支
>
> OpenClaw 基线：`v2026.6.1`
>
> 状态：实现完成，自动化发布门禁已通过，待 Electron 实际会话联调

本文取代 2026-05 初版设计草稿，描述当前代码的真实行为、从旧实现保留的回归约束，以及 OpenClaw `v2026.4.14` 升级到 `v2026.6.1` 后的兼容策略。

## 1. 目标与范围

在最终 assistant 消息的现有 footer 中展示并持久化以下元数据：

| 能力 | 当前行为 |
| --- | --- |
| Input tokens | 展示为 `↑29.6k`；值为 0 也展示 |
| Output tokens | 展示为 `↓647`；值为 0 也展示 |
| Cache read | 展示为 `R59.4k`；仅大于 0 时展示 |
| Cache write | 解析、持久化并参与 ctx 计算；不展示 `W` |
| Context usage | 展示为 `23% ctx` |
| Model | 展示去掉 provider 前缀后的 model id |
| Timestamp | 保留当前完整日期时间展示 |
| Agent name | metadata 兼容字段保留；UI 明确不展示 |

不在本次范围内：

- cost/费用展示；
- `totalTokens` 的 UI 或持久化；
- cache write 的 `W` 视觉项；
- 纯 `MEDIA` 图片回复的 footer。该路径当前直接渲染 `MediaImageInline`，不经过 `AssistantMessageItem`。

不需要 SQLite schema migration。主/IM/cron/物化子会话继续写入既有
`cowork_messages.metadata` JSON；子代理详情面板继续写入既有
`subagent_messages.metadata` JSON。覆盖安装时不新增列、不重建消息表。

## 2. 语义边界

LobsterAI 在主进程按当前 user turn 聚合 assistant API call usage，再把快照附着到该 turn 最后一个可见 Cowork assistant message：

- input、output、cacheRead、cacheWrite 分别饱和求和；
- ctx 分子取各 call 的最大 `input + cacheRead + cacheWrite`，不能把 prompt 相加；
- 无可见文本的 tool-call-only assistant 参与聚合，但不改变消息/工具拓扑；
- model 取本 turn 最后一个非 `gateway-injected` 值；
- renderer 不再做二次求和，只展示最终消息上已经聚合的 metadata。

这与 OpenClaw `v2026.6.1` Control UI `grouped-render` 的 usage 规则一致：

- 分别累加 input、output、cacheRead、cacheWrite；
- ctx% 使用各 assistant API call 中最大的 prompt snapshot，而不是累计 prompt。

公式如下：

```text
singlePromptTokens = input + cacheRead + cacheWrite

Lobster/OpenClaw grouped ctx% =
  min(round(max(each assistant call singlePromptTokens)
            / contextTokens * 100), 100)
```

`output` 不进入 ctx 分子。聚合边界是用户可见的 Cowork 逻辑 turn，通常由
原始 history user message 划分。以下 LobsterAI 已确认属于同一 active turn 的内部
continuation 是唯一例外：完整且精确匹配的两种 Plan Mode recovery prompt，以及
本轮 `sessions.queueSteer` 已确认接受、无 transcript idempotency key 的 steer 文本。
这些内部 user record 在相关性校验和 usage 聚合前透明移除；普通用户输入即使拥有相同
前缀也不能被误删。

聚合结果只装饰逻辑 turn 的最后一个可见 assistant；较早 assistant 不挂 usage/model，
消息正文与 assistant/tool 拓扑保持不变。若最新执行仍 active，则最新可见 assistant
明确保持 `isStreaming: true/isFinal: false`，并移除 usage/context，直到 terminal history
再次回填；已经关闭的较早 turn 不受影响。

OpenClaw history 同时受条数和约 6 MiB JSON byte cap 约束，响应不提供可靠的
`truncated/hasMore` 标记。因此“数组长度小于请求 limit”不能证明 history 完整。
正常 50 条窗口缺少本轮强关联键时最多再请求一次 200 条窗口；只有找到
`${runId}:user` user idempotency key 或对应 `${runId}` final assistant key，才允许对
窗口中部的超长 turn 生成 bounded partial aggregate。仍无法证明归属时安全省略 footer，
不能凭相同文案、数组长度或 user 计数猜测。

## 3. OpenClaw v6 数据契约

### 3.1 数据源优先级

1. 机会性实时数据：`chat.final.payload.message.usage/model`；
2. 兼容源：`chat.final.payload.usage/model`；message 与顶层 usage 按 canonical 字段逐项合并，message 中缺失的字段可由顶层补齐；
3. 常规权威源：`chat.history` 中的 assistant message；
4. 上下文窗口：只在最新、已关闭的目标 turn 与 `sessionInfo` 的 provider/model identity
   完全一致时使用 `chat.history.sessionInfo.contextTokens`；缺失时可对同一 identity 做定向
   `sessions.list`，最后使用 provider-aware model catalog；旧 turn、active turn 或 identity
   无法证明一致时不借用当前 session 状态。

OpenClaw 两个版本的成功 `chat.final` schema 都允许 usage，但标准 server-chat 成功事件通常只发送文本与时间戳，并不保证发送 usage/model。因此 direct-final 只能作为低延迟快路径，`chat.history` 仍是正常恢复来源。

`v2026.6.1` 的 `chat.history` 新增 `sessionInfo`，其中包含 `contextTokens`、
`modelProvider/model`、active 状态等 session 信息。同一响应通常可以提供 ctx 分母，
不再需要额外的 `sessions.list` RPC。`hasActiveRun` 不是所有 IM/cron/subagent 执行的
唯一真值，因此还要合并 `hasActiveSubagentRun`、`status`、`subagentRunState`、本地
active turn 和新鲜 channel lifecycle；显式 terminal subagent state 优先于陈旧
`status: running`。

model identity 使用 canonical `provider/model` 比较。带显式 provider 时，model id
自身包含 `/`（例如 `openrouter + google/gemini-*`）必须完整保留。provider 已知的一侧
不能与 provider 缺失或不同的一侧视为兼容；不确定时省略 ctx%，不能借当前模型窗口。
direct-final 只使用该 provider-aware 本地 catalog，不读取可变的 session numeric cache；
history 回填再使用经过同响应 identity 校验的权威分母。

model 为 `gateway-injected` 时视为占位值并丢弃。

### 3.2 usage 字段归一化

所有实时、history、IM reconcile 和 cron 路径共用同一套 canonical 语义。表中一部分 provider/llama/nested 字段只可能出现在 direct payload；`chat.history` 的 sanitizer 只保留其协议定义的 scalar subset：

| 语义 | 支持字段 |
| --- | --- |
| Input | `input`, `inputTokens`, `input_tokens`, `promptTokens`, `prompt_tokens`, `prompt_n`, `timings.prompt_n` |
| Output | `output`, `outputTokens`, `output_tokens`, `completionTokens`, `completion_tokens`, `predicted_n`, `timings.predicted_n` |
| Cache read | `cacheRead`, `cacheReadTokens`, `cache_read`, `cache_read_input_tokens`, `cached_tokens`, `input_tokens_details.cached_tokens`, `prompt_tokens_details.cached_tokens` |
| Cache write | `cacheWrite`, `cacheWriteTokens`, `cache_write`, `cache_creation_input_tokens` |
| Total | `total`, `totalTokens`, `total_tokens` |

数值规则：

- 只接受 finite number；
- 负数归零；
- 小数截断；
- 最大值限制为 `Number.MAX_SAFE_INTEGER`；
- 0 必须保留，不能通过 truthy 判断丢失。

Provider cache 语义必须区分：

- Anthropic 风格的 `input_tokens` 是非缓存 input，prompt 需要再加 cacheRead/cacheWrite；
- 只有出现 `cached_tokens`、`input_tokens_details.cached_tokens` 或 `prompt_tokens_details.cached_tokens` 时，输入字段才按 OpenAI 风格的总 prompt 处理，并减去 cached tokens，避免 cache read 被计算两次。

示例：

```text
input_tokens = 80,000
cache_read_input_tokens = 20,000
cache_creation_input_tokens = 2,000

singlePromptTokens = 80,000 + 20,000 + 2,000 = 102,000
```

```text
prompt_tokens = 80,000
prompt_tokens_details.cached_tokens = 20,000

normalized input = 60,000
singlePromptTokens = 60,000 + 20,000 = 80,000
```

`message.usage.total*` 表示单次 API usage 总量，通常包含 output；`sessions.list.totalTokens` 表示 session prompt/context snapshot。两者不能混用，也都不用于消息 ctx 分子。

### 3.3 contextTokens 来源

消息级 ctx 分母按以下安全顺序解析：

1. 最新 closed turn 的 target provider/model 与同一次
   `chat.history.sessionInfo.modelProvider/model` 完全一致时，使用其 `contextTokens`；
2. sessionInfo 缺分母但 identity 已知且仍一致时，使用
   `sessions.list({ search: sessionKey, limit: 5 })` 精确 row，并再次校验 identity；
3. 使用本地 `models.json`/model catalog 的 canonical provider/model context window；
4. provider 未知时，只有 bare model 在 catalog 中唯一时才允许 fallback，否则省略。

`sessionContextTokensCache` 仍服务实时 session context 指示和无历史身份歧义的路径；
它只存 number，因此历史消息不能仅凭该缓存借分母。active turn、切模后的旧回复、
provider/model 不匹配以及 target model 未知时，禁止使用当前 cache/sessionInfo/sessions.list。

旧实现的 `sessions.list({ activeMinutes: 60, limit: 50 })` 可能在 session 较多时漏掉目标会话，已不再使用。

若无法解析 contextTokens，只省略 ctx%；input/output/cache/model 仍正常展示。

`sessionContextTokensCache` 是最多 400 项的进程内有界 LRU。一次性的 cron `:run:` key
不写入长期缓存；模型 patch/override 成功、gateway 停止或重连、Cowork session 删除时
必须失效。全局 cache generation 与 gateway generation 让旧 RPC 结果失效；若无关 session
恰在 enrichment 中途触发 generation 变化，最多沿既有 1s/3s 有限链重试，不永久保留
token/map。gateway 停止时同时清除 model catalog 两张 map（canonical 与唯一 bare），
避免运行时配置更新后继续使用旧窗口。

## 4. 主进程数据流

### 4.1 Managed 实时路径

`chat.final` 到达后：

1. 确定本轮最终可见 assistant message；
2. 规范化 message-level usage，兼容顶层 usage；
3. 过滤占位 model；
4. 若存在可展示 usage，先立即用单 call metadata 补齐尚未存在的字段，保证低延迟；若 IM/cron reconcile 已写入权威聚合，direct-final 不得降级覆盖；
5. 无论 direct payload 是否已有 usage，都会延迟读取 `chat.history`，用 authoritative turn aggregate 覆盖；
6. direct-final 只可用 provider-aware catalog 形成低延迟 ctx；history 回填用经过
   target/session identity 校验的 contextTokens 重新计算权威 contextPercent。

如果整个生命周期没有收到 `chat.final`，lifecycle completion fallback 在 history 同步后执行相同的 usage enrichment。

### 4.2 History fallback 与有限重试

常规 final fallback 首次等待 2 秒，让 transcript 完成落盘。若 history 尚无 usage，再按 1 秒、3 秒进行有限重试。

同一 `sessionId + assistantMessageId` 的 enrichment timer 必须合并为单条有限重试链；
每次链使用 Symbol epoch，重复 final 可以 supersede 已在途的旧 history，旧响应在任何
await 后和 SQLite 写前都必须复核 token。成功、重试耗尽、gateway stop 或 session delete
都会清理 timer/token；删除期间迟到的空 history 也不能复活 retry。timer 使用 `unref`，
不会阻止 Electron 主进程退出。

必须同时满足以下条件才允许写入：

- history 目标 turn 存在最后一个可见 assistant，且不是 heartbeat 或 `NO_REPLY`；
- 目标 message ID 仍然存在；
- 目标仍是本地最后一条可见 assistant；
- 平台规范化后的本地文本与 history 文本一致；本地多出的 suffix 必须精确等于同一
  history 窗口中 `message` tool 的已发送路径生成的链接（兼容 macOS、Windows、UNC、
  `~` 与相对路径），任意 HTTP/Markdown 链接不能放宽相关性；
- 延迟期间不得通过 stale-ID fallback 改写到更新的一轮。

生产 managed turn 优先使用 `chat.send` 写入 transcript 的 `${runId}:user`，并兼容
标准 injected final assistant 的 `${runId}` 作为强关联键。普通 50 条窗口满且缺强键时
最多扩到 200；OpenClaw 的 byte cap 可能让扩展结果少于 200，因此“少于 limit”仍不能
当作完整。强键仍缺失或不匹配时安全省略，不使用相同 user/assistant 文案或全局 ordinal
猜测。没有 run key 的兼容调用只允许在非满 tail 上使用严格文本/anchor fallback。

只允许聚合同一用户可见逻辑 turn 内的 assistant usage；完整 Plan recovery prompt 与
本轮已确认 accepted steer 是前述透明 continuation，其他 user 永远不能跨越。若最终
可见 assistant 自身 usage 尚未落盘，即使前面的 tool call 已有 usage，也必须继续有限
重试，避免永久保存 partial aggregate。最后 raw assistant 仍是空的 tool-only record 时
重试；纯 heartbeat/`NO_REPLY` turn 则停止，不能回退到上一轮。

direct-final 的 stale-ID 兼容仍保留：如果 reconcile 已在 final 处理前替换了 message ID，可以在任何异步 RPC 发生前解析一次当前最终 assistant；一旦开始异步读取 context window，若该目标又被删除，则停止写入，不能再次回退到新消息。

如果旧 timer 执行时本地已经出现下一条 user，而 gateway history 也已经出现下一轮 assistant，则立即停止；即使两轮回复文本完全相同也不能靠文本相等把新 usage 写回旧消息。若 history 最新 turn 仍只有 user、尚无 assistant，则可以继续给明确的上一轮 assistant 回填，但不能借用新 turn 的 sessionInfo model/context。

整会话 history reconcile 使用另一组仅在途 Symbol token，key 为
`sessionId + sessionKey`：同一来源 latest-wins，防止旧 response 覆盖新 response；同一个
Cowork session 下不同 cron `:run:` key 互不取消，保证并发 run 都能导入。gateway stop
清空全部 token，session delete 按 session 前缀失效，迟到 response 不写库、不通知 renderer。

### 4.3 Metadata merge

`CoworkStore.updateMessage()` 对 metadata JSON 是整体替换，因此 usage 写入前必须显式 merge：

```ts
metadata: {
  ...existingMetadata,
  isStreaming: false,
  isFinal: true,
  usage: {
    ...existingMetadata.usage,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  },
  contextPercent,
  model,
}
```

根 metadata 与内层 usage 都要 merge，避免重启后丢失 `skillIds`、媒体、plan、截断标记等既有字段。更新持久化后通过 `messageUpdate` 通知 renderer。

replacement 不能按全会话 role/text 反向搜索 metadata 或 timestamp。相同的 `继续/OK`
可能出现在多个 user turn；只有 user anchor 对齐唯一时，才在同一逻辑 turn 内按位置、
精确内容或 assistant tail ordinal 承接本地字段。文案被 history 修正、同时新增 tool
拓扑时也要保留同 turn 的本地字段；prefix/suffix 同时命中且无法消歧时安全省略 merge。
该对齐是线性、仅作用于 authoritative bounded tail，不能随本地长历史形成平方或立方扫描。

authoritative latest turn 仍 active 时，merge 必须强制
`isStreaming: true/isFinal: false`，并删除本地遗留的 `usage/contextPercent`；完成 history
则强制 `isStreaming: false/isFinal: true`。不能让旧 partial metadata 在重启或异常 terminal
路径中重新显示。

写入前比较完整 metadata；内容相同的 direct/history 结果不重复写 SQLite 或发送 IPC，避免低延迟快路径与权威回填造成无意义的写放大。

### 4.4 IM/channel reconcile

`chat.history` authoritative assistant entry 可携带：

- input/output/cacheRead/cacheWrite；
- model；
- 最新 turn 可基于 sessionInfo、session cache、定向 sessions.list 或 model fallback 计算 contextPercent；
- gateway timestamp。

文本已同步时，fast path 与 tail-alignment path 仍要执行 metadata-only enrichment，不能因为 role/text 相同就提前返回。metadata-only 更新必须保留本地其他字段并通知 renderer。

history 已证明消息完成时，metadata-only 更新必须同时写入 `isStreaming: false`、`isFinal: true`，避免 renderer 把旧安装或导入消息误判为新的 running turn。只更新 metadata 时，`messageUpdate` 必须携带本地原始正文，不能用为匹配而 trim/规范化后的文本覆盖 Redux 内容。

`sessionInfo.contextTokens` 只描述当前 session/model，因此只给 history 窗口中的最新 assistant turn 计算 ctx；不能用当前窗口给所有旧 turn 反算百分比。旧 turn 没有已持久化 ctx 时宁可省略。

借用 `sessionInfo`、numeric cache 或定向 `sessions.list` 前，目标 transcript assistant 的
provider/model 必须与当前 session identity 完全一致；目标 identity 缺失、provider 缺失、
切模后不一致或 latest turn active 时，只能使用无歧义的静态 catalog fallback，否则省略
ctx。native IM 的 active 状态还要合并新鲜 lifecycle 与本地 active turn，不能仅依赖
`hasActiveRun`。

发生 replacement 时，authoritative metadata 和 timestamp 随 entry 写入；本地字段与
timestamp 只按上节同 turn 对齐承接。较早、未在 history window 内的本地前缀按现有
reconciliation 规则保留。同一 `sessionId + sessionKey` 的并发 history 采用 latest-wins
Symbol token；会话删除或 gateway 重启后的迟到响应不得写库或发 IPC。

本地非空而 bounded authoritative window 只有 assistant、既无 user anchor 又无精确
entry suffix overlap 时，不得把它当全量 history 做 replacement；必须保留现有本地历史，
等待后续可验证窗口，避免一个超长 turn 的无锚 tail 删除整段会话。

### 4.5 Cron/scheduled run history

Cron history builder 使用相同 usage normalizer，并携带 cacheRead/cacheWrite/model/contextPercent/timestamp。

- 匹配到已有本地 message：深合并 metadata 并发送 `messageUpdate`；
- 已带 `openclawCronRunSessionKey + openclawCronRunEntryIndex` 的 entry 优先用稳定索引匹配，
  history 修正文案时也不会重复追加；
- 首次未打标导入仅在 user anchor、role topology 和位置能唯一证明属于该 run 时允许
  partial assistant 被 authoritative final 替换；重复正文、已有其他 run 或无法区分的
  follow-up 不得凭全局唯一文本认领；
- 已存在旧 run 时，本轮尚未打标的 realtime partial 只可通过仍 active 且 sessionKey
  完全相同的 ActiveTurn 精确 assistant ID，以及本轮成功 prefetch 明确记录的 user ID
  认领；不能向前猜测普通 follow-up。若 gateway user 仍未同步，则按 authoritative timestamp
  插入到该 assistant 前，再修正强绑定的 partial；
- IPC 继续发送本地原始正文，并按 authoritative active/final 状态清理或补齐 metadata；
- 未匹配：使用 gateway timestamp 新增 message；
- 已导入同一 run 不能直接整体 early-return，否则迟到的 usage 永远无法回填；
- 不删除、改写或错误打标用户在 scheduled run 后追加的 follow-up conversation；
- 同一个 Cowork session 的不同 `:run:` sessionKey 可并发导入，不能互相 supersede；
- run-scoped key 不进入长期 context cache；sessionInfo 缺分母时只做一次 provider/model
  精确的定向查询，再走 catalog fallback。

### 4.6 子代理历史

子代理有两条展示链路，必须共享相同的 turn usage、active 与 provider/model 语义：

1. `SubagentTracker` 为子代理详情面板读取 `chat.history` 并写既有
   `subagent_messages.metadata`；
2. `syncSubagentChildHistory` 把子代理 history 物化到 Cowork child session 的
   `cowork_messages.metadata`。

latest subagent execution active 时，最后可见 assistant 只能是
`isStreaming: true/isFinal: false`，不得持久化 partial usage/context。active 判定合并
`hasActiveRun`、`hasActiveSubagentRun`、`subagentRunState/status` 与本地 running 状态，
但显式 `historical/interrupted/done/failed/killed/timeout` 优先终止陈旧 running 信号。

bounded child history 必须先按规范化 user anchor 做唯一 prefix/suffix 对齐，保留窗口外
本地前缀，再仅在同一逻辑 turn 内承接 root metadata；文案修正和新增 tool topology
不能丢 `skillIds` 等字段，也不能把旧轮同文 assistant 的 usage 搬到新轮。无法唯一对齐时
保留原数据并安全省略 enrichment。

每个 subagent run 的 history fetch 使用 latest-wins Symbol token。删除 run、删除 parent
session、gateway client 替换或同 run 新请求都会让旧响应失效；迟到响应不得复活内存缓存
或写入无外键约束的孤儿 `subagent_messages`。

### 4.7 时间戳

- chat delta/final 路径使用 gateway message timestamp；
- agent assistant stream 先于 chat.delta 到达时，使用 agent event 顶层 `ts`；
- history 兼容 numeric/string timestamp，以及 `createdAt`、`created_at`、`time`；
- 无有效 gateway timestamp 时才退回本地创建时间。

## 5. 数据模型与存储

Main 与 renderer 的 metadata 类型保持一致：

```ts
interface CoworkMessageMetadata {
  isStreaming?: boolean;
  isFinal?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  contextPercent?: number;
  model?: string;
  agentName?: string; // 兼容字段，不展示
  [key: string]: unknown;
}
```

存储 `contextPercent`，不存储计算时的 contextTokens。它代表消息完成或首次 history 回填时的快照。

新写入的 model 使用 canonical `provider/model-id` ref；model id 自身包含 `/` 时完整保留，
renderer 只移除最前面的 provider segment。旧 metadata 没有 provider 信息时继续走历史
label 兼容，不做破坏性重写。

旧 Cowork 历史消息没有这些字段时继续正常显示原内容、时间和 model，不需要离线数据
迁移。旧 `subagent_messages` 在首次打开 completed run 时做一次 lazy metadata backfill：

- 以现有行及其 ID、timestamp、root metadata 为基准，仅对唯一对齐的 final assistant 做
  事务内 metadata-only `UPDATE`；
- gateway 的 100 条 bounded snapshot 不能 `DELETE + replace`，窗口外的旧行和本地字段
  必须保留；
- authoritative usage 真正到达后才写
  `openclawUsageMetadataBackfillVersion: 1`，lagging transcript 不永久标记完成；
- 同一进程的 attempted set 最多 400 项，避免不支持 usage 的 provider 每次轮询重复 RPC；
- 旧行 JSON 损坏时记录 warning 并忽略该 metadata，不阻断消息读取；
- 不新增列、不重建表，故 macOS/Windows 覆盖安装继续使用现有 SQLite 文件。

## 6. Renderer 行为

展示位置是当前 `AssistantMessageItem` footer，不恢复旧 `CoworkSessionDetail` 中已经过时的 JSX。

显示顺序：

```text
goal → YYYY/MM/DD HH:mm → ↑input → ↓output → RcacheRead
     → N% ctx → model → fork/copy
```

规则：

- 普通文本、纯 `<proposed_plan>` 和“说明文字 + `<proposed_plan>`”共用同一个 footer，
  最多渲染一次；混合内容的 footer 必须位于整个 plan card 之后；
- input/output 为 0 时展示；
- cacheRead 为 0 时隐藏；
- contextPercent 为 0 时展示，超过 100 时 clamp 到 100；
- 非 finite 或负的持久化展示值被忽略；
- `< 75%` 使用高对比默认 secondary 色；`75–89%` 使用 `text-amber-700 dark:text-amber-300`；`>= 90%` 使用 `text-red-700 dark:text-red-300`；
- `isStreaming === true` 或 `isFinal === false` 时不展示 usage；
- 为兼容旧历史，`isFinal` 缺失但存在有效 usage 时可以展示；
- 有 usage/context 时 footer 常显；只有时间/model 时仍依赖 hover/focus；goal completion 也会让 footer 常显；
- fork/copy 始终只在 hover/focus 时出现并可聚焦；
- 当前 streaming turn 由 `showCopyButton=false` 整体隐藏 footer，已经完成的历史 turn 不受新 turn streaming 影响；
- footer 保留 `data-cowork-search-exclude`，token/model 不参与会话全文搜索；
- agentName 不展示；cacheWrite 不展示；
- model 使用现有 label helper 去掉 provider 前缀。

footer 使用 `min-w-0/max-w-full/flex-wrap`；时间与各统计项作为不可拆分原子在字段之间换行，任意长度 model 可收缩并截断，完整值保留在 `title` 与可访问文本中。该布局须覆盖主会话宽度以及约 180px 的 artifact/subagent 窄面板，不能造成水平溢出。

紧凑符号及其完整读屏文本都通过中英文 i18n：视觉文本设置 `aria-hidden`，相邻 `sr-only` 文本说明 input/output/cache/context 的完整语义。

Renderer 只在 final message 的 usage/context/model metadata 到达 IPC/Redux 边界时记录 debug 诊断：包含 session/message id、已有字段名和 model，不包含消息正文或 token 数值。日志持久化是 best-effort，异常不得阻断 Redux 更新；streaming chunk 不分配诊断字段数组，也不逐块记录日志。

纯 `MEDIA` 图片 assistant 目前绕过 `AssistantMessageItem`，因此没有 footer。这是既有 renderer 分支的明确例外，不在本次迁移中改变。

## 7. 旧实现与回归约束

旧分支名为 `liuzhq/message-ctx`，远端分支已删除；可恢复的 PR head 包括 #1912、#1927、#1932。功能曾短暂进入 `release/2026.05.08`，后由 `053f6365` 删除；正式 tag `2026.5.9` 已包含删除提交。

迁移必须保留以下历史修复：

| 提交 | 回归约束 |
| --- | --- |
| `1e99ab2b` | input/output/model/footer 与 spec 初版 |
| `f0e34fef` | metadata 迟到时仍更新最终 assistant；服务端时间 |
| `9eb30bcf` | direct-final/history race、IM history、不能跨 turn 错借 usage |
| `11fa652e` | 新 turn streaming 不隐藏已完成历史 turn footer |
| `e2e46c3f` | cacheRead/context 元数据 |
| `c16014db` | sessions.list contextTokens 与 gateway timestamp |
| `c1008a49` | fork/copy 位于 metadata 之后并保持 hover 行为 |
| `157e3094` | cacheRead 为 0 时不显示 `R0` |
| `fe77062e` | agentName 不展示；不得复制该快照的双时间戳 bug |
| `8af4f88e`, `462b8488` | IM timestamp 与 hover/focus 离开后不粘住 |
| `6697f1c4`, `941da713` | stale ID、`NO_REPLY`、迟到 backfill 状态 |
| `c97deb57` | 手动停止的 partial assistant 仍 final 并保留 model |

## 8. 自动化测试

### Main/OpenClaw

- `openclawHistory.test.ts`
  - canonical 与 v6 aliases；
  - Anthropic/OpenAI cache 语义；
  - tool-loop 求和、最大单 call prompt、tool-only assistant；
  - target call usage 迟到时不持久化 partial aggregate；
  - heartbeat/`NO_REPLY` usage 不污染可见回复；
  - cache-aware ctx、0、cap 100；
  - 非法值；
  - `gateway-injected` model 过滤；
  - history timestamp 与 cache fields。
- `openclawRuntimeAdapter.test.ts`
  - direct usage metadata merge 与 stale ID；
  - `sessionInfo.contextTokens`；
  - managed tool-loop turn 聚合；
  - history lag 有限重试；
  - 快速下一 turn 不串写；
  - 相同回复文本与 user-only 尾项的 sessionInfo 隔离；
  - direct-final 不降级 IM/cron 已有聚合；
  - IM fast-path metadata-only enrichment；
  - metadata-only enrichment 保持 final 状态和本地原始正文；
  - contextTokens 缓存在模型变更、gateway stop、session delete 后失效；
  - cache 容量上限与 cron run key 排除；
  - provider/model 精确 identity、同名跨 provider catalog 隔离与切模竞态；
  - direct-final catalog-only，history sessionInfo/sessions.list 只在 identity 一致时使用；
  - 50→200 单次扩窗、6 MiB byte truncation、user/final idempotency 强关联；
  - exact Plan recovery、accepted steer、goal wrapper 与 message-tool file suffix 相关性；
  - usage timer 合并、逆序 response、generation 隔离、删除与重试 token 清理；
  - history sync `(sessionId, sessionKey)` latest-wins，不同 cron run 并发互不取消；
  - active IM/cron/subagent 最新回复不持久化 partial usage；
  - agent event 顶层 `ts`；
  - 既有 silent reply、stop stream、reconcile 回归。
- `openclawConversationReconciliation.test.ts`
  - 同文 assistant metadata/timestamp 不跨 user turn；
  - authoritative 文案修正仍保留同 turn 本地字段；
  - 重复 anchor 歧义时安全省略；
  - active authoritative reply 清除旧 partial usage/context。
  - assistant-only bounded tail 无锚且无 suffix overlap 时不做破坏性 replacement。
- `openclawCronRunHistorySync.test.ts`
  - cron usage/model/context/timestamp；
  - 匹配文本规范化与 renderer 原始正文分离；
  - stable entry index、首次 partial→final 与重复/follow-up 歧义保护。
- `subagent/historyParser.test.ts`、`childHistorySync.test.ts`、`tracker.test.ts`
  - tool-loop usage/context/model 与 final-call completeness；
  - active latest turn 抑制 footer；
  - bounded tail user-turn 对齐、文案/tool topology 修正与本地 metadata 保留；
  - 旧 JSON metadata-only lazy backfill、版本标记、>100 行保留与损坏 JSON 容错；
  - 同 run 乱序 fetch latest-wins，run/parent delete 后迟到响应不复活。

### Renderer

- `messageUsageDisplay.test.ts`
  - 0 值与 `R0`；
  - 75/90 阈值；
  - streaming/non-final；
  - 非法值与 clamp。
- `AssistantMessageItem.test.ts`
  - 完整 footer 的顺序与单次渲染；
  - agentName 隐藏与 model 缩写；
  - stats 常显；
  - streaming gate；
  - 纯 plan 与混合 text+plan 只显示一次，且 footer 位于完整 plan 后；
  - canonical provider 只剥一层，nested model id 不被截断。
- `tokenFormat.test.ts`
  - k/M 视觉格式、完整 token 可访问格式和完整时间格式。
- `coworkMessageMetadataDiagnostics.test.ts`
  - renderer debug 日志不包含正文/token 数值；
  - 日志持久化失败不阻断 Redux/stream listener。

## 9. 手动验收

至少验证：

1. Managed 普通回复，footer 顺序、hover actions 与完整时间正确；
2. 高 cache 示例 `1 + 438400 + 307`、窗口 1M，ctx 显示 `44%`；
3. cacheRead 为 0 时无 `R0`；
4. plan-only 与说明文字 + plan 均只有一个 footer；
5. 新一轮 streaming 时旧回复 footer 保持可见，当前回复完成前不显示；
6. 应用重启后 metadata 仍在；
7. IM/channel 收发及 history replacement 后 input/output/cache/model/context 不丢；
8. IM/cron/subagent 运行中的 progress reply 不提前显示 footer，terminal 后才回填；
9. scheduled run history 回填与已有 follow-up conversation 共存，首次 partial 不重复；
10. 老版本已持久化的 subagent run 首次打开只补 metadata，重启后不重复 RPC，且 >100
    条旧历史不丢失；
11. 删除 subagent/session 或重连时，迟到响应不会复活消息；
12. 手动 stop 的 partial assistant 保留当前 model，不伪造 token；
13. 中英文、浅色/深色、窄宽度换行和键盘 focus 行为；
14. classic-light/classic-dark 下主会话与约 180px 窄面板中，长 model 不溢出且 11px footer 对比度可读。

## 10. 当前文件地图

- `src/main/libs/openclawHistory.ts`
- `src/main/libs/agentEngine/openclawConversationReconciliation.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/openclawCronRunHistorySync.ts`
- `src/main/libs/agentEngine/subagent/historyParser.ts`
- `src/main/libs/agentEngine/subagent/childHistorySync.ts`
- `src/main/libs/agentEngine/subagent/tracker.ts`
- `src/main/coworkStore.ts`
- `src/main/subagentMessageStore.ts`
- `src/renderer/types/cowork.ts`
- `src/renderer/components/cowork/AssistantMessageItem.tsx`
- `src/renderer/components/cowork/AssistantTurnBlock.tsx`
- `src/renderer/components/cowork/messageUsageDisplay.ts`
- `src/renderer/utils/tokenFormat.ts`
- `src/renderer/services/i18n.ts`
- `src/renderer/services/cowork.ts`

## 11. 已知限制

- bounded history 若从 turn 中间开始，只有当前 ActiveTurn 的 user/final idempotency 强键能
  证明归属时才展示窗口内 partial aggregate；普通 50 条窗口最多扩到 200 一次，仍无强键
  时安全省略。OpenClaw 的 6 MiB byte cap 没有完整性标记，不能靠 response length 推断；
- 本次变更前已经持久化、且之后未被 history 回填的旧 `contextPercent` 不做不可逆离线重算；因历史记录未保存当时的 context window/cacheWrite，它可能继续反映旧版 input-only 公式，保留原快照比猜测分母更安全；
- 很旧的历史消息首次回填 ctx 时，若无法证明其 provider/model 与 session 窗口一致，则
  只用唯一静态 catalog 候选或省略 ctx%，不会用当前模型窗口做近似值；
- 新 provider 引入未知 usage 字段时，需要同步更新 canonical normalizer；
- total-only usage 没有可展示 breakdown；
- 纯 `MEDIA` 图片回复没有 footer。
