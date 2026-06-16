---
instance_id: sympy__sympy-24443
repo: sympy/sympy
base_commit: 809c53c077485ca48a206cee78340389cb83b7f1
version: "1.12"
difficulty: "15 min - 1 hour"
created_at: 2022-12-30T14:43:19Z
fail_to_pass: 1
pass_to_pass: 1
gold_files: [sympy/combinatorics/homomorphisms.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`homomorphism(D3, D3, D3.generators, D3.generators)`처럼 `PermutationGroup`에서 항등사상을 만들면 `ValueError: The given images do not define a homomorphism`이 발생한다. 원인은 내부 `_check_homomorphism`의 `_image()` 함수로, relator의 원소 `r[i]`가 **역원(inverted generator)**일 때 `r[i] in gens` 테스트가 실패해서 잘못된 분기로 빠진다. 이슈 작성자가 깨진 라인(L336-L337)과 근본원인을 정확히 지목하며 "전체를 크게 단순화할 수 있다"고 제안한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 파일·함수(`_check_homomorphism`/`_image`)와 정확한 라인까지 지목. grep 한 방. localize 비용 0.
- **S2 Constraint-Reasoning (+S6 Design-Refactor)**: 고칠 지점은 명확하나, 올바른 픽스는 "역원 처리"를 즉석에서 땜질하는 게 아니라 generator-symbol ↔ domain-generator 매핑이라는 **불변식을 다시 세워** `array_form`만으로 일관되게 합성하는 것이다. 골드는 이중 인덱스(i/j) 루프를 `symbols_to_domain_generators` 딕셔너리 + `for symbol, power in r.array_form` 한 줄 루프로 **재구조화**(S6)하여 역원 케이스를 구조적으로 소거한다. 단순 가드 추가(S1)가 아니다.
- **K-Domain**: `PermutationGroup`/`FpGroup`/`FreeGroup`의 `presentation()`, `relators`, `array_form`, `ext_rep`, generator 객체 vs 심볼 구분 등 sympy 조합론 내부 계약을 알아야 픽스가 옳은지 판단 가능.
- **primary = T-ConstraintReason**: 위치는 자명(L0)하나 난점은 "역원 분기를 어떻게 일반적으로 올바르게 처리하느냐"는 의미 추론에 있음.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일·단일 함수, 골드 net은 음수(코드가 줄어듦, ~42줄→~31줄), repro 완비(has-repro, ~87% easiness 신호), localize 직접성 L0. 이 셋만 보면 T2에 가깝다. 그러나 픽스가 단순 가드가 아니라 매핑 불변식을 재구성하는 소규모 refactor(S6)이고, 옳음 판단에 sympy 군론 도메인지식(K-Domain)이 필요해 T2에서 T3로 민다. 공식 라벨 "15 min - 1 hour"와 정합. P2P가 `test_isomorphisms` 단 1개라 광범위 regression-trap은 아니지만, 같은 `_image` 경로를 `FpGroup`/`FreeGroup`도 공유하므로 재구성이 그쪽 동작을 깨면 안 된다(좁은 trap).

## 골드패치 분석
- **파일·함수**: `sympy/combinatorics/homomorphisms.py`의 `_check_homomorphism`와 그 내부 클로저 `_image`.
- **근본원인**: 기존 `_image`는 relator를 두 인덱스(`i`는 `r`의 원소, `j`는 `r.array_form`의 (sym, power) 튜플)로 동시 순회하며, `PermutationGroup`일 때 `r[i] in gens`로 generator를 역추적해 `domain.generators[gens.index(r[i])]`를 골랐다. `r[i]`가 역원이면 `gens`(presentation generators)에 없어 `in gens`가 False → `s = r[i]`(역원 객체)로 떨어지고, 이어 `s in images`/`s**-1 in images` 어느 쪽도 매칭 못 해 항등으로 잘못 누적 → relator image가 항등이 아니게 되어 homomorphism 검증 실패.
- **수정요지**: presentation을 `pres`로 한 번만 받고 `symbols = [g.ext_rep[0] for g in gens]`로 generator 심볼을 뽑아, `symbols_to_domain_generators = dict(zip(symbols, domain.generators))` 매핑을 선구축. `_image`는 `for symbol, power in r.array_form:`로 (심볼, 거듭제곱)만 순회해 `images[symbols_to_domain_generators[symbol]]**power`를 곱한다. `array_form`의 power 부호가 역원을 이미 표현하므로 `r[i] in gens` 분기·이중 인덱스·`is_identity` 특수처리가 통째로 불필요해진다. docstring도 추가.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_homomorphism`** (1개): `D3 = DihedralGroup(3); T = homomorphism(D3, D3, D3.generators, D3.generators); assert T.is_isomorphism()`를 추가. base에선 항등사상 생성 자체가 `ValueError`로 죽어 이 줄에서 실패. 픽스 후엔 역원이 섞인 relator도 `array_form` power 부호로 올바르게 image를 합성해 검증 통과 → `is_isomorphism()`이 True.
- **픽스 증명**: 깨진 입력(역원을 포함하는 dihedral relator)이 정상 경로로 흐름을 직접 관찰. repro가 테스트로 승격된 형태.
- **overfit·regression**: 테스트가 D3 항등사상 1개로 얇아 overfit 여지는 있으나(`overfit-risk` 경계), 골드 픽스는 special-case 분기가 아니라 일반 매핑이라 모든 군 타입에 동일하게 일반화 → overfit 아님. PASS_TO_PASS = `test_isomorphisms` 1개가 `FpGroup`/`FreeGroup`/`PermutationGroup` 혼합 동형을 커버해, `_image` 재구성이 비-permutation 경로를 깨지 않음을 보증(regression-trap을 막는 핵심 가드).

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `_check_homomorphism`의 `_image()`와 L336-L337(`if ... and r[i] in gens`)을 명시. 추가 탐색 없이 해당 클로저로 직행.
2. **픽스와 일반화 근거**: 역원에서 `in gens`가 실패하는 게 병이므로, "심볼 + power"로만 동작하는 표현(`array_form`)에 기대 generator 객체 역추적을 제거한다. `array_form`의 power 부호가 역원/거듭제곱을 모두 표현하므로 `symbols_to_domain_generators[symbol]`로 심볼→domain generator를 매핑하면 permutation/Fp/Free 모든 케이스가 한 식으로 처리된다. 이게 special-case 패치보다 옳은 일반화인 이유는, 결함의 근원(객체 동일성 기반 역추적)을 없애 버리기 때문.
3. **regression 안전**: `_image`는 `FpGroup`·`FreeGroup` 경로도 공유한다. 재구성 후 `test_isomorphisms`(혼합 타입)가 통과해야 하므로, `array_form`/`ext_rep`가 세 군 타입 모두에서 동일 계약을 만족함을 신뢰. `pres = domain if hasattr(domain,'relators') else domain.presentation()` 분기로 FpGroup이 자기 relators를 그대로 쓰는 기존 동작을 보존.
4. **함정 회피**: 오라클 없는 에이전트는 `if r[i].is_Inverse` 같은 역원 전용 가드를 끼워 깨진 입력만 통과시키는 **S1 땜질**로 빠지기 쉽다(테스트 1개라 통과해도 구조 부패). 또 `gens`를 presentation generators로만 보고 `domain.generators`와 혼동하면(둘은 다른 객체 공간) 매핑이 어긋난다. 올바른 길은 이슈 저자 힌트("크게 단순화")를 받아들여 이중 인덱스 자체를 버리고 `array_form` 기반 단일 매핑으로 재작성하는 것.
