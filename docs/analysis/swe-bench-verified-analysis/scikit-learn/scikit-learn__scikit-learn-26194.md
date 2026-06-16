---
instance_id: scikit-learn__scikit-learn-26194
repo: scikit-learn/scikit-learn
base_commit: e886ce4e1444c61b865e7839c9cff5464ee20ace
version: "1.3"
difficulty: "15 min - 1 hour"
created_at: "2023-04-17T16:33:08Z"
fail_to_pass: 2
pass_to_pass: 186
gold_files: [sklearn/metrics/_ranking.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`roc_curve`가 확률 추정치(`y_score ∈ [0,1]`)를 입력받을 때, 반환되는 `thresholds[0]`이 1을 초과하는 값이 나온다. 곡선이 `(0,0)`에서 시작하도록 맨 앞에 임계값을 하나 추가하는데, 그 값을 `thresholds[0] + 1`로 잡기 때문이다. 즉 최고 점수가 1.0이면 추가 임계값이 2.0이 되어 "확률은 1을 못 넘는다"는 사용자 기대를 깬다. 이슈는 재현 테스트와 정확한 결함 라인(L1086)을 직접 제시한다.

## 유형 (정형화)

- **L = L0 (Pinpointed)**: 이슈가 결함 라인을 GitHub permalink로 직접 지목(`thresholds = np.r_[thresholds[0] + 1, thresholds]`). grep 한 방. 탐색 노력 0.
- **S = S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나, "어떤 값으로 바꿔야 올바른가"가 핵심. 이슈가 제안한 `clip(<=1)` 워크어라운드는 틀린 일반화다(확률이 아닌 일반 점수에선 1이 유효 임계값일 수 있음). 골드는 도메인 불변식 — "이 prepended 임계값은 어떤 인스턴스도 양성 예측하지 않는 가상의 컷오프" — 을 추론해 `np.inf`라는 의미적으로 올바른 sentinel을 합성한다. 후보 나열·테스트 반복이 아니라 의미 추론으로 푸는 전형적 S2.
- **K = K-Domain**: ROC 곡선의 임계값 의미("score >= threshold면 양성")와 "no instance predicted positive" 시작점의 정의를 알아야 `+1`이 왜 임의적이고 `np.inf`가 왜 정답인지 판단 가능. scikit-learn 메트릭 도메인 지식.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 기계적 가드/상수교체가 아니라 올바른 식의 추론 합성(S2)이므로.

## 난이도 티어

**T3 (중간).** 구조적 피처: 1파일·실질 변경 1줄(+docstring), localize 직접성 최고(L0, has-repro), cross-file 없음. 이것만 보면 T1~T2지만, 위로 미는 요인 두 가지 — (1) 픽스가 "값 추론"이라 이슈 본문의 제안(clip)을 그대로 따르면 오답이 됨(S2의 추론 부담), (2) `regression-trap`: P2P 150개로 `test_ranking.py`의 거의 전 메트릭이 `roc_curve` 출력 형태에 의존. 특히 기존 `test_roc_curve_drop_intermediate`가 `2.0` 기대값을 하드코딩하고 있어, 픽스가 이 기댓값을 동시에 깨므로 단순 add-only가 아니다. 공식 라벨 "15분-1시간"과 정합. L0+has-repro라 T2로 내릴 만하지만, "올바른 값 도출"의 추론성과 넓은 P2P trap이 T3을 정당화한다.

## 골드패치 분석

- **파일·함수**: `sklearn/metrics/_ranking.py`의 `roc_curve` 단일 함수.
- **근본원인**: `(0,0)` 시작점을 추가하려고 `thresholds = np.r_[thresholds[0] + 1, thresholds]`로 "가장 큰 점수보다 1 큰" 값을 prepend. `+1`은 점수 스케일에 대한 무근거 가정 — 확률 추정치(max=1.0)에선 결과가 2.0이 되어 "임계값 ≤ 1" 기대 위반.
- **수정요지**: prepend 값을 `np.inf`로 교체(`thresholds = np.r_[np.inf, thresholds]`). 의미상 "어떤 인스턴스도 양성으로 예측되지 않는(`score >= inf`는 항상 거짓)" 컷오프이므로 스케일 무관하게 항상 올바르다. 함께 docstring을 갱신 — shape 표기 오타(`= (n_thresholds,)`→`(n_thresholds,)`), `thresholds[0]` 설명을 `max(y_score)+1`→`np.inf`, Notes에 inf 시작점 설명 추가, doctest 예시 출력을 `1.8`→`inf`로 수정.

## 검증 (test_patch)

FAIL_TO_PASS 2개:
1. `test_roc_curve_with_probablity_estimates[42]` (신규): `global_random_seed` fixture로 확률형 `y_score`를 만들고 `assert np.isinf(thresholds[0])`. 픽스 후 첫 임계값이 정확히 `inf`임을 직접 증명. (이슈 본문의 `<=1 or >=0` 약식 단언보다 강한 정확 일치 단언으로 격상됨.)
2. `test_roc_curve_drop_intermediate` (수정): 기존 하드코딩 `[2.0, ...]`을 `[np.inf, ...]`로 갱신 — `+1` 산식이 의존하던 기댓값을 새 동작에 맞춤. 이 변경이 필요했다는 사실 자체가 P2P가 출력 형태에 결합돼 있었음을 증명.

overfit 관점: 단언이 정확값(`isinf`)이라 special-case 통과가 어렵고, `global_random_seed` 파라미터화로 여러 시드에서 불변식을 검증 → overfit 위험 낮음. regression 관점: P2P 150개(det/precision-recall/top-k/lrap 등 인접 메트릭 전부) 그대로 통과해야 하며, `inf`는 `(0,0)` 시작점 보장만 바꾸고 fpr/tpr 값은 불변이라 안전.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 결함 permalink(L1086)와 재현 스니펫을 직접 줌 → `_ranking.py`의 `roc_curve` 끝부분 `np.r_[thresholds[0] + 1, thresholds]` 한 줄로 즉시 수렴. 탐색 불필요.
2. **픽스와 일반화 정당성**: `+1`을 `np.inf`로 교체. 이슈가 제안한 "max<=1이면 clip" 워크어라운드는 *틀림* — 분기 휴리스틱이고 일반 스코어에선 1이 정당한 임계값이라 의미를 깨고 매직 분기를 도입한다. `np.inf`는 "이 시작점은 양성 예측 0개에 대응하는 가상 컷오프"라는 ROC 정의에 정확히 들어맞아, 점수 스케일·dtype 무관하게 항상 옳다. 즉 스케일 가정을 제거하는 진짜 일반화.
3. **regression 안전**: P2P 150개 중 `roc_curve` 출력에 의존하는 모든 메트릭이 통과해야 함. `inf` prepend는 fpr=0/tpr=0 시작점만 보장하고 곡선 본체(fpr/tpr/AUC)는 불변이므로 `test_auc`, `test_roc_curve_*`, `det_curve`류 안전. 단, 임계값 배열을 하드코딩한 `test_roc_curve_drop_intermediate`는 반드시 `inf`로 동반 수정해야 함(안 하면 자기 테스트가 깨짐).
4. **함정 회피**: 오라클 없는 에이전트가 빠질 두 함정 — (a) 이슈가 친절히 제안한 `clip`을 그대로 구현해 의미적 오답을 만드는 것(이슈 제안을 비판적으로 검토해야 함), (b) 코드만 고치고 기존 `2.0` 기댓값 테스트·doctest(`1.8`)를 방치해 regression을 일으키는 것. 픽스의 파급(하드코딩 기댓값·docstring doctest)을 함께 추적하는 것이 정답 궤적의 핵심.
