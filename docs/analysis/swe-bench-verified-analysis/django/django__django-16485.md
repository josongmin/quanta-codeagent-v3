---
instance_id: django__django-16485
repo: django/django
base_commit: 39f83765e12b0e5d260b7939fc3fe281d879b279
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-01-18T22:03:52Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [django/template/defaultfilters.py]
---

# django__django-16485

## 문제 요약
템플릿 필터 `floatformat()`이 정밀도 인자 `0`과 함께 `"0.00"`(또는 `Decimal("0.00")`)을 받으면 크래시한다. 두 호출 모두 `ValueError: valid range for prec is [1, MAX_PREC]`를 던진다. 사용자는 `floatformat("0.00", 0)`이 정상적으로 `"0"`을 반환하기를 기대했다. 알파 릴리즈 회귀로, 커밋 08c5a787262c1ae57f6517d4574b54a5fcaad124에서 유입됐다.

## 유형 분류
- 버그 카테고리: edge-case (off-by-one 경계 조건; `< 0` vs `<= 0`)
- 서브시스템: django template / defaultfilters (`floatformat`)
- 증상 타입: 예외 (ValueError, 크래시)
- 로컬라이제이션 신호: problem_statement이 `floatformat`을 직접 명시 + 에러 메시지가 `prec`(decimal precision) 범위 위반 → `django/template/defaultfilters.py`의 `floatformat` 내부 Decimal `Context(prec=...)` 경로로 바로 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/template/defaultfilters.py`:`floatformat(text, arg=-1)`
- 근본 원인: 값이 0(`not m`, 가수가 없음)이고 정밀도 `p`가 `0`일 때, 정수 단축 경로(`"%d" % int(d)`)로 빠지지 못하고 아래로 흘러가 `Context(prec=p)` 같은 Decimal 연산을 호출한다. Decimal의 prec는 최소 1이어야 하므로 `p=0`에서 `ValueError`가 발생한다. 기존 가드 `if not m and p < 0:`는 `p < 0`만 단축 처리해 `p == 0` 경계를 빠뜨린 off-by-one이다.
- 수정 요지: 단축 가드의 조건을 `if not m and p < 0:` → `if not m and p <= 0:`로 한 글자 변경. 이제 값이 0이고 정밀도가 0 이하면 정수 포맷 경로(`number_format("%d" % int(d), ...)`)로 빠져나가 prec 위반 Decimal 연산을 아예 타지 않게 한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_zero_values` — `floatformat`의 0 값 처리 동작.
- 테스트가 어떻게 픽스를 증명하는지: `test_zero_values`에 두 단언을 추가한다. `floatformat("0.00", 0) == "0"`과 `floatformat(Decimal("0.00"), 0) == "0"`. 패치 전에는 두 호출이 ValueError로 크래시하므로 테스트가 RED, 패치 후엔 `p <= 0` 가드가 정수 경로로 보내 `"0"`을 반환하므로 GREEN. 문자열/Decimal 입력 둘 다 검증해 입력 타입 무관함도 보장한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: 에러 메시지 `valid range for prec`는 Decimal `Context(prec=...)` 시그니처. `floatformat` 함수 본문에서 `Context`/`prec`을 세팅하는 지점과 그 앞의 0-값 단축 가드(`not m and p < 0`)를 읽으면 끝난다. 단일 함수, 단일 파일.
- 함정/난이도 메모: 한 글자 변경이지만 "왜 `<=`가 맞는지" 논증이 필요하다. `p`(소수 자릿수)와 `m`(가수 유무)의 의미를 잘못 읽으면 0이 아닌 값의 `p=0` 처리(반올림)까지 단축시켜 회귀를 낼 수 있다. 가드는 반드시 `not m`(값=0)으로 게이트되어 있어야 안전하다. 음수 0(`test_negative_zero_values`)과 일반 포맷팅이 PASS_TO_PASS에 있어 과교정 시 깨진다.
- 우리 에이전트 관점: 막힐 만한 지점은 "정수 단축 경로로 빠지면 된다"는 통찰. 단순히 `try/except`로 ValueError를 삼켜버리는 잘못된 픽스를 유도할 수 있으나, 그러면 출력이 `"0"`이 아니거나 다른 prec 케이스를 망친다. 골드처럼 기존 단축 가드의 경계만 `<=`로 넓히는 최소 수정을 찾는 게 핵심이며, 값=0 게이트(`not m`)를 유지하는지 확인해야 한다.
