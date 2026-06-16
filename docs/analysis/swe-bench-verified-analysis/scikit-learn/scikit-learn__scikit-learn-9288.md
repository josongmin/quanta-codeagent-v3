---
instance_id: scikit-learn__scikit-learn-9288
repo: scikit-learn/scikit-learn
base_commit: 3eacf948e0f95ef957862568d87ce082f378e186
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: 2017-07-06T11:03:14Z
fail_to_pass: 1
pass_to_pass: 123
gold_files: [sklearn/cluster/k_means_.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`cluster.KMeans`가 동일한 `random_state`를 줘도 `n_jobs=1`일 때와 `n_jobs>1`일 때 약간 다른 클러스터링 결과(예: `inertia_`)를 낸다. 재현 코드와 기대/실제 inertia 값이 이슈에 그대로 첨부되어 있다. 힌트가 정확히 짚듯, 두 경로가 `n_init`번의 반복에 서로 다른 난수 시드를 공급해서 생긴 불일치다. 합의된 방향은 "버전 내 일관성"을 위해 두 경로가 같은 시드를 쓰도록 통일하는 것.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 파일/심볼을 직접 지목하진 않지만, 증상(`n_jobs` 분기 차이)이 곧장 `k_means_.py`의 `n_jobs` 분기로 수렴한다. 게다가 힌트가 `k_means_.py#L338-L363`을 명시 링크로 박아준다. grep 한두 방.
- **S2 (+S6, Constraint-Reasoning)**: 고칠 지점은 명확하나, "두 경로가 동일 결과를 내려면 per-init 시드를 양쪽에서 공유해야 한다"는 불변식을 추론으로 합성해야 한다. 단순 가드/상수 변경(S1)이 아니라, 시드 생성 위치를 루프 바깥으로 끌어올리는 작은 구조 이동(S6)을 동반한다.
- **K-Domain**: `random_state.randint`로 미리 시드를 뽑아 각 `kmeans_single` 호출에 넘긴다는 sklearn의 RNG 관례, Parallel/joblib 경로가 이미 그렇게 하고 있다는 내부 지식이 픽스의 정답 형태를 결정한다.
- **primary = T-ConstraintReason**: 위치는 쉽게 좁혀지지만 난점은 "어디"가 아니라 "두 경로의 RNG 소비를 어떻게 동치로 맞추느냐"는 불변식 추론에 있다.

## 난이도 티어
**T3 (중간).** 구조적 피처: 단일 파일(`k_means_.py`) 1함수(`k_means`), 실질 수정은 약 4줄 hunk 2개. has-repro(이슈에 정확한 수치 재현)로 easiness가 높지만, 픽스가 자명한 한 줄 가드가 아니라 "왜 single-thread 경로가 매 init마다 같은 `random_state` 객체를 그대로 넘겨서 어긋나는가"를 이해해야 한다. P2P가 119개로 광범위해 regression-trap이 있다(시드 변경이 인접 KMeans 동작을 바꾸면 안 됨). 공식 라벨 "15분-1시간"과 일치 — localize는 힌트 덕에 쉬우나 RNG 동치 추론과 넓은 회귀면 때문에 T2 아래로는 내려가지 않는다.

## 골드패치 분석
- **파일·함수**: `sklearn/cluster/k_means_.py`의 `k_means(...)` (모듈 레벨 함수, `KMeans.fit`이 호출).
- **근본원인**: 병렬 경로(`else` 브랜치)는 `seeds = random_state.randint(np.iinfo(np.int32).max, size=n_init)`로 미리 `n_init`개의 정수 시드를 뽑아 각 `kmeans_single`에 `random_state=seed`로 넘겼다. 반면 단일 스레드 경로(`if effective_n_jobs(n_jobs) == 1`)는 매 반복마다 **동일한 `random_state` 객체**를 `kmeans_single(..., random_state=random_state)`로 그대로 넘겼다. 같은 `random_state` 객체는 호출 내부에서 소비되며 상태가 진행되므로, 시드 추출 → 정수 시드 사용 경로와 RNG 소비 순서가 달라져 결과가 어긋났다.
- **수정요지**: `seeds = random_state.randint(...)` 한 줄을 `if/else` 분기 **앞**으로 끌어올려 양쪽이 공유. 단일 스레드 루프를 `for it in range(n_init)` → `for seed in seeds`로 바꾸고 `random_state=random_state` → `random_state=seed`로 교체. `else` 브랜치 안에 있던 중복 `seeds = ...` 라인은 삭제. 결과적으로 두 경로 모두 동일한 per-init 정수 시드 배열을 소비한다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `test_result_of_kmeans_equal_in_diff_n_jobs`. `RandomState(0)`로 `(50,10)` 데이터 생성 후 `KMeans(n_clusters=3, random_state=0, n_jobs=1)`와 `n_jobs=2`의 `labels_`를 `assert_array_equal`로 비교. 픽스 전엔 두 경로의 시드 공급 방식이 달라 라벨이 어긋나 실패, 픽스 후엔 동일 `seeds` 배열을 공유하므로 정확히 일치한다.
- **픽스 증명**: 테스트가 "label 동치"라는 정확한 불변식을 직접 단언 — 골드패치가 보장하는 바로 그 속성이다.
- **overfit/regression 관점**: 단일 입력(50×10, k=3)만 검사하므로 형식상 얇지만, 픽스가 입력에 의존하지 않는 구조 변경(시드 공유)이라 special-case overfit 여지는 작다. 진짜 리스크는 regression: 119개 P2P(`test_kmeans_results`, `test_k_means_fit_predict`, `test_predict`, `test_float_precision` 등)가 단일 스레드 KMeans의 수치 출력을 광범위하게 고정한다. 시드 생성 방식이 바뀌면 이 기대값들이 깨질 수 있는데, 모두 통과한다는 건 변경이 RNG 동치를 유지함을 보여준다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "`n_jobs=1` vs `n_jobs>1` 차이" 신호 → `n_jobs` 분기가 있는 곳을 grep → `k_means_.py`의 `k_means` 함수 안 `if effective_n_jobs(n_jobs) == 1: ... else:` 분기. 힌트가 라인까지 링크하므로 즉시 도달.
2. **픽스**: 두 경로의 RNG 소비를 동치로 만든다. 병렬 경로가 이미 `random_state.randint`로 `n_init`개 정수 시드를 뽑으므로, 그 라인을 분기 앞으로 hoist해 SSOT로 만들고 단일 스레드 루프도 `for seed in seeds`로 같은 시드를 소비하게 한다. 이게 overfit이 아닌 올바른 일반화인 이유: 임의의 입력·`n_clusters`·`n_init`에 대해 두 경로가 **같은 시드 시퀀스**를 쓰게 만드는 구조적 보장이지, 특정 테스트 데이터를 맞추는 게 아니다.
3. **regression 안전**: 119개 P2P가 단일 스레드 KMeans 수치 출력을 고정한다. 병렬 경로의 시드 생성 방식(`randint`로 정수 뽑기)을 **그대로 채택**해 단일 스레드를 거기에 맞추는 게 핵심 — 반대로 병렬 경로를 단일 스레드 쪽 객체-패싱으로 바꿨다면 병렬 P2P가 깨졌을 것이다. 골드는 더 적게 깨지는 방향(병렬 동작 보존)을 골랐다.
4. **함정 회피**: (a) 단일 스레드 루프에서 `random_state=random_state`를 안 바꾸고 `seeds`만 추가하면 여전히 어긋난다 — 객체 자체 전달이 원인임을 놓치기 쉽다. (b) `else` 브랜치의 기존 `seeds = ...`를 지우지 않고 앞에도 추가하면 중복(이중 소비)으로 병렬 결과가 바뀌어 P2P가 깨진다 — 반드시 단일 라인으로 통합. (c) 동치를 추구하다 `random_state` 자체를 매 반복 재시드하는 식으로 과하게 손대면 광범위한 수치 회귀를 유발. 최소 변경(시드 hoist + 단일 루프 교체)이 정답.
