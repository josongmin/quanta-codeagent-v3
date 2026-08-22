/**
 * `host/runtime/agent-arg-builder/command-hooks-wire.ts` — extracted from
 * `agent-arg-builder.ts` (god-module split). The composition-root command-hooks
 * install slice: project the `QUANTA_COMMAND_HOOKS` triple-gate + the optional
 * `QUANTA_HOOK_TRUST_GATE` review ledger onto the base's {@link HookBus}. The
 * public `installCommandHooksIntoBase` surface is re-exported from
 * `agent-arg-builder.ts` byte-compatibly.
 */

import { HookBus } from "@/agent"
import {
  type CommandHookBinding,
  type CommandHookConfig,
  type CommandHookReviewPort,
  createSandboxCommandHookExec,
  defaultHookApprovalsPath,
  HookReviewStore,
  installCommandHooks,
  normalizeCommandHookGate,
} from "@/agent/command-hooks"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import { gateOn, quantaHomeDirFrom } from "@/shared"

// ADR-0454 jun-02 wire — install disk-configured command hooks onto the base's
// HookBus. SECURITY: command hooks run ARBITRARY shell, so the slice is
// triple-gated INSIDE (enabled + acknowledgedRisk + ≥1 binding) + injection-safe
// (payload is stdin-JSON, NEVER the command string) + env-allowlist-scrubbed +
// timeout-bounded. This root wire only SUPPLIES config + ports — it cannot
// weaken those gates.
//
// Default-OFF: `QUANTA_COMMAND_HOOKS !== "1"` ⇒ no config, no throw, no handlers
// (byte-identical). `enabled` WITHOUT `acknowledgedRisk` ⇒ normalizeCommandHookGate
// THROWS at startup (fail-fast — never mid-turn). Bindings come ONLY from
// `settings.json#hooks` (loaded async at runMain, threaded via the partial).
//
// Permission port: per the approved design the TRIPLE-GATE IS the approval — the
// operator explicitly armed (enabled), typed an audit-grade acknowledgement, and
// authored the bindings on disk — so `isAllowed` returns true; `bypass` mode is
// the recommended operating posture. The port is an INJECTED seam a host MAY
// tighten (e.g. route through an interactive approval) without touching the slice.
export const installCommandHooksIntoBase = (
  base: AssembleRequest["base"],
  env: NodeJS.ProcessEnv,
  bindings: readonly CommandHookBinding[] | undefined,
): void => {
  if (!gateOn(env, "QUANTA_COMMAND_HOOKS")) return // default-OFF
  // T04 — the trust gate is an INDEPENDENT opt-in (`QUANTA_HOOK_TRUST_GATE`).
  // OFF (default) ⇒ `needsReview` is informational and every armed binding fires
  // (byte-identical pre-T04). ON ⇒ imported / repo-shipped bindings flagged
  // `needsReview` are HELD until approved via `/hooks` (read from the on-disk
  // approval ledger below).
  const trustGate = gateOn(env, "QUANTA_HOOK_TRUST_GATE")
  const config: CommandHookConfig = {
    enabled: true,
    ...(env.QUANTA_COMMAND_HOOKS_ACK !== undefined
      ? { acknowledgedRisk: env.QUANTA_COMMAND_HOOKS_ACK }
      : {}),
    bindings: bindings ?? [],
    trustGate,
  }
  const gate = normalizeCommandHookGate(config) // throws on enabled-without-ack (fail-fast)
  if (!gate.armed) return // ack present but no bindings ⇒ disarmed ⇒ no-op
  // Command hooks need a bus; reuse the observability bus if present, else mint
  // one (command hooks are independent of QUANTA_OBSERVABILITY).
  const bus = base.hooks ?? new HookBus()
  base.hooks = bus
  installCommandHooks(bus, gate, {
    exec: createSandboxCommandHookExec(),
    permission: { isAllowed: () => true },
    cwd: base.cwd,
    // Review port — wired ONLY when the trust gate is armed AND at least one
    // binding is review-gated (else byte-identical: no ledger read). Re-`load`s
    // the (tiny) ledger per hook fire so a mid-session `/hooks approve` takes
    // effect immediately without threading an in-process handle from the CLI.
    ...(trustGate && gate.bindings.some((b) => b.needsReview === true)
      ? { review: hookReviewPort(env) }
      : {}),
  })
}

/** T04 — the production review port: read-through to the on-disk approval
 *  ledger (user-config-dir scoped). Fail-closed — an unreadable / absent ledger
 *  means "nothing approved", so an un-reviewed imported hook never fires. */
const hookReviewPort = (env: NodeJS.ProcessEnv): CommandHookReviewPort => {
  const userConfigDir = quantaHomeDirFrom(env)
  const path = defaultHookApprovalsPath(userConfigDir)
  return {
    isApproved: async (binding) => (await HookReviewStore.load(path)).isApproved(binding),
  }
}
