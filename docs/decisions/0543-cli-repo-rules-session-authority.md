# ADR-0543 — One repo-rules authority per session: the shipping CLI's model wire and `/rules` read the same snapshot

Status: Accepted (2026-08-24)
Slice: `src/host/bootstrap/bootstrap-session/session-state-ports.ts` · `src/host/bootstrap/bootstrap-session.ts` · `src/host/runtime/internal/context-binding/base.ts` · `src/apps/cli/rule-indicator.ts` · `src/apps/cli/rules-cmd.ts`
Feature: `cli-repo-rules-session-authority` (feature-catalog §10-app)
Related: `slash-rules-indicator` · `repo-rules-tree` · `MODE_REPO_RULES_POLICY` (`src/agent/run-mode/repo-rules-policy.ts`, the trust SSOT)

## Context

`AgentConfig.repoRules` was fully wired **downstream**: `context-assembler.ts` forwards it and `prompt.ts` renders it into the cached `project_md` system section. Five mode presets populated it (`interactive`, `headless`, `ide`, `daemon`, `ci-bot`), as did the web daemon.

The shipping CLI uses none of them. `src/apps/cli/index.ts` calls `runRepl()`, which composes its own runtime through `bootstrapSession`, and nothing in `src/apps/cli/**` or `src/host/bootstrap/**` ever resolved repo rules. A repo's `AGENTS.md` reached the model on bench and on web — but not on the surface a human actually drives.

Worse than a missing feature, it was a **split** between two things a user reasonably assumes agree:

- `/rules` (`rule-indicator.ts`) called `loadRepoRules` itself and listed the repo's `AGENTS.md`, so the CLI *said* the file was in scope;
- the system prompt the model received never carried it.

The surface claimed a rule was active while the model never saw it. That is the worst shape of untruth an agent surface can have, because the user writes the rules and then watches the CLI confirm they loaded.

## Decision

**One authority per session, not a second loader.**

`buildPromptState` resolves the rules once (`resolveBootstrapRepoRules`) and returns them alongside the system prompt — which is where they belong, since `prompt.ts` renders them into a system section. `bootstrapSession` carries the snapshot on `SessionBootstrapResult.repoRules`; `buildBaseFromBootstrap` lifts it onto the base, so the per-turn `AgentConfig` carries it; and the **same** snapshot is threaded to the `/rules` slash context.

`buildRuleInventory` prefers the snapshot and falls back to its legacy self-read only when no session supplied one, so callers with no session stay byte-identical.

Two independent disk reads could disagree the moment a file changed mid-session. One snapshot cannot.

**Security.** The resolve is gated on `modeLoadsRepoRules` — the surface-agnostic SSOT the presets and the web daemon already gate on — so the CLI cannot drift from the trust classification. Defanging of a forged `<system-reminder>` boundary inside a rule file is inherited from `buildSystemSections` and is pinned on the live path.

**Fail-open, but attributed.** An unreadable rule source must never break session start; the failure is logged with the cwd rather than swallowed, because an operator who wrote `AGENTS.md` deserves to know it was not loaded instead of wondering why the model ignores it.

## Consequences

- A hell-audit lesson worth keeping: the first cut of the hellgate passed while two of the four links were dead, because it hand-assembled the `AgentConfig` and hand-built the slash ctx. Wiring proofs must drive the **shipping** builders (`buildBaseFromBootstrap`, `buildSurfaceSlashContext`), not equivalents.
- Residual (display-only): `repoRulesToSources` still stats the file for its byte-size column, so the **size** shown by `/rules` is read from disk even when the content authority is the snapshot.
