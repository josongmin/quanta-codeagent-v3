import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import { parseEnvFlag } from "@/runner/assemble"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import type { LocalEnvSelection } from "@/runtime"
import { gateDisabled, gateOn } from "@/shared"
import type { AssembleRequestPartial } from "./agent-arg-builder"

/** ADR-0303 god-module split — the `buildBaseFromArgs` "spread-ready config
 *  slot" projection family. Each helper folds one env knob / partial field into
 *  a `{}`-when-off object so the base literal in `buildBaseFromArgs` carries no
 *  conditional branch for it (keeps that keystone under biome's cognitive-
 *  complexity cap). Pure leaf helpers: they call only module-level imports, so
 *  the type-only back-import of `AssembleRequestPartial` from `./agent-arg-builder`
 *  is erased at runtime (no import cycle). Moved VERBATIM out of
 *  `agent-arg-builder.ts`. */

/** ADR-0428 jun-02 wire — resolve the socket-level egress proxy config from the
 *  composition-root env view and return a SPREAD-READY slot (`{}` when off) so
 *  the base literal carries no conditional branch for it (keeps
 *  `buildBaseFromArgs` under biome's cognitive-complexity cap). Absent / "0" /
 *  empty / zero-token ⇒ `{}` (default-OFF byte-identical). */
export const resolveNetworkProxySlot = (
  env: NodeJS.ProcessEnv,
): { networkProxy?: NonNullable<AssembleRequest["base"]["networkProxy"]> } => {
  const networkProxy = resolveNetworkProxyFromEnv(env)
  return networkProxy !== undefined ? { networkProxy } : {}
}

// ADR-0452 jun-02 wire — composition-root projection of `QUANTA_PREWARM` into
// `AgentConfig.prewarm`. Extracted (mirrors `resolveNetworkProxySlot`) so the
// branch lives here, NOT in `buildBaseFromArgs` (keeps that function under
// biome's cognitive-complexity cap). Default-OFF (`parseEnvFlag(…, false)`):
// absent ⇒ `undefined` ⇒ slot omitted ⇒ the loop reads no clock, runs no warm,
// emits no TTFM key (byte-identical legacy). `now` is the REAL clock injected
// ONLY here at the root (the slice body reads no timer); the stock LLM adapters
// implement no `prewarm` hook, so warming is a documented no-op while the
// `quanta.startup.*` TTFM observability is genuinely active.
export const resolvePrewarmSlot = (
  env: NodeJS.ProcessEnv,
): { prewarm?: NonNullable<AssembleRequest["base"]["prewarm"]> } =>
  parseEnvFlag(env.QUANTA_PREWARM, /* defaultOn */ false)
    ? { prewarm: { enabled: true, now: () => Date.now() } }
    : {}

// RFC jun-17 (code-intelligence warm backend) — project `QUANTA_LSP_PREWARM`
// into `AgentConfig.lspPrewarm`. DEFAULT-ON, but GATED on the nav tools actually
// being exposed (`QUANTA_LSP_TOOLS=full`, matching `resolveLspNavMode`, OR the
// bench-only `QUANTA_BENCH_LSP`) — warming a server whose tools are not
// registered is wasted work, so with nav OFF the slot is omitted (byte-identical
// legacy). With nav ON the warm fires unless explicitly killed via
// `QUANTA_LSP_PREWARM=0` (`gateDisabled` off-switch, also the bench A/B cold
// arm). The session signal is not available at config-build time, so
// `warmSignal` is left to the (bench-side) caller; the orchestrator
// self-terminates via evict / idle-TTL.
export const resolveLspPrewarmSlot = (
  env: NodeJS.ProcessEnv,
): { lspPrewarm?: NonNullable<AssembleRequest["base"]["lspPrewarm"]> } => {
  const navEnabled = env.QUANTA_LSP_TOOLS === "full" || gateOn(env, "QUANTA_BENCH_LSP")
  if (!navEnabled || gateDisabled(env, "QUANTA_LSP_PREWARM")) return {}
  return { lspPrewarm: { enabled: true } }
}

// Spread-ready projection of the partial's resolved local-env selection (`{}`
// when absent ⇒ no branch in `buildBaseFromArgs`, keeps it under biome's
// cognitive-complexity cap — same pattern as `resolvePrewarmSlot`).
export const localEnvSlotOf = (p: AssembleRequestPartial): { localEnv?: LocalEnvSelection } =>
  p.localEnv !== undefined ? { localEnv: p.localEnv } : {}

// Spread-ready projection of the partial's named-agent resolver (`{}` when absent
// ⇒ no branch in `buildBaseFromArgs`, keeps it under biome's cognitive-complexity
// cap — same pattern as `localEnvSlotOf`). Absent ⇒ `AgentConfig.namedAgentResolver`
// stays unset ⇒ the subagent runner's resolve path is byte-identical (no named
// agent ever matches).
export const namedAgentResolverSlotOf = (
  p: AssembleRequestPartial,
): { namedAgentResolver?: import("@/agent").NamedAgentResolver } =>
  p.namedAgentResolver !== undefined ? { namedAgentResolver: p.namedAgentResolver } : {}
