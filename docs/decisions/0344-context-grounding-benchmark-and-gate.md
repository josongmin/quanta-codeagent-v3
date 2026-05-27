# ADR-0344: Context grounding benchmark and release gate

- Status: Accepted
- Date: 2026-05-27
- Related:
  - ADR-0087 Eval schema additive
  - ADR-0182 Prompt cache observability
  - ADR-0338 LLM surface, transport, and checkpoint seams
- Tags:
  - eval
  - benchmark
  - grounding
  - prompt
  - turn-management

## Context

현재 repo는 prompt assembly, turn policy, continuation, prompt-cache observability
쪽은 많이 정리되어 있다. 하지만 agent가 multi-turn history와 active workstream을
올바르게 읽고, 생략된 지시대상과 의도를 복원하는 능력은 별도 benchmark나
release gate가 없다.

이 결손은 다음 실패 형태를 남긴다.

- 잘못된 workstream에 붙는 `wrong-thread` 오판
- 오래된 맥락으로 회귀하는 `stale-context attachment`
- 애매한 질의를 멋대로 단정하는 `should-clarify miss`
- compaction, summary, tool noise 이후 해석이 뒤집히는 `context drift`

예시:

- 직전 흐름이 `prompt rules` 작업인데 사용자가 `이제 다 됐냐?`라고 물었을 때
  이를 현재 작업의 status check로 읽어야 한다.
- 한 세션 안에 여러 작업이 섞여 있을 때 `그거 다시 돌려봐`의 `그거`가 어느
  thread인지 복원해야 한다.
- 후보가 둘 이상이면 멋대로 결정하지 말고 clarification으로 올라가야 한다.

이 능력은 prose quality가 아니라 structured decision quality로 다뤄야 한다.
자유서술 답변 평가는 judge drift와 rubric ambiguity를 키운다.

## Decision

`context grounding`을 별도 benchmark surface로 정의한다. 이 surface는
`agent가 지금 무엇을 가리키는지, 무엇을 묻는지, 얼마나 확실한지, clarification이
필요한지`를 구조화된 label로 평가한다.

평가의 primary artifact는 자연어 응답이 아니라 아래 decision tuple이다.

```ts
type GroundingIntent =
  | "status_check"
  | "execute_change"
  | "explain"
  | "approval_request"
  | "clarify_request"
  | "fact_lookup"

type GroundingScope =
  | "current_workstream"
  | "entire_session"
  | "latest_tool_result"
  | "specific_file"
  | "specific_subthread"

type ConfidenceBand = "high" | "medium" | "low"

interface GroundingDecision {
  activeThreadId: string | null
  referentId: string | null
  intent: GroundingIntent
  scope: GroundingScope
  shouldClarify: boolean
  confidence: ConfidenceBand
}
```

Primary scoring은 closed-label exactness로 한다.

- `thread selection`
- `referent resolution`
- `intent classification`
- `scope classification`
- `clarification decision`

LLM judge는 primary scorer로 금지한다. 필요하면 error clustering과 failure
triage 보조에만 쓴다.

## Corpus model

한 fixture는 transcript와 gold decision, 그리고 failure-class metadata를 가진다.

```ts
interface GroundingExample {
  id: string
  transcript: TurnRecord[]
  userUtterance: string
  gold: GroundingDecision
  bucket:
    | "ellipsis"
    | "reference"
    | "multi_workstream"
    | "topic_switch_return"
    | "tool_noise"
    | "summary_equivalence"
    | "stale_context_trap"
    | "must_clarify"
    | "wrong_thread_adversarial"
  severity: "critical" | "high" | "medium"
  notes?: string
}
```

`transcript`는 raw message dump가 아니라 benchmark에 필요한 최소 structured
state를 가진다.

- role
- thread id
- utterance
- optional tool/result summary
- optional compaction marker
- optional policy marker

이 벤치의 목적은 prompt text 재생이 아니라 conversational state 해석 정확도다.

## Evaluation axes

반드시 분리해서 본다.

- `thread_selection_accuracy`
- `referent_accuracy`
- `intent_accuracy`
- `scope_accuracy`
- `clarify_precision`
- `clarify_recall`
- `wrong_thread_rate`
- `stale_context_attachment_rate`
- `summary_equivalence_rate`
- `exact_tuple_match_rate`

`wrong_thread_rate`와 `must_clarify recall`은 별도 hard gate다. 전체 평균이 높아도
이 둘이 무너지면 ship 금지다.

## Dataset taxonomy

최소한 아래 bucket을 분리한다.

1. `ellipsis`
   - 목적어, 지시대상, 시간 표현이 생략된 질의
2. `reference`
   - `그거`, `이거`, `방금 그거`, `여기서`, `다시` 같은 지시어 중심
3. `multi_workstream`
   - 한 세션 안에 2개 이상 active lane이 공존
4. `topic_switch_return`
   - 중간에 다른 주제로 샜다가 원래 작업으로 복귀
5. `tool_noise`
   - stack trace, command output, code block, screenshot summary 뒤의 질의
6. `summary_equivalence`
   - 원문 transcript와 compacted transcript가 같은 decision을 내야 하는 케이스
7. `stale_context_trap`
   - 예전 작업명이 다시 나타나지만 current focus는 다른 케이스
8. `must_clarify`
   - 후보가 둘 이상이라 의도적으로 물어봐야 하는 케이스
9. `wrong_thread_adversarial`
   - lexical overlap 때문에 오래된 thread로 잘못 붙기 쉬운 케이스

## Gate policy

Gate는 3층으로 나눈다.

1. `schema + scorer hellgate`
   - deterministic
   - CI blocking
2. `canary grounding gate`
   - 작고 curated된 critical corpus
   - release-adjacent blocking
3. `full grounding regression`
   - larger corpus
   - nightly / non-blocking by default

초기 hard gate 기준:

- critical corpus `wrong_thread_rate == 0`
- critical corpus `must_clarify recall == 1.0`
- critical corpus `summary_equivalence_rate >= 0.98`
- critical corpus `thread_selection_accuracy >= 0.97`
- critical corpus `referent_accuracy >= 0.95`
- critical corpus `intent_accuracy >= 0.97`
- critical corpus `scope_accuracy >= 0.97`

Threshold는 empirical baseline 이후 조정 가능하다. 하지만 `wrong_thread`와
`must_clarify miss`는 relaxed metric으로 다루지 않는다.

## Implementation shape

구현은 기존 `bench`가 아니라 `eval` stack 안에 landed 했다.

- `src/apps/eval/grounding/schema.ts`
- `src/apps/eval/grounding/loader.ts`
- `src/apps/eval/grounding/parser.ts`
- `src/apps/eval/grounding/probe.ts`
- `src/apps/eval/grounding/scorer.ts`
- `src/apps/eval/grounding/report.ts`
- `src/apps/eval/grounding/index.ts`
- `src/apps/eval/grounding/cases/canary/*.json`
- `src/apps/eval/grounding/cases/nightly/*.json`

storage/report/taxonomy SSOT도 같이 widened 됐다.

- `src/apps/eval/types.ts` — `EvalTier += "grounding"`
- `src/apps/eval/storage/schema.ts` — `PayloadKind += "grounding"` + `GroundingPayload`
- `src/apps/eval/report/coverage-matrix.ts` — grounding tier rollup
- `src/apps/eval/taxonomy/usecases.ts` — `persistent-context.conversation-state.thread-grounding`

CLI surface:

```sh
bun run eval grounding run --suite canary
bun run eval grounding run --suite nightly
bun run eval grounding report --run-id <id>
```

fixture contract은 v1에서 text-only transcript로 고정한다.

- `history: { role, text }[]`
- optional knobs: `mode`, `cwd`, `memoryContext`, `workingState`, `repoRulesText`, `contextChanges`
- `targetUtterance`
- `gold`
- `bucket`, `severity`, optional `pairId`/`pairRole`

probe는 real prompt assembly path를 직접 탄다.

- `buildTurnContext(...)`
- `LLMPort.stream(...)`
- `tools: []`
- benchmark-only trailing user probe
- balanced-object extraction parser
- stream/parse failure는 `verdict:"error"`로 기록
- live route 문제는 `grounding preflight`가 먼저 분리한다
- live corpora는 bounded concurrency로 실행 가능하다

## Scoring rules

Primary scorer는 exact-match + explicit failure buckets다.

- `thread`: exact
- `referent`: exact
- `intent`: exact
- `scope`: exact
- `shouldClarify`: exact

`confidence`는 calibrational diagnostic이다. 1차 gate에는 포함하지 않는다.

`summary_equivalence`는 pair-scoring으로 계산한다.

- raw transcript decision
- summarized transcript decision
- 두 decision이 같아야 pass

`must_clarify` 케이스는 false positive보다 false negative가 위험하다.
즉, 애매한데도 특정 referent를 찍는 쪽을 더 강하게 벌점 준다.

## Non-goals

이 벤치는 다음을 primary 목표로 두지 않는다.

- model prose quality 평가
- stylistic naturalness 평가
- generic hallucination benchmark 대체
- downstream task success 전체를 대체하는 단일 score

이 벤치는 `context-grounding decision correctness`만 본다.

## Invariants

- prose answer를 gold로 채점하지 않는다
- LLM judge를 source of truth로 쓰지 않는다
- ambiguous gold를 force-choice로 만들지 않는다
- implementation-internal object id에 corpus를 직접 결합하지 않는다
- compaction/summary 여부가 정답을 바꾸면 안 된다
- 평가 대상 model/provider가 바뀌어도 schema와 scorer는 고정한다

## Failure handling

Report는 aggregate score만 내면 안 된다. 최소한 아래 breakdown이 필요하다.

- bucket별 score
- severity별 score
- `wrong_thread` 사례 목록
- `must_clarify miss` 사례 목록
- summary-equivalence regression 목록
- provider/model별 delta

Ship gate에서는 aggregate보다 failure-class presence를 우선한다.

## Rollout

### Landed on 2026-05-27

- `canary` 28-case governed corpus
- `nightly` 52-case governed corpus (`canary + 24 medium`)
- deterministic rails:
  - schema parse/validation
  - parser tolerant JSON extraction
  - scorer hellgate
  - summary-pair governance
  - result-store roundtrip
  - report aggregation
  - CLI dispatch/help wiring
- live workflow:
  - `.github/workflows/grounding-live-gate.yml`
  - labeled PR/manual canary gate
  - cron-driven nightly regression
  - read-only permissions
  - JSONL + markdown + JSON artifact upload

### Remaining follow-up

- production miss bank append-only ingest
- provider/model delta trend surfacing beyond per-run metadata
- optional future schema bump for native multimodal/tool-result fixtures

## Tradeoffs

- structured-label benchmark는 자연어 richness를 버리는 대신 reproducibility를 얻는다
- strict gate는 모델 업그레이드 속도를 늦추는 대신 wrong-thread class regression을 줄인다
- hand-authored corpus는 비용이 크지만, judge-based auto-label보다 authority가 높다

## Alternatives considered

### 1. Free-form answer + LLM judge

기각.

- rubric drift
- exact failure class 추적 어려움
- must-clarify 같은 fail-closed policy를 강제하기 어려움

### 2. Task success benchmark로 대체

기각.

- grounding failure가 downstream retries와 verbosity에 가려진다
- 어떤 단계에서 잘못 붙었는지 추적이 어렵다

### 3. Offline heuristic-only scorer

부분 채택.

Scorer 자체는 heuristic/exact label 기반이 맞다. 하지만 corpus authoring은
human-owned여야 한다.

## Decision consequences

이 RFC를 따르면 `말귀를 잘 알아먹는다`는 모호한 감상을 다음으로 분해할 수 있다.

- 현재 active thread를 맞추는가
- 생략된 referent를 복원하는가
- 질문 intent를 맞추는가
- 애매하면 멈추고 clarification 하는가
- compaction과 noise 이후에도 위 판단이 유지되는가

즉, 평가 대상을 prose fluency가 아니라 fail-closed conversational grounding으로
강제할 수 있다.

## Follow-up

- production miss bank를 governed corpus에 append-only로 흡수
- paired raw/summary corpus를 실제 compaction miss bank와 연결
- fork PR에서 secrets를 쓸 수 없다는 GitHub constraint를 고려한 operator runbook 유지
