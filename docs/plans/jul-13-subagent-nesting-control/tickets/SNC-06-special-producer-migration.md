# SNC-06 — migrate direct and special descendant producers

**Priority:** P0
**Depends on:** SNC-04
**Parallelizable:** yes, with SNC-05 and SNC-09 on disjoint files

## Objective

Close every descendant path that bypasses or wraps the standard foreground runner.

## Owned surfaces

- `src/agent/branch-search-runner.ts`
- `src/agent/subagent-background.ts` and `src/agent/subagent-background/**`
- `src/agent/subagent-typed/delegation-router.ts`
- `src/agent/tier1/delegate.ts`
- `src/agent/tier1/reviewer-subagent.ts`, `src/agent/reviewer-port.ts`
- `src/tool/git/review-diff.ts`
- `src/agent/side-agent-runner.ts`, `src/side-agent/worker-charter-runner.ts`

## Required changes

1. `branch_search`: authorize each candidate before isolation and call descendant entry; cap `0` starts zero candidates.
2. background/`subagent_fork`: scheduler carries source/parent authority, not a hardcoded depth.
3. delegate: remove caller `parentDepth + 1`; wrapper passes source and parent lineage.
4. reviewer/guardian/`git_review_diff`: use the same admission with distinct source tags.
5. side-agent child paths use grants; genuine standalone roots use root grants.
6. Remove all temporary direct-child allowlist entries from SNC-04.

## Acceptance

```sh
bun test tests/unit/branch-search-tool.test.ts tests/unit/branch-search.test.ts
bun test tests/integration/git-review-diff-e2e.test.ts
bun test tests/unit/agent/reviewer-subagent.test.ts tests/unit/guardian-assessor-subagent-hellgate.test.ts
bun test tests/unit/subagent-background-depth-hellgate.test.ts tests/integration/subagent-cancellation-e2e.test.ts
bun test tests/integration/side-agent-process-llm-charter-e2e.test.ts
bun test tests/unit/agent-run-authority-fence-hellgate.test.ts
bun run typecheck
```

## Stop rule

Stop if an internal producer is exempted because it is not model-visible. Runtime admission applies regardless of projection.

