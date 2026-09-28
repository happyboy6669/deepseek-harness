/**
 * 组装机制模拟 —— 对应 docs/architecture.md#profiles-and-bundles。
 *
 * dsh 启动时把"行（row）"列表按层叠加：bundle → profile 的 cordis.patch.yml
 * → home 层 patch → 命令行 --patch。每层只能：按 id 整行替换，或插入新行。
 * 这保证任何一层都能改掉上层行为，而无需触碰上层代码。
 */

/** base bundle（类比 packages/bundle/base 的 dsh-base：模型、工具、持久化的公共层）。 */
export const baseBundle = [
  // 有意把 agent-loop 放在行首：它声明了 inject 依赖，用来演示"等待依赖"机制
  { id: 'agent-loop', plugin: 'agentLoop' },
  { id: 'sessions', plugin: 'sessions' },
  { id: 'llm', plugin: 'mockLlm' },
  { id: 'system-prompt', plugin: 'systemPrompt' },
  { id: 'tools', plugin: 'tools' },
  { id: 'fs-tools', plugin: 'fsTools' },
]

/** profile 内置 patch（类比 dsh-web-app：GUI 场景追加遥测观察者）。 */
export const webPatch = [
  { op: 'insert', row: { id: 'telemetry', plugin: 'telemetry' } },
]

/** 命令行 overlay（类比 `dsh web --patch xxx.overlay.yml`：本次运行追加策略）。 */
export const overlayPatch = [
  { op: 'insert', row: { id: 'deny-dangerous', plugin: 'denyDangerous' } },
  { op: 'insert', row: { id: 'safety-prompt', plugin: 'safetyPrompt' } },
]

/**
 * 把补丁依次应用到行列表。
 * @param {Array<{id: string}>} rows - 现有行
 * @param {Array<object>} patches - { op: 'insert', row } 或 { op: 'replace', id, row }
 */
export function applyPatches(rows, patches) {
  const out = rows.map(row => ({ ...row }))
  for (const patch of patches) {
    if (patch.op === 'insert') {
      out.push({ ...patch.row })
      continue
    }
    if (patch.op === 'replace') {
      const index = out.findIndex(row => row.id === patch.id)
      // 目标不存在 → 立即失败（对应 dsh 的 misconfiguration fails loud 原则）
      if (index === -1) throw new Error(`patch 目标行不存在: ${patch.id}`)
      out[index] = { ...patch.row, id: patch.id }
      continue
    }
    throw new Error(`未知 patch op: ${patch.op}`)
  }
  return out
}
