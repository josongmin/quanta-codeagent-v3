# Cases requiring clean re-solve

실행 티켓: [T-RESOLVE-14](./tickets/T-RESOLVE-14-clean-resolve-and-score-correction.md)
가 이 문서의 모든 케이스를 clean re-solve하고 leaderboard count를 정정한다. 이 문서는
케이스 인벤토리, T-RESOLVE-14는 그 실행/DoD를 가진다.

목적:

- heuristic authority가 개입한 solved receipt를 clean score와 분리한다.
- clean preset으로 다시 풀어야 할 케이스를 한곳에 모은다.
- `solved`와 `targeted heuristic present`를 섞지 않는다.

## Buckets

### 1. contaminated solved

이 bucket은 solved receipt 자체가 heuristic authority 아래서 나온 케이스다. clean score에서 제외하고 다시 풀어야 한다.

#### `django__django-11138`

- 상태: contaminated solved, clean re-solve required
- 근거:
  - RCA 문서가 이 케이스용 `multi-backend owner-family steer` 추가를 명시한다.
  - solved receipt는 `agentless-v3-thin-strict-closure-select` preset이다.
  - selection telemetry에서 winning candidate가 `soft:declaredExpectedMatch=1`을 받고, 다른 candidate는 `hard:declaredExpectedMatch=false`로 inadmissible 처리된다.
- 증거:
  - `.tmp/bench-ouronly-visible-2026-06-21/rca-three-confirmed-fails.md`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0312b299466235419.json`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/runlog-i-0312b299466235419.log`

#### `django__django-14315`

- 상태: contaminated solved, clean re-solve required
- 근거:
  - RCA 문서가 이 케이스용 `subprocess/env boundary steer` 추가를 명시한다.
  - solved receipt는 `agentless-v3-thin-strict-closure-select` preset이다.
  - selection telemetry에서 winning candidate가 `soft:declaredExpectedMatch=1`, `soft:ownerCoverage=1`을 받는다.
  - solved patch가 `postgresql/client.py` + `base/client.py` 동시 수정이라는 RCA target family와 정확히 맞는다.
- 증거:
  - `.tmp/bench-ouronly-visible-2026-06-21/rca-three-confirmed-fails.md`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0312b299466235419.json`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/runlog-i-0312b299466235419.log`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-0312b299466235419.jsonl`

### 2. targeted heuristic present, causality unproven

이 bucket은 targeted heuristic은 확인됐지만, 현재 손에 있는 solved receipt만으로 heuristic solve라고 단정할 수 없는 케이스다. clean 재풀이 우선순위는 높지만 contaminated solved count에는 넣지 않는다.

#### `astropy__astropy-13033`

- 상태: targeted heuristic present, solved-by-heuristic unproven
- 근거:
  - RCA 문서가 이 케이스용 `targeted exception-message steer` 추가를 명시한다.
  - 그러나 현재 확인된 solved receipt는 `agentless-v3-thin-strict` preset이며 `verify-select`/closure-select 계열이 비활성이다.
- 증거:
  - `.tmp/bench-ouronly-visible-2026-06-21/rca-three-confirmed-fails.md`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0ca81ea7542a59713.json`

### 3. heuristic-bearing solved, attribution unproven

이 bucket은 solved receipt가 heuristic-bearing profile에서 나왔지만, 현재 artifact만으로
"그 heuristic 때문에 풀렸다"고 단정할 수 없는 케이스다. clean score에는 바로 섞지 말고,
counterfactual clean replay 또는 signal-off replay로 원인성을 확인한다.

#### `django__django-13128`

- 상태: `repro-doubt` active solved, causality unproven
- 근거:
  - solved receipt는 `agentless-v2` preset이지만 `repro-doubt={stuckRuns:5}`가 env source로 켜져 있다.
  - report에는 `repro-doubt` guard가 실제로 fire했는지 남아 있지 않다.
  - 따라서 "repro-doubt가 해결했다"가 아니라 "`repro-doubt` active run에서 solved"로만 기록한다.
- 증거:
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-09d925cd23f3e0d83.json`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/preds-i-09d925cd23f3e0d83.jsonl`
- clean 판정 조건:
  - same model/auth posture에서 `repro-doubt` off replay가 PASS이거나,
  - telemetry가 `repro-doubt` steer 미발화였음을 증명해야 clean solved로 승격한다.

#### `django__django-13417`

- 상태: verify-select/soft-selector solved, causality unproven
- 근거:
  - solved receipt가 `agentless-v3-thin-strict-select` 및 `agentless-v3-thin-strict-closure-select`
    계열에서 확인된다.
  - winning selection telemetry는 `voterQuorum`, `minimality`, `ownerCoverage` 같은 soft selector
    signal을 포함한다.
  - 현재 artifact만으로는 selector가 없었어도 같은 patch가 제출됐는지 알 수 없다.
- 증거:
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-08f5a809da41673cb.json`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0fbad2607ed35389f.json`
- clean 판정 조건:
  - `verify-select` off single-pass replay PASS, 또는
  - selector-on/off counterfactual에서 동일 patch 제출 확인.

#### `pydata__xarray-3677`

- 상태: verify-select/soft-selector solved, causality unproven
- 근거:
  - solved receipt가 selector profile에서 확인된다.
  - selection telemetry가 candidate ranking을 거쳤지만, heuristic signal이 승패를 바꿨는지
    counterfactual evidence가 없다.
- 증거:
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-08f5a809da41673cb.json`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0fbad2607ed35389f.json`
- clean 판정 조건:
  - `verify-select` off replay PASS, 또는 selector가 동일 first candidate를 제출했다는 receipt 필요.

#### `astropy__astropy-13579`

- 상태: verify-select/soft-selector solved, causality unproven
- 근거:
  - solved receipt는 `agentless-v3-thin-strict-select`에서 확인된다.
  - 같은 case가 `agentless-v3-thin-strict-closure-select` artifact에서는 unresolved인 receipt도 있다.
  - selector/prompt/profile 차이 중 무엇이 원인인지 현재 artifact만으로 분해할 수 없다.
- 증거:
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-08f5a809da41673cb.json`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0fbad2607ed35389f.json`
- clean 판정 조건:
  - selector-off clean replay PASS.
  - 실패/성공 두 receipt의 prompt/profile diff를 분리한 A/B.

#### `django__django-16139`

- 상태: verify-select/soft-selector solved, causality unproven
- 근거:
  - solved receipt가 `agentless-v3-thin-strict-select`에서 확인된다.
  - selected candidate id가 `cand-3`라 selector가 실제로 후보 선택에 관여했다.
  - no-selector path가 같은 patch를 만들었는지 확인되지 않았다.
- 증거:
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0eaee8c4b2c85fd4f.json`
- clean 판정 조건:
  - `verify-select` off replay PASS, 또는 `cand-3` patch가 clean single-pass에서도 제출됨을 증명.

#### `matplotlib__matplotlib-25122`

- 상태: verify-select/soft-selector solved, causality unproven
- 근거:
  - solved receipt가 selector profile에서 확인된다.
  - 현재 telemetry만으로 soft ranking이 outcome을 바꿨는지 알 수 없다.
- 증거:
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0eaee8c4b2c85fd4f.json`
- clean 판정 조건:
  - selector-off clean replay PASS.

#### `mwaskom__seaborn-3069`

- 상태: gated verify-select solved, causality unproven
- 근거:
  - solved receipt가 `agentless-v3-thin-strict-gated`에서 확인된다.
  - `verify-select-regression=discovered`가 active인 profile이다.
  - discovered regression이 reject/admit을 바꿨다는 direct evidence는 없다.
- 증거:
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0d1d71ab25b926bad.json`
  - `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0e8fb2823dfd721fc.json`
- clean 판정 조건:
  - `verify-select-regression=off` or clean witness-only replay PASS.

#### `matplotlib__matplotlib-20488`

- 상태: gated verify-select solved, causality unproven
- 근거:
  - solved receipt가 `agentless-v3-thin-strict-gated` manual-fetch report에서 확인된다.
  - profile에 `verify-select-regression=discovered`가 active다.
  - discovered regression이 outcome을 바꿨는지 확인되지 않았다.
- 증거:
  - `.tmp/bench-ouronly-visible-2026-06-21/gated-retry5-manual-fetch/report.json`
- clean 판정 조건:
  - discovered regression off replay PASS, 또는 static witness/executed proof만으로 동일 patch PASS.

## Replay requirements

다시 푸는 run은 아래 조건을 만족해야 한다.

- `selection-declared-expected.ts`가 clean authority로 연결되지 않을 것
- `rca-target-gates` off
- clean preset에서 `RCA_*_STEER` literal prompt가 주입되지 않을 것
- `declaredExpectedMatch=false`가 candidate inadmissible reason으로 쓰이지 않을 것
- 기존 contaminated solved receipt와 새 clean solved receipt를 같은 score bucket에 합치지 않을 것
- ambiguous bucket은 signal-off replay나 동일-patch clean replay 전까지 clean score로 승격하지 않을 것

## Current count

- contaminated solved: 2
- targeted heuristic present, causality unproven: 1
- heuristic-bearing solved, attribution unproven: 8
