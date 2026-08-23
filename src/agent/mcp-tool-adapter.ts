import { z } from "zod"
import {
  clientTasksPort,
  type McpCallResult,
  type McpClient,
  McpError,
  type McpProgress,
  type McpProgressHandler,
  type McpReconnectSupervisor,
  type McpToolDef,
  tasksPortOver,
} from "@/mcp"
import { errMessage, sliceWholeChars } from "@/shared"
import {
  mcpTasksTools,
  type TasksHandle,
  type Tool,
  type ToolContext,
  type ToolEvent,
} from "@/tool"
import { neutralizeTerminalOutput } from "@/tool/terminal-sanitize"
import { toToolResult } from "./mcp-media-guard"

/**
 * MCP TOOL ADAPTER — one MCP server surface ⇒ native `Tool` objects.
 *
 * ONE responsibility: convert what an MCP server EXPOSES into what the agent
 * loop CALLS. That is the bridged tool name, the passthrough input schema, the
 * §19.1 annotation trust gate that derives `isReadOnly`/`isConcurrencySafe`, the
 * §19.4 streaming `tools/call` driver that relays inbound progress, and the
 * ADR-0431 `tasks/*` capability bridge — each in both the single-client and the
 * ADR-0435 supervised (auto-restart) flavor, which MUST stay shape-identical.
 *
 * It knows nothing about lifecycle: starting servers, wiring inbound
 * capabilities, and aggregating clients stay in `mcp-bridge.ts`, which re-exports
 * this module's public names so no consumer import path changes.
 *
 * Split out of `mcp-bridge.ts` (god-module ratchet) — pure move, no behavior
 * change.
 */

/** `mcp__<server>__<tool>`, sanitized so the name is a safe identifier. */
export const mcpToolName = (server: string, tool: string): string => {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_]+/g, "_")
  return `mcp__${clean(server)}__${clean(tool)}`
}

/** Ceiling on a server-supplied tool description, in UTF-16 code units.
 *
 *  The description is UNTRUSTED third-party text that is re-sent to the model
 *  on EVERY request, so an unbounded one is a context/cost DoS (and the wire
 *  codecs pass it through verbatim). 4096 mirrors `MAX_USER_CONFIG_VALUE_LEN`
 *  in `src/plugin-isolation/dxt-user-config.ts` — this repo's existing ceiling
 *  for a single untrusted third-party string — and is ~7.6x the LONGEST
 *  description this repo itself ships (535 chars, `src/tool/node-repl`), so a
 *  legitimate server is not clipped. */
export const MAX_TOOL_DESCRIPTION_CHARS = 4096

/** Truncation is DISCLOSED to the model, never silent (idiom shared with
 *  `src/runner/batch/eval/llm-candidate-select.ts`). */
const TRUNCATION_MARKER = "\n…(truncated)"

/** Make a server-declared `description` safe to splice into the model's
 *  tool-definition block: defuse control bytes, then bound the length.
 *
 *  The sibling `mcpToolName` already sanitizes the server-supplied NAME; the
 *  description had no guard at all, so raw ANSI/C0, the 8-bit C1 introducers,
 *  bidi overrides, zero-width characters (invisible in every human-facing tool
 *  listing, fully legible to the model) and lone surrogates all flowed
 *  straight through. We reuse `@/tool` {@link neutralizeTerminalOutput} — the
 *  house defence for untrusted text spliced into the model transcript — which
 *  DEFANGS to a visible caret form (`^[`) instead of deleting, so the model
 *  still reads what the server meant and an auditor can see the escape, while
 *  PRESERVING `\n`/`\t` so a legitimate multi-line description renders
 *  byte-identically. Neutralize runs BEFORE the cap so truncation only ever
 *  measures already-defanged text (the contract documented on that helper);
 *  `sliceWholeChars` keeps the cut off a surrogate pair.
 *
 *  DELIBERATELY OUT OF SCOPE: semantic prompt-injection isolation (delimiters,
 *  refusal wrappers). That changes the tool MENU the model reads and is a
 *  product decision, not a mechanical safety fix. */
const safeDescription = (description: string): string => {
  const neutralized = neutralizeTerminalOutput(description)
  return neutralized.length <= MAX_TOOL_DESCRIPTION_CHARS
    ? neutralized
    : `${sliceWholeChars(neutralized, MAX_TOOL_DESCRIPTION_CHARS)}${TRUNCATION_MARKER}`
}

/**
 * Build a minimal passthrough zod schema for an MCP tool. We do not attempt to
 * faithfully reproduce arbitrary JSON Schema (over-engineering, RFC §1.2); we
 * accept any object and require the schema's declared top-level `required`
 * keys when present so obviously-wrong calls are rejected before dispatch.
 */
const passthroughSchema = (jsonSchema: Record<string, unknown>): z.ZodType<unknown> => {
  const required = Array.isArray(jsonSchema.required)
    ? (jsonSchema.required as unknown[]).filter((k): k is string => typeof k === "string")
    : []
  const base = z.record(z.unknown())
  if (required.length === 0) return base
  // z.unknown() also matches `undefined`, so an object schema would not truly
  // enforce presence. Refine instead: every declared required key must exist.
  return base.refine(
    (obj) => required.every((k) => obj[k] !== undefined),
    (obj) => ({
      message: `missing required field(s): ${required.filter((k) => obj[k] === undefined).join(", ")}`,
    }),
  )
}

const isMcpError = (e: unknown): e is McpError => e instanceof McpError

/** §19.1 — the per-server gate that authorizes HONORING a tool's self-declared
 *  annotations. Both signals are required and BOTH fail-closed:
 *   - `annotationsHonored` — the `QUANTA_MCP_TOOL_ANNOTATIONS` knob is ON.
 *   - `trusted` — the host marked THIS server trusted (`McpServerConfig.trusted`).
 *
 *  Absent ⇒ `{ annotationsHonored:false, trusted:false }` (the default), which is
 *  byte-identical to the pre-§19.1 bridge: every MCP tool stays
 *  `isReadOnly:()=>false, isConcurrencySafe:()=>false`. */
export interface McpToolBindOpts {
  /** `QUANTA_MCP_TOOL_ANNOTATIONS` knob — global default-OFF master switch. */
  readonly annotationsHonored?: boolean
  /** `McpServerConfig.trusted` — this server is host-vetted. */
  readonly trusted?: boolean
  /** §19.4 — opt IN to streaming `notifications/progress`. DEFAULT-OFF: when
   *  absent/false the bridge passes NO `onProgress`, so `callTool` mints no
   *  `progressToken` and the `tools/call` wire carries NO `_meta` — byte-
   *  identical to the pre-§19.4 request (a strict server never sees an
   *  unexpected `_meta`). On ⇒ inbound progress relays as `ToolEvent.progress`. */
  readonly progress?: boolean
}

/** §19.1 — derive the `{ isReadOnly, isConcurrencySafe }` predicates for an MCP
 *  tool from its sanitized annotations under the trust gate.
 *
 *  `honored = annotationsHonored && trusted`. Annotations may ONLY ELEVATE (and
 *  only for a trusted server with the knob on); they can NEVER downgrade safety:
 *   - `isReadOnly = honored && readOnlyHint === true`
 *   - `isConcurrencySafe = honored && readOnlyHint === true && idempotentHint !== false`
 *
 *  When `honored` is false — knob off, untrusted server, OR no annotations — both
 *  predicates are `false`, byte-identical to the conservative legacy default (so
 *  an untrusted server's `readOnlyHint:true` can NOT escape HITL or run in
 *  parallel). Because `sanitizeAnnotations` already dropped non-boolean hints, a
 *  poisoned `readOnlyHint:"true"` arrives as `undefined` here ⇒ `=== true` is
 *  false ⇒ the tool stays mutating. */
const annotationPredicates = (
  def: McpToolDef,
  opts: McpToolBindOpts | undefined,
): { isReadOnly: boolean; isConcurrencySafe: boolean } => {
  const honored = opts?.annotationsHonored === true && opts?.trusted === true
  if (!honored) return { isReadOnly: false, isConcurrencySafe: false }
  const ann = def.annotations
  const isReadOnly = ann?.readOnlyHint === true
  const isConcurrencySafe = isReadOnly && ann?.idempotentHint !== false
  return { isReadOnly, isConcurrencySafe }
}
/** §19.4 — render an inbound progress tick into a one-line tool progress
 *  message: `<server> <tool>: <progress>[/<total>][ (NN%)][ — message]`. */
const formatProgress = (serverName: string, toolName: string, p: McpProgress): string => {
  const frac = p.total !== undefined ? `${p.progress}/${p.total}` : `${p.progress}`
  const pct =
    p.total !== undefined && p.total > 0 ? ` (${Math.round((p.progress / p.total) * 100)}%)` : ""
  const msg = p.message !== undefined ? ` — ${p.message}` : ""
  return `${serverName} ${toolName}: ${frac}${pct}${msg}`
}

/** §19.4 — drive ONE `tools/call` as a streaming generator: emit the opening
 *  "calling …" line, then relay every inbound `notifications/progress` as a
 *  `ToolEvent.progress` in real time, then the final result. `call` receives the
 *  per-call progress sink and returns the folded {@link McpCallResult}.
 *
 *  Producer/consumer: progress ticks arrive on the transport pump (the `call`
 *  promise's microtasks) and are buffered in `queue`; the generator drains the
 *  queue, then parks on a one-shot `wake` promise until the next tick OR
 *  settlement. A lost wakeup (tick pushed in the gap between drain and park) can
 *  only DELAY a tick to the next event — and `settle` ALWAYS fires `wake`, after
 *  which the final drain emits any straggler — so it can never deadlock or drop
 *  the result. A throwing call is mapped to a typed `ok:false` result (the
 *  dispatcher must never see a throw). */
async function* streamMcpCall(
  serverName: string,
  toolName: string,
  call: (onProgress: McpProgressHandler) => Promise<McpCallResult>,
): AsyncIterable<ToolEvent> {
  yield { type: "progress", message: `calling ${serverName} tool ${toolName}` }
  const queue: ToolEvent[] = []
  let wake: (() => void) | null = null
  let settled = false
  const fire = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  const onProgress: McpProgressHandler = (p) => {
    queue.push({ type: "progress", message: formatProgress(serverName, toolName, p) })
    fire()
  }
  // `Promise.resolve().then(call)` so even a SYNCHRONOUS throw inside `call`
  // (a non-async thunk) lands in the rejected branch → `ok:false` result,
  // never an exception out of this generator (the dispatcher's no-throw contract).
  const settledP = Promise.resolve()
    .then(() => call(onProgress))
    .then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    )
    .finally(() => {
      settled = true
      fire()
    })
  while (true) {
    while (queue.length > 0) {
      const ev = queue.shift()
      if (ev !== undefined) yield ev
    }
    if (settled) break
    await new Promise<void>((res) => {
      wake = res
    })
  }
  const outcome = await settledP
  if (outcome.ok) {
    yield { type: "result", result: toToolResult(outcome.r) }
  } else {
    const message = isMcpError(outcome.e) ? outcome.e.message : errMessage(outcome.e)
    yield { type: "result", result: { ok: false, output: message } }
  }
}

/** Adapt one MCP tool definition (on a started client) to our Tool interface.
 *
 *  §19.1 — `opts` carries the per-server annotation trust gate. Omitted (the
 *  default) ⇒ predicates are the conservative `false/false` and media is still
 *  surfaced (the §19.3 path is trust-independent — it only adds typed image/
 *  document blocks the model can see, never relaxes a permission predicate).
 *  §19.4 — the call streams inbound progress as `ToolEvent.progress`. */
export const mcpToolToTool = (
  client: McpClient,
  def: McpToolDef,
  serverName: string,
  opts?: McpToolBindOpts,
): Tool => {
  const name = mcpToolName(serverName, def.name)
  const schema = passthroughSchema(def.inputSchema)
  const { isReadOnly, isConcurrencySafe } = annotationPredicates(def, opts)
  return {
    name,
    description: safeDescription(def.description),
    inputSchema: schema,
    isReadOnly: () => isReadOnly,
    isConcurrencySafe: () => isConcurrencySafe,
    execute: (input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> =>
      streamMcpCall(serverName, def.name, (onProgress) =>
        // §19.4 default-OFF: forward the progress sink (⇒ `_meta.progressToken`
        // on the wire) ONLY when progress streaming is opted in. Off ⇒ no
        // `_meta`, byte-identical request.
        client.callTool(def.name, input, opts?.progress === true ? { onProgress } : undefined),
      ),
  }
}
/** ADR-0431 — adapt a live `McpClient` into the duck-typed `TasksHandle` the
 *  `@/tool` mcp_tasks tools consume. The slice fence forbids `@/tool` importing
 *  `@/mcp`, so the bridge (the assembler) is where the concrete `McpTasksPort`
 *  becomes the structural mirror. The two shapes are byte-identical by
 *  construction; any drift is a TYPE error here.
 *
 *  Returns the three tools ONLY when the connected server advertised the
 *  `tasks/*` capability in its `initialize` response (default-OFF). Absent ⇒
 *  empty array, so a server that does not speak tasks adds NO tools (the load
 *  is byte-identical to before this binding existed). */
export const tasksToolsFor = (client: McpClient): Tool[] => {
  if (!client.serverSupportsTasks()) return []
  // `McpTasksPort` and `TasksHandle` are structurally identical (the mirror is
  // maintained in lockstep); the assignment proves it at compile time.
  const handle: TasksHandle = clientTasksPort(client)
  return mcpTasksTools(handle)
}

/** ADR-0435 (follow-up) — supervisor-aware sibling of {@link tasksToolsFor}.
 *
 *  Instead of binding the tasks handle to a CONCRETE (mortal) `McpClient`, it
 *  builds the handle over the supervisor, whose `requestRaw`/`serverSupportsTasks`
 *  always re-resolve the CURRENT live client. So when auto-restart swaps the
 *  underlying client behind the stable supervisor, the once-built `mcp_task_*`
 *  tools keep working against the NEW client — no stale capture.
 *
 *  Gated exactly like the default path: tools are present ONLY when the current
 *  server advertises `capabilities.tasks` (`sup.serverSupportsTasks()`). A
 *  supervised server that does NOT advertise tasks ⇒ empty array (byte-identical
 *  to the pre-follow-up supervised path, which never bridged tasks at all). */
export const supervisedTasksToolsFor = (sup: McpReconnectSupervisor): Tool[] => {
  if (!sup.serverSupportsTasks()) return []
  // `tasksPortOver` captures the SUPERVISOR (a `TasksRpc`), not a client. Every
  // method dispatches a fresh `sup.requestRaw(...)`, which delegates to the live
  // client at call time — the restart-survival invariant.
  const handle: TasksHandle = tasksPortOver(sup)
  return mcpTasksTools(handle)
}

/**
 * Supervisor-aware variant of {@link mcpToolToTool} (ADR-0435). Instead of
 * capturing a single (mortal) client instance, it captures the supervisor and
 * routes every call through `sup.callTool`, which always delegates to the
 * current live client — surviving auto-restarts behind a stable tool name.
 *
 * The execute/yield/error-mapping shape is identical to {@link mcpToolToTool}
 * so the model sees the same result contract whether or not auto-restart is on.
 */
export const mcpToolToToolSupervised = (
  sup: McpReconnectSupervisor,
  def: McpToolDef,
  serverName: string,
  opts?: McpToolBindOpts,
): Tool => {
  const name = mcpToolName(serverName, def.name)
  const schema = passthroughSchema(def.inputSchema)
  const { isReadOnly, isConcurrencySafe } = annotationPredicates(def, opts)
  return {
    name,
    description: safeDescription(def.description),
    inputSchema: schema,
    isReadOnly: () => isReadOnly,
    isConcurrencySafe: () => isConcurrencySafe,
    execute: (input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> =>
      streamMcpCall(serverName, def.name, (onProgress) =>
        sup.callTool(def.name, input, opts?.progress === true ? { onProgress } : undefined),
      ),
  }
}
