/**
 * `session_config` tool — read (and selectively mutate) the agent's own SDK
 * posture. Closes the visibility gap surfaced by users asking "thinking 모드
 * 몇으로 되어있노?" — the agent could not previously answer because nothing in
 * its tool set exposed `sessionEffort` / permission-mode / identity-mode /
 * tool-profile / model.
 *
 * Operations:
 *   - `get`         → snapshot of effort tier (+ token budget), permission
 *                     mode, identity mode, tool profile, model id, provider.
 *                     Read-only.
 *   - `set_effort`  → mutate the session effort tier ("low"/"medium"/"high"/
 *                     "max"/"default"). Mirrors what `/effort` already lets a
 *                     human operator do; persists across turns via the same
 *                     EffortStore (the seam carries `writeEffort`, not the
 *                     store itself, so the tool stays slice-fenced).
 *
 * Authority boundary:
 *   - ONLY effort is writable here. Permission mode / identity mode / tool
 *     profile are authority-bearing operator surfaces (`session.permission.set`,
 *     `/identity`, `/profile`, etc.). Letting the model mutate them through its
 *     own tool call path would create a self-escalation seam, so this tool
 *     exposes those fields READ-ONLY on purpose.
 *
 * Wiring:
 *   - The tool is registered unconditionally in `buildDefaultTools` and
 *     reads `ctx.sessionConfig` (the duck-typed seam). When the host has not
 *     wired the seam, every `op` returns `ok:false` with a typed
 *     `not_wired` failure — byte-identical to the pre-ADR posture (a session
 *     that never calls the tool sees no behavioral change either way).
 *   - Dispatch (`buildToolContext` in `@/agent/dispatch.ts`) maps
 *     `AgentConfig.sessionConfigPort` → `ToolContext.sessionConfig`. The
 *     composition root (CLI bootstrap-session) builds the port from the
 *     pre-existing `effortStore` + `permissionModeState` +
 *     `identityModeState` + `toolProfileState` + runtime model/provider.
 *
 * Slice posture (RFC §3.1):
 *   - Imports `zod` and the local `./types`. NO `@/agent`, `@/permission`,
 *     `@/memory`, `@/llm`. EffortLevel literals are duplicated as a closed
 *     zod enum so this file does not import `@/agent/effort` — the seam is
 *     structural and the literals are stable (extending the EffortLevel union
 *     requires a coordinated change at both consumers, enforced by the unit
 *     test in `tests/unit/tool/session-config-effort-parity.test.ts`).
 *   - No-throw: every failure mode yields a typed `ok:false` `ToolResult`.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { SessionConfigSeam, Tool, ToolContext, ToolEvent, ToolResult } from "./types"

export type { SessionConfigSeam }

/** Closed enum of effort tiers. Mirror of `@/agent/effort#EffortLevel` —
 *  duplicated here to keep the `@/tool` slice from importing `@/agent`. */
export const SESSION_CONFIG_EFFORT_LEVELS = ["default", "max", "high", "medium", "low"] as const
export type SessionConfigEffortLevel = (typeof SESSION_CONFIG_EFFORT_LEVELS)[number]

/** Token-budget mapping mirror of `effortToTokenBudget`. Used only for the
 *  human-readable `get` rendering; the actual budget is computed by the loop
 *  via `@/agent/effort#effortToTokenBudget` at LLMInput build time. */
const EFFORT_TOKEN_BUDGET: Readonly<Record<SessionConfigEffortLevel, number | undefined>> = {
  default: undefined,
  low: 1024,
  medium: 4096,
  high: 16384,
  max: 64000,
}

/** Closed input schema. The shape is a tagged-union over `op`:
 *    - `{ op: "get" }`           → snapshot
 *    - `{ op: "set_effort", level }` → mutate effort
 *  Zod's `discriminatedUnion` makes the level field required ONLY for
 *  `set_effort` (and forbidden on `get`), preventing accidental no-op
 *  mutations. */
export const sessionConfigInputSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("get"),
    })
    .describe(
      "Return the current SDK posture (effort, permission mode, identity mode, " +
        "tool profile, model, provider).",
    ),
  z
    .object({
      op: z.literal("set_effort"),
      level: z
        .enum(SESSION_CONFIG_EFFORT_LEVELS)
        .describe("Target effort tier. Mirrors the `/effort` slash command's accept-list."),
    })
    .describe(
      "Change the session effort tier. Applies from the NEXT turn (the loop " +
        "re-reads `sessionEffort` at the top of each turn). Mirrors the operator " +
        "`/effort` command — use sparingly, e.g. to bump effort on a stuck task.",
    ),
])
export type SessionConfigInput = z.infer<typeof sessionConfigInputSchema>

/** Format a token count with thousands separators, deterministically (no
 *  locale dependence — important for snapshot tests + LLM determinism). */
const fmtThousands = (n: number): string => {
  // Manual grouping; `toLocaleString` is locale-sensitive and would drift on
  // ja_JP / fr_FR / etc.
  const s = String(Math.trunc(Math.abs(n)))
  let out = ""
  for (let i = 0; i < s.length; i++) {
    out += s[i]
    const left = s.length - 1 - i
    if (left > 0 && left % 3 === 0) out += ","
  }
  return n < 0 ? `-${out}` : out
}

/** Render the budget suffix verbosely — distinct visual treatments for
 *  "no override" vs "explicit cap" so the snapshot is self-describing. */
const fmtBudget = (level: SessionConfigEffortLevel): string => {
  const b = EFFORT_TOKEN_BUDGET[level]
  return b === undefined
    ? "thinking budget: provider default"
    : `thinking budget: ${fmtThousands(b)} tokens`
}

/** Internal record fed to the renderer — kept narrow so the section is
 *  trivially extensible (just add to the array; the formatter pads). */
type Row = { readonly label: string; readonly value: string }

/** Header rule width — small fixed value keeps lines under typical terminal
 *  widths even for the longest label/value pair we emit today. The hairline
 *  `─` is a single Unicode codepoint so width math stays trivial. */
const RULE = "────────────────────────────────────────"

/** Render a section by:
 *   1. computing the longest label (left column),
 *   2. emitting a top rule `── <title> ─…`,
 *   3. padding each label, joining with two spaces + value,
 *   4. emitting a closing rule.
 *  Pure helper — exported in spirit (file-local) for both `get` and `set`. */
const renderSection = (title: string, rows: readonly Row[], footer?: string): string => {
  if (rows.length === 0) return `── ${title} ${RULE}`
  const labelWidth = rows.reduce((acc, r) => Math.max(acc, r.label.length), 0)
  const body = rows.map((r) => `  ${r.label.padEnd(labelWidth)}  ${r.value}`)
  const lines: string[] = []
  lines.push(`── ${title} ${RULE.slice(0, Math.max(0, RULE.length - title.length - 1))}`)
  lines.push(...body)
  if (footer !== undefined) lines.push(`  ${footer}`)
  return lines.join("\n")
}

const renderSnapshot = (seam: SessionConfigSeam): string => {
  const effort = seam.readEffort()
  const rows: Row[] = []
  rows.push({ label: "effort", value: `${effort}  ·  ${fmtBudget(effort)}` })
  const permission = seam.readPermissionMode?.()
  if (permission !== undefined && permission !== "") {
    rows.push({ label: "permission mode", value: permission })
  }
  const mode = seam.readIdentityMode?.()
  if (mode !== undefined && mode !== "") rows.push({ label: "identity mode", value: mode })
  const profile = seam.readToolProfile?.()
  if (profile !== undefined && profile !== "") rows.push({ label: "tool profile", value: profile })
  const model = seam.readModel?.()
  if (model !== undefined && model !== "") rows.push({ label: "model", value: model })
  const provider = seam.readProvider?.()
  if (provider !== undefined && provider !== "") rows.push({ label: "provider", value: provider })
  return renderSection("session_config", rows)
}

const renderSetResult = (
  prev: SessionConfigEffortLevel,
  next: SessionConfigEffortLevel,
): string => {
  if (prev === next) {
    return renderSection(
      "session_config · set_effort",
      [
        { label: "effort", value: `${next}  (unchanged)` },
        { label: "", value: fmtBudget(next) },
      ],
      "no-op: session was already at this tier.",
    )
  }
  return renderSection(
    "session_config · set_effort",
    [
      { label: "effort", value: `${prev}  →  ${next}` },
      { label: "", value: fmtBudget(next) },
    ],
    "applies from the next turn.",
  )
}

/** Build the result for the "no seam wired" branch — shared between `get`
 *  and `set_effort` so the message stays consistent. */
const unwiredResult = (op: SessionConfigInput["op"]): ToolResult => ({
  ok: false,
  output:
    `session_config: ${op} unavailable — the host did not wire a session-config seam ` +
    "in this session. (Composition root must set `AgentConfig.sessionConfigPort`.)",
  failure: { mode: "rejected", reason: "not_wired" },
})

/** Tool factory. No arguments — the seam is read off `ctx.sessionConfig` at
 *  call time (so a host that wires it AFTER `buildDefaultTools` still works).
 *  Read/write split:
 *    - `op: "get"`        → `isReadOnly() === true` would be tempting, but
 *                            the union also carries `set_effort`. The Tool
 *                            interface lacks per-call readonly classification,
 *                            so we declare the tool MUTATING. The plan-mode
 *                            gate (`@/agent/admissibility`) blocks
 *                            `set_effort` in `plan` posture; `get` callers
 *                            running in `plan` will get a dispatch-time deny
 *                            with a clear message ("use /effort" stays valid).
 *    - `op: "set_effort"` → mutating; the seam invokes the EffortStore
 *                            setter. */
export const sessionConfigTool: Tool<SessionConfigInput> = {
  name: "session_config",
  description:
    "Read the agent's own SDK posture (effort tier, permission mode, identity " +
    "mode, tool profile, model, provider) or change the effort tier. `op:get` " +
    "returns a plain-text snapshot; `op:set_effort` mutates the session effort " +
    "(mirrors the operator `/effort` slash command). Permission/identity/tool-" +
    "profile posture stays read-only here so the model cannot self-escalate " +
    "authority. Use this when asked 'what mode am I in?' or when a task is " +
    "stuck and a higher effort would help.",
  inputSchema: sessionConfigInputSchema,
  // Structurally mutating because of `set_effort`, and the Tool contract has no
  // per-call read-only classification, so both plan layers block it — `op:get`
  // included — as the docstring above says. `MUTATING_TOOL_TABLE` classifies it
  // `working_state_write` so the collaboration-mode layer agrees with the agent-mode
  // one. (A previous edit to this comment claimed plan mode ALLOWS it; that was true
  // of the collaboration layer only, and only because the table then said `null`.)
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async *execute(input: SessionConfigInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    if (ctx.signal.aborted) {
      const result: ToolResult = {
        ok: false,
        output: "session_config: aborted before start",
        failure: { mode: "rejected", reason: "aborted" },
      }
      yield { type: "result", result }
      return
    }
    const seam = ctx.sessionConfig
    if (seam === undefined) {
      yield { type: "result", result: unwiredResult(input.op) }
      return
    }
    if (input.op === "get") {
      let output: string
      try {
        output = renderSnapshot(seam)
      } catch (e) {
        const msg = errMessage(e)
        const result: ToolResult = {
          ok: false,
          output: `session_config: snapshot read failed: ${msg}`,
          failure: { mode: "error", modelVisibleError: msg },
        }
        yield { type: "result", result }
        return
      }
      yield { type: "result", result: { ok: true, output } }
      return
    }
    // input.op === "set_effort"
    let prev: SessionConfigEffortLevel
    try {
      prev = seam.readEffort()
    } catch (e) {
      const msg = errMessage(e)
      const result: ToolResult = {
        ok: false,
        output: `session_config: pre-write read failed: ${msg}`,
        failure: { mode: "error", modelVisibleError: msg },
      }
      yield { type: "result", result }
      return
    }
    try {
      seam.writeEffort(input.level)
    } catch (e) {
      const msg = errMessage(e)
      const result: ToolResult = {
        ok: false,
        output: `session_config: write failed: ${msg}`,
        failure: { mode: "error", modelVisibleError: msg },
      }
      yield { type: "result", result }
      return
    }
    yield { type: "result", result: { ok: true, output: renderSetResult(prev, input.level) } }
  },
}
