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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-16667

## 문제 요약
`SelectDateWidget`에 사용자가 `sys.maxsize`보다 큰 연/월/일 값을 보내면 `value_from_datadict`의 `datetime.date(int(y), int(m), int(d))` 호출이 `OverflowError`("Python int too large to convert to C long")를 던진다. 기존 코드는 이 생성자를 `try/except ValueError`로만 감쌌는데, `OverflowError`는 `ValueError`의 하위클래스가 아니므로 그 except를 빠져나가 폼 검증(`form.is_valid()`) 경로 전체를 터뜨린다 → HTTP 500. 사용자(악의적 입력 포함)는 단순한 GET 쿼리스트링(`?my_date_year=1234567821345678&...`)만으로 서버를 크래시시킬 수 있는 DoS다. 기대 동작은 크래시가 아니라 "Enter a valid date." 검증 에러로 정상 처리되는 것. problem_statement에 네이티브 traceback과 재현 뷰가 그대로 들어 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈 본문이 traceback으로 `django/forms/widgets.py` line 1160, `value_from_datadict`, 그리고 폭발 지점 `datetime.date(int(y), int(m), int(d))`를 글자 그대로 지목한다. grep 한 방, 탐색 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조).** 정형 결함클래스 = "unguarded exception"이며 픽스는 템플릿적이다: 누락된 예외 분기 하나 추가. 이슈가 예외 타입(`OverflowError`)까지 명시하므로 "체크 추가" 패턴에 기계적으로 매칭된다. S2를 보조로 다는 이유는, **폴백 값이 아무거나면 안 되기** 때문 — `"0-0-0"`이 모든 input_format에서 파싱 실패하는 무효 날짜라는 불변식을 따져야 상위 `DateField.clean`이 자연스럽게 `ValidationError`를 내도록 합성된다. 이 한 가지 의미적 추론이 순수 S1을 살짝 넘긴다.
- **K (Knowledge) = K-Gen.** django 내부 ORM/query-compiler 지식 불필요. `datetime.date`가 큰 int에 `OverflowError`를 낸다는 것은 일반 파이썬 지식이고, `"0-0-0"`이 무효라는 것도 같은 함수의 위 두 줄(pseudo-ISO 폴백)을 읽으면 도출된다. 약한 forms 맥락(폴백 문자열이 `DateField`로 흘러간다)이 있지만 "모델빨" 수준은 아니다.
- **Primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적 가드 추가(S1)다. T-LocTrivial로 보기엔 폴백 값 선택에 미세한 의미 추론이 있어 한 단계 위, T-ConstraintReason으로 보기엔 추론량이 너무 얕아 한 단계 아래 — 정확히 가운데인 T-DirectMap.

## 난이도 티어
**T2 (쉬움).** 미는 구조적 피처:
- **파일 1개 / 함수 1개 / +2줄** (`except OverflowError: return "0-0-0"`). ICLR 2024 컷에서 1파일·<5줄은 ≈48% solve 구간.
- **L0 + has-repro**: 네이티브 traceback이 파일·함수·줄을 직접 주는 것은 가장 강한 easiness 신호(해결률 ~87%). localize 노력 거의 0.
- 다만 **순수 T1이 아닌 이유**: (a) 폴백 값을 `"0-0-0"`처럼 골라야 한다는 가벼운 엣지추론(S2 보조), (b) `OverflowError ⊄ ValueError`라 기존 except에 묶이지 않는다는 함정, (c) 24개 P2P가 인접 날짜 검증 동작 전반을 커버해 약한 `regression-trap`이 존재한다. 이 세 가지가 "이슈가 픽스를 거의 적어주는" T1에서 T2로 올린다.
- **공식 라벨("15 min - 1 hour")과 정합.** 개발자 구현시간 기준 하단부이고, 에이전트 관점에서도 localize 비용이 0이라 시간라벨과 어긋나지 않는다(localize 어려움/overfit 위험이 시간라벨에 안 잡히는 케이스가 아님).

## 골드패치 분석
- **건드린 파일·함수:** `django/forms/widgets.py` : `SelectDateWidget.value_from_datadict`
- **근본 원인:** 기존 코드는 `date_value = datetime.date(int(y), int(m), int(d))`를 `try`로 감싸고 `except ValueError` 한 분기만 두어, 그 안에서 pseudo-ISO 문자열(`"%s-%s-%s" % (y or 0, m or 0, d or 0)`)로 폴백했다. 그러나 `sys.maxsize`를 초과하는 정수는 C long 변환 실패로 `OverflowError`를 던지는데, `OverflowError`는 `ArithmeticError`의 하위클래스라 `except ValueError`에 걸리지 않는다. 따라서 예외가 try/except를 뚫고 올라가 `value_from_datadict` → `is_valid()` 전체를 크래시시킨다.
- **수정 요지:** 기존 `except ValueError` 다음에 `except OverflowError: return "0-0-0"` 핸들러를 한 분기 추가. 반환된 `"0-0-0"`은 어떤 input_format으로도 파싱되지 않는 무효 날짜 문자열이라, 상위 `DateField.clean`(→ `BaseTemporalField.to_python` → `strptime`)이 이를 받아 정상적으로 "Enter a valid date." `ValidationError`를 발생시킨다. 즉 **크래시를 검증 실패로 강등**시킨다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개, JSON 배열 길이와 일치):**
  - `test_value_from_datadict` (test_selectdatewidget): `((str(sys.maxsize + 1), "12", "1"), "0-0-0")` 케이스 추가 — **위젯 레벨**에서 오버플로 입력이 `"0-0-0"`을 반환하는지 직접 단언(픽스의 직접 효과 증명).
  - `test_form_field` (test_datefield): `mydate_month=str(sys.maxsize+1)`인 폼을 만들어 `e.is_valid() is False`이고 `e.errors == {"mydate": ["Enter a valid date."]}`인지 확인 — **end-to-end**로 크래시 대신 검증 에러가 나오는지 증명. 픽스 없으면 이 줄에서 `OverflowError`로 테스트 자체가 폭발한다.
- **overfit 관점:** FAIL_TO_PASS가 단언을 두 층(위젯 반환값 + 폼 errors dict)으로 나눠 special-case 통과를 막는다. `e.errors`의 정확한 메시지/키까지 고정하므로 단순히 예외만 삼키는 얕은 패치(예: `except OverflowError: pass` 또는 None 반환)는 통과 못 한다. `overfit-risk` 플래그는 달지 않음.
- **regression 관점:** test_patch가 PASS_TO_PASS의 `test_datefield_1`에 `f.clean("0-0-0")` → `ValidationError("Enter a valid date.")` 단언을 추가해, **폴백 문자열 선택 자체의 정당성을 회귀로 못박는다.** 나머지 23개 P2P(`test_datefield_2~5`, 각종 `test_render_*`, `test_l10n*`, `test_custom_*`)는 정상 날짜·렌더링·로컬라이제이션 경로 — 새 except 분기는 정상 입력 경로를 전혀 건드리지 않으므로 안전(`regression-trap`은 약함).

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 네이티브 traceback이 `django/forms/widgets.py` line 1160, `value_from_datadict`, `datetime.date(int(y), int(m), int(d))`를 직접 준다. 해당 함수를 열어 이 호출이 `try/except ValueError` 안에 있고 `OverflowError`는 잡히지 않음을 확인 → 5분 내 수렴.
2. **픽스와 일반화 정당성:** 기존 except 블록 바로 뒤에 `except OverflowError: return "0-0-0"`을 추가. 이것이 overfit이 아닌 올바른 일반화인 이유 — (a) `OverflowError`는 `ValueError`와 별개 계층이라 **반드시 분리 분기**여야 하고, (b) 폴백 `"0-0-0"`은 임의 상수가 아니라 *모든* input_format에서 파싱 실패하는 무효 날짜라, 이미 존재하는 검증 파이프라인(`DateField.clean`)이 큰-int뿐 아니라 어떤 오버플로 조합에도 일관되게 "Enter a valid date."를 내도록 만든다. 특정 테스트 입력(`sys.maxsize+1`)에 맞춘 게 아니라 결함클래스 전체를 덮는다.
3. **regression 안전:** 새 분기는 `OverflowError`가 실제로 던져졌을 때만 진입하므로 정상 날짜·pseudo-ISO 폴백(`ValueError` 분기)·렌더링 경로는 byte-identical. 안 깨야 할 P2P는 `test_datefield_1`(특히 새로 추가된 `f.clean("0-0-0")` 거부 단언)과 `test_render_*`·`test_l10n*` — 모두 정상 경로라 영향 없음. `except (ValueError, OverflowError)`로 두 예외를 한 분기에 묶으면 안 되는 이유도 여기 있다: 그러면 오버플로 입력이 pseudo-ISO 폴백(`"%s-%s-%s" % (y or 0, ...)`)을 타게 되어 의미가 미묘하게 달라지고, `test_datefield_1`의 `"0-0-0"` 회귀 단언과 어긋날 수 있다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (i) `OverflowError`가 `ValueError`의 하위클래스라고 잘못 가정해 기존 except를 손대지 않거나 `int(y)` 단계에 별도 try를 끼워 범위를 넓힘(과대수정 → P2P 회귀 위험), (ii) 폴백을 `None`·`pass`·`""`로 두어 폼이 "required" 에러를 내거나 다른 메시지를 내 FAIL_TO_PASS의 `e.errors` 단언을 못 맞춤, (iii) 상위 `DateField`/`BaseTemporalField`까지 올라가 고치려다 광범위 회귀를 부름. 정답은 골드처럼 **기존 try 블록 안에 except 한 분기를 끼우고 `"0-0-0"`을 직접 반환하는 최소 변경**이다.
