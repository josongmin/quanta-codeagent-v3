---
instance_id: scikit-learn__scikit-learn-14053
repo: scikit-learn/scikit-learn
base_commit: 6ab8c86c383dd847a1be7103ad115f174fe23ffd
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: 2019-06-09T15:36:55Z
fail_to_pass: 1
pass_to_pass: 5
gold_files: [sklearn/tree/export.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`export_text`에 `feature_names`를 넘기고 트리에 피처가 1개뿐이면 `IndexError: list index out of range`가 난다. 원인은 893행 `[feature_names[i] for i in tree_.feature]`가 트리 전체 노드를 순회하는데, `tree_.feature`에는 분기 피처 인덱스(0)뿐 아니라 리프 노드를 뜻하는 센티넬 값 `-2`(`_tree.TREE_UNDEFINED`)가 섞여 있기 때문이다. 길이 1짜리 `feature_names`를 `-2`로 인덱싱하면(`feature_names[-2]`) 범위를 벗어난다. 피처가 여러 개면 음수 인덱스가 우연히 유효해 에러가 가려진다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 스택트레이스가 `IndexError`를 직접 주고, 힌트 스레드가 이미 893행 `feature_names[i] for i in tree_.feature`와 `-2` 센티넬을 정확히 짚었다. grep `export_text` 한 방이면 도달. localize 노력 거의 0.
- **S1 Direct-Map (+S2)**: 결함클래스가 "센티넬 값을 인덱스로 오용" — 정형 경계/None-가드 템플릿에 매칭된다. 픽스는 컴프리헨션에 `if i != _tree.TREE_UNDEFINED else None` 가드 한 줄 추가로 기계적. 다만 "왜 None을 넣어도 안전한가"(리프 위치는 다운스트림에서 절대 안 읽힘)를 따져야 하므로 보조로 S2 약간.
- **K-Domain**: `tree_.feature` 배열에 `_tree.TREE_UNDEFINED == -2`가 리프 마커로 들어간다는 sklearn 트리 내부 표현을 알아야 한다. 일반 파이썬 추론만으론 "왜 길이 1 리스트를 -2로 인덱싱하나"가 안 보인다.
- **primary = T-DirectMap**: 위치가 명확하고 픽스가 가드 추가라는 기계적 템플릿. APR 관점에서 PAR/TBar식 "결함패턴→수리템플릿" 직매핑이며 탐색·테스트반복(G&V)이 불필요하다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·실질 1줄 수정, 1함수(`export_text`), repro 코드와 네이티브 스택트레이스 제공(`has-repro` — 강한 easiness 신호), 컴프리헨션 한 곳만 건드림. T1이 아닌 이유: 픽스가 자명하려면 `_tree.TREE_UNDEFINED` 도메인 지식과 "리프 자리에 무엇을 넣어도 다운스트림이 안 읽는다"는 불변식 확인이 필요해 K-Gen 순수 자명은 아님. T3 이상이 아닌 이유: cross-file 없음, localize 비용 0, P2P trap이 좁다(같은 테스트 파일 5개). 공식 라벨 "15분-1시간"과 정합 — repro가 있어 사람 구현은 거의 가드 한 줄.

## 골드패치 분석
- **파일·함수**: `sklearn/tree/export.py` 의 `export_text(decision_tree, feature_names=...)`, 890행대 `if feature_names:` 분기.
- **근본원인**: `feature_names_ = [feature_names[i] for i in tree_.feature]`가 리프 노드의 센티넬 `tree_.feature[node] == -2`(`_tree.TREE_UNDEFINED`)까지 즉시(eager) 인덱싱한다. 피처 1개일 때 `feature_names`는 길이 1이라 `feature_names[-2]`가 `IndexError`. 인덱스 자체가 아니라 "리프에 대해서도 피처명을 만들려 한다"는 제어흐름이 진짜 문제(힌트 스레드 결론과 일치).
- **수정요지**: 컴프리헨션에 센티넬 가드를 넣어 리프 위치엔 `None`을 채운다.
  `[feature_names[i] if i != _tree.TREE_UNDEFINED else None for i in tree_.feature]`. 분기 노드 인덱스(0 등)는 그대로 정상 매핑.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_export_text`: 단일 피처 `X_single = [[-2],[-1],[-1],[1],[1],[2]]`로 `DecisionTreeRegressor(max_depth=2)`를 학습하고 `feature_names=['first']`로 `export_text`를 호출, 기대 리포트(`|--- first <= 0.0` ... `value: [-1.0, -1.0]`)와 정확히 일치하는지 단언. `show_weights=True` 변형도 동시 검증.
- **픽스 증명**: 패치 전이면 `feature_names_` 생성 단계에서 `feature_names[-2]`가 즉시 `IndexError`를 던져 테스트가 실패. 패치 후엔 리프 위치가 `None`이 되고, 다운스트림 `print_tree_recurse`는 `feature_names_[node]`를 `tree_.feature[node] != _tree.TREE_UNDEFINED`(분기) 가지에서만 읽으므로 `None`은 절대 출력에 안 닿는다 → 정상 리포트 생성.
- **overfit·regression**: `overfit-risk` 낮음 — 가드가 센티넬 일반(`-2`)을 처리해 단일 피처라는 특수케이스를 넘어 모든 트리에 적용. `regression-trap` 표기: 피처가 여러 개인 기존 경로도 같은 컴프리헨션을 타므로 다분기 트리에서 피처명 매핑이 깨지면 안 됨. P2P 5개(`test_graphviz_toy`, `test_precision`, `test_export_text_errors` 등)가 export 출력 포맷을 고정해 회귀를 잡아준다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `IndexError` + `export_text` + repro 한 줄로 `sklearn/tree/export.py`의 `export_text`로 직행. 트레이스/힌트가 `[feature_names[i] for i in tree_.feature]` 컴프리헨션을 지목 → grep `feature_names_` 로 893행 확정.
2. **픽스**: `tree_.feature`가 리프에 `_tree.TREE_UNDEFINED(-2)`를 담는다는 사실을 확인하고(같은 파일 `print_tree_recurse`의 `tree_.feature[node] != _tree.TREE_UNDEFINED` 분기가 증거), 컴프리헨션에 동일 가드를 넣어 리프엔 `None`. 이게 올바른 일반화인 이유: 음수 인덱스가 "우연히 유효"한 다피처 케이스는 사실 잘못된 피처명을 매핑할 수도 있었고, 가드는 그 잠재 오류까지 차단하면서 리프 위치를 의미적으로 "피처 없음"으로 표시한다.
3. **regression 안전**: 다분기·다피처 트리는 분기 노드 인덱스가 유효 범위라 매핑이 패치 전과 동일하게 보존(`else None`은 리프에만 발동). `test_precision`/`test_export_text_errors`가 포맷·검증 경로를 고정하므로 깨지면 즉시 포착.
4. **함정 회피**: (a) 힌트의 잘못된 유도 — `if feature_names and len(feature_names)==n_features` 같은 입력검증 추가는 실제 결함(리프 인덱싱)을 안 고치고 정상 입력을 거부할 수 있다. (b) `feature_names`를 리스트→배열로 바꿔 fancy-index하면 `-2`가 마지막 원소로 매핑돼 에러는 사라지지만 리프에 엉뚱한 피처명이 새는 silent bug. 정답은 센티넬을 명시적으로 걸러 `None`을 넣고, 그 `None`이 분기 가지에서만 읽히는 다운스트림 불변식을 확인하는 것.
