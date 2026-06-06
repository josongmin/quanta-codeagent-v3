/**
 * RFC-08 / ADR-0443 — canonical user-facing permission/agent-mode cycle.
 *
 * claude-cli ships a `shift+tab` 4-posture cycle (default → accept-edits → plan
 * → bypass), each a color-coded pill + a one-line description. quanta has two
 * ORTHOGONAL mode axes — `PermissionMode` (the approval posture) and `AgentMode`
 * (the prompt-pack / read-only posture) — so this module collapses them into a
 * SINGLE user-facing slot mapped 1:1 onto claude-cli's cycle. No new mode is
 * invented: every posture projects onto an EXISTING `PermissionMode` value and
 * an EXISTING `AgentMode` value.
 *
 * Pure — no IO, no env, no globals. The TTY hook (raw-line-reader) and the
 * turn-boundary store (surface-compose) consume it. ADR-0303 — the chosen
 * posture is now AUTHORITATIVE per-turn: `runSessionTurn` syncs this store into
 * the engine-owned `RuntimeContext.permissionModeState()` before each turn, so
 * a mid-session shift+tab applies on the very next turn (not only the next
 * session). This store remains the UI input cell; the engine holds authority.
 */

import { gateOn } from "@/shared"
import type { AgentMode } from "@/agent"
import type { PermissionMode } from "@/permission"

/** One rung of the user-facing cycle. `permissionMode` is the approval-axis
 *  projection the next `createSession` reads; `agentMode` is the posture-axis
 *  projection (e.g. `plan` = read-only). Both are existing enum values. */
export interface ModeCyclePosture {
  readonly key: "default" | "acceptEdits" | "plan" | "bypass"
  readonly permissionMode: PermissionMode
  readonly agentMode: AgentMode
  readonly label: string
  /** status-pills ANSI color family (status-pills.ts:45-49). */
  readonly color: "green" | "yellow" | "magenta" | "red"
  readonly desc: string
}

/** Fixed order — mirrors claude-cli's cycle. Wrap-around is index mod length.
 *  Colors/descs are the single source of truth (one decision site). */
export const MODE_CYCLE: readonly ModeCyclePosture[] = [
  {
    key: "default",
    permissionMode: "default",
    agentMode: "default",
    label: "DEFAULT",
    color: "green",
    desc: "ask before every edit",
  },
  {
    key: "acceptEdits",
    permissionMode: "acceptEdits",
    agentMode: "default",
    label: "ACCEPT-EDITS",
    color: "yellow",
    desc: "edit freely, ask for commands",
  },
  {
    key: "plan",
    permissionMode: "default",
    agentMode: "plan",
    label: "PLAN",
    color: "magenta",
    desc: "research and propose, never touch files",
  },
  {
    key: "bypass",
    permissionMode: "bypass",
    agentMode: "default",
    label: "BYPASS",
    color: "red",
    desc: "runs without asking — dangerous",
  },
] as const

/** The posture the cycle starts at (and the only one whose pill is hidden to
 *  reduce clutter — see status-pills `formatCyclePosture`). */
export const DEFAULT_POSTURE: ModeCyclePosture = MODE_CYCLE[0] as ModeCyclePosture

/** Look a posture up by key. Unknown key (defensive) ⇒ the default rung. */
export const postureByKey = (key: string): ModeCyclePosture =>
  MODE_CYCLE.find((p) => p.key === key) ?? DEFAULT_POSTURE

/** Advance one rung with wrap-around. Unknown current key ⇒ treated as index 0
 *  so the result is the second rung (acceptEdits) — never throws. */
export const nextPosture = (cur: ModeCyclePosture["key"]): ModeCyclePosture => {
  const i = MODE_CYCLE.findIndex((p) => p.key === cur)
  return MODE_CYCLE[(Math.max(i, 0) + 1) % MODE_CYCLE.length] as ModeCyclePosture
}

/** Turn-boundary mutable store — the closed-port seam mirroring the existing
 *  `effortStore` / `identityModeState` `{get,set}` precedent. The REPL mutates
 *  it on shift+tab (instant pill); the NEXT `createSession` reads `.current()`
 *  for its `permissionMode`. Mid-turn `PermissionMode` change is impossible
 *  (RuntimeContext.permissionMode() is read once at session creation), so the
 *  chosen posture applies from the next submitted prompt — RFC-08 §2. */
export interface ModeCycleStore {
  /** The active posture (drives the pill + the next session's permissionMode). */
  current(): ModeCyclePosture
  /** Advance one rung (wrap-around) and return the new active posture. */
  cycle(): ModeCyclePosture
}

/** Build a store seeded at `start` (default: the DEFAULT rung). Pure in-memory;
 *  no IO. The host builds ONE per REPL session. */
export const createModeCycleStore = (start: ModeCyclePosture = DEFAULT_POSTURE): ModeCycleStore => {
  let active = start
  return {
    current: () => active,
    cycle: () => {
      active = nextPosture(active.key)
      return active
    },
  }
}

/** Env gate — `QUANTA_MODE_CYCLE=1` enables the shift+tab cycle. Any other
 *  value (incl. absent) ⇒ OFF (the hook is never wired ⇒ byte-identical). */
export const modeCycleEnabled = (env: NodeJS.ProcessEnv): boolean => gateOn(env, "QUANTA_MODE_CYCLE")

const ESC = "\x1b["
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const POSTURE_FG: Record<ModeCyclePosture["color"], string> = {
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  magenta: `${ESC}35m`,
  red: `${ESC}31m`,
}

/** Render the prompt meta line for a posture: a bold colored `[LABEL]` pill +
 *  a dim one-line description + the shift+tab affordance. Pure string; the
 *  raw-line reader paints it dim-wrapped under the prompt (RFC-08 §4.3). */
export const formatPostureMeta = (p: ModeCyclePosture): string =>
  `${BOLD}${POSTURE_FG[p.color]}[${p.label}]${RESET} ${DIM}${p.desc} · shift+tab to cycle${RESET}`
