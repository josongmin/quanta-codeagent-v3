---
instance_id: matplotlib__matplotlib-13989
repo: matplotlib/matplotlib
base_commit: a3e2897bfaf9eaac1d6649da535c4e721c89fa69
version: "3.0"
difficulty: "<15 min fix"
created_at: 2019-04-19T01:47:57Z
fail_to_pass: 1
pass_to_pass: 411
gold_files: [lib/matplotlib/axes/_axes.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`plt.hist(x, "auto", range=(0,1), density=True)`가 `density=True`일 때 `range=...`를 무시한다. 첫/마지막 bin edge가 0과 1로 고정되지 않고 데이터 자체 범위로 잡힌다. 이슈는 `density=False`에선 정상이라고 명시하고, 원인 커밋(#8638)까지 bisect로 지목해 준다. 즉 회귀(regression) 버그이며 재현 코드가 그대로 제공된다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 `hist()`·`range`·`density` 조합을 직접 지목하고 원인 PR(#8638)까지 bisect로 제공 → `_axes.py`의 `hist()` 한 함수로 grep 한 방에 수렴. 탐색 비용 사실상 0.
- **S2 (Constraint-Reasoning)**: 고칠 한 줄은 자명하나, *왜* 틀렸는지(불변식 위반)를 이해해야 올바른 한 줄을 쓴다. `hist_kwargs`는 `range`/`density`를 누적해야 하는 딕셔너리인데 `dict(density=...)`로 **재할당**하면 직전에 넣은 `hist_kwargs['range'] = bin_range`가 통째로 날아간다. 단순 상수 변경(S1)이 아니라 "딕셔너리는 덮어쓰지 말고 키만 추가" 라는 데이터플로우 불변식을 추론해 고친다.
- **K-Gen**: matplotlib 도메인 지식 불필요. 순수 파이썬 가변 객체 재할당 vs 키 갱신의 일반 추론으로 충분.
- **primary = T-DirectMap**: 위치가 L0로 확정되고 픽스가 거의 기계적(딕셔너리 재할당→키 대입)이라 Direct-Map. S2 색채가 있으나 추론 깊이가 얕아 ConstraintReason까지 가지 않음. APR 관점에선 "한 줄 식 수정 + 불변식 보존"으로 SemFix류 가벼운 의미 수리.

## 난이도 티어
**T2 (쉬움)**. 구조 피처: 파일 1개 / 변경 1줄 / localize 직접성 최상(L0, bisect 제공) / `has-repro` 존재(가장 강한 easiness 신호) / 도메인 지식 무관(K-Gen). 공식 라벨 "<15 min fix"와 일치. T1로 더 내리지 않는 이유는, 이슈가 픽스 *문장*을 적어주지는 않고 "range가 무시된다"는 증상만 주므로 `hist_kwargs` 흐름을 한 번 읽고 재할당 버그임을 스스로 짚는 약한 엣지 추론이 필요하기 때문(순수 S1 템플릿 매칭은 아님). P2P가 411개로 넓어 `regression-trap` 신호가 있으나, 픽스가 `range` 키 보존을 **추가**할 뿐 기존 동작을 빼지 않아 실질 회귀 위험은 낮다.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/axes/_axes.py` 의 `Axes.hist()`.
- **근본 원인**: `bins` 미지정 단일 데이터셋 경로에서 `hist_kwargs['range'] = bin_range`로 range를 먼저 채운다. 이어서 density 분기에서
  `hist_kwargs = dict(density=density)`
  로 **딕셔너리 전체를 새 객체로 교체**하면서 직전에 넣은 `range` 키가 소실된다. 그 결과 `np.histogram(..., **hist_kwargs)` 호출에 `range`가 전달되지 않아 numpy가 데이터 min/max로 bin을 재산정 → edge가 (0,1)이 아니게 된다. 원인 커밋 #8638이 density 처리를 추가하며 이 재할당을 넣은 회귀.
- **수정 요지**: 재할당을 키 대입으로 바꿔
  `hist_kwargs['density'] = density`
  로 한다. range가 이미 들어있으면 보존하고 density만 더한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_hist_range_and_density`. `plt.hist(np.random.rand(10), "auto", range=(0,1), density=True)`의 반환 `bins`에 대해 `bins[0]==0`, `bins[-1]==1`을 단언. 픽스 전엔 range가 소실돼 첫/끝 edge가 데이터 범위로 잡혀 실패, 픽스 후 range가 `np.histogram`까지 전달돼 edge가 (0,1)로 고정 → 통과.
- **픽스 증명**: 테스트가 density=True와 range를 *동시에* 거는 정확한 회귀 조합을 친다. range 보존이 안 되면 단언이 깨지므로 골드 한 줄과 테스트가 직접 대응.
- **overfit 관점**: F2P 1개로 얇지만 special-case 우회가 어렵다 — edge 두 끝을 동시에 (0,1)로 맞추려면 range를 실제로 전달하는 일반 픽스 외엔 통과 불가. `overfit-risk`는 약함.
- **regression 관점**: P2P 411개에 `test_hist_normed_density[*]`, `test_hist_unequal_bins_density`, `test_hist2d_density_normed` 등 density·hist 경로가 다수. 재할당→키대입은 density 미지정/스택 경로(분기 진입 안 함)와 density만 있고 range 없는 경로(키 추가만 됨)를 모두 그대로 보존하므로 이들이 깨지지 않는다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `hist()`+`range`+`density` 조합과 원인 PR #8638을 직접 준다 → `lib/matplotlib/axes/_axes.py`의 `hist()`에서 `density`와 `hist_kwargs`를 grep. density 분기 직전 `hist_kwargs['range'] = bin_range`가 있고 직후 분기에서 `hist_kwargs`가 새 dict로 재할당되는 것을 즉시 발견.
2. **픽스**: `hist_kwargs = dict(density=density)` → `hist_kwargs['density'] = density`. 올바른 일반화인 이유 — 버그의 본질은 "누적해야 할 딕셔너리를 덮어썼다"이고, 키 대입은 range가 있든 없든 항상 옳게 동작한다(range 있으면 보존, 없으면 density만). 특정 입력에 맞춘 우회가 아니라 데이터플로우 불변식을 복구하는 수정.
3. **regression 안전**: `test_hist_normed_density[*]`(density 결과값), `test_hist_unequal_bins_density`, `test_hist2d_density_normed` 등 411개 P2P를 안 깨야 한다. 키 대입은 density 처리 동작을 그대로 두고 range 소실만 막으므로 안전. 분기 조건(`density and not stacked`) 자체는 건드리지 않아 stacked 경로도 불변.
4. **함정 회피**: (a) 증상만 보고 numpy `histogram_bin_edges`나 `bin_range` 계산부를 의심해 엉뚱한 곳을 고치는 것 — 실제 결함은 그 이후 kwargs 누적부다. (b) `dict(density=...)`를 `dict(density=..., range=bin_range)`로 고치면 range가 None인 경로까지 강제 전달돼 다른 동작이 바뀔 수 있다(과수정); 키 대입이 None-안전하고 최소 변경. (c) density 분기 조건을 바꿔 stacked 경로를 건드리면 P2P 회귀. 한 줄 키 대입이 가장 좁고 정확한 일반 픽스.
