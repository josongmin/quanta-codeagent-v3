/**
 * `node_repl` — agent-callable front door to the ADR-0249 persistent Node REPL
 * kernel (`@/runtime/node-repl`).
 *
 * DISTINCT FROM `code_cell` (code-mode): code-mode runs model-authored JS in a
 * ONE-SHOT QuickJS-WASM sandbox whose every `tools.X()` re-enters the real
 * `dispatchTool` — it is a tool-COMPOSITION surface with NO cross-call state and
 * NO real Node runtime. `node_repl` is a long-lived REAL `node -i` subprocess
 * whose variable bindings PERSIST across calls (`let x = 42` then a later
 * `x` → `42`), with FULL Node.js access (fs, net, require). Two different
 * capabilities; neither subsumes the other.
 *
 * SECURITY: evaluating arbitrary Node code IS arbitrary code execution (full
 * host access — no WASM jail). So the tool is:
 *   - default-OFF: registered ONLY when `DefaultToolPorts.nodeRepl` is wired
 *     (composition root sets it iff `QUANTA_NODE_REPL` is on). Absent ⇒ the
 *     tool never enters the menu (byte-identical).
 *   - `hitlTier: "always-confirm"` — EVERY call needs approval, exactly like
 *     `bash` / `debug_inspect`. There is no per-input relaxation.
 * NEVER throws: the kernel port is no-throw (`Result<…, KernelError>`); a spawn
 * / eval / abort fault collapses to an `ok:false` tool_result.
 *
 * Fence: this leaf imports ONLY `zod`, `@/shared`, and the `@/runtime/node-repl`
 * port/types (the SAME deep-import direction `default-tool-ports.ts` already
 * uses for `@/runtime`). The concrete STATEFUL kernel is INJECTED (closed-port
 * DI) so a test drives the whole tool over the deterministic `headlessStub`
 * with no real subprocess.
 */

import { z } from "zod"
import type { KernelId, NodeReplKernel } from "@/runtime/node-repl"
import { errMessage } from "@/shared"
import type { CoreToolContext, Tool, ToolEvent } from "../types"

const schema = z.object({
  op: z
    .enum(["exec", "list", "status", "kill"])
    .describe(
      "exec = evaluate `code` in the session's persistent Node kernel (auto-spawns on first use; variables/bindings persist across calls). list = enumerate live kernels. status = report one kernel's state. kill = terminate a kernel.",
    ),
  code: z
    .string()
    .optional()
    .describe(
      "JS/Node source to evaluate. REQUIRED for op:'exec'. Variables declared here persist into later exec calls in the same session.",
    ),
  id: z
    .string()
    .optional()
    .describe(
      "Target kernel id (from op:'list'). Optional for op:'exec' (defaults to the session's own kernel); REQUIRED for op:'kill'/'status'.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-exec wall-clock cap (ms). Omit for the kernel default."),
})
type Input = z.infer<typeof schema>

const fail = (output: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output, failure: { mode: "error", modelVisibleError: output } },
})

const okEvent = (output: string, ok = true): ToolEvent => ({
  type: "result",
  result: { ok, output },
})

/** Render a `KernelError` to a compact, model-readable line. */
const renderKernelError = (e: {
  kind: string
  detail?: string
  id?: string
  raw?: string
}): string => {
  switch (e.kind) {
    case "node-missing":
      return `node_repl: node binary not found on PATH (${e.detail ?? ""}). Install Node or ensure it is on PATH.`
    case "spawn-failed":
      return `node_repl: kernel spawn failed (${e.detail ?? ""}).`
    case "kernel-dead":
      return `node_repl: kernel ${e.id ?? "?"} is dead (process exited). Re-run to spawn a fresh one.`
    case "exec-aborted":
      return `node_repl: exec aborted for kernel ${e.id ?? "?"}.`
    case "invalid-id":
      return `node_repl: invalid kernel id ${JSON.stringify(e.raw ?? "")}.`
    default:
      return `node_repl: kernel error (${e.kind}).`
  }
}

/** A mutable one-field holder for the session's own kernel id — threaded to the
 *  op handlers so `kill` can clear it (forcing a re-spawn on the next exec) and
 *  `exec` can lazily populate it. */
interface SessionSlot {
  id: KernelId | undefined
}

/** Lazily spawn (once) the session's own kernel — the variable-persistence unit.
 *  Returns the existing id when already spawned; a typed message on spawn error
 *  (never throws). */
const ensureSessionKernel = async (
  kernel: NodeReplKernel,
  slot: SessionSlot,
  ctx: CoreToolContext,
): Promise<{ ok: true; id: KernelId } | { ok: false; output: string }> => {
  if (slot.id !== undefined) return { ok: true, id: slot.id }
  const spawned = await kernel.spawn({
    // No sessionId seam on ToolContext — use the stable per-turn id when present,
    // else a constant. Provenance metadata on the persisted handle only; the
    // kernel keys by the generated `id`.
    sessionId: ctx.turnId ?? "node_repl",
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  })
  if (!spawned.ok) return { ok: false, output: renderKernelError(spawned.error) }
  slot.id = spawned.value.id
  return { ok: true, id: slot.id }
}

/** op:'list' — enumerate live kernels. */
const handleList = (kernel: NodeReplKernel): ToolEvent => {
  const rows = kernel.list()
  if (rows.length === 0) return okEvent("node_repl: no live kernels.")
  const lines = rows.map(
    (r) => `${r.spec.id}\tstate=${r.state}\tinUse=${r.inUse}\tpid=${r.spec.pid}`,
  )
  return okEvent(`node_repl kernels:\n${lines.join("\n")}`)
}

/** op:'status' — report one kernel's state (requires an explicit id). */
const handleStatus = (kernel: NodeReplKernel, id: string | undefined): ToolEvent => {
  if (id === undefined || id === "")
    return fail("node_repl: op:'status' requires `id` (from op:'list').")
  return okEvent(`node_repl: kernel ${id} state=${kernel.status(id as KernelId)}`)
}

/** op:'kill' — terminate one kernel; clears the session slot when it was ours. */
const handleKill = async (
  kernel: NodeReplKernel,
  slot: SessionSlot,
  id: string | undefined,
): Promise<ToolEvent> => {
  if (id === undefined || id === "")
    return fail("node_repl: op:'kill' requires `id` (from op:'list').")
  await kernel.kill(id as KernelId)
  if (id === slot.id) slot.id = undefined // forget ⇒ next exec re-spawns
  return okEvent(`node_repl: killed kernel ${id}.`)
}

/** op:'exec' — evaluate `code` in a kernel (the session's own by default). */
const handleExec = async (
  kernel: NodeReplKernel,
  slot: SessionSlot,
  input: Input,
  ctx: CoreToolContext,
): Promise<ToolEvent> => {
  if (input.code === undefined || input.code === "")
    return fail("node_repl: op:'exec' requires non-empty `code`.")
  // An explicit `id` targets a specific kernel; otherwise reuse/spawn the
  // session's own kernel (the variable-persistence path).
  let targetId: KernelId
  if (input.id !== undefined && input.id !== "") {
    targetId = input.id as KernelId
  } else {
    const ensured = await ensureSessionKernel(kernel, slot, ctx)
    if (!ensured.ok) return fail(ensured.output)
    targetId = ensured.id
  }
  try {
    const result = await kernel.exec(targetId, input.code, {
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    })
    if (!result.ok) return fail(renderKernelError(result.error))
    const { stdout, stderr, hadError } = result.value
    const body = [
      stdout.length > 0 ? stdout : "(no stdout)",
      stderr.length > 0 ? `\n[stderr]\n${stderr}` : "",
    ].join("")
    // hadError ⇒ the eval reported to stderr / threw; surface as ok:false so the
    // model treats it as a failing evaluation (not a tool crash).
    return okEvent(body, hadError !== true)
  } catch (e) {
    // Belt-and-braces: the port is no-throw by contract, but a pathological throw
    // must still collapse to a tool_result, never a host fault.
    return fail(`node_repl: unexpected failure — ${errMessage(e)}`)
  }
}

/**
 * Build `node_repl` over an INJECTED persistent kernel port. The tool keeps a
 * single per-session kernel handle in a closure (`slot`) so that repeated
 * `op:'exec'` calls WITHOUT an explicit `id` reuse the SAME live process — that
 * is where the variable persistence lives. `spawn` is called lazily on the first
 * exec (nothing spawns at registration time, so an OFF or never-exercised session
 * touches no subprocess).
 */
export const makeNodeReplTool = (kernel: NodeReplKernel): Tool<Input> => {
  // One slot per tool instance ⇒ one per session (the composition root mints one
  // kernel + one tool per session).
  const slot: SessionSlot = { id: undefined }

  return {
    name: "node_repl",
    description:
      "Evaluate code in a PERSISTENT Node.js REPL kernel — a live `node -i` subprocess whose variable bindings survive across calls (`let x = 42` now, then `x` → `42` later). Full Node runtime (fs / require / async). Distinct from code_cell (one-shot WASM sandbox with NO persistent state). op:'exec' evaluates `code` in the session kernel (auto-spawned on first use); op:'list'/'status'/'kill' manage kernels. HIGH RISK: runs arbitrary Node code with full host access ⇒ always-confirm. Never throws — spawn/eval/abort faults return ok:false.",
    inputSchema: schema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // Arbitrary Node code exec (full host access, no sandbox) ⇒ confirm every call.
    hitlTier: (): "always-confirm" => "always-confirm",

    async *execute(input: Input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
      if (ctx.signal?.aborted === true) {
        yield fail("node_repl: aborted before start")
        return
      }
      switch (input.op) {
        case "list":
          yield handleList(kernel)
          return
        case "status":
          yield handleStatus(kernel, input.id)
          return
        case "kill":
          yield await handleKill(kernel, slot, input.id)
          return
        case "exec":
          yield await handleExec(kernel, slot, input, ctx)
          return
      }
    },
  }
}
