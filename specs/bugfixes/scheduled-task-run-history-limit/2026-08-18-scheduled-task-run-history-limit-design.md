# LobsterAI 定时任务历史加载失败修复设计文档

## 1. 概述

### 1.1 问题

用户在桌面端进入定时任务的“历史”页时，页面显示“定时任务数据加载失败”，错误信息为：

```text
invalid cron.runs params: at /limit: must be <= 200
```

截图中的失败发生在定时任务全局运行历史加载路径。OpenClaw 网关的 `cron.runs` 接口限制单次请求 `limit <= 200`，但 LobsterAI 端侧服务在部分路径中会将调用方传入的可见条数直接作为网关请求条数，导致大于 200 的 `limit` 被透传给网关。

### 1.2 根因

- `CronJobService.listRuns()` 和 `CronJobService.listAllRuns()` 为了支持隐藏内部任务、状态过滤和日期过滤，会自行读取网关历史并在 LobsterAI 侧筛选。
- 原实现使用 `pageSize = Math.max(visibleLimit, 50)` 作为 `cron.runs.limit`。当调用方传入 `visibleLimit > 200` 时，单次网关请求越过 OpenClaw 的参数上限。
- IPC 和 renderer 没有足够的历史加载诊断日志，无法快速判断是 UI、IPC 还是服务层传入了异常分页参数。

## 2. 用户场景

### 场景 1：打开定时任务历史页

**Given** 用户已有定时任务运行记录

**When** 用户进入定时任务“历史”页

**Then** 页面正常加载最近运行记录，不因网关单次 limit 限制显示错误态

### 场景 2：历史记录超过 200 条

**Given** 用户或系统已有超过 200 条定时任务运行历史

**When** 端侧需要读取超过 200 条可见历史

**Then** LobsterAI 内部按网关限制拆成多次 `cron.runs` 请求，并合并为调用方需要的可见结果

### 场景 3：单任务运行历史超过 200 条

**Given** 某个定时任务已有超过 200 条运行历史

**When** 用户查看该任务详情中的运行历史

**Then** 单任务历史同样通过内部分页读取，不向网关发送非法 limit

### 场景 4：网关尚未准备好

**Given** OpenClaw 网关仍在启动或连接尚未完成

**When** renderer 请求定时任务历史

**Then** main 返回 `ready: false`，renderer 保持启动中状态，等待后续 refresh 后重载

### 场景 5：历史加载失败需要排查

**Given** 用户再次遇到定时任务历史加载失败

**When** 开发者查看 renderer DevTools 和主进程日志

**Then** 能看到 `limit`、`offset`、过滤条件、返回条数和错误信息，便于定位失败层级

## 3. 功能需求

### FR-1：网关请求 limit 上限保护

- 所有发往 OpenClaw `cron.runs` 的请求必须满足 `limit <= 200`。
- `listRuns()` 和 `listAllRuns()` 的调用方仍可请求超过 200 条可见结果。
- 大请求必须由 `CronJobService` 内部分页完成，不能要求 renderer 或 IPC 调用方理解网关上限。

### FR-2：分页参数规范化

- `limit` 和 `offset` 进入服务层后统一规范化为非负整数。
- 非数字、无穷大或小于等于 0 的 `limit` 不触发网关历史请求，直接返回空数组。
- 小于默认页大小的请求保持最小扫描页大小，避免因内部任务或过滤条件导致可见结果不足。

### FR-3：保留现有筛选语义

- 内部任务仍从全局历史中隐藏。
- 日期过滤继续通过网关 `startMs`/`endMs` 与 LobsterAI 侧过滤共同生效。
- 状态过滤继续在 LobsterAI 侧按应用状态执行，不向网关传入不支持或语义不一致的状态字段。
- `offset` 继续在内部任务隐藏和状态过滤之后按可见结果计算。

### FR-4：诊断日志

- Renderer 在全局历史加载开始、网关未就绪、成功、失败和异常时输出 debug/warn 日志。
- Main IPC 在全局历史和单任务历史请求、结果、失败时输出 debug/warn 日志。
- `CronJobService` 仅在调用方请求超过网关上限时输出 debug 日志，说明已进入内部拆页。
- 日志只包含低敏技术参数：`limit`、`offset`、过滤条件、返回条数和错误信息，不记录任务 prompt、摘要正文、Token 或 IM 内容。

### FR-5：自动化测试

测试至少覆盖：

- 全局历史请求 `limit > 200` 时拆成多个 `cron.runs` 请求，且每次请求 `limit <= 200`
- 单任务历史请求 `limit > 200` 时拆成多个 `cron.runs` 请求，且每次请求 `limit <= 200`
- 既有内部任务隐藏、过滤后 offset、状态过滤行为不回归
- 定时任务服务和 IPC 相关测试继续通过

## 4. 实现方案

### 4.1 服务层分页收口

在 `src/scheduledTask/cronJobService.ts` 中新增分页工具：

- `CRON_RUNS_MIN_PAGE_SIZE = 50`
- `CRON_RUNS_MAX_PAGE_SIZE = 200`
- `normalizeRunPageNumber()`
- `getGatewayRunPageSize()`
- `getGatewayRunRequestLimit()`

`listRuns()` 和 `listAllRuns()` 使用同一套工具计算网关请求页大小。调用方请求超过 200 条时，服务层循环发起多个 `cron.runs` 请求；每次请求不超过 200 条，最后一页按剩余需求收缩，避免额外读取。

### 4.2 保持调用协议不变

不修改 `ScheduledTaskIpc.ListRuns`、`ScheduledTaskIpc.ListAllRuns`、preload bridge 或 renderer 类型定义。现有 renderer 和 IPC 调用方继续使用原来的 `limit`、`offset`、`filter` 协议。

这样可以避免扩大兼容风险，并保证老版本本地数据、已创建任务和现有 UI 状态无需迁移。

### 4.3 Renderer 诊断

在 `src/renderer/services/scheduledTask.ts` 的 `loadAllRuns()` 中增加结构化日志：

- 请求开始：记录 `limit`、`offset`、是否初始加载、过滤条件
- 网关未就绪：记录请求参数
- 请求成功：记录返回条数和 `hasMore`
- 请求失败或异常：记录错误信息

这些日志进入 renderer 控制台，便于现场问题排查。

### 4.4 Main IPC 诊断

在 `src/main/ipcHandlers/scheduledTask/handlers.ts` 中为以下 IPC 增加结构化日志：

- `scheduledTask:listRuns`
- `scheduledTask:listAllRuns`

日志覆盖请求参数、返回条数、网关未就绪和异常错误。主进程日志可与 renderer 日志串联定位请求链路。

### 4.5 回归测试

在 `src/scheduledTask/cronJobService.test.ts` 中新增两条大 limit 回归测试：

- `listAllRuns(450, 0)` 拆成 `200, 200, 50`
- `listRuns('job-1', 450, 0)` 拆成 `200, 200, 50`

测试同时断言返回结果数量保持为调用方请求的 450 条，确认修复不是简单截断。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 调用方传入 `limit > 200` | 服务层内部拆页，每次请求网关不超过 200 |
| 调用方传入 `limit = 0` 或负数 | 规范化后直接返回空数组，不请求网关 |
| 调用方传入非整数 `limit` 或 `offset` | 向下取整并限制为非负数 |
| 调用方传入 `Infinity` 或 `NaN` | 规范化为 0，避免非法请求 |
| 历史中包含内部 memory-core 任务 | 全局历史继续隐藏内部任务 |
| 状态过滤后第一页可见结果不足 | 服务层继续读取后续网关页，直到满足可见 limit 或网关无更多数据 |
| 日期过滤存在 | 继续传递 `startMs`/`endMs` 给网关，并保留应用侧过滤 |
| 网关返回空 entries | 停止分页并返回已收集结果 |
| 网关返回数量小于本次请求 limit | 视为没有更多数据，停止分页 |
| OpenClaw 网关未就绪 | IPC 返回 `ready: false`，renderer 进入 starting 状态 |
| Windows 或 macOS | 逻辑为纯 TypeScript 数据处理，无平台差异 |
| 老用户覆盖安装 | 不涉及数据库、配置文件或任务数据迁移，现有任务和历史文件继续沿用 |

## 6. 非目标

本次不包含：

- 修改 OpenClaw 网关 `cron.runs` 的参数上限
- 改造定时任务 UI 分页大小或视觉样式
- 新增数据库表、迁移或清理历史数据
- 改变内部任务隐藏策略
- 改变定时任务创建、更新、删除、手动运行语义
- 新增远程 telemetry 或服务端指标接口

## 7. 验收标准

1. 打开定时任务“历史”页不再出现 `invalid cron.runs params: at /limit: must be <= 200`。
2. 全局历史和单任务历史在请求超过 200 条时能够继续分页读取，不截断为 200 条。
3. 发往 OpenClaw `cron.runs` 的每次请求 `limit` 均不超过 200。
4. 内部任务隐藏、状态过滤、日期过滤和可见 offset 行为不回归。
5. Renderer 和 main 日志能定位历史加载请求参数、返回条数、网关未就绪和失败原因。
6. 不引入数据库迁移、用户数据兼容风险、平台差异或 UI 分辨率适配变化。
7. 相关 Vitest、改动文件 ESLint、Electron TypeScript 编译和 renderer build 全部通过。
