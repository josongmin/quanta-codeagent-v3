/**
 * Pure Claude Code MCP-server / hook-map decoder.
 *
 * File I/O, size caps, and error policy stay at the two entrypoints
 * (`external-config/convert.ts`, `translators/claude-code-config.ts`).
 * This module owns only object-shape decoding. MCP `env` is dropped.
 */

export interface ClaudeMcpServerShape {
  readonly name: string
  readonly transport: "http" | "sse" | "stdio" | "unknown"
  readonly command?: string
  readonly args?: readonly string[]
}

export interface ClaudeHookShape {
  readonly event: string
  readonly commands: readonly string[]
  readonly matcher?: string
}

export const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

export const classifyClaudeTransport = (
  entry: Record<string, unknown>,
): ClaudeMcpServerShape["transport"] => {
  const type = entry.type
  if (type === "http" || type === "sse" || type === "stdio") return type
  if (typeof entry.url === "string") return "http"
  if (typeof entry.command === "string") return "stdio"
  return "unknown"
}

const stringArgs = (raw: unknown): readonly string[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((a): a is string => typeof a === "string")
}

export const decodeClaudeMcpServers = (value: unknown): ClaudeMcpServerShape[] => {
  const obj = asObject(value)
  const servers = asObject(obj?.mcpServers)
  if (servers === undefined) return []
  const out: ClaudeMcpServerShape[] = []
  for (const [name, rawEntry] of Object.entries(servers)) {
    const entry = asObject(rawEntry)
    if (entry === undefined) continue
    const transport = classifyClaudeTransport(entry)
    const command = typeof entry.command === "string" ? entry.command : undefined
    const args = stringArgs(entry.args)
    out.push({
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
    })
  }
  return out
}

const commandsOf = (group: Record<string, unknown>): string[] => {
  const hooks = group.hooks
  if (!Array.isArray(hooks)) return []
  const cmds: string[] = []
  for (const h of hooks) {
    const ho = asObject(h)
    if (ho?.type === "command" && typeof ho.command === "string") cmds.push(ho.command)
  }
  return cmds
}

const decodeHookGroup = (event: string, rawGroup: unknown): ClaudeHookShape | undefined => {
  const group = asObject(rawGroup)
  if (group === undefined) return undefined
  const commands = commandsOf(group)
  if (commands.length === 0) return undefined
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined
  return { event, commands, ...(matcher !== undefined ? { matcher } : {}) }
}

export const decodeClaudeHookMap = (value: unknown): ClaudeHookShape[] => {
  const hooks = asObject(value)
  if (hooks === undefined) return []
  const out: ClaudeHookShape[] = []
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue
    for (const rawGroup of rawGroups) {
      const decoded = decodeHookGroup(event, rawGroup)
      if (decoded !== undefined) out.push(decoded)
    }
  }
  return out
}
