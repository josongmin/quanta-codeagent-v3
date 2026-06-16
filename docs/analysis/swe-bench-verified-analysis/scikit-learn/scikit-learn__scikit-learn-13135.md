---
instance_id: scikit-learn__scikit-learn-13135
repo: scikit-learn/scikit-learn
base_commit: a061ada48efccf0845acae17009553e01764452b
version: "0.21"
difficulty: "<15 min fix"
created_at: 2019-02-11T21:34:25Z
fail_to_pass: 1
pass_to_pass: 33
gold_files: [sklearn/preprocessing/_discretization.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`KBinsDiscretizer`를 `strategy='kmeans'`로 쓸 때 특정 상황(예: `n_bins`가 데이터 포인트 수에 가까울 때)에서 `ValueError: bins must be monotonically increasing or decreasing`로 실패한다. 원인은 1D KMeans가 반환하는 `cluster_centers_`가 정렬 보장이 없어서, 이로부터 만든 `bin_edges`가 단조증가가 아니게 되고, `transform`의 `np.digitize` 호출이 단조 bins를 요구하기 때문이다. 이슈는 재현 코드와 네이티브 traceback을 모두 제공한다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 파일·함수·심볼을 직접 지목한다. traceback이 `_discretization.py`의 `transform` → `np.digitize`를 가리키고, 본문이 "centers and consequently bin_edges being unsorted"라며 근본을 `fit`의 centers 생성부로 못 박는다. grep 한 방으로 `KMeans(...).fit(...).cluster_centers_` 라인을 찾는다.
- **S (Repair Strategy) = S1 (+S2)**: 결함 클래스가 "정렬 불변식 위반" → 정형화된 템플릿(정렬 강제 1줄 삽입)에 매칭된다. dominant는 S1(기계적 `centers.sort()`). 보조 S2는 "왜 fit 단계에서 정렬해야 하고 transform 쪽 우회가 아닌지"의 불변식 추론(centers가 bin_edges의 전제이므로 가장 상류에서 고정)을 깔끔히 해야 한다는 점.
- **K (Knowledge) = K-Domain**: 일반 파이썬이 아니라 sklearn 도메인 지식 필요 — `KMeans.cluster_centers_`가 정렬을 보장하지 않는다는 점, bin_edges가 centers의 midpoint로 정의된다는 점, `np.digitize`가 단조 bins를 요구한다는 점을 알아야 진짜 원인을 짚는다.
- **primary_type = T-DirectMap**: 위치가 L0로 자명하고 픽스가 "정렬 강제" 1줄 기계적 매핑이다. 추론은 가볍고(엣지 인지 수준), 위치 탐색의 어려움도 없으므로 T-DirectMap. APR 관점: 결함이 known fault class(invariant restoration)라 template repair(PAR/TBar 계열)로 바로 합성 가능하다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`sklearn/preprocessing/_discretization.py`), 실효 변경 1줄(+주석 1줄). <5줄 컷에 든다(ICLR 2024 ~48% solve 구간).
- localize 직접성 매우 높음(L0): traceback + 본문이 근본 라인을 명시.
- `has-repro`: 네이티브 스택트레이스 + 6-포인트 재현 배열 제공(가장 강한 easiness 신호).
- 도메인 지식이 약간 필요(K-Domain)하지만 KMeans 정렬 미보장은 흔한 함정이라 T3까지 밀지 않는다.
- `regression-trap` 약하게 존재: PASS_TO_PASS 33개로 uniform/quantile/inverse_transform/numeric_stability 등 인접 동작이 넓다. 단 픽스가 kmeans 브랜치 내부 1줄이라 다른 전략에 영향이 없어 trap이 실현될 위험은 낮다.
공식 라벨 `<15 min fix`와 일치 — 이 케이스는 시간라벨이 에이전트 난이도와 어긋나지 않는다.

## 골드패치 분석
- **파일·함수**: `sklearn/preprocessing/_discretization.py`의 `KBinsDiscretizer.fit`, 정확히는 `strategy == 'kmeans'`의 "1D k-means procedure" 블록.
- **근본원인**: `km = KMeans(n_clusters=n_bins[jj], init=init, n_init=1)` 후 `centers = km.fit(column[:, None]).cluster_centers_[:, 0]`로 얻은 `centers`가 정렬되어 있지 않다. `init`이 정렬되어 있어도 KMeans 반복 후 클러스터 중심의 순서가 뒤섞일 수 있다. 다음 줄 `bin_edges[jj] = (centers[1:] + centers[:-1]) * 0.5`가 인접 midpoint를 계산하는데, centers가 비정렬이면 bin_edges도 비단조가 되고, `transform`의 `np.digitize(... , bin_edges[jj][1:])`가 ValueError를 던진다.
- **수정요지**: midpoint 계산 직전에 `centers.sort()`(in-place)를 삽입해 단조성을 복원. 골드 주석이 의도를 명시한다: "Must sort, centers may be unsorted even with sorted init".

```python
centers = km.fit(column[:, None]).cluster_centers_[:, 0]
# Must sort, centers may be unsorted even with sorted init
centers.sort()
bin_edges[jj] = (centers[1:] + centers[:-1]) * 0.5
```

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_nonuniform_strategies[kmeans-...-expected_5bins1]`. 기존 파라미터화 테스트에 `expected_5bins` 컬럼과 `n_bins=5` 케이스를 추가했다. kmeans 기대값 `[0, 0, 1, 2, 3, 4]`는 정렬된 centers로 만든 단조 bin_edges에서만 나온다 — 픽스 전엔 `np.digitize`가 던지는 ValueError로 죽고, 픽스 후엔 정확한 라벨이 나온다.
- **픽스 증명**: 입력 `X = [0, 0.5, 2, 3, 9, 10]`, `n_bins=5`는 본문의 재현 입력과 동일. 정렬 강제가 digitize의 단조성 전제를 만족시켜 예외를 제거하고 정확한 ordinal 라벨을 산출.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 픽스가 특정 입력에 맞춘 special-case가 아니라 보편 불변식(centers 정렬) 복원이라 overfit이 아니다. CEGIS류 구별입력이 필요 없는 구조 — 정렬은 모든 비정렬 입력을 일괄 처리한다.
- **regression 관점**: uniform/quantile expected_5bins(`[0,0,1,1,4,4]`, `[0,1,2,3,4,4]`)도 같은 테스트에 추가됐고 PASS_TO_PASS로 보존된다. 픽스가 kmeans 브랜치에 국한되어 이들·inverse_transform·numeric_stability를 깨지 않음을 33개 P2P가 보증한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: traceback의 마지막 프레임 `transform → np.digitize(... bin_edges[jj][1:])`와 에러 메시지 "bins must be monotonically increasing"이 직접 신호다. 그러나 본문이 "centers and consequently bin_edges being unsorted"로 근본을 상류로 지목하므로, transform에 가드를 넣는 게 아니라 `fit`의 kmeans 블록 `cluster_centers_` 라인으로 거슬러 올라가야 한다.
2. **픽스와 일반화 근거**: centers 생성 직후 `centers.sort()`로 단조성을 가장 상류에서 고정한다. bin_edges는 centers의 인접 midpoint이므로, centers가 정렬되면 bin_edges도 단조 → digitize 전제 충족. 이는 입력별 패치가 아니라 "1D KMeans 중심은 정렬 미보장"이라는 보편 사실에 대한 불변식 복원이므로 올바른 일반화다.
3. **regression 안전**: uniform/quantile 전략은 bin_edges를 다른 경로(linspace/percentile)로 만들어 이미 단조라 영향받지 않아야 한다 — 픽스를 kmeans 브랜치 안에만 두어 보장. inverse_transform, transform_outside_fit_range, numeric_stability, same_min_max 등 33개 P2P가 안 깨져야 하며, 1줄 in-place sort는 이들과 직교한다.
4. **함정 회피**: (a) 증상 자리(transform)에서 digitize 입력을 정렬하거나 try/except로 우회하면 근본을 안 고치고 bin label 의미가 틀어진다 — 반드시 fit의 centers에서 고정. (b) `np.sort(centers)`로 새 배열을 만들면 동작은 같으나 골드는 in-place `centers.sort()`를 쓴다(둘 다 정답이나 reassign 누락 주의). (c) FAIL_TO_PASS가 1개라 "5 bins만 통과"하게 좁게 맞추려는 유혹이 있으나, 정렬 강제가 정답이지 expected 배열 하드코딩이 아니다.
