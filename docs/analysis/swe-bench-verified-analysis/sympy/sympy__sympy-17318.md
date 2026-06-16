---
instance_id: sympy__sympy-17318
repo: sympy/sympy
base_commit: d4e0231b08147337745dcf601e62de7eefe2fb2d
version: "1.5"
difficulty: "15 min - 1 hour"
created_at: "2019-08-01T11:55:36Z"
fail_to_pass: 1
pass_to_pass: 10
gold_files: [sympy/simplify/radsimp.py, sympy/simplify/sqrtdenest.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`sqrtdenest((3 - sqrt(2)*sqrt(4 + 3*I) + 3*I)/2)` (또는 보다 명확하게 `sqrtdenest(3 - sqrt(2)*sqrt(4 + I) + 3*I)`)가 `IndexError: tuple index out of range`로 죽는다. 스택트레이스는 `sqrtdenest → _sqrtdenest1 → _sqrt_match → split_surds → _split_gcd`로 내려가며, `_split_gcd`의 `g = a[0]`에서 빈 `surds` 리스트를 받아 터진다. 의도된 동작은 "denest 불가능한 식은 변경 없이 그대로 반환"이다. 근본 원인은 `_sqrt_match`가 복소 항을 포함한 `4 + I` 같은 인자를 `split_surds`에 넘기기 때문.

## 유형 (정형화)
- **L (Localization) = L1**: 네이티브 스택트레이스가 `_sqrt_match`(sqrtdenest.py:159)와 `split_surds`/`_split_gcd`(radsimp.py)를 정확히 지목. 단 "어느 함수에서 가드할지"는 콜체인 위에서 판단해야 해 L0는 아님.
- **S (Strategy) = S2 (+S1)**: 단순 None가드가 아니라, "어떤 입력이 `split_surds`에 정당한가"라는 불변식(항의 제곱이 *양의* 유리수)을 재구성해 조건식을 합성해야 한다. 기존 `(x**2).is_Rational` 검사는 `(4+I)**2`처럼 `is_Rational`이 거짓이 되는 경우는 잘 거르지만, `I**2 == -1`(음의 유리수)는 `is_Rational`이 참이라 통과시켜 버린다 — 여기에 `is_positive` 조건을 더해야 한다는 의미적 추론이 핵심(S2). 추가된 검사 자체는 한 줄 가드라 S1 보조.
- **K (Knowledge) = K-Domain**: `_sqrt_match`/`split_surds`/`rad_rationalize`가 surd(무리근) 대수 위에서 무엇을 가정하는지, sympy assumptions(`is_Rational`/`is_positive`)의 3치 논리를 알아야 픽스가 옳음을 안다.
- **primary = T-ConstraintReason**: 위치는 트레이스로 거의 공짜지만, 진짜 일은 `split_surds`의 전제조건(항² = 양의 유리수)을 정확히 식으로 옮기는 제약 추론이다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 2개지만 **실질 로직 변경은 sqrtdenest.py 1군데**(`_sqrt_match`)뿐 — radsimp.py 변경은 docstring 문구 보정("rationals" → "positive rationals")으로 동작 무관.
- `has-repro`: 완전한 네이티브 트레이스 제공 → easiness 강신호.
- localize 직접성 높음(L1), 픽스 2줄.
- 그러나 단순 가드가 아니라 `is_positive` 누락분을 *추론*해야 함(S2) + PASS_TO_PASS가 sqrtdenest 회귀군 10개로 **regression-trap**이 존재(잘못 가드하면 정상 denest 경로를 막아 `test_sqrtdenest*` 다수가 깨질 수 있음).
- 공식 라벨 "15min–1h"와 일치. T2가 아닌 이유는 의미 추론(음의 유리수 vs 양의 유리수 구분) 때문, T4가 아닌 이유는 cross-file 조율·넓은 후보 탐색이 없기 때문.

## 골드패치 분석
- **건드린 파일·함수**:
  - `sympy/simplify/sqrtdenest.py` — `_sqrt_match(p)` (실로직).
  - `sympy/simplify/radsimp.py` — `rad_rationalize`, `split_surds` docstring만(전제 명문화).
- **근본 원인**: `_sqrt_match`의 `p.is_Add` 분기에서 `if all((x**2).is_Rational for x in pargs)`는 `split_surds(p)`를 호출할 자격 조건이다. `split_surds`는 "각 항의 제곱이 **양의** 유리수인 실 surd 합"을 가정하지만, 검사가 `is_Rational`만 보므로 `I` 같은 항(`I**2 = -1`, 유리수이지만 음수)도 통과. 그 결과 `split_surds` 내부에서 실제 surd가 하나도 없는 빈 `surds` 리스트가 만들어지고 `_split_gcd`의 `g = a[0]`이 `IndexError`.
- **수정 요지**: 가드를 `sqargs = [x**2 for x in pargs]; if all(sq.is_Rational and sq.is_positive for sq in sqargs)`로 강화. 복소·음제곱 항이 섞이면 이 분기를 건너뛰고, `_sqrt_match`는 일반 경로의 `nmax[0] == 0`에서 `res = []`(빈 리스트)를 반환 → 상위 `_sqrtdenest1`이 식을 변경 없이 반환. 이것이 "denest 불가 → 원식 반환" 요구를 충족.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_12420` (1개)**. 단언 3종:
  1. `_sqrt_match(4 + I) == []` — 픽스 직격: 잘못된 인자에 대해 `split_surds` 호출 없이 빈 매치 반환(IndexError 부재).
  2. `sqrtdenest((3 - sqrt(2)*sqrt(4 + 3*I) + 3*I)/2) == I` — 식이 auto-eval로 `I`가 되는 케이스가 정상 통과.
  3. `e = 3 - sqrt(2)*sqrt(4 + I) + 3*I; sqrtdenest(e) == e` — auto-eval 안 되는 변형이 원식 그대로 반환(crash 대신).
- **픽스 증명**: 단언 1이 `_sqrt_match` 단위에서 직접 가드를 친다(상위 무관). 단언 3이 end-to-end로 "변경 없이 반환" 계약을 확인.
- **overfit 관점**: `_sqrt_match` 직접 단언 + end-to-end 단언을 함께 둬 special-case 통과를 어느 정도 차단. 단 FAIL_TO_PASS 1개라 입력공간 커버는 얇음(`overfit-risk` 경계선이나, `is_positive` 일반 가드라 special-case 코딩으로 통과하긴 어려움 → 미표기).
- **regression 관점**: PASS_TO_PASS 10개(`test_sqrtdenest`, `test_sqrtdenest2/3/4`, `test_sqrtdenest_rec`, `test_sqrt_symbolic_denest`, `test_issue_5653/5857/6241`, `test_subsets`)가 정상 denest 경로를 보호. 가드 강화가 *양의* 실 surd 합에는 영향 없음을 이들이 보증(`is_positive`는 정상 surd엔 참이라 분기 유지).

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 네이티브 트레이스가 `_split_gcd`의 `g = a[0]`(빈 시퀀스 인덱싱)을 지목 → 한 단계 위 `split_surds`의 `surds`가 비었음 → 그 위 호출자 `_sqrt_match`의 `if all((x**2).is_Rational ...)` 가드가 "자격 없는" 인자를 통과시킨 게 진짜 결함이라고 콜체인 역추적. "헬퍼를 hardening"이 아니라 "호출자가 bogus 인자를 안 넘기게" 고치는 게 옳은 지점.
2. **픽스 / 올바른 일반화**: `is_Rational`만으로는 `I**2 = -1`(음의 유리수)을 못 거른다는 점을 짚고 `sq.is_positive`를 합취. 이는 `4+I` 한 케이스가 아니라 "제곱이 음/복소가 되는 모든 Add 항"을 일반적으로 배제 → `split_surds`의 실제 전제(양의 유리수 제곱)와 정확히 정렬. CEGIS식 special-case 추가가 아니라 전제 명문화라 일반화가 옳다.
3. **regression 안전**: 정상 denest 입력(`1 + sqrt(2) + sqrt(6)` 등)은 항² 모두 양의 유리수라 `is_positive`가 참 → 분기 보존. PASS_TO_PASS 10개가 이 불변을 검증하므로, 가드가 정상 경로를 좁히지 않았음이 보장됨.
4. **함정 회피**: (a) 메인테이너가 명시적으로 "bare except 금지, 근원에서 고쳐라"라고 했으므로 `_split_gcd`나 `split_surds`를 try/except로 감싸는 유혹을 거부해야 함 — 오라클 없는 에이전트가 가장 빠지기 쉬운 함정. (b) 원이슈 예시는 auto-eval로 `I`가 돼 버그가 안 보이므로(`((3 - sqrt(2)*sqrt(4 + 3*I) + 3*I)/2) == I`), `sqrt(4 + I)` 변형으로 재현해야 진짜 crash를 잡는다 — 재현 검증을 auto-eval 케이스로만 하면 "이미 고쳐졌다"고 오판. (c) `rad_rationalize`/`1+cbrt(2)` 무한재귀 등 인접 결함이 hints에 언급되나, 골드는 `_sqrt_match` 가드로 범위를 한정 — scope를 넓혀 split_surds를 직접 손대면 회귀 위험만 키운다.
