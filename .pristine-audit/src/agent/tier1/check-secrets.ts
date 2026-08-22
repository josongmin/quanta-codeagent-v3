/**
 * Tier-1 per-subsystem builder: CHECK_SECRETS block (ADR-0412).
 *
 * Returns `[checkSecretsTool]` when the env knob `QUANTA_SECRET_CHECK_TOOL`
 * is set to the canonical string `"on"`; `[]` otherwise (DEFAULT-OFF —
 * byte-identical for every legacy caller). The tool itself is a leaf over
 * `@/security/secret-detection` (async, detection-only); see the matching
 * tool file for the "why a tool and not a redaction wire" rationale.
 *
 * Mirror of the env-gating posture in `src/scheduler/runtime-wire.ts`
 * (`AUTOMATION_ENV_FLAG === "on"`) — a STRICT canonical value, not a
 * truthy-string-of-any-kind check. `QUANTA_SECRET_CHECK_TOOL=1` and other
 * common-truthy values do NOT enable the tool by design (avoids the classic
 * env-string footgun where downstream tooling forwards `"true"` / `"yes"` /
 * `"1"` inconsistently).
 *
 * Slot shape: the builder takes an optional `env` reader (defaults to
 * `process.env`) so tests can wire a deterministic env without mutating the
 * real process. The current ToolPort takes no other dependency — the scanner
 * is constructed lazily per call.
 *
 * Slice posture: imports `@/tool/check_secrets` (sibling tool slice) and
 * nothing else. Does NOT extend `AgentConfig` — env-gated builders sit beside
 * the canonical config-gated ones (mirroring how the automation engine's
 * composition root reads env at the apps boundary, not inside `tier1/*`).
 * Here we read env directly because there is NO port to inject — the gate is
 * the env knob itself.
 */

import type { Tool } from "@/tool"
import { checkSecretsTool } from "@/tool/check_secrets"

/** Canonical ENV flag name. The ONLY value that enables the tool is `"on"` —
 *  every other value (absent, empty, `"1"`, `"true"`, `"yes"`, `"off"`, …) ⇒
 *  default-OFF. Exported so the hellgate suite can assert the exact string. */
export const CHECK_SECRETS_ENV_FLAG = "QUANTA_SECRET_CHECK_TOOL" as const

/** Canonical enabling value — the ONLY string that flips the gate on. */
export const CHECK_SECRETS_ENABLED_VALUE = "on" as const

/** Minimal env reader port. The composition root reads the env knob and
 *  resolves the boolean gate via {@link checkSecretsToolEnabled}; this slice
 *  never reads `process.env` itself (slice-boundary invariant). Kept exported
 *  for the composition-root resolver + hellgate suite. */
export interface CheckSecretsEnvReader {
  get(name: string): string | undefined
}

/** Composition-root resolver: is the `check_secrets` tool enabled? The ONLY
 *  enabling value is `"on"` (every other value ⇒ default-OFF). The composition
 *  root passes its already-loaded env reader; the resolved boolean is what gets
 *  threaded into `AgentConfig.secretCheckToolEnabled`. */
export const checkSecretsToolEnabled = (env: CheckSecretsEnvReader): boolean =>
  env.get(CHECK_SECRETS_ENV_FLAG) === CHECK_SECRETS_ENABLED_VALUE

/** Build the check-secrets block. When `enabled` is true, returns the single
 *  `check_secrets` tool; otherwise returns an empty array so the composer can
 *  splat without a conditional. The gate is env-derived
 *  (`QUANTA_SECRET_CHECK_TOOL=on`) at the composition root — this slice takes a
 *  plain boolean and never reads `process.env`. */
export const buildCheckSecretsBlock = (enabled: boolean | undefined): Tool[] =>
  enabled === true ? [checkSecretsTool as Tool] : []
