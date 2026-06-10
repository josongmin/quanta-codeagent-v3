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
      "apps/bench/eval/driver.ts":
        "LSP-nav opt-in probe (`QUANTA_LSP_TOOLS=full`) — same gate as CLI; tools register harmlessly without a server. Same posture as the bench CLI's env reads.",
      "runner/batch/eval/driver.ts":
        "Extracted batch core keeps the same bench-only opt-in env gates (`QUANTA_BENCH_*`) while the app surface becomes thin. Same posture as the prior apps/bench/eval/driver.ts entry; follow-up work can move these dials behind typed config.",
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
    },
  },
  {
    id: "no-math-random",
    pattern: /Math\.random\(/,
    why: "Use `node:crypto.randomBytes`/`randomUUID` — Math.random's collision space is too small under parallel runs.",
    allowlist: {
      "agent/retry.ts": "documented non-security jitter; centralized helper, no cross-use",
      "runner/orchestrate/side-chat.ts":
        "non-security side-chat nonce for in-process turn correlation — not used for collision resistance.",
      "host/runtime/internal/context-binding.ts":
        "mintSideConversationSessionId — non-security side-conversation id for in-process turn correlation; identical posture to runner/orchestrate/side-chat.ts, not used for collision resistance.",
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
    // `String(e).includes(` / `String(err).match(` / `/re/.test(String(error))`
    // — text-classification of a STRINGIFIED error. Evades the
    // `.message.includes(` ban above by flattening the whole error first
    // (jun-10 silent-failure audit R4, finding #23: lsp-bridge regex-tested
    // String(e) instead of branching on `LspRequestError.code`). Zero
    // tolerance: a typed form always exists.
    pattern: /\.test\(String\((?:e|err|error)\)\)|String\((?:e|err|error)\)\.(?:includes|match)\(/,
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
      "apps/cli/repl.ts":
        "CLI composition root — `loadPermissionStore` is EXACTLY where the rule says the singleton should be wired (`src/apps/**`); the store is then injected downstream via AgentConfig.",
    },
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
