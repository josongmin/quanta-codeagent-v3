---
instance_id: scikit-learn__scikit-learn-12682
repo: scikit-learn/scikit-learn
base_commit: d360ffa7c5896a91ae498b3fb9cf464464ce8f34
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: "2018-11-27T08:30:51Z"
fail_to_pass: 1
pass_to_pass: 66
gold_files: [examples/decomposition/plot_sparse_coding.py, sklearn/decomposition/dict_learning.py]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-API
flags: [regression-trap, cross-file-dep]
---

## 문제 요약
`SparseCoder`는 `algorithm='lasso_cd'`/`'lasso_lars'`일 때 내부적으로 `Lasso`/`LassoLars`를 쓰는데, `max_iter`를 전달하지 않아 기본값 1000으로 고정된다. 그 결과 `examples/decomposition/plot_sparse_coding.py` 예제에서 추정기가 수렴하지 못해 `ConvergenceWarning`이 뜬다. 사용자가 내부 추정기의 `max_iter`를 지정할 수 있는 경로가 필요하다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 한 지점이 아니라 `SparseCoder.__init__` → `_set_sparse_coding_params` → `transform` → `sparse_encode` → `_sparse_encode`로 이어지는 콜체인 전체와, `DictionaryLearning`/`MiniBatchDictionaryLearning` → `dict_learning`/`dict_learning_online`의 병렬 체인까지 **조율해서 함께** 새 인자를 통과시켜야 한다. 단일파일이지만 멀티-site 조율이 본질.
- **S = S6 (Design-Refactor) +S5**: 한 줄 가드가 아니라 새 파라미터(`transform_max_iter`/`method_max_iter`/`max_iter`)를 공개 API와 내부 헬퍼에 일관된 이름·기본값(1000)으로 **도입·배선**하는 소규모 구조 변경. 어디까지 노출할지(공개 `transform_max_iter` vs 내부 `method_max_iter`)는 이슈 토론에서 스펙을 재구성(S5)해야 결정된다.
- **K = K-API (API-contract)**: 기본값 1000을 유지해 하위호환을 깨지 않고, `.. versionadded:: 0.22` 데코로 공개 생성자 시그니처를 확장하는 계약 정합성이 핵심. 도메인 수학지식은 거의 불필요.
- **primary = T-DesignRefactor**: 난점이 "올바른 식 추론"이 아니라 새 파라미터를 콜그래프 전반에 정확히 꿰는 구조적 배선에 있음.
- APR 관점: 결함클래스가 "파라미터 누락(forgotten pass-through)"이라 템플릿(S1)이 아니라 collect-then-thread형 리팩터(S6)가 dominant. 이슈가 `algorithm_kwargs` 대안까지 논의하므로 노출 범위 결정에 spec-inference가 보조로 붙는다.

## 난이도 티어
**T4 (약간 어려움)**. 공식 라벨 "15분-1시간"과 일치한다.
- 파일수: 2 (예제 1 + 코어 1), 코어 줄수는 적당하나 **헌크가 ~20개**로 분산되어 diffuse-edit 성격.
- localize 직접성: 이슈가 `SparseCoder`/`max_iter`/`lasso_cd`를 명시(L0급 진입점)하나, 진짜 작업은 그 인자를 어느 계층까지 어떤 이름으로 흘릴지 결정하는 조율이라 L3로 끌어올림.
- repro: 예제의 `ConvergenceWarning`이 사실상 재현 신호지만 네이티브 스택트레이스는 아님 → `has-repro` 미부여.
- P2P trap: **PASS_TO_PASS 66개**(positivity 파라미터 매트릭스, online/minibatch shapes 등)로 광범위 → `regression-trap`. 새 인자가 모든 기존 호출경로의 기본동작을 1000으로 보존해야 함.
- 도메인: Ricker wavelet 사전은 테스트 픽스처일 뿐, 픽스 자체는 배선이라 도메인 부담 낮음.

## 골드패치 분석
- **건드린 파일·함수**: `sklearn/decomposition/dict_learning.py`의 `_sparse_encode`, `sparse_encode`, `dict_learning`, `dict_learning_online`, `SparseCodingMixin._set_sparse_coding_params`/`transform`, 클래스 `SparseCoder.__init__`, `DictionaryLearning.__init__`/`fit`, `MiniBatchDictionaryLearning.__init__`/`fit`/`partial_fit`. 부수로 예제 `plot_sparse_coding.py`의 `ricker_function`.
- **근본원인**: `_sparse_encode`가 `lasso_cd` 경로의 `Lasso`에는 `max_iter`를 넘기지만 `lasso_lars` 경로의 `LassoLars(...)`에는 `max_iter`를 누락. `sparse_encode`/`_sparse_encode`는 이미 `max_iter=1000`을 받아 `Lasso`까지 흘려보내고 있었다(즉 함수형 진입점은 노출됨). 진짜 미노출은 추정기 클래스(`SparseCoder`/`DictionaryLearning`/`MiniBatch`의 `_set_sparse_coding_params`/`transform`)와 `dict_learning`/`dict_learning_online` 함수 쪽이다 — 후자는 lasso 반복수 인자가 아예 없었고, 기존 `max_iter=100`은 dict-learning **외부반복** 카운트라 이름이 충돌해 골드가 `method_max_iter`를 신설. 그 결과 추정기 진입점에선 lasso 반복수가 항상 1000 고정 → 수렴 실패.
- **수정요지**: (1) `LassoLars(... positive=positive, max_iter=max_iter)`로 누락된 전달을 보강. (2) 공개 추정기에 `transform_max_iter=1000`을, 함수형 API(`dict_learning*`)에 `method_max_iter=1000`을 신설하고 `_set_sparse_coding_params`에 `self.transform_max_iter`로 저장, `transform`/`fit`이 이를 `sparse_encode(..., max_iter=...)`로 흘려보냄. (3) docstring을 `lasso_cd` or `lasso_lars`로 정정하고 `verbose`도 동반 전달. 기본값 1000으로 동작 불변 보장. 예제의 `np.pi ** 1 / 4` 연산자 우선순위 버그도 `np.pi ** .25`로 정정.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_max_iter` 1개. Ricker 사전 + 계단형 신호 `X`로 `SparseCoder(..., transform_max_iter=1)`이 `ConvergenceWarning`을 내는지(미수렴), `transform_max_iter=2000`이 경고 없이(`assert not record.list`) 수렴하는지를 페어로 확인.
- **픽스 증명**: 새 `transform_max_iter`가 `transform → sparse_encode → _sparse_encode`를 거쳐 실제 `Lasso`/`LassoLars`의 반복수에 도달함을 두 극단값(1 vs 2000)의 관측 가능한 동작차로 입증 → 단순 인자수용이 아니라 effect까지 배선 증명.
- **overfit 관점**: 테스트가 `lasso_cd` 경로만 직접 타격(`transform_algorithm='lasso_cd'`)해, `LassoLars`에 `max_iter`를 단 변경분은 이 테스트만으론 검증되지 않는다(약한 overfit 구멍). 다만 골드는 일반화(모든 경로 일괄 배선)를 택했으므로 정답은 더 넓다.
- **regression 관점**: 66개 P2P가 기본값 1000 보존을 강제 → special-case 회피.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈의 "`SparseCoder` + `lasso_cd` + `max_iter` 미전달 + `ConvergenceWarning`" 신호로 `dict_learning.py::_sparse_encode`에 진입 → `lasso_cd` 분기는 `max_iter`를 받지만 `lasso_lars` 분기 `LassoLars(...)`엔 없음을 확인. 거꾸로 호출자(`sparse_encode`→`transform`→`SparseCoder.__init__`)를 따라 올라가며 인자가 끊긴 지점을 모두 수집.
2. **픽스/일반화**: 누락된 `LassoLars(..., max_iter=max_iter)` 보강 + 공개층 `transform_max_iter`/함수층 `method_max_iter` 신설. 한 호출만 패치하지 않고 콜그래프 전체에 같은 인자를 꿰는 것이 올바른 일반화 — 사용자 진입점이 `SparseCoder`/`DictionaryLearning`/`MiniBatch`/함수 API로 다양하기 때문.
3. **Regression 안전**: 모든 신규 파라미터 기본값을 기존 하드코딩과 동일한 1000으로 두어 66개 P2P(positivity 매트릭스, online/minibatch shapes, reconstruction)의 수치·형태 동작을 그대로 보존. 이름 충돌 회피를 위해 공개 API엔 `transform_max_iter`(이미 `max_iter`가 dict_learning 반복수로 점유됨)를 선택.
4. **함정 회피**: (a) `lasso_cd`만 보고 `_sparse_encode` 한 줄만 고치면 공개 노출 경로가 없어 이슈를 못 풀고 `test_max_iter`의 생성자 인자 `transform_max_iter`에서 TypeError. (b) 기존 `max_iter`(dict_learning 외부반복) 의미와 새 lasso 반복수를 혼동하면 회귀. (c) `verbose` 동반 전달을 빠뜨려도 테스트는 통과하나 골드 의도(경고 가시성)에 미달. (d) 예제의 `np.pi ** 1 / 4` 우선순위 버그는 본 이슈와 무관해 보이나 골드가 함께 정정함.
