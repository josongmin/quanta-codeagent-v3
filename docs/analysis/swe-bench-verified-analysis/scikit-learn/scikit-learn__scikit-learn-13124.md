---
instance_id: scikit-learn__scikit-learn-13124
repo: scikit-learn/scikit-learn
base_commit: 9f0b959a8c9195d1b6e203f08b698e052b426ca9
version: "0.21"
difficulty: "15 min - 1 hour"
created_at: 2019-02-09T02:15:23Z
fail_to_pass: 1
pass_to_pass: 60
gold_files: [sklearn/model_selection/_split.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap, overfit-risk]
---

## 문제 요약
`StratifiedKFold(shuffle=True)`가 문서("각 stratum 내부 샘플을 셔플")와 다르게 동작한다. 실제로는 클래스 내부 샘플 순서가 셔플되지 않고 fold(배치)의 출력 순서만 뒤바뀐다. 그래서 `random_state`를 바꿔도 각 fold의 test 인덱스 구성(1↔11, 2↔12 페어링)은 동일하고 순서만 달라져, cross-validation 관점에서 셔플이 무의미하다. hints에 따르면 #7823에서 들어온 회귀로, 모든 클래스의 stratification을 같은 random state로 셔플하는 것이 원인이다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `StratifiedKFold` + `shuffle`을 명시 → `_split.py`의 `StratifiedKFold._make_test_folds`로 빠르게 수렴. 단, "어느 한 줄"인지는 per-class KFold 생성부의 `random_state` 전달 경로를 따라가야 보임. 단일 파일·단일 함수.
- **S2 (Constraint-Reasoning)**: 고칠 지점(rng 전달)은 좁지만, 올바른 픽스는 "int seed를 KFold마다 그대로 넘기면 동일 셔플 → `check_random_state`로 mutable `RandomState` 인스턴스화해서 클래스마다 RNG 상태가 전진되게 하라"는 RNG 의미론 추론을 요구한다. 후보 난사가 아니라 불변식("서로 다른 클래스는 서로 다른 순열")을 따져 합성하는 결함.
- **K-Domain**: numpy `RandomState` vs int-seed 의미 차이, sklearn `check_random_state` 관례 지식이 병목. 일반 파이썬 추론만으론 "왜 같은 seed가 같은 셔플을 만드는가"를 짚기 어렵다.
- **primary = T-ConstraintReason**: 위치는 명확하나 픽스가 기계적 가드/상수 변경이 아니라 RNG 상태 공유라는 의미적 불변식 추론이라서.

## 난이도 티어 — **T3 (중간)**
구조 피처: 1파일·실질 2줄(코드 1줄 + docstring 1줄), localize는 L1로 비교적 직접, `has-repro`(명확한 재현 코드+출력)로 easiness가 높다. 그러나 픽스 줄 수가 작다고 T1/T2가 아닌 이유는, 결함이 "없는 가드"가 아니라 "int seed를 공유하면 per-class RNG가 분기하지 않는다"는 비자명한 RNG 의미론(K-Domain)이고, regression 표면이 넓기(P2P 61개, 그중 재현성/순서 관련 테스트 다수) 때문이다. 공식 라벨 "15분-1시간"과 일치 — 구현은 한 줄이나 근본원인 진단에 도메인 추론이 든다.

## 골드패치 분석
- **파일/함수**: `sklearn/model_selection/_split.py` → `StratifiedKFold._make_test_folds` (및 클래스 docstring의 `shuffle` 설명).
- **근본원인**: `_make_test_folds`가 `rng = self.random_state`로 받은 값을 클래스별 `KFold(self.n_splits, shuffle=self.shuffle, random_state=rng).split(...)`에 그대로 주입한다. `random_state`가 정수 seed면 모든 클래스의 KFold가 동일 seed로 동일 순열을 만들어, 클래스 내부 셔플이 사실상 일어나지 않고 seed를 바꿔도 fold 묶음 구성이 불변(출력 순서만 변동)이다.
- **수정요지**: `rng = self.random_state` → `rng = check_random_state(self.random_state)`. int seed를 mutable `RandomState` 인스턴스로 변환하면, 동일 인스턴스가 클래스별 KFold.split에서 순차 소비되며 RNG 상태가 전진 → 클래스마다 다른 순열, seed마다 다른 fold 구성이 나온다. docstring도 "각 클래스 샘플을 셔플"로 정정.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_shuffle_stratifiedkfold` 1개. 추가된 단언은 `X=arange(10)`, `y=[0]*5+[1]*5`에 대해 `random_state=0`과 `random_state=1`의 `kf.split` test 인덱스 집합(`test_set1`, `test_set2`)이 **다름**(`assert test_set1 != test_set2`)을 요구한다. 버그 버전에선 두 seed가 같은 fold 구성을 내므로 정렬된 test set이 동일 → 실패. 픽스 후 `RandomState` 상태 전진으로 서로 다른 순열 → 통과.
- **overfit 관점**: 테스트가 "두 seed의 결과가 다르다"만 본다(특정 순열값을 고정하지 않음). 이는 `check_random_state` 픽스의 의도(seed 의존 셔플)와 정합하나, 단언이 1개라 얕다(`overfit-risk`). 다만 `check_random_state` 이외의 임시방편(예: seed에 클래스 인덱스 더하기)은 P2P의 재현성 테스트를 깨므로 사실상 정답으로 수렴한다.
- **regression 관점**: P2P 61개 — `test_stratified_kfold_no_shuffle`, `test_shuffle_kfold_stratifiedkfold_reproducibility`, `test_stratified_kfold_ratios` 등. 픽스가 `shuffle=False` 경로나 동일 seed 재현성을 깨면 안 된다. `check_random_state(int)`는 결정론적(같은 seed→같은 인스턴스 시퀀스)이라 재현성은 보존되고, `shuffle=False`면 KFold가 random_state를 쓰지 않아 무영향.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "shuffle이 stratum 내부를 안 섞고 배치 순서만 섞임" + `StratifiedKFold` 명시 → `_split.py`의 `StratifiedKFold._make_test_folds`로 직행. 그 안에서 `random_state`가 흘러가는 유일 지점인 per-class `KFold(..., random_state=rng)` 리스트 컴프리헨션을 지목.
2. **픽스와 일반화 근거**: `rng = self.random_state`가 int면 클래스마다 동일 seed→동일 순열이 핵심. `check_random_state`로 단일 `RandomState` 인스턴스를 만들면 클래스별 split 호출이 그 인스턴스를 순차 소비해 상태가 전진, 클래스마다·seed마다 다른 셔플이 나온다. 이는 특정 테스트값이 아니라 "stratum별 독립 셔플"이라는 문서화된 계약을 복원하므로 올바른 일반화다.
3. **regression 안전**: `shuffle=False`엔 random_state가 미사용이라 무영향. int seed→`RandomState`는 결정론적이라 `..._reproducibility` 테스트(같은 seed 재현)를 보존. ratio/no-shuffle 등 fold 분배 불변식도 KFold 로직 자체를 안 건드려 유지.
4. **함정 회피**: 오라클 없는 에이전트는 (a) docstring만 고치고 코드 미수정("문서가 틀렸다"로 오판), 또는 (b) per-class KFold마다 `random_state`에 클래스 인덱스를 더하는 ad-hoc 셔플 분기를 도입해 재현성 P2P를 깰 수 있다. 핵심은 numpy RNG 의미론 — **공유된 int seed는 셔플을 분기시키지 못한다**는 것을 진단하고, sklearn 표준 관례인 `check_random_state` 한 줄로 mutable 인스턴스화하는 것이다.
