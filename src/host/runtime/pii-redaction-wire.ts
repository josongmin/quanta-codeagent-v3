/**
 * ADR-0399 last-mile — the missing OPERATOR SWITCH for the PII-redaction
 * dispatch pass.
 *
 * The masking chokepoint is LANDED (`dispatch/execute.ts#applyRedaction`,
 * application point #2): after the secret pass, when
 * `config.redaction.pii.enabled === true`, a `compositePiiScanner().redactText`
 * pass masks PII on the tool_result the NEXT turn's LLM sees. But nothing in any
 * production composition root ever populated `cfg.redaction.pii` — so the pass
 * was UNREACHABLE (wired-but-inert): the sibling SECRET branch is reachable only
 * because redaction is DEFAULT-ON (an absent `redaction` block still redacts
 * secrets), whereas the PII branch's strict `=== true` toggle stays OFF for
 * every operator with no enable path.
 *
 * This module is that enable path — a BYTE-FOR-BYTE clone of the already-landed
 * `maybeWireProgressSink` / `maybeWireVcsEventSink` env-gate pattern
 * (`progress-sink-wire.ts`): read a gate off the injected `AssemblerEnv` view,
 * populate a `cfg` slot when on, no-op (byte-identical) when off. It lives in
 * `@/host/runtime` (the composition layer) so the assembler carries only a
 * single import + call line — keeping the concurrently-edited god-module hunk
 * minimal.
 *
 * Env discipline: like every other `maybeWire*` helper, it reads its gate off
 * the injected `AssemblerEnv` view (never the `process.env` global), so the
 * module stays `process.env`-free and below `src/apps/**`.
 */

import type { AgentConfig } from "@/agent"
import type { RedactionConfig } from "@/security"
import { ALL_PII_KINDS, type PiiKind } from "@/security/pii-redaction"
import { gateOn } from "@/shared"
import type { AssemblerEnv } from "./agent-config-assembler"

/** Parse a comma-separated `QUANTA_PII_KINDS` env value into the closed
 *  {@link PiiKind} subset the scanner accepts. Unknown / empty tokens are
 *  dropped (no throw — a stray token must never break assembly). Returns
 *  `undefined` when the env is absent OR yields no valid kind, so the scanner
 *  falls back to its "all kinds" default (byte-identical to omitting the knob). */
const parsePiiKinds = (raw: string | undefined): ReadonlySet<PiiKind> | undefined => {
  if (raw === undefined) return undefined
  const kinds = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t): t is PiiKind => ALL_PII_KINDS.has(t as PiiKind))
  return kinds.length > 0 ? new Set(kinds) : undefined
}

/** Parse a comma-separated `QUANTA_PII_ALLOWLIST` env value into the exact-string
 *  passthrough list (fixture tokens the operator trusts). Blank entries are
 *  dropped; an absent env or all-blank value yields `undefined` (no allowlist,
 *  byte-identical to omitting the knob). */
const parsePiiAllowlist = (raw: string | undefined): readonly string[] | undefined => {
  if (raw === undefined) return undefined
  const list = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return list.length > 0 ? list : undefined
}

/**
 * Wire the ADR-0399 PII-redaction pass ON from an operator env switch, mirroring
 * exactly how the sibling redaction/secret config is threaded onto `cfg`
 * (a `RedactionConfig` on the base). OPT-IN (`QUANTA_PII_REDACTION=1`): off by
 * default for every surface (this assembler is shared by bench/eval +
 * web-daemon, so a default-ON would change their tool_result stream +
 * SWE-bench reproducibility — the same reasoning the other `maybeWire*` gates
 * cite). When on, populates `cfg.redaction.pii = { enabled: true, ... }` so the
 * dispatch chokepoint's strict `=== true` toggle fires; the SECRET branch of
 * the SAME `RedactionConfig` (`disabled` / `acknowledgedRisk` / `whitelist`) is
 * PRESERVED verbatim (the two passes are orthogonal — either can be on with the
 * other off).
 *
 * Optional sub-knobs, both defaulting to the scanner's own default when absent
 * (byte-identical to omitting them):
 *   - `QUANTA_PII_KINDS` — comma list restricting the scan to a {@link PiiKind}
 *     subset (unknown tokens dropped; empty ⇒ ALL kinds);
 *   - `QUANTA_PII_ALLOWLIST` — comma list of exact strings to pass through.
 *
 * Caller-override-safe (ADR-0332): a pre-set `cfg.redaction.pii` is preserved
 * (a host that already opted in via the base wins). Absent gate ⇒ `cfg.redaction`
 * is left EXACTLY as the caller supplied it (usually unset ⇒ no PII block ⇒ the
 * dispatch pass is skipped ⇒ byte-identical default-OFF).
 */
export const maybeWirePiiRedaction = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!gateOn(env, "QUANTA_PII_REDACTION")) return
  // Caller-override-precedence: a base that already carries a pii block wins.
  if (cfg.redaction?.pii !== undefined) return
  const kinds = parsePiiKinds(env.QUANTA_PII_KINDS)
  const allowlist = parsePiiAllowlist(env.QUANTA_PII_ALLOWLIST)
  const pii: NonNullable<RedactionConfig["pii"]> = {
    enabled: true,
    ...(kinds !== undefined ? { kinds } : {}),
    ...(allowlist !== undefined ? { allowlist } : {}),
  }
  // Orthogonal merge: keep any existing secret-branch config (disabled / ack /
  // whitelist) the caller threaded on the base; only ADD the pii sub-block.
  cfg.redaction = { ...cfg.redaction, pii }
}
