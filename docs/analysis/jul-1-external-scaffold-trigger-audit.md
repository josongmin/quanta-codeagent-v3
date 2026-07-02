# jul-1 -- 외부 스캐폴드 트리거 감사 (SOTA++ 얼라인 근거)

> 범위: 외부 스캐폴드만. Quanta 제외.
> **축 한정: 이 문서는 `patch-candidate breadth/retry 선택 축`만 다룬다.** 즉 "여러 후보를
> 생성/재시도하고 그중 고르는" 동작만. 아래 "범위 밖 트리거 클래스"(compaction, model
> fallback/reroute, effort 상승, per-step 샘플링/requery, subagent spawn)는 별도이며 여기서
> 완결되지 않는다 — 완전한 트리거 맵이 아니라 breadth-family 분류용이다.
> 리뷰 방식: 적대적 감사, 증거 우선.
> 증거 규칙: 각 행은 `source-confirmed`, `bundle-only`, `unverified` 중 하나로 표기한다.

## TL;DR

- 외부 스캐폴드들이 하나의 공통 문제 해결 전략으로 수렴한다고 보기 어렵다.
- 소스 기준으로 확정 가능한 큰 축은 두 개다.
  - `round0부터 고정 breadth 후보 생성`
  - `시도 후 reviewer/critic이 거는 재시도 루프`
- 세 번째 축은 `단일 bounded loop` 또는 `LLM supervisor 재귀 라우팅`이다. 이것은 breadth escalation과 다르다.
- 따라서 `일단 single로 가고, 실패 신호가 나오면 breadth로 escalate`를 외부 공통 전략처럼 쓰는 것은 안전하지 않다.

## 범위와 증명 한계

- 읽은 소스 리포지토리:
  - `agentless`
  - `prometheus-agent`
  - `Lingxi`
  - `swe-agent`
  - `openhands-agent-sdk`
  - `joycode-agent`
  - `trae-agent`
  - `mini-swe-agent`
- 위 소스 리포지토리들은 리뷰 시점에 clean checkout이었다.
- 소스가 아니라 번들/추출물만 본 대상:
  - `Cursor.app`
  - `Codex.app`
  - `claude-code-v2-extracted/extracted-code.js`
- `live-swe-agent`는 현재 로컬 트리에 `LICENSE`, `README.md`, `assets`, `config`만 있고, 주장에 대응되는 owner source file이 없다.
- 이번 문서는 런타임 벤치 재현이 아니라 소스 경로 감사다.

## 범위 밖 트리거 클래스 (이 문서에서 닫지 않음)

deep audit에서 스캐폴드당 23~32개 시나리오가 나왔으나, 아래는 breadth/retry 선택 축이
아니라서 본 매트릭스에서 제외했다. SOTA++ 다른 결정에 쓰려면 별도 감사 필요.

| 클래스 | 관측된 스캐폴드 (예) |
|---|---|
| compaction / condensation | Claude(auto/micro-compact), Codex(`model_auto_compact_token_limit`), OpenHands(`llm_summarizing_condenser`, non-subscription 자동 부착), SWE-agent(observation elide) |
| model fallback / reroute | Claude(529 연속→fallback), Codex(usage/rate-limit→reroute) |
| effort 상승 | Claude(`/\bultrathink\b/` 키워드), Codex(`model_reasoning_effort`, 자동상승은 미관측) |
| per-step 샘플링 / requery | SWE-agent(`action_sampler` 4→10 escalate, FormatError/blocked requery) — attempt-level retry와 별개 |
| subagent / delegation spawn | Claude·Codex `spawn_agent`(LLM tool, "user explicitly asks"), Cursor `best-of-n-runner`(worktree subagent) |
| 기타 비싼 LLM 경로 | OpenHands(`run_goal` judge 루프, `switch_llm` 툴, security analyzer), Claude/Codex API retry(헤더/status det) |

## 증거 강도 레전드

| 라벨 | 의미 |
|---|---|
| `source-confirmed` | 읽을 수 있는 owner source checkout에서 file:line까지 확인됨 |
| `bundle-only` | minified bundle 또는 extracted JS에 식별자/가드 흔적은 있으나, 의미를 닫을 만큼 구조가 드러나지 않음 |
| `unverified` | 로컬 source가 없거나, 현재 증거로는 주장을 지지하기에 부족함 |

## 시나리오 매트릭스

| 스캐폴드 | 증거 | 지배적 전략 | 기본 상태 | 트리거 시점 | 트리거 결정자 | 트리거 동작 | 선택 / 종료 | 피해야 할 과장 | 핵심 근거 |
|---|---|---|---|---|---|---|---|---|---|
| Agentless | `source-confirmed` | round0 고정 breadth repair | `ON`, `max_samples=20` | repair 진입 시 | config | greedy 1개 + `N-1`개 sampled candidate 생성, 전 샘플 순회. **repro-test 생성도 동일 best-of-N**(`generate_reproduction_tests.py` max_samples) | regression/reproduction filter 후 majority vote, filter 결과가 비면 모든 valid patch에 대해 fallback vote | signal-driven escalate loop라고 쓰면 안 됨 | `agentless/repair/repair.py:446,481,739,826`; `agentless/repair/rerank.py:189,217,256`; `agentless/test/generate_reproduction_tests.py:178,487` |
| Prometheus | `source-confirmed` | 고정 개수 candidate 생성 + structured verify/vote | `ON`, request default `3` | edit patch 생성 후 candidate loop 경계 | config, 단 path별 조정 있음 | candidate count를 채울 때까지 edit/reset 반복 | structured LLM verify, candidate가 `1`개 초과일 때만 final `10x` vote, verified path는 candidate budget을 절반으로 줄임 | `항상 3`, `항상 10x vote`라고 쓰면 안 됨 | `requests/issue.py:56`; `issue_not_verified_bug_subgraph.py:145,180`; `issue_verified_bug_subgraph.py:294`; `final_patch_selection_node.py:139,171,180`; `bug_fix_verify_structured_node.py:92` |
| Lingxi | `source-confirmed` | LLM supervisor 재라우팅 / 재귀 orchestration | `ON` | supervisor hop마다 | LLM router | 다음 worker 선택 또는 종료/실패 | LLM이 다음 agent를 결정, 코드상 hard cap은 `recursion_limit=100` | prompt의 `3 attempts`를 하드 카운터로 쓰면 안 됨 | `prompt/supervisor.py:16`; `supervisor_graph_demo.py:93,95,318` |
| SWE-agent heavy | `source-confirmed` | reviewer-gated retry loop + chooser | heavy preset에서는 `ON` (**shipped는 chooser 1개만**; ScoreRetryLoop n_sample=5·action_sampler는 코드만 존재·미배선) | 각 submitted attempt 직후 | reviewer score + deterministic stop gate | `retry()`가 true면 새 attempt 시작 | chooser가 submission 중 하나 선택, reviewer score가 acceptance 상태에 반영됨 | `best-of-N N=3`라고 쓰면 틀림. 이것은 retry loop이고 `max_attempts=10`이다 | `250212_sweagent_heavy_sbl.yaml:135,138`; `reviewer.py:333,365,443,595,617,632`; `agents.py:428,162` |
| OpenHands SDK | `source-confirmed` | critic + refine loop | 기본은 `OFF` (`critic=None`) | `FinishAction` 후 critic result가 있을 때 | deterministic threshold/iteration gate, 단 score source는 critic 구현마다 다름 | score가 threshold 미만이고 iteration cap 미만이면 refine 재실행 | threshold 충족, critic 없음, max iteration 도달 시 종료 | `score authority`가 항상 LLM이라고 쓰면 안 됨. **이 행은 critic축만** — condenser·goal-judge·switch_llm은 별도(범위 밖 표 참조) | `agent/base.py:419`; `critic/base.py:42,48,109`; `critic_mixin.py:100,114`; `critic/impl/api/critic.py:113,135`; `critic/impl/empty_patch.py:44` |
| JoyCode | `source-confirmed` | classified retry + LLM failure routing | 기본은 `OFF` | validation 후 post-processing 단계 | 먼저 deterministic bucket, 일부에만 LLM | `TEST`는 basic retry, `PATCH`는 experience retry 또는 basic fallback | best-of-N selector가 아니라 retry 라우팅이며, judgment 실패는 `PATCH`로 fail-open | `LLM이 전체를 고른다`고 쓰면 안 됨 | `run_patch_pipeline.py:883,1264,1560`; `utils/count.py:93,98,105,118`; `validate_retry_necessity.py:86,112,133` |
| mini-swe-agent | `source-confirmed` | 단일 bounded loop | 단일 | query step마다 | deterministic step/cost limit | limit 또는 exit까지 loop 지속 | `step_limit` 또는 `cost_limit` 초과, 또는 exit action에서 종료 | wall-clock cap까지 확인됐다고 쓰면 안 됨 | `agents/default.py:25,27,105,128`; `config/benchmarks/swebench.yaml:112` |
| Trae | `source-confirmed` | 단일 bounded loop + no-op reflection | 단일 | agent step마다 | deterministic `max_steps` | completion 또는 error까지 진행 | completion, error, max steps에서 종료, reflection은 `None` 반환. **유일 코드 게이트=must_patch(eval ON) 빈-diff veto** | 별도 repair escalation scaffold가 있다고 쓰면 안 됨. 단 **"best-of-N 아예 없다"도 과장** — offline `patch_selection` selector(agent-based ensemble, 런타임 미배선) 별도 존재 | `agent/base_agent.py:163`; `agent/trae_agent.py:177,236`; offline: `evaluation/patch_selection/selector_agent.py:190`. 상세: [jul-1-trae-agent-deep-dive.md](jul-1-trae-agent-deep-dive.md) |
| Cursor | `bundle-only` | plurality / best-of-N surface 존재, 정확한 semantics는 미확정 | pref default는 `1`로 보임 | 여러 model entry가 있고 bundle guard가 성립할 때만 plural branch 진입 | bundle에 보이는 gate 수준만 확인 | plurality 또는 best-of-N 분기로 보이는 surface 존재 | deeper judge semantics는 닫히지 않음 | `runner subagent`, `server RPC judge`, `pref unused`를 확정하면 안 됨 | `workbench.desktop.main.js:35607,47270`; `workbench.desktop.main.js`에 `UiBestOfNJudgeCandidate`; `cursor-agent-exec/dist/main.js:2`에 `best_of_n_group_id`, `try_use_best_of_n_promotion` |
| Claude Code | `bundle-only` | retry와 subagent surface는 존재 | 미상 | request retry path와 subagent 관련 config surface | header/status code helper + config surface | retry request 또는 subagent orchestration surface 존재 | 정확한 branch semantics는 닫히지 않음 | `x3`, 상세 branching을 확정하면 안 됨 | `extracted-code.js:129`; `extracted-code.js:176` |
| Codex | `bundle-only` | spawn_agent / Cloud best-of-N / retry surface 존재, semantics 미확정 | 미상 | 미상 | 미상 | 미상 | 미상 | `Codex.app` 설치번들엔 anchor 없음. 단 repo strings 덤프엔 식별자 존재 — semantics는 못 닫음(strings = 식별자만, 분기본문 없음) | `Codex.app`엔 readable anchor 없음(아티팩트 한정). 단 `.extracted_source/codex-cli/_cli-symbols.txt`에 `spawn_agent`·`best_of_n`·`model_auto_compact_token_limit`·`model_reasoning_effort`·`request_max_retries` 47개 hit |
| live-swe | `unverified` | 로컬 checkout에 owner source 없음 | 미상 | 미상 | 미상 | 미상 | 미상 | hard-evidence 표에 넣지 말 것 | 현재 `git ls-tree HEAD` 결과가 `LICENSE`, `README.md`, `assets`, `config`뿐임 |

## 원래 축약 문구에 대한 적대적 수정

| 원래 문구 | 감사 판정 | 왜 과한가 | 더 안전한 문구 |
|---|---|---|---|
| `Agentless = best-of-N 20 / ON unconditional` | 대체로 유지 | 큰 그림은 맞지만 rerank fallback branch를 숨긴다 | `round0 fixed breadth repair, config-driven, filter then vote, filter 결과가 비면 모든 valid patch에 fallback vote` |
| `Prometheus = best-of-N N=3 / ON N=3` | 부분 유지 | request default는 `3`이지만 verified path는 budget을 반으로 줄이고, candidate가 하나면 vote 자체를 건너뛴다 | `fixed-count candidate generation; default request budget 3; verified path는 budget을 줄일 수 있고, candidate > 1일 때만 final 10x vote` |
| `Lingxi = 3 attempts` | 하향 | `3 attempts`는 prompt 문구지 코드상의 hard counter가 아니다 | `LLM supervisor recursion, prompt-level 3-attempt guidance, hard code cap은 recursion_limit=100` |
| `SWE-agent heavy = best-of-N N / ON` | 기각 | owner mechanism은 up-front fixed breadth가 아니라 reviewer-gated retry + chooser다. `max_attempts=10`이다 | `reviewer-gated retry loop + chooser` |
| `SWE-agent heavy = max_accepts input = LLM` | 기각 | `max_accepts`는 deterministic stop gate이고, LLM은 review score 입력만 만든다 | `LLM reviewer score가 acceptance 상태에 반영되지만, retry 종료는 deterministic config gate로 닫힌다` |
| `OpenHands SDK = score = LLM critic or det` | 유지 가능 | 맞지만 default-off와 threshold gate를 같이 써야 정확하다 | `critic+refine, default-off, score<threshold && iter<max일 때 refine` |
| `JoyCode = LLM judge routing only` | 대체로 유지 | `test_validation_failed` subset에 대해서는 맞지만, deterministic bucket과 PATCH fail-open fallback을 빼면 불완전하다 | `deterministic failure bucket first; LLM은 validation-failure subset만 라우팅; judgment 실패는 PATCH` |
| `mini/live-swe = 없음(단일)` | 분리 필요 | mini는 source-confirmed 단일 loop이지만 live-swe는 이번 checkout에서 source-confirmed가 아니다 | `mini = single bounded loop`; `live-swe = current local checkout 기준 unverified` |
| `Cursor = best-of-N ensemble/runner / OFF(1)` | 하향 | bundle은 preference surface와 plural gate만 보여준다. runner/judge semantics 전체는 닫히지 않는다 | `bundle-only plurality/best-of-N surface; semantics not closed` |
| `Claude Code = subagent fanout / det retry-fallback` | 하향 | bundle은 retry helper와 subagent string을 보여주지만 branch 의미와 retry count를 닫지 못한다 | `bundle-only retry/subagent surfaces exist; exact semantics unverified` |
| `Codex = spawn / Cloud best-of-N / det retry` | 하향(unverified→bundle-only) | `Codex.app` 설치번들엔 anchor 없으나, repo strings 덤프엔 식별자 hit 있음. 분기본문은 못 닫음 | `bundle-only: strings 덤프에 spawn_agent/best_of_n/retry 식별자 존재, semantics unverified` |

## 소스가 실제로 지지하는 family 분류

| Family | 구성원 | 실제로 공통인 것 | 공통이 아닌 것 |
|---|---|---|---|
| round0 fixed breadth | Agentless, Prometheus | round0부터 candidate multiplicity가 config로 정해진다 | trigger가 failure signal 기반은 아니다. selection logic도 서로 다르다 |
| reviewer/critic-gated retry | SWE-agent heavy, OpenHands SDK, JoyCode | 나중 평가 단계가 다음 시도 또는 refine 여부를 정한다 | evaluator는 통일돼 있지 않다. reviewer score, critic score, bucket+router가 섞인다 |
| LLM supervision / single loop | Lingxi, mini-swe-agent, Trae | source-confirmed **런타임** breadth escalation scaffold는 안 보인다 | Lingxi는 recursive router, mini와 Trae는 deterministic bounded loop다. ⚠️ Trae엔 **offline** best-of-N selector(agent-based ensemble)가 런타임과 별개로 존재(§Trae 각주) |

> 각주(dead-code): Lingxi(`state.py` `current_sample_index`)와 JoyCode(`vote.py` LLM pairwise)에는
> best-of-N **의도**가 코드로 남아있으나 shipped 경로에서 **미배선**(import 0건)이다. family 분류엔
> 넣지 않았다 — 켜져있지 않으므로. 단 "이들도 best-of-N을 시도했다"는 방향 신호로는 유효.

## SOTA++ 프레이밍에 주는 함의

- breadth에 대한 가장 강한 외부 지지는 `Agentless`, `Prometheus`인데, 둘 다 `config-first round0 breadth`이지 `single first then escalate`가 아니다.
- gated retry에 대한 가장 강한 외부 지지는 `SWE-agent heavy`, `OpenHands SDK`, `JoyCode`인데, 이것도 `post-attempt reviewer/critic/bucket loop`이지 fixed breadth와 같은 설계가 아니다.
- `Lingxi`, `mini-swe-agent`, `Trae`는 일반화된 `WHEN=det / WHICH=LLM` 테제를 지지하지 않는다. 확인된 로직은 supervisor routing 또는 bounded single-loop다.
- `Cursor`, `Claude Code` 같은 bundle-only 행은 product direction 비교의 hard evidence로 쓰면 안 된다.

## 비교표에 바로 붙일 수 있는 문구

아래 문구는 증거 강도를 과장하지 않고 바로 인용할 수 있다.

| 스캐폴드 | 권장 문구 |
|---|---|
| Agentless | `round0 fixed breadth repair, config-driven, default max_samples=20; regression/reproduction filter 후 majority vote, filter 결과가 비면 모든 valid patch에 fallback vote` |
| Prometheus | `fixed-count candidate generation with structured LLM verification/selection; request default candidate budget=3, verified path는 budget을 줄일 수 있고, final 10x vote는 candidate count > 1일 때만 수행` |
| Lingxi | `LLM supervisor reroute/recursive orchestration; prompt에는 3 attempts가 있으나 hard code cap으로 확인된 것은 recursion_limit=100` |
| SWE-agent heavy | `reviewer-gated retry loop plus chooser; heavy preset은 chooser retry_loop(max_attempts=10)를 켜며, up-front fixed-breadth generator는 아니다` |
| OpenHands SDK | `critic+refine loop, default-off unless critic is configured; score<threshold && iteration cap 미도달일 때 refine` |
| JoyCode | `classified retry pipeline, default-off unless post-processing enabled; deterministic failure bucket first, LLM은 validation-failure subset만 라우팅` |
| mini-swe-agent | `single bounded loop with deterministic step/cost limits` |
| Trae | `single bounded loop with deterministic max_steps; reflection no-op; 유일 코드게이트=must_patch 빈-diff veto(eval ON). 런타임 best-of-N 없음, 단 offline patch_selection selector(agent-based ensemble, 미배선) 별도 존재` |
| Cursor | `bundle-only plurality/best-of-N surface observed; exact runner/judge semantics unverified` |
| Claude Code | `bundle-only retry/subagent surfaces observed; exact branching semantics unverified` |
| Codex | `bundle-only: repo strings 덤프에 spawn_agent/best_of_n/auto_compact/retry 식별자 존재(설치앱엔 없음), exact semantics unverified` |
| live-swe | `unverified in current local checkout because owner source files are absent` |

## 결론

- source-confirmed 외부 증거는 `하나의 전략`이 아니라 `여러 family`를 지지한다.
- 가장 안전한 헤드라인은 다음이다.
  - `외부 스캐폴드는 round0 fixed breadth, reviewer/critic-gated retry, bounded single-loop orchestration으로 갈린다`
- 가장 위험한 헤드라인은 다음이다.
  - `외부 합의는 single로 시작해서 signal-triggered breadth escalation을 한다`
