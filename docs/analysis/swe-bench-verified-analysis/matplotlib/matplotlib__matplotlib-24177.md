---
instance_id: matplotlib__matplotlib-24177
repo: matplotlib/matplotlib
base_commit: 493d608e39d32a67173c23a7bbc47d6bfedcef61
version: "3.6"
difficulty: "<15 min fix"
created_at: 2022-10-15T10:52:31Z
fail_to_pass: 1
pass_to_pass: 768
gold_files: [lib/matplotlib/axes/_base.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L2
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`ax.hist(..., density=True, histtype="step")`로 히스토그램을 그릴 때 density(y)축이 데이터 전체를 담도록 자동 스케일되지 않는다. `histtype="bar"`는 정상인데 `step`만 문제이고, 데이터를 리스케일하면 density 값이 바뀌는 비직관적 현상도 동반된다. step 모드는 모든 bin을 하나의 `Polygon` 윤곽선으로 합쳐 데이터 한계에 통째로 추가하는데, 이 윤곽선의 한계 계산이 실제 정점보다 작게(잘못) 나온다.

## 유형 (정형화)
- **L (Localization) = L2 (Diffuse)**: 이슈는 `hist`/`step`/`density` 사용자 API만 지목할 뿐, 실제 결함은 `Axes._update_patch_limits` → `Path.iter_bezier` → `Path.iter_segments`의 `simplify` 기본동작이라는 다단계 데이터플로우 안쪽에 있다. hints에 PR #19214 회귀라는 강력한 단서와 재현 정점배열이 있지만, 그 단서가 없으면 `hist`에서 patch 한계 계산까지 콜체인을 직접 따라가야 한다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 한 지점(`iter_bezier` 호출)은 좁지만, "왜 정점이 누락되는가 = path simplification이 한계 계산용 정점을 솎아낸다"는 불변식을 추론해 `simplify=False`라는 정확한 인자를 합성해야 한다. 후보를 마구 시도하는 G&V가 아니라 의미적 추론으로 단정짓는 결함이다.
- **K (Knowledge) = K-Domain**: matplotlib path/Bézier 내부와 `simplify`(렌더링 최적화로 정점 솎기) 의미를 알아야 "한계 계산 경로에서는 simplify를 꺼야 한다"는 결론에 도달한다. 일반 파이썬 추론만으론 부족.
- **primary = T-ConstraintReason**: 위치 자체는 1줄로 좁지만 난점은 "올바른 조건/인자(`simplify=False`)를 인과적으로 추론"하는 데 있다. 그래서 S2 기반 ConstraintReason.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개·실코드 변경 1줄(헌크 1개) → scope 자체는 T1~T2급.
- 그러나 localize 직접성이 낮다(L2): 사용자 증상(`hist density`)과 결함 지점(`_update_patch_limits`의 Bézier 반복) 사이 거리가 멀고, 도메인 지식(K-Domain)으로 `simplify` 의미를 알아야 한다.
- `regression-trap`: PASS_TO_PASS 768개로 path/autoscale/limit 인접 동작이 매우 광범위 — `simplify=False`가 모든 patch에 영향을 주므로 잘못 건드리면 대량 회귀 가능.
- `has-repro`: 정점배열 + `iter_segments` 출력까지 hints에 들어 있어 재현은 쉽다(easiness 신호).
- 공식 difficulty 라벨은 `<15 min fix`(개발자 구현시간). 패치는 1줄이라 라벨이 맞지만, **에이전트 관점**에선 hints 없이 콜체인을 역추적해 `simplify`까지 도달하는 localize·도메인 추론 비용이 시간라벨에 안 잡혀 T2가 아닌 T4로 올린다.

## 골드패치 분석
- **건드린 파일·함수**: `lib/matplotlib/axes/_base.py`의 `Axes._update_patch_limits(self, patch)`.
- **근본원인**: 이 함수는 patch의 경계(extrema)를 구하려 `for curve, code in p.iter_bezier():`로 Bézier 세그먼트를 순회한다. `iter_bezier`는 `**kwargs`를 `iter_segments`로 그대로 전달하는데, `iter_segments`의 `simplify`가 기본적으로 켜져(혹은 viewport 기준으로) 정점을 솎아낸다. step 히스토그램처럼 다수 정점을 가진 단일 `Polygon` path에서는 한계 계산에 꼭 필요한 정점(예: 최대 density를 만드는 꼭짓점)이 simplification으로 누락되어, 계산된 데이터 한계가 실제보다 작아진다. 이는 #19214에서 path를 그대로 쓰던 방식을 Bézier 순회로 바꾸며 들어온 회귀다.
- **수정요지**: `p.iter_bezier()` → `p.iter_bezier(simplify=False)`. 한계 계산 경로에서는 정점 솎기를 비활성화해 모든 정점이 extrema 계산에 반영되도록 강제한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_axes.py::test_small_autoscale`. 이슈 #24097의 작은 density 값(0.00~0.33대) 정점배열로 `Path`를 만들고 `PathPatch`로 추가한 뒤 `ax.autoscale()`을 호출한다. 그리고 `get_xlim()/get_ylim()`이 정점의 실제 min/max(`minx/maxx/miny/maxy`)를 **포함**(`<= min`, `>= max`)하는지 단언한다.
- **픽스 증명**: 버그 상태에서는 simplify로 큰 y정점이 솎여 `ylim[1]`이 실제 maxy보다 작아져 `>= maxy` 단언이 실패한다. `simplify=False` 후 모든 정점이 반영되어 한계가 데이터를 포함하므로 통과. 테스트는 step 히스토그램의 시각적 출력이 아니라 "autoscale 결과 한계가 데이터를 포함한다"는 일반 불변식을 직접 검증한다.
- **overfit 관점**: 단언이 특정 좌표가 아니라 `lim ⊇ [min, max]` 부등식이라 over-fit 위험은 낮다. 다만 FAIL_TO_PASS가 1개뿐이라 이 한 케이스만 통과시키는 좁은 패치(예: 값이 작을 때만 분기)로도 통과 가능 — 골드패치는 그런 special-case 없이 근본 인자만 바꿔 올바르게 일반화했다.
- **regression 관점**: 768개 PASS_TO_PASS가 `simplify=False` 도입이 기존 path/limit/autoscale 동작을 깨지 않음을 보증한다. `simplify=False`는 한계 계산을 *더 정확*하게만 만들므로(정점을 덜 버림) 기존 정상 케이스의 한계를 좁히지 않는다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 증상은 `hist(histtype="step", density=True)`의 y축 미스케일. hints의 "step은 단일 Polygon으로 합쳐져 데이터 한계에 통째 추가됨 + #19214 회귀"라는 신호를 따라 patch가 데이터 한계에 들어가는 진입점 `Axes._update_patch_limits`로 수렴한다. 그 안의 `p.iter_bezier()` 순회가 `iter_segments`의 simplify를 거치는 것을 확인하고, hints의 `iter_segments` 출력이 정점을 누락시키는 것을 근거로 결함을 확정한다.
2. **픽스와 일반화**: `iter_bezier(simplify=False)`. 한계 계산은 *모든* 정점을 봐야 정확하다는 불변식에서 도출되며, 특정 데이터 크기나 histtype에 의존하지 않는 근본 수정이다. simplify는 화면 렌더링 최적화이지 수치 한계 계산에 쓰여선 안 된다 — 그래서 step뿐 아니라 임의 PathPatch의 한계 정확도를 함께 고친다(올바른 일반화).
3. **regression 안전**: simplify를 끄면 정점을 덜 버리므로 한계가 줄어들 일은 없고, 기존에 정상이던 케이스는 동일하거나 더 정확한 한계를 갖는다. 768 PASS_TO_PASS(path/autoscale/patch 관련 다수)가 안 깨지는지로 확인.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) 증상만 보고 `hist`/`density` 정규화 코드를 고치려다 엉뚱한 데 손대기(실제 결함은 limit 계산), (b) `test_small_autoscale` 한 케이스만 통과시키려 "값이 작을 때만" 같은 special-case 분기 추가(overfit), (c) `_update_patch_limits` 자체에서 정점을 수동 재계산하는 과한 리팩터로 회귀 유발. 정답은 simplify의 의미를 이해하고 한 인자(`simplify=False`)만 정확히 전달하는 최소·근본 수정이다.
