# SNC-12 — cleanup, catalog rebuild, and gated default flip

**Priority:** P0
**Depends on:** SNC-05 through SNC-11
**Parallelizable:** no

## Objective

Remove legacy authority, prove the complete path matrix, then change the default from `3` to the RFC target `1` exactly once.

## Owned surfaces

- obsolete `src/agent/spawn-depth.ts` exports/callers
- legacy request-depth/config gates and compatibility allowlists
- `tools/feature-catalog/features/06-tier1/0150-subagent-spawn-depth-policy.yaml`
- generated `docs/10.feature-catalog.md` via `bun fc build`
- closeout tests/docs

## Entry gate

All prior ticket reports exist and their focused commands are current-green on the same HEAD. If any authority, persistence, resume, projection, or call-site inventory rail is red, do not flip the default.

## Required changes

1. Remove legacy `childDepthOf`/builder-gate dual owners and all temporary direct-call allowlists.
2. Remove `SubagentRequest.depth` diagnostic compatibility after mismatch telemetry shows no required consumer.
3. Set runtime-config, knob catalog, tests, and feature YAML default to `1` in one change.
4. Update the existing feature YAML; do not add a duplicate feature.
5. Run `bun fc build`; never hand-edit the generated catalog.
6. Mark RFC implementation status only after receipts are complete.

## Final proof matrix

```sh
bun test tests/unit/subagent-grant-admission-hellgate.test.ts
bun test tests/unit/agent-run-authority-fence-hellgate.test.ts
bun test tests/unit/subagent-central-projection-hellgate.test.ts
bun test tests/unit/subagent-persistence-v2-hellgate.test.ts
bun test tests/unit/subagent-resume-lineage-hellgate.test.ts
bun test tests/unit/subagent-spawn-telemetry-hellgate.test.ts
bun test tests/integration/subagent-fork-e2e.test.ts tests/integration/subagent-6tool-hell-e2e.test.ts
bun test tests/integration/git-review-diff-e2e.test.ts tests/integration/resume-e2e.test.ts
bun test tests/unit/god-code-ratchet.test.ts
bun run typecheck
bun run lint
bun fc validate
bun fc build
bun fc diff
bun fc check-evidence
```

## Definition of done

- live default is `1`; cap `0/1/2/3` matrix is green
- no unclassified descendant execution entry remains
- no legacy handle auto-resumes
- generated catalog has no drift
- `reports/SNC-12.md` links every prior receipt and separates any unrelated RED

## Stop rule

Any pre-flip RED blocks the default change. Do not split the default update across runtime config, catalog, and tests.

