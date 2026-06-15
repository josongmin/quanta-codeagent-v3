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
primary_type: T-GenValidate
tier: T4
loc_axis: L1
repair_strategy: S6 (+S4)
knowledge: K-Domain
flags: [overfit-risk, regression-trap, has-repro]
---

# django__django-13513

## 문제 요약
`DEBUG=True`일 때 표시되는 기술적 에러 뷰(`ExceptionReporter`)가 `raise ... from None`을 무시하고 억제된 원래 예외(`__context__`)를 계속 보여준다. 즉 PEP 415의 `__suppress_context__` 플래그를 존중하지 않아, Python 표준 트레이스백과 달리 디버그 페이지에는 숨겼어야 할 RuntimeError가 나타난다. 사용자는 Python CLI 트레이스백과 동일하게, 억제된 컨텍스트가 표시되지 않기를 기대한다. problem_statement는 `get_traceback_frames()` 안의 중첩 함수 `explicit_or_implicit_cause()`를 파일·줄(`django/views/debug.py#L392`)까지 링크로 지목하고, 거의 정답에 가까운 패치 스니펫(`None if exc_value.__suppress_context__ else ...`)까지 제시한다.

## 유형 (정형화)

3축 점수:

- **L (Localization) = L1 (Traceable).** problem_statement가 파일·줄·함수를 링크로 직접 지목하므로 표면적으로는 L0에 가깝다. 그러나 *실제 채점 테스트가 검증하는 결함*(innermost 예외의 `tb`가 None일 때 프레임 누락, 관련 티켓 #31672)은 본문이 명시한 `explicit_or_implicit_cause` 한 줄과 다른 지점 — `get_traceback_frames()`의 프레임 수집 while-루프 종료 조건 — 에 있다. 즉 "본문이 가리킨 곳"과 "테스트가 채점하는 곳"이 어긋나 있어 단순 grep 한 방(L0)이 아니라 함수 전체 흐름을 읽어야 수렴한다 → L1.
- **S (Repair Strategy) = S6 (Design-Refactor) + S4 (CEGIS).** 골드는 한 줄 분기 추가가 아니라 (a) 중첩 함수를 메서드 `_get_explicit_or_implicit_cause()`로 호이스트하고, (b) 프레임 수집 로직을 예외 단위 제너레이터 `get_exception_traceback_frames(exc_value, tb)`로 추출해, (c) `get_traceback_frames()`가 예외 스택을 pop하며 각 예외에 `frames.extend()`를 호출하는 **구조 변경(collect-per-exception lifecycle 재배치)**이다 → S6 dominant. 또한 FAIL_TO_PASS 단일 테스트는 "분기만 추가" 같은 special-case 픽스로도 통과 가능한 함정이 있어, 그 테스트 너머로 일반화(tb=None 케이스까지)해야 한다는 점에서 S4(과소명세 테스트, overfit 고위험) 성격이 보조로 붙는다.
- **K (Knowledge) = K-Domain.** Python 예외 체이닝 의미론(PEP 3134 `__context__`/`__cause__`, PEP 415 `__suppress_context__`)과 더불어 django 디버그 리포터가 예외 체인을 어떻게 순회·렌더하는지(프레임 dict 스키마, `exc_cause_explicit`, 템플릿 "During handling of the above exception")라는 프레임워크 내부 지식이 픽스를 좌우한다.

**primary type = T-GenValidate.** 본질 난점은 localize도(본문이 줘버림) 도메인 지식 결핍도 아니라, **본문이 가리킨 naive 픽스가 채점 테스트를 통과시키지 못하는 overfit/under-spec 함정**을 넘어서 루프 구조를 재배열해야 한다는 데 있다. APR 관점에서: 본문 스니펫을 그대로 적용하면 `test_suppressed_context`류는 살지만 FAIL_TO_PASS인 tb=None 케이스는 죽는 — 즉 "그럴듯하지만 틀린(plausible≠correct)" 후보가 자연스럽게 먼저 생성되고, 실패 테스트 피드백으로 구조 리팩토링(S6)까지 가야 비로소 수렴하는 generate-&-validate 궤적이다. dominant strategy는 S6지만 그 S6를 *강제하는 동력*이 테스트-구별(S4)이므로 primary는 T-GenValidate로 둔다(반례: 만약 본문 스니펫이 곧 정답이었다면 T-DirectMap이었을 것).

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 `15 min - 1 hour`로 T2~T3에 해당하나, 본 분석은 T4로 상향한다.

이 티어로 미는 구조적 피처:
- **patch scope = 단일 파일·소규모지만 멀티-헌크 구조 변경.** gold_files는 `django/views/debug.py` 1개뿐이라 cross-file은 아니지만, 헌크가 4개이고 함수 추출 2개(`_get_explicit_or_implicit_cause`, `get_exception_traceback_frames`) + 호출부 재배선이라 "1파일 <5줄"의 T1~T2 컷에 들지 않는다.
- **localize 직접성의 함정.** 본문이 파일·줄을 줘서 표면 L0처럼 보이지만, 실제 결함(tb=None)은 본문 지목점과 다른 곳이라 직접성이 깨진다(L1).
- **overfit/P2P trap이 시간라벨에 안 잡힘.** 단일 FAIL_TO_PASS가 얇아 special-case 픽스가 통과될 위험(overfit-risk)이 크고, PASS_TO_PASS 83개(특히 `test_suppressed_context`, `test_reporting_of_nested_exceptions`, `test_reporting_frames_for_cyclic_reference`, `test_sharing_traceback`)가 인접 예외-체인 동작을 광범위하게 묶고 있어 리팩토링이 이들을 깨면 안 된다(regression-trap). 이 두 위험은 "개발자 구현시간 15분~1시간" 라벨에 반영되지 않는, 에이전트 난이도 가산 요인이다.
- **도메인 의존(K-Domain).** PEP 415 + django 프레임 스키마 지식이 필요해 K-Gen 문제보다 한 단계 위.

다만 `has-repro`(본문이 재현 뷰 코드와 거의-정답 스니펫 제공)가 강한 easiness 신호로 작용해 T5까지는 가지 않는다 → T4 확정.

## 골드패치 분석
- **건드린 파일/함수:** `django/views/debug.py` — `ExceptionReporter.get_traceback_frames()` 재작성, 신규 메서드 `_get_explicit_or_implicit_cause(self, exc_value)`, 신규 제너레이터 메서드 `get_exception_traceback_frames(self, exc_value, tb)`.
- **근본 원인:**
  1. 중첩 함수 `explicit_or_implicit_cause()`가 `explicit or implicit`만 반환하고 `__suppress_context__`를 보지 않아, `raise ... from None`으로 억제됐어야 할 `__context__`가 살아남아 디버그 HTML에 표시됨(PEP 415 위반).
  2. 기존 구조는 단일 while 루프 안에서 `if not tb.tb_next and exceptions: exc_value = exceptions.pop(); tb = exc_value.__traceback__`로 다음 예외로 넘어갔는데, **innermost 예외의 `__traceback__`이 None이면** 루프 진입 자체가 안 돼 그 예외 프레임이 통째로 누락됨(티켓 #31672).
- **수정 요지:** (a) 중첩 함수를 메서드 `_get_explicit_or_implicit_cause()`로 호이스트하면서 `suppress_context = getattr(exc_value, '__suppress_context__', None)`를 반영해 `explicit or (None if suppress_context else implicit)`를 반환 → PEP 415 준수. (b) 프레임 수집을 예외별로 분리한 제너레이터 `get_exception_traceback_frames(exc_value, tb)`로 추출하고 내부에서 `frames.append(...)` 대신 `yield`. (c) `get_traceback_frames()`는 마지막 예외에 대해 `frames.extend(self.get_exception_traceback_frames(exc_value, tb))`를 먼저 호출한 뒤 `while exceptions:`로 나머지를 pop하며 각 예외에 대해 `exc_value.__traceback__`로 다시 호출. 이렇게 tb가 None이어도 예외 단위로 (적어도 1개) 프레임이 yield되어 누락이 사라지고, `exc_cause`/`exc_cause_explicit`도 예외별로 한 번씩만 계산된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_innermost_exception_without_traceback (view_tests.tests.test_debug.ExceptionReporterTests)`. innermost 예외에 `__traceback__`이 없는 체인을 만든다 — `raise RuntimeError('Oops')` 후 `except`에서 `exc.__context__ = new_exc`로 컨텍스트를 수동 주입하고 bare `raise`. 그 뒤 `reporter.get_traceback_frames()`가 **정확히 1개 프레임**(`assertEqual(len(frames), 1)`)을 반환하는지, 그리고 HTML에 `<h1>RuntimeError</h1>`, `Oops`, "During handling of the above exception (My context), another exception occurred"가 포함되는지 검증.
- **픽스 증명:** 구버전 단일 while 루프는 innermost의 `tb`가 비어 루프에 들어가지 못해 프레임 개수가 어긋났다. 제너레이터 분리 구조에서는 `get_traceback_frames()`가 예외 스택을 pop하며 각 예외에 대해 `get_exception_traceback_frames`를 호출하므로, tb가 None이어도 예외 단위로 프레임이 보장되고 컨텍스트 메시지가 정상 렌더된다 → `len(frames) == 1` 성립.
- **overfit 관점:** FAIL_TO_PASS가 단 1개이고, 본문이 가리킨 `__suppress_context__` 한 줄 분기는 이 테스트를 직접 다루지 않는다(이 테스트는 suppress가 아니라 tb=None 누락 케이스). 따라서 "본문대로 한 줄 추가"는 이 테스트를 통과시키지 못하고, 반대로 구조 리팩토링만 하고 suppress 분기를 빠뜨리면 `test_suppressed_context`(P2P)가 깨진다 — 두 결함이 한 패치에 묶여 있어 special-case 통과를 막는 셈이라 overfit 표면을 일부 상쇄한다. 다만 단일 F2P라 검증 두께 자체는 얇다(overfit-risk 유지).
- **regression 관점:** PASS_TO_PASS 83개 중 예외-체인/프레임 렌더에 직접 닿는 `test_suppressed_context`, `test_reporting_of_nested_exceptions`, `test_reporting_frames_for_cyclic_reference`(체인 사이클 경고), `test_reporting_frames_without_source`, `test_reporting_frames_source_not_match`, `test_sharing_traceback`이 리팩토링 후에도 살아야 한다. 특히 사이클 감지 로직(`if exc_value in exceptions: warnings.warn(...)`)은 호이스트된 `_get_explicit_or_implicit_cause` 호출로 옮겨가도 동작이 보존돼야 하므로 regression-trap이 실재한다.

## 모범답안 (오라클 기반)
1. **localize 경로.** 본문의 "debug error view doesn't respect `exc.__suppress_context__` (PEP 415)" + 링크된 `django/views/debug.py#L392`에서 출발해 `ExceptionReporter.get_traceback_frames()`로 직행한다. 여기서 멈추지 말고 hints_text의 #31672("debug error view shows no traceback if exc.__traceback__ is None for innermost exception")와 **실제 테스트 이름** `test_innermost_exception_without_traceback`를 연결해, 채점 초점이 suppress 분기가 아니라 *innermost tb=None 프레임 누락*에 있음을 읽어낸다. 그러면 손댈 범위가 한 줄이 아니라 프레임 수집 while-루프 전체임이 드러난다.
2. **픽스와 올바른 일반화.** 두 결함을 한 번에 닫는다: (a) `__suppress_context__`를 반영한 `explicit or (None if suppress_context else implicit)`로 cause 계산을 고치고, 이를 중첩 함수가 아닌 메서드 `_get_explicit_or_implicit_cause`로 올려 사이클 감지부와 프레임 dict 양쪽에서 재사용. (b) 프레임 생성을 예외 단위 제너레이터로 빼서 `get_traceback_frames()`가 예외별로 `extend`하게 만든다. 이는 단일 입력(이 테스트의 체인)에 맞춘 특수해가 아니라, "예외 체인의 각 예외를 그 자신의 traceback으로 독립 처리"라는 구조적 불변식을 세운 일반화다 — tb가 None이든 다중이든, suppress든 아니든 동일 경로로 처리되므로 overfit이 아니다.
3. **regression 안전.** `test_suppressed_context`(suppress 동작 유지), `test_reporting_of_nested_exceptions`(다중 예외 프레임 순서·개수), `test_reporting_frames_for_cyclic_reference`(사이클 경고)를 깨지 않아야 한다. 따라서 사이클 감지 `if exc_value in exceptions: warnings.warn(...)`는 루프 분리 후에도 `get_traceback_frames()`의 예외 수집 단계에 그대로 남겨야 하고, `exc_cause_explicit = getattr(exc_value, '__cause__', True)` 의미도 예외별로 보존해야 한다(기존엔 매 프레임마다 재계산되던 것을 예외당 1회로 옮기되 값은 동일).
4. **함정 회피.** 오라클 없는 에이전트의 전형적 실패는 **본문 스니펫을 곧이곧대로 받아 `__suppress_context__` 한 줄만 추가하고 종료**하는 것 — 이건 FAIL_TO_PASS를 못 잡는다(증상-테스트 불일치). 두 번째 함정은 루프를 제너레이터로 바꾸면서 사이클 경고나 다중 예외 순서를 흘려 P2P를 깨는 것. 회피법: (i) 본문이 아니라 *실제 F2P 테스트가 구성하는 입력*(`exc.__context__` 수동 주입 + bare raise + tb=None)을 먼저 재현해 무엇을 채점하는지 확정하고, (ii) 리팩토링 후 예외-체인 관련 P2P(특히 nested/cyclic/suppressed)를 회귀로 돌려 구조 변경이 인접 동작을 보존하는지 확인한다.
