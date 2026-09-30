import type { Context } from '@deepseek-ai/cordis'
import type {} from './greeter.ts' // 仅引入声明合并，运行时无依赖

export const name = 'formatter'

export function apply(ctx: Context) {
  // 监听器 1（先注册先执行）：只加工，必须 next() 把结果传下去
  ctx.on('greeter/format', async (text, next) => {
    const downstream = await next()
    return `『${downstream}』`
  })

  // 监听器 2：拥有最终决定权时可以不调用 next()，直接短路
  ctx.on('greeter/format', async (text, next) => {
    if (text.includes('加班')) return '今天不聊这个。'
    return next()
  })
}
