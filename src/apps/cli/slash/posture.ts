/**
 * RFC-05 E4 — `/posture` CLI approval-posture selector (`@/apps/cli/slash`).
 *
 * The operator's per-thread posture front door — the surface realization of the
 * `session.posture.set` verb (the web/SDK daemon dispatches the SAME verb through
 * the kernel/host command bus; the CLI REPL is single-focus so it applies it
 * IN-PROCESS through the SHARED {@link PostureControl}, exactly as RFC-03 C3's
 * `/objective` applies its objective authority in-process rather than
 * round-tripping the kernel). Because the control wraps the SAME live
 * {@link PostureAuthority} the per-turn gate reads, a `/posture` mutation changes
 * the NEXT turn's effective posture, and the echo it prints reflects the fresh
 * requested/effective/locks at the freshly-bumped revision.
 *
 * It exposes E2's TWO durable entries as EXPLICIT scopes so an operator can
 * distinguish "change THIS session" from "change what NEW sessions start with":
 *   - `/posture`                    show the CURRENT-thread posture
 *   - `/posture default`            show the FUTURE-thread default
 *   - `/posture use <preset> [--default]`   apply a NAMED PRESET
 *   - `/posture mode <mode> [--default]`     apply a CUSTOM mode patch
 *   - `/posture ask <on|off> [--default]`    toggle the custom question knob
 *
 * A stale CURRENT-scope mutation (the shared authority moved under the operator)
 * is a typed `stale_revision` conflict — never a clobber of a newer commit.
 *
 * DEFAULT-OFF: registered only when `QUANTA_POSTURE_SELECTOR` is on (see
 * {@link isPostureSelectorEnabled}) so the `/help` catalog + command table are
 * byte-identical when the gate is unset (parity with `/objective` / `/attention`).
 * When the slot (`ctx.postureEditor`) is absent it prints "not wired" + exit 0.
 */

import type { PostureControl } from "@/permission/posture/control"
import { OFFERED_PRESETS, presetPatch } from "@/permission/posture/presets"
import type { PosturePatch, PosturePreset } from "@/permission/posture/types"
import { ALL_PERMISSION_MODES, isPermissionMode } from "@/permission/types"
import type { PostureCommandScope, PostureProjectionView } from "@/protocol/session"
import { readCliKnob } from "../cli-knobs-accessor"
import type { SlashCommand, SlashContext } from "../slash-contract"

/** CLOSED outcome of an in-process posture edit. `stale` carries the revision the
 *  operator must re-read; `unsupported` means the scope had no durable target. */
export type PostureEditOutcome =
  | { readonly kind: "ok"; readonly projection: PostureProjectionView }
  | { readonly kind: "stale"; readonly currentRevision: number }
  | { readonly kind: "unsupported"; readonly detail: string }

/** The CLI `/posture` wire (`ctx.postureEditor`). A thin projection over the live
 *  posture AUTHORITY; the surface builds it via {@link buildPostureSlashState}.
 *  Absent ⇒ `/posture` prints "not wired". */
export interface PostureSlashState {
  /** The CURRENT-thread posture projection (always present). */
  readCurrent(): PostureProjectionView
  /** The FUTURE-thread DEFAULT projection, or `null` when no default store was
   *  wired (⇒ `--default` scope is unavailable on this surface). */
  readDefault(): PostureProjectionView | null
  /** Apply a NAMED preset at the given scope. */
  applyPreset(preset: PosturePreset, scope: PostureCommandScope): Promise<PostureEditOutcome>
  /** Apply a CUSTOM lossless patch at the given scope. */
  applyPatch(patch: PosturePatch, scope: PostureCommandScope): Promise<PostureEditOutcome>
}

/**
 * Build the `/posture` wire over the shared live {@link PostureControl} (the
 * SAME control the host `setPosture` projection applies through, so the CLI and
 * the wire never fork mutation semantics). Every CURRENT-scope mutation runs
 * under CAS at the authority's current revision; a stale peer edit races here and
 * the loser gets a `stale` refresh-required outcome (never a clobber).
 */
export const buildPostureSlashState = (control: PostureControl): PostureSlashState => {
  const runApply = async (
    patch: PosturePatch,
    scope: PostureCommandScope,
  ): Promise<PostureEditOutcome> => {
    const outcome = await control.apply({ patch, scope })
    if (outcome.ok) {
      // Re-read the fresh projection for the mutated scope so the echo shows the
      // bumped revision + resolved effective/locks.
      const projection = scope === "default" ? control.describeDefault() : control.describe()
      if (projection === null) {
        return { kind: "unsupported", detail: "no future-thread default store wired" }
      }
      return { kind: "ok", projection }
    }
    if (outcome.kind === "stale_revision") {
      return { kind: "stale", currentRevision: outcome.actual }
    }
    return { kind: "unsupported", detail: outcome.detail }
  }
  return {
    readCurrent: () => control.describe(),
    readDefault: () => control.describeDefault(),
    applyPreset: (preset, scope) => runApply(presetPatch(preset), scope),
    applyPatch: (patch, scope) => runApply(patch, scope),
  }
}

/** RFC-05 E4 — `/posture` registration gate. Default-OFF (opt-IN): registered
 *  only when `QUANTA_POSTURE_SELECTOR` is on so `/help` + the command table are
 *  byte-identical when the gate is unset (parity with `/objective`). Routed
 *  through the typed `readCliKnob` accessor (never raw `process.env`). */
export const isPostureSelectorEnabled = (): boolean =>
  readCliKnob("QUANTA_POSTURE_SELECTOR", "bool") ?? false

/* ------------------------------------------------------------------------- *
 * Rendering.
 * ------------------------------------------------------------------------- */

const scopeLabel = (scope: PostureCommandScope): string =>
  scope === "default" ? "future-thread default" : "current thread"

/** Render a posture projection — named PRESET when the record projects to one,
 *  else the CUSTOM patch verbatim; the effective view (incl `effectiveMode`) and
 *  any admitted locks (surfaced from the E1 producers VERBATIM — never remapped). */
const renderProjection = (view: PostureProjectionView, scope: PostureCommandScope): string => {
  const presetLine =
    view.requested.preset === null
      ? `  requested: custom ${JSON.stringify(view.requested.patch)}`
      : `  requested: ${view.requested.preset}`
  const eff = view.effective
  const lockLines = view.locks.map(
    (l) => `  🔒 ${l.label} (${l.reason}${l.detail !== undefined ? `: ${l.detail}` : ""})`,
  )
  return [
    `🛡️  Posture (${scopeLabel(scope)}) · rev ${view.revision}`,
    presetLine,
    `  effective: mode=${eff.effectiveMode} · reviewer=${eff.reviewerRoute} · ask-outside-plan=${eff.askOutsidePlan}`,
    ...lockLines,
    "",
  ].join("\n")
}

/* ------------------------------------------------------------------------- *
 * Argument parsing — scope flag + sub-command dispatch.
 * ------------------------------------------------------------------------- */

/** Strip the `--default` flag from the args; return the remaining args + the
 *  resolved scope. `--default` ⇒ future-thread default; absent ⇒ current thread. */
const parseScope = (args: readonly string[]): { rest: string[]; scope: PostureCommandScope } => {
  const rest = args.filter((a) => a !== "--default")
  const scope: PostureCommandScope = args.includes("--default") ? "default" : "current"
  return { rest, scope }
}

const reportOutcome = (
  ctx: SlashContext,
  outcome: PostureEditOutcome,
  scope: PostureCommandScope,
): number => {
  switch (outcome.kind) {
    case "ok":
      ctx.out(
        `✅ Posture updated (${scopeLabel(scope)}).\n${renderProjection(outcome.projection, scope)}`,
      )
      return 0
    case "stale":
      ctx.err(
        `/posture: changed under you (now rev ${outcome.currentRevision}) — re-run /posture and retry\n`,
      )
      return 1
    case "unsupported":
      ctx.err(`/posture: ${outcome.detail}\n`)
      return 1
  }
}

const isPosturePreset = (value: string): value is PosturePreset =>
  (OFFERED_PRESETS as readonly string[]).includes(value)

const handleUse = async (
  rest: string[],
  scope: PostureCommandScope,
  ctx: SlashContext,
  state: PostureSlashState,
): Promise<number> => {
  const preset = rest[1]
  if (preset === undefined) {
    ctx.err(`/posture use: requires a preset (${OFFERED_PRESETS.join(" | ")})\n`)
    return 1
  }
  if (!isPosturePreset(preset)) {
    ctx.err(`/posture use: unknown preset '${preset}' (${OFFERED_PRESETS.join(" | ")})\n`)
    return 1
  }
  return reportOutcome(ctx, await state.applyPreset(preset, scope), scope)
}

const handleMode = async (
  rest: string[],
  scope: PostureCommandScope,
  ctx: SlashContext,
  state: PostureSlashState,
): Promise<number> => {
  const mode = rest[1]
  if (mode === undefined || !isPermissionMode(mode)) {
    ctx.err(`/posture mode: requires a mode (${ALL_PERMISSION_MODES.join(" | ")})\n`)
    return 1
  }
  return reportOutcome(ctx, await state.applyPatch({ mode }, scope), scope)
}

const handleAsk = async (
  rest: string[],
  scope: PostureCommandScope,
  ctx: SlashContext,
  state: PostureSlashState,
): Promise<number> => {
  const flag = rest[1]
  if (flag !== "on" && flag !== "off") {
    ctx.err("/posture ask: requires on | off\n")
    return 1
  }
  return reportOutcome(ctx, await state.applyPatch({ askOutsidePlan: flag === "on" }, scope), scope)
}

/** RFC-05 E4 — `/posture` show / use / mode / ask, current-thread or
 *  `--default` future-thread scope. */
export const postureCmd: SlashCommand = {
  name: "/posture",
  describe:
    "Select the approval posture (show | use <preset> | mode <mode> | ask on|off) for the current thread or the --default future thread. Opt-in: QUANTA_POSTURE_SELECTOR=1",
  category: "config",
  async run(args, ctx) {
    const state = ctx.postureEditor
    if (state === undefined) {
      ctx.out("/posture: not wired in this surface\n")
      return 0
    }
    const { rest, scope } = parseScope(args)
    const sub = rest[0]

    if (sub === undefined || sub === "show") {
      // A bare `/posture --default` shows the future-thread default.
      if (scope === "default") {
        const def = state.readDefault()
        if (def === null) {
          ctx.err("/posture: no future-thread default store wired on this surface\n")
          return 1
        }
        ctx.out(renderProjection(def, "default"))
        return 0
      }
      ctx.out(renderProjection(state.readCurrent(), "current"))
      return 0
    }
    if (sub === "default") {
      const def = state.readDefault()
      if (def === null) {
        ctx.err("/posture: no future-thread default store wired on this surface\n")
        return 1
      }
      ctx.out(renderProjection(def, "default"))
      return 0
    }
    if (sub === "use") return handleUse(rest, scope, ctx, state)
    if (sub === "mode") return handleMode(rest, scope, ctx, state)
    if (sub === "ask") return handleAsk(rest, scope, ctx, state)

    ctx.err(`/posture: unknown sub-command '${sub}' (show | use | mode | ask)\n`)
    return 1
  },
}

export type { SlashContext }
