/**
 * Anti-regression scanner — pins the "no silent fallback / no heuristic"
 * contract across the WHOLE `src/` tree (not just `src/apps/eval/`).
 *
 * The rules below encode the structural invariants the 3-round audit pinned:
 *
 *   - **No string-substring error classification.** Retry / fallback / policy
 *     decisions read `LLMError.kind`/`statusCode`. Anything that does
 *     `e.message.includes(...)` to make a routing decision is a regression.
 *   - **No `process.env` reads outside `runtime-config.ts`.** Every env
 *     variable goes through the frozen `runtimeConfig()` so a garbage value
 *     can't silently flip behavior.
 *   - **No `Math.random()`.** Use `node:crypto.randomBytes` (or `randomUUID`)
 *     for any id/token mint — the collision space matters under parallelism.
 *   - **No empty `catch {}` blocks.** Either log via `@/shared.logger`,
 *     rethrow, or destructure the error into a typed `surface()` event.
 *   - **No `as JailedPath` casts outside `storage/service.ts`.** The brand
 *     is unforgeable BY DESIGN — the only legitimate constructor is
 *     `resolveJailed`.
 *   - **No `as LogLevel` / `as HITLTier` etc. on raw env / unknown.** Use
 *     the validators in `runtime-config.ts` / explicit guards.
 *   - **No magic `setTimeout(..., 5_000 / 30_000 / 60_000 / 120_000 / 180_000)`
 *     literals outside a named `UPPER_SNAKE_CASE` const.**
 *
 * Adding a new file under `src/`? The scan runs against it automatically.
 * If a banned pattern is legitimately required, document why and add the
 * file path to the rule's `allowlist` — that is the audit trail.
 *
 * The rules apply ONLY under `src/`. Test files exercise the violations on
 * purpose; the scanner intentionally does not look at `tests/`.
 */
// meta-test: scans src/ for banned patterns; no src/ unit to import.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

const SRC = join(__dirname, "..", "..", "src")

interface Rule {
  id: string
  pattern: RegExp
  why: string
  allowlist?: Record<string, string>
  /** Optional file-path predicate — when set, the rule only applies to files
   *  whose `relPath` (relative to `src/`) matches. Lets a rule target a single
   *  slice (e.g. `agent/`, `permission/`) without polluting `allowlist` with
   *  every other slice's legitimate uses. */
  scope?: RegExp
}

const RULES: readonly Rule[] = [
  {
    id: "no-process-env-outside-config",
    // Any direct `process.env` access outside the single owner.
    pattern: /\bprocess\.env\b/,
    why: "All env reads must go through `runtimeConfig()` (src/shared/runtime-config.ts) so garbage values are validated + logged at startup.",
    allowlist: {
      "shared/runtime-config.ts": "the single legitimate process.env owner — validates + freezes",
      "apps/cli/dotenv.ts":
        "user-facing dotenv loader writes into process.env BEFORE any module reads runtimeConfig()",
      "apps/cli/index.ts": "CLI bootstraps the same loader before module-level reads",
      "apps/agent/index.ts":
        "unified agent CLI entry — same bootstrap posture as apps/cli/index.ts: loadEnvFiles() runs before the API-key reads in buildLLM/resolveProvider (provider selection is a launch-time decision, not a feature read).",
      "apps/cli/internal.ts":
        "CLI feature-flag bootstrap — threads typed values via AgentConfig; downstream modules never read env directly. TODO(S5): migrate to runtimeConfig progressively.",
      "apps/cli/config-migration-notice.ts":
        "Injection-first by design (the file is explicitly env-free/homedir-free — every path injected): `process.env` is ONLY the default for the injected `env` param so the CLI entry works without threading, while tests inject a fake env. The action flag is read off that injected param, not a module-level process.env — same CLI-bootstrap posture as apps/cli/internal.ts. TODO(S5): migrate the flag to runtimeConfig progressively.",
      "apps/cli/ask-user-wire.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param (tests pass a fake env); the gate is read off that param via `gateOn(env, ...)`, never a module-level process.env. Same DI-boundary posture as config-migration-notice.ts.",
      "apps/cli/fetch-rules-wire.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param (tests pass a fake env); the gate is read off that param via `gateOn(env, ...)`, never a module-level process.env. Same DI-boundary posture as config-migration-notice.ts.",
      "apps/bench/index.ts": "bench CLI has its own dotenv shim; same bootstrap posture as the CLI",
      "apps/bench/run-main.ts":
        "Bench local-run composition root extracted verbatim from apps/bench/index.ts (already allowlisted) — owns the same dotenv shim + QUANTA_BENCH_* / QUANTA_SWEBENCH_* launch-time reads; downstream logic receives resolved values. Same bench-bootstrap posture as apps/bench/index.ts.",
      "apps/bench/run-args.ts":
        "Bench CLI-arg parsing concern extracted verbatim from apps/bench/run-main.ts — the tiny dotenv shim (loadEnv writes process.env before any runtimeConfig() read) + the QUANTA_BENCH_CONCURRENCY launch-time read; downstream receives resolved values. Same bench-bootstrap posture as apps/bench/index.ts.",
      "apps/bench/dataset-family.ts":
        "Injection-first (jul-01 A1): `process.env` is ONLY the default for the injected `env` param of `bridgeDatasetFamilyToEnv` (tests pass a fake env); the flag→QUANTA_SWEBENCH_DATASET_FAMILY bridge writes that injected param at the bench composition root. Same DI-boundary posture as runner/batch/eval/run-health.ts.",
      "apps/bench/eval/driver.ts":
        "LSP-nav opt-in probe (`QUANTA_LSP_TOOLS=full`) — same gate as CLI; tools register harmlessly without a server. Same posture as the bench CLI's env reads.",
      "runner/batch/eval/driver.ts":
        "Extracted batch core keeps the same bench-only opt-in env gates (`QUANTA_BENCH_*`) while the app surface becomes thin. Same posture as the prior apps/bench/eval/driver.ts entry; follow-up work can move these dials behind typed config.",
      "runner/batch/eval/driver/config-build.ts":
        "jul-02 god-file split of runner/batch/eval/driver.ts — PURE code motion. The bench-only opt-in `QUANTA_BENCH_*` / `QUANTA_LSP_*` gates moved here verbatim with the AgentConfig-assembly slice. Same posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/driver/selection-port-factories.ts":
        "jul-02 god-file split of runner/batch/eval/driver.ts — PURE code motion. The bench-only opt-in `QUANTA_BENCH_*` gates moved here verbatim with the selection/repair port-factory slice. Same posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/driver/repro-test-prep.ts":
        "jul-02 god-file split of runner/batch/eval/driver.ts — PURE code motion. The bench-only verifier-command env read moved here verbatim with the repro-test-prep slice. Same posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/driver/repair-phase.ts":
        "jul-02 god-file split of runner/batch/eval/driver.ts — PURE code motion. The bench-only opt-in gates (`familyCoverageCoeditEnabled(process.env)` / posture resolution) moved here verbatim with the repair-phase slice. Same posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/driver/attempt-context.ts":
        "jul-02 god-file split of runner/batch/eval/driver.ts — PURE code motion. The bench-knob/posture resolution (`resolveBenchKnobs`/`benchPostureFromState` off process.env defaults) moved here verbatim with the attempt-context slice. Same posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/driver/env-knob-parse.ts":
        "jul-02 god-file split of runner/batch/eval/driver.ts — PURE code motion. The bench env-var parsers (`resolveBenchKnobs`/`benchPostureFromState` off process.env) moved here verbatim with the env-knob-parse slice. Same posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/driver/selection-phase.ts":
        "jul-02 god-file split of runner/batch/eval/driver.ts — PURE code motion. The bench-only opt-in gates (`QUANTA_BENCH_*` / posture resolution / `familyCoverageCoeditEnabled`) moved here verbatim with the selection-phase slice. Same posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/repro-viability-wire.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param (`args.env ?? process.env`); the QUANTA_BENCH_REPRO_VIABILITY gate is read off that param via resolveReproViabilityMode, never module-level. Same bench-only opt-in gate posture as runner/batch/eval/run-health.ts; tests inject a fake env.",
      "runner/batch/eval/run-health.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param (`opts.env ?? process.env`); the QUANTA_BENCH_HEALTH_ABORT gate is read off that param via gateDisabled, never module-level. Same bench-only opt-in gate posture as runner/batch/eval/driver.ts; tests inject a fake env.",
      "lsp/server-mem-budget.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param; resolves the QUANTA_LSP_MEM_BUDGET_MB heap cap at LSP-spawn time and downstream gets the resolved budget. Same DI-boundary posture as the CLI gate wires; tests pass a fake env.",
      "lsp/adapters/base.ts":
        "ENV PROPAGATION — passes the parent's `process.env` into `buildLspServerEnv` so the spawned language-server child inherits it (plus the NODE_OPTIONS heap cap); pass-through to a child, not a feature read. Same posture as runtime/shell.ts / tool/git/runner.ts.",
      "apps/bench/remote/box-session/ec2-lifecycle.ts":
        "Bench full-remote launch dial (QUANTA_FULL_REMOTE_READY_POLLS) read at box-provision time; same bench-only opt-in env posture as runner/batch/eval/driver.ts. Downstream gets the resolved poll count.",
      "apps/bench/remote/box-session/types.ts":
        "Bench full-remote launch dial (QUANTA_FULL_REMOTE_INSTANCE_TYPE) read in the provision-config defaults; same bench-only opt-in env posture as the sibling ec2-lifecycle.ts. Downstream gets the resolved instance type.",
      "apps/bench/remote/box-session.ts":
        "Bench full-remote box-LAUNCH command composition — resolves the dataset family/namespace (QUANTA_SWEBENCH_DATASET_FAMILY / _DATASET_NAME, RFC jun-29 Pro verifier env) at box-provision time to assemble the on-box run command string; same bench-only opt-in launch posture as the sibling box-session/ec2-lifecycle.ts + box-session/types.ts entries. The box receives a resolved command, not live env.",
      "apps/bench/remote/pool.ts":
        "Bench full-remote pool composition root — `resolveDatasetFamily(undefined, process.env)` resolves the dataset family at pool-launch; same bench-only opt-in launch posture as box-session/ec2-lifecycle.ts. Downstream chunks receive the resolved family.",
      "apps/bench/remote/pool/worker.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param of `resumeForwardEnvFor`; the resume config + aws creds are read off that param, tests pass a fake env. Same DI-boundary posture as runner/batch/eval/run-health.ts.",
      "apps/bench/resume/resume-launch.ts":
        "BOX-SIDE prelaunch entrypoint (`bun run resume-launch.ts`) — reads QUANTA_BENCH_INSTANCE_ID at launch and threads `process.env` into `prepareResume(env, id)` (which reads off the param); composition-root posture same as apps/bench/index.ts. Downstream gets the resolved replay env.",
      "runner/batch/eval/sandbox.ts":
        "Bench-only opt-in resume gate (QUANTA_BENCH_RESUME) read inline at the deterministic-sandbox-path decision (the file documents it is intentionally inline, owned elsewhere — not a config module); same bench-only opt-in env-gate posture as runner/batch/eval/driver.ts.",
      "runner/batch/eval/repro-adapter.ts":
        "Bench-only opt-in gate (QUANTA_BENCH_REPRO_IMAGE_EXEC, RFC jun-29-repro-adapter-polyglot Phase 2b — DEFERRED/default-OFF, byte-identical when unset) read inline at the repro exec-backend decision; same bench-only opt-in env-gate posture as runner/batch/eval/driver.ts + sandbox.ts.",
      "lsp/server-rss-watchdog.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param; the RSS-watchdog reads its budget gate off that param, tests pass a fake env. Same DI-boundary posture as lsp/server-mem-budget.ts.",
      "apps/eval/index.ts": "eval CLI bootstraps env BEFORE other modules read it (mirrors bench)",
      "apps/probe/index.ts":
        "probe CLI bootstraps env before module loads (same posture as other CLI entries)",
      "tool/git/runner.ts":
        "ENV PROPAGATION (not config read) — copies a hardcoded ALLOWED_ENV set INTO the spawned git child; this is intentional pass-through, not a feature read.",
      "mcp/client.ts":
        "ENV PROPAGATION — passes the parent's PATH so the MCP stdio child can find its binary; not a feature-flag read.",
      "apps/bench/corpus/dataset.ts":
        "ENV PROPAGATION — bench shells out to git/python; child env is intentionally the parent's.",
      "runner/batch/corpus/dataset.ts":
        "Extracted batch core preserves the same env pass-through for git/python child processes; this is propagation, not a feature read.",
      "apps/bench/python-swebench.ts":
        "ENV PROPAGATION — same posture as swebench-dataset.ts; the Python harness inherits parent env.",
      "apps/bench/harness/prepare.ts":
        "ENV PROPAGATION — the Python prepare_images subprocess inherits parent env (Docker socket, PATH, HOME for conda).",
      "apps/bench/harness/images.ts":
        "ENV PROPAGATION — Bun.spawn `docker images` inherits parent env (DOCKER_HOST, PATH); not a feature-flag read.",
      "runtime/shell.ts":
        "ENV PROPAGATION — `inheritEnv:true` lets the spawned child see the parent's env directly (used by bench/agent shells); not a feature read.",
      "runtime/sandbox.ts":
        "ENV PROPAGATION — docker sandbox forwards named env vars (a hardcoded ALLOWLIST) to the container; pass-through, not a feature flag.",
      "subagent/handlers-6.ts":
        "ENV PROPAGATION — subagent child-process spawn forwards parent env (merged with `input.env`); same posture as runtime/shell.ts and tool/git/runner.ts — pass-through, not a feature read.",
      "subagent/exec-command.ts":
        "ENV PROPAGATION — the exec-command bridge spreads the parent env INTO the spawned bash child (`{ ...process.env, ...input.env }`) so PATH/HOME resolve for the subprocess; pass-through to a child, not a feature read. Same spawner env-boundary posture as subagent/handlers-6.ts and tool/git/runner.ts.",
      "agent/loop-helpers.ts":
        'DEFAULT-OFF gate at a seam — reads the OTel content-capture gate `gateOn(process.env, "QUANTA_OTEL_CAPTURE_CONTENT")` at the span-close boundary. Unset/falsy ⇒ NO content leaves the process (byte-identical); the redacted OTLP content plane is armed only when the gate is on AND a span sink is live. Same sanctioned default-OFF gate-at-a-seam class as tool/web/providers/from-env.ts; mirrored in the @/agent slice-boundary envAllowFiles.',
      "agent/loop/control-poll.ts":
        "Injection-first DEFAULT-OFF gate — `isControlRequestEnabled(slot.env ?? process.env)`: `process.env` is ONLY the DI fallback for the injected `slot.env` (tests pass a fake env). An absent controlRequest slot OR gate-off ⇒ the port is never even queried (byte-identical). Same injection-first gate-at-a-seam posture as connectors/marketplace-policy.ts; mirrored in the @/agent slice-boundary envAllowFiles.",
      "tool/container-exec/tool.ts":
        "DEFAULT-OFF dial resolved at module load — `resolveStreamCap(process.env)` reads the per-stream output cap `QUANTA_TB_STREAM_CAP`; unset/≤0 ⇒ the fixed 8K default (byte-identical). `resolveStreamCap` is PURE (takes the env bag), so the raw `process.env` is only its call-boundary argument. Same env-at-call-boundary posture as runner/diff-ops.ts; mirrored (path-scoped) in the @/tool slice-boundary envAllowFiles.",
      // jun-09 long-tail (§4.3/§1.6/§2.5/P16/ci-bot wiring) — injection-first DI
      // boundaries + one env-propagation, same posture as the entries above.
      "host/runtime/side-agent-fork-port.ts":
        "ENV PROPAGATION (§4.3) — `{...process.env, ...spec.env}` forwards the parent env into the forked side-agent child; intentional pass-through, not a feature read. Same posture as subagent/handlers-6.ts.",
      "connectors/connector-marketplace.ts":
        "Injection-first (§1.6): `process.env` is ONLY the default for the injected `env` param; the gate is read via `gateOn(env, ...)`, never a module-level read. Same DI-boundary posture as config-migration-notice.ts.",
      "connectors/marketplace-policy.ts":
        "Injection-first (§2.5): same `env`-param default + `gateOn(env, ...)` DI-boundary posture as connector-marketplace.ts.",
      "runtime/shell-argv.ts":
        "Injection-first (P16 win-shell): `process.env` is ONLY the default for the injected `env` param used to resolve the shell mode; tests pass a fake env. Same DI posture as config-migration-notice.ts.",
      "apps/agent/mode-presets/ci-bot.ts":
        "ci-bot mode-preset WIRING reads its opt-in long-tail gates (QUANTA_GH_CODE_TOUR / CI_FINDING / GIT_CO_CHANGE) via `gateOn(env, ...)` at the composition site; same launch-time bootstrap posture as apps/cli/internal.ts (threads typed opts downstream).",
      "apps/cli/shell-stream-painter.ts":
        "NO_COLOR is the cross-tool no-color.org convention read at the TTY paint boundary (alongside stderr.isTTY); a presentation-layer signal, not a validated feature flag — routing it through runtimeConfig would be over-centralization.",
      "apps/cli/auth-ui.ts":
        "Same NO_COLOR / FORCE_COLOR presentation read as shell-stream-painter.ts — TTY paint boundary for the /login UI; not a feature flag.",
      "apps/cli/login-cmd.ts":
        "CLI sub-command entry (ADR-0094 ChatGPT-OAuth). Same posture as apps/cli/internal.ts — `deps.env ?? process.env` is the DI fallback at the composition root; downstream `auth/` modules accept env explicitly.",
      "apps/cli/attach-cmd.ts":
        "CLI sub-command entry (`quanta attach`). `parseAttachArgs(argv, process.env)` threads env at the composition root for arg-default resolution; the parser reads it off the passed param, tests inject a fake env. Same DI-fallback posture as login-cmd.ts.",
      "apps/cli/status-cmd.ts":
        "CLI sub-command entry (ADR-0094). Same DI fallback posture as login-cmd.ts.",
      "apps/cli/logout-cmd.ts":
        "CLI sub-command entry (ADR-0094). Same DI fallback posture as login-cmd.ts.",
      "apps/cli/rule-indicator.ts":
        "Surface-only rule indicator (read-only mirror of repo-rules/glob-rules loaders). Same DI fallback posture as status-pills.ts — `opts.env ?? process.env` at the composition root, tests inject explicit env. Not a feature read of a runtimeConfig-validated knob.",
      "apps/cli/diff-preview.ts":
        "Surface presentation read (NO_COLOR / FORCE_COLOR) at TTY paint boundary; same posture as shell-stream-painter.ts.",
      "apps/cli/edit-message-cmd.ts":
        "CLI sub-command entry — same DI fallback posture as login-cmd.ts.",
      "apps/cli/edit-plan-cmd.ts":
        "CLI sub-command entry — same DI fallback posture as login-cmd.ts.",
      "apps/cli/history-cmd.ts":
        "CLI sub-command entry — same DI fallback posture as login-cmd.ts.",
      "apps/cli/idle-monitor.ts":
        "Surface idle-monitor reads idle-window envs at composition root; same posture as status-pills.ts.",
      "apps/cli/dream-cmd.ts": "CLI sub-command entry — same DI fallback posture as memory-cmd.ts.",
      "apps/cli/doctor/default-probes.ts":
        "Surface adapter (RFC jun-6-doctor-selfcheck §5) — the `/doctor` probe wiring legitimately reads `process.env` to REPORT environment health (BYOK key presence, dead-knob conditions); the pure check-registry leaf (registry.ts/render.ts) stays env-free and sees only the injected probe shape. Same surface-ambient posture as status-pills.ts.",
      "apps/cli/mcp-cmd.ts": "CLI sub-command entry — same DI fallback posture as login-cmd.ts.",
      "apps/cli/mcp-server-setup.ts":
        "Reverse-MCP server composition root (ticket-19) — the `quanta mcp` sub-command entry reads its STRICT activation gate (QUANTA_MCP_SERVER) + the EXPOSE list at bootstrap, same CLI-entry posture as mcp-cmd.ts; the assembled server + tool ports downstream stay env-free.",
      "apps/cli/memory-cmd.ts": "CLI sub-command entry — same DI fallback posture as login-cmd.ts.",
      "apps/cli/repl.ts":
        "REPL composition root — same posture as apps/cli/internal.ts (CLI feature-flag bootstrap).",
      "apps/cli/repl/session-loop.ts":
        "REPL session-loop composition root — same posture as repl.ts.",
      "apps/cli/repl/session-runtime-config.ts":
        "REPL session-runtime-config composition root — same posture as repl.ts.",
      "apps/cli/rewind-cmd.ts": "CLI sub-command entry — same DI fallback posture as login-cmd.ts.",
      "apps/cli/rewind-git.ts":
        "CLI rewind-git composition root — env DI fallback per CLI posture.",
      "apps/cli/sandbox-wire.ts":
        "Sandbox-wire composition root — env DI fallback per CLI posture.",
      "apps/cli/cli-knobs-accessor.ts":
        "THE designated CLI knob env reader (ADR-0503 P4) — env DI fallback to process.env is its contract; also exempt in the no-raw-process-env ratchet.",
      "apps/cli/status-flash-config.ts":
        "Surface status-flash config — env DI fallback at TTY composition.",
      "apps/cli/slash-commands-capabilities.ts":
        "Diagnostic command (/capabilities, /caps) — intentionally reads the LIVE process.env to REPORT each capability's gate state via gateOn(env, …); display-only, never a feature read. Same surface-ambient posture as doctor/default-probes.ts.",
      "apps/cli/status-pills.ts":
        "Surface presentation read (same posture as shell-stream-painter / auth-ui).",
      "apps/cli/web-cmd.ts": "CLI sub-command entry — same DI fallback posture as login-cmd.ts.",
      "mcp/isolated-client.ts":
        "ENV PROPAGATION — passes parent env to spawned MCP child (same posture as mcp/client.ts).",
      "media/stt/registry.ts":
        "Media composition root — env DI fallback for provider selection at boot.",
      "plugin-isolation/bun-spawner.ts":
        "ENV PROPAGATION — copies parent PATH into spawned plugin child (same posture as tool/git/runner.ts and runtime/shell.ts).",
      "storage/shadow-odb/default.ts":
        "Shadow ODB composition root — resolves HOME at boot for default odb path; not a feature flag.",
      "tool/debug/port.ts":
        "ENV PROPAGATION — forwards the parent OS env (merged with `spec.env`) to the spawned DAP debug-adapter child so it can find its binary on the real PATH/HOME; pass-through, not a feature read. Same posture as tool/git/runner.ts and plugin-isolation/bun-spawner.ts.",
      "tool/web/providers/from-env.ts":
        "BY NAME — this is the documented env-reader for web-search providers (factory mirrors openai/anthropic adapters' env-key bootstrap).",
      "ui/ui-helpers.ts":
        "Surface presentation read (NO_COLOR / FORCE_COLOR) — same posture as shell-stream-painter.ts and auth-ui.ts.",
      "shared/env-files.ts":
        "BY NAME — the tiny dotenv loader itself; writes KEY=VALUE into process.env BEFORE runtimeConfig() reads (same posture as apps/cli/dotenv.ts, which this is the shared implementation of).",
      "host/runtime/agent-arg-builder.ts":
        "Host-layer launcher composition builder — argv/env → AgentConfig base; ADR-0303 relocation from apps/agent/index.ts. Reads process.env / process.cwd() / process.exit(2) at the composition root (distinct from the env-PURE agent-config-assembler.ts sibling); same posture as apps/agent/index.ts.",
      "host/runtime/agent-arg-builder/gated-tool-ports.ts":
        "God-module split of agent-arg-builder.ts — the gated-tool registry cluster (buildGatedToolPorts / buildBaseRegistry). Reads the LIVE process.env at the composition root to evaluate per-tool gates (gateOn(process.env, …)) + process.cwd() for the .mcp.json default path; byte-identical to the reads that lived in agent-arg-builder.ts before the split. Same composition-root posture as agent-arg-builder.ts.",
      "host/runtime/internal/context-binding.ts":
        "Runtime composition root — binds `process.env` into the bootstrap shape (DEFAULT_RUNTIME_ENV default + wireInteractiveKnobs at boot); downstream modules receive the bound env via AgentConfig. Same posture as apps/cli/internal.ts.",
      "host/runtime/internal/mention-wire.ts":
        "Mention-resolver composition wiring — threads `process.env` into buildMentionSymbolDeps/buildDefaultMentionResolver at boot; same posture as context-binding.ts.",
      "apps/agent/assemble.ts":
        "Surface shim (ADR-0303) — binds launch-time process.env into the env-pure host assembler core (@/host/runtime/agent-config-assembler); same posture as apps/agent/index.ts.",
      "apps/agent/interactive-turn-assembler.ts":
        "Surface shim (ADR-0303) — binds launch-time process.env into the shared host interactive turn-assembler; same posture as apps/agent/assemble.ts.",
      "apps/agent/mode-presets/daemon.ts":
        "Agent mode-preset composition root — passes process.env into the shared knob wiring; same posture as apps/agent/assemble.ts.",
      "apps/agent/mode-presets/headless.ts":
        "Agent mode-preset composition root — same posture as daemon.ts.",
      "apps/agent/mode-presets/interactive.ts":
        "Agent mode-preset composition root — threads launch-time process.env into driveSessionTurn's crash-resume gate (WS-A UUX-1-04, same env-threading the CLI session-loop does); same posture as daemon.ts.",
      "apps/agent/mode-presets/ide.ts":
        "Agent mode-preset composition root — same posture as daemon.ts.",
      "apps/cli/at-autocomplete/env.ts":
        "Surface at-autocomplete gate — DI fallback (`env: NodeJS.ProcessEnv = process.env`) at composition root; tests inject explicit env. Same posture as status-pills.ts.",
      "apps/cli/from-pr-cmd-adapters.ts":
        "CLI sub-command adapter — env read at composition boundary (`process.env[name]` helper); same DI posture as from-pr surfaces.",
      "apps/cli/raw-line-reader-editor.ts":
        "CLI line-editor surface — `a.env ?? process.env` DI fallback for $EDITOR resolution at composition root; tests inject explicit env. Same posture as login-cmd.ts.",
      "apps/cli/repl/factories/notify-and-warning.ts":
        "REPL factory composition root — resolves notify channel from env at boot; same posture as repl.ts.",
      "apps/cli/repl/runtime-context-compose.ts":
        "REPL runtime-context composition root — `args.envSource ?? process.env` DI fallback; same posture as repl.ts.",
      "apps/cli/session-registry-cmd.ts":
        "CLI sub-command entry — reads session-registry backend paths at composition root; same DI posture as login-cmd.ts.",
      "apps/cli/slash-commands-knobs.ts":
        "CLI slash-command knob wiring — passes process.env into the shared knob resolver at composition root; same posture as repl.ts.",
      "apps/cli/status-bar.ts":
        "Surface status-bar — `options.env ?? process.env` DI fallback at TTY composition; same posture as status-pills.ts.",
      "apps/eval/synthetic/runner.ts":
        "ENV PROPAGATION — synthetic eval runner forwards parent env to child processes; same posture as apps/bench/corpus/dataset.ts.",
      "apps/eval/trajectory/replay.ts":
        "ENV PROPAGATION — trajectory replay forwards parent env to child processes; same posture as apps/eval/synthetic/runner.ts.",
      "apps/web-daemon/index.ts":
        "Web-daemon composition root — reads QUANTA_WEB_* launch-time config (port/bind/token/strict) at boot; same posture as the other apps/ entry points. Downstream handlers receive typed config.",
      "apps/web-daemon/server.ts":
        "Web-daemon composition root — QUANTA_WEB_* server config + a controlled env-mutation seam (set/delete) used by the static-asset/dist resolver at boot; same posture as index.ts.",
      "apps/web-daemon/auth-routes.ts":
        "Web-daemon OAuth route composition (ADR-0094) — resolves token/home paths from env at request-boot; same DI posture as apps/cli/login-cmd.ts.",
      "apps/web-daemon/persistence-sqlite.ts":
        "Web-daemon persistence composition root — resolves QUANTA_WEB_DB_DIR (with HOME default) at boot; same posture as storage/shadow-odb/default.ts.",
      "apps/web-daemon/runtime-factory.ts":
        "Web-daemon runtime factory composition root — binds process.env into the runtime shape; same posture as index.ts.",
      "mcp/transports/stdio.ts":
        "ENV PROPAGATION — passes the parent's PATH so the MCP stdio child can find its binary; moved verbatim from mcp/client.ts (already allowlisted with the same rationale).",
      "retrieval/reranker/registry.ts":
        "BY NAME — `createRerankerFromEnv` is the documented env-reader factory for reranker providers (DI override `opts.providerOverride ?? process.env`); same posture as tool/web/providers/from-env.ts.",
      "runner/batch/core.ts":
        "Extracted batch core — passes process.env into resolveBenchKnobs at the batch composition boundary; same bench-only opt-in posture as runner/batch/eval/driver.ts.",
      "runner/diff-ops.ts":
        "Env-driven display caps resolved at call time via the module's own NaN-safe parsePositiveInt (not raw Number()); composition-adjacent read, not a feature flag that flips behavior silently.",
      "runner/knobs/registry.ts":
        "NODE_ENV prod-guard inside test-only escape hatches (__resetRegistry/__restoreRegistry) — refuses to run in production; reads NODE_ENV as a safety fence, not a feature flag.",
      "runtime/os-sandbox/env.ts":
        "`resolveSandboxProfileFromEnv(env = process.env)` DI fallback that projects QUANTA_SANDBOX onto a closed enum (unknown ⇒ undefined); same DI-fallback posture as the CLI surfaces.",
      "agent/session-resource-registry/global.ts":
        "Composition-root lazy-init — reads session-registry backend paths (QUANTA_SESSION_REGISTRY_*) EXACTLY ONCE per process to pick the durable backend; degrades to in-memory on a hosed value. Composition posture, not a per-turn feature read.",
      "agent/session-resource-registry/caller-owned-builder.ts":
        "Caller-owned registry builder composition root — same session-registry backend-path reads as global.ts.",
      "agent/session-resource-registry/auto-sweep.ts":
        "Auto-sweep composition root — reads session-registry backend/WAL knobs (named *_ENV consts) at boot; same posture as global.ts.",
      "agent/session-resource-registry/inspector.ts":
        "Inspector composition root — reads the same session-registry backend env by key; same posture as global.ts.",
      "host/runtime/pty-backend.ts":
        "ENV PROPAGATION — the Bun-native PTY factory forwards the parent env (merged with the caller's `env`) into `Bun.spawn({ terminal })` so the spawned PTY child inherits PATH/HOME; same pass-through posture as runtime/shell.ts and subagent/handlers-6.ts — not a feature-flag read.",
      "storage/git-runner/runner.ts":
        "ENV PROPAGATION — `buildGitEnv` copies a hardcoded ALLOWED_ENV allowlist INTO the scrubbed env handed to the spawned `git` child (deterministic overrides win last); intentional pass-through, not a feature read. Same posture as tool/git/runner.ts.",
      "apps/cli/repo-info.ts":
        "Surface repo-identity helpers for `/version` `/release-notes` `/bug` — `env: NodeJS.ProcessEnv = process.env` DI fallback at the composition root (QUANTA_REPO_URL/QUANTA_VERSION/QUANTA_COMMIT build-time overrides); tests inject explicit env. Same DI-fallback posture as status-pills.ts / login-cmd.ts.",
      "apps/cli/version-cmd.ts":
        "CLI sub-command surface (`/version` `/release-notes`) — `deps.env ?? process.env` DI fallback at the composition root; downstream resolveVersion/repoUrl accept env explicitly. Same posture as repo-info.ts / login-cmd.ts.",
      "apps/cli/bug-cmd.ts":
        "CLI sub-command surface (`/bug`) — `deps.env ?? process.env` DI fallback at the composition root; same posture as version-cmd.ts.",
      "apps/cli/preflight.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param; the gate is read via `gateOn(env, ...)` on that param. Same DI-boundary posture as config-migration-notice.ts.",
      "apps/cli/hooks-cmd.ts":
        "CLI slash-command composition root (/hooks) — reads `process.env` once at command-run time to resolve user-config directory; same posture as login-cmd.ts.",
      "apps/cli/init-scaffold.ts":
        "Injection-first: `env: Readonly<...> = process.env` DI fallback at the init-scaffold composition root (EDITOR resolution); tests inject explicit env. Same posture as raw-line-reader-editor.ts.",
      "apps/bench/cli.ts":
        "Bench CLI sub-command composition root — reads HOME + QUANTA_SWEBENCH_DATASET + QUANTA_BENCH_PRESET at launch time (same bootstrap posture as apps/bench/index.ts, which is already allowlisted); downstream logic receives resolved values, not live env.",
      "apps/bench/commands/shared.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the shared argv/env-parse primitives (allowExtraBoxes/waitForIdleBox gates, resolveCliAuthSource `env: process.env`) read launch-time env at the CLI sub-command composition boundary; downstream handlers receive resolved values. Same composition-root posture as apps/bench/cli.ts.",
      "apps/bench/commands/grade.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the `grade` / `--mode full` handler resolves HOME + QUANTA_SWEBENCH_DATASET + QUANTA_FULL_REMOTE_* + the QUANTA_FULL_REMOTE_ONDEMAND gate + `ensureBenchTraceSink(process.env)` / `resolveBenchExecutionPreset({envVars: process.env})` at launch time. Same composition-root posture as apps/bench/cli.ts.",
      "apps/bench/commands/pool.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the `pool` handler reads QUANTA_FULL_REMOTE_CONCURRENCY / QUANTA_BENCH_CONCURRENCY launch dials + QUANTA_FULL_REMOTE_* + the QUANTA_BENCH_RECORD_TRAJECTORY gate, and `buildForwardedBenchEnv(process.env)` is ENV PROPAGATION into the spawned box. Same posture as apps/bench/remote/full.ts.",
      "apps/bench/commands/box.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the `box` handler resolves QUANTA_FULL_REMOTE_REGION / QUANTA_FULL_REMOTE_AMI + the QUANTA_FULL_REMOTE_ONDEMAND gate at launch time for box provisioning/inspection. Same composition-root posture as apps/bench/cli.ts.",
      "apps/bench/commands/auth.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the `auth login` handler resolves QUANTA_BENCH_AUTH_POOL + passes `env: process.env` into runBenchLogin (injection-first DI boundary) at launch time. Same composition-root posture as apps/bench/cli.ts.",
      "apps/bench/commands/analyze.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the analysis handlers (explain) read QUANTA_SWEBENCH_DATASET at launch time as a `--dataset` fallback; downstream logic receives resolved values. Same composition-root posture as apps/bench/cli.ts.",
      "apps/bench/commands/trace.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the `trace` handler resolves the durable span sink from QUANTA_OTEL_SINK / QUANTA_OTEL_SAVE via `resolveSpanSink(process.env)` at launch time; `runTraceSink` itself is pure (opts only). Same composition-root posture as apps/bench/otel-trace-sink.ts.",
      "apps/bench/otel-trace-sink.ts":
        "Standalone OTLP/JSON receiver + waterfall-UI script (`quanta-bench trace` / `bun … otel-trace-sink.ts`). `runTraceSink` is PURE (opts only); the SOLE env reads live in the `import.meta.main` script entry point, which resolves PORT / QUANTA_OTEL_SAVE / QUANTA_OTEL_RING via a NaN-guarded `envInt` parser and hands fully-validated options down. Same composition-root posture as apps/bench/cli.ts / index.ts.",
      "apps/bench/remote/ssh.ts":
        "Infrastructure HOME-expansion helper (`expandHome`) for tilde-prefix path resolution — pure string op, reads `process.env.HOME` only as a path component fallback; same posture as storage/shadow-odb/default.ts.",
      "apps/cli/webhook-server-setup.ts":
        "Webhook-server CLI composition root (`quanta webhook`) — reads QUANTA_GITHUB_WEBHOOK strict gate + secret config + port/session-id at launch; same DI posture as apps/cli/mcp-server-setup.ts.",
      "host/runtime/internal/context-binding/base.ts":
        'God-module split of host/runtime/internal/context-binding.ts (already allowlisted) — the call-time `env = process.env` DI fallback in wireRuntimePorts + the `wireInteractiveKnobs(..., process.env, "cli")` composition-root knob wiring relocated verbatim; downstream modules receive the bound env. Same composition-root posture as context-binding.ts.',
      "apps/bench/trajectory.ts":
        "Extracted verbatim from apps/bench/index.ts (already allowlisted) — the bench LLM trajectory record/replay cluster resolves QUANTA_BENCH_(RECORD|REPLAY)_TRAJECTORY / _LIMIT / _ON_MISS gates at resolve time, default-OFF and byte-identical when unset. Same bench-bootstrap posture as apps/bench/index.ts.",
      "apps/bench/remote/full.ts":
        "Full-remote bench composition root — reads the QUANTA_FULL_REMOTE_CONCURRENCY / QUANTA_BENCH_CONCURRENCY launch dials + the QUANTA_BENCH_RECORD_TRAJECTORY gate, and `buildForwardedBenchEnv(process.env)` is ENV PROPAGATION of the parent env into the spawned EC2 box. Same posture as apps/bench/remote/ssh.ts and the env-propagation entries.",
      "apps/bench/remote/single-box-guard.ts":
        "Bench single-box-guard composition — `resolveSingleBoxGuardDir` reads QUANTA_BENCH_SINGLE_BOX_GUARD_DIR at boot with a HOME-path fallback; not a feature flag. Same composition-root posture as apps/bench/remote/token-budget.ts.",
      "apps/bench/remote/fresh-auth.ts":
        "Injection-first: `opts.env ?? process.env` DI fallback feeding resolveOAuthConfig; tests inject explicit env. Same DI-fallback posture as apps/cli/login-cmd.ts.",
      "apps/bench/remote/token-budget.ts":
        "Bench token-budget composition — reads QUANTA_BENCH_PATCH_GEN_BUDGET / SWEEP_PATCH_GEN_BUDGET + QUANTA_BENCH_TOKEN_BUDGET_DIR at boot (raw extracted then parsed via NaN-safe asPositiveInt on a separate line). Same bench-bootstrap posture as apps/bench/index.ts.",
      "host/mcp-composition.ts":
        "P4 (jul-11) surface-shared MCP composition (moved from apps/cli/internal/mcp.ts — now @/host so the web daemon shares it): surface composition root reading QUANTA_MCP_AUTORESTART gate + resolveQuantaHome(process.env) + pickMcpNegotiator(process.env) + `envSource = process.env` DI fallbacks at launch; the assembled MCP ports downstream stay env-free. Re-exported by apps/cli/internal/mcp.ts.",
      "apps/cli/internal/argv.ts":
        "God-module split of apps/cli/internal.ts (ADR-0024) — pure process.argv/process.env CLI flag accessors (QUANTA_STATE_PATH / QUANTA_RESUME / QUANTA_OBSERVE_DIR / QUANTA_LSP_TOOLS / QUANTA_AST_GREP), re-exported from ../internal so importers keep resolving from ./internal. Same CLI-bootstrap posture as apps/cli/internal.ts.",
      "apps/cli/internal/shell-snapshot.ts":
        "God-module split of apps/cli/internal.ts — CLI shell-snapshot composition reads QUANTA_SHELL_SNAPSHOT_* via a NaN-safe intEnv helper and passes $SHELL through ONCE (ADR-0144) into AgentConfig.shellSnapshot; downstream slices never read env. Same posture as apps/cli/internal.ts.",
      "apps/web-daemon/server/fetch-handler.ts":
        "God-module split of apps/web-daemon/server.ts — the `/api/knobs` diagnostic endpoint reads the LIVE process.env to REPORT current knob values (display-only via resolveCatalogValues). Same surface-ambient posture as apps/cli/slash-commands-capabilities.ts.",
      "apps/web-daemon/server/http.ts":
        "God-module split of apps/web-daemon/server.ts — the controlled env-mutation seam (set/delete of validated config keys at the config-write endpoint) + the QUANTA_WEB_DIST static-asset resolver read, moved verbatim from server.ts (already allowlisted with this exact rationale).",
      "apps/web-daemon/server/follower-approval.ts":
        "God-module split of apps/web-daemon/server.ts — setupFollowerApproval reads QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS at boot. Same composition-root posture as apps/web-daemon/server.ts.",
      "apps/web-daemon/server/persistence.ts":
        "God-module split of apps/web-daemon/server.ts — setupThreadPersistence reads the QUANTA_WEB_DB gate at boot. Same composition-root posture as apps/web-daemon/persistence-sqlite.ts.",
      "sdk/embed.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `opts.env` param of the public `createAnalysisAgent` SDK factory (`env?: NodeJS.ProcessEnv`, documented DI seam); the resolved `env` is threaded into `resolveLlm(opts, env)`/`assembleAgentConfig(req, env)` which read provider keys off the PARAM, never a module-level read. Tests/consumers pass a fake env. Same composition-root DI-fallback posture as apps/cli/login-cmd.ts.",
      "apps/bench/lane-progress-renderer.ts":
        "Bench-surface DEFAULT-OFF opt-in gate read at the renderer composition root — `startLaneProgressRenderer` (called ONCE at apps/bench/run-main.ts, already allowlisted) reads `QUANTA_BENCH_LANE_PROGRESS`; unset/falsy ⇒ returns a no-op immediately (byte-identical). Same bench-only opt-in surface-gate posture as apps/bench/eval/driver.ts; the `nowMs` clock is separately injected.",
      "apps/bench/trajectory-debug-sink.ts":
        "Injection-first: `process.env` is ONLY the default for the injected `env` param of `isTrajectoryDebugEnabled` (`env: Record<string,string|undefined> = process.env`); the QUANTA_BENCH_RECORD_TRAJECTORY / _TRAJECTORY_DEBUG debug-tier gate is read off that param (`env.X`), never module-level. Tests pass a fake env. Same DI-boundary posture as runner/batch/eval/run-health.ts.",
      "apps/bench/run-main-helpers.ts":
        "Bench local-run composition helpers extracted verbatim from apps/bench/run-main.ts (already allowlisted) — `resolveObserve` resolves the observe root from `--observe-dir` / QUANTA_OBSERVE_DIR and `datasetFamily` resolves the family from `--dataset-family` / QUANTA_SWEBENCH_DATASET_FAMILY (via resolveDatasetFamily, itself allowlisted); both are launch-time reads called once at run setup, downstream gets resolved values. Same bench-bootstrap posture as apps/bench/run-main.ts.",
      "apps/terminal/brain-mode.ts":
        "Box-side process ENTRY shim (`import.meta.main` runMain, `/* c8 ignore */` — verified on the box): the pure `runTerminalBrain` core takes ALL env-gates off an injected `env` param (resolveMaxTurnsFromEnv/resolveOracleLoopRounds/verify-gate read `env.X`). runMain binds `process.env` ONCE at launch — threads `env: process.env` (ENV PROPAGATION so the pure core reads the verify-gate here, not ambient), resolves maxTurns, and does launch-time provider selection (`pickProvider(process.env)` / `tryCreateLLM(…, process.env)`, provider = a launch-time decision). Same composition-root posture as apps/agent/index.ts.",
      "apps/cli/rewind-tool-cmd.ts":
        "DIAGNOSTIC surface read — the `/rewind-tool` command's NOT-WIRED branch calls the PURE reporter `missingPerToolCheckpointGates(process.env)` (which reads gate presence off its injected `env` param; the hellgate passes a fake env) to REPORT which of the two wiring gates is missing (D-6 UUX-6-17). Display-only; the actual feature is gated upstream by `ctx.perToolCheckpoint` being wired, never by this read. Same diagnostic-reporter posture as apps/cli/slash-commands-capabilities.ts.",
    },
  },
  {
    id: "no-math-random",
    pattern: /Math\.random\(/,
    why: "Use `node:crypto.randomBytes`/`randomUUID` — Math.random's collision space is too small under parallel runs.",
    allowlist: {
      "agent/retry.ts": "documented non-security jitter; centralized helper, no cross-use",
      "host/runtime/internal/context-binding.ts":
        "mintSideConversationSessionId — non-security side-conversation id for in-process turn correlation, not used for collision resistance.",
      "host/runtime/internal/context-binding/side-conversation.ts":
        "God-module split of context-binding.ts — the SAME `mintSideConversationSessionId` relocated verbatim; non-security side-conversation id for in-process turn correlation, not used for collision resistance.",
    },
  },
  {
    id: "no-empty-catch",
    pattern: /catch\s*\(?[\s\S]{0,40}?\)?\s*\{\s*\}/,
    why: "Empty catch swallows errors — log via `@/shared.logger`, rethrow, or surface a typed error event.",
    allowlist: {
      "codemode/runtime.ts":
        "FALSE POSITIVE — the `catch {}` is INSIDE a template-string of generated cell-bootstrap JS (runs in the WASM cell, not TS control flow here); `delete globalThis.__cmDispatch` is best-effort fencing in that emitted code.",
      "stream/adapters/jsonl-recorder.ts":
        "explicit best-effort recording of a degraded line — the file already documents the fallthrough",
      "llm/replay/jsonl-store.ts":
        "`appendTail = run.catch(() => {})` swallows a rejection on the CHAIN TAIL only so one failed append cannot poison the serialized append chain — the documented inline comment notes the awaited `run` still surfaces the error to the caller. Same tail-swallow posture as stream/adapters/jsonl-recorder.ts.",
      "apps/cli/mcp-config-rmw.ts":
        "`await unlink(tmp).catch(() => {})` is best-effort tmp cleanup on a FAILED atomic write/rename — the primary io error is returned immediately afterward, so a cleanup failure is non-fatal and must never mask it (documented inline). Same failed-rename tmp-cleanup posture as memory/dream/team-write-target.ts.",
      "apps/bench/trajectory.ts":
        "`writeFile(metaPath, …).catch(() => {})` is a fire-and-forget run-meta sidecar write — a meta write failure must never crash the bench run (documented inline); the trajectory itself is recorded on a separate path. Same best-effort posture as apps/bench/otel-trace-sink.ts.",
      "llm/stream-timeout.ts":
        "jun-26 SE-audit: `void nextPromise.catch(() => {})` swallows the ABANDONED upstream promise's late settle on a timeout (4-line comment above explains it) — without it the orphaned rejection becomes an unhandledRejection that can crash the process; the timeout error is surfaced separately.",
      "session/store.ts": "ENOENT-style file delete cleanup; absence is the success state",
      "storage/service.ts":
        "realResolve climbs ancestors when a parent doesn't exist (expected, not an error)",
      "runtime/sandbox.ts":
        "kill-after-exited is a benign no-op (audit S6 flagged the wider catch — fix is tracked separately)",
      "skill/migration.ts":
        "mkdir recursive best-effort — absence is the success state (parent already exists, race-safe).",
      "voice/transcriber/local-whisper-transcriber.ts":
        "Voice transcriber best-effort cleanup of temp wav files and child handles (3 sites) — absence/post-exit is the success state.",
      "voice/default-recorder.ts":
        "Voice recorder best-effort cleanup of mic capture handle — absence/post-stop is the success state.",
      "media/voice/sox-capture.ts":
        "SoX capture best-effort cleanup of child handle — absence/post-exit is the success state.",
      "agent/loop.ts":
        "R4-audit browser teardown on EVERY turn exit (incl. thrown loop): `browserDispose?.().catch(() => {})` is idempotent best-effort — the session is ending, nowhere to surface a dispose error.",
      "agent/loop/entry.ts":
        "jun-6 loop-decomp relocation: the `finally` teardown (`browserDispose?.().catch(() => {})` + the new appshot peer `appshotDispose?.().catch(() => {})`) moved verbatim from agent/loop.ts — idempotent best-effort dispose at session end, nowhere to surface the error.",
      "agent/streaming-boomerang/default-streamer.ts":
        "Terminal-chunk pushes into an already-closing channel (3 sites) — the consumer is gone, there is nowhere to surface a push error; documented best-effort, same posture as stream/adapters/jsonl-recorder.ts.",
      "apps/cli/repl/voice-live-wire.ts":
        "Best-effort cancel of the mic stream reader on stop — post-stop is the success state (same posture as voice/default-recorder.ts).",
      "skill/playbook/trigger/fs-watch-adapter.ts":
        "Detached debounced scan routed through a catch sink (audit L3 C-14): one throwing/rejecting fire must not crash the watcher process as an unhandled rejection; documented inline.",
      "tool/browser/session-holder.ts":
        "Best-effort reap of a dead/superseded browser session handle (2 sites) — post-close is the success state; documented inline.",
      "mcp/client.ts":
        "Reconnect closes the STALE carrier LAST (`old?.close().catch(() => {})`) — a close-time error is non-fatal because the transport is already replaced; surfacing it would block the rebuilt path. Documented inline at the call site (same posture as stream/adapters/jsonl-recorder.ts).",
      "memory/dream/team-write-target.ts":
        "jun-06 atomic-write harden: temp-file cleanup on a FAILED rename (`unlink(tmp).catch(() => {})`) — the real rename error is about to be RETHROWN, so a cleanup failure is non-fatal and there is nothing to surface (same best-effort posture as tool/browser/session-holder.ts).",
      "apps/bench/python-swebench.ts":
        "Grading-lock chain: `await prev.catch(() => {})` waits for the PREVIOUS grading task and explicitly ignores its outcome — the lock is used for sequencing, not error detection, and the caller always receives the current task's result via the finally/release path. Documented inline.",
      "apps/bench/otel-trace-sink.ts":
        "Embedded-sink shutdown drain: `spanSink.flush().catch(() => {})` in the idempotent `stop()` — the trace server is being torn down, the last-batch flush is best-effort and there is nowhere to surface a drain error. Same session-ending best-effort posture as agent/loop.ts.",
      "apps/bench/remote/bootstrap-tracer.ts":
        "Bootstrap-span emission/teardown best-effort (2 sites): `exporter.flush().catch(() => {})` and `exporter.teardown().catch(() => {})` — the comment documents that the exporter already swallows a dead sink via its own warn, and a bootstrap-trace error must never escape into the box-provision path. Same inner-layer-already-warns posture as stream/adapters/jsonl-recorder.ts.",
      "runner/batch/eval/selection-smoke.ts":
        "`finally`-block best-effort temp-file cleanup (`(deps.removeFile ?? defaultRemoveFile)(path).catch(() => {})`) — the smoke compile already returned its verdict; a cleanup failure on the scratch file is non-fatal and absence is the success state. Same posture as session/store.ts.",
      "runner/batch/eval/patch-static-sanity.ts":
        "`finally`-block best-effort temp-payload cleanup (`rm(payloadPath, { force: true }).catch(() => {})`) — the sanity result is already resolved; a cleanup failure on the scratch payload is non-fatal and absence is the success state. Same posture as memory/dream/team-write-target.ts.",
      "runner/batch/corpus/dataset.ts":
        "Bare-mirror clone tmp cleanup (2 sites) — on a failed `git clone --bare` or a failed `rename(tmp, mirror)`, the `${mirror}.tmp-<uuid>` dir is removed best-effort and the REAL clone/rename error is then RETHROWN (or, when another instance already published the mirror, that one is adopted). A cleanup failure is non-fatal and absence is the success state. Same posture as memory/dream/team-write-target.ts.",
    },
  },
  {
    id: "no-jailed-path-cast",
    pattern: /\bas\s+JailedPath\b/,
    why: "`JailedPath` is brand-typed; the only legitimate constructor is `resolveJailed` in storage/service.ts.",
    allowlist: {
      "storage/service.ts": "the storage seam IS the canonical constructor",
    },
  },
  {
    id: "no-log-level-cast",
    pattern: /\bas\s+LogLevel\b/,
    why: "`as LogLevel` on raw input lets `undefined` flow through `ORDER[...]` and silently drop every log. Use the validator in `runtime-config.ts`.",
    allowlist: {
      "shared/runtime-config.ts":
        "the validator narrows after checking the value is in LOG_LEVEL_SET",
    },
  },
  {
    id: "no-error-message-includes-routing",
    // `e.message.includes(` / `error.message.includes(` / `msg.includes(` —
    // pattern most often used for retry/fallback policy. The fix is to read
    // `LLMError.kind` / `statusCode` instead. Allow `e.message` access for
    // log formatting (most common); this catches the `.includes(` form only.
    pattern: /\b\w*[Mm]essage\.toLowerCase\(\)?\.includes\(|\.\bmessage\.includes\(/,
    why: "Don't route on `e.message.includes(...)` — set `LLMError.kind` at the adapter boundary and branch on the structured field. See `src/shared/errors.ts`.",
    allowlist: {
      "retrieval/lexical/ripgrep-impl.ts":
        "NOT LLM routing — `isENOENT` checks the structured `rec.code === 'ENOENT'` FIRST; the message-substring is only a belt-and-suspenders fallback for spawn errors that omit `.code`. Orthogonal to the LLMError.kind retry/fallback path this rule guards.",
      "memory/auto-trigger/default-trigger.ts":
        "NOT LLM routing — `isAbortError` checks the structured `e.name === 'AbortError'` FIRST; the message-substring is the standard DOM-abort fallback for runtimes that don't set `.name`. Orthogonal to the LLMError.kind path.",
    },
  },
  {
    id: "no-string-error-text-classification",
    // Text-classification of a STRINGIFIED error — evades the
    // `.message.includes(` ban above by flattening the whole error first
    // (jun-10 silent-failure audit R4, finding #23: lsp-bridge regex-tested
    // String(e) instead of branching on `LspRequestError.code`). This pattern
    // catches the CLASS, not just the two seed shapes:
    //   - `String(<err>).<search>(`  where <search> ∈ includes / match /
    //     search / indexOf / startsWith / endsWith / split / exec
    //   - `/re/.test(String(<err>))`
    //   - template coercion: `` `${<err>}`.<search>( ``
    //   - concat coercion:   `("" + <err>).<search>(`
    // <err> is scoped to error-typed idents (e | err | error | caught | ex |
    // reason | cause), optionally with a member access (`String(e.message)`),
    // so legit `String(count).includes(…)` on a non-error stays clean. The fix
    // for any match is to branch on the typed field — for the common cases a
    // typed form exists (`e instanceof LspRequestError && e.code === …`,
    // `LLMError.kind`/`statusCode`).
    // The member arm is `(?:\.(?:message|stack|toString\(\)))?` — the WHOLE-error
    // TEXT forms (bare `String(e)` / `String(e.message)` / `String(e.stack)`).
    // It deliberately does NOT match a typed SCALAR field read like
    // `String(e.code).startsWith("E")` / `String(e.status)` — that IS the typed
    // branching the rule recommends (rounds-2/3 audit: the old `(?:\.\w+)*` arm
    // over-corrected, redding the very fix it advises).
    pattern:
      /String\(\s*(?:e|err|error|caught|ex|reason|cause)(?:\.(?:message|stack|toString\(\)))?\s*\)\.(?:includes|match|search|indexOf|startsWith|endsWith|split|exec)\(|\.test\(\s*String\(\s*(?:e|err|error|caught|ex|reason|cause)(?:\.(?:message|stack|toString\(\)))?\s*\)\s*\)|`\$\{\s*(?:e|err|error|caught|ex|reason|cause)(?:\.(?:message|stack|toString\(\)))?\s*\}`\.(?:includes|match|search|indexOf|startsWith|endsWith|split|exec)\(|\(\s*""\s*\+\s*(?:e|err|error|caught|ex|reason|cause)(?:\.(?:message|stack|toString\(\)))?\s*\)\.(?:includes|match|search|indexOf|startsWith|endsWith|split|exec)\(/,
    why: "Don't classify errors by stringified text — branch on the typed field instead (`e instanceof LspRequestError && e.code === …`, `LLMError.kind`/`statusCode`). Same contract as the `.message.includes(` ban.",
  },
  {
    id: "no-undocumented-magic-timeout",
    // Standalone literal that isn't on the right-hand side of a
    // `UPPER_SNAKE_CASE` const declaration.
    pattern:
      /(?<!const\s+[A-Z][A-Z_0-9]*\s*=\s*)(?<![A-Z_0-9])(?:5_000|30_000|60_000|120_000|180_000|240_000)(?!\d)/,
    why: "Wall-clock magic numbers must be bound to a named UPPER_SNAKE_CASE `const` with a comment explaining the choice.",
    allowlist: {
      "agent/loop.ts": "documented session-tuning ladder lives here as inline named constants",
      "agent/compaction.ts": "DEFAULT_THRESHOLD ladder uses inline literals for the ladder",
      "lsp/adapters/base.ts":
        "LSP_REQUEST_TIMEOUT_MS et al. are declared as named consts elsewhere",
      "observability/metrics/instrument-tool-dedup.ts":
        "RECOMMENDED_PER_TOOL_TTL_MS (ADR-0179) — values are documented per-tool TTL policy in a frozen UPPER_SNAKE_CASE Record; comment header explains each choice.",
      "plugin-isolation/lifecycle.ts":
        "Plugin-lifecycle restart-window default (60s) — documented inline; matches platform supervisor convention for restart-budget windows.",
      "apps/cli/idle-monitor.ts":
        "Idle minutes→ms conversion (`n * 60_000`) — surface helper, not a wall-clock policy literal.",
      "apps/cli/repl/session-loop.ts":
        "Goal-pill elapsed ms→minutes conversion (`Math.floor(view.elapsedMs / 60_000)`) used only to build a minute-resolution dedup KEY for the surface chip — display unit conversion, not a wall-clock policy literal. Same posture as apps/cli/idle-monitor.ts / status-pills.ts.",
      "apps/cli/status-pills.ts":
        "`formatElapsed` ms→minutes conversion (`Math.floor(ms / 60_000)`) for the surface goal chip's `2h 7m` display — surface unit conversion, not a wall-clock policy literal. Same posture as apps/cli/idle-monitor.ts.",
      "apps/cli/web-cmd.ts":
        "Web-fetch abort timer default (60s) at CLI sub-command boundary — surface composition root.",
      "migration/persistence.ts":
        "FALSE POSITIVE — `DEFAULT_LOCK_STALE_MS = 5 * 60_000` IS a named UPPER_SNAKE_CASE const; the regex's negative-lookbehind only fires when the literal IMMEDIATELY follows `=`, so the arithmetic form trips it. The value is named + documented inline.",
      "connectors/token-refresh-scheduler.ts":
        "FALSE POSITIVE — `BACKOFF_MAX_MS = 5 * 60_000` IS a named UPPER_SNAKE_CASE const with a documented backoff rationale (lines 74-78); identical arithmetic-form false positive as migration/persistence.ts — the lookbehind only fires for a literal IMMEDIATELY after `=`.",
      "mcp/reconnect/policy.ts":
        "DEFAULT_BACKOFF_POLICY — every timing value is a field of a single named/frozen policy const with an inline comment tracing it to the Cursor source; same documented-inline posture as plugin-isolation/lifecycle.ts.",
      "browser/cdp-adapter.ts":
        "DEFAULT_WAIT_SELECTOR_MS — extracted named const (5s, CDP/Puppeteer selector-wait convention) documented inline.",
      "browser/cdp/cdp-session.ts":
        "DEFAULT_CDP_COMMAND_MS — extracted named const (30s CDP request default) documented inline.",
      "browser/headless-stub.ts":
        "DEFAULT_WAIT_SELECTOR_MS — extracted named const mirroring the real adapter's default so deterministic-stub fixtures stay byte-identical.",
      "tool/poll_deferred.ts":
        "Zod schema UPPER BOUND `.max(60_000)` on the user-supplied `awaitMs` — an input-validation ceiling, not a wall-clock policy literal the harness controls.",
      "apps/headless/fake-deps.ts":
        "Headless DEV/test fake-deps fixture (idleMs/snoozeDefaultMs) — fixture values for the fake runtime, not a production wall-clock policy.",
      "apps/bench/cli.ts":
        "Bench CLI minutes→ms conversions (`mins * 60_000`, `(Number(wallMin) || 0) * 60_000`) at the flag-parse boundary — surface unit conversion, not a wall-clock policy literal. Same posture as apps/cli/idle-monitor.ts.",
      "apps/bench/commands/shared.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — `positiveMinutesFlagMs` does a minutes→ms `mins * 60_000` conversion at the flag-parse boundary; surface unit conversion, not a wall-clock policy literal. Same posture as apps/bench/cli.ts.",
      "apps/bench/commands/pool.ts":
        "Extracted verbatim from apps/bench/cli.ts (already allowlisted) — the `pool` handler's `(Number(wallMin) || 0) * 60_000` minutes→ms conversion at the `--max-box-wall-min` flag boundary; surface unit conversion, not a wall-clock policy literal. Same posture as apps/bench/cli.ts.",
      "apps/bench/remote/fresh-auth.ts":
        "ms→minutes conversion for a LOG message (`Math.round(remaining / 60_000)` shows token-remaining minutes) — display unit conversion, not a wall-clock policy literal. Same posture as apps/cli/idle-monitor.ts.",
    },
  },
  {
    id: "no-locale-compare",
    // `.localeCompare(` — locale/ICU-dependent ordering.
    pattern: /\.localeCompare\(/,
    why: "localeCompare is locale/ICU-dependent → sorted output varies across machines, breaking the byte-identical replay + prompt-cache invariant. Use `byteCompare` from `src/shared/byte-compare.ts`.",
    // No allowlist: all src/ localeCompare call sites were migrated to
    // byteCompare (R6 structural). The whole class is now actively guarded —
    // a new localeCompare anywhere under src/ trips the scan.
  },
  {
    id: "no-raw-number-env",
    // `Number(... process.env ...)` / `parseInt(process.env...)` on one line.
    pattern: /(?:Number|parseInt|parseFloat)\s*\([^)]*process\.env/,
    why: "Parsing process.env with raw Number()/parseInt() yields NaN on garbage input, silently disabling caps/limits. Route through the validated parsers in `runtime-config.ts`. (Currently zero violations — keep it so.)",
  },
  {
    id: "no-date-now-in-domain",
    // `Date.now(` / `new Date(` inside domain layers (agent + permission).
    // Determinism: anything reaching the model-facing prompt or persisted/replayed
    // output must use an injected clock (`opts.now ?? Date.now`); telemetry
    // timestamps are infrastructure and excluded by scope.
    pattern: /\bDate\.now\(|\bnew Date\(/,
    scope: /^(agent|permission)\//,
    why: "Domain layers must inject the clock (`opts.now ?? Date.now`) so model-facing/persisted output is replay-stable. See `src/agent/admissibility-gate.ts` / `src/memory/consolidate/writer.ts` for the established pattern.",
    allowlist: {
      // BURN-DOWN — every entry below uses Date.now()/new Date() in a way
      // that currently reaches a deterministic-replay boundary (or is a default
      // factory the injection pattern delegates to). Each should migrate to
      // `(opts.now ?? Date.now)()` and drop from this allowlist.
      "agent/loop.ts": "BURN-DOWN: turnId/startedAt default clock (telemetry — lowest priority)",
      // jun-6 loop decomposition (`agent/loop.ts` split into `agent/loop/*`):
      // the telemetry/provenance timestamps + default-clock factories below were
      // RELOCATED verbatim from the monolithic `agent/loop.ts` (already
      // allowlisted above with the same telemetry rationale). None reach a
      // model-facing/persisted-replay boundary — they stamp turn-header
      // `startedAt`, compaction `at`/`ts`/`compactedAt` provenance, event
      // `atMs`, the control-poll deadline, and the `() => Date.now()` default
      // clock handed to the background-compaction summarizer.
      "agent/loop/turn-iteration.ts":
        "BURN-DOWN (loop-decomp relocation): turn-header `startedAt` default clock — telemetry, same as agent/loop.ts.",
      "agent/loop/compaction-wire.ts":
        "BURN-DOWN (loop-decomp relocation): compaction `at`/`ts` provenance stamps — telemetry, not model-facing replay.",
      "agent/loop/recovery-executor.ts":
        "BURN-DOWN (loop-decomp relocation): compaction `at`/`compactedAt` provenance stamps — telemetry, not model-facing replay.",
      "agent/loop/control-poll.ts":
        "BURN-DOWN (loop-decomp relocation): `Date.now()` is the steer-deadline arg to the control-poll handler — infra timing, not persisted/replayed.",
      "agent/loop/emit-helpers.ts":
        "BURN-DOWN (loop-decomp relocation): usage-event `atMs` telemetry stamp — not model-facing replay.",
      "agent/loop/session-bootstrap.ts":
        "BURN-DOWN (loop-decomp relocation): `() => Date.now()` default-clock factory handed to the bg-compaction summarizer — default-factory fallback.",
      "agent/memory-tools.ts":
        "BURN-DOWN: W6 injected clock+uuid; `Date.now` here is the default-factory fallback",
      "agent/prompt.ts":
        "BURN-DOWN: W6 injected `todayDateLine(now)`; the literal `new Date` is the default fallback",
      "agent/submission.ts": "BURN-DOWN: W6 injected; default-fallback path uses Date.now",
      "agent/budget-ledger.ts":
        "BURN-DOWN: human-readable Date formatting in error message — not model-facing replay",
      "agent/hooks.ts": "BURN-DOWN: hook-elapsed measurement for telemetry — not model-facing",
      "agent/memory/stage1-store/sqlite.ts":
        "BURN-DOWN: SQLite persisted-row timestamp; replay-stable via the store",
      "agent/repro-test/execute.ts":
        "BURN-DOWN: crypto fallback when randomUUID unavailable — last-resort token, not model-facing",
      "agent/subagent-persistence-store/jsonl-store.ts":
        "BURN-DOWN: JSONL persisted-row cutoff for log GC — replay-stable",
      "agent/run-ledger/store.ts":
        "BURN-DOWN: injected clock (`opts?.now ?? Date.now`); the literal `Date.now` is the default-factory + the `safeDateNow` last-resort fallback when the injected clock throws.",
      "agent/objective/store.ts":
        "BURN-DOWN: injected clock (`opts?.now ?? Date.now`); the literal `Date.now` is the default fallback inside `clockNow()`'s catch + the empty-cell default factory.",
      "agent/approval-state-machine/store.ts":
        "BURN-DOWN: injected clock (`opts?.now ?? Date.now`); the literal `Date.now` is the finite-guard default fallback.",
      "agent/subagent-mailbox/store.ts":
        "BURN-DOWN: injected clock; the literal `Date.now` is the finite-guard default + `sentAt` default-factory fallback.",
      "agent/compaction.ts":
        "BURN-DOWN: `compactedAt` provenance stamp on the recovery record — telemetry/provenance metadata, not model-facing replay text.",
      "agent/plugin-skill-extension/extender.ts":
        "BURN-DOWN: injected `opts?.at`; the literal `Date.now` is the default-factory fallback for the skill-activation timestamp.",
      "agent/loop/turn-loop.ts":
        "BURN-DOWN (ADR-0231 radar wire): `Date.now()` is the wall-clock sample for the radar proposal-queue producer hook (turn-duration telemetry). Captured ONLY when `cfg.radar` is wired (default-OFF); never reaches model-facing/persisted-replay output — same infra-timing posture as agent/loop/control-poll.ts.",
      "agent/lsp-bridge.ts":
        "INFRA TIMING (RFC jun-17): `Date.now()` in `ensurePyrightFileReady` is the language-server warm-up READINESS-POLL deadline (when to stop polling a cold pyright for an import resolve). Pure infra timing — never reaches model-facing/persisted/replayed output; the budget/retry are injectable for tests via `__setPyrightWarmupTimingForTest`. Same posture as agent/loop/control-poll.ts.",
      "agent/lsp-workspace-pool.ts":
        "INFRA TIMING (RFC jun-17 warm-backend): `Date.now()`/`elapsed()` measure the LSP grounding-receipt warm-up probe duration (`startedAt`/`elapsed`) for telemetry on the receipt — pure infra timing, never reaches model-facing/persisted/replayed output. Same posture as agent/lsp-bridge.ts.",
      "agent/lsp-bridge/warm-pool.ts":
        "INFRA TIMING (RFC jun-17, god-module split of agent/lsp-bridge.ts): `Date.now()` in `ensurePyrightFileReady` is the language-server warm-up READINESS-POLL deadline (`deadline`/`while (Date.now() < deadline)`) — when to stop polling a cold pyright for an import resolve. Pure infra timing against a REAL server clock; never reaches model-facing/persisted/replayed output. The budget/retry are injectable for tests via `pyrightWarmupTimingForTest` (`__setPyrightWarmupTimingForTest`). Same posture as agent/lsp-bridge.ts.",
      "agent/loop/stream-consume.ts":
        "INFRA TIMING (stream stall-detection): the 3 `Date.now()` samples in `teeUsage` (`startedAt`/`lastEventAt` + the final sample) measure REAL wall-clock gaps in the LIVE provider stream to infer a silent degrade — a fake clock cannot measure a real stream's silence. The pure/deterministic decision function `inferDegradeNotice(config, sawEvent, lastEventAt, startedAt, now)` is already injected (all timing is params); the emitted notice text uses the CONFIG thresholds (`policy.idleMs`/`policy.totalMs`), not the raw samples, so the emit is deterministic given a degrade. Never reaches persisted/replayed output. Same infra-timing posture as agent/loop/control-poll.ts.",
      "agent/observation/providers/lsp-enrich/provider.ts":
        "INFRA TIMING (jul-6 S3 lsp-enrich): `Date.now()` in `harvestAll` is the per-provider wall-clock time-budget deadline (`deadline = Date.now() + budget.maxMillis`; loop-break `Date.now() >= deadline`) bounding a real I/O loop against a real language server so a cold server can't stall the pre-prompt enrichment. Pure infra timing; the harvested owners/contracts are the output, the deadline only bounds WHEN to stop. Never reaches persisted/replayed output. Same warm-backend infra-timing posture as agent/lsp-workspace-pool.ts.",
      "agent/prompt-reminders.ts":
        "INJECTED CLOCK (default-factory fallback): `todayDateLine(now?: () => number)` implements the sanctioned `(now ?? Date.now)()` pattern — the model-facing today's-date line is deterministic when the caller passes `now` (the sole caller threads `input.now`; replay/tests pin it). The literal `Date.now`/`new Date` is ONLY the default fallback. Same injected-clock-with-default-fallback posture as agent/prompt.ts / agent/run-ledger/store.ts.",
    },
  },
  {
    id: "no-getDefaultPermissionStore-outside-composition",
    // `getDefaultPermissionStore(` — the singleton accessor. Use ONLY in
    // composition roots (apps/) and in the canonical re-export. Internal
    // code must accept `store: PermissionStore` from the caller.
    pattern: /\bgetDefaultPermissionStore\s*\(/,
    why: "Service-locator: the singleton store must be wired at the composition root (`src/apps/**`) — internal `@/permission` callers and the loop must accept an injected `PermissionStore`. The fallback creates hidden coupling and breaks test isolation.",
    allowlist: {
      "permission/permission-store.ts": "the canonical definition site",
      "permission/index.ts": "barrel re-export",
      "agent/admissibility-gate.ts":
        "composition-adjacent layer; transitional fallback when surfaces omit `AgentConfig.admissibility.permissionStore`. Remove once every app wires the nested store explicitly.",
      "agent/admissibility-gate/gates.ts":
        "God-module split of agent/admissibility-gate.ts — the `opts.store ?? getDefaultPermissionStore()` transitional fallback relocated verbatim into the composition-adjacent gates cluster (called by dispatch). Same posture + remove-when-fully-wired note as agent/admissibility-gate.ts.",
      "apps/cli/repl.ts":
        "CLI composition root — `loadPermissionStore` is EXACTLY where the rule says the singleton should be wired (`src/apps/**`); the store is then injected downstream via AgentConfig.",
    },
  },
  {
    id: "no-eager-defaultTools-outside-composition",
    // Importing/using the EAGER `defaultTools` singleton (module-load
    // `buildDefaultTools()`) — banned outside composition roots. Matches a bare
    // `defaultTools` token NOT preceded by `build` (so `buildDefaultTools` is
    // clean) and NOT a member access `.defaultTools` (unrelated properties stay
    // clean). ARCHITECTURE.md §3: composition roots must call
    // `buildDefaultTools(...)`; the eager singleton is kept ONLY for back-compat
    // + tests. A domain slice that reaches for it takes an ambient module-load
    // tool set instead of an injected one.
    pattern: /(?<![A-Za-z0-9_.])defaultTools\b/,
    why: "Don't import the eager `defaultTools` singleton in a domain slice — call `buildDefaultTools(...)` at the composition root (ARCHITECTURE.md §3). The singleton is back-compat/tests only.",
    allowlist: {
      "tool/index.ts":
        "THE definition site — `export const defaultTools = buildDefaultTools()` is the sanctioned back-compat singleton the rule protects (plus every JSDoc mention here is a comment the scanner skips).",
      "apps/cli/permission-explain.ts":
        "Composition root (`src/apps/**`) — the `/permission explain` command legitimately enumerates the back-compat default tool set to render the static permission table; same sanctioned-back-compat posture the rule allows under apps/.",
      "apps/cli/side-cmd.ts":
        "FALSE POSITIVE — `readonly defaultTools?: readonly string[]` is an interface PROPERTY NAME on the side-cmd context (a surface-resolved allowlist of tool NAMES), not the eager `@/tool` singleton; and it lives under the composition layer (`src/apps/**`).",
    },
  },
  {
    id: "no-raw-process-env-member-read-in-fixed-slices",
    // Ban RAW `process.env.<ident>` MEMBER reads in the retrieval / observability
    // / ui domain slices — those must accept an injected env seam
    // (`env: NodeJS.ProcessEnv = process.env`, reading `env.X`) so the global is
    // bound only at the call boundary and the unit is testable. This targets ONLY
    // the member-access form `process.env.QUANTA_X`; the sanctioned injection
    // idiom `= process.env` / `: process.env` (the default-parameter binding, the
    // pattern the fix INTRODUCES) is deliberately NOT matched. Seeded GREEN after
    // the FIX #5 edits (reranker/registry.ts, ui/ui-helpers.ts) removed the last
    // member reads; health-snapshot.ts never had one in code (comment only).
    // Matches BOTH the dot form `process.env.X` and the bracket form
    // `process.env["X"]` (a bracket-form regression would otherwise slip past,
    // and these files are exempt from the global `\bprocess\.env\b` rule so it is
    // no backstop); the binding form is never followed by `.`/`[` so stays clear.
    pattern: /process\.env\s*[.[]/,
    scope: /^(retrieval|observability|ui)\//,
    why: "Domain slices must inject the env seam (`env: NodeJS.ProcessEnv = process.env`, read `env.X`) instead of raw `process.env.<ident>` — bind the global only at the call boundary so the unit is testable. See src/retrieval/reranker/registry.ts / src/ui/ui-helpers.ts for the pattern.",
  },
]

const isAllowed = (rule: Rule, relativePath: string): boolean =>
  rule.allowlist !== undefined && Object.hasOwn(rule.allowlist, relativePath)

// Co-located test files live under `src/**/__tests__/` and `*.test.ts`. They
// exercise the banned patterns ON PURPOSE (e.g. saving/restoring `process.env`,
// asserting on magic-timeout fixtures) — exactly the same posture as the
// `tests/` tree the header says the scanner "intentionally does not look at".
// The contract is a PRODUCTION-code contract; excluding test sources keeps the
// scan honest without polluting every rule's allowlist with throwaway fixtures.
const isTestFile = (name: string): boolean => name.endsWith(".test.ts")

const walk = (dir: string): readonly string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walk(full))
    else if (extname(name) === ".ts" && !isTestFile(name)) out.push(full)
  }
  return out
}

interface Violation {
  rule: Rule
  lineNo: number
  line: string
}

const scanFile = (path: string): readonly Violation[] => {
  const text = readFileSync(path, "utf8")
  const lines = text.split("\n")
  const violations: Violation[] = []
  const relPath = relative(SRC, path)
  for (const rule of RULES) {
    if (isAllowed(rule, relPath)) continue
    // Scope: when set, only files whose `relPath` matches the regex are scanned
    // by this rule. Lets a rule target a single slice (e.g. domain layers)
    // without polluting its allowlist with every other slice's legitimate uses.
    if (rule.scope !== undefined && !rule.scope.test(relPath)) continue
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      const trimmed = line.trim()
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue
      if (rule.pattern.test(line)) {
        violations.push({ rule, lineNo: i + 1, line: trimmed })
      }
    }
  }
  return violations
}

describe("src/: anti-regression scan (root-cause invariants)", () => {
  const files = walk(SRC)

  test("every TS file scans clean against the lazy-pattern allowlist", () => {
    const failures: string[] = []
    for (const f of files) {
      const v = scanFile(f)
      for (const { rule, lineNo, line } of v) {
        failures.push(`${relative(SRC, f)}:${lineNo}  [${rule.id}]  ${line}\n    → ${rule.why}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Anti-regression scan tripped ${failures.length} violation(s) under src/:\n\n${failures.join("\n\n")}`,
      )
    }
    expect(failures.length).toBe(0)
    // Walks ~2200 src files + cold module transpile — the 5s default trips on a
    // cold run (measured ~9.6s cold, ~1s warm). 30s gives ample headroom so the
    // ratchet never flakes under full-suite load.
  }, 30_000)

  test("scan covers a non-empty file set (smoke)", () => {
    expect(files.length).toBeGreaterThan(80)
  }, 30_000)
})

// D4 (jun-10 audit R4 broaden) — the `no-string-error-text-classification`
// rule must catch the CLASS of stringified-error text classification, not just
// the two seed shapes. We exercise the rule's pattern directly against fixtures
// (the scanner trims+skips comment lines, so we test the raw regex teeth here).
describe("no-string-error-text-classification: bypass-class coverage", () => {
  const rule = RULES.find((r) => r.id === "no-string-error-text-classification")
  const re = (): RegExp => {
    if (rule === undefined) throw new Error("rule not found")
    // Fresh regex each call — the source pattern is global-flag-free here, but
    // re-instantiating avoids any lastIndex statefulness across assertions.
    return new RegExp(rule.pattern.source, rule.pattern.flags)
  }

  test("the exact original seed shapes still trip", () => {
    expect(re().test('if (String(e).includes("timeout")) retry()')).toBe(true)
    expect(re().test("const m = String(err).match(/429/)")).toBe(true)
    expect(re().test("if (/ENOENT/.test(String(error))) ignore()")).toBe(true)
  })

  test("the 4 broadened bypass forms each trip", () => {
    // Form 1: String(<err>).<other-search-method>( — beyond includes/match.
    expect(re().test('if (String(e).search("rate") >= 0) retry()')).toBe(true)
    expect(re().test('String(reason).startsWith("E")')).toBe(true)
    expect(re().test('String(caught).indexOf("abort")')).toBe(true)
    expect(re().test('String(ex).split(":")')).toBe(true)
    expect(re().test('String(e.message).endsWith("timeout")')).toBe(true)
    // Form 2: /re/.test(String(<err>)) (already a seed, but with a wider ident).
    expect(re().test("if (/429/.test(String(cause))) backoff()")).toBe(true)
    // Form 3: template-literal coercion `${e}`.includes(
    expect(re().test('if (`${e}`.includes("rate limit")) retry()')).toBe(true)
    expect(re().test("`${err.message}`.match(/ETIMEDOUT/)")).toBe(true)
    // Form 4: concat coercion ("" + e).includes(
    expect(re().test('if (("" + e).includes("aborted")) stop()')).toBe(true)
  })

  test("negative paired control: String(<non-error>).includes stays clean", () => {
    // The whole point of scoping to error-typed idents: a legit stringify of a
    // number/length/non-error must NOT trip.
    expect(re().test('String(count).includes("3")')).toBe(false)
    expect(re().test('String(n).startsWith("1")')).toBe(false)
    expect(re().test('String(items.length).includes("0")')).toBe(false)
    // Plain stringify with no search method is fine (e.g. log formatting).
    expect(re().test("logger.warn(String(e))")).toBe(false)
    expect(re().test("const s = String(e)")).toBe(false)
  })

  test("negative control: stringifying a TYPED SCALAR field is the recommended fix, not a violation", () => {
    // rounds-2/3 audit: the old `(?:\.\w+)*` member arm over-corrected — it
    // redded `String(e.code).startsWith(…)`, which is exactly the typed-field
    // branching the rule's `why` advises. A scalar field read (.code/.status/
    // .errno) stringified for comparison must stay CLEAN; only the whole-error
    // TEXT forms (bare / .message / .stack) are the classification smell.
    expect(re().test('String(err.code).startsWith("E")')).toBe(false)
    expect(re().test('String(error.status).includes("4")')).toBe(false)
    expect(re().test('String(e.errno).indexOf("13")')).toBe(false)
    // ...but the whole-error TEXT forms still trip (teeth retained).
    expect(re().test('String(e.message).includes("timeout")')).toBe(true)
    expect(re().test('String(err.stack).split("\\n")')).toBe(true)
  })
})
