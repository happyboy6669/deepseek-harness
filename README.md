# cordis-demo —— 理解 DeepSeek Harness 插件架构的最小可运行示例

零依赖，运行方式：`node demo.mjs`（Node >= 18）。

本目录用约 500 行代码复刻了主仓库 DeepSeek Harness 的架构内核（Cordis 插件框架），
并完整演示一次生命周期：**组装 -> 挂载 -> 回合执行 -> 会话日志 -> 拆卸**。

## 解决什么问题（为什么这样设计）

| 问题 | 传统做法 | 插件化做法（本 demo） |
|---|---|---|
| 加功能要改核心 | 核心代码越来越胖 | 没有特权核心，扩展 = 挂新插件（demo 里策略/遥测都是旁观插件） |
| 启动顺序手工维护 | boot 清单易腐烂 | `inject` 声明依赖，就绪驱动激活（agent-loop 行首却最后激活） |
| 卸载/热重载泄漏状态 | 全靠自觉 | 注册即效果，disposer 逆序撤销（safety 小节 dispose 时消失） |
| 一套内核多种产品 | 各产品线 fork | 行（row）分层叠加：bundle -> profile patch -> --patch |
| 定制要改上游代码 | 打补丁 | 按 id 整行替换，或插入新行（deny-dangerous 就是一行 patch） |

## 文件导览与真实仓库映射

| 文件 | 内容 | 主仓库对应 |
|---|---|---|
| `mini-cordis.mjs` | ~200 行复刻 Cordis 五个核心概念 | `vendor/cordis`，概念文档 `docs/cordis-primer.md` |
| `compose.mjs` | 行（row）与补丁的分层叠加 | `docs/architecture.md` 的 Profiles and bundles |
| `plugins.mjs` | 模拟 dsh 插件集（9 个插件） | `packages/core/session` `core/tools` `core/system-prompt` `core/agent-loop`、`packages/llm/*` `packages/fs` `packages/guard` |
| `demo.mjs` | 组装 -> 挂载 -> 2 回合 -> 日志 -> dispose | dsh 的启动与回合（turn/step）流程 |

## 五个核心概念（对照 mini-cordis.mjs）

1. **插件即服务**：`{ name, inject, apply(ctx, config) }`，apply 返回服务对象；不返回的
   是纯贡献者（denyDangerous、telemetry、safetyPrompt），只通过事件和效果扩展。
2. **上下文即服务仓库**：服务以稳定 key 挂上 ctx（`ctx.tools`、`ctx.llm`、`ctx.sessions`），
   消费方按 key 找服务，而不是 import 具体实现 —— 所以任何服务都可在配置里被替换。
3. **inject 等待语义**：依赖未就绪的插件挂起，反复重试；永远无法满足则启动即失败
   （misconfiguration fails loud，绝不静默跳过）。
4. **类型化事件，五种派发模式**：`emit`（观察）/ `parallel`（并行）/ `serial`（保序收集）/
   `bail`（首个非 undefined 获胜）/ `waterfall`（环绕中间件）。waterfall 的监听器收到
   `(...args, next)`：调 `next()` 把可能包装过的结果委托给下游；不调 = 短路，自己拥有
   决策权。demo 第 5 节的策略否决、第 7 节的 `50` 输出都是这个语义。
5. **注册即可逆效果**：`ctx.effect()` / `ctx.on()` 都返回 disposer；`dispose()` 按挂载
   逆序先调服务 dispose、再撤销效果 —— 这是热重载与卸载安全的基础。

## demo 输出怎么读

1. **组装**：base bundle 6 行 -> profile patch 插入 telemetry -> overlay 插入策略与提示词
   贡献者，共 9 行。`replace` 只演示语义（按 id 整行换掉 llm）。
2. **挂载**：注意 `agent-loop` 在行首却**最后**激活 —— 它 `inject` 了 4 个服务，框架等
   依赖全部就绪才激活它。启动顺序由依赖驱动，不是行顺序。
3. **回合 1**：模型（mock）要求 `write_file` -> tools 守卫点过 waterfall -> 无策略接管 ->
   执行 -> 结果回给模型 -> 最终回答。`[telemetry]` 行是纯观察者的旁路视角。
4. **回合 2**：`delete_file` 被 denyDangerous 在 waterfall 中**不调 next()** 直接短路
   否决 -> `tool/denied` 记入日志 -> 错误作为工具结果回给模型 -> 模型如实告知用户。
   核心 agent-loop 完全不知道"审批策略"的存在 —— 这就是扩展点与核心的解耦。
5. **会话日志**：9 条事件。真实 dsh 的铁律 "model-visible iff logged"：凡到达模型的
   输入都能从这份日志重建（回放/审计/换模型续跑都靠它）。
6. **拆卸**：safety 小节撤销、内存文件清空、监听器移除；之后再访问 `ctx.sessions`
   直接报错 —— 不会有半死不活的残留状态。

## 回到主仓库继续探索

```sh
cd /Users/azer/deepseek-harness
pnpm dsh --profile web --dump-config   # 打印真实启动的插件树（每一行都可被 patch 替换）
pnpm run demo:inspector                # 带 inspector 面板的 web 模式，可视化插件树
pnpm dsh web --patch 你的.overlay.yml   # 用 --patch 挂自己的插件/改配置
```

文档：`docs/cordis-primer.md`（框架概念）、`docs/architecture.md`（仓库总体架构）、
`docs/cordis-tutorial/`（动手教程）。

## 清理

```sh
git -C /Users/azer/deepseek-harness worktree remove /Users/azer/cordis-demo
git -C /Users/azer/deepseek-harness branch -D cordis-demo
```
