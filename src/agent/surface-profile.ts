/**
 * Surface-adaptive prompt composition seam (TB21-06 TC-4 —
 * `docs/plans/aug-21-bench-terminal-2-1/TB21-06-transferred-contracts.md`).
 *
 * The universal SOTA shape (Codex / Claude / Terminus parity) is three cleanly
 * separated layers:
 *
 *   | layer          | who sets it              | cacheable            |
 *   |----------------|--------------------------|----------------------|
 *   | L1 base        | fixed in code            | ✅ prefix cache      |
 *   | L-surface      | the ENTRY POINT declares | ✅ per-surface prefix |
 *   | task turn      | the instruction / query  | n/a (per turn)       |
 *
 * A `SurfaceProfile` is the L-surface value object: a *deployment fact* the
 * entry point (terminal brain / CLI repl / bench runner / web daemon) DECLARES
 * at launch, NOT something the assembler infers from the query. The core
 * ({@link buildSystemPrompt}) stays a pure composer with a fixed, cacheable
 * base — there is NO `if (terminal) {…}` branch anywhere in the prompt core.
 *
 * Env-posture (lever #1) is folded INTO this one seam rather than living as a
 * second ad-hoc `owned`-injection hack: the terminal profile simply declares
 * `envPosture: "owned"`, and {@link composeSystemPromptForSurface} threads it
 * through the existing `buildSystemPrompt({ envPosture })` opt.
 *
 * PROMPT-TEXT-ONLY by construction: a `SurfaceProfile` carries only strings /
 * a rule-pack selector. It NEVER references `SandboxPolicy` / `SandboxMode` /
 * any runtime-enforcement type — the type shape makes a runtime-posture leak
 * a compile error, not a review catch.
 */

import type { PersonaKind } from "./persona"
import { buildSystemPrompt, type EnvironmentPosture } from "./prompt"
import type { AgentMode as RulePackMode, VerifyStrategy } from "./prompt-rules"
import type { PromptStyle } from "./prompt-style"

/**
 * A declared surface profile — the L-surface layer. Every field is optional
 * except `envPosture`; the {@link FROZEN_SURFACE_PROFILE} default reproduces
 * today's behavior for every surface that does not declare its own.
 *
 * - `envPosture` — env-ownership axis (`"frozen"` = SWE-bench guardrails =
 *   today's default; `"owned"` = the surface owns its container). Selects the
 *   rendered env-rule TEXT and NOTHING else.
 * - `operatorGuide` — optional per-surface operator capability guidance the
 *   entry point injects alongside the task (e.g. the terminal's exe-in-PATH
 *   habits). The core does NOT splice it into the cached system prefix; the
 *   entry point rides it on the first user turn (kept off the cache prefix on
 *   purpose). Carried here so the profile is the single declared bundle.
 * - `rulePack` — optional task-posture rule-pack selector (headless / batch /
 *   ci-bot). Absent ⇒ no task rules (the interactive default, byte-identical).
 *   Since the jul-4 2-axis refactor this is a FULLY INDEPENDENT axis from
 *   `envPosture`: the core composes `postureBase(envPosture) + taskRules(rulePack)`,
 *   so `owned` + a pack now COMPOSE (owned base THEN the task rule) — no XOR, no
 *   precedence. A surface may declare both and get both.
 */
export interface SurfaceProfile {
  readonly envPosture: EnvironmentPosture
  readonly operatorGuide?: string
  readonly rulePack?: RulePackMode
  /**
   * Verify-strategy axis (jul-4, third slot) — how this surface confirms its own
   * work (`reproduce-first` = SWE, `verify-after-edit` = general). Absent ⇒ no
   * verify rule (byte-identical). A fully INDEPENDENT axis from `envPosture` /
   * `rulePack`; threaded straight through to `buildSystemPrompt({ verifyStrategy })`.
   * MEASURE-FIRST: entry points set this only behind a default-OFF knob, so the
   * default profiles omit it and stay byte-identical. TB's self-test is its own
   * knob + machinery, not this field.
   */
  readonly verifyStrategy?: VerifyStrategy
}

/**
 * The DEFAULT surface profile: frozen env posture, no operator guide, no rule
 * pack. Composing with this yields a prompt byte-identical to `buildSystemPrompt()`
 * with no opts — so every existing (non-declaring) surface is unchanged. Callers
 * that want the legacy prompt need not touch this module at all; it exists so the
 * "frozen == today" invariant has a named reference the tests pin.
 */
export const FROZEN_SURFACE_PROFILE: SurfaceProfile = { envPosture: "frozen" }

/**
 * Named per-surface profiles — the "per-target rendering strategy" made explicit
 * (jul-4). DECLARE-WHERE-CONSUMED: a profile constant exists only where an entry
 * point actually selects it, so there are no inert/dead surface constants.
 *
 * - SWE — externally-graded batch/bench (consumed by config-build). Frozen + the `batch`
 *   pack (R-NO-EXPLORE-OVER-EDIT). `composeSystemPromptForSurface(SWE_SURFACE_PROFILE)` is
 *   byte-identical to config-build's prior `{ promptPack: "batch" }` call.
 *
 * TB (terminal) declares its own `owned` profile at its entry point
 * (`TERMINAL_SURFACE_PROFILE` in the terminal brain) — it carries an operator guide and is
 * knob-gated, so it lives next to that launch site rather than here.
 *
 * NOT declared here: GENERAL (interactive/IDE) / PR (ci-bot) / HEADLESS. Their mode-presets
 * render the frozen no-pack base via a RAW `buildSystemPrompt(cwd)` fallback. That fallback is
 * itself inert on the production dispatch (the composition root fills `base.system` with a
 * non-empty string, so the `??` never reaches it) — so routing it through a named profile would
 * be a same-behavior constant with no LIVE consumer. When a preset genuinely opts into a task
 * pack or verify strategy (a deliberate, measured behavior change reached on a live path),
 * declare the profile THEN — the rule packs and `renderTaskRules`/`renderVerifyStrategy` arms
 * already exist; only the reachable entry-point selection is missing.
 */
export const SWE_SURFACE_PROFILE: SurfaceProfile = { envPosture: "frozen", rulePack: "batch" }

/** Options for {@link composeSystemPromptForSurface} that are orthogonal to the
 *  surface (they belong to the specific launch, not the surface *kind*): the cwd
 *  passthrough and the persona. Kept minimal — the surface-specific bits live on
 *  the {@link SurfaceProfile}. */
export interface ComposeForSurfaceOpts {
  readonly cwd?: string
  readonly persona?: PersonaKind
  /** Render STYLE (jul-6) — a per-launch choice (like persona), NOT a surface
   *  *kind* property, so it rides here rather than on {@link SurfaceProfile}.
   *  `"sectioned"` promotes the base prompt's headers to `##` markdown; absent /
   *  `"flat"` ⇒ the key is never forwarded ⇒ byte-identical. */
  readonly promptStyle?: PromptStyle
}

/**
 * Compose the STATIC system prompt for a declared {@link SurfaceProfile}. The
 * ONLY composition path a surface entry point needs — it maps the profile's
 * declared axes onto the pure-composer {@link buildSystemPrompt} opts:
 *
 *   - `envPosture` → `buildSystemPrompt({ envPosture })` (owned vs frozen rules)
 *   - `rulePack`   → `buildSystemPrompt({ promptPack })` (task-posture pack)
 *
 * Surface-agnostic: it contains NO per-surface `if`. Two different profiles
 * produce two different prompts purely by their declared values; the frozen
 * default produces today's prompt byte-for-byte. The `operatorGuide` is NOT
 * folded into the cached system prefix here — it is a per-turn injection the
 * entry point owns (see the terminal brain), kept off the cache prefix.
 *
 * exactOptionalPropertyTypes-strict: only defined keys are spread so an absent
 * persona / rulePack does not collide with the strict optional shape and the
 * frozen path stays the EXACT `buildSystemPrompt(cwd, { persona? })` branch.
 */
export const composeSystemPromptForSurface = (
  profile: SurfaceProfile,
  opts: ComposeForSurfaceOpts = {},
): string => {
  const promptOpts: {
    persona?: PersonaKind
    promptPack?: RulePackMode
    envPosture?: EnvironmentPosture
    verifyStrategy?: VerifyStrategy
    promptStyle?: PromptStyle
  } = {}
  if (opts.persona !== undefined) promptOpts.persona = opts.persona
  // Render style (jul-6) — forward only a non-flat style; `"flat"` / absent must
  // take the EXACT default path in `buildSystemPrompt` (no `promptStyle` key) so
  // the flat output stays byte-identical to a caller that never learned this seam.
  if (opts.promptStyle !== undefined && opts.promptStyle !== "flat") {
    promptOpts.promptStyle = opts.promptStyle
  }
  // Only forward a non-frozen posture — a `"frozen"` posture must take the
  // EXACT default code path in `buildSystemPrompt` (no `envPosture` key) so the
  // frozen output is byte-identical to a caller that never learned this seam.
  if (profile.envPosture !== "frozen") promptOpts.envPosture = profile.envPosture
  // Task pack is an INDEPENDENT axis (jul-4 2-axis): forward it whenever declared,
  // regardless of posture. The core composes postureBase + taskRules, so an owned
  // surface can carry a task pack (owned base THEN the task rule) — no XOR, no
  // precedence drop. Byte-identical for every current profile (none declares
  // owned + a pack yet, so this widens the accepted inputs, not the outputs).
  if (profile.rulePack !== undefined) {
    promptOpts.promptPack = profile.rulePack
  }
  // Verify axis (jul-4, third slot) — forwarded straight through. Absent ⇒ the key
  // is never set, so `buildSystemPrompt` renders no verify rule (byte-identical).
  if (profile.verifyStrategy !== undefined) {
    promptOpts.verifyStrategy = profile.verifyStrategy
  }
  return buildSystemPrompt(opts.cwd, promptOpts)
}
