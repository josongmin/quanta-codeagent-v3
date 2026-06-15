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
---

# django__django-11206

## 문제 요약
`django.utils.numberformat.format`에 `decimal_pos`를 넘겨 아주 작은 Decimal을 포맷하면, 표시 가능한 소수 자릿수보다 작은 값인데도 지수표기(exponential notation)로 출력된다. 예: `nformat(Decimal('1e-200'), '.', decimal_pos=2)` 가 `'0.00'`이 아니라 `'1.00e-200'`을 반환한다. 사용자는 `decimal_pos`가 주어졌을 때 그 자릿수로 표현할 수 없을 만큼 작은 값이면 `0.00...0`이 나오기를 기대한다.

## 유형 분류
- 버그 카테고리: edge-case (극소값 + 표시 자릿수 경계)
- 서브시스템: django utils / number formatting (l10n number_format)
- 증상 타입: 잘못된 출력 (지수표기 leak)
- 로컬라이제이션 신호: problem_statement가 `utils.numberformat.format`를 직접 지목하고 "hardcoded cut-off point in the internal logic" 라고 명시 → `django/utils/numberformat.py` 단일 파일로 직결.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/numberformat.py:format`
- 근본 원인: `format`은 200자리 초과 Decimal을 메모리 보호 목적으로 과학적 표기로 강제하는 하드코딩 cutoff가 있다. `1e-200` 같은 값은 `as_tuple()`의 exponent가 매우 커서 이 분기를 타고 지수표기로 렌더된다. 이때 `decimal_pos`로 잘려서 사실상 0이 되어야 하는 값임에도 그 판단을 안 했다.
- 수정 요지: `isinstance(number, Decimal)` 블록 진입 직후, 지수표기/200자리 분기보다 **앞에서** 가드를 추가한다. `decimal_pos`가 None이 아니면 `cutoff = Decimal('0.' + '1'.rjust(decimal_pos, '0'))` (즉 표시 가능한 최소 단위)를 만들고, `abs(number) < cutoff`이면 `number = Decimal('0')`으로 치환한다. 0으로 치환되면 이후 일반 포맷 경로를 타서 `0.00...0`이 출력된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_decimal_numbers`, `test_decimal_subclass` (utils_tests.test_numberformat.TestNumberFormat)
- 테스트가 어떻게 픽스를 증명하는지: `test_decimal_numbers`의 케이스 테이블에서 `('0.{}1234'.format('0' * 299), 3, ...)` 의 기대값을 기존 `'1.234e-300'`에서 `'0.000'`으로 바꿨다. 즉 소수점 아래 299개의 0 뒤에 1234가 오는 극소값을 `decimal_pos=3`으로 포맷하면, 3자리로는 표현 불가하므로 지수표기 대신 `'0.000'`이 나와야 함을 검증한다. `test_decimal_subclass`는 Decimal 서브클래스에서도 동일 경로가 동작함을 보증한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem statement가 함수까지 이름으로 줬으므로 `numberformat.py`의 `format` 한 함수만 읽으면 된다. 핵심은 "200자리 → 과학적 표기" 분기와 `decimal_pos`의 관계.
- 함정/난이도 메모: (1) 가드를 **과학적 표기 분기보다 앞**에 둬야 한다. 뒤에 두면 이미 지수문자열로 바뀐 뒤라 무의미. (2) cutoff 계산 `'1'.rjust(decimal_pos, '0')`은 `decimal_pos`개 자리에서 마지막만 1인 최소 단위를 만드는 트릭 — off-by-one 나기 쉬움(`<` vs `<=` 경계, decimal_pos=0 처리). (3) `decimal_pos is None`일 때는 건드리면 안 됨(기존 동작 보존). 단일 파일·단일 함수라 멀티파일 아님.
- 우리 에이전트 관점: 수정 자체는 5줄 미만으로 작지만, "왜 지수표기가 나오는가"를 `Decimal.as_tuple()` exponent 기반 cutoff 로직까지 따라가야 정확한 삽입 위치를 잡는다. 가드를 잘못된 위치(예: sign 처리 후, 일반 경로)에 넣으면 PASS_TO_PASS(`test_large_number` 등 큰 수 과학표기)를 회귀시킬 수 있어, 큰 수 경로를 깨지 않으면서 작은 수만 0으로 떨어뜨리는 정밀함이 관건.
