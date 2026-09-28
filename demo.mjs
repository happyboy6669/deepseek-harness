/**
 * 运行：node demo.mjs（零依赖，Node >= 18）
 *
 * 完整走一遍 dsh 的生命周期：组装 -> 挂载 -> 回合执行 -> 会话日志 -> 拆卸。
 * 每一步标注了对应的真实仓库机制。
 */
import { Context } from './mini-cordis.mjs'
import { baseBundle, webPatch, overlayPatch, applyPatches } from './compose.mjs'
import * as plugins from './plugins.mjs'

const line = (title) => console.log(`\n===== ${title} =====`)

// ======================== 1. 组装 ========================
line('1. 组装：bundle -> profile patch -> --patch（行的有序叠加）')
console.log('  base bundle（类比 dsh-base）:')
for (const row of baseBundle) console.log(`    ${row.id}`)
console.log('  + web profile patch（类比 dsh-web-app）: insert telemetry')
console.log('  + overlay patch（类比 dsh web --patch x.yml）: insert denyDangerous, safetyPrompt')
const rows = applyPatches(applyPatches(baseBundle, webPatch), overlayPatch)
console.log(`  -> 最终 ${rows.length} 行: ${rows.map(r => r.id).join(', ')}`)
console.log('  (replace 语义) 按 id 整行替换 llm ->',
  JSON.stringify(applyPatches(baseBundle, [{ op: 'replace', id: 'llm', row: { plugin: 'myLlm' } }]).find(r => r.id === 'llm')))

// ======================== 2. 挂载 ========================
line('2. 挂载：agent-loop 在行首却最后激活 —— inject 依赖就绪驱动顺序')
const ctx = new Context({ onService: key => console.log(`  [ok] ctx.${key} 就绪`) })
// id -> 插件实现（真实 dsh 里这一步是包解析 + cordis.yml 行配置）
const registry = {
  agentLoop: plugins.agentLoopPlugin,
  sessions: plugins.sessionsPlugin,
  mockLlm: plugins.mockLlmPlugin,
  systemPrompt: plugins.systemPromptPlugin,
  tools: plugins.toolsPlugin,
  fsTools: plugins.fsToolsPlugin,
  telemetry: plugins.telemetryPlugin,
  denyDangerous: plugins.denyDangerousPlugin,
  safetyPrompt: plugins.safetyPromptPlugin,
}
ctx.mount(...rows.map(row => ({ ...registry[row.plugin], config: row.config })))

// ======================== 3. mock 脚本 ========================
line('3. 注入 mock LLM 脚本（真实实现：packages/llm 流式调用 DeepSeek API）')
ctx.llm.queue({ toolCalls: [{ name: 'write_file', input: { path: 'notes.txt', content: 'hello cordis' } }] })
ctx.llm.queue({ text: '已把 "hello cordis" 写入 notes.txt。' })
ctx.llm.queue({ toolCalls: [{ name: 'delete_file', input: { path: 'secrets.txt' } }] })
ctx.llm.queue({ text: 'delete_file 被安全策略否决，我无法删除 secrets.txt。' })
console.log('  已注入 4 段脚本化响应（2 个回合 x 2 步）')

// ======================== 4. 回合 1 ========================
line('4. 回合 1：正常工具调用（[telemetry] 行是观察者的旁路视角）')
console.log('  用户: 把 "hello cordis" 写进 notes.txt')
const answer1 = await ctx.agentLoop.run('把 "hello cordis" 写进 notes.txt')
console.log(`  助手: ${answer1}`)

// ======================== 5. 回合 2 ========================
line('5. 回合 2：waterfall 短路 —— 策略插件不调 next() 即否决')
console.log('  用户: 删除 secrets.txt')
const answer2 = await ctx.agentLoop.run('删除 secrets.txt')
console.log(`  助手: ${answer2}`)

// ======================== 6. 会话日志 ========================
line('6. 会话日志（model-visible iff logged：一切可从日志重建）')
for (const event of ctx.sessions.all()) {
  console.log(`  #${event.seq} ${event.type.padEnd(12)} ${JSON.stringify(event.payload)}`)
}

// ======================== 7. 事件派发模式速览 ========================
line('7. 五种派发模式速览（emit/bail/waterfall；serial 类似 parallel 但保序收集）')
const c2 = new Context()
c2.mount({
  name: 'modesDemo',
  apply(ctx) {
    ctx.on('scan', v => console.log(`      [A] 看到 ${v}`))
    ctx.on('scan', v => console.log(`      [B] 看到 ${v}`))
    ctx.on('gate', v => (v < 0 ? `拦下 ${v}` : undefined))
    ctx.on('chain', (v, next) => v * 10)
    ctx.on('chain', v => `B(${v})`)
  },
})
c2.emit('scan', 7)
console.log('  bail(-3)   ->', await c2.bail('gate', -3), '（首个非 undefined 短路获胜）')
console.log('  bail(3)    ->', await c2.bail('gate', 3), '（无人认领 -> undefined）')
console.log('  waterfall  ->', await c2.waterfall('chain', 5), '（[A] 未调 next() -> [B] 未运行）')
await c2.dispose()

// ======================== 8. 拆卸 ========================
line('8. dispose：效果按挂载逆序撤销（热重载/卸载的安全保证）')
await ctx.dispose()

// ======================== 9. 验证 ========================
line('9. 拆卸后：服务与监听器全部失效')
try {
  ctx.sessions.append('x', {})
} catch (error) {
  console.log(`  ctx.sessions -> ${error.message}`)
}
console.log('\n完成。对照阅读主仓库：docs/cordis-primer.md 与 docs/architecture.md')
