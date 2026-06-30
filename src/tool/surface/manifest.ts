/**
 * Tool-surface SSOT (jun-03) — the single managed catalog of the LLM-accessible
 * tool set: which tools exist, what gates them, and whether they are ON by
 * default per surface. The companion to the FEATURE catalog (`tools/feature-
 * catalog`): fc governs *features*, this governs the *LLM tool-access axis*
 * (gate + per-surface default) that was previously scattered across
 * `buildDefaultTools` + the tier-1 blocks (`@/agent/features`) + the host
 * `maybeWireX` slots (`@/host/runtime/agent-config-assembler`) + the CLI env
 * seed (`@/apps/cli`). One file now answers "what can the agent call, and when".
 *
 * # Why a manifest (not just docs)
 *
 * Hand-written docs drift. This module is the SSOT a TWO-WAY drift guard
 * (`tests/unit/tool-surface-manifest-hellgate.test.ts`) pins against the REAL
 * registry assembly: every registered tool name MUST appear here (no orphan
 * tools — that test caught `apply_patch_structured` missing from fc), and every
 * manifest entry MUST be a real tool name (no stale rows). Adding a tool without
 * a manifest row, or deleting a tool without removing its row, fails CI.
 *
 * # The two axes
 *
 * 1. BASE — always registered by `buildDefaultTools()` with no ports. These are
 *    the unconditional read/edit/shell/search primitives; their availability is
 *    not gated, so they carry `gate: { kind: "always" }` and `default: "on"` on
 *    every surface. Derived + asserted against `buildDefaultTools()` by the
 *    drift guard, NOT hand-maintained beyond the name list.
 * 2. GATED — registered only when an env flag / config slot / external resource
 *    is present. THIS is the genuinely-scattered data the manifest owns: the
 *    gate (env var or `AgentConfig` slot) AND the per-surface default
 *    (`on` = wired by default on that surface, `opt-in` = needs an explicit
 *    flag, `resource` = self-gates on an external resource being present).
 *
 * # Plane-clean
 *
 * Lives in `@/tool` (imported by every gate site: `@/apps/cli`, `@/host`,
 * `@/runner`). Imports nothing but `@/shared` — the {@link ToolSurface} axis is
 * a local string union (NOT `@/runner/knobs`'s `Surface`, which `@/tool` may not
 * import per the slice fence). Pure data + pure `resolveToolGate`; no I/O.
 *
 * # NO arbitrary heuristics
 *
 * Every default state is a documented decision (see each row's `note`), not a
 * guess: CLI-default-ON only for cheap/in-memory capabilities; `resource` for
 * anything needing Chrome / an API key; `opt-in` for surfaces sensitive to a
 * changed tool menu (bench/eval reproducibility) or where a tool OVERLAPS
 * another (background-scheduler vs the 6-tool router).
 */

import { assertNever } from "@/shared"
import { BASE_TOOL_NAMES, GATED_TOOLS } from "./gated-tools"

/** Surfaces the agent runs on. Distinct from `@/runner/knobs`'s `Surface`
 *  (which `@/tool` cannot import) — this is the tool-availability axis only. */
export type ToolSurface = "cli" | "bench" | "web" | "ide" | "headless" | "terminal"

/** All surfaces, in stable order — the drift guard + renderers iterate this. `terminal` (RFC
 *  jun-29) is a FIRST-CLASS surface (NOT folded into `bench` — a terminal-operator session must
 *  not inherit SWE-bench's repo-edit tools): its registry is the BASE-free `buildTerminalTools`
 *  (pty_* only), so the existing surfaces' defaults are byte-identical. */
export const TOOL_SURFACES: readonly ToolSurface[] = [
  "cli",
  "bench",
  "web",
  "ide",
  "headless",
  "terminal",
]

/** How a tool's availability is decided. */
export type ToolGate =
  /** Always registered (base default set). */
  | { readonly kind: "always" }
  /** Gated on a boolean env flag (the surface's env view). `default-on` ⇒ the
   *  flag defaults true when unset; `opt-in` ⇒ the flag must be explicitly set. */
  | { readonly kind: "env-flag"; readonly env: string }
  /** Gated on an `AgentConfig` slot the composition root populates (often itself
   *  behind an env flag — recorded in `env` when there is one). */
  | { readonly kind: "config-slot"; readonly slot: string; readonly env?: string }
  /** Self-gates on an external resource being present (a binary on PATH, an API
   *  key). Wired automatically when the resource resolves; never forced. */
  | { readonly kind: "resource"; readonly resource: string; readonly env?: string }
  /** ORPHAN — the tool factory exists but is wired into NO assembly path, so no
   *  agent on any surface can call it today. Catalogued (not hidden) so the
   *  orphan is VISIBLE + the drift guard tracks it; `reason` says why it's parked. */
  | { readonly kind: "unwired"; readonly reason: string }

/** Per-surface default availability. `on` = wired by default; `opt-in` = needs an
 *  explicit gate; `resource` = wired iff the external resource is present. */
export type ToolDefault = "on" | "opt-in" | "resource"

/** Coarse risk class — drives the "should this be default-ON" judgement and is
 *  cross-checkable against the live `Tool.isReadOnly()` / `Tool.hitlTier`. */
export type ToolRisk = "read-only" | "mutating" | "exec" | "network" | "spawns-subagent" | "meta"

/** One managed tool (or tool-group sharing a single gate). */
export interface ToolSurfaceEntry {
  /** The registered tool `name` (or representative name for a same-gate group). */
  readonly name: string
  /** Sibling tool names that share this exact gate (e.g. the 6-tool router). */
  readonly group?: readonly string[]
  /** Where the tool is built. */
  readonly origin: string
  readonly gate: ToolGate
  /** Per-surface default. Surfaces omitted inherit `opt-in` (conservative). */
  readonly default: Partial<Record<ToolSurface, ToolDefault>>
  readonly risk: ToolRisk
  /** ADR reference, when one exists. */
  readonly adr?: string
  /** Why this default state (the non-heuristic justification). */
  readonly note?: string
}

// The BASE + GATED tool DATA table lives in `./gated-tools` (split out to keep
// this SSOT module under the god-MODULE line cap). Re-exported so every existing
// importer of `@/tool/surface/manifest` keeps a byte-identical public API.
export { BASE_TOOL_NAMES, GATED_TOOLS }
export const surfaceDefaultFor = (entry: ToolSurfaceEntry, surface: ToolSurface): ToolDefault =>
  entry.default[surface] ?? "opt-in"

/** Should this surface seed the tool's env flag to ON by default? True only for
 *  `on`-default entries that gate on an env flag / config-slot-with-env — i.e.
 *  the set the CLI host seeds. `resource`/`opt-in` are never auto-seeded. */
export const shouldSeedOn = (entry: ToolSurfaceEntry, surface: ToolSurface): boolean => {
  if (surfaceDefaultFor(entry, surface) !== "on") return false
  const g = entry.gate
  switch (g.kind) {
    case "env-flag":
      return true
    case "config-slot":
      return g.env !== undefined
    case "resource":
    case "always":
    case "unwired":
      return false
    default:
      return assertNever(g)
  }
}

/** Every env var the manifest names — the canonical gate-env set the CLI seed
 *  block + drift guard read from (no hand-kept parallel list). */
export const seedEnvVarsForSurface = (surface: ToolSurface): readonly string[] => {
  const out: string[] = []
  for (const entry of GATED_TOOLS) {
    if (!shouldSeedOn(entry, surface)) continue
    const g = entry.gate
    const env = g.kind === "env-flag" ? g.env : g.kind === "config-slot" ? g.env : undefined
    if (env !== undefined && !out.includes(env)) out.push(env)
  }
  return out
}

/** Flatten an entry to all the concrete tool names it governs. */
export const entryToolNames = (entry: ToolSurfaceEntry): readonly string[] => [
  entry.name,
  ...(entry.group ?? []),
]

/** All tool names the manifest accounts for (base + every gated group member).
 *  The drift guard asserts this set covers the live registry. */
export const ALL_MANIFEST_TOOL_NAMES: readonly string[] = [
  ...BASE_TOOL_NAMES,
  ...GATED_TOOLS.flatMap(entryToolNames),
]
