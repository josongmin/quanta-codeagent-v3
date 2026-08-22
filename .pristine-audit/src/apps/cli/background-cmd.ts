/**
 * Ticket 18 (V1) — `/background [list|reattach <id>|cancel <id>]`.
 *
 * The surface management command for turns moved to the background via Ctrl+B.
 * Reads the READ-ONLY {@link BackgroundPortalView} threaded onto
 * `SlashContext.background` (present iff `QUANTA_BG_TURN` is on). V1 is
 * observe-only:
 *   - `list`     (default) ⇒ an aligned table (id · colored state pill · elapsed
 *                  · buffered bytes · label), running-first then by recency.
 *   - `reattach` ⇒ PRINT the captured buffer + the result/error. READ-ONLY — it
 *                  does NOT re-enter the loop; if the turn is still running it
 *                  notes "still streaming; transcript not yet merged".
 *   - `cancel`   ⇒ fire the entry's AbortController (the background body unwinds).
 *
 * Absent slot (`ctx.background === undefined`) ⇒ D-6 not-wired posture +
 * exit 2 with the QUANTA_BG_TURN hint (UUX-2-22).
 *
 * PURE render: the clock is injected via `ctx.now` so the elapsed column is
 * deterministic under test; no `@/agent` import, no `process.*` reads.
 */

import { cyan, dim, gray, green, red, yellow } from "@/ui/ui-helpers"
import { notWired } from "./not-wired"
import type {
  BackgroundPortalView,
  BackgroundTurnRow,
  BackgroundTurnState,
} from "./repl/background-turn-portal"
import type { SlashCommand, SlashContext } from "./slash-contract"

/** Humanize an elapsed-ms span into a compact `12s` / `3m` / `1h`. Clamps
 *  negative / NaN to `0s`. Local copy (no cross-slice import) — pure. */
const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h`
}

/** Compact byte count: `512 B` / `3.4 KB` / `12 MB`. */
const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${Math.round(n / (1024 * 1024))} MB`
}

/** Colored state pill — green=done, red=failed, yellow=running, gray=cancelled.
 *  Color is decided by `@/ui/ui-helpers` (it strips ANSI when the policy is
 *  "off"), so this is safe on a non-TTY / piped surface. */
const statePill = (state: BackgroundTurnState): string => {
  switch (state) {
    case "running":
      return yellow("● running")
    case "done":
      return green("✔ done")
    case "failed":
      return red("✖ failed")
    case "cancelled":
      return gray("⊘ cancelled")
  }
}

/** Running-first, then settled by most-recent start. */
const orderRows = (rows: readonly BackgroundTurnRow[]): BackgroundTurnRow[] =>
  [...rows].sort((a, b) => {
    const ar = a.state === "running" ? 0 : 1
    const br = b.state === "running" ? 0 : 1
    if (ar !== br) return ar - br
    return b.startedAt - a.startedAt
  })

const renderList = (view: BackgroundPortalView, now: number, out: (s: string) => void): number => {
  const rows = orderRows(view.list())
  if (rows.length === 0) {
    out(`${dim("(no background turns)")}\n`)
    return 0
  }
  out(`${dim("background turns:")}\n`)
  for (const r of rows) {
    const id = cyan(r.taskId.padEnd(8))
    const pill = statePill(r.state).padEnd(22)
    const elapsed = formatElapsed(now - r.startedAt).padStart(4)
    const bytes = formatBytes(r.bufferedBytes).padStart(8)
    out(`  ${id} ${pill} ${elapsed} ${bytes}  ${r.label}\n`)
  }
  out(`${dim("use: /background reattach <id> | /background cancel <id>")}\n`)
  return 0
}

const renderReattach = (
  view: BackgroundPortalView,
  id: string,
  out: (s: string) => void,
  err: (s: string) => void,
): number => {
  const re = view.reattach(id)
  if (re === undefined) {
    err(`/background: unknown task '${id}'\n`)
    return 1
  }
  out(`${dim(`── ${re.label} (${re.taskId}) ──`)}\n`)
  out(`state: ${statePill(re.state)}\n`)
  if (re.buffer.length > 0) out(`${re.buffer}\n`)
  if (re.running) {
    out(`${yellow("⏳ still streaming; transcript not yet merged")}\n`)
  } else if (re.error !== undefined) {
    out(`${red(`error: ${re.error instanceof Error ? re.error.message : String(re.error)}`)}\n`)
  } else if (re.result !== undefined) {
    // V1 prints the structural result (the SDK session remains the SSOT for the
    // merged transcript; V1 does NOT fold it back into surface history).
    out(`${green("result captured")} ${dim("(SDK session is the source of truth)")}\n`)
  }
  return 0
}

const renderCancel = (
  view: BackgroundPortalView,
  id: string,
  out: (s: string) => void,
  err: (s: string) => void,
): number => {
  const re = view.get(id)
  if (re === undefined) {
    err(`/background: unknown task '${id}'\n`)
    return 1
  }
  view.cancel(id)
  out(`${dim(`cancelled background task ${id}`)}\n`)
  return 0
}

export const backgroundCmd: SlashCommand = {
  name: "/background",
  describe:
    "Manage turns moved to the background (Ctrl+B). Usage: /background [list|reattach <id>|cancel <id>]",
  category: "session",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.background === undefined) {
      return notWired(ctx.out, { feature: "/background", gate: "QUANTA_BG_TURN" })
    }
    const view = ctx.background
    const sub = args[0] ?? "list"
    const now = ctx.now?.() ?? Date.now()
    if (sub === "list") {
      if (args.length > 1) {
        ctx.err("/background: list takes no arguments\n")
        return 1
      }
      return renderList(view, now, ctx.out)
    }
    if (sub === "reattach") {
      const id = args[1]
      if (id === undefined) {
        ctx.err("/background: reattach requires a task id (see /background list)\n")
        return 1
      }
      return renderReattach(view, id, ctx.out, ctx.err)
    }
    if (sub === "cancel") {
      const id = args[1]
      if (id === undefined) {
        ctx.err("/background: cancel requires a task id (see /background list)\n")
        return 1
      }
      return renderCancel(view, id, ctx.out, ctx.err)
    }
    ctx.err(`/background: unknown subcommand '${sub}' (use list|reattach|cancel)\n`)
    return 1
  },
}
