---
instance_id: django__django-16667
repo: django/django
base_commit: 02c356f2f3945b8075735d485c3cf48cad991011
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-03-20T21:32:53Z
fail_to_pass: 2
pass_to_pass: 24
gold_files: [django/forms/widgets.py]
---

# django__django-16667

## 문제 요약
`SelectDateWidget`에 사용자가 `sys.maxsize`보다 큰 연/월/일 값을 보내면 `value_from_datadict`의 `datetime.date(int(y), int(m), int(d))` 호출이 `OverflowError`("Python int too large to convert to C long")를 던진다. 이 예외는 폼 검증(`form.is_valid()`) 경로에서 발생하므로 catch되지 않고 서버 500(Internal Server Error)로 이어진다. 사용자(악의적 입력 포함)는 단순한 GET 쿼리스트링만으로 서버를 크래시시킬 수 있다. 기대 동작은 크래시가 아니라 "Enter a valid date." 검증 에러로 정상 처리되는 것.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (unvalidated user input → uncaught exception)
- 서브시스템: django forms widgets (`SelectDateWidget`)
- 증상 타입: 예외 / 크래시 (HTTP 500, DoS 가능)
- 로컬라이제이션 신호: problem_statement이 traceback에서 `django/forms/widgets.py` line 1160, `value_from_datadict`, `datetime.date(int(y), int(m), int(d))`를 그대로 가리킨다. 파일/함수/줄까지 사실상 명시됨.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/widgets.py` : `SelectDateWidget.value_from_datadict`
- 근본 원인: 기존 코드는 `datetime.date(...)` 생성 시 `ValueError`만 `except`로 잡아 pseudo-ISO 문자열(`"%s-%s-%s"`)로 폴백했다. 하지만 매우 큰 정수는 `ValueError`가 아니라 `OverflowError`를 던지므로 기존 try/except를 빠져나가 검증 경로 전체를 터뜨렸다.
- 수정 요지: 기존 `except ValueError` 블록 다음에 `except OverflowError: return "0-0-0"` 핸들러를 추가. `"0-0-0"`은 어떤 입력 포맷으로도 파싱되지 않는 무효 날짜 문자열이라, 상위 `DateField.clean`이 이를 받아 정상적으로 "Enter a valid date." `ValidationError`를 발생시킨다. 즉 크래시를 검증 실패로 강등시킨다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_value_from_datadict` (test_selectdatewidget): `((str(sys.maxsize + 1), "12", "1"), "0-0-0")` 케이스 추가 — 위젯 레벨에서 오버플로 입력이 `"0-0-0"`을 반환하는지 직접 확인.
  - `test_form_field` (test_datefield): `mydate_month=str(sys.maxsize+1)`인 폼을 만들어 `is_valid()`가 `False`이고 `errors == {"mydate": ["Enter a valid date."]}`인지 확인 — end-to-end로 크래시 대신 검증 에러가 나오는지 증명.
- PASS_TO_PASS의 `test_datefield_1`에 `f.clean("0-0-0")`이 `ValidationError("Enter a valid date.")`를 내는지 추가되어, 폴백 문자열 `"0-0-0"`이 실제로 무효 날짜로 거부됨을 보증한다(폴백 선택의 정당성 회귀).

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback이 파일·함수·줄을 직접 주므로 `value_from_datadict`의 `datetime.date(...)` 호출을 감싼 try/except를 찾는 것이 핵심. 거기서 잡는 예외 종류가 `ValueError`뿐임을 인지하면 끝.
- 함정/난이도 메모: 단일 파일·단일 함수의 2줄 수정으로 난이도는 낮다. 다만 (1) 폴백 값을 아무거나 두면 안 되고 `"0-0-0"`처럼 모든 input_format에서 파싱 실패하는 값이어야 검증이 자연스럽게 실패한다는 점, (2) `OverflowError`가 `ValueError`의 하위클래스가 아니라는 점(별도 except 필요)을 놓치기 쉽다. 그냥 `except (ValueError, OverflowError)`로 묶어 같은 분기로 보내면 pseudo-ISO 포맷(`y or 0` 등)을 거치게 되어 의도와 미묘하게 달라질 수 있으나, 골드는 명시적으로 `"0-0-0"`을 직접 반환하는 별도 핸들러를 택했다.
- 우리 에이전트 관점: 막힐 지점은 적다. 위험은 과대수정 — `int(y)` 단계에서 별도 try를 추가하거나 상위 `DateField`/`BaseTemporalField`까지 손대는 등 범위를 넓히면 PASS_TO_PASS 회귀 위험이 생긴다. 골드처럼 기존 try 블록 안에 except 한 줄을 끼우는 최소 변경이 정답.
