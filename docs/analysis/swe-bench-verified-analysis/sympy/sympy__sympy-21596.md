---
instance_id: sympy__sympy-21596
repo: sympy/sympy
base_commit: 110997fe18b9f7d5ba7d22f624d156a29bf40759
version: "1.9"
difficulty: "15 min - 1 hour"
created_at: 2021-06-10T15:35:08Z
fail_to_pass: 1
pass_to_pass: 46
gold_files: [sympy/sets/handlers/intersection.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

## 문제 요약
`imageset(Lambda(n, n + (n-1)*(n+1)*I), S.Integers).intersect(S.Reals)`가 잘못된 결과를 낸다. `2`는 원래 ImageSet의 원소가 아닌데(`2 in S1 == False`), `intersect(Reals)`에는 포함되는(`True`) 모순이 발생한다. 올바른 결과는 허수부가 0이 되는 `n = ±1`만 남긴 `{-1, 1}`이어야 한다. 즉 `intersect(Reals)`가 허수부 0 조건으로 base set을 좁히는 로직이 깨져 있다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `intersect(Reals)` 동작을 직접 지목하고 재현코드가 명확. ImageSet ∩ Reals 핸들러는 `sets/handlers/intersection.py`의 `other == S.Reals` 분기 하나로 수렴. 파일 후보가 좁아 grep 한두 번이면 도달.
- **S (Strategy) = S2 (+S6)**: 고칠 위치는 명확하나, 픽스가 "올바른 집합대수 식의 합성"을 요구한다. 기존 `base_set -= FiniteSet(xis)`에서 `xis`가 튜플이라 스칼라 원소와 절대 매칭 안 되는 버그를, 각 선형해를 `FiniteSet(xis)`로 모아 `Union`하고 base set과 `&`(교집합)로 좁히는 헬퍼 `_solution_union`으로 재구조화. 단순 가드 추가(S1)가 아니라 불변식("허수부=0이 되는 n들의 합집합으로 제한")을 따져 식을 재합성하므로 S2가 dominant, 작은 구조 도입이 있어 S6 보조.
- **K (Knowledge) = K-Domain**: sympy 집합대수(`ImageSet`/`ConditionSet`/`Union`/`FiniteSet`), `solve_linear`, `numer` vs `as_numer_denom`, `Mul.make_args` 의미를 알아야 픽스가 가능. 일반 파이썬 추론만으론 부족.
- **primary = T-ConstraintReason**: 위치는 쉽게 찾지만 핵심 난점이 "어떤 집합 연산식이 옳은가"의 의미 추론에 있다.

## 난이도 티어
- **tier = T4 (약간 어려움)**. 구조적 피처: 단일 파일 1곳(`gold_files` 1개), 수정 ~30줄(헬퍼 도입 + 두 블록 교체)로 줄수는 중간. has-repro로 재현은 쉬워 localize는 L1로 가볍다. 그러나 (1) 버그가 `tuple vs scalar` 매칭 실패라는 미묘한 의미오류이고, (2) `-= FiniteSet`(차집합)을 `&= Union`(교집합)으로 바꾸는 집합대수 추론, (3) `numer`로 분자만 뽑아 풀이성능을 유지하는 도메인 판단이 결합되어 S2 추론 부담이 크다.
- 공식 라벨("15 min - 1 hour")과 일치. has-repro·1파일이라 T5로 밀 만큼은 아니나, P2P 46개라는 넓은 regression 표면과 집합대수 추론 때문에 T3보다 위인 T4가 타당.

## 골드패치 분석
- **파일/함수**: `sympy/sets/handlers/intersection.py`의 `intersection_sets(ImageSet, ...)` 중 `other == S.Reals` 분기.
- **근본원인**: 기존 코드는 `x, xis = zip(*[solve_linear(i, 0) for i in Mul.make_args(im) ...])`로 모든 인자의 해를 한 번에 zip한 뒤 `base_set -= FiniteSet(xis)`를 했다. `xis`가 해들의 **튜플**이라 `FiniteSet(xis)`는 튜플 1개를 원소로 갖는 집합이 되어 정수 base set의 스칼라 원소와 절대 일치하지 않는다 → 허수부 0이 되는 n이 제거되지 못하거나(역으로) 잘못 제거됨. 분모(denoms) 처리 블록은 한술 더 떠 `im`을 잘못 재사용해 버그가 중첩.
- **수정요지**: 헬퍼 `_solution_union(exprs, sym)` 도입 — 각 식 `i`에 대해 `solve_linear(i, 0, [sym])`로 풀어 선형해면 `FiniteSet(xis)`, 못 풀면 `ConditionSet(sym, Eq(i, 0))`를 모아 `Union`으로 반환. 허수부 제약은 `base_set &= _solution_union(Mul.make_args(numer(im)), n)`(차집합이 아니라 **교집합**으로 "허수부=0인 n만 남김"), 분모 제외는 `base_set -= _solution_union(denoms(f), n)`. `as_numer_denom` 대신 `numer`로 분자만 뽑아 속도를 유지하면서 단순 케이스를 처리.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_imageset_intersect_real`. 핵심 어서션이 `Complement(S.Integers, FiniteSet((-1,1)))`(버그가 만든 튜플 차집합)에서 `FiniteSet(-1, 1)`(정답)로 교정됨. 추가로 `n + im*I` 변형들(`im = (n-1)*(n+S.Half)`), `n/2 + im*I`가 `ImageSet(..., ConditionSet(...))`로 떨어지는 비선형 케이스, 분모를 가진 `n/(1/n-1)`·`n/(n-6)`·`n/(n**2-9)` 케이스(각각 `{S.Half}`, `{-1}`, `S.EmptySet`)로 분자·분모 양쪽 경로를 모두 커버.
- **픽스 증명**: 새 어서션들이 (a) 선형해 → `FiniteSet`, (b) 비선형 → `ConditionSet`, (c) 분모 0 제외, (d) 교집합 결과 공집합까지 직접 관측해 `_solution_union`의 union·교집합 의미를 검증.
- **overfit/regression 관점**: FAIL_TO_PASS는 1개 테스트지만 그 안에 7개 이질적 어서션(선형/비선형/분모/공집합)이 들어 special-case 통과를 막아 overfit 위험을 상당히 낮춘다(그래도 flags에 overfit-risk 표기 — 단일 테스트함수라 미검증 입력공간은 존재). P2P 46개가 `test_Reals`/`test_intersections`/`test_imageset_intersect_interval`/`test_ComplexRegion_*` 등 집합 핸들러 전반을 덮어 regression-trap이 실재.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `S1.intersect(Reals)` 모순 + `2 in S1 == False`에서 출발 → `Intersection`이 dispatch로 `intersection_sets`를 타고, ImageSet ∩ Reals를 다루는 `sets/handlers/intersection.py`의 `if other == S.Reals:` 분기로 수렴. 거기서 허수부 `im` 처리 블록을 정조준.
2. **픽스/일반화**: `xis`가 튜플이라 `FiniteSet(xis)`가 스칼라와 매칭 안 되는 게 진짜 원인임을 파악. 올바른 일반화는 "허수부가 0이 되는 n들의 합집합으로 base set을 **교집합 제한**"하는 것 — 각 인자해를 `FiniteSet`/`ConditionSet`로 모아 `Union`하는 `_solution_union`. `numer(im)`으로 분자만 풀어 선형/비선형/분모 케이스를 일관되게 처리하는 것이 special-case 누적이 아닌 구조적 정답.
3. **regression 안전**: P2P의 `test_imageset_intersect_interval`·`test_imageset_intersect_diophantine`·`test_Reals`·`test_ComplexRegion_*`를 깨면 안 됨 — `other == S.Reals` 분기만 만지고 Interval/diophantine 경로는 불변으로 두는 것이 안전. 교집합/차집합 방향(허수부는 `&=`, 분모는 `-=`)을 혼동하면 인접 핸들러 동작이 무너진다.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `FiniteSet(xis)`의 튜플 버그를 못 보고 `solve_linear` 호출만 손대거나, (b) 차집합(`-=`)을 그대로 둔 채 식만 바꿔 "허수부=0인 n만 남김"이라는 의미를 뒤집거나, (c) `as_numer_denom`을 써 느려지거나 비선형에서 깨지기 쉽다. 핵심은 "튜플 vs 스칼라" 매칭 실패를 진단하고 union-기반 교집합 제한으로 재구성하는 것.
