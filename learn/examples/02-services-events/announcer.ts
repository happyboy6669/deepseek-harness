import type { Context } from '@deepseek-ai/cordis'
import type {} from './greeter.ts'
import Schema from '@deepseek-ai/schemastery'

export const name = 'announcer'
export const inject = ['greeter'] // 等 ctx.greeter 可用后才会启动

export interface Config {
  targets: string[]
}

export const Config: Schema<Config> = Schema.object({
  targets: Schema.array(String).default(['世界']),
})

export function apply(ctx: Context, config: Config) {
  // ctx.on 是 effect：插件卸载时监听器自动消失，不需要手动 removeListener
  ctx.on('greeter/greeted', (who) => {
    console.log(`[事件] 刚刚问候了 ${who}`)
  })

  // ctx.effect 手动收集一段可逆逻辑：返回的函数就是"回滚"
  ctx.effect(() => {
    console.log('[启动] announcer 已挂载')
    return () => console.log('[卸载] announcer 的所有注册已回滚')
  })

  void (async () => {
    for (const who of config.targets) {
      console.log(await ctx.greeter.greet(who))
    }
  })()
}
