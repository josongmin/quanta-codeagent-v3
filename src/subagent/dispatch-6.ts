/**
 * Subagent 6-tool dispatch routing (ADR-0041).
 *
 * Single entrypoint that takes a 6-tool name + already-parsed input and
 * routes to the appropriate handler in `./handlers-6`. The router validates
 * input against the frozen contract from `./tools-6`, so callers can pass
 * untrusted `unknown` payloads.
 *
 * Failure shape — every tool returns its discriminated `success|error`
 * union; the router itself NEVER throws. Three meta-error modes:
 *   - unknown tool name      → `{kind:"error", cause:"unknown_tool"}`
 *   - input fails contract   → `{kind:"error", cause:"input_invalid"}`
 *   - missing dep injection  → `{kind:"error", cause:"deps_missing"}`
 */

import {
  handleCloseAgent,
  handleExecCommand,
  handleSendInput,
  handleSpawnAgent,
  handleWaitAgent,
  handleWriteStdin,
  type InputChannelRegistry,
  type PtyTable,
} from "./handlers-6"
import type { TaskRegistry } from "./registry"
import {
  CloseAgentInputSchema,
  ExecCommandInputSchema,
  SendInputInputSchema,
  SpawnAgentInputSchema,
  SUBAGENT_6_TOOL_NAMES,
  type Subagent6ToolName,
  WaitAgentInputSchema,
  WriteStdinInputSchema,
} from "./tools-6"
import type { SubagentRunner } from "./types"

export interface Subagent6Deps {
  /** Required for spawn_agent + wait_agent + close_agent + send_input. */
  registry?: TaskRegistry
  /** Required for spawn_agent. */
  runner?: SubagentRunner
  /** Required for write_stdin + (optionally) exec_command pty retention. */
  ptyTable?: PtyTable
  /** Required for send_input. */
  inputChannel?: InputChannelRegistry
  /** Forwarded to spawn_agent depth checks. */
  maxDepth?: number
  parentDepth?: number
  /** Forwarded to close_agent ownership-token enforcement. */
  ownerToken?: string
  /** Forwarded to exec_command timeout/abort plumbing. */
  signal?: AbortSignal
}

/** Generic discriminated-error shape used by the router itself for meta-
 *  errors (unknown tool / bad input / missing dep). Each per-tool handler
 *  emits its own typed error variant; the meta-error here just lifts a
 *  uniform message + cause string into the kind:"error" slot. */
type AnyToolOutput =
  | { kind: "success"; [k: string]: unknown }
  | { kind: "error"; message: string; cause?: string | undefined }

const metaError = (message: string, cause: string): AnyToolOutput => ({
  kind: "error",
  message,
  cause,
})

/** Narrow string ⇒ Subagent6ToolName when the value is in the frozen set. */
export const isSubagent6Tool = (name: string): name is Subagent6ToolName =>
  (SUBAGENT_6_TOOL_NAMES as ReadonlyArray<string>).includes(name)

/** Schema table keyed by tool name — flat lookup keeps `parseInput`'s
 *  cognitive complexity below the biome cap (was a 5-level nested ternary). */
const SCHEMA_BY_NAME = {
  exec_command: ExecCommandInputSchema,
  write_stdin: WriteStdinInputSchema,
  spawn_agent: SpawnAgentInputSchema,
  wait_agent: WaitAgentInputSchema,
  close_agent: CloseAgentInputSchema,
  send_input: SendInputInputSchema,
} as const

/** Validate `raw` against the per-tool input schema. Returns the parsed
 *  value or a structured error so the router can short-circuit. */
const parseInput = (
  toolName: Subagent6ToolName,
  raw: unknown,
): { kind: "parsed"; value: unknown } | { kind: "rejected"; error: AnyToolOutput } => {
  const parsed = SCHEMA_BY_NAME[toolName].safeParse(raw)
  if (parsed.success) return { kind: "parsed", value: parsed.data }
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
  return {
    kind: "rejected",
    error: metaError(`Input failed contract validation: ${detail}`, "input_invalid"),
  }
}

// Per-tool route table — each route does its own dep validation + handler
// call. Keeping these flat avoids a deeply-nested switch and keeps the
// router's cognitive complexity below the biome cap.
type Route = (parsedInput: unknown, deps: Subagent6Deps) => Promise<AnyToolOutput>

const routeExecCommand: Route = (input, deps) =>
  handleExecCommand(
    input as Parameters<typeof handleExecCommand>[0],
    deps.ptyTable !== undefined ? { ptyTable: deps.ptyTable } : {},
    deps.signal,
  )

const routeWriteStdin: Route = async (input, deps) => {
  if (deps.ptyTable === undefined) {
    return metaError("write_stdin requires a ptyTable", "deps_missing")
  }
  return handleWriteStdin(input as Parameters<typeof handleWriteStdin>[0], {
    ptyTable: deps.ptyTable,
  })
}

const routeSpawnAgent: Route = async (input, deps) => {
  if (deps.runner === undefined || deps.registry === undefined) {
    return metaError("spawn_agent requires a runner + registry", "deps_missing")
  }
  return handleSpawnAgent(input as Parameters<typeof handleSpawnAgent>[0], {
    runner: deps.runner,
    registry: deps.registry,
    ...(deps.maxDepth !== undefined ? { maxDepth: deps.maxDepth } : {}),
    ...(deps.parentDepth !== undefined ? { parentDepth: deps.parentDepth } : {}),
  })
}

const routeWaitAgent: Route = async (input, deps) => {
  if (deps.registry === undefined) {
    return metaError("wait_agent requires a registry", "deps_missing")
  }
  return handleWaitAgent(input as Parameters<typeof handleWaitAgent>[0], {
    registry: deps.registry,
  })
}

const routeCloseAgent: Route = async (input, deps) => {
  if (deps.registry === undefined) {
    return metaError("close_agent requires a registry", "deps_missing")
  }
  return handleCloseAgent(input as Parameters<typeof handleCloseAgent>[0], {
    registry: deps.registry,
    ...(deps.ptyTable !== undefined ? { ptyTable: deps.ptyTable } : {}),
    ...(deps.ownerToken !== undefined ? { ownerToken: deps.ownerToken } : {}),
  })
}

const routeSendInput: Route = async (input, deps) => {
  if (deps.registry === undefined) {
    return metaError("send_input requires a registry", "deps_missing")
  }
  return handleSendInput(input as Parameters<typeof handleSendInput>[0], {
    registry: deps.registry,
    ...(deps.inputChannel !== undefined ? { inputChannel: deps.inputChannel } : {}),
  })
}

const ROUTES: Readonly<Record<Subagent6ToolName, Route>> = {
  exec_command: routeExecCommand,
  write_stdin: routeWriteStdin,
  spawn_agent: routeSpawnAgent,
  wait_agent: routeWaitAgent,
  close_agent: routeCloseAgent,
  send_input: routeSendInput,
}

/**
 * Dispatch a 6-tool call. The output is the tool's own discriminated union
 * (success/error) — callers map it onto the wider tool_result envelope at
 * their own layer.
 *
 * The router checks for the SPECIFIC dependencies a given tool needs and
 * fails fast with `deps_missing` when a required dep is absent — this is
 * the structural signal that "this slice is wired up correctly", not a
 * silent no-op.
 */
export const dispatchSubagent6 = async (
  toolName: string,
  rawInput: unknown,
  deps: Subagent6Deps,
): Promise<AnyToolOutput> => {
  if (!isSubagent6Tool(toolName)) {
    return metaError(`Unknown subagent-6 tool: ${toolName}`, "unknown_tool")
  }
  const parsed = parseInput(toolName, rawInput)
  if (parsed.kind === "rejected") return parsed.error
  return ROUTES[toolName](parsed.value, deps)
}
