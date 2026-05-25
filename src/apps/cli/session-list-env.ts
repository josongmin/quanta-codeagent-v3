/**
 * CLI surface adapter — `session list` env/TTY resolver.
 *
 * Resolves the CLI surface's defaults for `session list` from validated
 * runtime config + TTY. Lives here (apps/cli) so the surface-agnostic
 * `@/runner/session-ops` slice never reads env directly (architecture
 * guard, RFC may-22 §X — Layer-2 takes typed config only).
 *
 *  - `QUANTA_SESSION_LIST_FORMAT=plain|rich` pins the format (power-user
 *     override + test seam — callers that pipe through tee/less rarely
 *     want ANSI escapes even on a real TTY).
 *  - `QUANTA_SESSION_LIST_MAX=<N>` caps the rich-format default window.
 *  - Else `defaultFormat = "rich"` when stdout is a TTY, `"plain"`
 *     otherwise (pipelines + tests stay byte-identical).
 *
 * Env validation lives in `@/shared#runtimeConfig` (per the
 * anti-regression scan: feature sites never read process.env directly).
 * TTY detection is a presentation-layer signal that doesn't fit
 * runtimeConfig — it's read at the surface boundary like the existing
 * `apps/cli/shell-stream-painter.ts` does for `process.stderr.isTTY`.
 *
 * Extracted from the now-deleted `src/apps/cli/session-commands.ts` shim
 * (CLI-05, ADR-0305). Body is verbatim — behavior is byte-identical.
 */
import type { SessionListEnv } from "@/runner/session-ops"
import { runtimeConfig } from "@/shared"

/** Resolve `session list` defaults from validated runtime config + stdout TTY.
 *  Returns `undefined` ONLY in the (currently unreachable) shape where
 *  `defaultFormat` would itself be undefined; in practice always returns a
 *  populated object. Callers pass the result to
 *  `SessionCommandDeps["listEnv"]` (optional field — the runner slice falls
 *  back to internal safe defaults when omitted). */
export const resolveCliSessionListEnv = (): SessionListEnv | undefined => {
  const cfg = runtimeConfig()
  const defaultFormat: "rich" | "plain" =
    cfg.sessionListFormat ?? (process.stdout.isTTY === true ? "rich" : "plain")
  return cfg.sessionListMax !== undefined
    ? { defaultFormat, defaultMaxN: cfg.sessionListMax }
    : { defaultFormat }
}
