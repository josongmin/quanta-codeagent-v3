# Repo Map

## Overview

This repository is a large TypeScript/Bun codebase for **Quanta CodeAgent v3**. The main product code lives under `src/`, with substantial architecture and design history under `docs/decisions/`.

At a high level, the repo combines:
- CLI app surfaces
- runner/orchestration layers
- session persistence and recovery
- permission/policy enforcement
- subagent and side-agent execution
- MCP protocol support
- skills and playbooks
- retrieval/search infrastructure
- realtime/voice/browser integrations
- security, storage, workflow, and observability infrastructure

## Top-level structure

- `src/` — main application and library source
- `docs/decisions/` — architecture decision records and implementation-history docs
- `docs/bugbash/` — audit and bug-bash findings
- `rfc/` — top-level architecture RFCs
- `scripts/` — utility scripts
- `tests/` — eval and smoke tests
- `package.json` — Bun scripts and package metadata
- `tsconfig*.json` — TypeScript configs
- `bunfig.toml` — Bun/test configuration
- `AGENTS.md` — repo-local agent rules

## Main source map

### `src/apps/cli/`
Primary CLI surface and interactive UX.

Key areas:
- `index.ts` — CLI entrypoint
- `repl.ts` — REPL loop
- `help-render.ts`, `status-line.ts`, `status-pills.ts` — terminal UX rendering
- `plan-panel.ts`, `timeline-panel.ts`, `working-state-panel.ts` — status and planning panels
- `login-cmd.ts`, `logout-cmd.ts` — auth commands
- `session-cmd.ts`, `resume.ts`, `rewind-conv-cmd.ts` — session lifecycle commands
- `mcp-cmd.ts`, `remote-cmd.ts`, `voice-cmd.ts`, `web-cmd.ts` — domain-specific commands
- `slash/` — slash command registry/rendering
- `attach/` — attach-mode helpers and rendering
- `__tests__/` — CLI hellgate/e2e tests

### `src/apps/eval/`
Evaluation harnesses and comparison/reporting flows.

Subareas:
- `grounding/` — grounding harness and diagnostics
- `compare/` — comparison adapters and judging
- `report/` — report generation
- `storage/` — result storage

### `src/apps/probe/`
Probe and triage tooling.

### `src/runner/assemble/`
Runtime assembly and dependency composition.

Notable files:
- `pipeline.ts`
- `tooling.ts`
- `verify.ts`
- `memory.ts`, `memory-factory.ts`
- `search-pipeline.ts`
- `repo-map-scan.ts`
- `subagent.ts`
- `streaming.ts`

### `src/runner/orchestrate/`
Turn execution and resume/orchestration flows.

Notable files:
- `run-once.ts`
- `session-turn-driver.ts`
- `resume-fsm.ts`
- `persist-turn.ts`

### `src/runner/knobs/`
Knob parsing, persistence, presets, and validation.

### `src/runner/batch/`
Batch execution, observation, and reporting.

### `src/session/`
Session storage, import/export, rewind, and crash recovery.

Notable files:
- `store.ts`
- `index-store.ts`
- `crash-resume.ts`
- `import-export.ts`, `import-export-fs.ts`
- `rewind.ts`
- `git-fingerprint.ts`
- `why-explainer.ts`

### `src/kernel/session/`
Lower-level event-log, reducer, replay, scheduler, and state machinery.

### `src/subagent/`
Subagent registry, tooling, dispatch, handlers, and turn gating.

Notable files:
- `agent-tool.ts`
- `dispatch-6.ts`
- `handlers-6.ts`
- `registry.ts`
- `task-tools.ts`
- `turn-gate.ts`

### `src/subagent/coordination/`
Multi-agent coordination helpers such as broker, DAG gating, and idle barriers.

### `src/side-agent/`
Separate process-based side-agent runtime.

### `src/permission/`
Permission, policy, review, and enforcement layer.

Notable files:
- `policy.ts`, `policy-rules.ts`
- `pdp.ts`
- `classifier.ts`
- `inspector.ts`
- `permission-profile.ts`
- `profile-inheritance.ts`
- `remember-patterns.ts`
- `post-denial.ts`
- `git-write-guard.ts`
- `two-layer-manager.ts`

### `src/skill/`
Skill discovery, activation, registry, plugin loading, and tool exposure.

Notable files:
- `registry.ts`
- `discover.ts`
- `activation.ts`
- `plugin-loader.ts`
- `plugin-manifest.ts`
- `skill-tool.ts`
- `tool-search.ts`

### `src/skill/playbook/`
Procedural playbook execution and validation.

Subareas include:
- `nesting/`
- `plan-writeback/`
- `spec-to-test/`
- `template-literal/`

### `src/tool/`
General tool wrappers and utility tools.

### `src/tool/git/`
Git-focused tool family.

Notable files:
- `status.ts`
- `diff.ts`
- `log.ts`
- `blame.ts`
- `commit.ts`
- `push.ts`
- `review-diff.ts`
- `conflict-inspect.ts`
- `branch-switch.ts`

### `src/tool/debug/`
CDP/DAP-based debugging tools.

### `src/tool/mcp_tasks/`
Long-running MCP task inspection/control.

### `src/mcp/`
MCP client/server implementation and protocol wiring.

Core files:
- `client.ts`
- `server.ts`
- `server-builder.ts`
- `jsonrpc.ts`
- `types.ts`

Major subareas:
- `elicitation/`
- `tasks/`
- `resources/`
- `capabilities/`
- `reconnect/`
- `sampling/`
- `oauth/`
- `transports/`

### `src/retrieval/` and `src/retrieval/indexer/`
Retrieval/query and indexing infrastructure.

Notable files:
- `hybrid-query.ts`
- `chunk-bucket.ts`
- `chunker.ts`
- `chunker-syntactic.ts`
- `default-scanner.ts`
- `delta-tracker.ts`

### `src/auth/` and `src/auth/chatgpt-oauth/`
Authentication, token lifecycle, and ChatGPT OAuth flow.

### `src/integrations/github/`
GitHub webhook, payload validation, PR context loading, and output sink integration.

### `src/realtime/` and `src/realtime/voice-session/`
Realtime transport and voice-session state handling.

### `src/voice/` and `src/voice/transcriber/`
Voice capture and transcription adapters.

### `src/browser/` and `src/browser/cdp/`
Browser automation and CDP integration.

### `src/remote/runner/`
Remote execution adapters such as Docker, Lima, and Apple VZ.

### `src/plugin-isolation/`
Plugin process isolation and plugin host/runtime.

### `src/security/`
Security primitives such as redaction and sensitivity classification.

Subareas:
- `secret-detection/`
- `pii-redaction/`
- `bridge-attest/`
- `jwks-identity/`

### `src/storage/` and `src/storage/shadow-odb/`
Storage services, atomic writes, fs jail support, and shadow ODB support.

### `src/patch/`
Patch parser and applier infrastructure.

### `src/observability/` and `src/observability/coverage/`
Metrics, pricing, shell exec telemetry, and coverage ingestion/merging.

### `src/workflow/`
Declarative workflow compile/execute/build layers.

### `src/rules/`
Rule parser/matcher/store infrastructure.

### `src/sdk/runtime/`
Runtime SDK/session/context surfaces.

## Documentation-heavy areas

### `docs/decisions/`
Very large ADR-style decision log covering topics like:
- LLM providers
- permission/HITL
- session persistence
- MCP
- subagents
- observability
- plugin isolation
- workflow
- realtime
- security

### `rfc/`
Top-level architecture docs:
- `0001-architecture.md`
- `0002-observability-trajectory-probe.md`
- `0003-eval-architecture.md`

## Testing layout

Observed test-heavy areas include:
- `src/apps/cli/__tests__/`
- `src/permission/__tests__/`
- `src/mcp/__tests__/`
- `src/kernel/session/__tests__/`
- `src/remote/runner/__tests__/`
- `tests/eval/retrieval/`
- `tests/smoke/swebench/`

## Good starting points for reading

If you want to understand the repository quickly, start here:
1. `README.md`
2. `rfc/0001-architecture.md`
3. `src/apps/cli/index.ts`
4. `src/apps/cli/repl.ts`
5. `src/runner/assemble/index.ts`
6. `src/runner/orchestrate/run-once.ts`
7. `src/permission/policy.ts`
8. `src/session/store.ts`
9. `src/subagent/agent-tool.ts`
10. `src/mcp/index.ts`
11. `src/skill/registry.ts`
12. `src/runner/assemble/repo-map-scan.ts`

## Repo character summary

This repository appears to be a large, architecture-heavy TypeScript agent platform that combines CLI interaction, orchestration, policy enforcement, multi-agent execution, protocol support, retrieval, and realtime integrations.
