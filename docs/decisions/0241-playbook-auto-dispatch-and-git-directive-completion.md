# ADR-0241: Playbook auto-dispatch + Git directive completion (5 directive kinds wired)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Renumbered**: from initially-drafted ADR-0240 (collision with W4-D's `0240-loop-trio-integration*.md`). Per `adr-collision-policy-2026-05-25` next-free 0241.
- **Related ADRs**: ADR-0203 (playbook frontmatter — provides watcher + frontmatter shape), ADR-0228 (plan-queue per-msg mutators — provides `enqueue` target), ADR-0221 (git directive emit protocol — 5-kind closed enum), ADR-0232 (git directive turn-collector wire — provides collector + `_directive-publish.ts` helper that this ADR completes by adding 3 more hook sites)
- **References**:
  - `src/skill/playbook/auto-dispatch.ts` (dispatchPlaybook canonical sink + startPlaybookAutoDispatch orchestrator)
  - `src/skill/playbook/index.ts` (barrel re-exports)
  - `src/tool/git/_directive-publish.ts` (shared publish helper — reused for 3 new sites)
  - 3 new hook sites in `src/tool/git/` (stage / push / pr-create) emitting via collector → emitter
  - `tests/integration/playbook-inline-trigger-dispatch-hellgate.test.ts` (cases on disk)
  - `tests/unit/git-directive-stage-push-pr-hooks-hellgate.test.ts` (cases on disk)

## Context

ADR-0203 shipped playbook frontmatter parser + inline-trigger-watcher port but no dispatcher: a saved-file `// fix QUANTA!` comment was detected but the `onFire` callback was caller-supplied and unwired — nothing actually triggered. Symmetrically, ADR-0232 shipped the per-turn git-directive collector + 2 hook sites (commit / create-branch) but the remaining 3 directive kinds in the ADR-0221 closed enum (`stage` / `push` / `create-pr`) had no emit sites — collector never received them.

## Decision

### A. Playbook canonical dispatcher (`src/skill/playbook/auto-dispatch.ts`)
- `dispatchPlaybook({ playbookName, sourceFile, comment, planQueueSink })` — resolves trigger to a `/play <name>` follow-up, calls `planQueueSink.enqueue` with `source="inline_trigger"` + metadata `{ path, line, marker }`
- `startPlaybookAutoDispatch(cfg)` — orchestrator that wires `cfg.playbookTrigger.watcher` to the dispatcher; returns a controller for stop/observe
- Sink-optional: when `planQueueSink` is absent, fires are still resolved + counted (observable via controller); `/play` follow-up is NOT enqueued (graceful degradation)
- NO-THROW public surface: malformed registry / sink rejection surfaces as typed `DispatchResult`, never an exception
- Slice posture: leaf-only — imports `./port` (watcher fire type) + `./types` (frontmatter shape) ONLY. Composition root adapts `PlanQueueStore.enqueue` to the structural `PlaybookPlanQueueSink` shape.

### B. Git directive 3 remaining hook sites
Each completed git mutation (`stage` / `push` / `pr-create`) calls `publishGitDirective(directive, { collector })` exactly once on success path. Collector batches per turn; turn end → emitter.emit(d, { phase: "final-answer" }) for each.

Directive shapes per ADR-0221 closed enum:
- `{ kind: "stage", files: string[] }` — emitted after successful staging tool returns
- `{ kind: "push", ref: string, force: boolean }` — emitted after successful push, `force` derived from `--force` / `--force-with-lease` flag
- `{ kind: "create-pr", url: string, isDraft: boolean }` — emitted after `gh pr create` skill, `url` from gh API response, `isDraft` from `--draft` flag

## Hellgate

- `playbook-inline-trigger-dispatch-hellgate.test.ts` — 감지→dispatch flow, disabled→noop, debounce 동작, 여러 trigger 동시, glob 매칭, planQueueSink 부재 graceful
- `git-directive-stage-push-pr-hooks-hellgate.test.ts` — stage 성공 emit, push --force emit force=true, pr create --draft emit isDraft=true, 실패 시 emit 안 함, collector 부재 시 tool 정상 동작, 5 kind 통합 flow

Combined with W4-D batteries: 61 pass / 221 expects / 0 fail across 5 integration files.

## Configurable knobs

- `AgentConfig.playbookTrigger.enabled?: boolean` — default `false` (opt-in)
- `AgentConfig.playbookTrigger.watchGlobs?: string[]` — default `["**/*.{ts,py,js,md}"]`
- `AgentConfig.playbookTrigger.debounceMs?: number` — default 200
- Git directive emission reuses ADR-0232's `gitDirectiveEmit.enabled` knob (default false). Collector absent → all 5 hook sites are graceful noops.

## Default-OFF invariants

- `playbookTrigger.enabled !== true` → orchestrator returns immediately, watcher never starts, no comment detection
- `collector === undefined` at hook sites → 1-line publish call is graceful noop, git tools behave byte-identically to pre-wire state
- Closes the ADR-0221 5-kind enum: all directive kinds now have at least one wired emit site in production paths

## Consequences

- ADR-0203's "inline trigger as observable but unwired" gap is closed; playbooks become a first-class trigger model
- ADR-0221's 5-kind enum is now production-callable end-to-end (collector → emit → host parser)
- Future directive kinds (e.g. `tag`, `stash-pop`) follow the same pattern: 1 hook site + 1 collector call
- Auto-dispatch pattern (saved-file comment → enqueued follow-up) becomes precedent for future Aider-AI!-style triggers
