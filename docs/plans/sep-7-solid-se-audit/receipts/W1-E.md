# W1-E receipt — Sep-07 SOLID/SE and duplicate-development audit

```text
AUDIT_ASSIGNMENT|lane=E|scope=llm,retrieval,runner,skill,rules|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-E.md
```

## Snapshot

W0 receipt was **absent** at start and still absent at write. Coordinator
dispatched lane E against a dirty shared checkout. Inspection used **committed
HEAD only** (`git show HEAD:<path>`). Uncommitted overlay is outside this claim.

Lane E production porcelain (throughout inspection, unchanged):

```text
 M src/llm/retry/codex-spec-router.ts
 M src/llm/retry/decorator-policy.ts
 M src/llm/retry/port.ts
 M src/llm/retry/too-many-failed-attempts.ts
```

Those four files were classified from HEAD, not the working tree. The overlay
contains the SEP6-01 HITL repair; HEAD does not.

| Field | Pre-inspection | Post-inspection |
|---|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` | identical |
| branch | `main` | identical |
| origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` | identical |
| merge-base | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` | identical |
| ahead/behind | `0 0` | identical |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) | identical |
| unstaged/tracked diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` | identical |
| untracked manifest SHA-256 | `230a92807b653c53894a5e04b88aa02b5613fb60197dbbadf8cbe6205809dcb7` (7 files) | `d2cfaa3392e4451bed8ad8ea5b48719cdcc7091cf67fc7b0a668d6c7496d0260` (9 files) |

Untracked delta during inspection is sibling campaign receipts only
(`receipts/W1-C.md`, `receipts/W1-F.md`). Tracked production snapshot is
stable. Not STALE.

Authority-document hashes:

| Path | SHA-256 |
|---|---|
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` (HEAD=WT) |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| docs/ARCHITECTURE.md (HEAD) | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| docs/ARCHITECTURE.md (WT) | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` |
| tests/README.md | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` |
| package.json | `97c0650b754616cf72e5215aa7273c914840c314a141e8e83de3c0e37d8556e4` |
| biome.json | `86028e6e6c5e33a138cb5ed224f200fb4e704751b6aad14aee4c5477a2339703` |
| tsconfig.json | `622ad399076687a1e3cdc01ce3b0b46edd344e2bb3da963bf0ea30223a77564b` |
| tsconfig.base.json | `c4ca874cd213452f545c273569a8d220566d763188bb26b64f77433ef51aa22f` |
| tsconfig.typecheck.src.json | `da1da7a381f8ec7b172c78985569df66f1e13e88d7ab0066b1137eaa90eb3320` |
| tsconfig.typecheck.tests.json | `3449f97ec6694b101f4784ab1116c284906d25e10ddc30805de471ee487f0fd0` |
| tests/unit/_arch/slice-boundary-configs.ts (HEAD) | `315560288012f4e6f2cc149f0605a539faac9676149e2e606fb3580a89115697` |
| tests/unit/_arch/slice-boundary-configs.ts (WT) | `1e570be7ac9ecd80ede42399e98d8fabb948642be66ae2b4c93654dc0f4458d6` |
| tools/god-code/detect.ts | `0ffa10d217ab9f5e536181806fc1bfedeebfea53b86a8d219170ca28f981e5a5` |
| tools/god-code/allowlist.json | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` |
| tools/dev/lint-debt-ceiling.json | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` |

`docs/ARCHITECTURE.md` and `slice-boundary-configs.ts` differ HEAD vs working
tree (W2/W3 reserved). Lane E used HEAD TypeScript under
`src/{llm,retrieval,runner,skill,rules}` as owner.

If a later W0 names a different HEAD or a different **tracked** diff hash, this
receipt is **STALE**.

## Coverage counts

| Universe | Count |
|---|---:|
| Exclusive production `src/{llm,retrieval,runner,skill,rules}/**/*.ts` excluding `*.test.ts` and `__tests__` | **634** |
| Classified | **634** |
| Unclassified | **0** |
| Colocated tests under those trees | **32** |
| Total tracked `.ts` in E trees | **666** |
| God-MODULE >1000 | **0** |
| Cohort 900–999 | **4** |
| God-FUNCTION >150 in official allowlist | **0** (no E entries) |

By slice (production files / lines at HEAD):

| Slice | Files | Lines |
|---|---:|---:|
| llm | 90 | ~16.8k |
| retrieval | 113 | ~9.7k |
| runner | 322 | ~58.3k |
| skill | 98 | ~12.9k |
| rules | 11 | ~1.9k |

Cohort 900–999 (inventory, not findings):

| Lines | Path |
|---:|---|
| 972 | `src/runner/session-ops/index.ts` |
| 943 | `src/llm/openai-responses-wire.ts` |
| 933 | `src/runner/batch/report-official-grade.ts` |
| 927 | `src/runner/batch/corpus/repo-version-specs.ts` |

Mirrored tests (HEAD path-name heuristic; SUT ownership verified for findings):

| Bucket | Count |
|---|---:|
| `tests/unit` paths matching `llm` | 84 |
| `tests/unit` paths matching `retrieval` | 27 |
| `tests/unit` paths matching `runner` | 90 |
| `tests/unit` paths matching `skill` | 66 |
| `tests/unit` paths matching `rules`/`repo-rules`/`vendor-detect` | 34 |
| `tests/integration` matching E names | 16 |
| `tests/eval/retrieval` | 7 |

Depth: every production file was opened for line count + directory role.
Owner bodies plus at least one consumer were read for retry, factory/transport,
search-index-backend, knobs dual-channel, persist-turn, skill frontmatter/
registry/install, rules vendor-detector, and live retrieval engines.
`src/runner/knobs/knobs/*.ts` (68) classified as knob modules; `src/runner/batch/eval/**`
classified as bench-eval. Bodies not narrated file-by-file there are listed
under Uninspected conditions.

## Inspected consumer paths

| Owner (E) | Consumer inspected | Lane of consumer |
|---|---|---|
| `llm/retry/decorator-policy.ts` `retryDispositionForKind` | `src/agent/retry.ts` `isRetryable`; `RetryingLLM` via `src/runner/assemble/llm.ts` / CLI `buildLLM` | A / G |
| `llm/retry/codex-spec-router.ts` `codexSpecRoute` | `src/agent/recovery.ts` `decideTypedStreamError`; HEAD decorator-policy | A |
| `llm/factory.ts` `pickProvider` | `src/apps/cli/status-cmd.ts`, `doctor/default-probes.ts`, `src/llm/boot-selection.ts` | G |
| `llm/providers/registry.ts` `resolveProvider` | `src/runner/assemble/llm.ts` `selectLlmTransport`; CLI `internal.ts` `buildLLM` | G |
| `runner/assemble/search-index-backend.ts` | `src/runner/assemble/search-pipeline.ts`; host mention-symbol-deps (state unread) | G |
| `runner/assemble/pipeline.ts` `createRerankerFromEnv` | `buildSearchPipelineFromEnv` → CLI/host | G |
| `runner/knobs/knobs/{read-outline,test-runner}.ts` | `runtimeConfig().readOutline\|testRunner` (`@/shared`); `batch/eval/knobs-bench.ts` `resolveLiveOverrides` | F / E |
| `runner/orchestrate/persist-turn.ts` | `src/host/.../turn-runner.ts` `persistTurnOrFailStop`; `apps/cli/session-io.ts` | G |
| `retrieval/engines` `createEmbedderFromEnv` | `search-index-backend.ts` | E |
| `skill/frontmatter.ts` | `skill/discover.ts`; agent `glob-rules` (native path) | A |
| `rules/vendor-detector/normalizer.ts` | `src/agent/glob-rules.ts` vendor composition | A |
| `skill/install-enforcement.ts` `decideInstall` | **no production caller**; barrel re-export only | — |
| `skill/registry.ts` retag | `runner/assemble/skill.ts` / `build-skills.ts`; CLI `buildCliSkillAuthority` | G |
| `skill/activation.ts` `matchesAnyGlob` | skill paths activation | E |
| `skill/playbook/inline-trigger-watcher.ts` `matchesGlobSubset` | playbook disk watch | E |

## Findings

Retired SEP5/SEP6 IDs were not reopened unless the documented trigger reproduced
on HEAD. D8, D12, D14, D15 (merge), D17, D20, D21 stay closed/conditional.

### E-N7 [P1] HITL kinds still consult message markers on HEAD (SEP6-N7 trigger reproduced)

- **status:** open on HEAD snapshot
- **attribution:** pre-existing (DOF-30 parity). SEP6-01 repair exists **only in the dirty overlay**, not in HEAD.
- **owner:** HEAD `src/llm/retry/decorator-policy.ts` `retryDispositionForKind`: `kind === "auth"` → `no_retry`; `cyber_policy` / `sandbox_error` / `sandbox_blocked` fall through to `"consult_markers"`.
- **table:** HEAD `codexSpecRoute` maps those three plus `auth` to `hitl_handoff`.
- **consumer:** `src/agent/retry.ts` `isRetryable` (HEAD): `consult_markers` scans `RETRYABLE_MARKERS`. `RetryingLLM` retries before outer `decideTypedStreamError`.
- **measured drift:** HEAD comments state a `cyber_policy` error whose message contains `"429"` currently RETRIES. Fixture `"503 overloaded timeout, try again"` on `cyber_policy`/`sandbox_*` → `isRetryable === true` while table action is `hitl_handoff`.
- **test honesty:** HEAD `tests/unit/retry-decorator-policy-hellgate.test.ts` pins the legacy consult_markers parity (would go RED if HEAD already had the overlay policy). Overlay tests flip that contract.
- **not a new dual-write:** agent no longer owns a second kind set; the defect is decorator projection vs table.
- **proposed write set (E):** `src/llm/retry/decorator-policy.ts`. **Forbidden:** adding a second HITL kind set in `src/agent/retry.ts` (A). Do not re-apply if the overlay is the commit being merged.
- **proof limit:** static HEAD owner+consumer. Overlay behavior was not treated as snapshot truth.

### E-KNOB-01 [P1] Dual-channel truthy vocab drift for `READ_OUTLINE` / `TEST_RUNNER`

- **status:** open
- **attribution:** pre-existing; worsened vs “identical vocabulary” comments on dual-channel knobs
- **owners:** `src/runner/knobs/knobs/read-outline.ts` and `test-runner.ts` `ENABLING = {"1","on","true"}` vs live `src/shared/env-flag.ts` `GATE_TRUTHY` includes `"yes"` (`gateOn`).
- **consumers:** `runtimeConfig().readOutline` / `testRunner` (live feature wire); `src/runner/batch/eval/knobs-bench.ts` `resolveLiveOverrides` (knob parse).
- **measured drift:** `QUANTA_READ_OUTLINE=yes` (or `TEST_RUNNER`) → runtime gate **ON**, knob `parse` **undefined** → bench overlay omits the key while the feature is already on. MCP/RATELIMIT dual-channel knobs reuse `parseBool` and do **not** drift.
- **failure:** telemetry/help/resolve disagree with the live wire for the same env token.
- **proposed write set (E):** `src/runner/knobs/knobs/read-outline.ts`, `src/runner/knobs/knobs/test-runner.ts` (align with `parseBool`/`gateOn`). **Forbidden:** changing `src/shared/env-flag.ts` as if E owned it (F / W2-X).
- **proof limit:** token-set comparison + consumer read sites. Process-level env fixture not executed this pass.

### E-SEARCH-01 [P1] Explicit vector-store open-fail keeps `state:"ready"` while ops are inert

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/runner/assemble/search-index-backend.ts` `buildSemanticBackend` (~L825–856): valid `QUANTA_VECTOR_STORE=sqlite|lance|qdrant` but runtime open/capability fail → per-op `[]` / no-op, **static `state: "ready"`**. Typo path correctly returns `newDisabledBackend` `state:"failed"`.
- **consumers:** `src/runner/assemble/search-pipeline.ts`; host mention-symbol-deps does not branch on `state`.
- **test honesty:** `tests/unit/runner/t06-search-backend-failclosed-hellgate.test.ts` covers **invalid-explicit spelling only**. Removing open-fail `failed` promotion cannot turn that rail RED.
- **failure:** operator-visible “ready index” that never stores or returns hits; same empty-index class T06 closed for typos.
- **proposed write set (E):** `src/runner/assemble/search-index-backend.ts`; optionally `search-pipeline.ts` to refuse wire on `failed`. **Forbidden:** retrieval store adapters except to surface typed open errors they already return.
- **proof limit:** static control-flow on HEAD. Live sqlite/lance open failure not executed.

### E-EMBED-01 [P1] Vendor embed failure mixes 64-dim `hashEmbed` into a live index

- **status:** open
- **attribution:** pre-existing (documented “wire never throws”)
- **owner:** `src/runner/assemble/search-index-backend.ts` `resolveIndexEmbedder` (~L266–326): recognised provider + `!ok`/throw → headless same-dim, else **`hashEmbed` dim 64**. `capabilities()` catch returns `HASH_EMBED_CAPS` (64) while `providerLabel` stays `openai|voyage|…`.
- **consumer:** in-memory cosine (`Math.min` of lengths, L349–355) and vector stores that already hold provider-dim rows.
- **measured failure:** a later query vector (provider dim) scored against mixed 64-dim rows via truncated cosine → silent wrong ranking, not empty/fail.
- **not D15:** this is runner adapt fail-open, not a proposal to merge `embedders/**` barrels.
- **proposed write set (E):** `resolveIndexEmbedder` in `search-index-backend.ts` (fail-closed / same-dim-only / mark `failed`). **Forbidden:** rewriting `@/retrieval/engines` Result contract to throw.
- **proof limit:** control-flow + cosine truncation. Live vendor 401 not executed.

### E-FM-01 [P1] Vendor frontmatter fork omits skill `FORBIDDEN_KEYS`

- **status:** open
- **attribution:** pre-existing (fence-forced copy; comment claims “same subset”)
- **owners:** `src/skill/frontmatter.ts` (`FORBIDDEN_KEYS` `__proto__`/`constructor`/`prototype`) vs `src/rules/vendor-detector/normalizer.ts` `collectFrontmatter` / `applyFrontmatterLine` (assigns `data[key]` with no forbid set; nested `metadata.*` not preserved).
- **consumers:** skill path → `discover.ts`; vendor path → `src/agent/glob-rules.ts` ADR-0233 composition. Same `.mdc` can parse differently by loader.
- **measured drift:** `__proto__:` list key accepted on vendor path, rejected on skill path; nested metadata dropped only on vendor path.
- **failure:** prototype-key smuggle / globs interpretation drift on vendor-loaded rules.
- **not D8:** D8 was mention first-line projection (closed). This is YAML-ish frontmatter parse.
- **proposed write set (E):** `src/rules/vendor-detector/normalizer.ts` (copy forbid + nested policy) **or** W2-X fence-legal shared leaf used by both. **Forbidden:** `rules` value-importing `@/skill`; dumping policy into `@/shared` without two proven consumers.
- **proof limit:** source comparison. Hostile `__proto__` fixture not executed against vendor detector.

### E-PROV-01 [P2] Boot/status `pickProvider` vs live `resolveProvider` transport ladder

- **status:** open
- **attribution:** pre-existing (two ladders: vendor vs Anthropic cloud transport)
- **owners:** `src/llm/factory.ts` `pickProvider` (QUANTA_PROVIDER / ChatGPT token / ANTHROPIC_API_KEY / OPENAI_API_KEY); `src/llm/providers/registry.ts` `resolveProvider` + `provider-router.ts` `detectClaudeUseEnv`.
- **consumers:** status/doctor/eval/terminal/boot → `pickProvider` / `resolveBootSelection`; CLI `buildLLM` → `selectLlmTransport` → `resolveProvider`.
- **measured drift:** `CLAUDE_CODE_USE_BEDROCK=1` + `ANTHROPIC_API_KEY` set, no `QUANTA_PROVIDER` → pickProvider **`anthropic`**, resolveProvider **`bedrock`**. Status/DEFAULT_MODEL[anthropic] vs live Bedrock port.
- **failure:** operator display and boot model can name the public Anthropic vendor while the stream uses Bedrock.
- **proposed write set (E):** `pickProvider` / `boot-selection.ts` expose transport id **or** document two axes and make status consume `selectLlmTransport`. **Forbidden:** importing runner `selectLlmTransport` into llm (DIP).
- **proof limit:** precedence tables + consumer sites. Live Bedrock credentials not used.

### E-PERSIST-01 [P2] `persistTurn` usage-accounting snapshot is unguarded

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/runner/orchestrate/persist-turn.ts` L189–198: `objectiveSnapshot` goes through `resolveObjectiveSnapshot` try/catch; `usageAccountingSnapshot?.()` is **not**. Path-mode `saveSession` may already have succeeded (L173–180) before id-mode throws.
- **consumer:** host `persistTurnOrFailStop` fail-stops the session on throw.
- **failure:** asymmetric durability: objective encode cannot abort persist; usage encode can, including after path-mode save (partial two-channel write).
- **proposed write set (E):** `src/runner/orchestrate/persist-turn.ts` (guard usage like objective). **Forbidden:** rewriting `@/session` save semantics (D).
- **proof limit:** static try/catch asymmetry. Dual-save crash fixture not run.

### E-SKILL-01 [P2] `decideInstall` has no production ingress

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/skill/install-enforcement.ts` `decideInstall` + barrel export.
- **consumer:** **none** in `src/` besides `src/skill/index.ts`. Runtime uses `bannedSkillNames` / `requiredAdminSkillNames` inside authority/projections **if** org policy is loaded. CLI `buildCliSkillAuthority` leaves `orgConfigDir` null (lane G).
- **failure:** ADR-0134 install/remove matrix is never applied at install/promote time. A banned skill can land on disk; enforcement is later projection-only and inert when policy is null.
- **test honesty:** unit tests of the pure matrix do not prove a composition call. Removing a non-existent host call cannot RED those tests.
- **proposed write set (E):** call `decideInstall` from `src/skill/proposal/promote.ts` / `skill-creator.ts` (skill-owned install seams). **Forbidden:** editing `apps/cli/repl/session-setup.ts` as E (G / W2-X for orgConfigDir).
- **proof limit:** `rg` of `decideInstall(` in `src/**` = definition + barrel.

### E-SKILL-02 [P2] Registry retag overwrites frontmatter scope but leaves derived `installState`

- **status:** open
- **attribution:** pre-existing (comment/code contradiction)
- **owner:** `src/skill/registry.ts` `discoverSkillSourcesIn` L161–170: if `skillScope(s) !== src.scope` then `{...s, scope: src.scope}`. Comment claims “Explicit frontmatter still wins”; `skillScope` is just `s.scope ?? "builtIn"`, so frontmatter scope **loses**.
- **consumer:** registry snapshot → CLI skill management / authority projections.
- **failure:** user-dir skill with `scope: admin` can keep `installState:"required"` after scope is forced to `user` → fake required in management UI. Policy enforcement is name-based so this is observation-contract false, not a disable bypass by itself.
- **proposed write set (E):** `src/skill/registry.ts` (retag must recompute derived fields, or honor frontmatter as the comment says). **Forbidden:** agent mention resolvers (D8 closed).
- **proof limit:** retag tests cover “misinferred → admin” only, not frontmatter demotion.

## Inventory (smell without a new failure ticket)

- Residual `consult_markers` for `unknown` / `context_window_exceeded` / `too_many_failed_attempts` / `thread_rollback_failed` is HEAD-intentional DOF-30 parity. HITL subset is E-N7; do not silently flip the rest without a measured consumer bug. `isPromptTooLong` still runs before `isRetryable`.
- D15 dual barrels (`embedders/**` throw-port vs `engines/embedder` Result; `rerank/` vs `reranker/`): still present; live wire is `createEmbedderFromEnv` / `createRerankerFromEnv`. In-repo production callers of legacy factories **not found**. Stay **conditional**; no merge proposal.
- BM25 Unicode (`lexical/bm25-impl`) vs ASCII (`rerank/bm25-secondary`): documented different axis; live search uses engines reranker env factory. W2-X fingerprint only.
- `assemble/pipeline.ts` duck adapters map `!ok` → `[]` / identity rerank: Result erasure at composition. Bounded as inventory unless W2-X wants it bundled with E-EMBED-01.
- Implicit store open-fail → in-memory `legacy-fallback`: documented. Not the explicit-store class.
- Orphan retrieval leaves (`multimodal/`, `auto-hook/`, `versioning/`, `batching/`, `budget-probe/`, `hybrid-query`) plus `withFailureCounter` (llm, default-OFF, no prod wire): dead capability / catalog maturity, not live dual-write.
- LLM `sha256Hex` twins: D14 closed; implementations match.
- Skill three frontmatter parsers (lenient / strict zod / playbook yaml): consumers partitioned; drift finding is E-FM-01 (vendor copy), not “merge the three”.
- `matchesAnyGlob` (no brace) vs `matchesGlobSubset` (brace): different ingresses; algorithm-reuse candidate for W2-X, not a shared-consumer finding this pass.
- Cohort 900–999 four files; `ChatGPTOAuthAdapter` / `FallbackLLM` large classes. Split pressure only.
- Bench LLM risk-gate `invalidDecision` → `expand: true` on stream-error: documented “expand under uncertainty”. Cost burn is policy, not an accidental fail-open.

## Candidate fingerprints for W2-X

Fingerprint = `authority/invariant/input/output/state/effect/failure-policy/lifecycle`.

| ID | Pair | Fingerprint | Why |
|---|---|---|---|
| X-E-RETRY | `llm/retry/codexSpecRoute` ↔ `llm/retry/retryDispositionForKind` ↔ `agent/retry.isRetryable` ↔ `agent/recovery.decideTypedStreamError` | recovery-authority / kind→action / LLMError / retry\|handoff\|compact / none / rethrow-or-retry / marker-vs-typed / per-stream | E-N7; decorator vs outer FSM |
| X-E-MARKERS | adapter CONTEXT markers ↔ `agent/retry` PTL_MARKERS ↔ `shared` error classifier | failure-policy / context-window text / message / bool / none / compaction / marker-set / per-error | asymmetric strings |
| X-E-KIND-BRIDGE | `runtime/os-sandbox/llm-error-bridge` + `agent/.../rollback-llm-error-bridge` ↔ `codexSpecRoute` | failure-policy / layer kind stamp / sandbox event / LLMErrorKind / none / hitl_handoff / typed / per-call | foreign producers, llm consumer |
| X-E-TRANSPORT | `factory.pickProvider` ↔ `provider-router`/`resolveProvider` ↔ runner `selectLlmTransport` | selection-authority / which vendor+cloud / EnvLike / Provider\|ProviderId / none / construct adapter / conflict-throw vs fallthrough / boot | E-PROV-01 |
| X-E-KNOB | runner dual-channel knobs ↔ `shared/env-flag` `gateOn` ↔ `config` knob-schema | policy / truthy token / env string / bool\|undefined / none / AgentConfig overlay / parse-fallthrough / import-time | E-KNOB-01; MCP/RATELIMIT already aligned |
| X-E-EMBED | runner `hashEmbed` ↔ retrieval engines Embedder ↔ `agent/memory-embedder` OpenAIEmbedder | embed-authority / text→vector / string / number[]\|Result\|throw / cache / HTTP / fail-open-vs-Result / per-call | third stack is A; D15 barrels stay conditional |
| X-E-RG | `retrieval/lexical/ripgrep-impl` ↔ `tool/grep` ↔ `tool/glob` | lexical-search / argv+jail / pattern / hits / none / Bun.spawn / grep-degrade vs MAX_LINES / per-query | D12 closed; comparison only |
| X-E-FM | `skill/frontmatter` ↔ `rules/vendor-detector/normalizer` | parse-authority / YAML-ish FM / markdown / map+body / none / none / forbid-keys / per-file | E-FM-01; fence caused copy |
| X-E-GLOB | `skill/activation.matchesAnyGlob` ↔ playbook `matchesGlobSubset` ↔ agent glob | match-authority / glob subset / path+pattern / bool / none / none / cap-no-match / per-path | brace vs DP |
| X-E-INSTALL | `skill/decideInstall` ↔ CLI `orgConfigDir: null` ↔ web-daemon skill authority | install-policy / ADR-0134 matrix / attempt+policy / allow\|deny / none / audit / fail-open-null-policy / per-install | E-SKILL-01 + G |
| X-E-DELEG | `runner/session-execution-plane.adaptDelegation` ↔ host `resolveDelegation` | lifecycle / parentDepth / SessionDeps / AgentConfig slots / scheduler / env gates / session bind | parallel composition |
| X-E-D15 | `@/retrieval` barrel legacy factories ↔ `@/retrieval/engines` same names | embed-authority / public name / env / Embedder vs EmbeddingPort / none / HTTP\|throw / Result vs throw / boot | conditional; no merge |

## No-finding bounded areas

- DIP: runner value-imports of `@/rules` `@/patch` `@/migration` = 0 on HEAD. llm peer deny + `@/memory/history-sanitization` allow holds.
- `FallbackLLM` + `isFallbackKind` 1:1 with table `fallback_provider`.
- `withEmptyStreamCircuitBreaker` terminals `bad_request`; `stream-timeout` maps to `kind:"network"`.
- Explicit `QUANTA_VECTOR_STORE` **typo** → `failed` + T06 hellgate (spelling class only).
- Retrieval authority ratchet: `createEmbedderFromEnv` / `createRerankerFromEnv` required; retired assembler absent.
- Skill size cap 30MB + discover skip; `plugin-manifest` `.strict()` loud fail; `RulesStore` layer LPM.
- System-skills `manifest.generated.ts` embed.
- MCP/RATELIMIT dual-channel knobs share `parseBool` with runtime-config.
- D17/D21 triggers not reproduced.

## Uninspected conditions

- Live provider E2E (Bedrock+CLAUDE_USE, Voyage/OpenAI embed keys, Lance/Qdrant open).
- Hostile `__proto__` execution against vendor detector; `yes` env fixture against knobs-bench.
- Dual-save crash of `persistTurn` with both `--state` and id-mode.
- Cognitive-complexity scores / lint-debt per function (structure/lines used).
- `src/runner/batch/eval/{adaptive-escalation,kernel,repair,official-grade,posture,llm-evidence-packet}/**` bodies: classified as bench-eval, not line-by-line narrated except risk-gate / persist / knobs-bench / selection-finalize size.
- Most `src/runner/knobs/knobs/*.ts` beyond the four dual-channel knobs + repo-map.
- Dirty overlay of llm/retry (SEP6-01) — observed, not snapshot authority.
- External published importers of `@/retrieval` legacy barrel (in-repo `src/` none).

## Exact proposed write sets

| Finding | Allowed E files | Forbidden |
|---|---|---|
| E-N7 | `src/llm/retry/decorator-policy.ts` | `src/agent/retry.ts` kind sets; shared classifier retry policy |
| E-KNOB-01 | `src/runner/knobs/knobs/read-outline.ts`, `test-runner.ts` | `src/shared/env-flag.ts` |
| E-SEARCH-01 | `src/runner/assemble/search-index-backend.ts`, optionally `search-pipeline.ts` | retrieval store internals except typed errors they already emit |
| E-EMBED-01 | `src/runner/assemble/search-index-backend.ts` `resolveIndexEmbedder` | merging D15 barrels; making engines throw |
| E-FM-01 | `src/rules/vendor-detector/normalizer.ts` | `@/skill` import from rules; unsolicited `@/shared` policy dump |
| E-PROV-01 | `src/llm/factory.ts`, `src/llm/boot-selection.ts` | runner→llm up-import of `selectLlmTransport` |
| E-PERSIST-01 | `src/runner/orchestrate/persist-turn.ts` | `@/session` save engine |
| E-SKILL-01 | `src/skill/proposal/promote.ts`, `src/skill/skill-creator.ts`, `install-enforcement.ts` only if signature must change | `apps/cli/repl/session-setup.ts` |
| E-SKILL-02 | `src/skill/registry.ts` | mention-runner / plugin-app-resolver |

Tests for those rails live under `tests/unit/**` (W2-M). Catalog YAML is W2/W3.

## Complete file manifest

Format: `slice<TAB>lines<TAB>primary-role<TAB>path`. Union = 634 production files.
Pairwise intersection with other lanes is empty by path prefix. Colocated tests
(32) are listed after the production table and are **not** production ownership.

```text
llm	407	provider-adapter	src/llm/adapters/anthropic.ts
llm	735	provider-adapter	src/llm/adapters/chatgpt-oauth.ts
llm	234	provider-adapter	src/llm/adapters/openai-responses.ts
llm	564	provider-adapter	src/llm/adapters/openai.ts
llm	137	provider-adapter	src/llm/adapters/shared.ts
llm	417	provider-adapter	src/llm/anthropic-messages-codec.ts
llm	163	composition	src/llm/assemble.ts
llm	111	composition	src/llm/boot-selection.ts
llm	214	prompt-cache	src/llm/cache-control-audit/analyzer.ts
llm	29	prompt-cache	src/llm/cache-control-audit/hash.ts
llm	17	prompt-cache	src/llm/cache-control-audit/index.ts
llm	125	types	src/llm/cache-control-audit/types.ts
llm	60	impl	src/llm/context-1m.ts
llm	269	impl	src/llm/credential-helper.ts
llm	325	decorator-guard	src/llm/empty-stream-breaker.ts
llm	160	impl	src/llm/endpoint-transport.ts
llm	859	composition	src/llm/factory.ts
llm	381	decorator-guard	src/llm/fallback.ts
llm	16	decorator-guard	src/llm/image-sanitization-retry/index.ts
llm	53	types	src/llm/image-sanitization-retry/types.ts
llm	266	decorator-guard	src/llm/image-sanitization-retry/wrapping.ts
llm	218	barrel	src/llm/index.ts
llm	160	impl	src/llm/live-usage/index.ts
llm	229	impl	src/llm/message-batches.ts
llm	268	impl	src/llm/model-catalog.ts
llm	163	impl	src/llm/model-preset.ts
llm	184	impl	src/llm/model-swap.ts
llm	305	impl	src/llm/oidc-federation.ts
llm	97	provider-adapter	src/llm/openai-responses-output-items.ts
llm	943	provider-adapter	src/llm/openai-responses-wire.ts
llm	49	impl	src/llm/port-identity.ts
llm	73	port	src/llm/ports.ts
llm	102	impl	src/llm/prewarm.ts
llm	371	cloud-transport	src/llm/provider-metadata.ts
llm	244	cloud-transport	src/llm/provider-router.ts
llm	123	cloud-transport	src/llm/provider-types.ts
llm	230	cloud-transport	src/llm/providers/bedrock-adapter.ts
llm	68	cloud-transport	src/llm/providers/default-adapter.ts
llm	371	cloud-transport	src/llm/providers/foundry-adapter.ts
llm	155	cloud-transport	src/llm/providers/foundry-watch.ts
llm	25	cloud-transport	src/llm/providers/index.ts
llm	353	cloud-transport	src/llm/providers/mantle-adapter.ts
llm	204	port	src/llm/providers/provider-port.ts
llm	195	cloud-transport	src/llm/providers/registry.ts
llm	236	cloud-transport	src/llm/providers/vertex-adapter.ts
llm	146	ratelimit-snapshot	src/llm/ratelimit-snapshot/dual-window.ts
llm	27	ratelimit-snapshot	src/llm/ratelimit-snapshot/index.ts
llm	32	ratelimit-snapshot	src/llm/ratelimit-snapshot/notice.ts
llm	274	ratelimit-snapshot	src/llm/ratelimit-snapshot/parse.ts
llm	44	ratelimit-snapshot	src/llm/ratelimit-snapshot/policy.ts
llm	29	ratelimit-snapshot	src/llm/ratelimit-snapshot/store.ts
llm	277	impl	src/llm/reasoning-effort.ts
llm	23	replay-store	src/llm/replay/index.ts
llm	279	replay-store	src/llm/replay/jsonl-store.ts
llm	437	replay-store	src/llm/replay/recording-llm.ts
llm	137	replay-store	src/llm/replay/replay-llm.ts
llm	153	replay-store	src/llm/replay/s3-replay-store.ts
llm	158	types	src/llm/replay/types.ts
llm	106	impl	src/llm/responses-continuation-store.ts
llm	26	impl	src/llm/responses-continuation-wrapping.ts
llm	771	provider-adapter	src/llm/responses-stream.ts
llm	126	recovery-authority	src/llm/retry/codex-spec-router.ts
llm	109	recovery-authority	src/llm/retry/decorator-policy.ts
llm	30	recovery-authority	src/llm/retry/index.ts
llm	48	port	src/llm/retry/port.ts
llm	211	recovery-authority	src/llm/retry/too-many-failed-attempts.ts
llm	63	impl	src/llm/role-model-override/default-resolver.ts
llm	4	impl	src/llm/role-model-override/index.ts
llm	64	port	src/llm/role-model-override/port.ts
llm	50	types	src/llm/role-model-override/types.ts
llm	34	impl	src/llm/sample-temperature.ts
llm	91	impl	src/llm/spinner-stall/default-detector.ts
llm	157	impl	src/llm/spinner-stall/event-emitter.ts
llm	42	impl	src/llm/spinner-stall/index.ts
llm	90	impl	src/llm/spinner-stall/operator-notice-wire.ts
llm	135	port	src/llm/spinner-stall/port.ts
llm	195	impl	src/llm/stream-progress-trace.ts
llm	364	decorator-guard	src/llm/stream-timeout.ts
llm	390	impl	src/llm/streaming-events.ts
llm	446	impl	src/llm/structured-output.ts
llm	97	prompt-cache	src/llm/system-prompt-cache/drift-detector.ts
llm	24	prompt-cache	src/llm/system-prompt-cache/hash.ts
llm	125	prompt-cache	src/llm/system-prompt-cache/in-memory-cache.ts
llm	25	prompt-cache	src/llm/system-prompt-cache/index.ts
llm	70	port	src/llm/system-prompt-cache/port.ts
llm	132	types	src/llm/system-prompt-cache/types.ts
llm	27	impl	src/llm/target-metadata.ts
llm	453	types	src/llm/types.ts
llm	33	impl	src/llm/with-recording-lane.ts
llm	36	impl	src/llm/with-temperature.ts
retrieval	200	impl	src/retrieval/auto-hook/default-registrar.ts
retrieval	30	impl	src/retrieval/auto-hook/index.ts
retrieval	107	port	src/retrieval/auto-hook/port.ts
retrieval	60	types	src/retrieval/auto-hook/types.ts
retrieval	307	impl	src/retrieval/batching/default-batcher.ts
retrieval	19	impl	src/retrieval/batching/index.ts
retrieval	23	port	src/retrieval/batching/port.ts
retrieval	40	impl	src/retrieval/batching/single-flight.ts
retrieval	24	types	src/retrieval/batching/types.ts
retrieval	79	impl	src/retrieval/budget-probe/from-ledger.ts
retrieval	21	impl	src/retrieval/budget-probe/index.ts
retrieval	40	port	src/retrieval/budget-probe/port.ts
retrieval	35	impl	src/retrieval/budget-probe/static-probe.ts
retrieval	52	types	src/retrieval/budget-probe/types.ts
retrieval	55	embed-cache	src/retrieval/cache/hash.ts
retrieval	109	embed-cache	src/retrieval/cache/in-memory-lru.ts
retrieval	20	embed-cache	src/retrieval/cache/index.ts
retrieval	19	embed-cache	src/retrieval/cache/none-cache.ts
retrieval	29	port	src/retrieval/cache/port.ts
retrieval	39	embed-cache	src/retrieval/cache/registry.ts
retrieval	186	embed-cache	src/retrieval/cache/sqlite-cache.ts
retrieval	29	types	src/retrieval/cache/types.ts
retrieval	222	impl	src/retrieval/chunk-bucket.ts
retrieval	19	impl	src/retrieval/code-parser/index.ts
retrieval	175	impl	src/retrieval/code-parser/lang-table.ts
retrieval	287	impl	src/retrieval/code-parser/tree-sitter.ts
retrieval	60	types	src/retrieval/code-parser/types.ts
retrieval	164	impl	src/retrieval/commit-embedder.ts
retrieval	32	legacy-compat	src/retrieval/embedders/_abort.ts
retrieval	37	legacy-compat	src/retrieval/embedders/cohere.ts
retrieval	32	legacy-compat	src/retrieval/embedders/gemini.ts
retrieval	30	legacy-compat	src/retrieval/embedders/moonshot.ts
retrieval	30	legacy-compat	src/retrieval/embedders/nvidia.ts
retrieval	88	legacy-compat	src/retrieval/embedders/openai.ts
retrieval	84	legacy-compat	src/retrieval/embedders/voyage.ts
retrieval	31	legacy-compat	src/retrieval/embedders/xai.ts
retrieval	28	legacy-compat	src/retrieval/embedders/zai.ts
retrieval	47	legacy-compat	src/retrieval/embedding-port.ts
retrieval	44	live-engine	src/retrieval/engines/capabilities.ts
retrieval	92	live-engine	src/retrieval/engines/embedder/_http.ts
retrieval	92	live-engine	src/retrieval/engines/embedder/cohere-embedder.ts
retrieval	80	live-engine	src/retrieval/engines/embedder/headless-stub.ts
retrieval	89	live-engine	src/retrieval/engines/embedder/ollama-embedder.ts
retrieval	108	live-engine	src/retrieval/engines/embedder/openai-embedder.ts
retrieval	25	port	src/retrieval/engines/embedder/port.ts
retrieval	50	live-engine	src/retrieval/engines/embedder/registry.ts
retrieval	49	types	src/retrieval/engines/embedder/types.ts
retrieval	98	live-engine	src/retrieval/engines/embedder/voyage-embedder.ts
retrieval	63	live-engine	src/retrieval/engines/index.ts
retrieval	26	live-engine	src/retrieval/engines/store/_filter.ts
retrieval	107	live-engine	src/retrieval/engines/store/in-memory-store.ts
retrieval	118	live-engine	src/retrieval/engines/store/lance-store.ts
retrieval	20	port	src/retrieval/engines/store/port.ts
retrieval	152	live-engine	src/retrieval/engines/store/qdrant-store.ts
retrieval	60	live-engine	src/retrieval/engines/store/registry.ts
retrieval	158	live-engine	src/retrieval/engines/store/sqlite-vss-store.ts
retrieval	48	types	src/retrieval/engines/store/types.ts
retrieval	70	impl	src/retrieval/hybrid-query.ts
retrieval	134	barrel	src/retrieval/index.ts
retrieval	312	indexer	src/retrieval/indexer/chunker-syntactic.ts
retrieval	70	indexer	src/retrieval/indexer/chunker.ts
retrieval	661	indexer	src/retrieval/indexer/default-scanner.ts
retrieval	86	indexer	src/retrieval/indexer/delta-tracker.ts
retrieval	188	indexer	src/retrieval/indexer/headless-stub.ts
retrieval	38	indexer	src/retrieval/indexer/index.ts
retrieval	36	port	src/retrieval/indexer/port.ts
retrieval	102	types	src/retrieval/indexer/types.ts
retrieval	195	lexical-search	src/retrieval/lexical/bm25-impl.ts
retrieval	66	lexical-search	src/retrieval/lexical/headless-stub.ts
retrieval	34	lexical-search	src/retrieval/lexical/index.ts
retrieval	44	port	src/retrieval/lexical/port.ts
retrieval	374	lexical-search	src/retrieval/lexical/ripgrep-impl.ts
retrieval	57	types	src/retrieval/lexical/types.ts
retrieval	224	impl	src/retrieval/multimodal/clip-rest.ts
retrieval	130	impl	src/retrieval/multimodal/headless-stub.ts
retrieval	35	impl	src/retrieval/multimodal/index.ts
retrieval	27	port	src/retrieval/multimodal/port.ts
retrieval	45	impl	src/retrieval/multimodal/registry.ts
retrieval	79	types	src/retrieval/multimodal/types.ts
retrieval	185	impl	src/retrieval/multimodal/voyage-multimodal.ts
retrieval	29	pipeline-compose	src/retrieval/pipeline/budget-aware.ts
retrieval	199	pipeline-compose	src/retrieval/pipeline/compose.ts
retrieval	33	pipeline-compose	src/retrieval/pipeline/index.ts
retrieval	11	pipeline-compose	src/retrieval/pipeline/lexical-only.ts
retrieval	44	pipeline-compose	src/retrieval/pipeline/parallel-rrf.ts
retrieval	10	port	src/retrieval/pipeline/port.ts
retrieval	22	pipeline-compose	src/retrieval/pipeline/semantic-only.ts
retrieval	37	pipeline-compose	src/retrieval/pipeline/semantic-then-rerank.ts
retrieval	116	types	src/retrieval/pipeline/types.ts
retrieval	42	pure-rerank-algo	src/retrieval/rerank-registry.ts
retrieval	120	pure-rerank-algo	src/retrieval/rerank/bm25-secondary.ts
retrieval	21	pure-rerank-algo	src/retrieval/rerank/identity.ts
retrieval	89	pure-rerank-algo	src/retrieval/rerank/score-fusion-rrf.ts
retrieval	58	pure-rerank-algo	src/retrieval/rerank/tier-aware.ts
retrieval	151	live-reranker	src/retrieval/reranker/cohere-reranker.ts
retrieval	63	live-reranker	src/retrieval/reranker/headless-stub.ts
retrieval	44	live-reranker	src/retrieval/reranker/identity-reranker.ts
retrieval	31	live-reranker	src/retrieval/reranker/index.ts
retrieval	34	port	src/retrieval/reranker/port.ts
retrieval	76	live-reranker	src/retrieval/reranker/registry.ts
retrieval	53	types	src/retrieval/reranker/types.ts
retrieval	136	live-reranker	src/retrieval/reranker/voyage-reranker.ts
retrieval	34	impl	src/retrieval/semantic/embed-port.ts
retrieval	90	impl	src/retrieval/semantic/headless-embedder.ts
retrieval	15	impl	src/retrieval/semantic/index.ts
retrieval	18	types	src/retrieval/semantic/types.ts
retrieval	70	types	src/retrieval/types.ts
retrieval	43	impl	src/retrieval/versioning/index.ts
retrieval	125	impl	src/retrieval/versioning/invalidator.ts
retrieval	68	port	src/retrieval/versioning/port.ts
retrieval	52	impl	src/retrieval/versioning/registry-callbacks.ts
retrieval	197	impl	src/retrieval/versioning/tag-codec.ts
retrieval	50	types	src/retrieval/versioning/types.ts
rules	315	prefix-dsl	src/rules/argv.ts
rules	45	barrel	src/rules/index.ts
rules	116	prefix-dsl	src/rules/matcher.ts
rules	202	prefix-dsl	src/rules/parser.ts
rules	136	prefix-dsl	src/rules/store.ts
rules	104	types	src/rules/types.ts
rules	252	vendor-detect	src/rules/vendor-detector/default-detector.ts
rules	31	vendor-detect	src/rules/vendor-detector/index.ts
rules	385	vendor-detect	src/rules/vendor-detector/normalizer.ts
rules	128	port	src/rules/vendor-detector/port.ts
rules	150	vendor-detect	src/rules/vendor-detector/vendor-table.ts
runner	211	impl	src/runner/action-diff.ts
runner	72	composition	src/runner/assemble/compaction.ts
runner	340	composition	src/runner/assemble/config.ts
runner	10	composition	src/runner/assemble/env-flag.ts
runner	124	composition	src/runner/assemble/index.ts
runner	118	composition	src/runner/assemble/interactive-knobs.ts
runner	771	composition	src/runner/assemble/llm.ts
runner	287	composition	src/runner/assemble/memory-factory.ts
runner	79	composition	src/runner/assemble/memory.ts
runner	251	composition	src/runner/assemble/pipeline.ts
runner	100	composition	src/runner/assemble/repo-map-scan.ts
runner	858	composition	src/runner/assemble/search-index-backend.ts
runner	406	composition	src/runner/assemble/search-pipeline.ts
runner	110	composition	src/runner/assemble/session-authorities/blocker-dependency-resolver.ts
runner	227	composition	src/runner/assemble/session-authorities/build-objective.ts
runner	124	composition	src/runner/assemble/session-authorities/build-posture-control.ts
runner	325	composition	src/runner/assemble/session-authorities/build-posture.ts
runner	104	composition	src/runner/assemble/session-authorities/build-skills.ts
runner	112	composition	src/runner/assemble/session-authorities/build.ts
runner	57	composition	src/runner/assemble/session-authorities/index.ts
runner	390	composition	src/runner/assemble/session-authorities/restore.ts
runner	86	types	src/runner/assemble/session-authorities/types.ts
runner	115	composition	src/runner/assemble/session-state.ts
runner	28	composition	src/runner/assemble/skill.ts
runner	121	composition	src/runner/assemble/store.ts
runner	54	composition	src/runner/assemble/streaming.ts
runner	92	composition	src/runner/assemble/subagent.ts
runner	395	composition	src/runner/assemble/tooling.ts
runner	25	composition	src/runner/assemble/verify.ts
runner	9	bench-eval	src/runner/batch/admission.ts
runner	215	bench-eval	src/runner/batch/core.ts
runner	109	bench-eval	src/runner/batch/corpus/cache-pathspecs.ts
runner	530	bench-eval	src/runner/batch/corpus/dataset.ts
runner	314	bench-eval	src/runner/batch/corpus/failure-classifier.ts
runner	35	bench-eval	src/runner/batch/corpus/index.ts
runner	347	bench-eval	src/runner/batch/corpus/loader.ts
runner	59	bench-eval	src/runner/batch/corpus/paths.ts
runner	605	bench-eval	src/runner/batch/corpus/project-env.ts
runner	89	bench-eval	src/runner/batch/corpus/public-task.ts
runner	494	bench-eval	src/runner/batch/corpus/repo-version-python.ts
runner	927	bench-eval	src/runner/batch/corpus/repo-version-specs.ts
runner	44	bench-eval	src/runner/batch/corpus/selected-test-files-verifier.ts
runner	142	bench-eval	src/runner/batch/corpus/string-list-literal.ts
runner	128	bench-eval	src/runner/batch/eval/acceptance-adapter.ts
runner	67	bench-eval	src/runner/batch/eval/acceptance-llm-rerank-wire.ts
runner	60	bench-eval	src/runner/batch/eval/acceptance-llm-rerank.ts
runner	178	bench-eval	src/runner/batch/eval/acceptance-rerank.ts
runner	269	bench-eval	src/runner/batch/eval/acceptance-select.ts
runner	93	bench-eval	src/runner/batch/eval/acceptance-selector.ts
runner	75	bench-eval	src/runner/batch/eval/acceptance-wire.ts
runner	80	bench-eval	src/runner/batch/eval/adaptive-escalation/adaptive-run.ts
runner	180	bench-eval	src/runner/batch/eval/adaptive-escalation/controller.ts
runner	53	bench-eval	src/runner/batch/eval/adaptive-escalation/decision-legality.ts
runner	121	bench-eval	src/runner/batch/eval/adaptive-escalation/decision-schema.ts
runner	61	bench-eval	src/runner/batch/eval/adaptive-escalation/effort-ladder.ts
runner	135	bench-eval	src/runner/batch/eval/adaptive-escalation/evidence-facts.ts
runner	66	bench-eval	src/runner/batch/eval/adaptive-escalation/index.ts
runner	163	bench-eval	src/runner/batch/eval/adaptive-escalation/live-model-call.ts
runner	116	bench-eval	src/runner/batch/eval/adaptive-escalation/llm-router.ts
runner	83	bench-eval	src/runner/batch/eval/adaptive-escalation/phase-executor.ts
runner	117	bench-eval	src/runner/batch/eval/adaptive-escalation/router-evidence.ts
runner	79	bench-eval	src/runner/batch/eval/adaptive-escalation/router-prompt.ts
runner	103	bench-eval	src/runner/batch/eval/adaptive-escalation/transitions.ts
runner	412	bench-eval	src/runner/batch/eval/candidate-families.ts
runner	85	bench-eval	src/runner/batch/eval/capture-correctness.ts
runner	522	bench-eval	src/runner/batch/eval/cha-multisite.ts
runner	218	bench-eval	src/runner/batch/eval/closure-diagnostics-io.ts
runner	316	bench-eval	src/runner/batch/eval/closure-diagnostics.ts
runner	178	bench-eval	src/runner/batch/eval/closure-session.ts
runner	299	bench-eval	src/runner/batch/eval/counterfactual-contract.ts
runner	70	bench-eval	src/runner/batch/eval/counterfactual-risk.ts
runner	190	bench-eval	src/runner/batch/eval/counterfactual-seed.ts
runner	344	bench-eval	src/runner/batch/eval/declared-expected-matcher.ts
runner	107	bench-eval	src/runner/batch/eval/diff-touched-symbols.ts
runner	244	bench-eval	src/runner/batch/eval/driver.ts
runner	402	bench-eval	src/runner/batch/eval/driver/adaptive-evidence.ts
runner	635	bench-eval	src/runner/batch/eval/driver/attempt-context.ts
runner	246	bench-eval	src/runner/batch/eval/driver/candidate-family-ports.ts
runner	857	bench-eval	src/runner/batch/eval/driver/config-build.ts
runner	310	bench-eval	src/runner/batch/eval/driver/context-types.ts
runner	170	bench-eval	src/runner/batch/eval/driver/env-knob-parse.ts
runner	771	bench-eval	src/runner/batch/eval/driver/localize-prep.ts
runner	278	bench-eval	src/runner/batch/eval/driver/prompt-directives.ts
runner	277	bench-eval	src/runner/batch/eval/driver/repair-phase.ts
runner	249	bench-eval	src/runner/batch/eval/driver/repo-source-scan.ts
runner	845	bench-eval	src/runner/batch/eval/driver/repro-test-prep.ts
runner	775	bench-eval	src/runner/batch/eval/driver/result-assembly.ts
runner	120	bench-eval	src/runner/batch/eval/driver/selection-phase.ts
runner	469	bench-eval	src/runner/batch/eval/driver/selection-port-factories.ts
runner	32	bench-eval	src/runner/batch/eval/env-prep.ts
runner	158	bench-eval	src/runner/batch/eval/exec.ts
runner	267	bench-eval	src/runner/batch/eval/family-coverage-coedit.ts
runner	40	bench-eval	src/runner/batch/eval/fault-evidence.ts
runner	109	bench-eval	src/runner/batch/eval/forward-localize-trace.ts
runner	56	bench-eval	src/runner/batch/eval/gold-sanity.ts
runner	408	bench-eval	src/runner/batch/eval/impacted-test-discovery.ts
runner	9	bench-eval	src/runner/batch/eval/index.ts
runner	16	bench-eval	src/runner/batch/eval/kernel/derive.ts
runner	202	bench-eval	src/runner/batch/eval/kernel/eval-step.ts
runner	115	bench-eval	src/runner/batch/eval/kernel/experiments.ts
runner	83	bench-eval	src/runner/batch/eval/kernel/pipeline.ts
runner	37	bench-eval	src/runner/batch/eval/kernel/preset-spec.ts
runner	534	bench-eval	src/runner/batch/eval/kernel/preset-specs.ts
runner	40	bench-eval	src/runner/batch/eval/kernel/steps/env-prep.ts
runner	49	bench-eval	src/runner/batch/eval/kernel/steps/followup.ts
runner	42	bench-eval	src/runner/batch/eval/kernel/steps/localize.ts
runner	42	bench-eval	src/runner/batch/eval/kernel/steps/main-phase.ts
runner	45	bench-eval	src/runner/batch/eval/kernel/steps/repair.ts
runner	43	bench-eval	src/runner/batch/eval/kernel/steps/repro.ts
runner	42	bench-eval	src/runner/batch/eval/kernel/steps/terminal-validate.ts
runner	757	bench-eval	src/runner/batch/eval/knobs-bench.ts
runner	96	bench-eval	src/runner/batch/eval/lane-progress.ts
runner	229	bench-eval	src/runner/batch/eval/llm-candidate-select.ts
runner	91	bench-eval	src/runner/batch/eval/llm-evidence-packet.ts
runner	438	bench-eval	src/runner/batch/eval/llm-evidence-packet/assembly.ts
runner	852	bench-eval	src/runner/batch/eval/llm-evidence-packet/builders.ts
runner	34	bench-eval	src/runner/batch/eval/llm-evidence-packet/clean.ts
runner	119	bench-eval	src/runner/batch/eval/llm-evidence-packet/guards.ts
runner	15	bench-eval	src/runner/batch/eval/llm-evidence-packet/hash.ts
runner	86	bench-eval	src/runner/batch/eval/llm-evidence-packet/policy.ts
runner	154	bench-eval	src/runner/batch/eval/llm-evidence-packet/summarize.ts
runner	56	bench-eval	src/runner/batch/eval/llm-evidence-packet/text-utils.ts
runner	299	types	src/runner/batch/eval/llm-evidence-packet/types.ts
runner	168	bench-eval	src/runner/batch/eval/llm-risk-gate.ts
runner	262	bench-eval	src/runner/batch/eval/location-set-fanout.ts
runner	101	bench-eval	src/runner/batch/eval/mwe-proof-port.ts
runner	165	bench-eval	src/runner/batch/eval/mwe-proof.ts
runner	82	bench-eval	src/runner/batch/eval/no-patch-breaker-adapter.ts
runner	71	bench-eval	src/runner/batch/eval/no-progress-watchdog.ts
runner	54	bench-eval	src/runner/batch/eval/official-grade/index.ts
runner	80	bench-eval	src/runner/batch/eval/official-grade/legacy-buckets.ts
runner	164	bench-eval	src/runner/batch/eval/official-grade/merge.ts
runner	474	bench-eval	src/runner/batch/eval/official-grade/receipt.ts
runner	289	types	src/runner/batch/eval/official-grade/types.ts
runner	34	bench-eval	src/runner/batch/eval/patch-budget-admission.ts
runner	5	bench-eval	src/runner/batch/eval/patch-hygiene.ts
runner	527	bench-eval	src/runner/batch/eval/patch-static-sanity.ts
runner	417	bench-eval	src/runner/batch/eval/posture/capability-profiles.ts
runner	48	bench-eval	src/runner/batch/eval/posture/index.ts
runner	131	bench-eval	src/runner/batch/eval/posture/knob-module.ts
runner	83	bench-eval	src/runner/batch/eval/project-env-python-shim.ts
runner	20	bench-eval	src/runner/batch/eval/prompt-augment.ts
runner	429	bench-eval	src/runner/batch/eval/public-contract-bundle.ts
runner	143	bench-eval	src/runner/batch/eval/public-contract-types.ts
runner	31	bench-eval	src/runner/batch/eval/python-source-text.ts
runner	73	bench-eval	src/runner/batch/eval/regression-oracle-adapter.ts
runner	147	bench-eval	src/runner/batch/eval/regression-oracle.ts
runner	139	bench-eval	src/runner/batch/eval/regression-select.ts
runner	295	bench-eval	src/runner/batch/eval/rematerialize.ts
runner	371	bench-eval	src/runner/batch/eval/repair-breadth.ts
runner	44	bench-eval	src/runner/batch/eval/repair-phase-policy.ts
runner	42	bench-eval	src/runner/batch/eval/repair/candidate-ledger-sink.ts
runner	104	bench-eval	src/runner/batch/eval/repair/candidate-ledger.ts
runner	290	bench-eval	src/runner/batch/eval/repair/context.ts
runner	206	bench-eval	src/runner/batch/eval/repair/decision.ts
runner	479	bench-eval	src/runner/batch/eval/repair/index.ts
runner	245	bench-eval	src/runner/batch/eval/repair/llm-evidence.ts
runner	76	bench-eval	src/runner/batch/eval/repair/pytest-assertion-pin.ts
runner	4	bench-eval	src/runner/batch/eval/repair/pytest-report.ts
runner	419	bench-eval	src/runner/batch/eval/repair/repro-vote.ts
runner	232	bench-eval	src/runner/batch/eval/repair/resolved-consensus.ts
runner	82	bench-eval	src/runner/batch/eval/repair/strong-oracle.ts
runner	465	types	src/runner/batch/eval/repair/types.ts
runner	132	bench-eval	src/runner/batch/eval/repair/validator.ts
runner	69	bench-eval	src/runner/batch/eval/repo-local-verifier-command.ts
runner	713	bench-eval	src/runner/batch/eval/repo-regression-discovery-adapter.ts
runner	204	bench-eval	src/runner/batch/eval/report.ts
runner	188	bench-eval	src/runner/batch/eval/repro-adapter.ts
runner	45	bench-eval	src/runner/batch/eval/repro-artifacts-fs.ts
runner	135	bench-eval	src/runner/batch/eval/repro-artifacts-sink.ts
runner	25	bench-eval	src/runner/batch/eval/repro-artifacts.ts
runner	23	bench-eval	src/runner/batch/eval/repro-command.ts
runner	259	bench-eval	src/runner/batch/eval/repro-grounding.ts
runner	157	bench-eval	src/runner/batch/eval/repro-oracle-calibration.ts
runner	100	bench-eval	src/runner/batch/eval/repro-viability-wire.ts
runner	79	bench-eval	src/runner/batch/eval/repro-viability.ts
runner	385	bench-eval	src/runner/batch/eval/retry-policy.ts
runner	105	bench-eval	src/runner/batch/eval/reviewer-evidence-redact.ts
runner	304	bench-eval	src/runner/batch/eval/run-health.ts
runner	98	bench-eval	src/runner/batch/eval/sandbox.ts
runner	119	bench-eval	src/runner/batch/eval/score-label.ts
runner	301	bench-eval	src/runner/batch/eval/selection-assembly.ts
runner	679	bench-eval	src/runner/batch/eval/selection-executor.ts
runner	889	bench-eval	src/runner/batch/eval/selection-finalize.ts
runner	463	bench-eval	src/runner/batch/eval/selection-gates.ts
runner	35	bench-eval	src/runner/batch/eval/selection-generation-error.ts
runner	82	bench-eval	src/runner/batch/eval/selection-paths.ts
runner	316	bench-eval	src/runner/batch/eval/selection-proof-telemetry.ts
runner	636	bench-eval	src/runner/batch/eval/selection-repair-seed.ts
runner	103	bench-eval	src/runner/batch/eval/selection-risk-gate.ts
runner	257	bench-eval	src/runner/batch/eval/selection-smoke.ts
runner	385	bench-eval	src/runner/batch/eval/selection-types.ts
runner	38	bench-eval	src/runner/batch/eval/session-signal.ts
runner	316	bench-eval	src/runner/batch/eval/snapshot.ts
runner	501	bench-eval	src/runner/batch/eval/static-witness-adapter.ts
runner	26	bench-eval	src/runner/batch/eval/static-witness-contracts.ts
runner	259	bench-eval	src/runner/batch/eval/static-witness.ts
runner	331	bench-eval	src/runner/batch/eval/stream-tap.ts
runner	40	bench-eval	src/runner/batch/eval/strict-risk-gate.ts
runner	149	bench-eval	src/runner/batch/eval/strip-env-manifest-pins.ts
runner	56	bench-eval	src/runner/batch/eval/submission-review.ts
runner	85	bench-eval	src/runner/batch/eval/tentative-patch.ts
runner	243	bench-eval	src/runner/batch/eval/verdict.ts
runner	70	bench-eval	src/runner/batch/eval/verification-module-smoke.ts
runner	577	bench-eval	src/runner/batch/eval/verification-owner-test-expectations.ts
runner	141	bench-eval	src/runner/batch/eval/verification-owner-tests.ts
runner	50	bench-eval	src/runner/batch/eval/vote-key-normalize.ts
runner	228	bench-eval	src/runner/batch/failure-facts.ts
runner	4	bench-eval	src/runner/batch/index.ts
runner	459	bench-eval	src/runner/batch/observe.ts
runner	308	bench-eval	src/runner/batch/official-grade-ingest.ts
runner	24	bench-eval	src/runner/batch/repo-language.ts
runner	71	bench-eval	src/runner/batch/report-decode.ts
runner	319	bench-eval	src/runner/batch/report-envelope.ts
runner	92	bench-eval	src/runner/batch/report-official-grade-coverage.ts
runner	933	bench-eval	src/runner/batch/report-official-grade.ts
runner	659	bench-eval	src/runner/batch/report-terminal.ts
runner	640	bench-eval	src/runner/batch/report.ts
runner	556	types	src/runner/batch/types.ts
runner	295	impl	src/runner/diff-ops.ts
runner	122	impl	src/runner/hunk-apply.ts
runner	284	impl	src/runner/hunk-mutation-journal.ts
runner	32	barrel	src/runner/index.ts
runner	31	knob-module	src/runner/knobs/apply.ts
runner	108	knob-module	src/runner/knobs/derive.ts
runner	45	knob-module	src/runner/knobs/index.ts
runner	14	knob-module	src/runner/knobs/knobs/acceptance.ts
runner	14	knob-module	src/runner/knobs/knobs/adversarial-repro.ts
runner	111	knob-module	src/runner/knobs/knobs/advisor.ts
runner	18	knob-module	src/runner/knobs/knobs/bench-in-loop-exec.ts
runner	56	knob-module	src/runner/knobs/knobs/branch-search.ts
runner	14	knob-module	src/runner/knobs/knobs/cha-multisite-general.ts
runner	14	knob-module	src/runner/knobs/knobs/cha-multisite-steer.ts
runner	63	knob-module	src/runner/knobs/knobs/closeout-critic.ts
runner	58	knob-module	src/runner/knobs/knobs/closeout-guard.ts
runner	14	knob-module	src/runner/knobs/knobs/closure-repair.ts
runner	81	knob-module	src/runner/knobs/knobs/compose-authoring.ts
runner	14	knob-module	src/runner/knobs/knobs/dynamic-message-matcher.ts
runner	21	knob-module	src/runner/knobs/knobs/fault-evidence.ts
runner	14	knob-module	src/runner/knobs/knobs/forward-localize.ts
runner	67	knob-module	src/runner/knobs/knobs/git-directive.ts
runner	50	knob-module	src/runner/knobs/knobs/hooks.ts
runner	37	knob-module	src/runner/knobs/knobs/index.ts
runner	14	knob-module	src/runner/knobs/knobs/issue-hint-expected-actual.ts
runner	18	knob-module	src/runner/knobs/knobs/issue-hint.ts
runner	25	knob-module	src/runner/knobs/knobs/localize-budget.ts
runner	60	knob-module	src/runner/knobs/knobs/localize-phase.ts
runner	14	knob-module	src/runner/knobs/knobs/lsp-cheap.ts
runner	14	knob-module	src/runner/knobs/knobs/lsp-steer.ts
runner	45	knob-module	src/runner/knobs/knobs/lsp.ts
runner	67	knob-module	src/runner/knobs/knobs/mcp-tool-annotations.ts
runner	88	knob-module	src/runner/knobs/knobs/memory-mode.ts
runner	14	knob-module	src/runner/knobs/knobs/model-lane-diversity.ts
runner	71	knob-module	src/runner/knobs/knobs/multi-voter.ts
runner	69	knob-module	src/runner/knobs/knobs/must-pass.ts
runner	169	knob-module	src/runner/knobs/knobs/network-proxy.ts
runner	14	knob-module	src/runner/knobs/knobs/no-patch-breaker.ts
runner	14	knob-module	src/runner/knobs/knobs/no-patch-force-fraction.ts
runner	14	knob-module	src/runner/knobs/knobs/paired-control.ts
runner	14	knob-module	src/runner/knobs/knobs/patch-budget-strict.ts
runner	14	knob-module	src/runner/knobs/knobs/patch-budget.ts
runner	14	knob-module	src/runner/knobs/knobs/patch-hygiene.ts
runner	79	knob-module	src/runner/knobs/knobs/persona.ts
runner	76	knob-module	src/runner/knobs/knobs/policy-merge.ts
runner	14	knob-module	src/runner/knobs/knobs/primary-rail.ts
runner	64	ratelimit-snapshot	src/runner/knobs/knobs/ratelimit-notice.ts
runner	38	knob-module	src/runner/knobs/knobs/read-outline.ts
runner	14	knob-module	src/runner/knobs/knobs/regression-max-tests.ts
runner	14	knob-module	src/runner/knobs/knobs/repair-escalation.ts
runner	78	knob-module	src/runner/knobs/knobs/repo-map.ts
runner	46	knob-module	src/runner/knobs/knobs/repro-doubt.ts
runner	14	knob-module	src/runner/knobs/knobs/repro-exec-timeout.ts
runner	15	knob-module	src/runner/knobs/knobs/repro-grounding.ts
runner	19	knob-module	src/runner/knobs/knobs/repro-test.ts
runner	14	knob-module	src/runner/knobs/knobs/repro-vote.ts
runner	14	knob-module	src/runner/knobs/knobs/retry-transient.ts
runner	17	knob-module	src/runner/knobs/knobs/selector-mode.ts
runner	35	knob-module	src/runner/knobs/knobs/skills.ts
runner	14	knob-module	src/runner/knobs/knobs/spec-fidelity-invariant.ts
runner	14	knob-module	src/runner/knobs/knobs/spec-fidelity-steer.ts
runner	36	knob-module	src/runner/knobs/knobs/subagent.ts
runner	72	knob-module	src/runner/knobs/knobs/task-budget.ts
runner	38	knob-module	src/runner/knobs/knobs/test-runner.ts
runner	14	knob-module	src/runner/knobs/knobs/verification-plan.ts
runner	14	knob-module	src/runner/knobs/knobs/verify-select-concurrency.ts
runner	14	knob-module	src/runner/knobs/knobs/verify-select-counterfactual.ts
runner	14	knob-module	src/runner/knobs/knobs/verify-select-early-accept.ts
runner	17	knob-module	src/runner/knobs/knobs/verify-select-llm-risk-gate.ts
runner	14	knob-module	src/runner/knobs/knobs/verify-select-proof-required.ts
runner	17	knob-module	src/runner/knobs/knobs/verify-select-regression.ts
runner	16	knob-module	src/runner/knobs/knobs/verify-select-repro.ts
runner	14	knob-module	src/runner/knobs/knobs/verify-select-risk-gate.ts
runner	14	knob-module	src/runner/knobs/knobs/verify-select.ts
runner	44	knob-module	src/runner/knobs/knobs/working-state.ts
runner	67	knob-module	src/runner/knobs/memory-mode-parse.ts
runner	107	knob-module	src/runner/knobs/persist.ts
runner	409	knob-module	src/runner/knobs/presets.ts
runner	102	knob-module	src/runner/knobs/register-bench-knobs.ts
runner	69	knob-module	src/runner/knobs/registry.ts
runner	103	knob-module	src/runner/knobs/resolve.ts
runner	166	types	src/runner/knobs/types.ts
runner	71	knob-module	src/runner/knobs/validate.ts
runner	120	turn-orchestrate	src/runner/orchestrate/approval-decision.ts
runner	230	turn-orchestrate	src/runner/orchestrate/crash-resume-wire.ts
runner	75	turn-orchestrate	src/runner/orchestrate/external-prompt-queue.ts
runner	56	turn-orchestrate	src/runner/orchestrate/index.ts
runner	214	turn-orchestrate	src/runner/orchestrate/persist-turn.ts
runner	18	turn-orchestrate	src/runner/orchestrate/prompt-payload.ts
runner	286	turn-orchestrate	src/runner/orchestrate/resume-fsm.ts
runner	121	turn-orchestrate	src/runner/orchestrate/run-once.ts
runner	200	turn-orchestrate	src/runner/orchestrate/session-turn-driver.ts
runner	92	turn-orchestrate	src/runner/orchestrate/worktree-cwd-pin-wire.ts
runner	169	turn-orchestrate	src/runner/orchestrate/worktree-reconcile-wire.ts
runner	274	impl	src/runner/session-execution-plane.ts
runner	523	impl	src/runner/session-memory-auto.ts
runner	222	session-ops	src/runner/session-ops/auto-title.ts
runner	446	session-ops	src/runner/session-ops/current-thread-worktree.ts
runner	972	session-ops	src/runner/session-ops/index.ts
runner	319	session-ops	src/runner/session-ops/list-tui.ts
runner	267	session-ops	src/runner/session-ops/worktree-gc.ts
runner	111	session-ops	src/runner/session-ops/worktree/activity-adapter.ts
runner	140	session-ops	src/runner/session-ops/worktree/live-progress.ts
skill	255	skill-domain	src/skill/activation.ts
skill	52	skill-domain	src/skill/admin-policy-loader-fs.ts
skill	122	skill-domain	src/skill/admin-policy.ts
skill	143	skill-domain	src/skill/audit-log.ts
skill	338	skill-parse-registry	src/skill/discover.ts
skill	240	skill-parse-registry	src/skill/frontmatter.ts
skill	316	barrel	src/skill/index.ts
skill	149	skill-domain	src/skill/install-enforcement.ts
skill	160	skill-domain	src/skill/manifest-compat.ts
skill	213	skill-domain	src/skill/migration.ts
skill	285	playbook	src/skill/playbook/auto-dispatch.ts
skill	215	playbook	src/skill/playbook/disk-registry.ts
skill	211	playbook	src/skill/playbook/dispatcher.ts
skill	235	playbook	src/skill/playbook/frontmatter-parser.ts
skill	66	playbook	src/skill/playbook/host-adapters.ts
skill	116	playbook	src/skill/playbook/index.ts
skill	344	playbook	src/skill/playbook/inline-trigger-watcher.ts
skill	51	playbook	src/skill/playbook/nesting/cycle-detector.ts
skill	159	playbook	src/skill/playbook/nesting/default-executor.ts
skill	26	playbook	src/skill/playbook/nesting/index.ts
skill	57	port	src/skill/playbook/nesting/port.ts
skill	87	types	src/skill/playbook/nesting/types.ts
skill	106	playbook	src/skill/playbook/plan-writeback/default-writeback.ts
skill	25	playbook	src/skill/playbook/plan-writeback/index.ts
skill	51	port	src/skill/playbook/plan-writeback/port.ts
skill	74	types	src/skill/playbook/plan-writeback/types.ts
skill	104	port	src/skill/playbook/port.ts
skill	142	playbook	src/skill/playbook/spec-to-test/default-generator.ts
skill	24	playbook	src/skill/playbook/spec-to-test/index.ts
skill	34	port	src/skill/playbook/spec-to-test/port.ts
skill	75	types	src/skill/playbook/spec-to-test/types.ts
skill	226	playbook	src/skill/playbook/template-literal/default-expander.ts
skill	24	playbook	src/skill/playbook/template-literal/index.ts
skill	37	port	src/skill/playbook/template-literal/port.ts
skill	64	types	src/skill/playbook/template-literal/types.ts
skill	65	playbook	src/skill/playbook/trigger/comment-scanner.ts
skill	68	playbook	src/skill/playbook/trigger/debouncer.ts
skill	201	playbook	src/skill/playbook/trigger/fs-watch-adapter.ts
skill	128	playbook	src/skill/playbook/trigger/headless-stub.ts
skill	42	playbook	src/skill/playbook/trigger/index.ts
skill	71	port	src/skill/playbook/trigger/port.ts
skill	72	types	src/skill/playbook/trigger/types.ts
skill	122	types	src/skill/playbook/types.ts
skill	86	playbook	src/skill/playbook/validator.ts
skill	158	playbook	src/skill/playbook/wire.ts
skill	350	skill-domain	src/skill/plugin-loader.ts
skill	266	skill-domain	src/skill/plugin-manifest.ts
skill	179	skill-domain	src/skill/proposal/compiler.ts
skill	91	port	src/skill/proposal/port.ts
skill	114	skill-domain	src/skill/proposal/promote.ts
skill	111	types	src/skill/proposal/types.ts
skill	119	skill-domain	src/skill/registry-readonly.ts
skill	328	skill-parse-registry	src/skill/registry.ts
skill	245	skill-runtime	src/skill/runtime/actions.ts
skill	203	skill-runtime	src/skill/runtime/adapters/disabled-store-lock.ts
skill	158	skill-runtime	src/skill/runtime/adapters/json-disabled-store.ts
skill	128	skill-runtime	src/skill/runtime/adapters/node-skill-actions.ts
skill	219	skill-runtime	src/skill/runtime/authority.ts
skill	106	skill-runtime	src/skill/runtime/disabled-store-port.ts
skill	70	skill-runtime	src/skill/runtime/index.ts
skill	84	skill-runtime	src/skill/runtime/projections.ts
skill	86	skill-runtime	src/skill/runtime/reader.ts
skill	121	types	src/skill/runtime/types.ts
skill	275	skill-domain	src/skill/skill-creator.ts
skill	788	skill-parse-registry	src/skill/skill-frontmatter.ts
skill	41	skill-domain	src/skill/skill-mcp-deps/index.ts
skill	187	skill-domain	src/skill/skill-mcp-deps/parser.ts
skill	65	skill-domain	src/skill/skill-mcp-deps/resolve.ts
skill	195	skill-domain	src/skill/skill-mcp-deps/session.ts
skill	174	types	src/skill/skill-mcp-deps/types.ts
skill	219	skill-domain	src/skill/skill-resources.ts
skill	50	skill-domain	src/skill/skill-size.ts
skill	429	skill-domain	src/skill/skill-tool.ts
skill	58	skill-domain	src/skill/skill-vs-extension.ts
skill	37	system-skill-embed	src/skill/system-skills/add-tests/index.ts
skill	53	system-skill-embed	src/skill/system-skills/babysit/index.ts
skill	48	system-skill-embed	src/skill/system-skills/blame-section/index.ts
skill	37	system-skill-embed	src/skill/system-skills/debug-error/index.ts
skill	45	system-skill-embed	src/skill/system-skills/debug-trace/index.ts
skill	37	system-skill-embed	src/skill/system-skills/explain-code/index.ts
skill	45	system-skill-embed	src/skill/system-skills/explain-stack-trace/index.ts
skill	37	system-skill-embed	src/skill/system-skills/extract-function/index.ts
skill	39	system-skill-embed	src/skill/system-skills/fix-merge-conflicts/index.ts
skill	39	system-skill-embed	src/skill/system-skills/get-pr-comments/index.ts
skill	40	system-skill-embed	src/skill/system-skills/git-log-search/index.ts
skill	186	system-skill-embed	src/skill/system-skills/index.ts
skill	39	system-skill-embed	src/skill/system-skills/localize-fault/index.ts
skill	38	system-skill-embed	src/skill/system-skills/loop-on-ci/index.ts
skill	40	system-skill-embed	src/skill/system-skills/make-pr-easy-to-review/index.ts
skill	59	system-skill-embed	src/skill/system-skills/manifest.generated.ts
skill	39	system-skill-embed	src/skill/system-skills/new-branch-and-pr/index.ts
skill	39	system-skill-embed	src/skill/system-skills/pr-review-canvas/index.ts
skill	84	system-skill-embed	src/skill/system-skills/progress-audit/index.ts
skill	39	system-skill-embed	src/skill/system-skills/review-and-ship/index.ts
skill	37	system-skill-embed	src/skill/system-skills/rewind/index.ts
skill	17	system-skill-embed	src/skill/system-skills/skill-md-assets.d.ts
skill	321	skill-domain	src/skill/tool-search.ts
skill	217	types	src/skill/types.ts
```


### Colocated tests under E trees (32; not production)

src/llm/empty-stream-breaker.test.ts
src/llm/image-sanitization-retry/__tests__/wrapping.hellgate.test.ts
src/llm/openai-responses-wire-reasoning-usage.test.ts
src/llm/reasoning-effort.test.ts
src/llm/replay/__tests__/s3-replay-store.test.ts
src/llm/stream-progress-trace.test.ts
src/llm/system-prompt-cache/__tests__/drift-detector.hellgate.test.ts
src/llm/system-prompt-cache/__tests__/in-memory-cache.hellgate.test.ts
src/llm/system-prompt-cache/__tests__/port-contract.test.ts
src/runner/batch/corpus/dataset-pro.test.ts
src/runner/batch/corpus/project-env-era.test.ts
src/runner/batch/corpus/selected-test-files-verifier.test.ts
src/runner/batch/eval/__tests__/sandbox-deterministic.test.ts
src/runner/batch/eval/acceptance-evidence.test.ts
src/runner/batch/eval/driver-infra-hole.test.ts
src/runner/batch/eval/driver/calibrated-oracle-fail-open.test.ts
src/runner/batch/eval/driver/config-build-prompt-pack.test.ts
src/runner/batch/eval/knobs-bench-verify-select-escape.test.ts
src/runner/batch/eval/llm-candidate-select.test.ts
src/runner/batch/eval/repair/candidate-ledger.test.ts
src/runner/batch/eval/repro-adapter.test.ts
src/runner/batch/eval/repro-grounding.test.ts
src/runner/batch/eval/repro-oracle-calibration.test.ts
src/runner/batch/eval/reviewer-evidence-redact.test.ts
src/runner/batch/eval/stream-tap.test.ts
src/runner/batch/repo-language.test.ts
src/runner/batch/report-r4.test.ts
src/runner/orchestrate/persist-turn-message-ids.test.ts
src/runner/orchestrate/persist-turn-rollback-interaction.test.ts
src/skill/__tests__/skill-creator.hellgate.test.ts
src/skill/playbook/__tests__/inline-trigger-boundary-hellgate.test.ts
src/skill/proposal/promote-tamper-guard.test.ts


## Terminal status

**DONE** — exclusive E production scope classified on HEAD `0b14f5cf`. Not fixed.
W0 file absent; tracked snapshot hashes stable. Untracked hash moved only by
sibling receipts. Overlay llm/retry excluded from completion claim.
