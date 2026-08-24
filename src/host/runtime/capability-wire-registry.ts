/**
 * `host/runtime/capability-wire-registry.ts` — declarative slot registry for the
 * optional agent-capability mutators, replacing the hand-ordered call-list in
 * `agent-config-assembler.ts`'s `wireOptionalCapabilitySlots`. Same proven
 * pattern as `PRE_FLIGHT_CONSULTS` (src/agent/dispatch.ts): a `readonly` array
 * of uniform entries applied in a single loop, so adding a capability is ONE
 * array entry instead of a new inline call (OCP), and the fragile
 * ordering-by-comment dependencies (“maybeWireAppshot must run after
 * maybeWireBrowser”, “maybeWireSideAgent after maybeWireMailbox”) become
 * EXPLICIT, machine-checked `dependsOn` edges.
 *
 * BYTE-IDENTICAL invariant: the array is authored in the EXACT current execution
 * order and applied in array order, so the assembled `AgentConfig` is identical
 * for every input. `dependsOn` is an explicit assertion of the intended partial
 * order — `assertWireOrder` (a drift guard) fails at module init if the array
 * order ever violates a declared edge, catching a future reorder that would
 * silently break a "runs AFTER" contract. Each entry's `apply` calls the SAME
 * per-capability helper the old list called; no per-capability logic moved.
 */

import type { AgentConfig } from "@/agent"
import { runtimeConfigFromEnv as runtimeConfigFromEnvImpl } from "@/shared"

/** Surface-owned env view + the derived runtime-config snapshot, threaded to
 *  every wire so entries with different arities in the legacy code (some read
 *  `env`, some the derived `config`, one reads both) share ONE uniform
 *  signature. `config` is computed ONCE per assembly (as before) and passed in. */
export interface CapabilityWireContext {
  readonly env: Record<string, string | undefined>
  readonly config: ReturnType<typeof runtimeConfigFromEnvImpl>
}

/** One capability-wiring step. `apply` MUTATES `cfg` in place (caller-override-
 *  safe + env-gated + no-op when its gate/resource is absent — unchanged from the
 *  extracted helper it delegates to). `dependsOn` lists the `name`s of steps that
 *  MUST have run before this one (the "runs AFTER X" contracts), enforced by
 *  {@link assertWireOrder}. */
export interface CapabilityWire {
  readonly name: string
  readonly dependsOn: readonly string[]
  readonly apply: (cfg: AgentConfig, ctx: CapabilityWireContext) => void
}

/**
 * Build the ordered capability-wire registry. The per-capability helpers are
 * injected (they live in `agent-config-assembler.ts` alongside the closures they
 * share) so this module stays a pure ordering/dependency layer with no wiring
 * logic of its own. The RETURNED array is in the exact legacy execution order;
 * {@link assertWireOrder} verifies that order honors every `dependsOn` edge.
 */
export const buildCapabilityWires = (helpers: {
  readonly maybeWireBrowser: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireAppshot: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireObjective: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireMailbox: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWirePeerMessageSurface: (
    cfg: AgentConfig,
    env: CapabilityWireContext["env"],
  ) => void
  readonly maybeWireWebSearch: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireBackgroundSubagent: (
    cfg: AgentConfig,
    env: CapabilityWireContext["env"],
    config: CapabilityWireContext["config"],
  ) => void
  readonly maybeWireReadFileState: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireDiagnostics: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireSkillMcp: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWirePromptCacheObserver: (
    cfg: AgentConfig,
    env: CapabilityWireContext["env"],
  ) => void
  readonly maybeWireVcsEventSink: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireProgressSink: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWirePiiRedaction: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
  readonly maybeWireSideAgent: (cfg: AgentConfig, config: CapabilityWireContext["config"]) => void
  readonly maybeWireWriteBudget: (cfg: AgentConfig, config: CapabilityWireContext["config"]) => void
  readonly maybeWireBudgetLedger: (cfg: AgentConfig, env: CapabilityWireContext["env"]) => void
}): readonly CapabilityWire[] => {
  const wires: readonly CapabilityWire[] = [
    { name: "browser", dependsOn: [], apply: (c, x) => helpers.maybeWireBrowser(c, x.env) },
    // G1 — AFTER browser so it can read the freshly-wired `cfg.browser.port`;
    // no-op unless QUANTA_APPSHOT=1 AND a browser is present.
    {
      name: "appshot",
      dependsOn: ["browser"],
      apply: (c, x) => helpers.maybeWireAppshot(c, x.env),
    },
    { name: "objective", dependsOn: [], apply: (c, x) => helpers.maybeWireObjective(c, x.env) },
    { name: "mailbox", dependsOn: [], apply: (c, x) => helpers.maybeWireMailbox(c, x.env) },
    // jul-15 W2 — decorate the mailbox with the peer-message SURFACE notifier
    // BEFORE side-agent (so daemon findings surface) and BEFORE the team wrap (so
    // a denied cross-team send never reaches the display seam). No-op unless
    // QUANTA_PEER_MSG_SURFACE is on AND a mailbox is present (byte-identical).
    {
      name: "peerMessageSurface",
      dependsOn: ["mailbox"],
      apply: (c, x) => helpers.maybeWirePeerMessageSurface(c, x.env),
    },
    { name: "webSearch", dependsOn: [], apply: (c, x) => helpers.maybeWireWebSearch(c, x.env) },
    {
      name: "backgroundSubagent",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWireBackgroundSubagent(c, x.env, x.config),
    },
    {
      name: "readFileState",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWireReadFileState(c, x.env),
    },
    {
      name: "diagnostics",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWireDiagnostics(c, x.env),
    },
    { name: "skillMcp", dependsOn: [], apply: (c, x) => helpers.maybeWireSkillMcp(c, x.env) },
    {
      name: "promptCacheObserver",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWirePromptCacheObserver(c, x.env),
    },
    {
      name: "vcsEventSink",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWireVcsEventSink(c, x.env),
    },
    {
      name: "progressSink",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWireProgressSink(c, x.env),
    },
    // ADR-0399 — operator switch (`QUANTA_PII_REDACTION=1`) populates
    // `cfg.redaction.pii`. Byte-identical default-OFF (the secret branch of the
    // same RedactionConfig is untouched).
    {
      name: "piiRedaction",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWirePiiRedaction(c, x.env),
    },
    // AFTER mailbox so the in-process path reuses the session mailbox when present
    // (and AFTER peerMessageSurface so daemon findings ride the notify-decorated
    // mailbox — preserved by the array order + the mailbox dependsOn chain).
    {
      name: "sideAgent",
      dependsOn: ["mailbox", "peerMessageSurface"],
      apply: (c, x) => helpers.maybeWireSideAgent(c, x.config),
    },
    {
      name: "writeBudget",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWireWriteBudget(c, x.config),
    },
    {
      name: "budgetLedger",
      dependsOn: [],
      apply: (c, x) => helpers.maybeWireBudgetLedger(c, x.env),
    },
  ]
  assertWireOrder(wires)
  return wires
}

/**
 * Drift guard: assert the registry array is in an order that honors every
 * `dependsOn` edge — i.e. for each wire, all of its dependencies appear EARLIER
 * in the array. Also validates that every `dependsOn` name refers to a real wire
 * (a typo'd dependency is a silent no-constraint bug). Throws at module init on
 * violation so a future reorder that breaks a "runs AFTER" contract fails loudly
 * BEFORE any config is assembled — not as a subtle wrong-order runtime bug.
 *
 * This is the registry's analogue of the ordering-by-comment the loop replaces:
 * the comment said "must run after X"; this makes it executable.
 */
export const assertWireOrder = (wires: readonly CapabilityWire[]): void => {
  const indexByName = new Map<string, number>()
  wires.forEach((w, i) => {
    if (indexByName.has(w.name)) {
      throw new Error(`capability-wire-registry: duplicate wire name '${w.name}'`)
    }
    indexByName.set(w.name, i)
  })
  wires.forEach((w, i) => {
    for (const dep of w.dependsOn) {
      const depIdx = indexByName.get(dep)
      if (depIdx === undefined) {
        throw new Error(
          `capability-wire-registry: wire '${w.name}' depends on unknown wire '${dep}'`,
        )
      }
      if (depIdx >= i) {
        throw new Error(
          `capability-wire-registry: wire '${w.name}' (index ${i}) must run AFTER its ` +
            `dependency '${dep}' (index ${depIdx}) — array order violates the dependsOn contract`,
        )
      }
    }
  })
}

/** Apply the registry in array order (== topological order, guarded above),
 *  mutating `cfg`. This is the single loop that replaces the ~17 hand-ordered
 *  calls; byte-identical because array order === legacy call order. */
/** Fold `wires` onto `cfg`, in place, deriving the runtime-config once.
 *
 *  This exists as its own export because the registry has TWO consumers, not
 *  one. `assembleAgentConfig` folds it for the headless / SDK / batch surfaces;
 *  the INTERACTIVE CLI never calls that function — it binds through
 *  `context-binding#wireRuntimePorts`, which must fold the SAME registry or the
 *  two surfaces disagree about which capabilities exist.
 *
 *  They did disagree. Measured slot-by-slot under identical gates, the CLI left
 *  `browser`, `appshot`, `diagnosticsProvider`, `promptCacheObserver`,
 *  `vcsEventSink` and `sideAgentDaemons` unset while the assembler set all six,
 *  so an operator who turned those gates on got nothing and no error saying why.
 *  `readFileState` was a seventh and worse, because its gate is DEFAULT-ON.
 *
 *  Every wire is env-gated and caller-override-safe, so folding on a path whose
 *  gates are unset is a no-op. */
export const foldCapabilityWires = (
  wires: readonly CapabilityWire[],
  cfg: AgentConfig,
  env: CapabilityWireContext["env"],
): void => {
  applyCapabilityWires(wires, cfg, { env, config: runtimeConfigFromEnvImpl(env) })
}

export const applyCapabilityWires = (
  wires: readonly CapabilityWire[],
  cfg: AgentConfig,
  ctx: CapabilityWireContext,
): void => {
  for (const wire of wires) wire.apply(cfg, ctx)
}
