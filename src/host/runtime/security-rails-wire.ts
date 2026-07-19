/**
 * SECURITY-RAILS OWNER — the SINGLE place that installs the two jun-6 anti-exfil
 * / authority rails onto an assembled (or compose-time) `AgentConfig`:
 *
 *   (a) write-budget       (`QUANTA_WRITE_BUDGET`)      — mints the per-session
 *       `SessionWriteBudget` onto `cfg.writeBudget`; dispatch then binds the
 *       current turn onto `ToolContext.writeBudget` so write/edit tally each
 *       mutation and the (N+1)th write in an untrusted turn is rejected.
 *   (b) sandbox-escalation (`QUANTA_SANDBOX_ESCALATION`) — installs the bash
 *       sandbox-block → escalation-retry handler (routes a sandboxed nonzero
 *       exit through the host `onConfirm` authority).
 *
 * WHY THIS OWNER EXISTS: the host `assembleAgentConfig` wired BOTH rails, but the
 * primary INTERACTIVE CLI builds its per-turn config through the runtime-context
 * overlay (NOT the assembler), so `QUANTA_WRITE_BUDGET=1` /
 * `QUANTA_SANDBOX_ESCALATION=1` were silently DARK on `quanta`. This module is the
 * ONE shared impl both surfaces route through:
 *   - the assembler calls {@link maybeWireWriteBudget} + {@link maybeWireBashSandboxEscalation}
 *     at its two existing sites (byte-identical to before — this file re-homes the
 *     exact same helpers);
 *   - the interactive-CLI compose calls {@link wireSecurityRails} with the deps it
 *     already has in scope (permissionStore + onConfirm).
 *
 * DEFAULT-OFF / byte-identical: knob unset ⇒ neither rail installs anything (the
 * write-budget slot stays unset; the escalation handler is cleared). Each helper
 * is caller-override-safe (a pre-set `cfg.writeBudget` / handler wins/skips).
 */

import type { AgentConfig } from "@/agent/types"
import type { PermissionStore } from "@/permission"
import type { runtimeConfigFromEnv } from "@/shared"
import { createSessionWriteBudget } from "@/tool/_shared/write-budget"
import { maybeWireBashSandboxEscalation } from "./sandbox-escalation-wire"

/** The runtime-config view both rails read (the full `runtimeConfigFromEnv`
 *  shape; each helper narrows to the fields it needs). */
type SecurityRailsConfig = ReturnType<typeof runtimeConfigFromEnv>

/**
 * jun-6 exfil-rail (a) — mint ONE per-session `SessionWriteBudget` when the
 * write-budget is opted in (`QUANTA_WRITE_BUDGET=1`) AND a cap is configured
 * (`QUANTA_WRITE_BUDGET_MAX=<N>`, a positive integer). BOTH must be present —
 * the cap is a KNOB value with NO hardcoded default (no-heuristics rule), so an
 * enabled-but-uncapped config stays inert. `untrustedContext` is resolved from
 * the EXISTING untrusted-envelope gate (`QUANTA_UNTRUSTED_ENVELOPE`): the budget
 * fires ONLY when the session is operating on untrusted input — a trusted
 * codegen session keeps unlimited writes. The over-cap verdict is `confirm` (the
 * narrow default per RFC §7 — the user can wave it through). Dispatch binds the
 * current turn so the counter resets per turn. Caller-override-safe; absent gate
 * / no cap ⇒ slot unset ⇒ no counter, byte-identical (default-OFF).
 *
 * (Re-homed verbatim from `agent-config-assembler.ts` so this owner is the single
 * impl — the assembler still calls it at its exact original site.)
 */
export const maybeWireWriteBudget = (cfg: AgentConfig, config: SecurityRailsConfig): void => {
  if (cfg.writeBudget !== undefined) return
  if (!config.writeBudget) return
  const max = config.writeBudgetMax
  if (max === undefined) return
  cfg.writeBudget = createSessionWriteBudget({
    untrustedContext: config.untrustedEnvelope,
    maxWritesPerTurn: max,
    overVerdict: "confirm",
  })
}

export { maybeWireBashSandboxEscalation }

/** The minimal surface-supplied deps a NON-assembler comp-root (the interactive
 *  CLI) must thread so BOTH rails can install: the gate-shared permission store
 *  the escalation records into + the host `onConfirm` authority. The interactive
 *  CLI mints an admissibility via a builder AFTER this call, so it can't rely on
 *  `cfg.admissibility.permissionStore` being populated — it passes them here. */
export interface SecurityRailsSurfaceDeps {
  readonly permissionStore: PermissionStore | undefined
  readonly onConfirm: AgentConfig["onConfirm"]
}

/**
 * THE OWNER — install BOTH security rails onto `cfg` from the runtime-config
 * `config`. One place both the host assembler and the interactive-CLI compose
 * route through.
 *
 * `surfaceDeps` (optional) lets a comp-root that hasn't populated
 * `cfg.admissibility` yet (the interactive CLI) supply the escalation store +
 * onConfirm directly; when present they are projected onto a shallow view of
 * `cfg` so {@link maybeWireBashSandboxEscalation} reads the gate-shared store.
 * Absent ⇒ the assembler path (reads `cfg.admissibility.permissionStore` /
 * `cfg.onConfirm` as before).
 *
 * Default-OFF: both knobs unset ⇒ write-budget slot stays unset + the escalation
 * handler is cleared ⇒ byte-identical.
 */
export const wireSecurityRails = (
  cfg: AgentConfig,
  config: SecurityRailsConfig,
  surfaceDeps?: SecurityRailsSurfaceDeps,
): void => {
  maybeWireWriteBudget(cfg, config)
  // The escalation wire reads `cfg.admissibility?.permissionStore` + `cfg.onConfirm`.
  // On the assembler path both are already on `cfg`. On the interactive-CLI path
  // the admissibility is built by a later builder, so the surface hands the
  // gate-shared store + onConfirm here; project them onto a shallow cfg view so
  // the SAME helper installs the handler against the same store the gate consults.
  const escalationCfg: AgentConfig =
    surfaceDeps === undefined
      ? cfg
      : ({
          ...cfg,
          onConfirm: surfaceDeps.onConfirm,
          admissibility: {
            ...(cfg.admissibility ?? {}),
            ...(surfaceDeps.permissionStore !== undefined
              ? { permissionStore: surfaceDeps.permissionStore }
              : {}),
          },
        } as AgentConfig)
  maybeWireBashSandboxEscalation(escalationCfg, config)
}

/**
 * CLI-friendly entrypoint — install BOTH rails at the interactive-CLI compose
 * seam (which builds its per-turn config through the runtime overlay, NOT the
 * assembler) and RETURN the minted `writeBudget` so the surface can thread it
 * onto its overlay slot (the base then carries it to per-turn dispatch). The
 * sandbox-escalation handler is installed as a side-effect (global seam) against
 * the surface-supplied gate-shared store + onConfirm.
 *
 * A NARROW carrier `AgentConfig` is minted here (not exposed to the surface) so
 * the CLI never has to construct a full config just to mint one budget slot.
 *
 * Default-OFF: knobs unset ⇒ returns `{ writeBudget: undefined }` (overlay slot
 * omitted) + clears the escalation handler ⇒ byte-identical to today.
 */
export const wireSecurityRailsForOverlay = (
  config: SecurityRailsConfig,
  surfaceDeps: SecurityRailsSurfaceDeps,
): { readonly writeBudget: AgentConfig["writeBudget"] } => {
  const carrier = {
    onConfirm: surfaceDeps.onConfirm,
    ...(surfaceDeps.permissionStore !== undefined
      ? { admissibility: { permissionStore: surfaceDeps.permissionStore } }
      : {}),
  } as AgentConfig
  wireSecurityRails(carrier, config, surfaceDeps)
  return { writeBudget: carrier.writeBudget }
}
