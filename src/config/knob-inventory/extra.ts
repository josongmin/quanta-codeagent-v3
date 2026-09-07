import { MENTION } from "./mention"
import type { KnobDeclaration } from "./types"

export const EXTRA: readonly KnobDeclaration[] = [
  // jul-9 — general-CLI default env posture. OFF (default) ⇒ "frozen" (SWE-bench
  // don't-install / stop-when-env-blocked, byte-identical to today). ON ⇒ "default"
  // (install-permitted local-dev posture) so an interactive user at their OWN repo is not
  // told installing is forbidden. Read directly from env at the CLI comp-root resolver.
  {
    envKey: "QUANTA_ENV_DEFAULT",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "General-CLI default env posture. OFF ⇒ 'frozen' (SWE-bench don't-install/stop-when-env-blocked, byte-identical). ON ⇒ 'default' (install-permitted local-dev posture; the user's own machine, not a graded sandbox). Prompt-text-only; NEVER touches SandboxPolicy.",
    readSite: "agent/system-prompt/default-builder.ts",
  },
  {
    envKey: "QUANTA_TYPED_EVENT_REPLAY",
    kind: "bool",
    default: false,
    group: "memory",
    home: "runtime-config",
    describe:
      "Replay bounded stored compaction events into the next turn's context envelope. Opt-in because it changes model-visible context; unset leaves typed history append-only. Other event variants retain their direct owners and are consumed without duplicate replay.",
    readSite: "host/runtime/agent-config-assembler.ts",
  },
  // tool gates (env-flag) — gate string lives in the tool-surface manifest SSOT;
  // declared here so the orphan ratchet sees the read (ADR-0503 P1).
  {
    envKey: "QUANTA_AST_GREP",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "ast_grep tool gate (opt-in everywhere) — structural AST code search; requires ast-grep binary on PATH, read-only, 50-match cap. Gate SSOT = tool/surface/manifest.ts (GATED_TOOLS data split into gated-tools.ts).",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    // container_exec tool gate. Opt-in on cli/bench/web/ide/headless; DEFAULT-ON
    // only on the `terminal` surface (built BASE-free by buildTerminalTools). Gate
    // SSOT = tool/surface/manifest.ts (GATED_TOOLS in gated-tools.ts).
    envKey: "QUANTA_CONTAINER_EXEC",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "container_exec tool gate — one-shot command execution over the container transport (the terminal surface's exec workhorse). Opt-in on cli/bench/web/ide/headless; default-ON on the terminal surface only.",
    readSite: "tool/surface/gated-tools.ts",
  },
  // durable cross-session trust grants (CLI comp-root; opt-in, NOT default-seeded)
  {
    envKey: "QUANTA_TRUST_SCOPE",
    kind: "bool",
    default: false,
    group: "permission",
    home: "runtime-config",
    describe:
      "Persistent cross-session trust-scope grants ([P] prefix-grant verb); hydrated once at CLI comp-root so the gate sees prior-session grants on turn 1. Opt-in (durable grants are a deliberate operator choice); absent ⇒ byte-identical.",
    readSite: "apps/cli/repl/runtime-context-compose.ts",
  },
  // memory pipeline — gateDisabled (=off disables) ⇒ default-ON; recall values
  {
    envKey: "QUANTA_MEMORY",
    kind: "enum",
    default: "sqlite",
    group: "memory",
    home: "runtime-config",
    describe:
      "Long-term memory store kind (ADR-0557: unset⇒sqlite at ~/.quanta/memory/memory.sqlite; memory=volatile; off).",
    readSite: "runner/assemble/memory-factory.ts",
  },
  {
    envKey: "QUANTA_MEMORY_DISTILL",
    kind: "bool",
    default: true,
    group: "memory",
    home: "runtime-config",
    describe: "Memory distillation (=off disables).",
    readSite: "runner/assemble/memory-factory.ts",
  },
  {
    envKey: "QUANTA_MEMORY_CONSOLIDATE",
    kind: "bool",
    default: true,
    group: "memory",
    home: "runtime-config",
    describe: "Memory consolidation (=off disables).",
    readSite: "runner/assemble/memory-factory.ts",
  },
  {
    envKey: "QUANTA_MEMORY_SELF_EDIT",
    kind: "bool",
    default: true,
    group: "memory",
    home: "runtime-config",
    describe: "Memory self-edit (=off disables).",
    readSite: "runner/assemble/memory-factory.ts",
  },
  {
    envKey: "QUANTA_MEMORY_LINE_CITATIONS",
    kind: "bool",
    default: false,
    group: "memory",
    home: "runtime-config",
    describe: "Memory line-citations opt-in (set =1 to enable).",
    readSite: "runner/assemble/memory-factory.ts",
  },
  {
    envKey: "QUANTA_MEMORY_RECALL_LIMIT",
    kind: "int",
    default: undefined,
    group: "memory",
    home: "runtime-config",
    describe: "Memory recall result limit.",
    readSite: "runner/assemble/memory-factory.ts",
  },
  {
    envKey: "QUANTA_MEMORY_RECALL_TIERS",
    kind: "string",
    default: undefined,
    group: "memory",
    home: "runtime-config",
    describe: "Memory recall tier selection.",
    readSite: "runner/assemble/memory-factory.ts",
  },
  {
    // §10.6 routing weighting — default-OFF opt-in. When on, per-turn recall
    // passes the current cwd as a routing context so memories scoped to this
    // checkout (Codex `applies_to: cwd=...`) score up. Absent ⇒ byte-identical.
    envKey: "QUANTA_MEMORY_ROUTING",
    kind: "bool",
    default: false,
    group: "memory",
    home: "runtime-config",
    describe: "Memory recall routing weighting (cwd/task-group meta; set =1 to enable).",
    readSite: "runner/assemble/memory-factory.ts",
  },
  // @-mention resolver knobs (file/symbol caps + §10.3 folder/git + RFC-12-2
  // mcp/subagent/thread) live in the cohesive `./mention` module (extracted to
  // keep this flat inventory under the god-MODULE ratchet); spread in here.
  ...MENTION,
  // bench / swebench harness
  {
    envKey: "QUANTA_LSP_TOOLS",
    kind: "enum",
    default: undefined,
    group: "bench",
    home: "bench",
    describe: "Bench LSP-nav tools (=full).",
    readSite: "runner/batch/eval/knobs-bench.ts",
  },
  {
    envKey: "QUANTA_MODEL",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe: "Bench model id (--model).",
    readSite: "llm/boot-selection.ts",
  },
  {
    envKey: "QUANTA_OBSERVE_DIR",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe: "Bench observation output dir.",
    readSite: "apps/bench/run-main-helpers.ts",
  },
  {
    envKey: "QUANTA_REPAIR_ROUNDS",
    kind: "int",
    default: undefined,
    group: "bench",
    home: "bench",
    describe: "Bench repair-round count.",
    readSite: "apps/bench/run-main.ts",
  },
  {
    // B1 (jul-03): operator ESCAPE hatch for the RETIRED verify-select best-of-N
    // veto SELECTION plane. Read DIRECTLY from env at the bench posture site (a
    // fail-closed gate on the QUANTA_BENCH_VERIFY_SELECT knob), NOT a layered
    // knob — declared here so the completeness ratchet (ADR-0503) sees the read.
    // Default-OFF ⇒ the plane stays inert ⇒ byte-identical to every shipped preset.
    envKey: "QUANTA_BENCH_VERIFY_SELECT_ESCAPE",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe:
      "Bench: opt-in ESCAPE hatch that re-enables the RETIRED verify-select best-of-N veto SELECTION plane (jun-27 footgun — it laundered correct patches to empty when no candidate passed the hard gates). Without this, QUANTA_BENCH_VERIFY_SELECT is inert (fail-closed). Default-OFF ⇒ byte-identical.",
    readSite: "runner/batch/eval/knobs-bench.ts",
  },
  {
    envKey: "QUANTA_SWEBENCH_REPO_BASE_URL",
    kind: "string",
    default: "https://github.com/",
    group: "bench",
    home: "bench",
    describe: "SWE-bench repo base URL.",
    readSite: "apps/bench/run-main.ts",
  },
  {
    envKey: "QUANTA_SWEBENCH_DATASET",
    kind: "string",
    default: "",
    group: "bench",
    home: "bench",
    describe: "SWE-bench dataset file.",
    readSite: "apps/bench/run-main.ts",
  },
  {
    envKey: "QUANTA_SWEBENCH_DATASET_NAME",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe: "SWE-bench dataset name.",
    readSite: "apps/bench/python-verifier-wiring.ts",
  },
  {
    envKey: "QUANTA_SWEBENCH_PYTHON",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe: "SWE-bench python harness gate.",
    readSite: "apps/bench/python-verifier-wiring.ts",
  },
  {
    envKey: "QUANTA_SWEBENCH_CORPUS_ROOT",
    kind: "string",
    default: "",
    group: "bench",
    home: "bench",
    describe: "SWE-bench corpus root.",
    readSite: "apps/bench/run-main.ts",
  },
  // PMX-01 — SWE-bench ProMax's OWN settings. Deliberately NOT spelled
  // `QUANTA_SWEBENCH_PRO_*`: ProMax and ScaleAI Pro are different corpora with
  // different evaluators and must never share a grader, a harness location, or a
  // report partition. Both are resolved ONCE at the bench composition root
  // (`apps/bench/run-config.ts` → `promax/settings.ts`), fail-closed on an
  // explicitly-set-but-unusable value; absent leaves the ProMax lane unconfigured
  // rather than guessing a bundle (PMX-00 forbids search paths and downloads).
  {
    envKey: "QUANTA_PROMAX_BUNDLE_ROOT",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe:
      "SWE-bench ProMax: ABSOLUTE root of the operator's already-verified, frozen upstream bundle checkout (dataset + eval metadata + the pinned test_run.py). No default and no search path — an unset value leaves the ProMax lane unconfigured instead of resolving a moving ref. A relative or blank value is REFUSED at the composition root.",
    readSite: "apps/bench/promax/settings.ts",
  },
  {
    envKey: "QUANTA_PROMAX_PYTHON",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe:
      "SWE-bench ProMax: the interpreter that runs the pinned upstream evaluator (bare name or absolute path). Unset ⇒ the pinned-evaluator invocation boundary's own `python` default. A blank value is REFUSED at the composition root.",
    readSite: "apps/bench/promax/settings.ts",
  },
  {
    envKey: "QUANTA_PROMAX_SAMPLE",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe:
      "SWE-bench ProMax: ABSOLUTE path of the PMX-*.manifest.json a run selects its instances from (PMX-06). The manifest is the SELECTION AUTHORITY — its ordered ids, and only those, execute — and it is fail-closed: a manifest whose sha256, ordering algorithm or dataset revision does not match, or that names an instance the loaded corpus lacks, REFUSES the run rather than falling back to the whole corpus. Cannot be combined with --instance. Unset ⇒ no manifest selection (byte-identical to the historical filter). A relative or blank value is REFUSED at the composition root.",
    readSite: "apps/bench/promax/settings.ts",
  },
  // The bench composition root's ONE official-grader ingress (PMX-05 writer).
  // Read DIRECTLY from the injected env bag at `apps/bench/official-grade-ingest-source.ts`
  // (fail-closed: absent ⇒ no `officialGrade` report section ⇒ every lane byte-identical;
  // present-but-unreadable ⇒ THROW rather than publish an unofficial number under an
  // official campaign's name). Declared here — like the sibling QUANTA_PROMAX_* /
  // QUANTA_SWEBENCH_* composition-root settings — so the completeness ratchet (ADR-0503)
  // sees the read and operators can discover it on the /knobs surface.
  {
    envKey: "QUANTA_OFFICIAL_GRADE_RECEIPT",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe:
      "Bench: ABSOLUTE path of the official-grade ingest document (a pinned upstream evaluator's verdict, produced out of process) that this run's report aggregates into `officialGrade`. Unset ⇒ no section (byte-identical). Blank, unreadable, non-JSON or drifted ⇒ the report REFUSES to publish.",
    readSite: "apps/bench/official-grade-ingest-source.ts",
  },
  {
    envKey: "QUANTA_ALLOW_EXTRA_BOXES",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe: "Bench CLI: allow box commands to operate when extra remote boxes are present.",
    readSite: "apps/bench/commands/shared.ts",
  },
  {
    envKey: "QUANTA_BENCH_AUTH_FILE",
    kind: "string",
    default: undefined,
    group: "auth",
    home: "bench",
    describe: "Bench auth: explicit single-account auth file path.",
    readSite: "apps/bench/auth-pool/load.ts",
  },
  {
    envKey: "QUANTA_BENCH_AUTH_POOL",
    kind: "string",
    default: undefined,
    group: "auth",
    home: "bench",
    describe: "Bench auth: auth pool manifest path for multi-account remote runs.",
    readSite: "apps/bench/auth-pool/load.ts",
  },
  {
    envKey: "QUANTA_BENCH_LEAN_PROMPT",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe: "Bench prompt: use the lean directive family instead of the full directive block.",
    readSite: "runner/batch/eval/driver/config-build.ts",
  },
  {
    envKey: "QUANTA_BENCH_PATCH_GEN_BUDGET",
    kind: "int",
    default: undefined,
    group: "bench",
    home: "bench",
    describe: "Bench remote: global patch-generation concurrency budget.",
    readSite: "apps/bench/remote/token-budget.ts",
  },
  {
    envKey: "QUANTA_BENCH_SINGLE_BOX_GUARD_DIR",
    kind: "string",
    default: "~/.quanta/bench-single-box",
    group: "bench",
    home: "bench",
    describe: "Bench remote: single-box guard lease directory.",
    readSite: "apps/bench/remote/single-box-guard.ts",
  },
  {
    envKey: "QUANTA_BENCH_TENTATIVE",
    kind: "bool",
    default: true,
    group: "bench",
    home: "bench",
    describe: "Bench eval: retain last verified-green tentative patch unless explicitly disabled.",
    readSite: "apps/bench/eval/driver/agent-phase.ts",
  },
  {
    envKey: "QUANTA_BENCH_FAMILY_COVERAGE",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe:
      "Bench eval (T1, jun-24): clean-mode family-coverage veto (hard:familyCoverageMissing). Default OFF; opt-in via QUANTA_BENCH_FAMILY_COVERAGE (reverted as net-negative producer-consumer over-demand).",
    readSite: "apps/bench/eval/driver/selection.ts",
  },
  {
    envKey: "QUANTA_BENCH_FAMILY_COVERAGE_COEDIT",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe:
      "Bench eval (T1, jun-25): deterministic family-coverage coedit patch synthesis (exact-replay donor hunks onto sibling files). Default OFF; opt-in via QUANTA_BENCH_FAMILY_COVERAGE_COEDIT.",
    readSite: "runner/batch/eval/driver/selection-phase.ts",
  },
  {
    envKey: "QUANTA_BENCH_NONEMPTY_FALLBACK",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe:
      "Bench eval (jun-25): CORRECTED non-empty fallback. When no winner exists, submit the rock-solid-subset candidate (applies clean / no regression / no static-sanity break, barred only by a self-oracle MWE/repro false-negative) instead of empty — weakly dominates on binary SWE-bench scoring. Default OFF; opt-in via QUANTA_BENCH_NONEMPTY_FALLBACK.",
    readSite: "apps/bench/eval/driver/selection.ts",
  },
  {
    envKey: "QUANTA_BENCH_TOKEN_BUDGET_DIR",
    kind: "string",
    default: "~/.quanta/bench-token-budget",
    group: "bench",
    home: "bench",
    describe: "Bench remote: token/patch-generation budget lease directory.",
    readSite: "apps/bench/remote/token-budget.ts",
  },
  {
    envKey: "QUANTA_BENCH_V5_ADAPTIVE",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe: "Bench preset: explicit opt-in for the v5 adaptive controller.",
    readSite: "apps/bench/preset.ts",
  },
  {
    // jul-13 (ADR-0539) — explicit escape-hatch gate for the trajectory DEBUG
    // sidecar sink (the `verdict`/`toolExec`/`editTrace` enrichers — all three
    // wired — that ride ALONGSIDE the recorded LLM turn as
    // `RecordedInteraction.metadata.debug`). The debug tier
    // is primarily driven by `QUANTA_BENCH_RECORD_TRAJECTORY=debug` (one var, no
    // drift); THIS var is the standalone opt-in that enables the enrichers without
    // forcing the recording tier. Read DIRECTLY from env at the sink's gate
    // (isTrajectoryDebugEnabled), a bench-side observability gate — declared here
    // so the completeness ratchet (ADR-0503) sees the read. Default-OFF ⇒ the
    // enrichers no-op and the recording path is byte-identical.
    envKey: "QUANTA_BENCH_TRAJECTORY_DEBUG",
    kind: "bool",
    default: undefined,
    group: "observability",
    home: "bench",
    describe:
      "Bench trajectory DEBUG sidecar gate (opt-in). When truthy, subsystems contribute keyed debug slices (grade/verify `verdict`, tool-exec `toolExec`, edit-tool `editTrace` — all three enrichers wired) that ride ALONGSIDE the recorded LLM turn as `metadata.debug` — replay-neutral (the cassette match key is request-hash, so debug enrichment can never invalidate a replay hit). Also implicitly ON when QUANTA_BENCH_RECORD_TRAJECTORY=debug. OFF/unset ⇒ enrichers no-op, recording path byte-identical.",
    readSite: "apps/bench/trajectory-debug-sink.ts",
  },
  {
    // jul-13 (ADR-0539, T-B3) — bench observability gate that installs the
    // CONTEXT-ONLY span sink (T-B1/T-B2): mints real W3C {traceId,spanId} ids and
    // an active-context scope WITHOUT any OTLP export, so OBSERVE + the replay
    // cassette carry ONE unified {traceId,spanId} per instance-attempt and the
    // trajectory viewer's span-tree lights up on ordinary (no-endpoint) bench
    // runs. Read at the bench OTLP boot seam (bootBenchOtelExport, apps/bench/otel.ts):
    // truthy + no QUANTA_OTEL_ENDPOINT ⇒ context-only sink; endpoint set ⇒ the real
    // exporter wins and this never shadows it. NOT `QUANTA_BENCH_`-prefixed ⇒ NOT
    // auto-forwarded to full-remote boxes (T-B4 adds it to FORWARD_EXTRA_ENV).
    // Default-OFF/unset ⇒ no sink registered ⇒ byte-identical, zero-alloc.
    envKey: "QUANTA_TRACE_CONTEXT",
    kind: "bool",
    default: undefined,
    group: "observability",
    home: "bench",
    describe:
      "Bench: install a context-only span sink (real trace ids, NO OTLP export) so OBSERVE+cassette carry a unified {traceId,spanId} for the trajectory viewer's span-tree, without an OTLP endpoint. Default-OFF ⇒ byte-identical.",
    readSite: "apps/bench/otel.ts",
  },
  {
    // jul-13 (ADR-0539, T-D0/T-D1) — opt-in GenAI CONTENT capture on the LLM
    // sampling (chat) span. Mirrors the OTel-GenAI spec env
    // `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. When truthy AND a span
    // sink is live, `closeSamplingSpan` (loop-helpers.ts) attaches the pinned
    // STRUCTURED content attrs `gen_ai.input.messages` / `gen_ai.output.messages`
    // (role + parts[]) + `gen_ai.system_instructions`, AND the trace-UI
    // prompt/completion previews — ALL redacted via `redactSecrets` (Plane-B
    // secret boundary; the replay cassette / Plane A stays unredacted, untouched).
    // "likely PII": default-OFF. Unset/falsy ⇒ NO content leaves the process and
    // the previews are NOT emitted even under a live sink (byte-identical, and the
    // fix for the T-B preview leak). Read directly from env at the span-close gate,
    // an agent-loop observability gate — declared here so the completeness ratchet
    // (ADR-0503) sees the read.
    envKey: "QUANTA_OTEL_CAPTURE_CONTENT",
    kind: "bool",
    default: undefined,
    group: "observability",
    home: "bench",
    describe:
      "Opt-in GenAI content capture on the chat span: emit the pinned structured `gen_ai.input.messages`/`gen_ai.output.messages` + `gen_ai.system_instructions` attrs and the prompt/completion previews, ALL redacted. Mirrors OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT. Default-OFF ⇒ no content emitted, byte-identical; the cassette (Plane A) stays unredacted and untouched.",
    readSite: "host/runtime/agent-config-assembler.ts",
  },
  {
    envKey: "QUANTA_BENCH_WAIT_FOR_IDLE",
    kind: "bool",
    default: false,
    group: "bench",
    home: "bench",
    describe: "Bench CLI: wait for a remote box to become idle before taking ownership.",
    readSite: "apps/bench/commands/shared.ts",
  },
  {
    envKey: "QUANTA_FULL_REMOTE_REGION",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe: "Full-remote bench: AWS region override for box commands.",
    readSite: "apps/bench/commands/box.ts",
  },
  // web-daemon persistence / serving
  {
    envKey: "QUANTA_WEB_DB",
    kind: "string",
    default: undefined,
    group: "web-daemon",
    home: "runtime-config",
    describe: "Web-daemon DB backend/path.",
    readSite: "apps/web-daemon/server/persistence.ts",
  },
  {
    envKey: "QUANTA_WEB_DIST",
    kind: "string",
    default: undefined,
    group: "web-daemon",
    home: "runtime-config",
    describe: "Web-daemon static dist dir.",
    readSite: "apps/web-daemon/server/http.ts",
  },
  {
    envKey: "QUANTA_WEB_STRICT_PORT",
    kind: "bool",
    default: false,
    group: "web-daemon",
    home: "runtime-config",
    describe: "Fail if port busy (no auto-increment).",
    readSite: "apps/web-daemon/index.ts",
  },
  // ── §2.x plugin/skill flags + connector marketplace V1 (jun-08 longtail).
  // Slice-read gates (read via `gateOn(process.env, …)` in the owning slice, NOT
  // in runtime-config's loadFromEnv) — so they live HERE, never in
  // runtime-config-knobs.ts (the disjoint ratchet forbids both). All default-OFF.
  {
    envKey: "QUANTA_PLUGIN_POINTERS",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe: "§2.4 — resolve plugin manifest hooks/apps pointer fields (opt-in).",
    readSite: "skill/plugin-loader.ts",
  },
  {
    envKey: "QUANTA_SKILL_IMPLICIT_POLICY",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "§2.3 — honor skill policy.allow_implicit_invocation (filters implicit-inject set).",
    readSite: "skill/activation.ts",
  },
  {
    envKey: "QUANTA_MARKETPLACE_POLICY",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe: "§2.5 — enforce marketplace.json source allow/block policy gating (opt-in).",
    readSite: "connectors/marketplace-policy.ts",
  },
  {
    // B5 (jul-03): presence-aware desktop-notification suppression. Read DIRECTLY
    // from env at the CLI notify factory (a CLI-surface gate on the notify port,
    // NOT a layered runtime-config value) — declared here so the completeness
    // ratchet (ADR-0503) sees the read and it surfaces in --help / /knobs / /config.
    // The raw env read at the factory is kept as-is (declaration-only home).
    envKey: "QUANTA_NOTIFY_PRESENCE",
    kind: "bool",
    default: false,
    group: "observability",
    home: "runtime-config",
    describe:
      "CLI desktop-notify presence suppression (opt-in). When on (1/on/true/yes), a PRESENT/active user suppresses the notification (competitor 'suppress while present' semantics); off/unset ⇒ legacy always-notify (byte-identical).",
    readSite: "apps/cli/repl/factories/notify-and-warning.ts",
  },
  {
    envKey: "QUANTA_RADAR",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "ADR-0231 radar proposal-queue: producer hook + /radar surface (default-OFF; opt-in UX).",
    readSite: "apps/cli/repl/surface-compose/wire-builders.ts",
  },
  {
    envKey: "QUANTA_RADAR_FILE",
    kind: "string",
    default: undefined,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Radar jsonl store path (set ⇒ persistent 0600 file store; unset ⇒ in-memory).",
    readSite: "apps/cli/repl/surface-compose/wire-builders.ts",
  },
  {
    envKey: "QUANTA_RADAR_TASK_MS",
    kind: "int",
    default: 30000,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Radar idle/long-task heuristic: long-task duration threshold (ms).",
    readSite: "apps/cli/repl/surface-compose/wire-builders.ts",
  },
  {
    envKey: "QUANTA_GITHUB_WEBHOOK",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe:
      "`quanta webhook` GitHub webhook HOST (strict =1; inbound HTTP → reactor; default-OFF).",
    readSite: "apps/cli/webhook-server-setup.ts",
  },
  {
    envKey: "QUANTA_GITHUB_WEBHOOK_SECRET",
    kind: "string",
    default: undefined,
    group: "integration",
    home: "runtime-config",
    describe: "GitHub webhook HMAC shared secret (empty ⇒ host refuses to boot).",
    readSite: "integrations/github/webhook-secret-resolver.ts",
  },
  {
    envKey: "QUANTA_GITHUB_WEBHOOK_SECRETS",
    kind: "string",
    default: undefined,
    group: "integration",
    home: "runtime-config",
    describe:
      "Multi-installation HMAC secret map ('k1=s1,k2=s2'); each App posts to /webhook/<k> (PATH routing). Wins over single secret.",
    readSite: "integrations/github/webhook-secret-resolver.ts",
  },
  {
    envKey: "QUANTA_GITHUB_WEBHOOK_SECRETS_FILE",
    kind: "string",
    default: undefined,
    group: "integration",
    home: "runtime-config",
    describe:
      "Path to a JSON '{key:secret}' webhook secret map (alternative to QUANTA_GITHUB_WEBHOOK_SECRETS; inline wins).",
    readSite: "integrations/github/webhook-secret-resolver.ts",
  },
  {
    envKey: "QUANTA_GITHUB_WEBHOOK_PORT",
    kind: "int",
    default: 8787,
    group: "integration",
    home: "runtime-config",
    describe: "GitHub webhook host listen port.",
    readSite: "apps/cli/webhook-server-setup.ts",
  },
  {
    envKey: "QUANTA_GITHUB_WEBHOOK_SESSION",
    kind: "string",
    default: undefined,
    group: "integration",
    home: "runtime-config",
    describe: "Target session id the webhook host publishes reactor triggers to.",
    readSite: "apps/cli/webhook-server-setup.ts",
  },
  {
    envKey: "QUANTA_CONNECTOR_MARKETPLACE",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe: "§1.6 — connector DirectoryApp marketplace install/lifecycle V1 (opt-in).",
    readSite: "connectors/connector-marketplace.ts",
  },
  // ── ci-bot GitHub/CI tool gates (jun-08 longtail). AGENT-SIDE reads via
  // `gateOn(env, "QUANTA_…")` in the ci-bot mode preset — NOT a CLI-terminal-render
  // knob, so they live HERE, never in apps/cli/cli-knobs.ts (the read-site-domain
  // ratchet forbids declaring an agent-only gate in the CLI registry). Both
  // default-OFF: absent ⇒ the ghTools opt is empty ⇒ byte-identical legacy gh set.
  {
    envKey: "QUANTA_GH_CODE_TOUR",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe: "§5.4 gh_pr_code_tour guided PR-diff walkthrough tool (opt-in).",
    readSite: "apps/agent/mode-presets/ci-bot.ts (buildCiBotWiring ghTools opts.codeTour)",
  },
  {
    envKey: "QUANTA_CI_FINDING",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe: "§7.3 ci_finding structured CI-investigation record tool (opt-in).",
    readSite: "apps/agent/mode-presets/ci-bot.ts (buildCiBotWiring ghTools opts.ciFindingStore)",
  },
  {
    envKey: "QUANTA_CI_BOT_GH_WRITE",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe:
      "B3/B4 ci-bot gh write path — wire the guarded gitRunner into ghOpts so gh_pr_resolve_thread/gh_pr_open can issue bounded rebases (opt-in).",
    readSite: "apps/agent/mode-presets/ci-bot.ts (buildCiBotWiring ghOpts gitRunner)",
  },
  // TB lever #2 / v2 (TB21-06 TC-6) — the verify-gate v2
  // compare-to-reference gate in the terminal brain. AGENT-SIDE read via
  // `gateOn(env, "QUANTA_TB_VERIFY_GATE")` in `apps/terminal/brain-mode.ts` (a terminal-surface
  // gate, NOT a CLI-render knob, so it lives HERE per the read-site-domain ratchet). Default-OFF:
  // absent ⇒ no `verification` field on the report and no extra turn ⇒ byte-identical to the
  // pre-lever brain. ON ⇒ the v2 L1-gated logic (the broken v1 rubber-stamp is RETIRED, not a level).
  {
    envKey: "QUANTA_TB_VERIFY_GATE",
    kind: "bool",
    default: false,
    group: "bench",
    home: "runtime-config",
    describe:
      "TB verify-gate v2 (compare-to-reference, opt-in). Inspects the trajectory for an OBSERVED L1 comparison of the deliverable's output against a distinct, NON-test reference (diff/cmp/sdiff/colordiff of two operands, or a script naming a reference); no-leak (R1): a comparison against a verifier/test path is REFUSED. If no L1 comparison, injects EXACTLY ONE bounded follow-up (K=0, cannot loop/over-persist), then stamps an honest verified-pass/verified-fail/unverifiable trichotomy — verified-pass is UNREACHABLE without an observed comparison (the v1 rubber-stamp is closed).",
    readSite: "apps/terminal/brain-mode.ts (runTerminalBrain verify-gate v2 compare-to-reference)",
  },
  // TB lever #1 (TB21-06 TC-6) — the ENVIRONMENT POSTURE.
  // AGENT-SIDE read via `gateOn(env, "QUANTA_TB_ENV_OWNED")` in `apps/terminal/brain-mode.ts` (a
  // terminal-surface gate, NOT a CLI-render knob — lives HERE per the read-site-domain ratchet).
  // Default-OFF: absent ⇒ the brain keeps the frozen SWE-bench env guardrails (R-ENV / R-STOP-ENV)
  // ⇒ byte-identical to the pre-lever brain. PROMPT-TEXT-ONLY: when ON it swaps the rendered env
  // rule list via `boot.systemSource`; it sets NO SandboxMode / SandboxPolicy and does NOT loosen
  // host enforcement.
  {
    envKey: "QUANTA_TB_ENV_OWNED",
    kind: "bool",
    default: false,
    group: "bench",
    home: "runtime-config",
    describe:
      "TB environment posture (opt-in). When ON, the terminal brain rebuilds its SYSTEM prompt with the `owned` posture — install/configure/build freely (a working environment IS the deliverable), dropping the frozen R-ENV/R-STOP-ENV install-prohibition and adding R-ENV-OWNED/R-INSTALL-THRASH. PROMPT-TEXT-ONLY: swaps rendered rule text via boot.systemSource; touches NO SandboxPolicy/os-sandbox/host enforcement. Off ⇒ byte-identical (frozen) brain.",
    readSite: "apps/terminal/brain-mode.ts (runTerminalBrain env-posture systemSource swap)",
  },
  // RETIRED by TB21-06 (retirement manifest SR-6): `QUANTA_TB_BEST_OF_N`, the terminal-local
  // best-of-N sampler knob. Trials belong to the external run harness (its `-k <n>` gives each
  // trial a fresh container); a second sampling layer inside the brain shared one exhausted
  // duplex and one container, so its attempts were not independent. There is no replacement
  // knob — the 2.1 run config REFUSES an enabled terminal-local sampler beside `-k`
  // (`apps/bench/terminal/config.ts` `assertNoTerminalBestOfN`).
  // TB cassette (TB21-06 TC-6) — DEFAULT-ON trajectory recording on the brain report.
  // The jul-3 M0 regression could not be RCA'd without a record of what the agent actually did, so
  // this is the one deliberately default-ON TB knob; an explicit 0/false/off suppresses the field
  // entirely (byte-identical to the pre-cassette report). AGENT-SIDE read via
  // `resolveTrajectoryOn(env)` in `apps/terminal/brain-mode.ts`.
  {
    envKey: "QUANTA_TB_TRAJECTORY",
    kind: "bool",
    default: true,
    group: "bench",
    home: "runtime-config",
    describe:
      "TB report cassette (DEFAULT-ON). Records a bounded compact trajectory on the brain report — every tool call paired with ok/exit/preview plus coalesced assistant-text claims — so a run is always RCA-able. No-leak: only the model's own actions/claims. Explicit 0/false/off suppresses the `trajectory` field (byte-identical to the pre-cassette report).",
    readSite: "apps/terminal/brain-mode.ts (resolveTrajectoryOn report cassette)",
  },
  // TB OC1 sub-lever (TB21-06 TC-6) — output-contract check riding the verify-gate's
  // single bounded follow-up. Default-OFF and INERT unless QUANTA_TB_VERIFY_GATE is also ON
  // (separate knob so its effect is measured in isolation from v2).
  {
    envKey: "QUANTA_TB_OUTPUT_CONTRACT",
    kind: "bool",
    default: false,
    group: "bench",
    home: "runtime-config",
    describe:
      "TB OC1 output-contract sub-lever (opt-in; effective only with QUANTA_TB_VERIFY_GATE). Since S4 (RFC jul-3) the single bounded verify-gate follow-up is RUN-only; OC1 ON additionally fires it when an EXERCISED deliverable ran to a DIRTY exit (crash-at-invocation, e.g. sam-cell-seg exit 2), not only when it was never exercised. OFF ⇒ the follow-up fires only on a never-exercised deliverable.",
    readSite: "apps/terminal/brain-mode.ts (runTerminalBrain outputContractOn)",
  },
  // TB S1 self-test discipline (RFC jul-3 /02 S1) — spec-derived, range-covering executable self-test
  // steer on the instruction turn. Default-OFF (measure-first: box A/B before it ships on).
  {
    envKey: "QUANTA_TB_SELF_TEST",
    kind: "bool",
    default: false,
    group: "bench",
    home: "runtime-config",
    describe:
      "TB S1 self-test discipline (opt-in). When ON, appends a spec-derived self-test discipline block to the instruction turn: build an EXECUTABLE self-test from the task spec that covers the input RANGE + edges, run the deliverable against it, and iterate to green before finalizing. Targets the measured synthesis-convergence bottleneck (polyglot/sam consistent 0/3: a single-value self-compare passed a wrong general solution). No-leak: task spec only, never the hidden test/verifier. OFF ⇒ the instruction turn is byte-identical.",
    readSite: "apps/terminal/brain-mode.ts (runTerminalBrain selfTestOn)",
  },
  // TB Phase C oracle-repair loop (RFC jul-3 /02) — HARNESS-enforced convergence (not just a prompt
  // steer): drive the agent's own self-test to green with bounded feedback rounds. Default-OFF.
  {
    envKey: "QUANTA_TB_ORACLE_LOOP",
    kind: "int",
    default: undefined,
    group: "bench",
    home: "runtime-config",
    describe:
      "TB harness-enforced oracle-repair loop (opt-in). After the main run, while the agent's OWN self-test is observed RED, the harness feeds that self-test's OWN failing output back as a follow-up turn and lets the agent re-edit + re-run — bounded to K rounds (1/on/true ⇒ 2; a positive int ⇒ that many, hard-capped at 4) with a turn-budget watchdog. The structural attack on the synthesis-convergence bottleneck (single-pass can't match multi-attempt without a real convergence harness). No-leak: reads ONLY the agent's own taint-clean self-test receipt + output, never the hidden verifier. Unset/0/off ⇒ byte-identical.",
    readSite: "apps/terminal/brain-mode.ts (resolveOracleLoopRounds runOracleRepairLoop)",
  },
  // TB container_exec per-stream output cap (P3-C, jul-3) — env-tunable head+tail truncation
  // budget for stdout/stderr EACH (per-stream so a stdout flood can never evict stderr). Unset ⇒
  // 8192 (byte-identical); clamped to [1024, 32768] (pty_read's 32K pane cap is the in-house
  // ceiling precedent).
  {
    envKey: "QUANTA_TB_STREAM_CAP",
    kind: "int",
    default: 8192,
    group: "bench",
    home: "runtime-config",
    describe:
      "container_exec per-STREAM head+tail output cap in chars (stdout and stderr each get their own budget). Unset/non-numeric ⇒ 8192 (byte-identical default); values clamp to [1024, 32768] so a fat env cannot blow the token budget or starve stderr diagnostics.",
    readSite: "tool/container-exec/tool.ts (resolveStreamCap MAX_STREAM)",
  },
  // TB write tool (B2, RFC jul-3) — exact-byte file authoring on the terminal surface. Default-OFF
  // (measure-first: flips on only for A/B arms until the smoke battery proves it).
  {
    envKey: "QUANTA_TB_WRITE_TOOL",
    kind: "bool",
    default: false,
    group: "bench",
    home: "runtime-config",
    describe:
      "TB `container_write_file` tool (opt-in). When ON, the terminal surface additionally mints exact-byte file authoring over the SAME container transport — content travels base64 (inert bytes, no heredoc/quoting mangling) and the write is verified by an in-container byte-count readback. Targets the file-is-the-deliverable failure class (polyglot / code-from-image). OFF ⇒ byte-identical tool menu.",
    readSite: "apps/terminal/brain-mode.ts (runTerminalBrain writeFile gate)",
  },
  // TB21-03 — TB2.1 run provenance + brain location. Both are CROSS-LANGUAGE
  // knobs: quanta-TS materializes them at the bench composition root, and the
  // Python agent adapter (`quanta_agent.py`) is the consumer. Registered here
  // (rather than left as ad-hoc shell exports, retirement SR-13) so the unified
  // knob catalog stays the true SSOT and `/knobs` can show an operator what a
  // paid TB2.1 run is actually configured with.
  {
    envKey: "QUANTA_TB_AGENT_VERSION",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe:
      "TB2.1 agent provenance: `<package.json version>+g<sha>[.dirty]` (sha 7-40 lowercase hex; `.dirty` REQUIRED iff `git status --porcelain` is non-empty and FORBIDDEN when clean). DERIVED by `quanta-bench terminal run` and delivered as a per-run agent env override (`--ae`). The upstream leaderboard keys a submission on (agent, agent_version, model, reasoning_effort), so a trial without it is unattributable and the Python agent adapter refuses to construct.",
    readSite: "apps/bench/terminal/harbor-command.ts",
  },
  {
    envKey: "QUANTA_TERMINAL_BRAIN_CMD",
    kind: "string",
    default: undefined,
    group: "bench",
    home: "bench",
    describe:
      "Path/name of the quanta terminal-brain executable the TB2.1 Python agent adapter spawns as the 'brain' subprocess. Unset \u21d2 `quanta-terminal-brain` on PATH. Read by the TB doctor (to probe `--version`) and by the adapter (to spawn), so a box can point at an installed path without a code change.",
    readSite: "apps/bench/terminal/doctor.ts",
  },
  // W4-b (ADR-0540 Wave 2 item 0) — on-disk kernel session event log. Default-OFF substrate for
  // wire connect({resume}) (transport-unified-sdk ticket 05): when set, kernel SessionEvents append
  // to <dir>/<sessionId>.jsonl (protocol-codec envelope lines) and post-restart seq issuance
  // RESUMES from the log tip instead of 0. Unset ⇒ in-memory log, byte-identical.
  {
    envKey: "QUANTA_SESSION_EVENT_LOG_DIR",
    kind: "string",
    default: undefined,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "On-disk session event-log directory (W4-b). Set \u21d2 kernel session events persist as append-only JSONL at <dir>/<sessionId>.jsonl and seq issuance resumes from the on-disk tip after a restart (the substrate wire connect({resume}) replays from \u2014 ticket 05). Unset/blank \u21d2 the in-memory event log, byte-identical zero-disk default.",
    readSite: "host/runtime/persistence.ts",
  },
  {
    envKey: "QUANTA_IMAGE_SANITIZATION",
    kind: "bool",
    default: false,
    group: "llm",
    home: "runtime-config",
    describe:
      "Enable the image-sanitization retry adapter for the CLI REPL. Unset leaves the provider path unchanged.",
    readSite: "apps/cli/repl/surface-compose/runtime-compose.ts",
  },
  {
    envKey: "QUANTA_LLM_ENDPOINT",
    kind: "string",
    default: undefined,
    group: "llm",
    home: "runtime-config",
    describe:
      "Name of a configured openaiEndpoints profile (central config) to drive the CLI LLM (custom baseUrl / local model). Unset ⇒ the vendor path. Secret via QUANTA_ENDPOINT_API_KEY.",
    readSite: "apps/cli/configured-endpoint-wire.ts",
  },
  {
    envKey: "QUANTA_MENTION_APP_PLUGIN",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "Enable @@app and plugin:// mention dependencies at the host resolver composition root.",
    readSite: "host/runtime/internal/mention-app-plugin-deps.ts",
  },
  {
    envKey: "QUANTA_PEER_MSG_SURFACE",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Surface attributed peer and side-agent mailbox messages to the session transcript.",
    readSite: "host/runtime/peer-message-sink-wire.ts",
  },
  {
    envKey: "QUANTA_PRECOMPACT_CONFIRM",
    kind: "bool",
    default: false,
    group: "permission",
    home: "runtime-config",
    describe: "Ask for operator confirmation before context compaction in the CLI surface.",
    readSite: "apps/cli/repl/surface-compose/core-state.ts",
  },
  {
    envKey: "QUANTA_SERVE_STDIO",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe: "Maturity gate for the stdio serving transport; only the exact value 1 enables it.",
    readSite: "apps/cli/serve-stdio-cmd.ts",
  },
  {
    envKey: "QUANTA_SHADOW_VERIFY",
    kind: "bool",
    default: false,
    group: "security",
    home: "runtime-config",
    describe: "Enable the shadow-workspace verification slot in the CLI composition root.",
    readSite: "apps/cli/repl/surface-compose/core-state.ts",
  },
  {
    envKey: "QUANTA_TURN_DIFF",
    kind: "bool",
    default: false,
    group: "observability",
    home: "runtime-config",
    describe: "Attach per-turn git-diff observability to the CLI REPL runtime.",
    readSite: "apps/cli/repl/surface-compose/runtime-compose.ts",
  },
  {
    envKey: "QUANTA_VENDOR_RULES",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "Load trusted multi-vendor repository glob rules into interactive, headless, and IDE mode presets.",
    readSite: "apps/agent/mode-presets/interactive.ts",
  },
  {
    envKey: "QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD",
    kind: "bool",
    default: false,
    group: "web-daemon",
    home: "runtime-config",
    describe:
      "Explicitly acknowledge an unauthenticated wildcard web-daemon bind; loopback remains the safe default.",
    readSite: "apps/web-daemon/index.ts",
  },
  {
    envKey: "QUANTA_WORKING_STATE",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Enable the CLI working-state panel and its /state projection.",
    readSite: "apps/cli/repl/surface-compose/core-state.ts",
  },
]
