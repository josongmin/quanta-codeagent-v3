/**
 * `/dream` slash command — CROSS-SESSION memory consolidation ("auto-dream").
 *
 * Surface contract (subcommand-style):
 *
 *   - `/dream`            → trigger a cross-session consolidation NOW
 *                           (`CrossSessionDreamTrigger.dream()` — bypasses the
 *                           sessions/hours threshold but honors the dream-lock
 *                           and the feature flag).
 *   - `/dream status`     → show sessions-since / hours-since last dream, the
 *                           last outcome, the team write-target path, and
 *                           whether the feature is enabled.
 *
 * Default-OFF posture (RFC §1.2):
 *
 *   - `QUANTA_DREAM_SLASH` defaults to `"1"` (command registered). Setting
 *     `"0"` removes `/dream` from BUILTINS at load time — same effect as never
 *     registering it.
 *   - Without an injected {@link DreamSlashState} on
 *     {@link SlashContext.dream}, the command prints "auto-dream not wired in
 *     this surface" and exits 0 (byte-identical to NOT registering).
 *   - When the surface IS wired but `QUANTA_AUTO_DREAM` is OFF, the trigger
 *     reports `enabled=false`; a manual `/dream` then returns `below_threshold`
 *     (nothing happens) and `/dream status` shows the feature is off.
 *
 * Slice contract: lives in `src/apps/cli/**` — allowed to import `@/memory`
 * (the CLI surface carve-out). The body NEVER imports `@/llm` — the
 * consolidation work is done by the injected trigger's `DreamConsolidatePort`,
 * which the surface composer wires over the existing `runPhase2` pipeline.
 */

import type { CrossSessionDreamTrigger } from "@/memory"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

/** Surface-time state injected by the REPL / session composer so `/dream`
 *  can trigger + inspect the cross-session dream. Absent ⇒ command prints
 *  "not wired" and exits 0, symmetric with `/memory` and `/side`. */
export interface DreamSlashState {
  /** The live cross-session dream trigger (default-OFF when no policy). */
  readonly trigger: CrossSessionDreamTrigger
  /** Override env access (test seam). Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

declare module "./slash-commands" {
  interface SlashContext {
    /** `/dream` cross-session consolidation state — see `./dream-cmd.ts`. */
    readonly dream?: DreamSlashState | undefined
  }
}

/* ------------------------------------------------------------------ */
/* env knob                                                           */
/* ------------------------------------------------------------------ */

const isOn = (v: string | undefined, fallback: string): boolean => {
  const raw = (v ?? fallback).trim().toLowerCase()
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no"
}

/** Whether `/dream` should be registered. Honors an injected env source (test
 *  seam) first, then `process.env`. Default `"1"` (registered). */
export const isDreamSlashEnabled = (
  envSource?: Readonly<Record<string, string | undefined>>,
): boolean => {
  const e = envSource ?? process.env
  return isOn(e.QUANTA_DREAM_SLASH, "1")
}

/* ------------------------------------------------------------------ */
/* renderers                                                          */
/* ------------------------------------------------------------------ */

const fmtHours = (h: number | null): string => {
  if (h === null) return "(never dreamed)"
  return `${h.toFixed(1)}h`
}

const runStatus = (ctx: SlashContext, state: DreamSlashState): number => {
  const t = state.trigger
  const s = t.readState()
  ctx.out("/dream status:\n")
  ctx.out(`  Enabled:           ${t.enabled ? "yes" : "no (QUANTA_AUTO_DREAM off)"}\n`)
  ctx.out(`  Sessions since:    ${s.sessionsSinceLastDream}\n`)
  ctx.out(`  Hours since:       ${fmtHours(t.hoursSinceLastDream(s))}\n`)
  ctx.out(`  Last outcome:      ${s.lastOutcome ?? "(none)"}\n`)
  ctx.out(`  Team write target: ${t.targetPath}\n`)
  return 0
}

const runDreamNow = async (ctx: SlashContext, state: DreamSlashState): Promise<number> => {
  const t = state.trigger
  if (!t.enabled) {
    ctx.out("/dream: auto-dream is OFF (set QUANTA_AUTO_DREAM=1 to enable)\n")
    return 0
  }
  ctx.out("/dream: consolidating cross-session memory...\n")
  const outcome = await t.dream()
  switch (outcome.kind) {
    case "completed":
      ctx.out(`/dream: done — wrote ${outcome.bytesWritten} bytes to ${t.targetPath}\n`)
      return 0
    case "no_op":
      ctx.out("/dream: nothing new to consolidate (no-op)\n")
      return 0
    case "locked":
      ctx.out("/dream: another dream is already running — skipped\n")
      return 0
    case "below_threshold":
      // Reachable only if the feature flipped off between the guard and here.
      ctx.out("/dream: auto-dream is OFF\n")
      return 0
    case "error":
      ctx.err(`/dream: failed — ${outcome.error.message}\n`)
      return 1
  }
}

/* ------------------------------------------------------------------ */
/* dispatch                                                           */
/* ------------------------------------------------------------------ */

const HELP_TEXT = `\
/dream            Consolidate cross-session memory NOW (manual trigger).
/dream status     Show sessions/hours since last dream + last outcome + target.`

export const dreamCmd: SlashCommand = {
  name: "/dream",
  describe: "Trigger or inspect cross-session memory consolidation (auto-dream)",
  category: "session",
  async run(args, ctx) {
    if (ctx.dream === undefined) {
      ctx.out("/dream: auto-dream not wired in this surface\n")
      return 0
    }
    const sub = args[0]
    const state = ctx.dream
    if (sub === undefined) return runDreamNow(ctx, state)
    if (sub === "--help" || sub === "-h") {
      ctx.out(`${HELP_TEXT}\n`)
      return 0
    }
    switch (sub) {
      case "status":
        return runStatus(ctx, state)
      default:
        ctx.err(`/dream: unknown subcommand: ${sub}\n`)
        ctx.out(`${HELP_TEXT}\n`)
        return 1
    }
  },
}
