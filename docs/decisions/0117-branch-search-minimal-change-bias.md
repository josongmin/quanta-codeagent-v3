# ADR-0117: Branch-search minimal-change bias + CLI progress surface

- **상태**: Accepted (구현 + 25-case hellgate 봉인)
- **날짜**: 2026-05-24
- **관련 ADRs**: ADR-0084 (speculative branch search), ADR-0116 (Shadow ODB anchor — provides per-candidate `delta`)
- **참조**:
  - `src/agent/branch-search/verify.ts` — `patchSizeVerifier()` 신규 factory
  - `src/agent/branch-search/score.ts` — `minimalChangeSelector()` 신규 selector
  - `src/agent/branch-search/progress.ts` — pure `formatBranchTrace` 포맷터 (신규 파일, plane-clean)
  - `src/agent/branch-search/tool.ts` — `patch_size` 자동 부착 + 기본 selector 교체
  - `src/agent/branch-search-runner.ts` — `onProgress` adapter wiring
  - `src/agent/types.ts` — `AgentConfig.onProgress` 상위 슬롯 + `FeaturesConfig` 확장
  - `tests/unit/branch-search-minimal-change-hellgate.test.ts` — 25 case

## Context

ADR-0116 으로 branch-search 후보마다 `BranchCandidate.delta` (Shadow ODB 기반 `{changedFiles, addedLines, removedLines}`) 가 *측정* 되기 시작했다. 그런데 정작 selection 에 **흐르지 않았다**:

1. `VerifierKind` 에 `"patch_size"` 가 이미 enum 으로 등록되어 있고,
2. `DEFAULT_WEIGHTS` 에도 `patch_size: 0.1` 이 박혀 있고,
3. `PENALTY_KINDS` 에도 `patch_size` 가 (penalty 로 빼는) 등록되어 있는데,
4. **`patchSizeVerifier()` factory가 없어** 어떤 후보에서도 `patch_size` 시그널이 생성되지 않았다.

또한 CLI 가 branch-search 진행 상황 (어떤 후보가 시작/종료/실패/scored/winner) 을 사람이 읽을 수 있게 surface 하는 경로가 0 이었다 — `BranchTraceEvent` 는 OTel 싱크로만 흘러 들어갔다.

본 ADR 은 위 두 갭을 동시에 메운다. ADR-0116 의 측정 인프라가 비로소 selection 에 *흐르도록* 결선 (Part 1–3) 하고, 후보 진행 상황이 CLI 에 *흐르도록* 결선 (Part 4–5) 한다.

## Decision

5 part. 전부 default-OFF — anchor 미배선 시 patch_size 시그널이 magnitude 0 (penalty 0 = 점수 무변화), `onProgress` 미배선 시 trace adapter 미설치 (byte-identical).

### Part 1 — `patchSizeVerifier()` in `verify.ts`

`cand.delta` 가 있으면 `magnitude = min(1, log10(1 + added+removed) / 3)` 로 정규화된 단일 `patch_size` PENALTY 시그널 생성. `cand.delta` 가 OMIT 이면 magnitude 0 + detail `"no-delta"` — penalty 기여 0 이므로 reward 무영향 (byte-identical-when-absent). `pass` 는 **항상 true** (size 는 gate 가 아니라 quality axis).

Magnitude 곡선 보정 메모: `log10(1+total)/3` 은 1–20 라인이 [0, 0.4], 20–200 라인이 [0.4, 0.75], 200+ 이 ~1 에 근접하도록 calibrate. /3 divisor 는 ~1000 라인에서 saturate (그 이상 patch 는 일률적으로 나쁘다는 경험적 관찰과 일치).

### Part 2 — Auto-add `patch_size` kind when anchor wired (`tool.ts`)

`branchSearchTool.execute()` 가 `verifier_kinds` resolved list 에 `"patch_size"` 가 없고 `deps.anchor !== undefined` 면 자동 추가 (dedupe). 이로써 ADR-0116 anchor 가 박힌 *순간* minimal-change bias 가 자동 활성화. 입력 스키마 `verifier_kinds` enum 은 그대로 `["tsc","test","lint","lsp_diag"]` — `patch_size` 는 내부/auto kind 이고 LLM 이 요청하지 않는다 (surface 좁게).

`buildVerifier` signature 의 `Exclude<VerifierKind, "patch_size" | "llm_judge">` 는 `Exclude<VerifierKind, "llm_judge">` 로 완화 (patch_size 만 허용 복귀, llm_judge 는 별도 시밍).

### Part 3 — `minimalChangeSelector()` in `score.ts`

`argmaxSelector` 를 wrap. base winner 와 `epsilon=1e-6` 내 tie 인 모든 후보를 모은 뒤, total `delta` (added+removed) 가 가장 작은 후보를 선택. delta 미부착 = `+Infinity` (delta 있는 후보에 무조건 짐). 단일 winner 인 경우 base 결과를 그대로 반환 — **tie 가 실제로 존재할 때만 동작이 바뀐다**.

Pure + deterministic. `+Inf - +Inf = NaN` 으로 인한 비결정 sort 를 막기 위해 `da !== db` 가드 후 `da - db`; 동률은 baseWinner first → lexicographic id 로 fall-through.

`branchSearchTool` 의 기본 selector 를 `argmaxSelector` 에서 `minimalChangeSelector()` 로 교체.

### Part 4 — `progress.ts` — pure formatter

Plane-clean (`./types` 만 import) 모듈. 단일 export `formatBranchTrace(event, opts?) → { text, severity }`.

- 변형별 prefix: `▶` started / `✓` finished / `✗` failed / `·` scored / `Δ` delta / `★` winner / `⚠` anchor (id=="anchor"의 candidate-failed 분리 처리).
- `useUnicode: false` → ASCII fallback (`>` `+` `!` `.` `D` `*` `!`).
- `colors: true` → severity-별 ANSI: info=무색, success=`\x1b[32m`, warning=`\x1b[33m`, error=`\x1b[31m`.
- `turns`/`files` 단/복수 명시. score 는 `toFixed(3)` (Cursor 컨벤션 일치).

### Part 5 — Runner wiring (`branch-search-runner.ts` + `AgentConfig.onProgress`)

`AgentConfig` 에 `onProgress?: (line: ProgressLine) => void` 상위 슬롯 신설. `FeaturesConfig` Pick 에도 추가.

`buildBranchSearchTool` 에 `buildBranchProgressTrace(config)` 분기 추가 — `config.onProgress` 있으면 `(event) => onProgress(formatBranchTrace(event))` try/catch wrap 된 어댑터 반환 (없으면 `undefined`). 그 결과를 condition-spread (`...(onTrace ? { onTrace } : {})`) 로 tool deps 에 주입.

host callback 이 throw 해도 search 가 깨지지 않는다 (OTel sink 와 동일 계약).

## Default-OFF 자리

| 슬롯              | 미설정 시 결과                                                |
| ----------------- | ------------------------------------------------------------- |
| `shadowOdb`       | anchor 미생성 → `patch_size` 자동 부착 분기도 미발동          |
| `patch_size` 시그널 | anchor 부착해도 `delta` 미측정 시 magnitude 0 = penalty 0    |
| `verifier_kinds`  | enum 에 `patch_size` 없음 — LLM 이 끌어들일 수 없음             |
| `minimalChangeSelector` | 단일 winner / 비-tie 입력에 대해 base selector 결과와 동일 |
| `onProgress`      | adapter 미설치 → `onTrace` slot OMITTED, byte-identical       |

## Hellgate (25 case)

- **A. `patchSizeVerifier`** (5): `delta` OMIT/zero/small/large/pluralization.
- **B. scorer 통합** (4): magnitude 0 = baseline; magnitude 0.5 < magnitude 0 (penalty 우위); weight 0 = 무시; patch_size only → total clamp 0.
- **C. `minimalChangeSelector`** (5): 단일 후보; exact tie smaller-delta wins; tie + delta-vs-omit; epsilon boundary strict `<`; all-omit no-false-promotion.
- **D. progress formatter** (8): 모든 variant 의 prefix/severity/단복수/`toFixed(3)`/anchor distinct/ANSI/determinism.
- **E. runner wiring** (3): `onProgress` 부재 → base sink unchanged; 단일 onProgress → ProgressLine 순서; 양쪽 wired → 둘 다 호출.

`bun test` 25/25 pass; ADR-0084 (24-case) + ADR-0116 (18-case) 와 합쳐 67/67 pass / 139 expects.

## Alternatives rejected

- **"patch size > N 라인이면 hard fail"** — gate 로 만들면 LLM 이 override 할 여지가 사라지고, smallest-delta 가 *압도적이지 않은* (예: 잘 작성된 큰 리팩터) 경우를 잘못 깎는다. quality axis 로 두는 편이 미래에 mode 별 weight 로 조절하기도 쉽다.
- **`verifier_kinds` enum 에 `patch_size` 추가해서 LLM 이 요청 가능하게**  — LLM surface 확장 = 입력 contract 부담 + 잘못 끄거나 켜는 길. anchor 기반 auto-wire 가 host policy 만으로 결정되므로 더 깔끔.
- **ANSI color hard-coded** — 헤드리스 환경에 강제. `opts.colors` 로 opt-in 유지.
- **`Selector` 합성을 functor 패턴 (compose 등) 로 일반화** — 현재 시밍 1개에 over-engineer. 필요 시 ADR-0117+1 에서 도입.

## SOTA++ 자리매김

| 시스템      | minimal-change axis              |
| ----------- | --------------------------------- |
| Cursor 3.2  | 없음 (단일 trajectory + winner-applies-only) |
| Codex 0.131 | 없음 (subagent 결과 reviewer-tier 만)        |
| Claude Code 2.1 | 없음 (sub-agent 결과 LLM judge 만)        |
| **quanta**  | **있음** — anchor-gated, 자동 부착, tie-only behavior change |

CLI 진행 surface 도 동일: Cursor 는 status-bar 만, Codex 는 OTel 만, Claude 는 stream 만 — 우리는 host-callback + pure formatter 분리.

## Follow-up

- **per-mode weight tuning** — `BranchSearchConfig.weights` 의 `patch_size` 를 mode (refactor / hotfix / spike) 별 preset 으로 분리. 현재 0.1 은 모든 mode 공통 (conservative).
- **magnitude 곡선 calibration** — `log10(1+total)/3` 은 직관 기반. 운영 corpus (SWE-bench Verified 결선 winner들의 patch size 분포) 를 모으면 더 정확한 곡선으로 교체.
- **trace event 확장** — 현재 `candidate-failed` 의 `id="anchor"` 재사용으로 anchor 실패를 표현. 향후 `anchor-registration-failed` 분리 variant 가 더 깔끔할 수 있음 (단, 변경 시 progress.ts 도 추적).
