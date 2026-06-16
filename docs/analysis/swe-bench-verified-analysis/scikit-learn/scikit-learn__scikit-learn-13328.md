---
instance_id: scikit-learn__scikit-learn-13328
repo: scikit-learn/scikit-learn
base_commit: 37b0e66c871e8fb032a9c7086b2a1d5419838154
version: "0.21"
difficulty: "<15 min fix"
created_at: 2019-02-28T12:47:52Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [sklearn/linear_model/huber.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
`HuberRegressor().fit(X, y)`에 boolean dtype의 `X`를 넘기면 `TypeError`가 발생한다. 내부 `_huber_loss_and_gradient`에서 `-axis0_safe_slice(X, ...)`처럼 boolean 배열에 단항 `-` 연산자를 적용하는데, numpy는 boolean 배열에 negative 연산을 허용하지 않기 때문이다(`The numpy boolean negative, the - operator, is not supported`). `LinearRegression`은 boolean을 float로 변환해 잘 동작하므로, `HuberRegressor.fit`도 동일하게 boolean → float 변환을 해야 한다는 것이 기대 동작이다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 네이티브 스택트레이스가 `huber.py`의 `fit` → `_huber_loss_and_gradient` 93번째 줄까지 정확히 지목한다. 입력 검증 지점(`check_X_y`)을 grep 한 방에 찾을 수 있다.
- **S1 (Direct-Map, +S2)**: 결함 클래스가 "입력 dtype 강제 누락"이라는 정형 패턴이다. 픽스는 기존 `check_X_y` 호출에 `dtype=[np.float64, np.float32]` 인자를 추가하는 기계적 작업. 다만 "어떤 dtype 리스트를 넣느냐"(bool→float64 승격, float32 보존)는 가벼운 의미 추론을 동반하므로 S2 보조.
- **K-Domain**: sklearn의 `check_X_y` 검증 유틸리티 계약(`dtype` 인자가 입력 캐스팅을 제어, 리스트면 허용 dtype 우선순위)과 다른 추정기(`LinearRegression`)의 관례를 알아야 한다. 일반 파이썬 추론만으로는 정확한 형태를 못 짚는다.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 검증 함수에 dtype 가드를 추가하는 기계적 매핑이다. "이슈가 사실상 픽스를 명세"한다(기대 결과에 boolean→float 변환을 직접 적시).

APR 관점: 스택트레이스가 근인(boolean negate)을 노출하지만 그 줄을 직접 고치는 대신, 입력 경계에서 dtype을 정규화하는 것이 정석. SemFix류 constraint-reasoning보다는 PAR/TBar식 결함클래스 템플릿(타입 강제 누락 → dtype 인자 주입)에 더 가깝다.

## 난이도 티어
**T2 (쉬움)**.
- 파일 1개(`sklearn/linear_model/huber.py`), 실질 수정 1줄(인자 1개 추가).
- localize 직접성 최상: `has-repro` + 네이티브 스택트레이스가 정확한 함수·줄을 지목.
- 단일 헌크, cross-file 조율 없음.
- P2P 9개는 모두 같은 `test_huber.py` 모듈 내부(sample_weights/sparse/scaling/warm_start 등). regression-trap은 약함 — dtype을 `[np.float64, np.float32]`로 명시하면 기존 float 입력 경로가 그대로 유지되므로 인접 동작이 깨지지 않는다.
- 약한 S2(dtype 리스트 선택)와 K-Domain(check_X_y 계약) 때문에 순수 T1은 아님 — "이슈가 픽스를 거의 적어주는" T1보다는 검증 유틸 관례를 알아야 하는 T2.

공식 라벨 `<15 min fix`와 일치. 구조 피처(1파일/1줄/강한 repro)가 모두 쉬움 쪽을 가리킨다.

## 골드패치 분석
- **건드린 파일·함수**: `sklearn/linear_model/huber.py`, `HuberRegressor.fit`.
- **근본 원인**: `fit`이 입력을 `check_X_y(X, y, copy=False, accept_sparse=['csr'], y_numeric=True)`로 검증하면서 `dtype`을 지정하지 않았다. `dtype` 미지정 시 `check_X_y`는 입력 dtype을 그대로 보존하므로 boolean 배열이 그대로 통과해, 하류 `_huber_loss_and_gradient`의 `-axis0_safe_slice(X, ~outliers_mask, n_non_outliers)`에서 boolean 단항 부정이 `TypeError`를 일으킨다.
- **수정 요지**: `check_X_y` 호출에 `dtype=[np.float64, np.float32]`를 추가. 이 리스트는 "입력이 float32면 보존, 그 외(boolean 포함)는 float64로 캐스팅"을 의미한다. 결과적으로 boolean → float64 변환이 검증 단계에서 일어나 numerical loss/gradient 경로가 정상 float 산술을 받게 된다.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_huber_bool`: `make_regression`으로 데이터를 만든 뒤 `X_bool = X > 0`(boolean)로 `HuberRegressor().fit(X_bool, y)`가 크래시 없이 완료되는지만 검사한다. 픽스 전엔 `TypeError`, 후엔 dtype 캐스팅 덕에 통과.
- **픽스 증명**: 테스트는 정확한 계수값을 비교하지 않고 "크래시하지 않음"만 단언한다. 픽스가 boolean을 검증 단계에서 float로 승격시키므로 boolean negate 경로가 사라져 통과한다.
- **overfit/regression 관점**: FAIL_TO_PASS가 1개이고 "no-crash"만 보므로 표면적으론 얇아 보이나, 픽스가 입력 경계에서 일반적 dtype 정규화를 하기 때문에 boolean뿐 아니라 int 등 다른 비-float 입력도 함께 일반화된다(special-case 회피). float32 보존을 명시해 정밀도 회귀도 막는다. test_patch의 나머지 변경(`loss_func`/`grad_func` lambda→def, 주석 줄바꿈, `tol` 인자 줄바꿈)은 PEP8 정리일 뿐 동작 무관. P2P 9개(특히 `test_huber_sparse`의 csr 경로, `test_huber_sample_weights`)는 dtype 인자가 기존 float/csr 입력을 변경하지 않으므로 안전.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 네이티브 스택트레이스가 `_huber_loss_and_gradient`의 `-axis0_safe_slice(X, ...)` + 에러 메시지("numpy boolean negative ... not supported")로 근인을 명시한다. 하지만 손실 함수 내부에서 매번 `~`/`logical_not`으로 우회하는 대신, 입력이 들어오는 `fit`의 `check_X_y` 검증 지점이 정규화의 정석 위치임을 인지한다. `LinearRegression`이 boolean을 받아주는 이유를 비교하면 그쪽이 `check_X_y`에 dtype을 지정한다는 단서로 수렴.
2. **픽스와 일반화 근거**: `check_X_y(...)`에 `dtype=[np.float64, np.float32]`를 추가. 이는 손실 계산 줄을 패치하는 국소 우회가 아니라 입력 계약을 고치는 것이라, boolean/int 등 모든 비-float 입력을 일반적으로 처리한다. float32를 리스트에 포함해 float32 사용자의 메모리/정밀도 동작을 보존 — 무조건 float64 캐스팅보다 올바른 일반화.
3. **regression 안전**: 기존 float64/float32/csr-sparse 입력은 dtype 리스트가 그 dtype을 보존하므로 동작 불변. P2P의 `test_huber_sparse`(accept_sparse=['csr'] 유지), `test_huber_sample_weights`, `test_huber_scaling_invariant` 등이 깨지지 않는다.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) 스택트레이스만 보고 `_huber_loss_and_gradient`의 `-` 연산을 `~`/`logical_not`으로 국소 패치 → boolean만 통과시키는 overfit이고 다른 비-float 입력은 여전히 위험. (b) `dtype=np.float64` 단일값으로 강제 → float32 입력의 정밀도/메모리 동작을 침해하는 회귀. 정답은 검증 경계에서 `[np.float64, np.float32]` 리스트로 캐스팅해 일반성과 float32 보존을 동시에 달성하는 것이다.
