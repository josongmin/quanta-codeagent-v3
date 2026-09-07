# Sep-08 SE audit — agent-4 session dump (Lane E)

> **Role:** Sep-07/08 SOLID/SE campaign **Lane E** worker  
> **Scope:** `src/llm`, `src/retrieval`, `src/runner`, `src/skill`, `src/rules`  
> **Machine receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-E.md`](../../plans/sep-7-solid-se-audit/receipts/W1-E.md)  
> **Status of this dump:** classification complete, **not fixed**. Production code was not edited.  
> **Date:** 2026-09-07 → 2026-09-08 (KST)

이 파일은 해당 세션에서 확인한 사실만 남긴다. W2-X / W3-I / 다른 agent가
재현·병합할 때 여기와 W1-E를 같이 본다. 634파일 전체 매니페스트는 W1-E에
있고, 여기에는 발견·증거·재개 금지·쓰기 세트·한계를 모은다.

---

## 1. Assignment and method

```text
AUDIT_ASSIGNMENT|lane=E|scope=llm,retrieval,runner,skill,rules|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-E.md
```

- Read-only. Source / tests / docs / git / GitHub 미수정. 영수증 `W1-E.md`만 작성.
- W0 파일은 세션 시작·종료 모두 **부재**. 코디네이터가 dirty shared checkout에
  Lane E를 바로 배정함.
- 권위는 **committed HEAD only** (`git show HEAD:<path>`). Uncommitted overlay는
  completion claim에 넣지 않음.
- `rg`는 탐색만. 발견은 owner 코드 + reachable consumer 직접 열람.
- SOLID smell without failure mode → inventory. Duplicate는 두 live owner +
  producer-contract-consumer + 측정 drift 또는 dual-write race.
- SEP5 / SEP6 retired ID는 HEAD에서 트리거가 재현될 때만 재개.

병렬 점검: llm / retrieval / runner / skill+rules 서브에이전트 + HEAD 라인카운트
스크립트 + 핫패스(`retry`, `search-index-backend`, knobs, persist-turn,
frontmatter, registry) 직접 재확인.

---

## 2. Snapshot (this session)

| Field | Value |
|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` |
| origin/main | same commit (ahead/behind `0 0`) |
| staged diff SHA-256 | `e3b0c442…` (empty) |
| unstaged tracked diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| inspection start untracked manifest | `230a92807b653c53894a5e04b88aa02b5613fb60197dbbadf8cbe6205809dcb7` (7 files) |
| inspection end untracked (before this dump) | sibling receipts appeared (`W1-C`, `W1-F`, …). Tracked HEAD/diff 불변 → **not STALE** |

Lane E production porcelain (HEAD와 다름, 세션 내내 동일):

```text
 M src/llm/retry/codex-spec-router.ts
 M src/llm/retry/decorator-policy.ts
 M src/llm/retry/port.ts
 M src/llm/retry/too-many-failed-attempts.ts
```

**핵심:** 워킹트리 overlay는 SEP6-01 HITL fail-closed 수리를 이미 담고 있다.
HEAD는 담고 있지 않다. 이 세션의 발견은 HEAD 기준이다. overlay를 커밋하면
E-N7은 그 커밋에서 repaired가 된다. HEAD에 다시 같은 패치를 넣으면 이중 적용.

HEAD vs WT 권위 문서:

| Path | Note |
|---|---|
| `docs/ARCHITECTURE.md` | HEAD `f190b0a2…` / WT `16626624…` — W2/W3 reserved, Lane E 소유 아님 |
| `tests/unit/_arch/slice-boundary-configs.ts` | HEAD `31556028…` / WT `1e570be7…` — 동일 |

---

## 3. Coverage

Exclusive production `*.ts` excluding colocated tests:

| Slice | Files | Approx lines | God-module >1000 | Cohort 900–999 |
|---|---:|---:|---:|---|
| llm | 90 | ~16.8k | 0 | `openai-responses-wire.ts` 943 |
| retrieval | 113 | ~9.7k | 0 | — |
| runner | 322 | ~58.3k | 0 | `session-ops/index.ts` 972, `batch/report-official-grade.ts` 933, `batch/corpus/repo-version-specs.ts` 927 |
| skill | 98 | ~12.9k | 0 | — (`skill-frontmatter.ts` 788) |
| rules | 11 | ~1.9k | 0 | — |
| **total** | **634** | | **0** | **4** |

- Colocated tests under E trees: 32. Total tracked ts in E trees: 666.
- Official god-function allowlist: E 엔트리 없음.
- 전 파일: 라인수 + directory role 분류. 핫패스: owner body + consumer 열람.
- `src/runner/knobs/knobs/*.ts` (68): knob-module로 그룹 분류. 4 dual-channel + repo-map만 본문 확인.
- `src/runner/batch/eval/**`: bench-eval로 분류. risk-gate / knobs-bench / selection-finalize / persist 외 본문 미서술.

미러 테스트 (경로 휴리스틱):

| Bucket | Count |
|---|---:|
| unit `llm` | 84 |
| unit `retrieval` | 27 |
| unit `runner` | 90 |
| unit `skill` | 66 |
| unit `rules`/`repo-rules`/`vendor-detect` | 34 |
| integration E-name | 16 |
| `tests/eval/retrieval` | 7 |

---

## 4. Findings that survive this session

Failure mode 있는 것만. 전부 **pre-existing**. 이 세션이 코드를 악화시키지 않음
(read-only).

### P1

#### E-N7 — HITL kinds still consult message markers on HEAD (SEP6-N7 재현)

- **Owner (HEAD):** `src/llm/retry/decorator-policy.ts` `retryDispositionForKind`
  - `kind === "auth"` → `"no_retry"`
  - `cyber_policy` / `sandbox_error` / `sandbox_blocked` → `"consult_markers"`
- **Table (HEAD):** `codexSpecRoute` maps those three + `auth` → `hitl_handoff`
- **Consumer:** `src/agent/retry.ts` `isRetryable` — markers on `consult_markers`.
  `RetryingLLM`가 outer `decideTypedStreamError`보다 먼저 재시도.
- **Measured:** HEAD 주석 자체가 `cyber_policy` + `"429"` currently RETRIES.
  `"503 overloaded timeout, try again"` → `isRetryable === true`.
- **Overlay:** WT는 `if (action === "hitl_handoff") return "no_retry"` 로 이미 고침.
- **Test honesty:** HEAD hellgate는 legacy consult_markers parity를 **고정**.
  overlay 테스트는 그 계약을 뒤집음.
- **Write:** `src/llm/retry/decorator-policy.ts` only. Forbidden: `src/agent/retry.ts`
  에 두 번째 HITL kind set. overlay가 merge 대상이면 재적용 금지.
- **Not:** agent 이중 kind-set (이미 제거됨). 결함은 decorator projection vs table.

#### E-KNOB-01 — Dual-channel truthy vocab drift (`READ_OUTLINE` / `TEST_RUNNER`)

- **Owner:** `src/runner/knobs/knobs/read-outline.ts`, `test-runner.ts`
  `ENABLING = {"1","on","true"}`
- **Live wire:** `src/shared/env-flag.ts` `GATE_TRUTHY` includes `"yes"` (`gateOn`)
  → `runtimeConfig().readOutline` / `testRunner`
- **Consumer:** `src/runner/batch/eval/knobs-bench.ts` `resolveLiveOverrides`
- **Measured:** `QUANTA_READ_OUTLINE=yes` → runtime **ON**, knob parse **undefined**
  → bench overlay가 키를 빼는데 기능은 이미 켜짐.
- **Negative control:** MCP / RATELIMIT dual-channel knobs는 `parseBool` 공유 → drift 없음.
- **Write:** 두 knob 파일을 `parseBool`/`gateOn`에 맞출 것. Forbidden: `src/shared/env-flag.ts` (F).
- **Proof limit:** token-set + consumer 사이트. process env fixture 미실행.

#### E-SEARCH-01 — Explicit vector-store open-fail keeps `state:"ready"`

- **Owner:** `src/runner/assemble/search-index-backend.ts` `buildSemanticBackend`
  (~L825–856)
- **Behavior:** `QUANTA_VECTOR_STORE=sqlite|lance|qdrant` 철자는 맞는데 open 실패
  → per-op `[]` / no-op, **static `state: "ready"`**.
- **Contrast:** 오타 경로는 `newDisabledBackend` `state:"failed"` (T06이 잡는 클래스).
- **Consumers:** `search-pipeline.ts`; host mention-symbol-deps는 `state`를 안 봄 (G).
- **Test honesty:** `tests/unit/runner/t06-search-backend-failclosed-hellgate.test.ts`
  는 **invalid-explicit spelling only**. open-fail `failed` promotion을 지워도 RED 안 됨.
- **Write:** `search-index-backend.ts`, optionally `search-pipeline.ts` refuse on `failed`.

#### E-EMBED-01 — Vendor embed fail mixes 64-dim `hashEmbed` into a live index

- **Owner:** same file, `resolveIndexEmbedder` (~L266–326)
- **Behavior:** recognised provider + `!ok`/throw → same-dim headless, else
  **`hashEmbed` dim 64**. `capabilities()` catch → `HASH_EMBED_CAPS` (64) while
  `providerLabel` stays `openai|voyage|…`.
- **Consumer:** in-memory cosine `Math.min(lengths)` (~L349–355) + 이미 provider-dim
  을 가진 vector store.
- **Failure:** silent wrong ranking, not empty/fail. Documented “wire never throws”.
- **Not D15:** runner adapt fail-open. 레거시 `embedders/**` 병합 제안 아님.
- **Write:** `resolveIndexEmbedder` fail-closed / same-dim-only / mark `failed`.
  Forbidden: engines Result를 throw로 되돌리기.

#### E-FM-01 — Vendor frontmatter fork omits skill `FORBIDDEN_KEYS`

- **Owners:**
  - `src/skill/frontmatter.ts` — `FORBIDDEN_KEYS` `__proto__`/`constructor`/`prototype`
  - `src/rules/vendor-detector/normalizer.ts` — `data[key]` 직접 할당, forbid 없음,
    nested `metadata.*` 미보존. 주석은 “same subset as `@/skill/frontmatter`”.
- **Consumers:** skill → `discover.ts`; vendor → `src/agent/glob-rules.ts` ADR-0233.
  같은 `.mdc`가 로더에 따라 다르게 파싱됨.
- **Measured drift:** `__proto__:` list key는 vendor에서 수락, skill에서 거절.
- **Not D8:** D8은 mention first-line (closed). 이건 YAML-ish frontmatter.
- **Write:** vendor normalizer에 forbid+nested 복사, 또는 W2-X fence-legal shared leaf.
  Forbidden: `rules`가 `@/skill` value-import; 검증 없는 `@/shared` 정책 덤프.
- **Proof limit:** 소스 비교. hostile `__proto__` fixture 미실행.

### P2

#### E-PROV-01 — Boot/status `pickProvider` vs live `resolveProvider`

- **Two ladders (intentional axes, measured display drift):**
  - `src/llm/factory.ts` `pickProvider`: QUANTA_PROVIDER / ChatGPT token /
    ANTHROPIC_API_KEY / OPENAI_API_KEY → vendor `anthropic|openai|chatgpt-oauth`
  - `src/llm/providers/registry.ts` `resolveProvider` + `provider-router.ts`
    `detectClaudeUseEnv` → cloud transport `bedrock|vertex|foundry|…`
- **Consumers:** status/doctor/eval/terminal/boot → `pickProvider` /
  `resolveBootSelection`. CLI `buildLLM` → `selectLlmTransport` → `resolveProvider`.
- **Measured:** `CLAUDE_CODE_USE_BEDROCK=1` + `ANTHROPIC_API_KEY`, no `QUANTA_PROVIDER`
  → pick **`anthropic`**, resolve **`bedrock`**.
- **Failure:** status/DEFAULT_MODEL[anthropic] vs live Bedrock port.
- **Write:** boot/status가 transport id를 노출하거나 status가 `selectLlmTransport`를
  소비. Forbidden: runner `selectLlmTransport`를 llm로 up-import (DIP).
- **Proof limit:** 선행 테이블 + consumer 사이트. live Bedrock 키 미사용.

#### E-PERSIST-01 — `persistTurn` usage-accounting snapshot unguarded

- **Owner:** `src/runner/orchestrate/persist-turn.ts`
  - `objectiveSnapshot` → `resolveObjectiveSnapshot` try/catch
  - `usageAccountingSnapshot?.()` **unguarded** (~L189–198)
  - path-mode `saveSession` (~L173–180)가 먼저 성공할 수 있음
- **Consumer:** host `persistTurnOrFailStop` — throw 시 세션 fail-stop.
- **Failure:** objective encode는 persist를 못 죽임. usage encode는 죽임.
  path-mode 저장 후 id-mode abort → 부분 dual-channel write.
- **Write:** usage를 objective처럼 가드. Forbidden: `@/session` save engine (D).

#### E-SKILL-01 — `decideInstall` has no production ingress

- **Owner:** `src/skill/install-enforcement.ts` `decideInstall` + barrel.
- **Consumer universe (`src/**`):** definition + `src/skill/index.ts` re-export only.
- **Related G:** CLI `buildCliSkillAuthority`는 `orgConfigDir` null
  (`src/apps/cli/repl/session-setup.ts`).
- **Runtime:** ban/required는 org policy가 로드될 때만 projections에서.
  policy null이면 무력. install/promote 시점 매트릭스는 한 번도 안 탐.
- **Test honesty:** 순수 매트릭스 유닛은 composition call을 증명하지 않음.
  없는 host call을 지워도 RED 안 됨. C-F1(isolated MCP env dead gate)과 동형.
- **Write:** `proposal/promote.ts` / `skill-creator.ts`에서 `decideInstall` 호출.
  Forbidden: CLI session-setup을 E가 고치기 (G / W2-X).

#### E-SKILL-02 — Registry retag vs derived `installState`

- **Owner:** `src/skill/registry.ts` `discoverSkillSourcesIn` L161–170
  - `skillScope(s) !== src.scope` → `{...s, scope: src.scope}`
  - 주석: “Explicit frontmatter still wins”
  - `skillScope` = `s.scope ?? "builtIn"` → frontmatter scope **짐**
- **Failure:** user-dir `scope: admin` 스킬이 `installState:"required"`를 유지한 채
  scope만 `user`로 덮임 → 관리 UI에 가짜 required. 집행은 이름 기준이라 disable
  bypass는 아님. 관측 계약이 거짓.
- **Tests:** retag는 “misinferred → admin”만. frontmatter demotion 없음.
- **Write:** `registry.ts` — 파생 필드 재계산 또는 주석대로 frontmatter 존중.
  Forbidden: mention-runner (D8 closed).

---

## 5. Inventory — smell only, not tickets

세션에서 열었지만 failure ticket으로 올리지 않은 것.

| Item | Why not a finding |
|---|---|
| Residual `consult_markers` for `unknown` / `context_window_exceeded` / `too_many_failed_attempts` / `thread_rollback_failed` | HEAD 의도적 DOF-30 parity. HITL만 E-N7. `isPromptTooLong`이 `isRetryable`보다 앞 |
| D15 dual barrels `embedders/**` vs `engines/embedder`, `rerank/` vs `reranker/` | live wire는 `createEmbedderFromEnv` / `createRerankerFromEnv`. in-repo 레거시 factory 호출 없음. SEP5-11 **conditional**. merge 금지 |
| BM25 Unicode (`lexical/bm25-impl`) vs ASCII (`rerank/bm25-secondary`) | 파일 주석이 다른 axis라고 명시. live search는 engines reranker env factory |
| `assemble/pipeline.ts` duck `!ok` → `[]` / identity rerank | Result 소실. E-EMBED-01에 묶을 수 있음. 단독 ticket은 약함 |
| Implicit store open-fail → in-memory `legacy-fallback` | 주석에 명시. explicit-store 클래스(E-SEARCH-01)와 다름 |
| Orphan retrieval: multimodal / auto-hook / versioning / batching / budget-probe / hybrid-query | `src/` 외부 consumer 없음. catalog maturity 부채 |
| `withFailureCounter` | default-OFF, production wire 없음 |
| llm `sha256Hex` twins (`system-prompt-cache/hash`, `cache-control-audit/hash`) | D14 closed. 구현 동일 |
| Skill frontmatter 3종 (lenient / strict zod / playbook yaml) | consumer 분리. drift 발견은 vendor copy (E-FM-01)뿐 |
| `matchesAnyGlob` (brace 없음, DP+cap) vs `matchesGlobSubset` (brace) | ingress가 다름. 같은 입력 공유 consumer 미증명. W2-X 후보 |
| Cohort 900–999 4파일, 큰 adapter 클래스 | 구조 압력. failure mode 없음 |
| Bench LLM risk-gate `invalidDecision` → `expand: true` on stream-error | 문서화된 “expand under uncertainty”. 의도적 정책 |
| SQLite embed-cache TTL-only unbounded | 스케일 측정 없음. W2-P 후보이지 finding 아님 |

---

## 6. Retired IDs this session did **not** reopen

| ID | Why left closed/conditional |
|---|---|
| SEP6 N7 | **HEAD에서는 트리거 재현 → E-N7로 재개.** overlay에는 이미 수리. ID를 새로 만들지 말고 HEAD vs overlay를 구분 |
| SEP6 N12 / S8 / S9 | Lane E 밖 |
| SEP5 D8 | mention first-line. `src/shared/mention-text.ts` (untracked overlay). skill resolver 병합 금지 |
| SEP5 D12 | rg spawn 3구현, 계약 다름. X-E-RG comparison only |
| SEP5 D14 | fence-local sha256Hex |
| SEP5 D15 merge | dual barrel 유지. live SSOT는 engines. 외부 consumer 증거 전까지 merge 금지 |
| SEP5 D17 | `buildModePresetBase` 트리거 미재현 |
| SEP5 D20 | JSONL stores 계약 상이 |
| SEP5 D21 | CLI/Web boot merge 트리거 미재현 |

---

## 7. Inspected consumers (owner → who reads it)

| E owner | Consumer | Foreign lane |
|---|---|---|
| `retryDispositionForKind` | `agent/retry.ts` `isRetryable`; CLI/runner `RetryingLLM` | A / G |
| `codexSpecRoute` | `agent/recovery.ts` `decideTypedStreamError` | A |
| `pickProvider` | `apps/cli/status-cmd.ts`, `doctor/default-probes.ts`, `boot-selection.ts`, eval, terminal | G |
| `resolveProvider` | `runner/assemble/llm.ts` `selectLlmTransport` → CLI `buildLLM` | G |
| `buildSemanticBackend` / `resolveIndexEmbedder` | `search-pipeline.ts`; host mention-symbol-deps ignores `state` | G |
| `createRerankerFromEnv` | `assemble/pipeline.ts` → `buildSearchPipelineFromEnv` | G |
| read-outline / test-runner knobs | `runtimeConfig()` + `knobs-bench.ts` | F / E |
| `persistTurn` | host turn-runner `persistTurnOrFailStop`; `apps/cli/session-io.ts` | G |
| `createEmbedderFromEnv` | `search-index-backend.ts` | E |
| `skill/frontmatter` | `discover.ts`; agent glob-rules native path | A |
| vendor `normalizer` | `agent/glob-rules.ts` vendor composition | A |
| `decideInstall` | **none** | — |
| registry retag | `assemble/skill.ts`, `build-skills.ts`, CLI skill authority | G |

---

## 8. W2-X fingerprints to merge

`authority / invariant / input / output / state / effect / failure-policy / lifecycle`

| ID | Pair | Ties to |
|---|---|---|
| X-E-RETRY | `codexSpecRoute` ↔ `retryDispositionForKind` ↔ `agent/retry.isRetryable` ↔ `recovery.decideTypedStreamError` | E-N7 |
| X-E-MARKERS | adapter CONTEXT markers ↔ agent PTL_MARKERS ↔ shared error-classifier | context-window 문자열 비대칭 |
| X-E-KIND-BRIDGE | `runtime/os-sandbox/llm-error-bridge` + agent rollback-llm-error-bridge ↔ `codexSpecRoute` | 외 lane이 kind stamp, llm이 소비 |
| X-E-TRANSPORT | `pickProvider` ↔ `resolveProvider` ↔ `selectLlmTransport` | E-PROV-01 |
| X-E-KNOB | runner dual-channel knobs ↔ `gateOn` ↔ config knob-schema | E-KNOB-01 |
| X-E-EMBED | runner `hashEmbed` ↔ retrieval engines ↔ `agent/memory-embedder` | 3스택. D15 barrel은 conditional |
| X-E-RG | retrieval ripgrep ↔ `tool/grep` ↔ `tool/glob` | D12 closed |
| X-E-FM | skill frontmatter ↔ rules vendor normalizer | E-FM-01 |
| X-E-GLOB | `matchesAnyGlob` ↔ playbook `matchesGlobSubset` ↔ agent glob | brace vs DP |
| X-E-INSTALL | `decideInstall` ↔ CLI `orgConfigDir: null` | E-SKILL-01 + G |
| X-E-DELEG | `session-execution-plane.adaptDelegation` ↔ host `resolveDelegation` | parentDepth 이중 seam |
| X-E-D15 | `@/retrieval` legacy names ↔ `@/retrieval/engines` same names | throw vs Result. merge 금지 |

---

## 9. Exact proposed write sets (Lane E only)

| Finding | Allowed | Forbidden |
|---|---|---|
| E-N7 | `src/llm/retry/decorator-policy.ts` | `src/agent/retry.ts` kind sets; overlay 재적용 |
| E-KNOB-01 | `src/runner/knobs/knobs/read-outline.ts`, `test-runner.ts` | `src/shared/env-flag.ts` |
| E-SEARCH-01 | `src/runner/assemble/search-index-backend.ts`, optionally `search-pipeline.ts` | retrieval store internals |
| E-EMBED-01 | `search-index-backend.ts` `resolveIndexEmbedder` | D15 barrel merge; engines throw |
| E-FM-01 | `src/rules/vendor-detector/normalizer.ts` | rules→skill import; unsolicited shared dump |
| E-PROV-01 | `src/llm/factory.ts`, `src/llm/boot-selection.ts` | runner→llm `selectLlmTransport` |
| E-PERSIST-01 | `src/runner/orchestrate/persist-turn.ts` | `@/session` save engine |
| E-SKILL-01 | `src/skill/proposal/promote.ts`, `skill-creator.ts` | `apps/cli/repl/session-setup.ts` |
| E-SKILL-02 | `src/skill/registry.ts` | mention-runner / plugin-app-resolver |

테스트는 W2-M. catalog YAML은 W2/W3.

---

## 10. Bounded no-finding areas (inspected, held)

- Runner DIP: `@/rules` `@/patch` `@/migration` value-import 0.
- llm peer deny + `@/memory/history-sanitization` allow 유지.
- `FallbackLLM` + `isFallbackKind` = table `fallback_provider` 1:1.
- empty-stream breaker → `bad_request`; stream-timeout → `kind:"network"`.
- Explicit `QUANTA_VECTOR_STORE` **typo** → `failed` + T06 (철자 클래스만).
- Retrieval authority ratchet: live factories 필수, retired assembler 없음.
- Skill 30MB size cap + discover skip; plugin-manifest `.strict()` loud fail;
  `RulesStore` LPM; system-skills `manifest.generated.ts` embed.
- MCP/RATELIMIT dual-channel knobs는 `parseBool` 공유.

---

## 11. Uninspected / proof limits

실행하지 않은 것. 정적 발견을 런타임 GREEN으로 덮지 말 것.

- Live Bedrock + `CLAUDE_CODE_USE_*`, Voyage/OpenAI embed 키, Lance/Qdrant open.
- vendor detector에 `__proto__` 주입 실행.
- `QUANTA_READ_OUTLINE=yes` process fixture vs knobs-bench.
- `persistTurn` dual-save crash (`--state` + id-mode).
- biome cognitive-complexity / lint-debt 함수 전수.
- `batch/eval/{adaptive-escalation,kernel,repair,official-grade,posture,llm-evidence-packet}`
  본문 전수.
- 68 knob 모듈 중 dual-channel 4 + repo-map 이외.
- `@/retrieval` legacy barrel의 **repo 밖** importer.
- Dirty overlay llm/retry의 CI 영수증 (HEAD 권위 밖). SEP6 closeout은 overlay를
  detached worktree로 검증했다고 문서화되어 있음.

---

## 12. Slice-group fingerprints (for W2-X role-contract merge)

세션에서 쓴 그룹 역할. 파일 단위 문단은 W1-E 매니페스트.

| Group | Role | Fingerprint gist |
|---|---|---|
| `llm/retry/*` | recovery authority table + decorator projection | kind→action; marker vs typed; per-stream |
| `llm/factory` + `boot-selection` | vendor selection | EnvLike → Provider; boot/status |
| `llm/providers` + `provider-router` | cloud transport selection | CLAUDE_USE quartet; conflict-throw |
| `llm/adapters` + responses-wire | provider LSP adapters | HTTP; LLMError stamp; 943-line cohort |
| `llm/fallback` + empty-stream + timeout + image-sanitize | decorator guards | failure-policy + lifecycle |
| `retrieval/engines/*` | live SSOT embed/store | `Result<>`; `create*FromEnv` |
| `retrieval/embedders/*` | public-compat throw port | D15 conditional |
| `runner/assemble/*` | composition helper | env at surface; fail-open concentrated here |
| `runner/knobs/*` | discovery + layered resolve | import-time registry; 4 dual-channel keys |
| `runner/orchestrate/persist-turn` | per-turn durability | default-OFF; two save channels |
| `runner/batch/eval/*` | SWE-bench harness | expand-under-uncertainty |
| `skill/frontmatter` vs `skill-frontmatter` vs playbook parser | three FM contracts | lenient / strict / playbook-yaml |
| `skill/registry` + runtime authority | snapshot + CAS enable/disable | persist-before-publish |
| `rules` prefix DSL | admissibility command rules | LPM; no_match ≠ error |
| `rules/vendor-detector` | multi-vendor → DetectedRule | inline FM copy |

---

## 13. Process notes for the coordinator / W3-I

1. **W0 없음.** 이 세션은 HEAD `0b14f5cf`를 로컬 freeze했다. 이후 W0가 다른
   HEAD/tracked-diff를 적으면 W1-E와 이 dump는 STALE.
2. **Dirty checkout.** uncommitted 파일을 완료 주장에 넣지 말 것. 특히 llm/retry
   overlay = SEP6-01.
3. **E-N7 vs SEP6 closeout.** `docs/bugbash/sep-06-solid-se-audit.md`는 N7을
   resolved로 적는다. 그건 **overlay + detached worktree CI** 기준이다. 깨끗한
   HEAD tree만 보면 N7은 아직 열려 있다. W3는 “어느 스냅샷이 캠페인 진실인가”
   를 한 줄로 고정해야 한다.
4. **형제 레인.** 이 세션 중 `W1-A`…`W1-H` 영수증이 같은 폴더에 쌓였다.
   untracked hash 변동은 그 때문이다. tracked production snapshot은 유지.
5. **구현하지 않음.** 이 agent는 패치/테스트/티켓 파일을 만들지 않았다.
   티켓은 W3-I 소유.
6. 634파일 매니페스트·role 컬럼은 `receipts/W1-E.md` appendix.

---

## 14. One-page index

| ID | Pri | Owner file | One-line |
|---|---|---|---|
| E-N7 | P1 | `llm/retry/decorator-policy.ts` (HEAD) | HITL + retry-looking msg → auto retry |
| E-KNOB-01 | P1 | `runner/knobs/knobs/read-outline.ts`, `test-runner.ts` | `yes` ∈ gateOn, ∉ knob ENABLING |
| E-SEARCH-01 | P1 | `runner/assemble/search-index-backend.ts` | explicit store open-fail still `ready` |
| E-EMBED-01 | P1 | same, `resolveIndexEmbedder` | fail → 64-dim hash mixed into index |
| E-FM-01 | P1 | `rules/vendor-detector/normalizer.ts` | no `FORBIDDEN_KEYS` vs skill FM |
| E-PROV-01 | P2 | `llm/factory.ts` vs `providers/registry.ts` | status anthropic / live bedrock |
| E-PERSIST-01 | P2 | `runner/orchestrate/persist-turn.ts` | usage snapshot can abort persist |
| E-SKILL-01 | P2 | `skill/install-enforcement.ts` | `decideInstall` never called |
| E-SKILL-02 | P2 | `skill/registry.ts` | retag drops frontmatter, keeps installState |

**DONE (session classification). Not fixed.**
