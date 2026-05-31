/**
 * Per-slice deny-lists and named carve-outs for `registerSliceBoundarySuite`.
 * SSOT for slice-boundary policy — edit here, not in individual test files.
 */

import type { SliceBoundaryConfig } from "./slice-boundary-scanner"

const PEER_LIBRARY_DENY = [
  "@/agent",
  "@/tool",
  "@/mcp",
  "@/rules",
  "@/migration",
  "@/session",
  "@/subagent",
  "@/skill",
  "@/observability",
  "@/llm",
  "@/memory",
  "@/storage",
  "@/permission",
  "@/lsp",
  "@/stream",
] as const

export const SLICE_BOUNDARY_CONFIGS: Record<string, SliceBoundaryConfig> = {
  agent: {
    slice: "agent",
    denyImports: ["@/migration"],
    // Documented env-boundary carve-outs (mirror of the `tool` slice's
    // `from-env.ts`/`runner.ts` precedent). The session-resource-registry is a
    // self-contained composition seam: ADR-0347's process-level lazy-init
    // singleton + ADR-0368's caller-owned builder explicitly designed their
    // env reads to live HERE — the header of `caller-owned-builder.ts` records
    // that the four threading alternatives (env var / signature change /
    // factory / etc.) all broke the first-call-wins lazy-init OR the
    // multi-tenant observability invariant. These four files are the sanctioned
    // env-resolution boundary for that subsystem. `inspector.hellgate.test.ts`
    // legitimately save/restores `process.env` to drive the env-selected
    // backend it is testing.
    envAllowFiles: [
      "global.ts",
      "caller-owned-builder.ts",
      "auto-sweep.ts",
      "inspector.ts",
      "inspector.hellgate.test.ts",
    ],
    // `default-stdout-emitter.ts` (ADR-0220) deliberately exposes
    // `process.stderr` as the production default sink for git-directives.
    // The sink is injectable; the default literal is the documented
    // contract — exempted from the slice's no-raw-stdio invariant.
    stdioAllowFiles: [
      "admissibility-gate.ts",
      "hitl-tier-registry.ts",
      "default-stdout-emitter.ts",
      // ADR-0234 git-directive emit wire — `loop-helpers.ts` resolves the
      // `cfg.gitDirectiveEmit.sink` knob ("stdout"|"stderr"|fn) into a
      // `DirectiveSink` for the emitter. The sink is fully injectable
      // (caller may pass an inline function); the `process.stdout` /
      // `process.stderr` literals only appear in the sink-resolver as the
      // documented defaults — exempted from the slice's no-raw-stdio invariant.
      "loop-helpers.ts",
    ],
    requireSliceBarrel: true,
  },
  tool: {
    slice: "tool",
    denyImports: [
      "@/agent",
      "@/mcp",
      "@/rules",
      "@/migration",
      "@/memory",
      "@/session",
      "@/subagent",
      "@/skill",
      "@/observability",
      "@/permission",
      "@/lsp",
      "@/stream",
    ],
    // Documented carve-out: coverage_check tool consumes the @/observability/coverage
    // sub-barrel (ADR-0165) as a typed contract — the coverage primitives are
    // observability services that tools intentionally call into. Reviewed exception.
    allowImports: ["@/observability/coverage"],
    envAllowFiles: ["runner.ts", "from-env.ts"],
    requireSliceBarrel: true,
  },
  memory: {
    slice: "memory",
    denyImports: [...PEER_LIBRARY_DENY],
    stdioAllowFiles: ["store.ts"],
    requireSliceBarrel: true,
  },
  llm: {
    slice: "llm",
    denyImports: [...PEER_LIBRARY_DENY],
    // Documented cross-slice contract (mirror of the `tool` slice's
    // `@/observability/coverage` carve-out). ADR-0323/0328/0337 wire the
    // image-sanitization retry path against `@/memory`'s `HistorySanitizationPort`
    // — `wrapping.ts` consumes that port as a typed contract (import type), and
    // the slice's end-to-end hellgate drives the real
    // `createWorkingMemoryHistorySanitization(wm)` to prove the closed-port is
    // wired straight through `wm.snapshot()`. Reviewed exception.
    allowImports: ["@/memory/history-sanitization"],
    requireSliceBarrel: true,
  },
  permission: {
    slice: "permission",
    denyImports: [
      "@/agent",
      "@/tool",
      "@/mcp",
      "@/rules",
      "@/migration",
      "@/memory",
      "@/session",
      "@/subagent",
      "@/skill",
      "@/observability",
      "@/llm",
      "@/lsp",
      "@/stream",
      "@/storage",
    ],
    stdioAllowFiles: ["json-state-file.ts"],
    requireSliceBarrel: true,
  },
  observability: {
    slice: "observability",
    denyImports: [...PEER_LIBRARY_DENY],
    stdioAllowFiles: ["logger.ts", "console-sink.ts"],
    requireSliceBarrel: true,
  },
  session: {
    slice: "session",
    denyImports: [
      "@/agent",
      "@/mcp",
      "@/rules",
      "@/migration",
      "@/subagent",
      "@/skill",
      "@/observability",
      "@/permission",
      "@/lsp",
      "@/stream",
      "@/memory",
    ],
    requireSliceBarrel: true,
  },
  subagent: {
    slice: "subagent",
    denyImports: [
      "@/agent",
      "@/mcp",
      "@/rules",
      "@/migration",
      "@/session",
      "@/skill",
      "@/observability",
      "@/llm",
      "@/memory",
      "@/storage",
      "@/permission",
      "@/lsp",
      "@/stream",
    ],
    envAllowFiles: ["handlers-6.ts"],
    requireSliceBarrel: true,
  },
  skill: {
    slice: "skill",
    denyImports: [
      "@/agent",
      "@/mcp",
      "@/rules",
      "@/migration",
      "@/session",
      "@/subagent",
      "@/observability",
      "@/llm",
      "@/memory",
      "@/storage",
      "@/permission",
      "@/lsp",
      "@/stream",
    ],
    consoleAllowFiles: ["discover.ts"],
    requireSliceBarrel: true,
  },
  storage: {
    slice: "storage",
    denyImports: [
      "@/agent",
      "@/mcp",
      "@/rules",
      "@/migration",
      "@/session",
      "@/subagent",
      "@/skill",
      "@/observability",
      "@/llm",
      "@/memory",
      "@/permission",
      "@/lsp",
      "@/stream",
    ],
    envAllowFiles: ["default.ts"],
    requireSliceBarrel: true,
  },
  mcp: {
    slice: "mcp",
    denyImports: [
      "@/agent",
      "@/tool",
      "@/rules",
      "@/migration",
      "@/session",
      "@/subagent",
      "@/skill",
      "@/observability",
      "@/llm",
      "@/memory",
      "@/storage",
      "@/permission",
      "@/lsp",
      "@/stream",
    ],
    envAllowFiles: ["client.ts", "isolated-client.ts", "stdio.ts"],
    requireSliceBarrel: true,
  },
  rules: {
    slice: "rules",
    denyImports: [...PEER_LIBRARY_DENY, "@/auth"],
    requireSliceBarrel: true,
  },
  security: {
    slice: "security",
    denyImports: [...PEER_LIBRARY_DENY, "@/auth"],
    requireSliceBarrel: true,
  },
  auth: {
    slice: "auth",
    denyImports: [...PEER_LIBRARY_DENY],
    requireSliceBarrel: true,
  },
  runner: {
    slice: "runner",
    denyImports: ["@/rules", "@/patch", "@/migration"],
    includeBackupArtifacts: true,
    requireSubSliceBarrels: ["assemble/index.ts", "orchestrate/index.ts", "session-ops/index.ts"],
  },
  ipc: {
    slice: "ipc",
    denyImports: ["@/rules", "@/patch", "@/migration"],
    includeBackupArtifacts: true,
    requireSliceBarrel: true,
  },
}

export const getSliceBoundaryConfig = (slice: string): SliceBoundaryConfig => {
  const cfg = SLICE_BOUNDARY_CONFIGS[slice]
  if (!cfg) throw new Error(`unknown slice-boundary config: ${slice}`)
  return cfg
}
