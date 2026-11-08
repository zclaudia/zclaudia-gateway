# 连接容量与慢消费者验证报告

> 由 `scripts/capacity-verify.ts` 生成；按"复现命令"可在任意环境重跑。

## 结果性质（先读）

- 本报告数字是**单机、单进程（网关与全部 SDK 端点同进程回环）的一次采样**，用于相对比较与回归参考，**不是**对任何部署形态的容量承诺或 SLA。
- 唯一的**严格保证**来自实现内建的边界（每 Channel 4 MiB 高水位背压、消息尺寸上限、每 IP 控制连接限额、每 peer Channel 配额），由 CI 行为测试固定（`capacity-regression.test.ts`、`phase2-channels.test.ts`），与本报告的采样数字无关。
- 生产容量取决于部署硬件、TLS 终止、真实网络 RTT 与负载形态，应在目标环境用同一脚本复测。

## 测试条件

| 项 | 值 |
| --- | --- |
| 时间 | 2026-11-08T09:18:28.958Z |
| 运行环境 | darwin arm64 · Apple M2 Max · 12 cores |
| Node | v22.23.2 |
| 拓扑 | 3 Echo Backend × 6 设备 × 12 Channel（round-robin） |
| 负载 | 双向 echo，text（小 JSON）与 binary（64.0 KiB）交替，每 10 个 text 帧含 1 个 RTT 探测 |
| 持续负载时长 | 12 s（free-running 饱和发送） |
| 慢消费者 | 专用 Channel 的客户端 `pause()`，注入 32 MiB 后观察 3.0 s |
| 网关配置 | in-process、临时 SQLite；maxWsConnectionsPerIp=0（仅本脚本自身多连接）；每 Channel 高水位 4 MiB |

## 吞吐与延迟（采样）

| 指标 | 值 |
| --- | --- |
| 持续阶段 echo 完成消息数 | 74,752 msgs / 12.0 s |
| 持续阶段吞吐（回环确认口径） | 6215 msgs/s · 174.8 MiB/s |
| RTT p50 / p95 / p99 / max | 105.1 ms / 139.8 ms / 154.5 ms / 189.7 ms |

## 慢消费者隔离（行为证据）

| 观测 | 结果 |
| --- | --- |
| 暂停的消费者在 3.0 s 内停止接收 | 是（停滞，符合背压预期） |
| 停滞时该 Channel 积压（发送 − 已收） | 32.0 MiB（有界：受每 Channel 4 MiB 高水位约束） |
| 停滞窗口内其他 Channel 吞吐 | 5176 msgs/s（持续阶段均值的 83%） |
| resume 后积压排空 | 126 ms 内 32.0 MiB 全部送达（无死锁） |

## 连接与队列峰值（采样，经 /api/admin/overview 诊断计数）

| 指标 | 峰值 | 结束 |
| --- | --- | --- |
| 在线 peer（控制连接） | 10 | 0 |
| 跟踪中的 Channel | 13 | 0 |

## 内存趋势（采样，网关同进程）

| 指标 | 起点 | 峰值 | 结束 |
| --- | --- | --- | --- |
| RSS | 119.7 MiB | 285.1 MiB | 285.1 MiB |
| 堆已用 | 17.0 MiB | 20.5 MiB | 20.5 MiB |

采样点共 32 个（每 0.5 s 一个）。峰值与结束值受 V8 GC 时机影响，仅作趋势参考。

## 恢复验证（行为证据）

| 项 | 结果 |
| --- | --- |
| 取消/断线 churn（5 轮：连接 → 2 Channel → 主动取消 → 断开） | 35 ms 完成 |
| 全部端点关闭后资源回落 | 107 ms 内 channels=0、peers=0（轮询诊断计数确认） |

## 复现命令

```bash
pnpm capacity                                  # 默认参数（本报告）
pnpm capacity --duration-ms=60000 --devices=12 --backends=6 --channels-per-device=3 --slow-mib=64
pnpm capacity --out=capacity-report.md         # 报告写入文件
```
