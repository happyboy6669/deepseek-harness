/**
 * mini-cordis —— 用最小代码复刻 DeepSeek Harness 底层插件框架 Cordis 的核心机制。
 *
 * 真实实现在主仓库 vendor/cordis（rescope 进仓库的框架源码），概念文档见
 * docs/cordis-primer.md 的 "Cordis In Five Ideas"。这里保留五个概念、五种
 * 事件派发模式与"注册即可逆"的语义，省略层级上下文、作用域注册等工程细节。
 *
 * 五个概念：
 *   1. 插件是实现 Service 的对象：{ name, inject, apply(ctx, config) }
 *   2. 上下文是服务仓库：服务以稳定 key 挂在 ctx 上（ctx.tools、ctx.llm…）
 *   3. inject 声明依赖：依赖未就绪的插件挂起，就绪后自动激活（顺序由依赖驱动）
 *   4. 类型化事件通信：emit / parallel / serial / bail / waterfall 五种派发模式
 *   5. 注册即可逆效果：ctx.effect()/ctx.on() 返回 disposer，dispose 时逆序撤销
 */
export class Context {
  #listeners = new Map() // event -> Array<listener>（保持注册顺序）
  #services = new Map()  // ctx key -> 服务实例
  #pending = []          // 依赖未就绪、等待激活的插件队列
  #activated = []        // { key, service, effects: Disposer[] }，按激活顺序
  #current = null        // 当前正在激活的插件，effect 注册归属它
  #disposed = false

  /**
   * @param {object} [options]
   * @param {(key: string) => void} [options.onService] 服务就绪回调（demo 用于展示激活顺序）
   */
  constructor(options = {}) {
    this.onService = options.onService
    // 让 `ctx.sessions` 这样的 ctx key 直接可用（真实 Cordis 通过 TS 声明合并提供类型）
    return new Proxy(this, {
      get(target, key) {
        if (key in target) {
          const value = target[key]
          return typeof value === 'function' ? (...args) => value.apply(target, args) : value
        }
        if (target.#disposed) throw new Error(`context 已销毁，无法访问 ctx.${String(key)}`)
        if (target.#services.has(key)) return target.#services.get(key)
        return undefined
      },
    })
  }

  // ── 挂载 ──────────────────────────────────────────────────────────────

  /** 挂载一个或多个插件；依赖未就绪的自动挂起，随后续激活反复重试。 */
  mount(...plugins) {
    this.#pending.push(...plugins)
    this.#drain()
  }

  #drain() {
    let progressed = true
    while (progressed) {
      progressed = false
      for (const plugin of [...this.#pending]) {
        const missing = (plugin.inject ?? []).filter(key => !this.#services.has(key))
        if (missing.length > 0) continue // 依赖未就绪 → 继续挂起（inject 等待语义）
        this.#pending.splice(this.#pending.indexOf(plugin), 1)
        this.#activate(plugin)
        progressed = true
      }
    }
    if (this.#pending.length > 0) {
      // 依赖永远无法满足 → 启动即失败（misconfiguration fails loud，拒绝静默跳过）
      const dead = this.#pending.map(p => p.name ?? '(匿名插件)').join(', ')
      throw new Error(`插件依赖无法满足: ${dead}`)
    }
  }

  #activate(plugin) {
    const entry = {
      key: plugin.name ?? `contributor-${this.#activated.length}`,
      service: undefined,
      effects: [],
    }
    this.#activated.push(entry)
    this.#current = entry
    try {
      // 服务插件返回服务对象；纯贡献者插件返回 undefined（只留下 effects）
      entry.service = plugin.apply(this.#pluginContext(), plugin.config)
    } finally {
      this.#current = null
    }
    if (plugin.name) {
      this.#services.set(plugin.name, entry.service)
      this.onService?.(plugin.name)
    }
  }

  /** 每个插件拿到自己的注册上下文：effect 归属追踪 + ctx key 动态解析。 */
  #pluginContext() {
    const root = this
    const ctx = {
      /** 注册可逆效果：立即执行 setup，返回的 disposer 在 dispose 时逆序调用。 */
      effect(setup) {
        if (!root.#current) throw new Error('ctx.effect() 只能在插件 apply() 内调用')
        const disposer = setup()
        if (disposer) root.#current.effects.push(disposer)
        return disposer
      },
      /** 注册事件监听器，返回 disposer。 */
      on(event, listener) {
        const list = root.#listeners.get(event) ?? []
        list.push(listener)
        root.#listeners.set(event, list)
        return () => {
          const index = list.indexOf(listener)
          if (index !== -1) list.splice(index, 1)
        }
      },
      emit: (event, ...args) => root.emit(event, ...args),
      parallel: (event, ...args) => root.parallel(event, ...args),
      serial: (event, ...args) => root.serial(event, ...args),
      bail: (event, ...args) => root.bail(event, ...args),
      waterfall: (event, ...args) => root.waterfall(event, ...args),
    }
    return new Proxy(ctx, {
      get(target, key) {
        if (key in target) return target[key]
        if (root.#disposed) throw new Error(`context 已销毁，无法访问 ctx.${String(key)}`)
        if (root.#services.has(key)) return root.#services.get(key)
        return undefined
      },
    })
  }

  // ── 事件派发（五种模式，语义见 docs/cordis-primer.md） ────────────────

  emit(event, ...args) { this.#dispatch('emit', event, args) }
  parallel(event, ...args) { return this.#dispatch('parallel', event, args) }
  serial(event, ...args) { return this.#dispatch('serial', event, args) }
  bail(event, ...args) { return this.#dispatch('bail', event, args) }
  waterfall(event, ...args) { return this.#dispatch('waterfall', event, args) }

  #dispatch(mode, event, args) {
    const listeners = [...(this.#listeners.get(event) ?? [])]
    switch (mode) {
      case 'emit': // 即发即忘：按注册顺序观察，单个监听器出错不中断其他
        for (const listener of listeners) {
          try { listener(...args) } catch (error) {
            console.error(`[mini-cordis] ${event} 监听器抛错（emit 不中断）:`, error.message)
          }
        }
        return
      case 'parallel': // 并行等待全部
        return Promise.all(listeners.map(listener => listener(...args)))
      case 'serial': { // 依次等待，收集全部返回值
        return (async () => {
          const results = []
          for (const listener of listeners) results.push(await listener(...args))
          return results
        })()
      }
      case 'bail': { // 首个非 undefined 返回值短路获胜
        return (async () => {
          for (const listener of listeners) {
            const result = await listener(...args)
            if (result !== undefined) return result
          }
          return undefined
        })()
      }
      case 'waterfall': { // 环绕中间件：(...args, next)；不调 next() 即短路
        const walk = (index, value) => {
          if (index >= listeners.length) return Promise.resolve(value)
          let delegated = false
          let nextResult
          const next = (v = value) => {
            delegated = true
            nextResult = walk(index + 1, v)
            return nextResult
          }
          return Promise.resolve(listeners[index](value, ...args.slice(1), next))
            .then(result => (delegated ? nextResult : result))
        }
        return walk(0, args[0])
      }
      default:
        throw new Error(`未知派发模式: ${mode}`)
    }
  }

  // ── 拆卸 ──────────────────────────────────────────────────────────────

  /** 逆序拆卸：每个插件先调服务自身的 dispose，再逆序撤销它注册的全部效果。 */
  async dispose() {
    this.#disposed = true
    const order = [...this.#activated].reverse()
    this.#activated.length = 0
    this.#services.clear()
    this.#listeners.clear()
    this.#pending.length = 0
    for (const entry of order) {
      await entry.service?.dispose?.()
      for (const disposer of [...entry.effects].reverse()) await disposer()
    }
  }
}
