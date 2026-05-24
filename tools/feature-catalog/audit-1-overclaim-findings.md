# Audit-1: Overclaim Verification Report

Date: 2026-05-24
Total overclaimed flagged by `fc judge`: 217
Sample audited: 80

## Verdict counts

- **appropriate-thin-not-overclaim**: 50
- **truly-overclaimed**: 24
- **missing-tests**: 5
- **mislabeled-wiring**: 1
- **mislabeled-monitoring**: 0
- **missing-evidence-code**: 0

## Findings (per-feature)

| feature-id | section | verdict | grep-evidence | recommendation |
|---|---|---|---|---|
| cfg-fourrule-true | s1 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| biome | s10 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| codemodcloseoutreminder | s2 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| fsjailerror | s3 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| cache-true | s4 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |
| durable-state-belongs-in-workspace-files | s5 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| agent | s6 | missing-tests | tests-on-disk-not-listed=tests/integration/agent-metrics-e2e.test.ts;tests/integration/agent-role-x-tool-policy-hell-e2e.test.ts | add to evidence.tests.unit |
| quantaprovider | s7 | mislabeled-wiring | paths→cli but ui_surfaces=n-a | add ui_surfaces:[cli] |
| permission-rules-fixture-corpus | s8 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| diagnostics | s9 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| safe | s1 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| non-authoritative-inspector | s10 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| gitdiff | s2 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| git-c | s3 | missing-tests | tests-on-disk-not-listed=tests/unit/tool/git-commit.test.ts;tests/unit/git-cloud-branch-snapshot.test.ts | add to evidence.tests.unit |
| compactionbreaker | s4 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |
| l3-workingstate | s5 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| mutatingmodes-set-agentmode-default | s6 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |
| llm-error-taxonomy | s7 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| lsp-nav-test-fixtures | s8 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| quantamcpconfig | s9 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| verifyguard | s1 | appropriate-thin-not-overclaim | code=1 mon=0 wire=8 | thin axes are correct (not overclaim) |
| tests-integration-probe-test-ts | s10 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| cr2-fu3-exhaustiveness-gate | s2 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| localsandbox | s3 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| loadreporules-cwd | s4 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| llm-distill | s5 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| quantaskillsdir | s6 | appropriate-thin-not-overclaim | code=3 mon=0 wire=0 | thin axes are correct (not overclaim) |
| retry-error-classification | s7 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| byte-stable-string-comparator | s8 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| sensitivity-classifier | s9 | missing-tests | tests-on-disk-not-listed=tests/unit/security/sensitivity-classifier.test.js;tests/unit/security/sensitivity-classifier.test.ts | add to evidence.tests.unit |
| precedence-rule-r3-p1 | s1 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| withgitsnapshot | s10 | appropriate-thin-not-overclaim | code=1 mon=0 wire=10 | thin axes are correct (not overclaim) |
| tool-search | s2 | missing-tests | tests-on-disk-not-listed=tests/unit/tool-search.test.js;tests/unit/tool-search.test.ts | add to evidence.tests.unit |
| reviewer-3tier | s3 | appropriate-thin-not-overclaim | code=4 mon=0 wire=0 | thin axes are correct (not overclaim) |
| mode-repo-rules-active-skills-working-state-memory-hints | s4 | appropriate-thin-not-overclaim | code=3 mon=0 wire=0 | thin axes are correct (not overclaim) |
| memorysearch-write-update | s5 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| 2026-05-21 | s6 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| fallback-kinds-policy | s7 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| assert-never-exhaustiveness | s8 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| redaction-config-gate | s9 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| streamreset | s1 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| llm-0 | s10 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| git-review-diff | s2 | missing-tests | tests-on-disk-not-listed=tests/unit/tool/git-review-diff.test.ts;tests/integration/git-review-diff-e2e.test.ts | add to evidence.tests.unit |
| 183-safety-net-green | s3 | appropriate-thin-not-overclaim | code=1 mon=4 wire=0 | thin axes are correct (not overclaim) |
| proactive | s4 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| reminder-memory-recall-routing-hints-only | s5 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| bounded | s6 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |
| escalating-kill | s7 | appropriate-thin-not-overclaim | code=3 mon=0 wire=0 | thin axes are correct (not overclaim) |
| otel-sink | s8 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| anthropic-beta-and-skill-size-cap | s9 | appropriate-thin-not-overclaim | code=3 mon=0 wire=0 | thin axes are correct (not overclaim) |
| testrunner | s1 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| quantabenchtimeoutms | s10 | appropriate-thin-not-overclaim | code=1 mon=0 wire=10 | thin axes are correct (not overclaim) |
| gh-pr-typed-ops | s2 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| cr3-rule-catalog-ssot-fu1-rule-per-concern-invert | s3 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| source-runtime-tests-docs-memory | s4 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| src-agent-working-state-ts | s5 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| tool-scoping | s6 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |
| cap-enforcer-nextaction | s7 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| mcp-tool-bridge | s9 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |
| decideverifyguard | s1 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| mode-matrix-narrow-assert | s10 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| lsp-nav-tool-slice | s2 | appropriate-thin-not-overclaim | code=3 mon=0 wire=0 | thin axes are correct (not overclaim) |
| dockersandbox | s3 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| turncontextinput-mode-reporules-workingstate-activeskills | s4 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| tier | s5 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| quantasubagent-maxdepth | s6 | appropriate-thin-not-overclaim | code=3 mon=0 wire=0 | thin axes are correct (not overclaim) |
| sandbox-policy | s7 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| claude-code-session-translator | s9 | appropriate-thin-not-overclaim | code=3 mon=0 wire=0 | thin axes are correct (not overclaim) |
| src-agent-closeout-guard-ts | s1 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| cli-resume-state-machine | s10 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| prefix-rule-dsl | s3 | appropriate-thin-not-overclaim | code=5 mon=0 wire=0 | thin axes are correct (not overclaim) |
| reactive-fail-fast | s4 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |
| quantamemory-path-embed-embedmodel-recalllimit-distill-conso | s5 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| safety-posture-round-2-fix | s6 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| token-store-atomic | s7 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| slice-boundary-invariants | s9 | appropriate-thin-not-overclaim | code=17 mon=0 wire=0 | thin axes are correct (not overclaim) |
| quantaverifyguard | s1 | truly-overclaimed | code:[] empty | downgrade-or-hold |
| repl-mcp-surface-wire | s10 | appropriate-thin-not-overclaim | code=1 mon=0 wire=0 | thin axes are correct (not overclaim) |
| permission-profile-2-layer | s3 | appropriate-thin-not-overclaim | code=4 mon=0 wire=0 | thin axes are correct (not overclaim) |
| trust-and-inputs | s4 | appropriate-thin-not-overclaim | code=2 mon=0 wire=0 | thin axes are correct (not overclaim) |

## Surprise findings

1. **24/80 (30%) are "code:[] empty"** — these features have NO `evidence.code` paths at all in the yaml but were marked L4+/stable. E.g. `cfg-fourrule-true`, `testrunner`, `decideverifyguard`, `quantaverifyguard`, `dockersandbox`, `localsandbox`, `quantamcpconfig`, `biome`, `diagnostics`, `2026-05-21`. These are unambiguously overclaimed; either downgrade to L2/hold or backfill code paths.
2. **5/80 are "missing-tests"** — hellgate/unit test files exist on disk matching the id but are NOT listed in `evidence.tests.*`. Examples: `agent` (2 integration tests un-listed), `git-c` (`git-commit.test.ts` un-listed), `git-review-diff`, `tool-search`, `sensitivity-classifier`. Pure SSOT gap — listing them flips axis 2.
3. **Only 1/80 mislabeled-wiring**: `quantaprovider` (s7) — paths under `src/apps/cli/` but `ui_surfaces:[n-a]`. Easy fix.
4. **0 mislabeled-monitoring** — when `evidence.code` is non-empty, OTel grep is also 0 except `183-safety-net-green` (mon=4 grep matches but monitoring already passes). The judge's monitoring axis appears to reflect real telemetry density; "thin" here is genuine, not mislabeled.
5. **50/80 (62.5%) are genuinely-thin-but-not-overclaim** — code exists, paths resolve, but no OTel hooks and no env-knob wiring. These are correctly flagged "thin" by the judge but calling them "overclaimed" is a misnomer; the judge formula conflates "thin axis coverage" with "overclaim". The yaml maturity (L4) may be accurate; the axes just measure something orthogonal.
6. **`verifyguard` caveat**: evidence.code points to `src/apps/bench/eval/driver.ts` (not the real verify-guard module). The audit's surface-inference does not classify `src/apps/bench/` as a UI surface, so this slipped past wiring check despite wire=8 grep hits — recommend extending surface map (or auditing if evidence path is stale).

## Method

- Source: `bun run tools/feature-catalog/cli.ts judge --overclaimed`
- Per-feature: yaml parsed → existing evidence.code → rg counts for OTel/recordAttrs/startSpan and runtimeConfig/env
- Surface inferred from path prefix (cli/api/ide); compared to yaml ui_surfaces
- Tests on disk matched by id substring; compared to evidence.tests.{unit,integration,contract}
- Verdict matrix applied in priority order; no heuristics beyond grep counts