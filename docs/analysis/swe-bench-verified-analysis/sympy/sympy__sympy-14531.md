---
instance_id: sympy__sympy-14531
repo: sympy/sympy
base_commit: 205da797006360fc629110937e39a19c9561313e
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: "2018-03-18T18:15:33Z"
fail_to_pass: 2
pass_to_pass: 84
gold_files: [sympy/printing/str.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S3)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`StrPrinter`의 출력 설정(예: `sympy_integers=True`)이 일부 하위표현식에서 무시된다. `sstr(x + S(1)/2, sympy_integers=True)`는 올바르게 `'x + S(1)/2'`를 내지만, `sstr(Eq(x, S(1)/2), sympy_integers=True)`는 `'Eq(x, 1/2)'`로 설정이 적용되지 않는다(`Limit`도 동일). 코드생성 `python(Eq(x, y))`도 심볼 선언이 누락되어 `'e = Eq(x, y)'`만 나온다. 근본 원인은 여러 `_print_*` 메서드가 인자를 `self._print()`가 아니라 파이썬 `%` 포맷으로 직접 문자열화하면서 printer의 settings/디스패치를 우회하기 때문이다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `StrPrinter`/`sstr`/`Eq`/`Limit`을 지목한다. 클래스는 `sympy/printing/str.py` 하나로 즉시 수렴하나, 잘못된 메서드가 `_print_Relational`, `_print_Limit`, `_print_ExprCondPair`, `_print_Lambda` 등 **다수**라서 grep 한 방(L0)은 아니다 → L1.
- **S2 (+S3)**: 고칠 지점은 알지만 "어떤 인자가 settings를 우회하는가"를 메서드별로 따져 `expr.x` → `self._print(expr.x)`로 바꿔야 한다. 패턴은 기계적이나 디스패치 불변식(모든 하위표현식은 printer를 통과해야 함)을 적용해 누락 사이트를 빠짐없이 찾는 추론이 본질. 후보 사이트 식별에 약한 grep-반복(S3) 보조.
- **K-Domain**: SymPy printer 아키텍처(`Printer._print` 디스패치가 settings를 전파한다는 계약)를 알아야 한다. 일반 파이썬 지식만으론 "왜 `%` 직접보간이 틀렸는가"를 모른다.
- **primary = T-ConstraintReason**: 위치는 한 파일로 명확하지만, 픽스의 핵심은 "settings 전파 불변식"이라는 의미적 조건을 모든 사이트에 일관 적용하는 추론. 단순 가드추가(T-DirectMap)가 아니다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일수 = 1 (`str.py`), gold scope ≈ 12개 헌크 / 약 20여 라인 — 단일파일이지만 멀티헌크.
- localize 직접성: 클래스는 자명, 그러나 깨진 메서드 집합을 전수로 찾아야 함(중간).
- has-repro: 이슈가 `sstr`/`python` 정확한 입출력을 제시 → 강한 easiness 신호.
- 도메인: SymPy printer 계약 필요(가벼운 K-Domain).
- P2P trap: PASS_TO_PASS 85개로 광범위 — `_print_*` 출력은 회귀 위험이 큼(regression-trap).
공식 라벨 "15분-1시간"과 일치. 멀티헌크+넓은 P2P가 T2(쉬움)보다 위로 밀지만, 픽스 패턴이 동형반복이라 T4까지는 아니다.

## 골드패치 분석
- **건드린 파일**: `sympy/printing/str.py` 한 곳.
- **건드린 함수**: `_print_AppliedPredicate`, `_print_ExprCondPair`, `_print_Lambda`, `_print_Limit`, `_print_MatrixElement`, `_print_Normal`, `_print_Permutation`, `_print_PermutationGroup`, `_print_PolyRing`, `_print_FracField`, `_print_Relational`, `_print_Uniform`.
- **근본원인**: 이 메서드들이 하위표현식을 `'%s' % expr.arg`처럼 직접 보간하면, 파이썬 `str()`가 호출되어 SymPy 기본 `StrPrinter()`로 재진입한다 — 현재 printer 인스턴스의 `settings`(예: `sympy_integers`)와 `_print` 디스패치를 우회한다.
- **수정요지**: 모든 하위표현식 보간을 `self._print(...)`로 라우팅. 예: `_print_Relational`은 `(charmap[...], expr.lhs, expr.rhs)` → `(charmap[...], self._print(expr.lhs), self._print(expr.rhs))`. `_print_Limit`은 `tuple(map(self._print, (e, z, z0)))`로 일괄 변환. 연산자 토큰(`charmap`)·리터럴 문자열은 그대로 둔다 — 표현식만 통과시킨다.

## 검증 (test_patch)
- **FAIL_TO_PASS**:
  - `test_python_relational` — `python(Eq(x, y))`가 이제 `"x = Symbol('x')\ny = Symbol('y')\ne = Eq(x, y)"`를 내야 함. 기존엔 `_print_Relational`이 `expr.lhs/rhs`를 직접 보간해 심볼이 printer 그래프에 등록되지 않아 선언이 누락됐다. `self._print(expr.lhs)` 경유로 심볼이 수집된다. (이슈가 "이상하게도 테스트가 옛 동작을 단언한다"고 지적 → 테스트 자체를 정정.)
  - `test_Rational` — `sstr(Eq(x, Rational(2,3)), sympy_integers=True) == "Eq(x, S(2)/3)"` 및 `sstr(Limit(x, x, Rational(7,2)), sympy_integers=True) == "Limit(x, x, S(7)/2)"` 신규 단언. `_print_Relational`/`_print_Limit`이 `self._print`로 라우팅되어야만 `sympy_integers` 설정이 하위표현식까지 전파됨을 증명.
- **overfit 관점**: 테스트가 `Eq`/`Limit` 두 케이스만 직접 검증하므로, 그 둘만 고치는 special-case 픽스로도 FAIL_TO_PASS는 통과 가능 → CEGIS적 과소명세 소지가 있다. 골드는 정답대로 **모든** 위반 사이트를 고쳐 일반화했다.
- **regression 관점**: P2P 85개(`test_Lambda`, `test_Limit`, `test_PolyRing`, `test_Permutation_Cycle`, `test_Relational` 등)가 동일 메서드들의 평문 출력을 고정. `self._print`는 기본 설정에서 `str()`와 동치 출력이라 평문 케이스는 보존된다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "setting이 무시된다 + `Eq`/`Limit` 예시"에서 `sstr`→`StrPrinter`(`sympy/printing/str.py`)로 진입. `_print_Relational`, `_print_Limit`을 읽으면 `expr.lhs`/`z0`를 `%s`로 직접 보간하는 걸 발견 → `_print` 디스패치 우회가 원인. 같은 파일에서 `'%s' % expr.*` / `% (..., expr.x, ...)` 패턴을 전수 grep해 동일 결함 사이트를 모은다.
2. **픽스와 일반화**: 모든 하위표현식 보간을 `self._print(...)`로 교체. 이것이 올바른 일반화인 이유 — settings 전파는 printer의 **불변식**(하위표현식은 항상 동일 인스턴스의 `_print`를 통과)이므로, 위반 사이트를 한 메서드만 고치면 다른 메서드는 계속 새다. `Eq`/`Limit`만이 아니라 `Lambda`/`MatrixElement`/`Normal`/`Uniform`/`PolyRing` 등 12개를 일괄 수정해야 결함 클래스가 닫힌다.
3. **regression 안전**: 연산자 토큰·리터럴(`charmap[...]`, `'Lambda(...)'`, `size=`)은 표현식이 아니므로 절대 `_print`로 감싸면 안 됨 — 감싸면 출력이 깨져 `test_Lambda`/`test_Permutation_Cycle`이 깨진다. `self._print(sub)`는 default 설정에서 `str(sub)`와 동치라 85개 평문 P2P는 그대로 통과.
4. **함정 회피**: (a) FAIL_TO_PASS가 `Eq`/`Limit`만 검증하므로 그 둘만 고치고 멈추면 overfit — 동일 결함 클래스 전수 수정이 정답. (b) `test_python_relational`의 기존 단언(`"e = Eq(x, y)"`)이 "틀린 동작을 단언"하므로, 그걸 보고 "현재 코드가 맞다"고 오판하지 말 것 — 테스트 자체가 정정 대상이다. (c) `expr.func`(`_print_AppliedPredicate`)처럼 표현식이 아닌 함수객체까지 `self._print`로 통과시켜야 하는지 메서드별로 따져, 토큰과 표현식을 혼동하지 말 것.
