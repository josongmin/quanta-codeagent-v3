# agentless-v3-thin-strict-gated — counterfactual select plan

## 목적

최종 SOTA++ 방향은 LLM gate 기본화가 아니다.

목표는 `agentless-v3-thin-strict-gated`를 다음 구조로 진화시키는 것이다.

```
thin cand0
  -> structural risk facts + cheap validation
  -> low-risk validated accept OR counterfactual cand1
  -> late selector / validation authority
  -> optional critic only after N grows
```

즉, 현재의 owner-file focused rerun을 유지하되 cand1을 단순 재시도가 아니라
**cand0 실패 형태의 반대 제약을 가진 minimal alternative**로 만든다.

## 최신 코드 기준 사실

> Authority update: this plan is superseded for selector authority by
> [`jun-21-heuristic-authority-cleanup`](../jun-21-heuristic-authority-cleanup/README.md).
> Counterfactual generation remains useful, but `declaredExpected`, issue smoke, and
> discovered regression are no longer acceptable clean hard-gate authority.

- 현재 후보 생성은 full agent rerun이다. `generateSelectionCandidate()`가 각 후보마다
  `runAgentPhase()`를 호출하고, `runAgentPhase()`는 `withGitSnapshot()`으로 후보 사이 트리를
  reset한다.
  - `src/runner/batch/eval/driver.ts:1897`
  - `src/runner/batch/eval/driver.ts:2255`
  - `src/runner/batch/eval/driver.ts:2311`
- 현재 seed는 owner-focus 한 줄이다. cand0는 seed 없음, cand1+는 ranked owner file 하나에
  집중하라는 hint만 받는다.
  - `src/runner/batch/eval/selection-executor.ts:271`
- 현재 gated sequential loop는 cand0 risk gate가 `expand=false`면 `staticAccept()`로 바로 끝낸다.
  - `src/runner/batch/eval/selection-executor.ts:693`
- 현재 `staticAccept()`는 `applyClean`, `regressionGreen`, `smokeGreen`,
  `patchedResolvedKofN`를 모두 `null`로 둔다. `declaredExpected`만 부분 반영한다.
  - `src/runner/batch/eval/selection-executor.ts:545`
- structural risk gate는 `analyzePatchBudget()` 기반이며 empty patch, source-file budget,
  new-def, runtime-expanding 등을 expansion reason으로 만든다.
  - `src/runner/batch/eval/strict-risk-gate.ts:25`
  - `src/agent/patch-budget/index.ts:128`
- LLM risk gate는 이미 optional arm으로 있다. `shadow`는 telemetry only, `on`은 semantic
  expand authority를 가진다. 기본 `agentless-v3-thin-strict-gated`에는 없다.
  - `src/runner/batch/eval/selection-risk-gate.ts:50`
  - `src/runner/batch/eval/llm-risk-gate.ts:4`
  - `src/runner/knobs/presets.ts:259`

## 외부 정렬

- Agentless: 복잡한 autonomous loop보다 localization -> repair -> patch validation의 단순
  pipeline을 강조한다. 기본 round-0는 thin해야 한다.
  - https://arxiv.org/abs/2407.01489
- SWE-agent: 핵심은 두꺼운 planner가 아니라 agent가 잘 쓰는 interface/tooling이다.
  - https://arxiv.org/abs/2405.15793
- OpenHands: inference-time scaling은 여러 complete trajectory를 만든 뒤 critic/selector가
  고르는 방향이다. critic은 candidate 품질 이후 단계다.
  - https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model
- SWE-bench Live: static SWE-bench 과적합/contamination risk를 명시한다. leaderboard score를
  직접 최적화하는 scaffold 증식은 위험하다.
  - https://arxiv.org/html/2505.23419v2
  - https://www.swebench.com/

## 불변식

- round-0는 thin/noexec/source-only/minimal first.
- risk gate는 "후보를 더 만들지"만 결정한다. correctness authority가 아니다.
- low-risk cand0도 blind accept하지 않는다. 최소 `applyClean`은 확인한다.
- `declaredExpected`, issue smoke, discovered regression은 clean cheap validation authority가 아니다.
  이 신호들은 research/telemetry 또는 witness generation으로만 쓴다.
- cand1은 owner hint만 받는 재시도가 아니라 counterfactual seed를 받는다.
- 전역 patch-budget hard reject는 금지한다. 맞는 large patch를 죽일 수 있다.
- 단, counterfactual candidate가 자기 계약을 어기면 selector에서 강하게 내린다.
- LLM semantic gate는 `shadow -> on` 승격 데이터가 쌓이기 전까지 기본값이 아니다.
- critic/reranker는 N=3~5 이상에서만 붙인다. N=2에서는 cand1 품질이 먼저다.

## 운영 제약 (silent no-op 방지)

counterfactual arm은 다음 두 조건이 충족돼야 engage한다. 기존 risk gate와 동일한 제약이며,
프리셋이 이미 둘 다 고정하므로 정상 경로에서는 항상 만족된다. 수동 env override로 깨면 경고
없이 inert가 되므로 주의한다.

- `verify-select-concurrency=1` (sequential). risk gate/counterfactual seam은 cand0 이후
  순차 분기에서만 돈다. concurrency>1이면 cand0 gate 자체가 안 돌아 counterfactual도 inert.
- `verify-select-risk-gate=1` (structural). structural gate가 `patchBudget`를 실어 보내야
  facts/seed가 생긴다. risk-gate=0 + llm-risk-gate만 켜면 `patchBudget`가 없어 seed 미생성.

counterfactual seed는 cand1에만 적용한다. cand2+는 owner-focus seed를 유지해 fix-site 다양성을
보존한다 (N copies of one seed 방지). counterfactual contract는 cand1에만 바인딩된다.

## 목표 arm

새 실험 arm:

- `agentless-v3-thin-strict-counterfactual-shadow`
- `agentless-v3-thin-strict-counterfactual`

기본 shape:

```
agentless-v3-thin-strict-gated
+ cheap static accept validation
+ cand0 risk facts
+ counterfactual cand1 seed
+ counterfactual contract scoring
+ optional llm-risk shadow
```

## 측정 지표

- gate trigger rate
- cand1 generated count
- cand1 wins over cand0
- resolved delta
- turns delta
- patch bytes delta
- multi-file rate
- added-def rate
- runtime-expanding-call rate
- false expansion rate
- low-risk cand0 validation reject rate
- LLM shadow precision / missed semantic risk / extra-candidate win-rate

## 티켓

- [T-101 — cheap validation accept](tickets/T-101-cheap-validation-accept.md)
- [T-201 — cand0 risk facts contract](tickets/T-201-cand0-risk-facts-contract.md)
- [T-202 — counterfactual candidate seed](tickets/T-202-counterfactual-candidate-seed.md)
- [T-301 — counterfactual contract in selector](tickets/T-301-counterfactual-contract-selector.md)
- [T-401 — presets and telemetry](tickets/T-401-presets-telemetry.md)
- [T-501 — optional critic late](tickets/T-501-optional-critic-late.md)
