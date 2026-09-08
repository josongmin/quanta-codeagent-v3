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
| llm | 90 | ~17.5k (17498 @`0b14f5cf` / 17489 @HEAD) | 0 | `openai-responses-wire.ts` 943 |
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
| unit `llm` | 83 |
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

#### E-N7 — **CLOSED at `9b05cd33`** (캠페인 HEAD `0b14f5cf`에서만 재현)

- **Owner (HEAD):** `src/llm/retry/decorator-policy.ts` `retryDispositionForKind`
  - `kind === "auth"` → `"no_retry"`
  - `cyber_policy` / `sandbox_error` / `sandbox_blocked` → `"consult_markers"`
- **Table (HEAD):** `codexSpecRoute` maps those three + `auth` → `hitl_handoff`
- **Consumer:** `src/agent/retry.ts` `isRetryable` — markers on `consult_markers`.
  `RetryingLLM`가 outer `decideTypedStreamError`보다 먼저 재시도.
- **Measured:** HEAD 주석 자체가 `cyber_policy` + `"429"` currently RETRIES.
  `"503 overloaded timeout, try again"` → `isRetryable === true`.
- **랜딩됨:** `9b05cd33`의 `decorator-policy.ts:84`가 `if (action === "hitl_handoff") return "no_retry"`. `src/agent/retry.ts` diff는 주석만 — 이 dump가 예측한 write set 그대로. 오버레이는 더 이상 uncommitted가 아님.
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
- **Measured (실행 확인):** `QUANTA_READ_OUTLINE=yes` → `runtimeConfig().readOutline = true`, knob parse `undefined`, `state.inactive`에 `read-outline` 포함, `liveOverrides = []`.
- **1차 서술 정정:** "bench overlay가 키를 뺀다"는 **거짓**. `applyLiveOverrides`(`config-build.ts:129-133`)는 set-only라 아무것도 지우지 않음 — 기능은 벤치 경로 내내 ON. 실제 잔여 결함은 **telemetry drift**뿐: `state.inactive`가 report.json `knobs.inactive`로 흘러 A/B 리포트가 "돌지 않은 knob"으로 오표기.
- **Negative control:** MCP는 `parseBool` 공유. RATELIMIT은 `ratelimitNoticeWanted`(`parsers.ts:106`) 공유 — 술어는 다르지만 각자 live 채널과 동일하므로 drift 없음.
- **Write:** 두 knob 파일을 `isTruthyToken`/`gateOn`에 맞출 것. **`parseBool`은 `yes`를 똑같이 거부하므로 그쪽에 맞추면 drift가 그대로 남음.** Forbidden: `src/shared/env-flag.ts` (F).

#### E-SEARCH-01 — Explicit vector-store open-fail keeps `state:"ready"`

- **Owner:** `src/runner/assemble/search-index-backend.ts` `buildSemanticBackend`
  (~L825–856)
- **Behavior:** `QUANTA_VECTOR_STORE=sqlite|lance|qdrant` 철자는 맞는데 open 실패
  → per-op `[]` / no-op, **static `state: "ready"`**.
- **Contrast:** 오타 경로는 `newDisabledBackend` `state:"failed"` (T06이 잡는 클래스).
- **Consumers — 결정적 정정:** `SemanticBackendState` / `.state` 리더가 `src/`·`tests/` 전체에 **0**. `search-pipeline.ts`와 host `mention-symbol-deps.ts` **둘 다** `.port`/`.upsert`만 씀. ⇒ `ready`와 `failed`는 행동상 구분 불가이고, 두 경로 모두 port에서 `[]`/no-op으로 동일. **fail-open이 아니라 dead typed-health 필드** — `state` 자신의 doc-comment는 "consumers MUST treat this as a hard config error"라고 약속하지만 그런 소비자가 없음 (E-SKILL-01과 동형).
- **Test honesty:** `tests/unit/runner/t06-search-backend-failclosed-hellgate.test.ts`
  는 **invalid-explicit spelling only**. open-fail `failed` promotion을 지워도 RED 안 됨.
- **Write:** `search-index-backend.ts`, optionally `search-pipeline.ts` refuse on `failed`.

#### E-EMBED-01 — Vendor embed fail mixes 64-dim `hashEmbed` into a live index

- **Owner:** same file, `resolveIndexEmbedder` (~L266–326)
- **Behavior:** recognised provider + `!ok`/throw → same-dim headless, else
  **`hashEmbed` dim 64**.
- **정정 — `capabilities()` catch 경로는 dead:** 레지스트리 4개 provider(openai/voyage/cohere/ollama) 전부 `async capabilities() { return caps }` (I/O 없는 클로저 상수)라 throw하지 않음. 실행 매트릭스: embed err→1536, embed throw→1536, capabilities throw→64(합성으로만), 33KiB+err→64, empty→1536.
- **유일한 live 64-dim 경로**(문서가 지목하지 않았던 것): `fallbackHeadless` → `createHeadlessEmbedder({dim: caps.dim})`의 `maxInputBytes` 기본 32KiB(`headless-stub.ts:15`) 초과 → `input-too-large` → null → `hashEmbed`. 청크가 50줄 윈도(`chunker.ts:22`)라 줄당 ~655B, 즉 minified/generated 파일 한정.
- 또한 `buildVectorStoreRuntime` L623-627이 open 전에 `negotiateCapabilities`를 돌리므로 dim 불일치 store는 애초에 열리지 않음.
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
- **Measured (직접 실행 재현):** `__proto__`는 **양쪽 다 드랍** — skill은 leading-letter key regex로 거절, vendor는 `data["__proto__"]=…`가 프로토타입 대입이라 own key가 안 생김. vendor만 수락하는 건 **`constructor` / `prototype`** 2키.
  - SKILL → `{description, alwaysApply, allowed-tools, globs}`
  - VENDOR metadata → `{"allowed-tools":"Read","constructor":"pwned-ctor","prototype":"pwned-proto"}`
- **소비자 도달성 (1차 서술 정정):** "같은 `.mdc`가 로더에 따라 다르게 파싱됨"은 소비자에 도달하지 않음. ① `composeGlobRulesWithDetected`가 `sourcePath`로 dedup하는데 legacy가 quanta 우선순위(0)로 먼저 앉고 cursor는 1 ⇒ `placeDetectedRule`의 `if (pri >= existing.priority)`에 걸려 vendor 결과는 항상 `collision_lost`. ② 살아남아도 `detectedToGlobRule`(`glob-rules.ts:351-365`)이 `{sourcePath, description?, globs, alwaysApply, body}`만 반환 — **metadata를 버림**. `DetectedRule.metadata` 리더는 repo 전체 0.
  ⇒ vendor 파서가 실제로 쓰이는 건 skill 파서가 안 읽는 `.clinerules` / `.windsurfrules` / `CONVENTIONS.md` / `.roo/rules-*` 뿐 = **이중 파싱 없음**.
- **opt-in:** vendor 반쪽은 `vendorDetectorEnabled` 게이트. 유일 production enabler는 `src/apps/agent/mode-presets/system.ts:73`.
- **Not D8:** D8은 mention first-line (closed). 이건 YAML-ish frontmatter.
- **Write:** vendor normalizer에 forbid+nested 복사, 또는 W2-X fence-legal shared leaf.
  Forbidden: `rules`가 `@/skill` value-import; 검증 없는 `@/shared` 정책 덤프.

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
- **Failure:** user-dir `scope: admin` 스킬이 `installState:"required"`를 유지한 채 scope만 `user`로 덮임 (재현됨: projection이 `{scope:"user", installState:"required"}` 방출). `registry.ts:165` 주석 "Explicit frontmatter still wins"는 **거짓**.
- **단, 표면화되지 않음:** `ManagedSkill.installState` 리더 0 — `skill-tool.ts:278`은 `name`/`enabled`만, `skills-surface.ts`의 `SkillRow`에는 `installState` 필드 자체가 없음. `grep installState src/apps` = 0. ⇒ "관리 UI에 가짜 required"는 **없음**. E-SKILL-01과 동형인 dead projection.
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
| SEP6 N7 | `0b14f5cf`에서 트리거 재현 → E-N7. **`9b05cd33`에 수리가 랜딩되어 현재는 CLOSED.** ID를 새로 만들지 말 것 |
| SEP6 N12 / S8 / S9 | Lane E 밖 |
| SEP5 D8 | mention first-line. `src/shared/mention-text.ts`는 `0b14f5cf`에 **untracked**였고 `9b05cd33`에서 tracked로 랜딩. skill resolver 병합 금지 |
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
- (해소됨) vendor detector `__proto__` 주입 — 실행 완료, 결과는 E-FM-01 참조.
- (해소됨) `QUANTA_READ_OUTLINE=yes` fixture vs knobs-bench — 실행 완료, 결과는 E-KNOB-01 참조.
- `persistTurn` dual-save crash (`--state` + id-mode).
- biome cognitive-complexity / lint-debt 함수 전수.
- `batch/eval/{adaptive-escalation,kernel,repair,official-grade,posture,llm-evidence-packet}`
  본문 전수.
- 68 knob 모듈 중 dual-channel 4 + repo-map 이외.
- `@/retrieval` legacy barrel의 **repo 밖** importer.
- Dirty overlay llm/retry의 CI 영수증 (HEAD 권위 밖). **주의:** "SEP6 closeout이
  overlay를 detached worktree로 검증했다고 문서화되어 있다"는 1차 서술은 인용
  시점에서 거짓 — `0b14f5cf`의 `docs/` 전체에 "detached worktree" 문자열이 없음
  (그 기록은 `9b05cd33`이 추가한 `SEP6-01-hitl-retry-fail-closed.md`에만 존재).

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
3. **E-N7 vs SEP6 closeout — 1차 서술 철회.** "`docs/bugbash/sep-06-solid-se-audit.md`가
   N7을 resolved로 적는다"는 **거짓**: `0b14f5cf`의 그 파일은 N7을 `still / 🟠 p1`로
   적고 "resolved"라는 단어가 **0회**다. 즉 프리즈 시점엔 이 dump와 그 문서가
   **일치**했다. `resolved`는 수리와 같은 커밋(`9b05cd33`)에서 쓰였다. W3는 여전히
   “어느 스냅샷이 캠페인 진실인가”를 한 줄로 고정해야 하지만, 그 근거로 이
   문서 불일치를 들면 안 된다.
4. **형제 레인.** 이 세션 중 `W1-A`…`W1-H` 영수증이 같은 폴더에 쌓였다.
   untracked hash 변동은 그 때문이다. tracked production snapshot은 유지.
5. **구현하지 않음.** 이 agent는 패치/테스트/티켓 파일을 만들지 않았다.
   티켓은 W3-I 소유.
6. 634파일 매니페스트·role 컬럼은 `receipts/W1-E.md` appendix.

---

## 14. One-page index

| ID | Pri | Owner file | One-line |
|---|---|---|---|
| E-N7 | — | `llm/retry/decorator-policy.ts` | **CLOSED at `9b05cd33`** (`:84` `hitl_handoff → no_retry`). `0b14f5cf`에서만 재현 |
| E-KNOB-01 | P3 | `runner/knobs/knobs/read-outline.ts`, `test-runner.ts` | `yes` ∈ gateOn, ∉ knob ENABLING ⇒ report.json `knobs.inactive` 오표기뿐 (기능은 계속 ON) |
| E-SEARCH-01 | P3 | `runner/assemble/search-index-backend.ts` | `SemanticBackend.state` 리더 0 ⇒ dead typed-health 필드. fail-open 아님 |
| E-EMBED-01 | P3 | same, `resolveIndexEmbedder` | 64-dim hash는 headless 32KiB 초과 경로만; `capabilities()` catch 경로는 dead |
| E-FM-01 | P3 | `rules/vendor-detector/normalizer.ts` | vendor가 `constructor`/`prototype` 수락(=`__proto__` 아님). 단 metadata를 소비자가 안 봄 + sourcePath 충돌로 항상 폐기 |
| E-PROV-01 | P2 | `llm/factory.ts` vs `providers/registry.ts` | status anthropic / live bedrock |
| E-PERSIST-01 | P2 | `runner/orchestrate/persist-turn.ts` | usage snapshot can abort persist |
| E-SKILL-01 | P2 | `skill/install-enforcement.ts` | `decideInstall` never called |
| E-SKILL-02 | P3 | `skill/registry.ts` | retag drops frontmatter, keeps installState — 단 `installState` 리더 0 (dead projection) |

**DONE (session classification). Not fixed.**
