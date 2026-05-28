/**
 * ADR-0401 — Default matcher composition.
 *
 * The default matcher is the union of six small per-tool matchers, each
 * named after the tool whose `post_tool_use` event it observes. Each leaf
 * matcher is a pure function `(event) ⇒ LedgerAction | null`:
 *
 *   - bash            : background-launch banner ⇒ start kind:"shell"
 *   - bash_await      : terminal exit            ⇒ settle completed|failed
 *   - bash_kill       : ok success               ⇒ settle stopped
 *   - agent           : background:true + task_id banner ⇒ start kind:"subagent"
 *   - task_output     : terminal status line     ⇒ settle completed|failed|stopped
 *   - task_stop       : ok success               ⇒ settle stopped
 *   - get_mcp_task    : terminal payload prefix  ⇒ settle completed|failed|stopped
 *   - cancel_mcp_task : ok success               ⇒ settle stopped
 *
 * Each leaf is DEFENSIVE: it validates every read against shape + type and
 * returns null on any mismatch. NO-THROW is enforced by a wrapper in
 * `createDefaultLedgerMatcher` (belt + braces — the leaves are already pure,
 * but a future leaf that uses a RegExp on user input can still throw on
 * pathological inputs, and we'd rather null out than break the hook bus).
 *
 * Parsing strategy: the `output` field carried on a `post_tool_use` event is
 * the post-redaction `preview` STRING the host sees. We match on substring +
 * narrow regex anchored on the literal banner each tool emits today. The
 * tests pin every banner verbatim so a tool author who changes a banner is
 * caught by CI (the matcher does NOT need to chase tool internals — it owns
 * the literal-banner contract).
 */

import type {
  DefaultLedgerMatcherOptions,
  LedgerAction,
  LedgerMatcher,
  ObservedToolEvent,
} from "./types"

/** Default owner stamped on a `start` action when the caller has not wired a
 *  threadId provider. Equally informative for log archaeology as `null`,
 *  without forcing the `RunEntry.owner` field into a nullable shape. */
const DEFAULT_OWNER = "unknown"

/** Title cap — pinned by the task_prompt-preview test and used uniformly
 *  across tool matchers so a UI sees a bounded title field regardless of
 *  source. */
const TITLE_MAX = 80

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

/** Pluck a string property from `obj` if present + a string + non-empty. */
const pickString = (obj: Record<string, unknown>, key: string): string | null => {
  const v = obj[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Pluck a non-empty string property from `obj` if present, trimmed. */
const pickStringTrimmed = (obj: Record<string, unknown>, key: string): string | null => {
  const v = obj[key]
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** Extract the `shellId=<id>` token from a bash background/await/kill banner.
 *  Returns null when the banner is missing, the token is empty, or the
 *  output is not a string. */
const extractShellId = (output: string): string | null => {
  const m = /shellId=([\w-]+)/.exec(output)
  return m?.[1] ?? null
}

/** Extract the `task_id: <id>` token from a subagent launch banner. */
const extractTaskId = (output: string): string | null => {
  const m = /task_id:\s*([\w-]+)/.exec(output)
  return m?.[1] ?? null
}

/** Extract the `status: <name>` token from a task_output banner. */
const extractTaskStatus = (output: string): string | null => {
  const m = /^status:\s*(\w+)\s*$/m.exec(output)
  return m?.[1] ?? null
}

/** Pull the leading word from a `get_mcp_task` payload. The tool returns
 *  either `not-ready: ...`, `<id> [<state>]\ncompleted: ...`,
 *  `<id> [<state>]\nfailed: ...`, or `<id> [<state>]\ncancelled` (verbatim
 *  in `src/tool/mcp_tasks/get_task.ts`). We branch on the SECOND-line
 *  prefix, which is the unambiguous terminal-state signal. */
const extractMcpGetState = (output: string): "completed" | "failed" | "cancelled" | null => {
  if (/^not-ready:/m.test(output)) return null
  if (/^completed:/m.test(output)) return "completed"
  if (/^failed:/m.test(output)) return "failed"
  // The `cancelled` arm is a bare line ("cancelled") — anchor on a full-line
  // match to avoid colliding with `cancel_mcp_task`'s `cancelled: <id>` shape
  // (which the cancel matcher owns).
  if (/^cancelled$/m.test(output)) return "cancelled"
  return null
}

// ─── Per-tool matchers ──────────────────────────────────────────────────────

/** `bash` — background-launch banner ⇒ start kind:"shell". */
const matchBash = (
  event: ObservedToolEvent,
  opts: DefaultLedgerMatcherOptions,
): LedgerAction | null => {
  if (event.name !== "bash") return null
  if (!event.ok) return null
  if (typeof event.output !== "string") return null
  // Anchor on the exact background-launch banner. A foreground bash returns
  // `[exit N]` so we never accidentally start a ledger entry for it.
  if (!event.output.startsWith("[bash background]")) return null
  if (!event.output.includes("status=running")) return null
  const shellId = extractShellId(event.output)
  if (shellId === null) return null
  const owner = (opts.owner ?? (() => DEFAULT_OWNER))()
  const cmd = isObject(event.input) ? pickString(event.input, "command") : null
  const title = cmd !== null ? truncate(cmd, TITLE_MAX) : `bash ${shellId}`
  return {
    kind: "start",
    id: shellId,
    runKind: "shell",
    owner,
    title,
    resumeAction: `bash_await ${shellId}`,
  }
}

/** `bash_await` — terminal exit ⇒ settle completed/failed. A `await_timeout`
 *  banner (shell still running) is null — settling there would mis-attribute
 *  a poll timeout as a terminal failure. */
const matchBashAwait = (event: ObservedToolEvent): LedgerAction | null => {
  if (event.name !== "bash_await") return null
  if (typeof event.output !== "string") return null
  // The await_timeout banner means the shell is still running — do NOT
  // settle. The same shell will be observed again later (the model has to
  // call bash_await again to wait it out).
  if (/await_timeout/.test(event.output)) return null
  const shellId = extractShellId(event.output)
  if (shellId === null) return null
  // exit 0 + ok ⇒ completed; non-zero or !ok ⇒ failed.
  if (event.ok && /\[bash_await exit 0\]/.test(event.output)) {
    return { kind: "settle", id: shellId, status: "completed" }
  }
  if (!event.ok) {
    return { kind: "settle", id: shellId, status: "failed" }
  }
  // ok:true but non-zero exit (defensive — bash_await sets ok=false on
  // non-zero so this branch is theoretical) ⇒ failed.
  if (/\[bash_await exit [1-9]/.test(event.output)) {
    return { kind: "settle", id: shellId, status: "failed" }
  }
  return null
}

/** `bash_kill` — ok success ⇒ settle stopped. */
const matchBashKill = (event: ObservedToolEvent): LedgerAction | null => {
  if (event.name !== "bash_kill") return null
  if (!event.ok) return null
  if (typeof event.output !== "string") return null
  if (!event.output.startsWith("[bash_kill")) return null
  const shellId = extractShellId(event.output)
  if (shellId === null) return null
  return { kind: "settle", id: shellId, status: "stopped" }
}

/** `agent` — background:true + task_id banner ⇒ start kind:"subagent". */
const matchAgent = (
  event: ObservedToolEvent,
  opts: DefaultLedgerMatcherOptions,
): LedgerAction | null => {
  if (event.name !== "agent") return null
  if (!event.ok) return null
  if (!isObject(event.input)) return null
  if (event.input.background !== true) return null
  if (typeof event.output !== "string") return null
  // Anchor on the unambiguous launch banner — a foreground agent never emits
  // this prefix even if its final text mentions `task_id`.
  if (!event.output.startsWith("Subagent launched in background.")) return null
  const taskId = extractTaskId(event.output)
  if (taskId === null) return null
  const prompt = pickStringTrimmed(event.input, "task_prompt")
  const title = prompt !== null ? truncate(prompt, TITLE_MAX) : `agent ${taskId}`
  const owner = (opts.owner ?? (() => DEFAULT_OWNER))()
  return {
    kind: "start",
    id: taskId,
    runKind: "subagent",
    owner,
    title,
    resumeAction: `task_output ${taskId}`,
  }
}

/** `task_output` — terminal status line ⇒ settle. The render() helper in
 *  task-tools.ts prints `task_id: <id>` then `status: <name>`. */
const matchTaskOutput = (event: ObservedToolEvent): LedgerAction | null => {
  if (event.name !== "task_output") return null
  if (typeof event.output !== "string") return null
  // The block-timeout placeholder is `timeout — task <id> still running` and
  // has no `status:` line — handled by the missing-status path below, but we
  // short-circuit here for clarity / robustness.
  if (/^timeout — task /.test(event.output)) return null
  // Pull the task_id from the input first (authoritative — output may still
  // have a task_id line, but the input is what the model wrote).
  const inputId = isObject(event.input) ? pickString(event.input, "task_id") : null
  if (inputId === null) return null
  const status = extractTaskStatus(event.output)
  if (status === null) return null
  if (status === "completed") return { kind: "settle", id: inputId, status: "completed" }
  if (status === "failed") return { kind: "settle", id: inputId, status: "failed" }
  if (status === "stopped") return { kind: "settle", id: inputId, status: "stopped" }
  // running ⇒ still active; no settle.
  return null
}

/** `task_stop` — ok success ⇒ settle stopped. */
const matchTaskStop = (event: ObservedToolEvent): LedgerAction | null => {
  if (event.name !== "task_stop") return null
  if (!event.ok) return null
  if (typeof event.output !== "string") return null
  if (!event.output.startsWith("Stopped task ")) return null
  const taskId = isObject(event.input) ? pickString(event.input, "task_id") : null
  if (taskId === null) return null
  return { kind: "settle", id: taskId, status: "stopped" }
}

/** `get_mcp_task` — terminal payload prefix ⇒ settle. */
const matchGetMcpTask = (event: ObservedToolEvent): LedgerAction | null => {
  if (event.name !== "get_mcp_task") return null
  if (typeof event.output !== "string") return null
  const taskId = isObject(event.input) ? pickString(event.input, "taskId") : null
  if (taskId === null) return null
  const state = extractMcpGetState(event.output)
  if (state === null) return null
  if (state === "completed") return { kind: "settle", id: taskId, status: "completed" }
  if (state === "failed") return { kind: "settle", id: taskId, status: "failed" }
  // cancelled ⇒ stopped (RunStatus has no `cancelled` arm; the wave-1 model
  // maps user/host cancellation to `stopped`).
  return { kind: "settle", id: taskId, status: "stopped" }
}

/** `cancel_mcp_task` — ok success ⇒ settle stopped. */
const matchCancelMcpTask = (event: ObservedToolEvent): LedgerAction | null => {
  if (event.name !== "cancel_mcp_task") return null
  if (!event.ok) return null
  if (typeof event.output !== "string") return null
  if (!event.output.startsWith("cancelled: ")) return null
  const taskId = isObject(event.input) ? pickString(event.input, "taskId") : null
  if (taskId === null) return null
  return { kind: "settle", id: taskId, status: "stopped" }
}

// ─── Composer ──────────────────────────────────────────────────────────────

/** All leaf matchers, in evaluation order. Order is not load-bearing today
 *  (each leaf gates on `event.name`), but stable order keeps test diffs
 *  small if a future leaf gains overlapping name predicates. */
type LeafMatcher = (
  event: ObservedToolEvent,
  opts: DefaultLedgerMatcherOptions,
) => LedgerAction | null

const LEAVES: readonly LeafMatcher[] = [
  matchBash,
  matchBashAwait,
  matchBashKill,
  matchAgent,
  matchTaskOutput,
  matchTaskStop,
  matchGetMcpTask,
  matchCancelMcpTask,
]

/** Validate the OUTER shape of an observed event. Returns null when the
 *  shape is malformed so the matcher composer can short-circuit before
 *  invoking any leaf. */
const isObservedEvent = (e: unknown): e is ObservedToolEvent => {
  if (!isObject(e)) return false
  if (typeof e.name !== "string") return false
  if (typeof e.ok !== "boolean") return false
  // `input` and `output` are intentionally typed `unknown` on the contract —
  // each leaf validates its own input/output expectations.
  return true
}

/** Compose the built-in matchers into one. Each leaf is invoked with the
 *  raw event; the FIRST non-null wins. Any throw from a leaf (defense in
 *  depth — leaves are pure today) is swallowed ⇒ null. */
export const createDefaultLedgerMatcher = (
  opts: DefaultLedgerMatcherOptions = {},
): LedgerMatcher => ({
  match(event: ObservedToolEvent): LedgerAction | null {
    if (!isObservedEvent(event)) return null
    for (const leaf of LEAVES) {
      try {
        const a = leaf(event, opts)
        if (a !== null) return a
      } catch {
        // Defensive — a future leaf using a user-supplied RegExp could
        // throw on a pathological input. The hook bus must never see a
        // matcher throw, so we swallow + move on.
      }
    }
    return null
  },
})
