---
instance_id: scikit-learn__scikit-learn-25102
repo: scikit-learn/scikit-learn
base_commit: f9a1cf072da9d7375d6c2163f68a6038b13b310f
version: "1.3"
difficulty: "1-4 hours"
created_at: 2022-12-02T20:03:37Z
fail_to_pass: 2
pass_to_pass: 59
gold_files: [sklearn/base.py, sklearn/feature_selection/_base.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, underspecified]
---

## 문제 요약
`set_output(transform="pandas")`로 DataFrame 출력을 설정한 feature selection transformer(`SelectKBest` 등)가, 입력 DataFrame의 이질적 dtype(`category`, `float16`, `float32`)을 모두 `float64`로 뭉개버린다. 원인은 `SelectorMixin.transform`이 내부에서 `check_array`를 통해 X를 무조건 ndarray로 캐스팅한 뒤 그 ndarray에서 컬럼을 골라내기 때문이다. 요구사항은 "값은 그대로 두고 컬럼만 선택"하는 transformer는 원본 컨테이너(DataFrame)에서 직접 컬럼을 골라 dtype을 보존하는 것이다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 `sklearn/base.py::_validate_data`와 `sklearn/feature_selection/_base.py::SelectorMixin.transform/_transform` **두 파일을 조율해서** 함께 바꿔야 성립한다. `_validate_data`에 신규 우회 경로(`cast_to_ndarray`)를 뚫고, 그 경로를 호출부에서 조건부로 켜는 구조라 단일 사이트로 끝나지 않는다.
- **S = S6 (Design-Refactor) +S5 (Spec-Inference)**: 한 줄 가드가 아니라, "캐스팅을 선택적으로 끄는 파라미터"라는 작은 구조 변경(seam 도입)이 본질이다. 또한 이슈 본문/긴 메인테이너 토론에서 "전체 transformer가 아니라 값을 안 바꾸는 selector에 한해 원본 컨테이너에서 컬럼 선택"이라는 **좁혀진 스펙을 먼저 재구성**해야 올바른 픽스에 도달한다.
- **K = K-Domain**: sklearn 내부 `_SetOutputMixin`/`_get_output_config`, `_validate_data`의 `n_features_in_`/`feature_names_in_` 설정 계약, `_safe_indexing` 유틸 등 프레임워크 내부 메커니즘 지식이 병목.
- **primary = T-DesignRefactor**: dominant 난점이 "조율된 구조 변경"(신규 파라미터 + 호출부 분기 + 인덱싱 경로 교체)에 있다. 위치 탐색은 키워드로 좁혀지지만, 픽스 자체가 multi-site refactor라 이 라벨이 맞다.
- **repair_strategy 근거(APR 관점)**: 결함이 "잘못된 값/조건"이 아니라 "데이터 컨테이너를 너무 일찍 ndarray로 강제하는 설계"라서 SemFix식 조건 합성으로는 못 푼다. seam(`cast_to_ndarray`)을 새로 만들어 검증 로직과 캐스팅을 분리하는 S6가 본질이고, 적용 범위를 selector로 한정하는 판단이 S5다.

## 난이도 티어
**T5 (어려움)**. 구조적 피처:
- 파일 2개, 함수 3개(`_validate_data`, `transform`, `_transform`) 조율 → L3.
- localize는 비교적 직접적("DataFrame dtype 안 보존" + `set_output` 키워드 → `SelectorMixin`)이라 탐색 난도는 낮지만, 픽스 scope가 cross-file refactor라 줄수보다 설계 부담이 크다.
- `has-repro` 있음(이슈에 최소재현 + 출력 dtype 캡처)이라 픽스 검증은 쉽지만, "어디까지 일반화할지"(전체 transformer? selector만?)가 긴 토론에서야 좁혀지는 underspecified.
- P2P 59개가 feature_selection 전체 동작을 커버 → `transform`/`_transform`의 ndarray/sparse 경로를 안 깨야 하는 regression-trap.

공식 라벨 `1-4 hours`와 일치(T5 = T4~T5 시간대). 다만 공식 시간라벨은 "DataFrame 보존이라는 좁힌 스펙을 합의하기까지의 설계 비용"을 반영하지 않으므로, 구조피처(L3 + S6 + 광범위 P2P)로 봐도 T5가 타당하다.

## 골드패치 분석
**건드린 파일·함수**
- `sklearn/base.py::BaseEstimator._validate_data` — 신규 인자 `cast_to_ndarray=True` 추가. `not no_val_X and no_val_y`(X만) 분기에서 `if cast_to_ndarray:`일 때만 `X = check_array(...)`, 아니면 X를 그대로 두고 `out = X`. y-only/validate_separately 분기에도 같은 가드. 즉 "feature 이름·`n_features_in_` 체크는 하되 ndarray 캐스팅은 건너뛰는" 우회 경로 제공.
- `sklearn/feature_selection/_base.py::SelectorMixin.transform` — `_get_output_config("transform", estimator=self)["dense"]`로 출력 설정을 읽어 `preserve_X = hasattr(X, "iloc") and output_config_dense == "pandas"` 계산. 이를 `self._validate_data(..., cast_to_ndarray=not preserve_X)`로 전달.
- `SelectorMixin._transform` — 선택이 0개일 때 `hasattr(X, "iloc")`면 `X.iloc[:, :0]`(빈 DataFrame, index 보존) 반환. 일반 경로는 `X[:, safe_mask(X, mask)]`(+ 별도 shape 체크)를 `_safe_indexing(X, mask, axis=1)`로 교체. 이 한 줄이 ndarray든 DataFrame이든 동일 인덱싱을 처리하게 만드는 핵심 일반화.

**근본원인**: `transform`이 컬럼 선택(값 불변 연산)임에도 `check_array`로 X를 무조건 ndarray화 → 이질적 dtype이 공통 dtype(float64)으로 승격되어 정보 손실. 인덱싱도 ndarray 전제(`X[:, mask]`)라 DataFrame을 받아도 ndarray로 떨어졌다.

**수정요지**: pandas 출력 모드 + DataFrame 입력이면 캐스팅을 끄고(`cast_to_ndarray=False`) 원본 컨테이너에서 `_safe_indexing`으로 컬럼만 골라 dtype·index를 보존. 검증(feature names/`n_features_in_`)은 그대로 수행.

## 검증 (test_patch)
**FAIL_TO_PASS (2개)**
- `test_base.py::test_output_dataframe` — `StepSelector`를 `_validate_data` 기반으로 재작성(`self.n_features_in_` 사용)하고 `set_output(transform="pandas")` 후 출력 dtype이 입력(`float32`/`category`/`float64`)과 컬럼별로 일치함을 단언. `step=0`이면 아무 컬럼도 선택 안 되며 `UserWarning("No features were selected")` + 빈 DataFrame(index 보존, shape `(n,0)`)을 확인 → `_transform`의 `X.iloc[:, :0]` 경로를 직접 검증.
- `test_feature_select.py::test_dataframe_output_dtypes` — gh-24860 비회귀. `load_iris(as_frame=True)`에 `float32`/`float64`/`category`(`pd.cut`) 섞은 뒤 `SelectKBest(...).set_output(transform="pandas")`로 fit_transform → 선택된 컬럼명·dtype이 입력과 일치.

**픽스 증명**: 두 테스트 모두 "값 불변 + dtype 보존"을 컬럼 단위로 검증하므로, `cast_to_ndarray=False` 경로와 `_safe_indexing`이 실제로 원본 DataFrame을 통과시켜야만 통과. 빈 선택 케이스까지 잡아 `_transform`의 양 분기를 커버.

**overfit/regression 관점**: FAIL_TO_PASS는 2개로 얇지만 dtype·index·빈선택·warning을 함께 단언해 special-case 통과 여지가 작다. 다만 categorical→numeric 같은 lossy 라운드트립이나 sparse+pandas 조합 등 미검증 입력공간은 남아 `overfit-risk`가 완전히 0은 아니다. 59개 P2P(`test_transform_dense/sparse`, `test_inverse_transform_*`, 다수 `SelectKBest`/`fdr`/`fwe` 케이스)가 ndarray·sparse 경로의 기존 동작 불변을 강제 → `_safe_indexing` 교체가 ndarray/CSR 경로를 깨지 않았음을 보증하는 regression 방어막.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 신호 "set_output pandas인데 dtype이 float64로 합쳐짐" + 최소재현(`SelectKBest`) → feature_selection의 공통 변환 진입점 `SelectorMixin.transform`(`_base.py`)로 직행. 거기서 `check_array`(=`_validate_data`)가 dtype 승격의 진범임을 확인.
2. **픽스와 일반화 근거**: 검증(feature names/`n_features_in_`)과 ndarray 캐스팅을 분리하는 seam `cast_to_ndarray`를 `_validate_data`에 도입하고, pandas+DataFrame일 때만 끈다. 컬럼 선택을 `_safe_indexing(X, mask, axis=1)`로 일원화해 ndarray·sparse·DataFrame을 모두 동일 코드로 처리 → "값을 안 바꾸는 selector"라는 클래스 전체에 올바르게 일반화(특정 estimator 하드코딩 회피). 메인테이너 토론이 합의한 "selector에 한정, lossy 변환 transformer는 대상 아님"이라는 좁힌 스펙과 정확히 일치.
3. **regression 안전**: `cast_to_ndarray` 기본값 `True`라 기존 모든 호출부는 byte-identical 동작. `_safe_indexing`은 ndarray/CSR에서 기존 `X[:, safe_mask(X, mask)]`와 동치 → `test_transform_dense/sparse`, `test_inverse_transform_*`, 59개 P2P가 깨지지 않는다. pandas가 아니면 `preserve_X=False`라 옛 경로 그대로.
4. **함정 회피**: (a) 이슈 제안대로 `_wrap_in_pandas_container`에 `astype(dtypes)`를 붙이면 float64로 계산 후 되돌리는 **lossy 캐스팅**이 되어 메인테이너가 명시적으로 반대한 방향 — 오라클 없는 에이전트가 빠지기 쉬운 함정. 올바른 길은 애초에 ndarray로 안 떨어뜨리는 것. (b) `_transform`의 빈 선택 분기에서 DataFrame일 때 `np.empty(...).reshape`로 가면 index가 사라지므로 `X.iloc[:, :0]`로 분기해야 한다. (c) 기존 `if len(mask) != X.shape[1]: raise` shape 가드를 제거하고 `_safe_indexing`에 위임했는데, 이를 남겨두면 DataFrame 경로에서 불필요한 충돌 가능 — 인덱싱 유틸로 일원화하는 게 정답.
