---
instance_id: django__django-11206
repo: django/django
base_commit: 571ab44e8a8936014c22e7eebe4948d9611fd7ce
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-04-13T10:19:38Z
fail_to_pass: 2
pass_to_pass: 4
gold_files: [django/utils/numberformat.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [regression-trap, has-repro]
---

# django__django-11206

## 문제 요약
`django.utils.numberformat.format`에 `decimal_pos`를 넘겨 아주 작은 Decimal을 포맷하면, 표시 가능한 소수 자릿수보다 작은 값인데도 지수표기(exponential notation)로 출력된다. 예: `nformat(Decimal('1e-200'), '.', decimal_pos=2)`가 `'0.00'`이 아니라 `'1.00e-200'`을 반환한다. 사용자(이슈 제출자)는 `decimal_pos`가 주어졌을 때 그 자릿수로 표현할 수 없을 만큼 절댓값이 작은 값이면 `0.00...0`이 나오기를 기대한다. problem_statement에 두 줄짜리 REPL 재현코드(`1e-199`는 정상, `1e-200`은 버그)가 들어 있어 경계가 명확하다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** problem_statement가 `utils.numberformat.format`를 함수 이름으로 직접 지목하고 "caused by a hardcoded cut-off point in the internal logic"라고 원인 위치까지 명시한다. grep 한 방으로 `django/utils/numberformat.py`의 `format` 단일 함수에 수렴 — 탐색 노력 거의 0.
- **S (Repair Strategy) = S2 (Constraint-Reasoning).** 고칠 *지점*은 자명하지만, 픽스는 이슈가 받아쓰기해주지 않는다. "decimal_pos로 표현 가능한 최소 단위"라는 불변식을 직접 합성해야 한다 — 즉 `cutoff = Decimal('0.' + '1'.rjust(decimal_pos, '0'))` 라는 경계식과 `abs(number) < cutoff` 라는 조건, 그리고 그 가드를 200자리/지수표기 분기보다 *앞*에 둬야 한다는 제어흐름 추론. 이는 후보를 여러 개 뿌려 테스트로 거르는 G&V(S3)가 아니라, 경계·엣지케이스를 "생각으로" 따져 한 번에 맞히는 SemFix/Angelix 계열의 semantic 합성에 해당한다.
- **K (Knowledge) = K-Gen (General).** `Decimal.as_tuple()`/`abs()`/문자열 `rjust` 정도의 표준 파이썬 지식이면 충분하다. django ORM·query-compiler 같은 프레임워크 내부 도메인 지식 불필요. 숫자 포맷팅 로직이라 일반 추론으로 닫힌다.

**Primary type = T-ConstraintReason.** 위치는 L0로 명확하나(따라서 T-DiffuseLoc 아님), 픽스가 S1 기계적 가드/상수 치환(T-DirectMap)을 넘어 "표시 가능한 최소 단위 = decimal_pos 기반 cutoff"라는 *올바른 식의 합성*을 요구하기 때문이다. 이슈가 의도(작으면 0으로)는 말해주지만 cutoff 산식·삽입 위치·경계연산자는 추론으로 채워야 하므로 S2가 dominant. K-API가 아닌 이유: 공개 시그니처/리턴형은 그대로고 `decimal_pos is None` 경로를 보존해 하위호환을 깨지 않을 뿐 새 API 계약 협상이 없다.

## 난이도 티어
**Tier = T3 (중간).** 구조적 피처: 1파일·1함수, 골드 추가 ~8줄(순증 가드 블록)로 patch scope는 작다(1파일·<5줄 핵심 → 본래 T2 신호). has-repro(REPL 재현)도 easiness 신호다. 그런데 두 가지가 T2에서 T3로 밀어 올린다 — (1) 픽스가 S1 템플릿이 아니라 cutoff 산식을 합성하는 S2 추론이고, (2) **삽입 위치가 정답의 일부**다: 가드를 지수표기 분기보다 앞에 둬야 하며 잘못 두면 `test_large_number`(큰 수 과학표기 경로)를 회귀시킨다 → regression-trap. 즉 "어디"가 아니라 "정확히 그 한 줄을 어떤 식으로, 제어흐름 어느 지점에"가 본질이라 순수 기계적 픽스보다 한 단계 위다.

공식 라벨 `15 min - 1 hour`(개발자 구현시간)와 T3는 일치한다. 다만 공식 라벨은 "구현 시간"이라 cutoff 경계연산자(`<` vs `<=`, `decimal_pos=0`)와 삽입 위치 오류 같은 overfit/회귀 함정은 잡지 못한다 — 이 함정 비용이 T2가 아닌 T3를 정당화하는 부분이다. L0·K-Gen이라 T4 이상으로는 가지 않는다(도메인지식·멀티사이트·diffuse-loc 없음).

## 골드패치 분석
- **건드린 파일/함수:** `django/utils/numberformat.py` — `format(number, decimal_sep, decimal_pos=None, grouping=0, thousand_sep='', ...)` 단일 함수.
- **근본 원인:** `format`은 200자리 초과 Decimal을 `{:f}.format()`의 메모리 폭증을 피하려 과학적 표기로 강제하는 하드코딩 cutoff를 갖는다(`as_tuple()`의 `digits`/`exponent` 기반). `1e-200` 같은 극소값은 exponent가 매우 커서 이 분기를 타고 지수표기로 렌더된다. 이때 `decimal_pos`로 잘라보면 사실상 0이 되어야 하는 값임에도, 그 "표현 가능한가" 판단을 **하기 전에** 과학표기 분기가 먼저 발동한다.
- **수정 요지:** `if isinstance(number, Decimal):` 블록 진입 **직후**, 즉 200자리/과학표기 로직(`_, digits, exponent = number.as_tuple()`)보다 앞에 가드를 삽입한다.
  ```python
  if decimal_pos is not None:
      cutoff = Decimal('0.' + '1'.rjust(decimal_pos, '0'))
      if abs(number) < cutoff:
          number = Decimal('0')
  ```
  `'1'.rjust(decimal_pos, '0')`은 길이 `decimal_pos`에서 마지막 자리만 1인 문자열(예: decimal_pos=3 → `'001'`)을 만들어 `Decimal('0.001')` 즉 표시 가능한 최소 단위를 구성한다. `abs(number) < cutoff`면 `number`를 `Decimal('0')`으로 치환 → 이후 일반 포맷 경로가 `0.00...0`을 출력한다. `decimal_pos is None`이면 가드를 건너뛰어 기존 동작을 그대로 보존한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2):** `test_decimal_numbers`, `test_decimal_subclass` (utils_tests.test_numberformat.TestNumberFormat).
- **픽스 증명:** `test_decimal_numbers`의 케이스 테이블에서 `('0.{}1234'.format('0' * 299), 3, ...)`의 기대값을 기존 `'1.234e-300'` → `'0.000'`으로 단 한 줄 변경했다. 소수점 아래 0이 299개 뒤에 `1234`가 오는 극소값을 `decimal_pos=3`으로 포맷하면 3자리로 표현 불가하므로, 지수표기 대신 `'0.000'`이 나와야 함을 검증한다. `test_decimal_subclass`는 `Decimal` 서브클래스 인스턴스에서도 `isinstance(number, Decimal)` 분기와 동일 가드가 발동함을 보증(서브클래스 우회 방지).
- **overfit 관점:** FAIL_TO_PASS는 얇지만(핵심 케이스 1개 + 서브클래스 1개), 같은 테이블에 `1e-10`, `1e-11`(8자리) 등 경계 인접 케이스가 PASS_TO_PASS로 함께 통과 조건에 묶여 있어, "이 한 입력만 0으로 하드코딩"하는 special-case 패치는 `1e-200`/`1e-300`/`decimal_pos` 변주에서 깨진다 → overfit이 비교적 잘 걸러진다. 다만 cutoff 경계(`< cutoff` vs `<= cutoff`)와 `decimal_pos=0` 경로는 테스트가 직접 핀하지 않아 미세 overfit 여지가 남는다.
- **regression 관점:** PASS_TO_PASS = `test_float_numbers`, `test_format_number`, `test_format_string`, `test_large_number`. 특히 `test_large_number`는 큰 수의 과학표기 경로를 검증하므로, 가드를 잘못된 위치(과학표기 분기 뒤, 또는 Decimal 블록 밖)에 넣거나 cutoff 조건을 과하게 잡으면 큰 수가 0으로 떨어지거나 과학표기가 깨져 이 테스트가 회귀한다 → regression-trap 플래그의 실체.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈가 `utils.numberformat.format`를 이름으로 주고 "hardcoded cut-off point in the internal logic"라 원인까지 명시 → 곧장 `django/utils/numberformat.py`의 `format` 한 함수를 연다. REPL 재현(`1e-199` OK / `1e-200` 버그)으로 경계가 200자리 과학표기 cutoff 근처임을 즉시 안다. `as_tuple()`/200자리 분기가 작은 수를 지수표기로 보내는 지점을 지목하면 localize 종료.

2. **픽스 (왜 올바른 일반화인가):** "decimal_pos로 표현 가능한 최소 단위보다 절댓값이 작으면 0"이라는 *불변식*을 코드로 합성한다 — `cutoff = Decimal('0.' + '1'.rjust(decimal_pos, '0'))`, `abs(number) < cutoff → number = Decimal('0')`. 이것이 special-case가 아니라 올바른 일반화인 이유: 임의의 `decimal_pos`와 임의의 극소 Decimal에 대해 "표시 자릿수로 0과 구별 불가"라는 의미를 그대로 인코딩하므로, 테스트에 없는 `1e-50`/`decimal_pos=2` 같은 입력에서도 정확히 동작한다. 부호(`abs`)를 취해 음수 극소값도 동일 처리.

3. **regression 안전:** 가드를 `if decimal_pos is not None:`으로 감싸 `decimal_pos=None` 호출(기존 다수 경로)을 무손실 보존하고, `isinstance(number, Decimal)` 블록 **안**에 둬 float/문자열 경로를 건드리지 않는다. 결정적으로 가드를 과학표기 분기 **앞**에 삽입해 큰 수의 200자리 과학표기(`test_large_number`)는 cutoff 조건(`abs < cutoff`)에 절대 걸리지 않으므로 그대로 통과 — `test_float_numbers`/`test_format_number`/`test_format_string`도 무영향.

4. **함정 회피 (오라클 없는 에이전트가 틀릴 지점):**
   - **삽입 위치 오류:** 가드를 `_, digits, exponent = number.as_tuple()` 이후나 sign 처리 후에 두면 이미 지수문자열로 가는 분기를 못 막거나 큰 수 경로를 오염시킨다. 반드시 Decimal 블록 진입 직후.
   - **cutoff 산식 off-by-one:** `'1'.rjust(decimal_pos, '0')`은 길이 `decimal_pos`를 채운다. `'0' * decimal_pos + '1'`처럼 짜면 자릿수가 하나 어긋나 `1e-(pos)` 경계 케이스가 틀어진다. 경계는 `<`(엄격 미만)여야 `decimal_pos` 마지막 자리에 정확히 걸치는 값(예: 0.001)이 0으로 안 죽는다.
   - **special-case 유혹:** 실패 테스트 입력만 보고 `if number == Decimal('1e-300'): return '0.000'`식으로 하드코딩하면 FAIL_TO_PASS는 통과하지만 일반화 실패(overfit). cutoff 불변식으로 일반화해야 한다.
   - **None 미보존:** `decimal_pos`가 None인데 가드를 무조건 실행하면 `Decimal('0.')` 생성에서 깨지거나 기존 동작을 바꿔 회귀한다 — None 가드 필수.
