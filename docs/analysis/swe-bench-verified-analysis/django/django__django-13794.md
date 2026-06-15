---
instance_id: django__django-13794
repo: django/django
base_commit: fe886eee36be8022f34cfe59aa61ff1c21fe01d9
version: 3.2
difficulty: <15 min fix
created_at: 2020-12-19T20:09:34Z
fail_to_pass: 3
pass_to_pass: 24
gold_files: [django/utils/functional.py]
---

# django__django-13794

## 문제 요약
템플릿의 `add` 필터로 일반 문자열과 lazy string(`gettext_lazy` 결과)을 이어붙이면 결과가 항상 빈 문자열이 된다. 내부적으로 `str + __proxy__` 연산이 `TypeError: can only concatenate str (not "__proxy__") to str`를 던지고, `add` 필터가 예외를 삼켜 빈 문자열을 반환하기 때문이다. 사용자는 `'string' + lazy('lazy')`가 `'stringlazy'`로 정상 연결되길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (API-contract) — lazy proxy가 `__add__`/`__radd__` 연산자를 구현하지 않음
- 서브시스템: django.utils.functional (lazy/`__proxy__`) + template defaultfilters(`add`)
- 증상 타입: silent-wrong (예외가 필터 내부에서 삼켜져 빈 문자열 출력)
- 로컬라이제이션 신호: 에러 메시지의 `"__proxy__"` 타입이 핵심 단서. `__proxy__`는 `django/utils/functional.py`의 `lazy()`가 생성하는 프록시 클래스명이며, 거기에 `+` 연산자 dunder가 빠진 것이 원인.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/functional.py` — `lazy()` 내부 `__proxy__` 클래스 (`__mod__` 바로 아래)
- 근본 원인: `__proxy__`는 `__str__`, `__mod__` 등 일부 매직 메서드만 위임하고 있었고 `__add__`/`__radd__`가 없었다. 그래서 `str + __proxy__`(좌변이 str) 시 str의 `__add__`가 `__proxy__`를 거부 → Python이 우변 `__proxy__.__radd__`로 폴백하지만 그것도 정의되어 있지 않아 `TypeError` 발생.
- 수정 요지: `__proxy__`에 두 메서드를 추가.
  - `__add__(self, other)`: `self.__cast() + other` — proxy를 먼저 실제 값(str/int 등)으로 캐스팅한 뒤 더함.
  - `__radd__(self, other)`: `other + self.__cast()` — proxy가 우변일 때 좌변 실제값과의 덧셈을 지원.
  - `__cast()`로 평가 시점에 실제 타입(str, int 등)을 얻으므로 문자열 연결뿐 아니라 숫자 덧셈에도 동작한다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작:
  - `test_lazy_add` (utils_tests): `lazy(lambda: 4, int)() + lazy(lambda: 5, int)()` == `9` — proxy+proxy 정수 덧셈.
  - `test_add08`: `{{ s1|add:lazy_s2 }}`로 str + lazy → `'stringlazy'` (`__radd__` 경로).
  - `test_add09`: `{{ lazy_s1|add:lazy_s2 }}`로 lazy + lazy → `'stringlazy'`.
- 증명 방식: 픽스 전에는 `add` 필터가 `TypeError`를 만나 빈 문자열을 렌더링하지만, `__add__`/`__radd__` 추가 후에는 양변을 캐스팅하여 정상 연결/덧셈 결과를 반환. 템플릿 렌더 출력 문자열을 직접 단언하므로 회귀를 잡는다.

## 공략 포인트 (뭘 조져야)
- localization 전략: 에러 메시지의 `__proxy__` 키워드로 바로 `django/utils/functional.py`의 `lazy()` → 내부 `__proxy__` 클래스로 직행. `add` 필터(`defaultfilters.add`) 쪽은 try/except로 예외를 삼킬 뿐 근본 원인이 아니다.
- 함정/난이도: `add` 필터를 고치려는 유혹(예: 예외 시 `str()` 캐스팅)이 있으나, 그건 다른 lazy 연산 시나리오를 못 잡는 표면적 수정이다. 골드는 프록시 자체에 연산자를 위임하는 더 일반적이고 올바른 수정.
- 우리 에이전트 관점: `__radd__` 누락(str이 좌변일 때 우변 폴백이 필요)을 빠뜨리면 `test_add08`가 실패한다. `__add__`만 추가하고 끝내기 쉬운 함정. 또 `__cast()`가 이미 위임 패턴의 표준 헬퍼임을 인접 메서드(`__mod__`)에서 읽어내면 자연스럽게 동일 패턴으로 수렴할 수 있다.
