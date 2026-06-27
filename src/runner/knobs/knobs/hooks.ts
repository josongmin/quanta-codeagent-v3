/**
 * Knob: `hooks` — pre/post tool-use hook bus (Cursor hooks absorption).
 *
 * Wires the in-process hook bus (`HookBus`) defined in `src/agent/hooks.ts`
 * onto `AgentConfig.hooks`. Surface set is `cli` + `agent-batch` (NOT bench:
 * the hook bus changes dispatch timing + can rewrite tool input, which is a
 * measurement-altering channel; bench callers stay byte-identical). The
 * `ide` surface gets no env-driven hooks wiring on purpose — the IDE surface
 * has its own hook plumbing seam and an env knob would race it.
 *
 * STRICT truthy gate — only `"1"` / `"on"` parse to `true`. `"true"` is
 * accepted by the other knobs but the task brief locks this one to "1"|"on"
 * specifically (matches the brief verbatim). Anything else returns
 * `undefined` so the caller falls through to the next layer.
 *
 * `apply` constructs an EMPTY `HookBus` (no logger, no opts) — the default
 * handlers / pre-registered handlers are the caller's concern. If
 * `cfg.hooks` is already set (a caller pre-wired its own bus), the knob is
 * a no-op (preserve caller intent — registry layering, NOT overwrite).
 */

import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { hooksSchema } from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch"]

/** Non-NOOP apply — wires the in-process `HookBus`. Bound into the central
 *  registrar (`APPLY_BINDINGS`) AND used to derive the back-compat knob export;
 *  ONE definition so the derived knob is byte-identical to the registered one. */
export const applyHooks = (cfg: AgentConfig, value: true, ctx: { surface: Surface }): AgentConfig => {
  if (value !== true) return cfg
  if (!SURFACES.includes(ctx.surface)) return cfg
  // Preserve a caller-supplied bus (defensive: a host that wired its own bus
  // with custom handlers must not be silently replaced by an empty one).
  if (cfg.hooks !== undefined) return cfg
  return { ...cfg, hooks: new HookBus() }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const hooksKnob = deriveKnob(hooksSchema, applyHooks)
