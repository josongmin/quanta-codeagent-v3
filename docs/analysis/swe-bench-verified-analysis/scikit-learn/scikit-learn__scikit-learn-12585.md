---
instance_id: scikit-learn__scikit-learn-12585
repo: scikit-learn/scikit-learn
base_commit: bfc4a566423e036fbdc9fb02765fd893e4860c85
version: "0.21"
difficulty: "<15 min fix"
created_at: 2018-11-14T13:20:30Z
fail_to_pass: 1
pass_to_pass: 22
gold_files: [sklearn/base.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`sklearn.base.clone`은 파라미터가 estimator의 **인스턴스가 아니라 클래스(타입) 그 자체**일 때 깨진다. 예: `clone(StandardScaler(with_mean=StandardScaler))`. `clone`은 객체가 `get_params` 속성을 가지면 estimator로 간주하고 `estimator.get_params(deep=False)`를 호출하는데, 클래스 객체도 `get_params` 속성(언바운드 메서드)을 가지므로 분기를 통과해 `TypeError: get_params() missing 1 required positional argument: 'self'`가 발생한다. 이슈 본문이 재현코드와 정확한 픽스 라인까지 제시한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 `base.py` line 51과 `clone` 함수, 그리고 네이티브 스택트레이스(`base.py line 60/62`)까지 직접 지목. grep 한 방. 점수: L0.
- **S1 (Direct-Map) + 보조 S2**: 결함클래스가 "estimator 판별 조건이 너무 느슨함(타입 가드 누락)"이라는 정형 패턴이고, 이슈가 픽스 표현식(`or isinstance(estimator, type)`)을 그대로 적어줌 → 기계적 매핑(S1). 다만 "왜 `isinstance(obj, BaseEstimator)`나 `inspect.ismethod`가 아니라 `isinstance(obj, type)`인가"를 판단하려면 Kernel 같은 비-estimator도 `get_params`를 가진다는 불변식 추론이 필요 → 약한 S2 보조.
- **K-Domain**: 올바른 일반화를 고르려면 sklearn duck-typing 관례(`get_params` 보유=estimator-like, 단 Kernel 등 예외)를 알아야 함. 순수 파이썬 추론만으론 `BaseEstimator` isinstance 검사로 과하게 좁힐 위험. 점수: K-Domain.
- **primary = T-DirectMap**: 위치가 자명하고(L0) 픽스가 기계적 가드 추가(S1)이며, 이슈가 사실상 패치를 명세한다. T-DirectMap이 dominant.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- 파일수 1개, 변경 줄수 1줄(단일 조건 확장) → 최소 scope.
- localize 직접성 최상(L0): 함수·라인·스택트레이스 모두 명시.
- `has-repro`: 3줄 재현코드 + 정확한 traceback → 가장 강한 easiness 신호.
- 다만 순수 T1이 아닌 이유: 픽스 표현식 선택에 가벼운 도메인 추론(K-Domain)이 들어가고, P2P 22개가 `clone` 의미를 광범위하게 고정해 `regression-trap`이 존재. 따라서 "거의 픽스를 적어주는" T1보다 반 단계 위.
- 공식 라벨 `<15 min fix`와 일치(이슈가 픽스를 제공하므로 개발자 구현시간은 사실상 패치+테스트 작성 시간).

## 골드패치 분석

- **건드린 파일·함수**: `sklearn/base.py` 의 `clone(estimator, safe=True)`.
- **근본원인**: estimator 판별 분기가
  `elif not hasattr(estimator, 'get_params'):`
  뿐이라, **클래스 객체**(예: `StandardScaler` 자체)도 `get_params` 어트리뷰트를 가지므로 이 가드를 통과하지 못하고 아래의 estimator 복제 경로(`estimator.get_params(deep=False)`)로 들어간다. 언바운드 메서드를 인자 없이 호출 → `TypeError`.
- **수정요지**: 조건을 `elif not hasattr(estimator, 'get_params') or isinstance(estimator, type):` 로 확장. 즉 "get_params가 없거나 **객체가 타입(클래스)이면**" non-estimator 분기로 보낸다. 그 분기에서 `safe=False`면 `copy.deepcopy`로 떨어지는데, 클래스는 deepcopy 시 동일 객체를 반환하므로 `clf.empty is clf2.empty`가 성립한다.

## 검증 (test_patch)

- **FAIL_TO_PASS** `test_clone_estimator_types`: `MyEstimator(empty=MyEstimator)`를 만들고 `clone` 후 `assert clf.empty is clf2.empty`. 픽스 전에는 `clone(MyEstimator, safe=False)`가 `get_params()` 호출에서 `TypeError`로 죽고, 픽스 후에는 `isinstance(MyEstimator, type)`이 True라 deepcopy 경로로 가 클래스 객체가 **그대로(identity 보존)** 복제된다.
- **픽스 증명**: `is` 동일성 단언이 핵심 — 클래스가 인스턴스화되거나 재복제되지 않고 패스스루됨을 확정한다.
- **overfit 관점**: 테스트가 하나뿐이라 얇아 보이나, 가드가 `isinstance(estimator, type)`이라는 **일반 술어**라 special-case 하드코딩이 아니다. 어떤 클래스 파라미터든 동일하게 처리 → overfit 위험 낮음. `overfit-risk` 미부여.
- **regression 관점**: P2P 22개(`test_clone`, `test_clone_buggy`, `test_clone_sparse_matrices`, `test_get_params`, `test_set_params*` 등)가 인스턴스 estimator의 정상 복제·예외 처리를 모두 고정. 추가 가드는 `isinstance(x, type)`이 False인 정상 인스턴스 경로를 건드리지 않으므로 이들 모두 그대로 통과. `regression-trap` 부여.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 traceback이 `base.py`의 `clone`과 `new_object_params = estimator.get_params(deep=False)` 라인을 직접 가리킴 → `clone` 함수의 estimator 판별 `elif not hasattr(estimator, 'get_params')` 분기로 즉시 수렴. 탐색 비용 0.
2. **픽스와 일반화 근거**: 근본 결함은 "estimator 판별이 `get_params` 어트리뷰트 유무만 봐서, 메서드를 클래스 레벨에 가진 **타입 객체**를 걸러내지 못함". 올바른 일반화는 `or isinstance(estimator, type)`로 모든 클래스 객체를 non-estimator로 라우팅하는 것. 클래스 파라미터 하나에 대한 분기가 아니라 타입 술어이므로 임의 입력에 견고.
3. **regression 안전**: 정상 인스턴스(`isinstance(x, type)` False)는 분기 평가가 변하지 않아 P2P 22개가 불변. 특히 `test_clone_buggy`(예외 의도) / `test_clone_sparse_matrices` / `test_get_params` 등 인스턴스 경로를 깨지 않음을 확인.
4. **함정 회피**: 오라클 없는 에이전트의 과좁힘 위험 — 판별을 `isinstance(estimator, BaseEstimator)`로 바꾸면 `get_params`를 가진 비-estimator(예: 커널 `Kernel`)의 복제가 깨진다(이슈 댓글이 명시). 정답은 estimator 화이트리스트가 아니라 **클래스 객체 블랙리스트(`isinstance(_, type)`)**다. 또 다른 함정은 픽스를 deepcopy 경로 대신 `get_params` 호출부에 try/except로 땜질하는 것 — 근본원인(판별 조건)이 아니라 증상을 막는 것이라 `safe=True` 경로에서 여전히 부정확. 가드는 반드시 estimator 판별 `elif`에 둬야 한다.
