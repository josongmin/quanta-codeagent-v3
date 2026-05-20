# ADR-0015 — Codex Foundation: TurnContext expansion + repo-local rule ingestion

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 0

## Context

RFC §1.2 commits the project to ROI-agnostic SOTA++ absorption. The Codex
agent analysis (`/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/`)
documents a much richer **operating contract** than our v3 ReAct loop currently
exposes:

- A 9-layer policy stack (system / developer / app / permission / mode /
  repo-local / skill / user / working-state) with explicit activation timing.
- A typed turn-context interface that names every per-turn injection: tool
  schemas, app capabilities, mode, session metadata, repo rules, memory.
- Repo-local rules (`AGENTS.md`, `CLAUDE.md`) as **authority**, not
  decoration — Codex `repo-local-rule-ingestion-audit.md`.

Our `prepareTurnContext` (`src/agent/loop.ts`) had no seam for repo-local
rules and no typed mode field — `planMode: boolean` was the only mode
representation, so review/audit task postures (Phase 3) had nowhere to land.

## Decision

Phase 0 creates the structural seams the rest of the absorption rides on:

1. **`AgentMode`** enum (`"default" | "plan" | "review" | "audit"`) exported
   from `src/agent/prompt.ts`. `planMode: boolean` stays as a backward-compat
   alias; `mode` wins when both are set.
2. **`RepoRules`** type + **`loadRepoRules(cwd)`** loader in
   `src/agent/repo-rules.ts`. Priority order is part of the contract:
   `AGENTS.md` → `CLAUDE.md` → `.codex/CODEX-RULES.md`. First non-empty file
   wins; secondaries are intentionally NOT merged (no silent dual-truth).
3. **`TurnContextInput`** extended with `mode`, `repoRules`. The per-turn
   reminder renders `repo-local rules` ABOVE memory hints (Codex trust
   ladder: repo-local is authority, memory is routing hint).
4. **`AgentConfig`** extended with `mode?: AgentMode`, `repoRules?: RepoRules`.
   Both default-OFF so existing callers (bench, dev apps) are
   byte-for-byte identical.

The loader is **explicitly opt-in** — `runAgent` does NOT auto-read
`AGENTS.md` from `cwd`. Callers that want repo-local ingestion call
`loadRepoRules(cwd)` and attach. Bench sandboxes, agent forks, and other
contexts that should NOT adopt workspace rules simply skip the call.

## Mechanism

Reminder injection order (top → bottom in the `<system-reminder>` block):

```
Today's date is …
Working directory: …
[mode notice]              ← plan / review / audit (default omits)
[repo-local rules]         ← if config.repoRules attached (authority)
[active skills]            ← Phase 7 addition
[working state]            ← Phase 6 addition
[memory hints]             ← labelled "routing hints only — not proof" (Phase 6)
```

The order encodes Codex's trust ladder structurally: authority (repo rules)
precedes posture (active skills) precedes state (working) precedes hint
(memory). Memory hints sit at the bottom because they are the WEAKEST
evidence class. This is the order pinned by
[tests/integration/sota-codex-full.test.ts](../../tests/integration/sota-codex-full.test.ts)
and `tests/unit/skill-trigger-rules.test.ts`.

## Consequences

- **Bench / SWE-bench**: callers do NOT load repo rules (the workspace under
  test is a Django/Flask/etc. repo whose `CONTRIBUTING.md`-style files would
  pollute the agent's posture). Byte-identical to pre-Phase-0.
- **Developer CLI**: future callers can `await loadRepoRules(cwd)` and pass
  the result on `AgentConfig` to pick up project policy.
- **Phase 3** (mode system) re-uses the new `mode` field to gate
  review/audit mutating-tool blocks at dispatch.
- **Phase 6** (memory 5-layer) re-uses the `TurnContextInput` slot pattern to
  add `workingState`.
- **Phase 7** (skill triggers) re-uses the same slot pattern to add
  `activeSkills`.

## Deferred

- **Activation timing lifecycle hooks** (Codex `prompt-and-policy-stack.md §3`
  — `before-first-action / before-tool-selection / after-observation`) are
  NOT shipped in Phase 0. The structural seams (block layering above) are
  ready, but the lifecycle-phase enum and per-phase layer routing are
  intentionally deferred to a future ADR — the current code activates all
  applicable layers at `prepareTurnContext` time, which is sufficient for
  every absorption that landed in Phases 1–8.

## Tests

- `tests/unit/repo-rules.test.ts` — loader priority, empty-file fallthrough,
  rendering with entrypoint citation.
- `tests/unit/prompt.test.ts` — repoRules block ordering (above memory),
  mode notice variants, byte-identical cache prefix.

## References

- Codex `may-20-codex-agent-loop.md` §3 (trust ladder), §6 (continuity
  boundary).
- Codex `turn-context-and-runtime-interface.md` §6 (TurnContext schema).
- Codex `repo-local-rule-ingestion-audit.md`.
