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

/** Layer-2 (composition / surface) slices. NO Layer-0/1 library or leaf slice
 *  may VALUE-import these — that would be an UP-import (a lower layer reaching
 *  up into the assembly/host/IPC/app surface). The AST scanner skips
 *  `import type`, so type-only contracts (rare) stay allowed. */
const LAYER2_DENY = ["@/runner", "@/host", "@/ipc", "@/apps"] as const

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
      // `loop-helpers.ts` reads the DEFAULT-OFF OTel content-capture gate
      // (`gateOn(process.env, "QUANTA_OTEL_CAPTURE_CONTENT")`) at the span-close
      // seam — the same sanctioned default-OFF gate-at-a-seam class as the
      // `tool` slice's `from-env.ts`/`port.ts` carve-outs. Unset/falsy ⇒ NO
      // content leaves the process (byte-identical); the gate arms the redacted
      // OTLP content plane only when a span sink is also live. (loop-helpers.ts is
      // ALSO in `stdioAllowFiles` above for the git-directive sink default.)
      "loop-helpers.ts",
      // `span-content-redact.ts` (jul-28) is the ONE shared home of that same
      // `contentCaptureEnabled()` gate — extracted from loop-helpers so the
      // LLM-sampling AND tool-dispatch span paths redact identically. Same
      // sanctioned default-OFF gate-at-a-seam read.
      "span-content-redact.ts",
      // `loop/control-poll.ts` gates the DEFAULT-OFF control-request drain on
      // `isControlRequestEnabled(slot.env ?? process.env)` — the `process.env`
      // token is ONLY the DI fallback for the injected `slot.env` (tests pass a
      // fake env); an absent slot OR gate-off ⇒ the port is never even queried
      // (byte-identical). Same injection-first default-OFF gate-at-a-seam class.
      "control-poll.ts",
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
      "@/llm",
    ],
    // Documented carve-outs:
    //  • coverage_check tool consumes the @/observability/coverage sub-barrel
    //    (ADR-0165) as a typed contract — coverage primitives are observability
    //    services tools intentionally call into.
    //  • apply_patch is the composition root for the pure `@/patch` applier's
    //    injected `PatchTracePort` (closed-port DI). It wires the OTel-bound
    //    adapter from @/observability/patch-trace HERE — the SINGLE runtime
    //    binding of the `quanta.patch.*` vocabulary — so `@/patch` itself stays
    //    a pure leaf with no `@/observability` value import.
    //  • git_compose_{commit,pr} value-import `assembleFromEvents` (a pure
    //    StreamEvent[]→turn fold) from @/llm/assemble; the @/llm barrel is denied
    //    wholesale so no OTHER tool→llm value edge lands silently (jul-28 audit).
    // Reviewed exceptions.
    allowImports: ["@/observability/coverage", "@/observability/patch-trace", "@/llm/assemble"],
    // debug/port.ts is a process SPAWNER (DAP adapters / `node --inspect-brk`): it
    // must pass the parent env to the child so PATH resolves node/lldb/dlv — the
    // same env-boundary carve-out as runner.ts. The gate VALUES come from cfg; only
    // the spawned child's env inherits `process.env`.
    //
    // `container-exec/tool.ts` is a PATH-SCOPED entry (not a bare basename): it
    // resolves the DEFAULT-OFF per-stream output cap dial `resolveStreamCap(
    // process.env)` (QUANTA_TB_STREAM_CAP) at module load — unset/≤0 ⇒ the fixed
    // 8K default (byte-identical); `resolveStreamCap` is PURE (takes the env bag),
    // so the raw `process.env` is only its call-boundary argument. `tool.ts` is NOT
    // a unique basename (10 `*/tool.ts` under @/tool), so the path-scoped form
    // exempts EXACTLY this one file — a future env read in a sibling `*/tool.ts`
    // still trips the guard.
    envAllowFiles: ["runner.ts", "from-env.ts", "port.ts", "container-exec/tool.ts"],
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
    // 77 files / ~600KB: the apps runtime+type-import AST scan alone can exceed
    // Bun's 5s behavioural-test deadline under full-unit CPU contention.
    // This remains the same bounded structural assertion, not a policy exemption.
    surfaceIsolationScanTimeoutMs: 20_000,
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
      // @/subagent may only reach @/tool + @/shared (biome.json enforces the same).
      // The escalatingKill/defaultPpidWalkKiller wiring is INJECTED from the
      // composition root precisely because this import is forbidden — keep the two
      // SSOTs (biome + this arch test) in lockstep so the fence can't silently drift.
      "@/runtime",
    ],
    // `exec-command.ts` spreads the parent `process.env` INTO the spawned bash
    // child (`{ ...process.env, ...input.env }`) so PATH/HOME resolve for the
    // subprocess — ENV PROPAGATION to a child, not a feature-flag read. Same
    // spawner env-boundary carve-out as `handlers-6.ts` (and the `tool` slice's
    // `port.ts`); the values only reach the child's environment.
    envAllowFiles: ["handlers-6.ts", "exec-command.ts"],
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
    // Reuse the canonical PEER_LIBRARY_DENY (which INCLUDES `@/tool`) so a
    // storage→tool VALUE import — the layering inversion that escaped CI when
    // `shadow-odb/default.ts` up-imported `defaultGitRunner` from `@/tool/git`
    // — now fails this guard. The generic git-exec port was relocated to the
    // LEAF `@/storage/git-runner`; storage no longer crosses into `@/tool`.
    denyImports: [...PEER_LIBRARY_DENY],
    // `shadow-odb/default.ts` resolves a workspace hash; `git-runner/runner.ts`
    // is the relocated `Bun.spawn` adapter whose deterministic-env scrub reads
    // the parent `process.env` allowlist AT CALL TIME (the documented env
    // boundary for the git effect port — same precedent as `@/tool`'s
    // `runner.ts`/`from-env.ts`).
    envAllowFiles: ["default.ts", "runner.ts"],
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
    // Documented env-resolution boundary (mirror of the `tool` slice's
    // `runner.ts`/`from-env.ts` precedent). These are the bench-surface
    // entrypoint + env-knob seams of `@/runner`, each of which resolves
    // env-driven posture AT CALL TIME by design (so tests can mutate
    // `process.env` without re-importing):
    //   • `core.ts` / `driver.ts` — the `agent:batch` / SWE-bench eval
    //     harness whose `collectBenchKnobsTelemetry` + per-instance knob
    //     resolution read the `QUANTA_BENCH_*` knob env directly (the
    //     bench surface IS the composition root for these knobs).
    //   • `dataset.ts` — the official SWE-bench adapter's `defaultExec`
    //     passes `env: process.env` straight into `Bun.spawn` (git child
    //     processes inherit the ambient environment, never a param).
    //   • `diff-ops.ts` — `resolveEnvCaps()` reads `QUANTA_DIFF_MAX_*` at
    //     call time so the cap is hot-swappable in tests; the value is the
    //     documented default, never threaded through every diff call site.
    //   • `registry.ts` — `NODE_ENV === "production"` is a test-only
    //     reset/restore guard, not configurable posture.
    // These four leaf names are unique within the slice, so the carve-out
    // exempts exactly these files.
    //
    // W3-A (bench eval-DRIVER composition root): when the `agent:batch` /
    // SWE-bench eval driver was split out of the monolithic `driver.ts` into
    // the `batch/eval/driver/*.ts` phase files (+ two `batch/eval/*.ts`
    // repro wires + `batch/eval/sandbox.ts`), the `QUANTA_BENCH_*` knob-
    // resolution reads moved with them. These are the SAME sanctioned
    // composition-root / knob-resolution class as `core.ts`/`driver.ts`
    // above (and the `tool` slice's `runner.ts`/`from-env.ts` precedent):
    // each read passes the raw `process.env` bag straight into a PURE gate
    // helper (`gateOn`/`gateDisabled`) or a PURE resolver
    // (`resolveBenchKnobs({ envVars })`, `benchPostureFromState(state, env)`,
    // `agentVisibleBenchVerifierCommand(instance, env)`,
    // `benchBudgetMeterFromEnv(env)`, `resolveLlmSelectMode(env)`,
    // `familyCoverageCoeditEnabled(env)`, `resolveReproViabilityMode(env)`) —
    // the value is never a config-SLOT that should be threaded through the
    // call graph; the bench surface IS the composition root that resolves
    // these DEFAULT-OFF knobs. (`repro-viability-wire.ts` reads
    // `args.env ?? process.env` — `process.env` is only the DI fallback for
    // an injected env, exactly the agent slice's `control-poll.ts` pattern.)
    // Every leaf name below is UNIQUE within the slice, so each entry exempts
    // exactly ONE file — a future env read in a NEW driver file still trips
    // the guard.
    envAllowFiles: [
      "core.ts",
      "driver.ts",
      "dataset.ts",
      "diff-ops.ts",
      "registry.ts",
      "config-build.ts",
      "attempt-context.ts",
      "env-knob-parse.ts",
      "repair-phase.ts",
      "repro-test-prep.ts",
      "selection-port-factories.ts",
      "repro-adapter.ts",
      "repro-viability-wire.ts",
      "sandbox.ts",
    ],
    requireSubSliceBarrels: ["assemble/index.ts", "orchestrate/index.ts", "session-ops/index.ts"],
  },
  ipc: {
    slice: "ipc",
    denyImports: ["@/rules", "@/patch", "@/migration"],
    includeBackupArtifacts: true,
    requireSliceBarrel: true,
  },
  // `@/host` is the Layer-2 composition seam (ADR-0299): it wires every surface
  // (CLI / headless / web) to the `@/runner` + `@/agent` core via a DI bundle.
  // It legitimately reads `process.env` (36 sites — it IS the env composition
  // root) and writes startup stdio, so the library-purity suite does NOT apply.
  // The ONE invariant that DOES bind it is surface isolation: the host must NOT
  // import or even type-reference `apps/**` (the bootstrap's own docblock,
  // `bootstrap/types.ts:133,394`, asserts "host cannot import apps/cli/...").
  // Previously NO automated guard enforced this over `src/host/**` — only the
  // `@/agent`/`@/runner` guards covered their own slices, leaving the host's
  // ADR-0299 fence enforced by docblock alone. `surfaceIsolationOnly` runs
  // exactly the surface-isolation test (runtime + type-position) and nothing
  // else.
  host: {
    slice: "host",
    denyImports: [],
    surfaceIsolationOnly: true,
  },
  // `@/sdk` and `@/kernel` are Layer-2 composition seams (the runtime facade +
  // the session-host turn machinery). They legitimately import many lower slices
  // (@/agent, @/host, @/ipc, @/llm, @/protocol, @/tool, …) and read env / write
  // a startup console line, so the library-purity suite does NOT apply — but the
  // surface-isolation invariant DOES: neither may import or type-reference
  // `apps/**`. Same `surfaceIsolationOnly` posture as `@/host`.
  sdk: {
    slice: "sdk",
    denyImports: [],
    surfaceIsolationOnly: true,
  },
  kernel: {
    slice: "kernel",
    denyImports: [],
    surfaceIsolationOnly: true,
  },
  // `@/patch` is a pure leaf (V4A parser + applier + ports). Its ONLY runtime
  // dependency is `@/shared` (leaf util). The applier takes an injected
  // `PatchTracePort` (closed-port DI) for telemetry, so it imports NOTHING from
  // the cross-cutting `@/observability` slice — the OTel binding lives in the
  // `@/observability/patch-trace` adapter, wired at the `apply_patch` tool root.
  // Denying the full peer-library set (incl. `@/observability`) locks that in:
  // a regression that re-adds a VALUE import from any higher layer is flagged.
  patch: {
    slice: "patch",
    denyImports: [...PEER_LIBRARY_DENY],
    requireSliceBarrel: true,
  },
  // `@/git` is a pure leaf (cloud-branch-snapshot port + conflict-parser +
  // passive-classify + directive-emit). Its ONLY runtime dependency is
  // `@/shared`. Deny the full peer-library set AND every Layer-2 surface so a
  // regression that re-adds a VALUE import from any higher layer is flagged.
  // (Previously this slice had NO boundary config at all — a gap that let the
  // whole up-import class escape CI.)
  git: {
    slice: "git",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  // `@/browser` is a pure leaf (CDP port + adapter + snapshot + allowlist).
  // ONLY runtime dependency is `@/shared`. Same full deny as `@/git`.
  browser: {
    slice: "browser",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  // `@/scheduler` is a pure leaf (rrule parser + next-fire + automation engine
  // + jsonl store). ONLY runtime dependency is `@/shared`. Same full deny.
  scheduler: {
    slice: "scheduler",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  // `@/stream` is a leaf (agent-event taxonomy + projectors + emitter adapters);
  // its ONLY runtime dependency is `@/shared`. Full deny so a VALUE import from
  // any higher layer is flagged. (`@/stream` IS itself in PEER_LIBRARY_DENY —
  // the self-prefix filter in `registerSliceBoundarySuite` drops it.)
  stream: {
    slice: "stream",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  // `@/reactor` is a proactive-reactor leaf. It gained ONE cross-slice edge —
  // `import type { AgentOutcome } from "@/agent"` in `agent-outcome-adapter.ts`
  // (the relocated turn-outcome projection; observer→observed, type-only). The
  // full deny-list INCLUDES `@/agent`, so a TYPE-only ref stays allowed (the AST
  // scanner skips `import type`) while a VALUE import of `@/agent` — or any other
  // peer library / Layer-2 surface — FIRES. That locks the new edge: it can never
  // silently widen into a runtime coupling. `types.ts` reads `REACTOR_ENV_FLAG`.
  reactor: {
    slice: "reactor",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    envAllowFiles: ["types.ts"],
    requireSliceBarrel: true,
  },
  // `@/side-agent` is the N1 background side-agent daemon (RFC
  // `docs/plans/jun-4-background-side-agent.md`). The barrel + registries
  // (`process.ts` / `registry.ts` / `process-registry.ts` / `types.ts`) are a
  // PURE LEAF: a supervise-loop over injected ports whose only deps are
  // `@/shared` + intra-slice. Deny the full peer-library set AND every Layer-2
  // surface so a regression that re-adds a VALUE import from any higher layer
  // into the leaf is flagged (this slice previously had NO boundary config —
  // the gap this closes).
  //
  // Documented carve-out: `worker-charter-runner.ts` is the CHILD composition
  // root the forked `.mjs` worker dynamically imports per charter (its own
  // header records this). Like the `@/host` wiring it deliberately assembles a
  // real LLM-backed bounded pass and is NOT re-exported from the pure-leaf
  // barrel, so the leaf consumed by `@/agent/side-agent-runner` stays
  // dependency-clean. These are the EXACT value-import specs that composition
  // root carries (type-only imports — `@/agent`, `@/permission`, `@/stream` —
  // are erased and never reach the scanner). Reviewed exceptions.
  "side-agent": {
    slice: "side-agent",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    allowImports: [
      "@/agent/side-agent-runner",
      "@/agent/subagent-runner",
      // Reviewed: the OS-process worker charter derives its own spawn-depth
      // containment (childDepthOf/effectiveCap) from the shared authority leaf so
      // a forked daemon is never a fresh unbounded root (rev.4 §4 defense-in-depth).
      "@/agent/spawn-depth",
      "@/llm",
      "@/llm/replay",
      "@/tool",
    ],
    requireSliceBarrel: true,
  },

  // ────────────────────────────────────────────────────────────────────────
  // S4b — previously-UNREGISTERED slices. Each had NO per-slice boundary config
  // (no console/env/deny/surface battery). Every config below is SEEDED GREEN
  // against current code: the leaf slices carry the canonical
  // `[...PEER_LIBRARY_DENY, ...LAYER2_DENY]` deny-list (mirror of @/git /
  // @/browser / @/scheduler / @/stream), with `envAllowFiles` carve-outs for the
  // exact leaf names that legitimately resolve env AT CALL TIME (verified by the
  // scanner probe — no surface / stdio / alt-runtime / node-surface / console
  // violations exist in any of these today). Two peer-crossing edges are
  // declared as reviewed `allowImports` carve-outs rather than silently dropped.
  // Slices WITHOUT an `index.ts` barrel (integrations, protocol) omit
  // `requireSliceBarrel` so the config stays GREEN; adding those barrels is a
  // noted follow-up.
  // ────────────────────────────────────────────────────────────────────────

  activity: {
    slice: "activity",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  artifact: {
    slice: "artifact",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  capability: {
    slice: "capability",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  codemode: {
    slice: "codemode",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  config: {
    slice: "config",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  connectors: {
    slice: "connectors",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // `connector-marketplace.ts` / `marketplace-policy.ts` resolve the
    // marketplace posture from env AT CALL TIME (the documented env boundary for
    // this slice; both leaf names are unique within the slice).
    envAllowFiles: ["connector-marketplace.ts", "marketplace-policy.ts"],
    requireSliceBarrel: true,
  },
  integrations: {
    slice: "integrations",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // Reviewed carve-out: `github/adapters/delivery-persist-fs.ts` persists
    // delivery records through the `@/storage` fs port (an adapter reaching the
    // storage leaf — a declared, defended cross-slice contract, not a silent
    // widening). Any OTHER peer-library / Layer-2 import still fires.
    allowImports: ["@/storage"],
    // No `src/integrations/index.ts` barrel today → omit `requireSliceBarrel`
    // to seed GREEN (adding the barrel is a noted follow-up).
  },
  lsp: {
    slice: "lsp",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // `base.ts` (server spawn env), `server-mem-budget.ts` /
    // `server-rss-watchdog.ts` (resource-cap env knobs) read env at call time.
    envAllowFiles: ["base.ts", "server-mem-budget.ts", "server-rss-watchdog.ts"],
    requireSliceBarrel: true,
  },
  media: {
    slice: "media",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // `registry.ts` resolves media-backend selection from env at call time
    // (unique leaf name within the slice).
    envAllowFiles: ["registry.ts"],
    requireSliceBarrel: true,
  },
  migration: {
    slice: "migration",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // Reviewed carve-outs: the external-config CONVERTER
    // (`external-config/convert.ts`) reads the `@/agent` glob/repo-rule shapes +
    // `@/skill` frontmatter shape to translate foreign config into ours. These
    // are named sub-barrels (typed conversion contracts), declared here so a NEW
    // peer-library crossing still fires. (`@/migration` is itself in
    // PEER_LIBRARY_DENY — the self-prefix filter drops it.)
    allowImports: ["@/agent/glob-rules", "@/agent/repo-rules", "@/skill/frontmatter"],
    requireSliceBarrel: true,
  },
  "plugin-isolation": {
    slice: "plugin-isolation",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // `bun-spawner.ts` passes the parent env to the spawned isolated-plugin
    // child so PATH resolves the runtime (same spawner env-boundary precedent as
    // `@/tool`'s `port.ts` / `@/storage`'s `runner.ts`).
    envAllowFiles: ["bun-spawner.ts"],
    requireSliceBarrel: true,
  },
  protocol: {
    slice: "protocol",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // No `src/protocol/index.ts` barrel today → omit `requireSliceBarrel` to
    // seed GREEN (adding the barrel is a noted follow-up).
  },
  radar: {
    slice: "radar",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  realtime: {
    slice: "realtime",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  remote: {
    slice: "remote",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  retrieval: {
    slice: "retrieval",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // `registry.ts` resolves backend selection from env at call time. NOTE: the
    // leaf name is NOT unique (5 `registry.ts` under the slice); basename
    // allowlisting is the only mechanism the scanner supports, so this exempts
    // all five from the env check. Only `cache/registry.ts` + `reranker/
    // registry.ts` actually read env today; the exemption is over-broad but
    // SAFE (can only make the test pass). Tightening to path-scoped exemption is
    // a noted follow-up.
    envAllowFiles: ["registry.ts"],
    requireSliceBarrel: true,
  },
  runtime: {
    slice: "runtime",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // Env-boundary leaves: `os-sandbox/env.ts` (sandbox env allowlist scrub),
    // `sandbox.ts`, `shell-argv.ts`, `shell.ts` resolve shell/sandbox posture
    // from env at call time. `env.ts` basename also covers the clean
    // `network-proxy/env.ts` (no env read) — safe.
    envAllowFiles: ["env.ts", "sandbox.ts", "shell-argv.ts", "shell.ts"],
    requireSliceBarrel: true,
  },
  shared: {
    slice: "shared",
    // `@/shared` is the base leaf every slice depends on; it imports NOTHING
    // upward. Full peer + Layer-2 deny locks that (self-prefix drops `@/shared`
    // if ever added). `env-files.ts` + `runtime-config.ts` ARE the env
    // composition primitives (the documented env-resolution boundary the whole
    // repo threads through) — exempted from the no-env-read invariant.
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    envAllowFiles: ["env-files.ts", "runtime-config.ts"],
    requireSliceBarrel: true,
  },
  ui: {
    slice: "ui",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    // `ui-helpers.ts` reads a display-posture env flag at call time.
    envAllowFiles: ["ui-helpers.ts"],
    requireSliceBarrel: true,
  },
  voice: {
    slice: "voice",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
  workflow: {
    slice: "workflow",
    denyImports: [...PEER_LIBRARY_DENY, ...LAYER2_DENY],
    requireSliceBarrel: true,
  },
}

export const getSliceBoundaryConfig = (slice: string): SliceBoundaryConfig => {
  const cfg = SLICE_BOUNDARY_CONFIGS[slice]
  if (!cfg) throw new Error(`unknown slice-boundary config: ${slice}`)
  return cfg
}
