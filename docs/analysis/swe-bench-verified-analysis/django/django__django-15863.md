---
instance_id: django__django-15863
repo: django/django
base_commit: 37c5b8c07be104fd5288cd87f101e48cb7a40298
version: 4.2
difficulty: <15 min fix
created_at: 2022-07-20T12:58:04Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [django/template/defaultfilters.py]
---

# django__django-15863

## 문제 요약
`floatformat` 템플릿 필터가 `Decimal` 입력에 대해 정밀도를 잃는다. 예를 들어 `Decimal('42.12345678901234567890')`을 `{{ value|floatformat:20 }}`로 렌더하면 `42.12345678901234400000`처럼 뒤쪽 자릿수가 깨진 값이 나온다. 사용자는 고정밀 `Decimal`이 그대로 보존된 채 포매팅되기를 기대했다. 원인은 필터 내부에서 입력을 `Decimal`로 변환하기 전에 사실상 float을 거치는 경로가 있기 때문이다.

## 유형 분류
- 버그 카테고리: logic (잘못된 변환 경로로 인한 정밀도 손실)
- 서브시스템: django template / built-in filters (`floatformat`)
- 증상 타입: silent-wrong (예외 없이 잘못된 출력)
- 로컬라이제이션 신호: problem_statement이 필터 이름 `floatformat`과 "incorrect conversion to Decimal", "converted to float instead"를 명시 → `django/template/defaultfilters.py`의 `floatformat` 함수에서 `Decimal`을 만드는 줄을 곧장 가리킴

## 골드패치 분석
- 건드린 파일/함수: `django/template/defaultfilters.py:floatformat`
- 근본 원인: `Decimal`을 생성하기 위한 입력 문자열을 `repr(text)`로 만들었다. `text`가 `Decimal` 인스턴스일 때 `repr()`은 `Decimal('42.12...')`처럼 따옴표·클래스명이 포함된 문자열을 돌려주고, 이 형태는 `Decimal(...)` 생성자가 받지 못해 `InvalidOperation`이 발생한다. 그러면 except 분기에서 `Decimal(str(float(text)))`로 떨어지면서 float을 경유해 정밀도가 손실된다.
- 수정 요지: `input_val = repr(text)`를 `input_val = str(text)`로 한 줄 변경. `str(Decimal('42.12...'))`는 `"42.12345678901234567890"` 같은 순수 숫자 문자열을 주므로 `Decimal(input_val)`이 첫 시도에서 성공하고 float 경유 fallback을 타지 않아 원래 정밀도가 보존된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `template_tests.filter_tests.test_floatformat.FunctionTests.test_inputs`
- 테스트가 어떻게 픽스를 증명하는지: `test_inputs`에 `floatformat(Decimal("123456.123456789012345678901"), 21)`가 정확히 `"123456.123456789012345678901"`을 반환하는지 단언하는 케이스가 추가된다. float이라면 21자리 소수를 담을 수 없으므로 패치 전에는 끝자리가 어긋난 값이 나와 실패하고, `str(text)` 경로로 `Decimal`이 그대로 보존되어야만 정확히 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `defaultfilters.py`에서 `def floatformat` 본문 중 `Decimal(...)` 생성 직전 줄을 찾아 입력 문자열을 어떻게 만드는지 본다. `repr` vs `str` 차이가 핵심.
- 함정/난이도 메모: 단일 파일·단일 라인 수정이지만 "왜 `repr`이 문제인가"를 이해해야 한다. `repr(Decimal(...))`이 `Decimal('...')` 문자열이라 생성자가 거부 → except fallback이 조용히 float을 거친다는 연쇄를 놓치면, fallback 분기를 건드리는 과교정으로 새는 경우가 많다. float 입력·문자열 입력·`"foo"` 같은 비숫자 입력에서 회귀가 없도록 `str`이 안전한지 확인 필요.
- 우리 에이전트 관점: 증상(정밀도 손실)에서 원인 라인까지의 거리가 짧아 grep 한 번이면 도달한다. 막힐 만한 지점은 fallback(except) 로직을 손대거나 `arg` 파싱부를 건드리는 식의 불필요한 변경. 골드처럼 한 토큰(`repr`→`str`)만 바꾸는 최소 수정으로 수렴하는지가 관건.
