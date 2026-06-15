---
instance_id: django__django-13513
repo: django/django
base_commit: 6599608c4d0befdcb820ddccce55f183f247ae4f
version: "3.2"
difficulty: 15 min - 1 hour
created_at: 2020-10-08T14:07:33Z
fail_to_pass: 1
pass_to_pass: 83
gold_files: [django/views/debug.py]
---

# django__django-13513

## 문제 요약
DEBUG=True 일 때 표시되는 기술적 에러 뷰(`ExceptionReporter`)가 `raise ... from None`을 무시하고 억제된 원래 예외(`__context__`)를 계속 보여준다. 즉 PEP 415의 `__suppress_context__` 플래그를 존중하지 않아, Python 기본 트레이스백과 달리 디버그 페이지에는 숨겼어야 할 RuntimeError가 나타난다. 사용자는 Python CLI 트레이스백과 동일하게 억제된 컨텍스트가 표시되지 않기를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (PEP 415 `__suppress_context__` 분기 누락) + 로직 리팩토링
- 서브시스템: django 디버그 뷰 / 예외 리포팅 (`django/views/debug.py`)
- 증상 타입: 잘못된 출력 (디버그 HTML에 억제된 예외 표시) + 부수적으로 innermost 예외에 `__traceback__`이 없을 때 프레임 누락
- 로컬라이제이션 신호: problem_statement가 `get_traceback_frames()` 내부의 `explicit_or_implicit_cause()` 함수와 `django/views/debug.py#L392`를 직접 링크로 지목 — 파일·함수 핀포인트가 명확

## 골드패치 분석
- 건드린 파일/함수: `django/views/debug.py` — `ExceptionReporter.get_traceback_frames()`, 신규 `_get_explicit_or_implicit_cause()`, 신규 `get_exception_traceback_frames()`
- 근본 원인: (1) 중첩 `explicit_or_implicit_cause()`가 `explicit or implicit`만 반환하고 `__suppress_context__`를 보지 않아 억제된 컨텍스트가 살아남음. (2) 기존 구조는 단일 while 루프 안에서 `tb.tb_next`가 소진되면 다음 예외로 넘어가는데, innermost 예외의 `tb`가 None이면 그 예외 프레임이 통째로 누락됨(관련 티켓 #31672).
- 수정 요지: 중첩 함수를 메서드 `_get_explicit_or_implicit_cause()`로 호이스트하고 `suppress_context`를 반영해 `explicit or (None if suppress_context else implicit)` 반환. 프레임 수집을 예외별로 분리한 제너레이터 `get_exception_traceback_frames(exc_value, tb)`로 추출하고, `get_traceback_frames()`는 예외 스택을 pop하며 각 예외에 대해 이 제너레이터를 `frames.extend()`로 호출. 이렇게 하면 tb가 None이어도 예외 단위로 프레임이 yield되어 누락이 사라진다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_innermost_exception_without_traceback` — innermost 예외에 `__traceback__`이 없는 체인을 만든 뒤 `get_traceback_frames()`가 정확히 1개 프레임을 반환하는지, HTML에 "During handling of the above exception (My context), another exception occurred"가 포함되는지 확인.
- 증명 방식: `raise RuntimeError('Oops')` 후 `except`에서 `exc.__context__ = new_exc`로 컨텍스트를 수동 주입하고 다시 raise. 구버전 단일 루프는 innermost의 tb가 비어 프레임을 못 만들거나 개수가 어긋났는데, 제너레이터 분리 구조에서는 `len(frames) == 1`이 보장되고 컨텍스트 메시지가 렌더된다. `test_suppressed_context`(PASS_TO_PASS)는 `from None` 억제가 유지됨을 함께 보증.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일·줄·함수까지 링크로 줘서 로컬라이제이션은 사실상 무료 — `django/views/debug.py`의 `explicit_or_implicit_cause`만 보면 됨.
- 함정/난이도: 표면적 요구는 "한 줄짜리 `__suppress_context__` 분기 추가"처럼 보이지만, 골드는 그 이상으로 프레임 수집 루프를 제너레이터로 리팩토링한다. naive 픽스(분기만 추가)는 `test_suppressed_context`는 통과시킬 수 있어도 FAIL_TO_PASS인 `test_innermost_exception_without_traceback`(tb=None 케이스)을 못 잡을 위험이 크다. 즉 문제 설명과 실제 채점 테스트의 초점이 어긋나 있음.
- 우리 에이전트 관점: problem_statement만 보고 "suppress_context 한 줄 추가"로 끝내면 단일 FAIL_TO_PASS 테스트에서 막힌다. hints_text의 #31672(innermost tb None) 언급과 실제 테스트 이름을 연결해 루프 구조까지 손대야 한다는 걸 추론해야 함 — 증상-테스트 불일치를 읽어내는 게 핵심.
