/**
 * ADR-0296 — `bash_await`. Block until a background shell (registered by a
 * `timeout_behavior:"background"` bash call) either exits OR a regex matches
 * its combined stdout/stderr OR an optional `timeout_ms` elapses.
 *
 * Output contract (NEVER throws past the loop):
 *  - unknown shell_id ⇒ ok:false with typed `not_found` failure.
 *  - regex provided + matches ⇒ ok:true, status="running" or terminal, output
 *    includes the matched text and the buffered output so far.
 *  - shell exited (no regex / regex absent) ⇒ ok:true (with exitCode in
 *    evidence) or ok:false if exit ≠ 0.
 *  - timeout elapsed before match/exit ⇒ ok:false with typed
 *    `{ mode: "timeout" }` failure; `output` includes `outputSoFar`.
 *
 * Concurrency: pure polling against an in-memory registry; multiple awaits on
 * DIFFERENT ids run in parallel (`isConcurrencySafe: () => true`). Two awaits
 * on the SAME id are also concurrency-safe — the registry's `awaitHandle`
 * resolves each on the same state machine.
 */

import { z } from "zod"
import {
  type BashBgRegistry,
  type BgShellSnapshot,
  getBashBgRegistry,
} from "@/runtime/bash-bg-registry"
import type { Tool, ToolContext, ToolEvent, ToolResult, ToolResultEvidence } from "../types"

export const bashAwaitInputSchema = z.object({
  shell_id: z
    .string()
    .min(1)
    .describe("Background shell id (returned by bash with timeout_behavior=background)."),
  regex: z
    .string()
    .optional()
    .describe(
      "Optional regex (JS source, default flag `s`). When matched against the combined " +
        "stdout+stderr the await returns immediately. Absent ⇒ wait until exit.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional poll timeout in ms. When elapsed before exit/match the result is " +
        "ok:false with a typed timeout failure (outputSoFar carried).",
    ),
})
export type BashAwaitInput = z.infer<typeof bashAwaitInputSchema>

const STDERR_CAP = 4_000
const MAX_OUTPUT = 30_000

const tail = (s: string): string => (s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s)

const buildOutputSoFar = (snap: BgShellSnapshot): string =>
  [tail(snap.stdout), tail(snap.stderr)]
    .filter((s) => s.length > 0)
    .join("\n")
    .trimEnd()

const buildEvidence = (snap: BgShellSnapshot): ToolResultEvidence => ({
  ...(snap.stderr ? { stderr: snap.stderr.slice(-STDERR_CAP) } : {}),
  ...(snap.exitCode !== null ? { exitCode: snap.exitCode } : {}),
})

const compileRegexOrFail = (
  regex: string | undefined,
): { ok: true; compiled?: RegExp } | { ok: false; result: ToolResult } => {
  if (regex === undefined || regex.length === 0) return { ok: true }
  try {
    return { ok: true, compiled: new RegExp(regex, "s") }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      result: {
        ok: false,
        output: `bash_await: invalid regex — ${msg}`,
        failure: { mode: "error", modelVisibleError: msg },
      },
    }
  }
}

const buildTimeoutResult = (snap: BgShellSnapshot, timeoutMs: number | undefined): ToolResult => ({
  ok: false,
  output:
    `[bash_await await_timeout] shellId=${snap.id} (deadline ${timeoutMs ?? "∞"}ms)\n` +
    `--- output so far ---\n${buildOutputSoFar(snap) || "(no output yet)"}`,
  evidence: buildEvidence(snap),
  failure: { mode: "timeout", ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
})

const buildMatchResult = (snap: BgShellSnapshot): ToolResult => ({
  ok: true,
  output:
    `[bash_await match] shellId=${snap.id} status=${snap.status}\n` +
    `--- output so far ---\n${buildOutputSoFar(snap) || "(no output yet)"}`,
  evidence: buildEvidence(snap),
})

const buildExitedResult = (snap: BgShellSnapshot): ToolResult => {
  const exit = snap.exitCode ?? -1
  const status =
    snap.status === "killed" || snap.status === "aborted" ? snap.status : `exit ${exit}`
  return {
    ok: snap.status === "completed" && exit === 0,
    output:
      `[bash_await ${status}] shellId=${snap.id}\n` + `${buildOutputSoFar(snap) || "(no output)"}`,
    evidence: buildEvidence(snap),
  }
}

const buildOutcomeResult = (
  outcome: { snapshot: BgShellSnapshot; matched: boolean; timedOut: boolean },
  timeoutMs: number | undefined,
): ToolResult => {
  if (outcome.timedOut && !outcome.matched && outcome.snapshot.status === "running") {
    return buildTimeoutResult(outcome.snapshot, timeoutMs)
  }
  if (outcome.matched) {
    return buildMatchResult(outcome.snapshot)
  }
  return buildExitedResult(outcome.snapshot)
}

export const makeBashAwaitTool = (
  registry: BashBgRegistry = getBashBgRegistry(),
): Tool<BashAwaitInput> => ({
  name: "bash_await",
  description:
    "Block on a background shell (handle returned by bash timeout_behavior=background) " +
    "until it exits, an optional regex matches its combined stdout/stderr, or an " +
    "optional timeout_ms elapses. Returns a typed `not_found` failure for an unknown " +
    "shell_id; a typed `timeout` failure with outputSoFar when the deadline elapses.",
  inputSchema: bashAwaitInputSchema,
  isReadOnly: () => true,
  // Pure polling against an in-memory registry; safe to parallelize.
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = bashAwaitInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `bash_await: invalid input — ${parsed.error.message}`,
          failure: { mode: "error", modelVisibleError: parsed.error.message },
        },
      }
      return
    }
    const { shell_id, regex, timeout_ms } = parsed.data
    if (ctx.signal.aborted) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `bash_await: aborted before start`,
          failure: { mode: "rejected", reason: "user_cancelled" },
        },
      }
      return
    }
    const compileResult = compileRegexOrFail(regex)
    if (!compileResult.ok) {
      yield { type: "result", result: compileResult.result }
      return
    }
    const outcome = await registry.awaitHandle(shell_id, {
      ...(compileResult.compiled !== undefined ? { regex: compileResult.compiled } : {}),
      ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
      signal: ctx.signal,
    })
    if (outcome === null) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `bash_await: unknown shell_id=${shell_id}`,
          failure: { mode: "not_found" },
        },
      }
      return
    }
    yield { type: "result", result: buildOutcomeResult(outcome, timeout_ms) }
  },
})

/** Default-instance tool (uses the module-level singleton registry). */
export const bashAwaitTool: Tool<BashAwaitInput> = makeBashAwaitTool()
