/**
 * Surface-adaptive prompt composition seam (RFC `jul-2-terminal-bench-levers/00` §X).
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
import type { AgentMode as RulePackMode } from "./prompt-rules"

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
 *   ci-bot). Absent ⇒ the interactive default pack (byte-identical). This is a
 *   SEPARATE axis from `envPosture`; when `envPosture:"owned"` the owned rule
 *   list wins over `rulePack` (matching {@link buildSystemPrompt}'s precedence).
 */
export interface SurfaceProfile {
  readonly envPosture: EnvironmentPosture
  readonly operatorGuide?: string
  readonly rulePack?: RulePackMode
}

/**
 * The DEFAULT surface profile: frozen env posture, no operator guide, no rule
 * pack. Composing with this yields a prompt byte-identical to `buildSystemPrompt()`
 * with no opts — so every existing (non-declaring) surface is unchanged. Callers
 * that want the legacy prompt need not touch this module at all; it exists so the
 * "frozen == today" invariant has a named reference the tests pin.
 */
export const FROZEN_SURFACE_PROFILE: SurfaceProfile = { envPosture: "frozen" }

/** Options for {@link composeSystemPromptForSurface} that are orthogonal to the
 *  surface (they belong to the specific launch, not the surface *kind*): the cwd
 *  passthrough and the persona. Kept minimal — the surface-specific bits live on
 *  the {@link SurfaceProfile}. */
export interface ComposeForSurfaceOpts {
  readonly cwd?: string
  readonly persona?: PersonaKind
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
  } = {}
  if (opts.persona !== undefined) promptOpts.persona = opts.persona
  // Only forward a non-frozen posture — a `"frozen"` posture must take the
  // EXACT default code path in `buildSystemPrompt` (no `envPosture` key) so the
  // frozen output is byte-identical to a caller that never learned this seam.
  if (profile.envPosture !== "frozen") promptOpts.envPosture = profile.envPosture
  // `rulePack` is inert when the owned posture is active (owned rules win in the
  // core, mirroring buildSystemPrompt precedence) — forward it only for frozen.
  if (profile.rulePack !== undefined && profile.envPosture === "frozen") {
    promptOpts.promptPack = profile.rulePack
  }
  return buildSystemPrompt(opts.cwd, promptOpts)
}
