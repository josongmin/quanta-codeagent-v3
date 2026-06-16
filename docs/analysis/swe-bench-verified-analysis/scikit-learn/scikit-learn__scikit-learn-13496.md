---
instance_id: scikit-learn__scikit-learn-13496
repo: scikit-learn/scikit-learn
base_commit: 3aefc834dce72e850bff48689bea3c7dff5f3fad
version: "0.21"
difficulty: "<15 min fix"
created_at: 2019-03-23T09:46:59Z
fail_to_pass: 1
pass_to_pass: 19
gold_files: [sklearn/ensemble/iforest.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [regression-trap]
---

## 문제 요약
`sklearn.ensemble.IsolationForest`의 부모 클래스 `BaseBagging`은 이미 `warm_start` 파라미터를 지원해 트리를 점진적으로 추가할 수 있지만, `IsolationForest.__init__()`에는 노출되어 있지 않다. 사용자는 초기화 후 속성을 직접 바꿔야만 쓸 수 있어 발견이 어렵다. 이슈는 `RandomForestClassifier`와 동일한 방식으로 `__init__`에 `warm_start=False`를 노출하고, docstring을 추가하고, 테스트를 붙일 것을 요청한다 (이슈가 docstring 텍스트까지 그대로 제공).

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 고칠 심볼(`IsolationForest.__init__`)과 파라미터명(`warm_start`)을 직접 지목. grep 한 방으로 도달. 탐색 비용 사실상 0.
- **S1 (Direct-Map)**: 이슈가 픽스를 사실상 명세한다 — 파라미터 추가, 부모로 전달, docstring 텍스트까지 verbatim 제공. 추론 합성 없음, 기계적 매핑.
- **K-API (API-contract)**: 핵심은 공개 API 시그니처 확장이고, 새 파라미터를 부모 `BaseBagging.__init__`의 `warm_start` 계약에 정확히 연결해야 한다. 도메인 알고리즘(iForest 내부) 지식은 불필요 — 위임 배선만 맞추면 됨.
- **primary = T-DirectMap**: 위치 명확(L0) + 기계적 픽스(S1)의 정의에 정확히 부합. 새 키워드 인자 추가는 정형 결함클래스(파라미터 노출/기본값)로, 추론(S2)이나 스펙 재구성(S5)이 끼지 않는다. APR 관점에서 template-based(PAR/TBar류) 수리로 충분.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`sklearn/ensemble/iforest.py`), 비테스트 변경 ~10줄, 헌크 3개(docstring/시그니처/super 전달) — 모두 인접하고 조율 불필요.
- localize 직접성 최상(L0): 이슈가 클래스·메서드·파라미터를 다 적어줌. has-repro는 아니지만 픽스가 자명해서 무관.
- 도메인 지식 병목 없음(K-API). 추론 부담 없음(S1).
- 약한 **regression-trap**: PASS_TO_PASS 19개가 IsolationForest의 인접 동작(parallel/sparse/chunks/score_samples/deprecation 등)을 광범위하게 커버. 새 인자가 기존 `__init__` 호출 경로를 깨면 잡힌다. 하지만 기본값 `False`라 기존 동작은 byte-identical하게 보존되어 trap이 실제로 발화할 위험은 낮음.
- 공식 라벨 `<15 min fix`와 일치(T1~T2 prior). T1(존나쉬움)이 아니라 T2인 이유: super 위임 배선이 한 줄 있어 "이슈 한 줄을 그대로 베끼면 끝"보다 약간의 wiring 정확성을 요구.

## 골드패치 분석
- **건드린 파일·함수**: `sklearn/ensemble/iforest.py` — `IsolationForest` 클래스 docstring, `IsolationForest.__init__` 시그니처, 그리고 그 안의 `super().__init__(...)` 호출.
- **근본원인**: `IsolationForest`가 `BaseBagging`을 상속하면서 `warm_start`를 `__init__` 시그니처에 누락하고 `super().__init__()`에 전달하지 않음. 기능은 부모에 존재하나(self-attr로 우회 가능) 공개 API로 노출되지 않은 "미배선" 결함.
- **수정요지**: (1) docstring에 `warm_start : bool, optional (default=False)` 블록 + `.. versionadded:: 0.21` 추가, (2) `__init__` 시그니처 끝에 `warm_start=False` 추가, (3) `super().__init__(...)` 호출에 `warm_start=warm_start` 전달. 부모 `BaseBagging`이 이미 `warm_start` 로직(estimators_ 재사용/추가)을 구현하므로 자식은 값 전달만 하면 됨.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_iforest_warm_start`: `warm_start=True`로 10개 트리 fit → `estimators_[0]`(tree_1) 기억 → `set_params(n_estimators=20)` 후 재fit → `len(estimators_) == 20`이고 `estimators_[0] is tree_1`(동일 객체, 덮어쓰지 않음)을 단언. 즉 (a) 파라미터가 실제로 부모까지 전달되어 warm_start 경로가 켜지는지, (b) 기존 트리 보존 + 신규 추가 동작을 검증.
- **픽스 증명**: 패치 전에는 `__init__`에 `warm_start` 인자가 없어 `IsolationForest(..., warm_start=True)` 자체가 `TypeError`(unexpected keyword argument)로 collection/실행 단계에서 실패. 전달 배선이 추가되어야만 부모의 warm_start 로직이 발동 → 두 단언 통과.
- **overfit 관점**: 테스트가 1개로 얇지만, S1/T-DirectMap에서는 overfit 위험이 본질이 아니다. 픽스가 새 동작 분기를 합성하는 게 아니라 부모의 검증된 로직에 위임만 하므로 special-case 통과 여지가 없음. flags에 overfit-risk 미포함.
- **regression 관점**: 19개 PASS_TO_PASS가 기존 IsolationForest 동작 전반을 고정. 기본값 `False`이므로 모든 기존 호출은 동일 코드경로를 타 회귀 없음. `versionadded:: 0.21`은 문서 메타라 런타임 무영향.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `IsolationForest.__init__`에 `warm_start`를 노출하라고 명시 → `sklearn/ensemble/iforest.py`의 `IsolationForest.__init__`로 즉시 직행. 참조 구현으로 `RandomForestClassifier`(ensemble/forest.py)의 동일 파라미터 배선을 확인.
2. **픽스와 일반화**: 시그니처에 `warm_start=False` 추가 + `super().__init__(..., warm_start=warm_start, ...)` 전달 + docstring 추가. 새 로직을 작성하지 않고 부모 `BaseBagging`의 기존 warm_start 구현에 위임하는 것이 올바른 일반화 — sklearn 전체에서 warm_start의 의미(estimators_ 재사용)가 한 곳(BaseBagging)에 SSOT로 존재하므로 자식이 재구현하면 오히려 drift.
3. **regression 안전**: 기본값 `False`로 두어 기존 19개 P2P(sparse/parallel/chunks/score_samples/deprecation/behaviour_param)가 동일 경로를 유지하게 함. super 호출에 인자를 키워드로 전달해 위치 인자 순서 회귀를 회피.
4. **함정 회피**: (a) 자식에서 `estimators_`를 직접 다루는 자체 warm_start 로직을 새로 짜려는 과잉구현 — 불필요하고 부모와 충돌. (b) `super().__init__`에 전달을 빠뜨리고 시그니처에만 추가하면 인자가 무시되어 테스트의 `estimators_[0] is tree_1`이 깨짐(가장 흔한 미스). (c) docstring/`versionadded`만 추가하고 실제 배선을 누락 — 문서는 통과시키지만 FAIL_TO_PASS는 못 넘김. 핵심은 "노출 = 시그니처 + super 전달" 두 곳을 모두 건드리는 것.
