import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

// 声明合并：让 ctx.greeter 和两个自定义事件获得类型
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
  interface Events {
    'greeter/greeted'(who: string, text: string): void
    'greeter/format'(text: string, next: () => Promise<string>): Promise<string>
  }
}

export const name = 'greeter'

export interface Config {
  greeting: string
}

// Config 同时是 TypeScript 接口（类型）和 Schemastery 模式（运行时校验器）
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('你好'),
})

export class GreeterService extends Service {
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'greeter') // 注册为 ctx.greeter；卸载时自动移除
  }

  async greet(who: string) {
    const raw = `${this.config.greeting}，${who}！`
    // waterfall：所有监听器依次加工文本，最内层是默认值
    const text = await this.ctx.waterfall('greeter/format', raw, async () => raw)
    // emit：广播一个事实，不知道也不关心谁在听
    this.ctx.emit('greeter/greeted', who, text)
    return text
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.plugin(GreeterService, config)
}
