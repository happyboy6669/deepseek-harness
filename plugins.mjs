/**
 * 模拟 dsh 的插件集 —— 每个插件对应主仓库 packages/ 下的一个真实包。
 * name 声明占用的 ctx key；inject 声明依赖；apply 返回服务对象（或 undefined 纯贡献）。
 */

// 对应 packages/core/session（ctx.sessions）：追加式会话日志 + 广播
export const sessionsPlugin = {
  name: 'sessions',
  apply(ctx) {
    const log = []
    return {
      append(type, payload) {
        const event = { seq: log.length + 1, type, payload }
        log.push(event)
        ctx.emit('session/event', event) // 持久事实追加日志后广播（model-visible ⟺ logged）
        return event
      },
      all: () => [...log],
    }
  },
}

// 对应 packages/llm/*（ctx.llm）：脚本化 mock，真实实现是对 DeepSeek API 的流式请求
export const mockLlmPlugin = {
  name: 'llm',
  apply(ctx) {
    const script = []
    return {
      queue(response) { script.push(response) },
      async complete(messages) {
        ctx.emit('llm/request', { roles: messages.map(m => m.role) })
        const next = script.shift()
        if (!next) throw new Error('mock llm: 脚本耗尽（真实实现里这是流式模型请求）')
        return next
      },
    }
  },
}

// 对应 packages/core/system-prompt（ctx.systemPrompt）：分节组装，任何插件可贡献小节
export const systemPromptPlugin = {
  name: 'systemPrompt',
  apply(ctx) {
    const sections = new Map()
    return {
      add(id, text) {
        ctx.effect(() => {
          sections.set(id, text)
          return () => sections.delete(id) // 贡献是可逆效果：dispose 时小节消失
        })
      },
      build: () => [...sections].map(([id, text]) => `[${id}] ${text}`).join('\n'),
    }
  },
}

// 对应 packages/core/tools（ctx.tools）+ packages/guard 的守卫管线
export const toolsPlugin = {
  name: 'tools',
  inject: ['sessions'],
  apply(ctx) {
    const tools = new Map()
    return {
      register(tool) { tools.set(tool.name, tool) },
      list: () => [...tools.keys()],
      /** 执行前的守卫点：waterfall 让策略插件可短路否决（对应 approval policy）。 */
      async execute(name, input) {
        const decision = await ctx.waterfall('tools/execute', { tool: name, input, allowed: true, reason: null })
        if (!decision.allowed) {
          ctx.sessions.append('tool/denied', { tool: name, reason: decision.reason })
          throw new Error(`工具 ${name} 被策略拒绝：${decision.reason}`)
        }
        ctx.sessions.append('tool/call', { tool: name, input })
        const result = await tools.get(name).run(input)
        ctx.sessions.append('tool/result', { tool: name, result })
        return result
      },
    }
  },
}

// 对应 packages/fs：文件工具；config.readOnly 演示"同一插件、不同配置"
export const fsToolsPlugin = {
  name: 'fsTools',
  inject: ['tools'],
  apply(ctx, config = {}) {
    const files = new Map([['notes.txt', '旧内容'], ['secrets.txt', '机密']])
    ctx.tools.register({
      name: 'write_file',
      run: ({ path, content }) => { files.set(path, content); return `已写入 ${path}` },
    })
    ctx.tools.register({
      name: 'read_file',
      run: ({ path }) => files.get(path) ?? '(不存在)',
    })
    if (!config.readOnly) {
      ctx.tools.register({
        name: 'delete_file',
        run: ({ path }) => { files.delete(path); return `已删除 ${path}` },
      })
    }
    ctx.effect(() => () => files.clear()) // 可逆：dispose 时清空内存文件系统
    return { files }
  },
}

// 对应 packages/core/agent-loop（ctx.agentLoop）：回合驱动器（step = 一次模型请求 + 其工具调用）
export const agentLoopPlugin = {
  name: 'agentLoop',
  inject: ['llm', 'tools', 'systemPrompt', 'sessions'],
  apply(ctx) {
    return {
      async run(input) {
        ctx.sessions.append('turn/start', { input })
        let messages = [
          { role: 'system', content: ctx.systemPrompt.build() },
          { role: 'user', content: input },
        ]
        for (let step = 1; ; step++) {
          const output = await ctx.llm.complete(messages)
          if (!output.toolCalls?.length) {
            ctx.sessions.append('turn/end', { answer: output.text })
            return output.text
          }
          for (const call of output.toolCalls) {
            let result
            try {
              result = await ctx.tools.execute(call.name, call.input)
            } catch (error) {
              result = `错误：${error.message}` // 失败（含策略否决）也回给模型，工具结果就是反馈
            }
            ctx.sessions.append('agent/step', { step, tool: call.name })
            messages = [...messages, { role: 'tool', content: `${call.name} → ${result}` }]
          }
        }
      },
    }
  },
}

// ─────── 以下为纯贡献者插件：只通过事件监听和效果扩展，不改核心 ───────

// 对应 packages/guard / approval policy：waterfall 短路否决破坏性工具
export const denyDangerousPlugin = {
  name: 'denyDangerous',
  apply(ctx) {
    ctx.effect(() => ctx.on('tools/execute', (decision, next) => {
      if (decision.tool === 'delete_file') {
        // 不调用 next()：短路 —— 该策略拥有否决权，下游监听器不再看到此事件
        return { ...decision, allowed: false, reason: '破坏性操作被安全策略否决' }
      }
      return next() // 观察者必须委托，否则链条在此断掉（waterfall 语义）
    }))
  },
}

// 遥测类插件（对应 telemetry/* 事件域）：emit 观察者，旁路视角
export const telemetryPlugin = {
  name: 'telemetry',
  apply(ctx) {
    ctx.effect(() => ctx.on('session/event', event => {
      console.log(`      [telemetry] 观察到 ${event.type} (#${event.seq})`)
    }))
  },
}

// 系统提示词贡献者：演示效果可逆性（dispose 时小节被撤销）
export const safetyPromptPlugin = {
  name: 'safetyPrompt',
  inject: ['systemPrompt'],
  apply(ctx) {
    ctx.systemPrompt.add('safety', '不得执行破坏性文件操作。')
    ctx.effect(() => () => console.log('      [safety-prompt] 系统提示词中的 safety 小节已撤销'))
  },
}
