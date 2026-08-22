/**
 * 6-tool subagent assembler — the LIVE assembly site for ADR-0041.
 *
 * `tools-6.ts` froze the contracts; `handlers-6.ts` supplied runtime handlers;
 * `dispatch-6.ts` routes a `(name, rawInput, deps)` triple to the right handler
 * and returns the handler's discriminated `success|error` union. NONE of those
 * produced `Tool` objects the agent loop can register — `dispatchSubagent6` is
 * a router, not a tool builder.
 *
 * THIS module is that missing builder. `createSubagent6Tools(deps)` returns the
 * six `Tool` objects (`exec_command` / `write_stdin` / `spawn_agent` /
 * `wait_agent` / `close_agent` / `send_input`), each wrapping
 * `dispatchSubagent6(name, input, deps)` and mapping its discriminated union
 * onto the SAME `ToolEvent` shape the trio tools emit
 * (`{type:"result", result:{ok, output}}`). This is what makes the already-
 * exposed `config.subagent.{maxConcurrent, waitTimeoutPolicy}` knobs behavior-
 * live: `deps` threads them straight into the spawn/wait handlers.
 *
 * DEFAULT-OFF: the builder is only invoked when `config.subagent.enable6Tools
 * === true`. Absent/false ⇒ the trio is built exactly as before (byte-
 * identical). When enabled the 6 tools COEXIST with the trio (ADR-0041
 * "두 surface가 한동안 공존" — both surfaces share the one TaskRegistry).
 *
 * Slice fence: imports only `@/tool` (the Tool/ToolEvent contract) + sibling
 * modules in this slice. No `@/agent`, no filesystem beyond what handlers-6
 * already owns.
 */

import { runtimeConfig } from "@/shared"
import { withDelegationPolicy } from "@/shared/delegation-policy"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { dispatchSubagent6, type Subagent6Deps } from "./dispatch-6"
import { InputChannelRegistry, PtyTable } from "./handlers-6"
import {
  CloseAgentInputSchema,
  type CloseAgentOutput,
  ExecCommandInputSchema,
  type ExecCommandOutput,
  SendInputInputSchema,
  type SendInputOutput,
  SpawnAgentInputSchema,
  type SpawnAgentOutput,
  WaitAgentInputSchema,
  type WaitAgentOutput,
  WriteStdinInputSchema,
  type WriteStdinOutput,
} from "./tools-6"

/** The dispatcher's union shape (mirrors `dispatch-6.ts AnyToolOutput`): a
 *  per-tool success record OR a uniform error. We map this onto a `ToolEvent`
 *  the SAME way the trio tools do — `{type:"result", result:{ok, output}}`. */
type DispatchOutput =
  | ({ kind: "success" } & Record<string, unknown>)
  | { kind: "error"; message: string; cause?: string | undefined }

/** A small per-tool renderer: given the dispatcher's discriminated success
 *  payload, produce the model-facing `output` string. The error arm is shared
 *  (message + optional cause) so each renderer only needs the success shape. */
type SuccessRender<S> = (success: S) => string

/** Map a dispatcher output onto the trio's `ToolEvent` idiom. `ok` is
 *  `kind === "success"`; the success arm is rendered by `renderSuccess`, the
 *  error arm surfaces `message` (+ `cause` when present) so the model sees the
 *  structured failure reason exactly as the trio's `task_*` tools do. */
const toEvent = <S>(out: DispatchOutput, renderSuccess: SuccessRender<S>): ToolEvent => {
  if (out.kind === "success") {
    return { type: "result", result: { ok: true, output: renderSuccess(out as unknown as S) } }
  }
  const detail = out.cause !== undefined ? `${out.message} (cause: ${out.cause})` : out.message
  return { type: "result", result: { ok: false, output: detail } }
}

/** Forward the live context into the deps the dispatcher threads down: the
 *  abort signal (so a cancelled tool call kills the child), plus `ctx.cwd`
 *  (spawn_agent `checkpoint` path) and `ctx.agentLabel` as the requester lineage
 *  (spawn_agent `continue_from` ownership gate). The per-call `ctx.*` wins over
 *  any base value a host set since it tracks THIS dispatch. */
const withCtxSignal = (deps: Subagent6Deps, ctx: ToolContext): Subagent6Deps => ({
  ...deps,
  signal: ctx.signal,
  cwd: ctx.cwd,
  ...(ctx.agentLabel !== undefined ? { requesterLineage: ctx.agentLabel } : {}),
})

/**
 * Assemble the six subagent tools against shared `deps`. The caller wires
 * `deps.registry` to the SAME `TaskRegistry` the trio uses so spawn/wait/close
 * observe the same tasks, and threads `maxConcurrent` / `waitTimeoutPolicy` /
 * `runner` / `maxDepth` so the cap + clamp knobs are behavior-live.
 *
 * `ptyTable` / `inputChannel` are minted here when the caller did not supply
 * them (the common case) so `write_stdin` / `send_input` have a live backing
 * store. The returned `cleanup` tears down the PTY table (kills live children).
 */
export interface Subagent6ToolSet {
  tools: Tool[]
  /** Tear down PTY children minted by `exec_command({pty:true})`. Idempotent.
   *  The host folds this into its session-cleanup hook. */
  cleanup: () => void
}

/** Base (fan-out-mechanics) description of the 6-tool `spawn_agent`, kept as a
 *  module const so {@link spawnAgent6Description} can project the C5059-05
 *  delegation policy from ONE place (identical atom to the trio `agent` tool). */
const SPAWN_AGENT_6_BASE_DESCRIPTION =
  "Spawn a CONCURRENT child subagent, returning its agentId immediately. This " +
  "is the FAN-OUT / interactive primitive: launch several workers in parallel, " +
  "STEER a paused one mid-run with send_input, and collect them with " +
  "wait_agent / close_agent. For a SINGLE delegated task prefer the `agent` " +
  "tool (its background:true gives the same async handle with simpler " +
  "task_output polling); reach for spawn_agent when you need multiple " +
  "concurrent children or mid-run control."

/** Model-facing description of the 6-tool `spawn_agent`. C5059-05: prepends the
 *  single-agent-first delegation policy when the opt-in knob is set (default-OFF
 *  ⇒ byte-identical). Projects the SAME SSOT atom as the trio `agent` tool. */
export const spawnAgent6Description = (): string =>
  withDelegationPolicy(SPAWN_AGENT_6_BASE_DESCRIPTION, runtimeConfig().subagentDelegateSuppress)

export const createSubagent6Tools = (deps: Subagent6Deps): Subagent6ToolSet => {
  // Mint a PtyTable + InputChannelRegistry when the caller didn't supply one,
  // so `write_stdin` / `send_input` have a live backing store. Owning them here
  // lets us expose a `cleanup` that kills any child processes exec_command kept
  // alive (no orphan PTYs at session end).
  const ptyTable = deps.ptyTable ?? new PtyTable()
  const inputChannel = deps.inputChannel ?? new InputChannelRegistry()
  const wired: Subagent6Deps = { ...deps, ptyTable, inputChannel }

  /** Build one tool. `isReadOnly`/`isConcurrencySafe` are set per the tool's
   *  observable side-effect surface (see per-call sites below). */
  const make = <I, S>(
    name: string,
    description: string,
    inputSchema: Tool<I>["inputSchema"],
    readOnly: boolean,
    concurrencySafe: boolean,
    renderSuccess: SuccessRender<S>,
    // S16: when a tool accepts a raw shell command, it exposes it here so the
    // permission policy applies the HARD_DENY denylist UNIFORMLY (mirrors
    // `bash`/`test_runner`). The dispatch seam reads `tool.extractShellCommand`
    // and populates `action.shellCommand`; omitting it (the common case for
    // non-shell tools) keeps the tool surface byte-identical.
    extractShellCommand?: (input: I) => string | null,
  ): Tool<I> => ({
    name,
    description,
    inputSchema,
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => concurrencySafe,
    ...(extractShellCommand !== undefined ? { extractShellCommand } : {}),
    async *execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const out = (await dispatchSubagent6(
        name,
        input,
        withCtxSignal(wired, ctx),
      )) as DispatchOutput
      yield toEvent<S>(out, renderSuccess)
    },
  })

  const tools: Tool[] = [
    // exec_command — runs a child process; classified MUTATING (a shell
    // command can write files / spawn processes). NOT concurrency-safe: a
    // command may touch shared state and a `pty:true` launch mutates the PTY
    // table; serialize it like the trio's `task_stop`.
    make<unknown, ExecCommandOutput & { kind: "success" }>(
      "exec_command",
      "Run a single shell command synchronously (optionally allocating a PTY for follow-up write_stdin).",
      ExecCommandInputSchema,
      false,
      false,
      (s) => {
        const pidLine = s.pid !== undefined ? `\npid: ${s.pid} (PTY retained)` : ""
        return `exit ${s.exitCode}${pidLine}\n--- stdout ---\n${s.stdout}\n--- stderr ---\n${s.stderr}`
      },
      // S16: exec_command runs a model-supplied shell line through Bun.spawn,
      // so it MUST face the SAME HARD_DENY denylist as `bash`. Read `command`
      // off the raw input (the schema guarantees a string post-parse; the
      // permission gate runs pre-dispatch on the raw value, hence the guard).
      (input) => {
        const command = (input as { command?: unknown }).command
        return typeof command === "string" ? command : ""
      },
    ) as Tool,

    // write_stdin — feeds bytes to a live PTY; MUTATING + NOT concurrency-safe
    // (orders bytes into a single child's stdin).
    make<unknown, WriteStdinOutput & { kind: "success" }>(
      "write_stdin",
      "Write bytes to the stdin of a long-running PTY started by exec_command.",
      WriteStdinInputSchema,
      false,
      false,
      (s) => `wrote ${s.bytesWritten} bytes`,
    ) as Tool,

    // spawn_agent — launches a child loop. Mirrors the trio `agent` tool's
    // classification: MUTATING (the child owns an unrestricted tool set) but
    // CONCURRENCY-SAFE (each spawn returns immediately and shares no mutable
    // state with siblings — fan-out is the whole point).
    make<unknown, SpawnAgentOutput & { kind: "success" }>(
      "spawn_agent",
      spawnAgent6Description(),
      SpawnAgentInputSchema,
      false,
      true,
      // S17 (jul-7 audit): surface the owner_token to the OWNER so it can authorize a
      // later close_agent. A sibling that only harvests the agentId (via list_agents)
      // has no token ⇒ close_agent DENIES it. Host cleanup uses an out-of-band authority.
      (s) =>
        s.ownerToken !== undefined
          ? `spawned agentId: ${s.agentId} (owner_token: ${s.ownerToken} — pass this to close_agent to cancel it)`
          : `spawned agentId: ${s.agentId}`,
    ) as Tool,

    // wait_agent — blocks until a child settles; READ-ONLY (observes registry
    // state, mutates nothing) + CONCURRENCY-SAFE (mirrors the trio's
    // `task_output`, which is read-only + concurrency-safe).
    make<unknown, WaitAgentOutput & { kind: "success" }>(
      "wait_agent",
      "Block (optionally with timeout) for a child subagent to reach a terminal state.",
      WaitAgentInputSchema,
      true,
      true,
      (s) => `status: ${s.status} (${s.turns} turns)\n${s.finalText}`,
    ) as Tool,

    // close_agent — terminates a child; MUTATING + NOT concurrency-safe
    // (mirrors the trio's `task_stop`).
    make<unknown, CloseAgentOutput & { kind: "success" }>(
      "close_agent",
      "Terminate a running child subagent (idempotent on already-settled agents).",
      CloseAgentInputSchema,
      false,
      false,
      (s) => (s.wasRunning ? "agent terminated" : "agent was already settled (no-op)"),
    ) as Tool,

    // send_input — delivers a conversational message to a paused child;
    // MUTATING + NOT concurrency-safe (one-shot delivery into a child's loop).
    make<unknown, SendInputOutput & { kind: "success" }>(
      "send_input",
      "Forward a user-supplied conversational message to a paused child subagent.",
      SendInputInputSchema,
      false,
      false,
      () => "input delivered",
    ) as Tool,
  ]

  return {
    tools,
    cleanup: () => {
      ptyTable.closeAll()
    },
  }
}
