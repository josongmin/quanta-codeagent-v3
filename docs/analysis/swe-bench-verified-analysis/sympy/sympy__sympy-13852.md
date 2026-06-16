---
instance_id: sympy__sympy-13852
repo: sympy/sympy
base_commit: c935e1d106743efd5bf0705fbeedbd18fadff4dc
version: "1.1"
difficulty: "1-4 hours"
created_at: "2018-01-06T23:54:51Z"
fail_to_pass: 1
pass_to_pass: 4
gold_files: [sympy/functions/special/zeta_functions.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`polylog(2, Rational(1,2))`가 닫힌형으로 평가되지 않고 그대로 남는다 — 기대값은 `pi**2/12 - log(2)**2/2`. 동시에 `expand_func(polylog(1, z))`가 불필요한 `exp_polar(-I*pi)` 인자를 끌고 다녀(`-log(z*exp_polar(-I*pi) + 1)`), 미분 불변식을 깨뜨린다. 이슈는 `polylog(1, z)`가 모든 목적에서 `-log(1-z)`와 동일함을(멱급수·branch cut·도함수 일치) 수치·해석 근거로 입증하며, polar 인자 제거와 알려진 special-value 추가를 함께 요구한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 함수명 `polylog`와 `expand_func`를 직접 지목. `polylog` 클래스는 `zeta_functions.py` 단일 파일에 있고, `eval`/`_eval_expand_func` 두 메서드가 정확한 수정지점. grep 한 방.
- **S2 (Constraint-Reasoning)**: 위치는 자명하나 픽스가 기계적이지 않다. `exp_polar` 제거는 "branch cut이 1에서 분기하지 않으므로 polar 정보(0 주위 winding number)가 무의미"라는 해석적 추론에서 도출되고, s==2 special value들(`pi**2/12 - log(2)**2/2`, 황금비 인자 6종)은 dilogarithm 항등식을 정확히 합성해야 한다. 후보 다수를 시도하는 G&V가 아니라 "올바른 식을 생각으로 푸는" SemFix/Angelix 계열.
- **K-Domain**: dilogarithm special values와 polar lifting/branch cut은 sympy 내부 + 특수함수 도메인 지식. 그러나 픽스 위치는 도메인지식 없이도 찾히므로 K-Domain은 병목이 아니라 식 합성 단계의 보조.
- **primary = T-ConstraintReason**: localize는 trivial(L0)이고 진짜 난점은 올바른 닫힌형·항등식을 추론으로 합성하는 데 있다.

## 난이도 티어
**T4 (약간 어려움)**. 구조 피처: 단일 파일·단일 클래스(localize 직접성 최상, L0), has-repro(이슈에 정확한 기대값과 미분 반례 제공). 줄수는 ~30줄·multi-hunk지만 모두 한 메서드군에 응집. 티어를 T2~T3에서 T4로 미는 것은 **S2 추론 부담**(황금비 인자별 정확한 dilog 항등식 6종 + polar 제거의 해석적 정당화)과 **regression-trap**(`eval`에 새로 추가한 `s==-1` 분기가 `polylog(-1,z)`를 construction time에 닫힌형 `z/(1-z)**2`로 자동평가시켜 `expand_func`를 항등으로 만들고, 그 결과 test_patch가 `polylog(-1,z)` 기대값을 `z/(1-z)**2`로 함께 수정해야 함 — 이는 polar 제거가 아니라 새 `eval` 분기의 부작용이다. polar 제거는 `_eval_expand_func`의 `s==1` 분기만 바꾸고 `s<=0` 경로(`start=u/(1-u)`)는 손대지 않는다). 공식 라벨 "1-4 hours"와 일치: 위치는 쉽지만 정확한 수학식 도출과 회귀 점검에 시간이 든다.

## 골드패치 분석
- **파일**: `sympy/functions/special/zeta_functions.py` (1파일).
- **건드린 심볼**: import에 `I`, `sqrt` 추가; `polylog.eval(cls, s, z)` classmethod; `polylog._eval_expand_func`; `polylog` docstring.
- **근본원인 (2가지)**:
  1. `_eval_expand_func`의 s==1 분기가 `-log(1 + exp_polar(-I*pi)*z)`를 반환 — `exp_polar(-I*pi)`는 1 주위 winding을 인코딩하지만 log는 1에서 분기하지 않아 무의미하고, 결과 표현식의 도함수가 `z/(1-z)`로 단순화되지 않아 불변식을 깬다.
  2. `eval`이 special value들을 모름 — `s==2`인 `z=1/2`, 황금비 인자들, 그리고 `s==0`, `s==-1`의 닫힌형이 누락.
- **수정요지**:
  - s==1 전개를 `-log(1 - z)`로 교정(polar 제거).
  - `eval`에 `s==2` 6개 special value(`z=S.Half→pi**2/12-log(2)**2/2`, `z=2→pi**2/4-I*pi*log(2)`, 황금비 4종) 추가.
  - `s==0→z/(1-z)`, `s==-1→z/(1-z)**2` 닫힌형 추가; `z==0`의 `0`을 `S.Zero`로 정규화. (s≤0를 `polylog(1,z)`처럼 자동 `-log(1-z)` 전개하지 않은 이유는 주석: hypergeometric 합산법에 바람직하지 않음.)

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_polylog_values` (신규). `polylog(2, 2) == pi**2/4 - I*pi*log(2)`, `polylog(2, S.Half) == pi**2/12 - log(2)**2/2`를 직접 단언하고, 6개 z값과 s∈{-1,0,1}×랜덤 복소 z 10개에 대해 `polylog(s,z).evalf()`와 `evaluate=False` 버전의 수치 일치(`<1e-15`)를 확인 — 닫힌형이 수치적으로 옳음을 증명.
- **회귀 부분**: `test_polylog_expansion`이 함께 수정됨 — `polylog(1,z)` 기대를 `-log(1-z)`로, `polylog(-1,z)`를 `z/(1-z)**2`로 갱신하고 `(1-z)**3 * expand_func(polylog(-2,z))).simplify() == z*(1+z)` 추가.
- **overfit 관점**: FAIL_TO_PASS는 1개지만 랜덤 복소수 수치 교차검증을 포함해 special-case overfit이 어렵다 — closed form이 틀리면 `<1e-15` 단언이 깨진다. PASS_TO_PASS 4개(`test_zeta_eval` 등)는 인접한 zeta/dirichlet_eta/stieltjes로 polar 제거 회귀를 가드.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `polylog`/`expand_func`를 명시 → `sympy/functions/special/zeta_functions.py`의 `class polylog`로 직행. 두 진입점은 미평가의 `eval`(special value), polar 인자의 `_eval_expand_func`(s==1 분기).
2. **픽스와 일반화**: s==1 전개를 `-log(1-z)`로 — 이슈가 제공한 도함수 반례(`diff(polylog(1,z) - expand_func(...))`가 0이 아님)가 polar 인자의 부당함을 *증명*하므로 이건 overfit 아닌 해석적으로 강제된 교정. special value는 알려진 dilog 항등식이라 임의 휴리스틱이 아니라 검증된 닫힌형. `s==0/-1`은 polylog 정의에서 직접 유도되는 유리식.
3. **regression 안전**: `polylog(-1,z)` 기대값 변경(`z**2/(1-z)**2 + z/(1-z)` → `z/(1-z)**2`)의 원인은 polar 제거가 아니라 새 `eval` `s==-1` 분기다 — construction time에 닫힌형으로 자동평가되어 `expand_func`가 항등이 된다. 반면 `polylog(-2,z)`는 형태가 바뀌지 않았다: `eval`에 `s==-2` 분기가 없어 여전히 미변경된 `_eval_expand_func`의 `s<=0` 경로를 타며, test_patch는 기대값을 갱신한 게 아니라 신규 단언 `((1-z)**3 * expand_func(polylog(-2,z))).simplify() == z*(1+z)`를 추가했을 뿐이다(변경되지 않은 코드경로에 대한 신규 회귀가드). 그리고 `test_zeta_eval`/`test_dirichlet_eta_eval`/`test_stieltjes`가 안 깨져야 한다(인접 zeta 패밀리 불변).
4. **함정 회피**: (a) s≤0를 `s==1`처럼 일괄 `-log(1-z)` 전개로 묶고 싶은 유혹 — 주석대로 hypergeometric 합산법을 깨므로 금물, 명시 분기로만. (b) `z==0` 반환을 raw `0` 대신 `S.Zero`로 정규화(sympy 타입 일관성). (c) 황금비 인자 z의 부호·형태(`-(sqrt(5)-1)/2` vs `(3-sqrt(5))/2`)를 정확 매칭하지 않으면 닫힌형이 적용 안 되고 수치 교차검증이 실패 — 식 합성을 대충 하면 FAIL_TO_PASS의 `<1e-15`에서 걸린다.
