# 유형별 에이전트 코드 보완 팔로업 (django 231 분석 기반)

분석 결과(231개 type/tier + 하드셋 84 인과검증)에서 **우리 에이전트가 뭘 보완해야 점수가 오르는지**를 유형별로 도출.
각 항목은 (기능) + (왜) + (ROI: 코퍼스 빈도 × 현재 실패율 × 구현난이도).

> 전제: 난이도는 solve-rate 아니라 구조피처로 매김(memorization confound). 아래 ROI의 "빈도"는 django 231 기준이고 django가 Verified의 46%라 전체로도 대표성 큼.

---

## 최종 결론

SOTA++ 접근의 첫 병목은 더 큰 모델 호출이나 더 많은 retry가 아니라 **patch 전에 owner-level evidence를 강제로 만드는 것**이다.

최종 방향:

- `agentless-v1`은 그대로 보존한다.
- 새 측정 posture는 `agentless-v2`로 분리한다.
- `agentless-v2`의 핵심은 `FaultEvidencePacket -> OwnerLocalization -> VerificationPlan -> EscalationPolicy` 순서다.
- django 231은 우선순위 근거일 뿐 runtime routing source가 아니다.
- official resolved를 주장하기 전에 owner metrics와 verification behavior가 먼저 좋아져야 한다.

Non-goals:

- django 전용 file/class/test map.
- hidden/gold/PASS_TO_PASS label 기반 routing.
- `composeAgentlessHint`에 raw source를 계속 덧붙이는 prompt-only 증축.
- branch-search/subagent를 처음부터 default-on으로 켜는 비용 큰 kitchen sink.

---

## 분포 요약 (어디에 화력을 쏠지)

- **Knowledge: K-Domain 188/231 (81%)** ← 압도적. django 내부지식(ORM/compiler/migrations/forms)이 진짜 병목.
- Type: DirectMap 90 / ConstraintReason 62 / DomainBound 50 / DesignRefactor 19 / 기타 10
- Loc: L0 149 / L1 51 (이슈가 위치 거의 다 알려줌) / L3 27 (멀티사이트 조율)
- Tier: T1 15 / T2 69 / T3 56 / T4 74 / T5 17

---

## 설계 원칙

- **벤치 전용 heuristic 금지**: capability는 bench뿐 아니라 일반 repo repair에도 재사용 가능해야 함.
- **django 전용 routing 금지**: django 231은 우선순위 산정용 evidence일 뿐, 구현이 `django.*`, ORM 파일명, 특정 instance ID, 특정 앱 구조를 special-case하면 실패.
- **file-level localize 재발명 금지**: 지금 빠진 건 Stage-1이 아니라 owner localization(file -> symbol -> line)임.
- **prompt blob 금지**: raw source를 프롬프트에 바로 계속 덧붙이지 말고, 먼저 typed artifact를 만든 뒤 각 surface가 예산 안에서 render.
- **측정 무결성 유지**: `agentless-v1`은 frozen preset이므로 새 동작은 in-place mutation 금지. 새 behavior면 `agentless-v2` 또는 새 knob/value로 분리.

---

## Heuristic Boundary

이 계획은 django 분석에서 출발했지만, **django용 heuristic으로 구현하면 안 된다**.

허용되는 정책:

- issue text에 나온 symbol, stack trace, public error message를 추출한다.
- repo에 실제 존재하는 file/definition/outline/caller reference를 근거로 후보를 랭킹한다.
- 후보 confidence가 낮으면 patch를 찍지 않고 evidence collection이나 escalation으로 보낸다.
- touched file, public test naming, owner 주변 테스트를 근거로 verification plan을 만든다.

금지되는 정책:

- `django` package 이름이나 ORM/compiler/forms 같은 domain string으로 고칠 파일을 직접 매핑한다.
- `instance_id`나 known gold patch에서 유래한 route를 둔다.
- `PASS_TO_PASS`, hidden test label, gold patch를 activation authority로 쓴다.
- django hardset에서만 좋아지는 file map, class map, test map을 코드에 박는다.

판정 기준:

- 같은 capability가 `pylint`, `pytest`, `sphinx`, `sympy` smoke에서도 evidence packet을 만들 수 있어야 한다.
- repo type이 달라져도 "무슨 파일을 고칠지"가 아니라 "무슨 공개 증거를 읽을지"만 달라져야 한다.
- django bucket의 통계는 priority와 A/B target을 정하는 데만 쓰고, runtime decision에는 들어가지 않는다.

---

## P0 — Fault Evidence Packet (K-Domain 81% 정조준)

**기능**: Stage-1 localize 뒤에, 추측 대신 **owner 주변의 실제 증거**를 모아 typed packet으로 만든다. 최소 구성은:

- ranked candidate files
- issue text에서 추출된 symbols
- candidate file의 outline / owner symbol 후보
- owner body snippet
- sibling method / same-class 관용구
- caller or reference 1-hop
- repro/test anchor(있으면)

핵심은 "타겟 함수 ±주변 클래스/형제 메서드 강제 열람"이지, 벤치용 RAG 꼼수가 아님.

**왜**: 분석상 231개 중 188개(81%)가 K-Domain. 하드셋 인과검증에서 잡힌 오류도 대부분이 *프레임워크 내부 메커니즘 오인*이었다(패치 대상 클래스 오인, 없는 분기 지어냄 등). 사람도 소스를 안 읽으면 틀리는 문제를 모델이 환각으로 맞출 가능성은 더 낮다.

**ROI**: **최상**. 빈도 81%, 실패기여 큼. 구현도 "새 모델 능력"보다 "증거 수집 구조화" 문제라 상대적으로 싸다.

**주의**: 이걸 `composeAgentlessHint`에 raw source blob으로 바로 밀어 넣는 건 구조가 아니다. `FaultEvidencePacket`을 먼저 만들고, bench prompt는 그 consumer 중 하나로만 둔다.

## P1 — Owner Localization (file -> symbol -> line)

**기능**: 새 file-level localizer를 만드는 게 아니라, 이미 좁혀진 파일 안에서 **정확한 수정 owner**를 핀한다.

- issue text의 symbol 추출
- candidate file 내부 definition hit 랭킹
- outline/LSP symbol로 함수/클래스 경계 확인
- 필요 시 line-level 후보까지 좁힘

탐색 예산은 "정확한 owner를 못 찾으면 더 읽고, 찾으면 바로 repair phase"로 끊는다.

**왜**: 231개 중 200개(86%)가 L0/L1이다. 문제는 대개 "어느 파일인가?"보다 "그 파일 안에서 어디를 고쳐야 하나?" 쪽에 남아 있다. file-level localize가 이미 있는 상황에서 Stage-2 owner pinning이 비어 있으면, 쉬운 케이스도 wrong file/wrong function으로 새어 나간다.

**ROI**: **높음**. 빈도 86%. 구현도 기존 부품 재조합 중심이다.

**주의**: P1을 "이슈텍스트 -> 심볼 직행 localizer"라고 부르면 Stage-1과 경계가 흐려진다. 진짜 빈틈은 Stage-2다.

## P2 — Verification Plan + Overfit Critic

**기능**: 패치 직후 막연한 self-critique 한 번 더가 아니라, **typed verification plan**을 만든다.

- repro test or fail-to-pass anchor
- owner-near tests
- touched module smoke
- public API / adjacent valid-case check

그 위에 advisory critic을 얹어 "special-case 패치인지", "인접 정상 입력을 깨는지"를 본다.

**왜**: ConstraintReason 62개는 올바른 식·조건 합성이 본질이라 overfit 위험이 크다. open-loop 에이전트는 FAIL_TO_PASS 하나 맞추고 끝내는 패턴이 반복된다.

**ROI**: **중상**. 빈도 27%+이지만 failure cost가 크다.

**주의**: 구조적으로는 새 프롬프트보다 기존 verify seam 위에 올려야 한다. `mustPass`는 pass/fail gate, critic은 advisory second opinion 역할이 맞다.

## P3 — Regression-Trap Selection

**기능**: PASS_TO_PASS를 무작위로 넓게 돌리는 게 아니라, **영향면 기준으로 작은 회귀 세트**를 고른다.

- touched module의 기존 테스트
- 같은 public API의 인접 케이스
- owner symbol 주변의 negative/positive pair
- reproducer의 inverse or nearby input

**왜**: django는 P2P가 큰데, gold FAIL_TO_PASS만 맞추고 회귀를 깨면 전체 instance가 실패한다. 특히 L3 / DesignRefactor에서 한 군데만 고치고 끝내면 쉽게 무너진다.

**ROI**: **중**. 빈도는 일부지만 instance-level blast radius가 크다.

**주의**: 이건 "벤치용 추가 테스트 꼼수"가 아니라 verification plan의 일부여야 한다. 선택 근거는 코드 구조와 공개 surface여야지 benchmark hidden label이면 안 된다.

## P4 — Escalation Policy for Multi-Owner / Refactor Cases

**기능**: "한 줄 패치인가, 구조 변경인가"를 감으로 맞히려 하지 말고, **증거 기반 escalation 조건**을 둔다.

- owner 후보가 여러 개로 남음
- evidence packet이 cross-file dependency를 가리킴
- verification divergence가 남음
- single-owner patch가 계속 must-pass를 못 넘김

이때만 multi-owner plan, branch search, subagent, wider review로 escalate한다.

**왜**: DesignRefactor 19개와 L3 27개는 보통 국소 패치 루프에서 망가진다. 문제는 "리팩터 감지 heuristic 부족"이라기보다, escalation 조건이 없어서 wrong abstraction을 계속 파는 데 있다.

**ROI**: **중하**. 빈도는 낮지만 상단 티어 캡을 뚫는 데 필요하다.

---

## 우선순위 (ROI 순)

| 순위 | 기능 | 정조준 유형 | 빈도 | 구현 |
|---|---|---|--:|---|
| **P0** | Fault Evidence Packet | K-Domain | 81% | 중 |
| **P1** | Owner Localization (Stage-2) | L0/L1 | 86% | 중 |
| **P2** | Verification Plan + Overfit Critic | ConstraintReason | 27%+ | 중 |
| **P3** | Regression-Trap Selection | 광 P2P/L3 | 일부·치명 | 중 |
| **P4** | Escalation Policy | DesignRefactor/L3 | 8-12% | 어려움 |

**핵심 한 줄**: django 점수는 "내부지식 환각을 owner-context 증거로 대체"(P0)와 "쉬운 localize를 file 안에서 owner까지 끝내기"(P1)가 큰 덩어리이고, 그 위에서 verification/escalation을 구조화해야 상단티어까지 간다.

---

## 현재 파이프라인 실측 (중복구현 방지)

bench solve path 매핑 결과(`src/apps/bench/` -> `src/runner/batch/eval/driver.ts`):

| 후보 | 실측 verdict | 근거 |
|---|---|---|
| P0 Fault Evidence Packet | **ABSENT** | 현재 agentless hint는 파일명 + 한줄 rationale만 준다. owner body / sibling pattern / caller evidence packet이 없다. |
| P1 Stage-1 file localize | **이미 있음** | `agentlessLocalize`가 file-level localization을 하고, `agentless-v1` preset도 이미 이 축을 켠다. |
| P1 Stage-2 owner localization | **PARTIAL** | symbol extraction, `localize` tool, `read-outline`, LSP-nav 부품은 있지만 "file -> symbol -> line"을 하나의 owner artifact로 묶는 경로가 없다. |
| P2/P3 verification plan | **PARTIAL** | `verifyGuard{mustPass}`는 배선돼 있다. 하지만 bench에서 pre-finish verification planner나 overfit/regression critic은 없다. |
| P4 escalation policy | **PARTIAL** | `localize-phase`, `branch-search`, `subagent` 축은 있으나, owner evidence 실패 시 자동 escalation하는 policy는 없다. |

### 이미 있는 부품

- Stage-1 file-level localization: `src/agent/issue-hint/agentless-localize.ts`
- issue symbol extraction: `src/agent/issue-hint/extract-symbols.ts`
- deterministic line ranking: `src/tool/localize/index.ts`
- localize-first guard: `src/agent/localize-phase-guard.ts`
- outline/repo orientation: `read-outline`, `repo-map`
- must-pass verification gate: `verifyGuard`
- advisory critic seam: `closeout-critic` (core에는 있으나 bench에는 아직 안 태움)

### 결론

- **재발명 금지**: file-level localize 새로 만들 필요 없다.
- **진짜 공백**: `FaultEvidencePacket + OwnerLocalization + VerificationPlan`
- **구조상 주의**: 새 behavior를 `agentless-v1`에 in-place로 얹지 말 것.

### ✅ UPDATE: LSP nav grounding django서 FIXED — 진짜원인=config에 pythonPath 누락

아래 "작동 불가" 결론은 **오진**이었다. 진짜 원인: pyright가 `workspaceFolders` 받으면 `workspace/configuration` pull하는데 **응답에 `pythonPath`가 없어** workspace env를 못 잡고 모든 요청 hang. + `workspace/didChangeConfiguration` push도 필요(VS Code식). 둘 다 주니 **django cross-file go-to-def 0~3초 resolve**(pool open 3s, ValidationError→exceptions.py 10ms). FIX = `pyright.ts buildWorkspaceConfiguration`(pythonPath venv우선+extraPaths:[cwd]+autoSearchPaths) + `base.ts` initialized 후 push. 가드 = `tests/integration/pyright-cross-file-resolution.test.ts`(real pyright, teeth).

#### 🔬 LSP grounding capability 경계 (실측, 과대주장 정정)

"LSP가 symbol-owner ⅓ 푼다"는 **과대주장**이었다. 실 pyright+실 django로 심볼 종류별 측정:

| crux 심볼 종류 | LSP go-to-def | 증거 |
|---|---|---|
| **import된 top-level 심볼** (클래스/예외/함수) | ✅ resolve | FieldDoesNotExist→exceptions.py:L9, Exists→expressions.py:L1588, ValidationError→exceptions.py:L133 |
| **동적객체의 메서드/attribute** (`opts.get_path_to_parent`, `_meta.x`) | ❌ **null** | 15563 linchpin 미해결 — pyright가 `opts`=Options 타입추론 실패(django ORM 동적성) |

**하드(T4/T5) 분류 (측정된 패턴 기반 추정)**: LSP-addressable **16** (crux=import 클래스: 12325·13315·14034·14170·14631·15268·16560 등) vs dynamic-method **36** (LSP 못 풂: 11551·11740·13128·15563 등). 즉 LSP는 하드의 **~31%(symbol-cruxed 중)** 만 닿고, **대다수 K-Domain 케이스(동적 메서드 체인·_meta)는 pyright 타입추론 한계로 grounding 불가** → 그게 SCG(자체 PTA/타입추론)가 필요한 정확한 이유.

> 정정: 위 매핑표 "LSP ✅"는 **import 케이스에만** 유효. behavioral ⅔ + dynamic-method K-Domain은 여전히 SCG 영역.

---

### ~~🔴 RCA: LSP nav grounding은 django에서 작동 불가~~ (오진, 위 UPDATE 참조)

"LSP go-to-def/find-refs로 cross-file 내부 grounding"을 K-Domain 레버로 구현 시도 → 실 pyright+실 django 측정이 전제를 무너뜨림. 근본원인 사슬(전부 실측 확정):

1. `src/lsp/adapters/base.ts` initialize가 **`workspaceFolders` 미전송**(`rootUri`만) → pyright(modern)가 워크스페이스 import 루트 미설정 → 로컬 `django` 패키지 못 찾음 → cross-file definition **instant null**, hover=`(import) X: Unknown`. intra-file 심볼은 poll0 즉시 resolve(루트 불필요).
2. workspaceFolders 추가 → pyright가 `workspace/configuration` 요청 → **`dispatch()`(base.ts:1407)가 server→client 요청 전부 무시** → pyright 블록 → timeout.
3. config 응답해도 → 같은 서버 **108s에도 영원히 timeout**(python env 없이 분석 미완).
4. **아키텍처 킬러**: nav 도구 **call마다 fresh 서버 스폰** → cross-file 1회=django 전체 재인덱싱(100s+) → 에이전트 루프 비현실적.

→ warmup-retry/nudge/aux-cwd/base.ts 핸드셰이크 **전부 revert**(fake-LSP 테스트 green이어도 실환경 무효). 고치려면 풀 핸드셰이크 + **persistent per-task 서버** + 인덱싱 warmup = 대형 투자, pyright 대형레포 latency 잔존 → **보류**.

### 문제 클래스 → 솔루션 레버 매핑

하드셋 84 인과오류(K-Domain 환각 프록시)를 클래스로 나누고, 어떤 레버가 푸는지. **솔루션** 칼럼이 정본.

| 문제 클래스 | 비중 | grep | tree-sitter | LSP(pyright) | SCG(codegraph) | **솔루션 (권장)** |
|---|---|---|---|---|---|---|
| wrong-owner/locus (어느 클래스 메서드냐) | ~⅓ | 🟡근사 | ✅class-context | ❌django실패 | ✅goto-def+CHA | **tree-sitter 즉시 / SCG 정밀** — class-context로 owner 확정 |
| fabricated symbol/branch (없는 분기 환각) | (⅓ 포함) | ❌ | 🟡함수구조 | ❌ | ✅CFG | **SCG CFG**로 분기 실재확인 (tree-sitter는 구조만) |
| behavioral 인과 (값흐름·제어흐름; 15930/16938/15554) | ⅔ 중 大 | ❌ | ❌ | ❌ | ✅CFG/DFG/dataflow | **SCG 전용** — grep/tree-sitter/LSP 전부 불가 |
| multi-site 조율 (L3, 27개) | — | ❌ | ❌ | ❌ | ✅change-impact+callgraph | **SCG change-impact** — 같이 바뀔 사이트 전수 |
| regression/overfit (PASS_TO_PASS 깨짐) | — | ❌ | ❌ | 🟡find-refs(느림) | ✅call graph | **SCG call graph** — "고치면 뭐 깨지나" |
| localization (이슈 심볼→정의) | — | 🟡 | 🟡 | ❌ | ✅import graph | 기존 localize + **SCG import graph** 정밀화 |
| 의도추론 / test-semantics (왜 FAIL_TO_PASS) | ⅔ 잔여 | ❌ | ❌ | ❌ | ❌ | **정적 불가** — 실행/LLM 추론 영역 |

핵심: **symbol-owner ⅓은 tree-sitter로 즉시(latency·설치 벽 없음). behavioral ⅔는 SCG(codegraph) 전용** — CFG/DFG라야 풀림. LSP는 latency 벽으로 django 탈락. SCG는 그 벽을 incremental+persistent index로 설계상 우회하나 **django 실작동 미검증(스파이크 필요)**.

상세 레버 평가: `[[jun-16-lsp-grounding-django-dead-end]]` + semantica-codegraph-v2 `.ai/기능-카탈로그-한글요약.md`.

---

## Runtime Decision Flow

첫 버전의 runtime 흐름은 단순해야 한다.

```text
issue
  -> Stage-1 file localization
  -> FaultEvidencePacket build
  -> OwnerLocalization admission
  -> repair attempt
  -> VerificationPlan execution/observation
  -> EscalationPolicy if unresolved
```

결정 규칙:

- `FaultEvidencePacket.ownerCandidates`가 비어 있으면 기존 flow로 degrade한다.
- high-confidence owner가 1개면 prompt renderer가 그 owner를 "first edit candidate"로 표시한다.
- confidence가 낮거나 owner가 여러 개면 patch target을 강제하지 않고 추가 evidence collection을 우선한다.
- verification required step이 실패하면 `mustPass`가 closeout을 막는다.
- repeated failure 또는 cross-file evidence가 나오면 branch-search/subagent/multi-owner plan으로 escalation한다.

불변식:

- packet builder는 diagnostic oracle을 읽지 않는다.
- renderer는 packet을 요약할 뿐 새로운 ranking authority가 되지 않는다.
- policy는 instance ID, django package name, hidden labels를 분기 조건으로 쓰지 않는다.
- 모든 escalation은 "왜 더 넓혀야 하는지"를 `reason`으로 남긴다.

---

## 권장 구현 단위 (capability 기준)

### 1. FaultEvidencePacket

입력:

- issue text
- Stage-1 ranked files
- extracted symbols
- sandboxed repo checkout

출력:

- `rankedFiles`
- `ownerCandidates`
- `ownerSnippet`
- `siblingPatterns`
- `callerRefs`
- `testAnchors`

consumer:

- bench prompt renderer
- interactive repair assistant
- future reviewer / critic

초안 타입:

```ts
interface FaultEvidencePacket {
  instanceId: string
  issueSymbols: readonly string[]
  rankedFiles: readonly RankedFileEvidence[]
  ownerCandidates: readonly OwnerCandidate[]
  testAnchors: readonly TestAnchor[]
  confidence: "high" | "medium" | "low"
  unresolvedReasons: readonly string[]
}

interface RankedFileEvidence {
  path: string
  source: "agentless-stage1" | "regex-issue-hint" | "localize-tool" | "trace"
  rationale: string
}

interface OwnerCandidate {
  file: string
  symbol: string
  kind: "function" | "class" | "method" | "module" | "unknown"
  startLine: number
  endLine?: number
  evidence: readonly OwnerEvidence[]
}

interface OwnerEvidence {
  kind: "definition-hit" | "issue-symbol" | "sibling-pattern" | "caller-ref" | "outline" | "test-anchor"
  file: string
  line?: number
  snippet: string
}
```

규칙:

- packet builder는 hidden oracle/test labels를 읽지 않는다.
- raw source 전문을 무제한 싣지 않는다. owner body와 sibling/caller snippet은 line/window cap을 둔다.
- `confidence=high`는 owner 후보 1개가 definition + issue symbol + source context 중 2개 이상으로 지지될 때만 준다.
- `confidence=low`면 repair phase로 바로 넘기지 말고 escalation policy 입력으로 보낸다.

### 2. VerificationPlan

입력:

- chosen owner
- touched files
- repro/test anchors

출력:

- `reproStep`
- `ownerNearTests`
- `moduleSmoke`
- `adjacentCases`

enforcement:

- pass/fail은 `mustPass`
- advisory denial은 critic

초안 타입:

```ts
interface VerificationPlan {
  required: readonly VerificationStep[]
  optional: readonly VerificationStep[]
  overfitChecks: readonly OverfitCheck[]
  selectedBy: readonly SelectionReason[]
}

interface VerificationStep {
  id: string
  command: string
  reason: "repro" | "owner-near" | "touched-module" | "public-api" | "smoke"
  timeoutMs: number
}

interface OverfitCheck {
  kind: "literal-hardcode" | "adjacent-valid-case" | "negative-positive-pair" | "api-contract"
  evidence: string
}
```

규칙:

- `required`는 적게 유지한다. first version은 repro 1개 + owner-near 1개 + touched-module smoke 1개를 상한으로 둔다.
- 실패한 `required` step은 `mustPass`로 막고, `optional` 실패는 critic/advisory로만 기록한다.
- command 생성은 benchmark metadata가 아니라 repo 구조, touched files, public test naming에서 나온다.

### 3. RepairEscalationPolicy

트리거:

- owner unresolved
- multi-owner conflict
- repeated must-pass failure
- cross-file evidence 확대

행동:

- 더 넓은 evidence 수집
- branch search
- reviewer/subagent
- multi-site patch plan

초안 타입:

```ts
interface RepairEscalationDecision {
  action: "continue-single-owner" | "collect-more-evidence" | "branch-search" | "reviewer" | "multi-owner-plan"
  reason: string
  nextBudget: { turns?: number; candidates?: number; tests?: number }
}
```

규칙:

- `ownerCandidates.length > 1`이고 confidence가 갈리면 `collect-more-evidence`.
- 같은 owner에서 `mustPass`가 2회 연속 실패하면 `branch-search`.
- cross-file evidence가 2개 이상 나오면 `multi-owner-plan`.
- critic이 high-risk overfit을 반환하면 reviewer 또는 extra verification으로 보낸다.

---

## 구체 실행 로드맵

### PR0 — Diagnostic Rail Only

목표:

- product behavior를 바꾸기 전에 owner-level measurement를 만든다.

작업:

- `picks-10`용 diagnostic oracle JSONL을 만든다.
- 기존 `agentless-v1` run artifact에서 owner diagnostic report를 뽑는다.
- report에는 patch result가 아니라 evidence quality를 기록한다.

산출물:

- `owner_recall@1`
- `owner_recall@3`
- `line_window_recall@50`
- `wrong_abstraction_rate`
- `first_edit_owner_match`

통과 기준:

- diagnostic script가 runtime path와 분리되어 있다.
- oracle JSONL은 evaluation input으로만 쓰인다.
- 기존 bench run behavior가 바뀌지 않는다.

### M0 — 측정 rail 먼저 고정

목표:

- score부터 보지 말고 `owner recall`, `wrong abstraction`, `verification coverage`를 먼저 측정한다.

작업:

- `tests/smoke/swebench/picks-10.jsonl`을 첫 smoke set으로 사용.
- django hardset 84는 후속 validation set으로 둔다.
- 각 instance별로 `gold owner file/symbol`을 수동 또는 기존 분석 md에서 추출해 작은 diagnostic oracle JSONL을 만든다.
- diagnostic oracle은 평가 스크립트 전용이다. runtime packet builder, routing policy, prompt renderer는 이 파일을 로드하면 안 된다.
- official grade와 별개로 local diagnostic report를 만든다.

산출물:

- `owner_recall@1`
- `owner_recall@3`
- `line_window_recall@50`
- `wrong_abstraction_rate`
- `evidence_packet_render_tokens`
- `required_verification_pass_rate`

통과 기준:

- 기존 `agentless-v1` 대비 `owner_recall@1` 상승.
- `wrong_abstraction_rate` 하락.
- packet render가 평균 prompt budget을 과도하게 먹지 않음.

### M1 — FaultEvidencePacket builder

권장 위치:

- core capability: `src/agent/fault-evidence/`
- bench adapter: `src/runner/batch/eval/fault-evidence.ts` 또는 기존 `prepareIssueHint` 주변
- tests: `tests/unit/fault-evidence/*.test.ts`, `tests/unit/bench-fault-evidence-wiring.test.ts`

작업:

- Stage-1 result와 regex fallback을 `RankedFileEvidence`로 정규화.
- `extractSymbols`를 packet 입력으로 연결.
- candidate file에 대해 outline/definition/localize hit를 수집.
- sibling method와 caller refs는 처음엔 deterministic grep/outline 기반으로 제한.
- render는 별도 함수로 분리: packet 생성과 prompt formatting을 분리.

통과 기준:

- no hidden oracle read.
- empty/ambiguous issue에서 fail-open: 기존 regex hint 또는 빈 hint로 degrade.
- same input -> same packet.
- 파일이 없거나 LSP가 없으면 deterministic local evidence만으로 degrade.

첫 PR 범위:

- owner body + sibling/caller까지 한 번에 다 하지 않는다.
- 먼저 `rankedFiles`, `issueSymbols`, `ownerCandidates`, `unresolvedReasons`만 만든다.
- render는 별도 함수로 두되, bench prompt에 넣는 것은 opt-in flag 뒤에 둔다.

### M2 — OwnerLocalization admission

권장 위치:

- policy/helper: `src/agent/fault-evidence/owner-localization.ts`
- bench wiring: `prepareIssueHint` 전후가 아니라 repair 시작 전 context assembly 지점

작업:

- `OwnerCandidate`가 high confidence면 prompt에 "edit owner candidate"로 명시.
- low confidence면 localize-phase를 계속 쓰고, mutating edit 전 추가 evidence collection을 유도.
- owner 후보가 여러 개면 repair phase 진입 전에 conflict를 packet에 남김.

통과 기준:

- owner 후보가 0개면 기존 flow를 깨지 않는다.
- high confidence owner가 있으면 첫 mutating edit의 touched file이 owner file과 일치하는 비율이 오른다.
- line-window recall이 개선된다.

첫 PR 범위:

- edit tool을 강제로 막는 새 guard를 만들지 않는다.
- prompt에 "candidate"로 표시하고, 실제 개선은 `first_edit_owner_match`로 측정한다.
- low confidence는 기존 localize-phase nudging을 유지한다.

### M3 — VerificationPlan wiring

권장 위치:

- planner: `src/agent/verification-plan/`
- bench adapter: `src/runner/batch/eval/verification-plan.ts`
- existing enforcement: `verifyGuard{mustPass}`

작업:

- chosen owner와 touched files에서 owner-near test 후보를 고른다.
- explicit repro가 있으면 required step 1순위로 둔다.
- touched module smoke는 time budget 안에서 1개만 고른다.
- plan을 agent prompt에 싣되, command 실행 여부는 `test_runner`/verify guard가 관찰한다.

통과 기준:

- patch 이후 required verification이 0개인 run 비율이 낮아진다.
- failed verification 후에도 "done"하는 케이스가 `mustPass`로 막힌다.
- optional regression failure는 advisory로 남고 control flow를 과도하게 막지 않는다.

첫 PR 범위:

- command synthesis를 과하게 넓히지 않는다.
- explicit repro가 있으면 그것만 required로 둔다.
- repro가 없으면 touched module smoke 1개만 required로 둔다.

### M4 — EscalationPolicy + preset

권장 위치:

- policy: `src/agent/repair-escalation/`
- bench preset: 새 `agentless-v2`
- report: bench summary에 packet/owner/verification metrics 추가

작업:

- `agentless-v1`은 그대로 둔다.
- `agentless-v2`에 `fault-evidence`, `owner-localization`, `verification-plan`을 켠다.
- branch-search/subagent는 default-on으로 넣지 말고 escalation action으로만 호출한다.

통과 기준:

- `agentless-v1` snapshot test가 변하지 않는다.
- `agentless-v2` report에서 새 metrics가 나온다.
- official Python harness artifact(`report.json`, `predictions.jsonl`)와 local diagnostic report를 함께 비교할 수 있다.

---

## A/B 매트릭스

| 조건 | 목적 | 기대 신호 |
|---|---|---|
| baseline | 현재 default | control |
| agentless-v1 | 기존 SOTA posture | file-level localize 효과 |
| agentless-v1 + packet render only | P0 단독 효과 | owner context 소비 여부 |
| agentless-v1 + owner admission | P1 효과 | first edit owner match |
| agentless-v1 + verification plan | P2/P3 효과 | unverified done 감소 |
| agentless-v2 | 통합 효과 | official resolved 상승 |

주의:

- `agentless-v1` 자체를 바꾸면 A/B가 깨진다.
- local arm64 run은 smoke로만 보고, broad claim은 x86/official harness artifact로만 한다.
- `full-remote done`이나 empty fail list를 resolved improvement로 해석하지 않는다. `report.json` / `predictions.jsonl` / patch artifact가 있어야 한다.

---

## Failure Modes

이 계획이 실패하는 대표 경로:

- packet은 좋아졌지만 agent가 읽지 않는다: prompt renderer가 너무 길거나 owner candidate가 약하게 표시된 경우.
- owner recall은 좋아졌지만 resolved가 안 오른다: repair synthesis 또는 verification feedback loop가 병목.
- resolved는 일부 오르지만 cost가 폭증한다: packet token budget, extra turns, test runtime을 줄여야 한다.
- django에서만 오른다: runtime decision에 django-specific signal이 섞였거나 validation set이 좁다.
- branch-search가 점수를 올리지만 재현성이 떨어진다: escalation trigger가 너무 공격적이다.
- optional regression check가 closeout을 과하게 막는다: optional/advisory와 required/must-pass 경계가 섞인 것이다.

대응:

- owner metric, verification metric, official resolved를 분리해서 본다.
- packet render token budget과 extra turn count를 report에 항상 포함한다.
- bucket별 report를 유지한다: django / pylint / pytest / sphinx / sympy.

---

## SOTA++ 판정 기준

이 계획은 "SOTA++ 가능성"을 여는 구조이지, 문서만으로 SOTA++가 아니다. 판정은 다음 gate를 모두 통과해야 한다.

- owner metrics가 먼저 좋아져야 한다: `owner_recall@1`, `line_window_recall@50`, `wrong_abstraction_rate`.
- verification behavior가 좋아져야 한다: required verification 실행률 상승, failed verify 후 done 감소.
- official harness resolved가 좋아져야 한다: local diagnostic만으로 claim 금지.
- bucket별 개선이 보여야 한다: django뿐 아니라 pylint/pytest/sphinx/sympy 등에서 최소 smoke가 필요.
- 비용이 통제돼야 한다: packet token budget, extra turns, test runtime이 기존 대비 폭증하면 실패.
- hidden-field leakage가 없어야 한다: hidden test labels, gold patch, PASS_TO_PASS oracle을 activation authority로 쓰면 실패.

---

## Go / No-Go

Go:

- `agentless-v1` snapshot이 그대로 유지된다.
- `picks-10`에서 owner metrics가 개선된다.
- packet builder가 diagnostic oracle을 읽지 않는 테스트가 있다.
- `agentless-v2` report에 owner/verification/cost metrics가 나온다.
- 최소 2개 이상의 non-django bucket에서 packet 생성이 정상 동작한다.

No-Go:

- resolved만 보고 owner metric이 나빠진다.
- django-specific routing이 들어간다.
- hidden/gold/PASS_TO_PASS label이 runtime authority가 된다.
- packet 평균 token cost가 커져 compaction/turn budget을 주 병목으로 만든다.
- `agentless-v1` 결과 재현성이 깨진다.

---

## 구현 시 주의

- `composeAgentlessHint`는 renderer여야지 evidence store가 아니다.
- `prepareIssueHint` / prompt prepend는 consumer seam이지, capability의 본체가 아니다.
- `agentless-v1`은 frozen contract다. 새 측정 posture면 `agentless-v2` 또는 새 knob.
- "django에서는 보통 여기" 같은 corpus-conditioned shortcut 금지.
- PASS_TO_PASS 선택은 benchmark hidden labels가 아니라 code structure / public API / touched owner 기준이어야 한다.
- 성공 기준은 bench score만이 아니라, non-bench repo repair에서도 같은 capability가 유효한가다.
