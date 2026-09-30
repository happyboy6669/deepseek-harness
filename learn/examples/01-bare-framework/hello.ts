import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  console.log('你好，只剩插件框架的世界！')
  console.log('此刻 ctx 上没有 tools、没有 llm、没有 sessions —— 它们全都是还没挂载的插件。')
}
