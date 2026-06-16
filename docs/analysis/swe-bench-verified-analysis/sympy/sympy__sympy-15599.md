---
instance_id: sympy__sympy-15599
repo: sympy/sympy
base_commit: 5e17a90c19f7eecfa10c1ab872648ae7e2131323
version: "1.4"
difficulty: "15 min - 1 hour"
created_at: 2018-12-06T17:45:49Z
fail_to_pass: 1
pass_to_pass: 80
gold_files: [sympy/core/mod.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`Mod(3*i, 2)`(i는 정수 심볼)가 `Mod(i, 2)`로 약분되지 않고 그대로 남는다. `Mod` 클래스의 Mul 분배 처리가 정수 비-mod 계수에 대해 `coeff % q` 약분을 적용하지 않기 때문이다. 단, 이슈 토론에서 지적되듯 분모가 있는 경우(`Mod(e/2, 2)`)에는 약분이 수학적으로 부당하므로, "정수 계수에 한해서만" 약분해야 하는 제약 추론이 핵심이다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 `mod.py`와 심지어 후보 diff(`def doit`의 Mul 분기)를 직접 지목한다. 단일 파일·단일 함수, grep 한 방.
- **S (Repair Strategy) = S2 (+S6)**: 고칠 지점은 자명하나, "올바른 조건"을 추론으로 합성해야 한다. 이슈에 제시된 naive diff(`non_mod_l = [cls(x, q) for x in non_mod_l]`)는 모든 인자에 무차별 `Mod`를 씌워 `Mod(e/2, 2)` 같은 유리식을 잘못 약분한다. 정답은 `i.is_Integer` 가드로 정수항만 `i % q`로 줄이는 불변식 추론이다. 골드패치가 새 수집 루프 + `p = Mul(*(non_mod_l + mod_l))` 재조립을 추가하므로 소규모 구조 변경(S6) 보조.
- **K (Knowledge) = K-Domain**: sympy의 `is_Integer`/`is_Number` assumptions, `Mod` 클래스 분배 의미론, `Mul` 재구성 등 프레임워크 내부 지식이 병목. 일반 파이썬 추론으로는 even/division 코너케이스를 못 잡는다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 난점이 "어떤 조건에서 약분이 valid한가"라는 의미적 제약 합성에 있다. T-DirectMap(기계적 가드)이 아닌 이유: 단순 None가드/상수변경이 아니라 even·유리식 반례를 배제하는 수학적 불변식이 필요.

## 난이도 티어
**T4 (약간 어려움).**
- 파일수 1 / 변경 LOC ~15(import net +1줄 + 새 분배 블록 ~10줄 + 1:1 치환 2건 사소 정리) → scope는 작다.
- localize 직접성: L0로 매우 높음, has-repro(StackOverflow 재현 + 명확한 입출력).
- 그럼에도 T2/T3가 아닌 이유: 픽스의 본질이 **반례 배제 제약**이다. naive 패치는 FAIL_TO_PASS를 통과시키지만 `Mod(e/2, 2)` 같은 even/division 케이스에서 silent wrong answer를 만든다(이슈 토론에서 maintainer가 두 번 경고). 즉 overfit 함정이 코드 안에 매설되어 있고, 80개의 넓은 PASS_TO_PASS(`test_Mul_is_even_odd`, `test_Mod_is_integer` 등 Mod·Mul 의미론 전반)가 regression-trap을 형성한다.
- 공식 라벨 "15min–1h"와 정합적이나, 에이전트 관점에선 "이슈에 적힌 naive diff를 그대로 쓰면 오답"이라는 함정 때문에 시간라벨보다 약간 무겁다 → T4 유지.

## 골드패치 분석
- **건드린 파일·함수**: `sympy/core/mod.py`의 `Mod.eval` 내부 `doit` 이후 `isinstance(p, Mul)` 분배 처리 분기.
- **근본원인**: Mul 분기에서 `mod_l`(이미 `Mod`인 인자)이 있을 때만 분배를 수행했고, 비-mod 정수 계수(`3`)는 `q`로 약분하지 않았다. 그래서 `3*i % 2`에서 계수 `3`이 `3 % 2 = 1`로 줄지 못함.
- **수정요지**:
  1. import에 `Integer`, `integer_types` 추가(한 줄을 두 줄로 교체, net +1줄).
  2. 기존 분배 블록 뒤에 새 가드 추가:
     ```python
     if q.is_Integer and q is not S.One:
         _ = []
         for i in non_mod_l:
             if i.is_Integer and (i % q is not S.Zero):
                 _.append(i%q)
             else:
                 _.append(i)
         non_mod_l = _
     p = Mul(*(non_mod_l + mod_l))
     ```
     `q`가 정수이고 1이 아닐 때만, **정수인** 비-mod 인자에 한해 `i % q`로 약분. 비정수항(`i/j` 같은 유리식, even 심볼)은 그대로 둔다 → `Mod(e/2,2)` 미평가 보존.
  3. `type(d) is int` → `isinstance(d, integer_types)`로 py2/3 long 호환 강화, `(p % q)` → `p%q` 사소 정리.

## 검증 (test_patch)
FAIL_TO_PASS = `test_Mod`(1개)에 issue 15493 단언 3개 추가:
- `Mod(3*i, 2) == Mod(i, 2)` — 정수 계수 `3`이 `3%2=1`로 약분되어야 통과. 픽스의 새 루프가 정확히 이를 수행.
- `Mod(8*i/j, 4) == 4*Mod(2*i/j, 1)` — `8`은 정수라 `gcd` 추출 경로와 결합, `i/j`(비정수)는 약분되지 않고 보존됨을 확인.
- `Mod(8*i, 4) == 0` — `8 % 4 = 0`(`is_Zero`)이므로 가드의 `i % q is not S.Zero` else 분기로 `8` 유지 후 상위 약분이 0 산출.
- **overfit 관점**: 테스트가 정수계수/유리식/0-약분 세 케이스를 모두 커버해 naive 패치(무차별 `cls(x,q)`)를 배제한다. 다만 `Mod(e/2,2)` even-symbol 반례 자체는 명시 단언으로 안 들어가 있어(이슈 토론 제안 테스트는 미채택), `has-repro`에도 미세한 underspecify 잔존.
- **regression 관점**: 80개 PASS_TO_PASS가 Mod·Mul·Pow even/odd/integer assumptions 전반을 고정한다. `q is not S.One` 가드가 없으면 `Mod(x,1)` 류가 깨질 수 있어 그 컷이 regression 방어선.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `mod.py`와 `def doit`의 Mul 분배 코드를 직접 인용 → `Mod.eval` 내 `isinstance(p, Mul)` 분기로 즉시 수렴(L0).
2. **픽스와 일반화 정당성**: 비-mod 인자 중 **정수항만** `i % q`로 약분(`i.is_Integer` 가드). 이게 올바른 일반화인 이유 — 정수에 대해 `(a*b) mod q ≡ ((a mod q)*b) mod q`는 항상 성립하지만, `e/2` 같은 유리식엔 성립 안 함(maintainer가 경고한 even/division 반례). 따라서 가드가 수학적 valid 영역으로 정확히 제한하므로 overfit이 아닌 일반화.
3. **regression 안전**: `q.is_Integer and q is not S.One` 컷으로 `Mod(_,1)`·비정수 q 케이스를 건드리지 않아 `test_Mod_is_integer`/`test_Mul_is_even_odd` 등 80 P2P 보존. `i % q is not S.Zero` else 분기로 0-약분 인자도 안전 처리.
4. **함정 회피**: 오라클 없는 에이전트는 이슈에 친절히 적힌 naive diff(`non_mod_l = [cls(x,q) for x in non_mod_l]`)를 그대로 복붙해 FAIL_TO_PASS만 통과시키기 쉽다. 그러나 이는 `Mod(e/2,2)`를 잘못 약분(maintainer가 두 번 경고). 회피법 = 이슈 본문의 제안 diff를 신뢰하지 말고 hints의 "분모 없을 때만/`is_Integer` 한정"이라는 제약을 코드로 옮길 것.
