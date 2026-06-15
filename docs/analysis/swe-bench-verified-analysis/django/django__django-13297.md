---
instance_id: django__django-13297
repo: django/django
base_commit: 8954f255bbf5f4ee997fd6de62cb50fc9b5dd697
version: 3.2
difficulty: <15 min fix
created_at: 2020-08-12T11:20:33Z
fail_to_pass: 1
pass_to_pass: 52
gold_files: [django/views/generic/base.py]
---

# django__django-13297

## 문제 요약
Django 3.1에서 `TemplateView.get_context_data()`의 kwargs가 URL 캡처값을 원래 타입(예: str slug)이 아니라 `SimpleLazyObject`로 감싸서 반환한다. 그 결과 `get_object_or_404(Account, slug=offer_slug)`처럼 ORM 필터에 그 값을 직접 넘기면 `Error binding parameter 0 - probably unsupported type` 크래시가 난다. 3.0에서는 그냥 동작했고, 사용자는 `str()`로 명시 변환해야만 회피할 수 있었다. URL kwargs를 context로 넘기는 것은 deprecated지만 3.1/3.2에서는 여전히 동작해야 한다.

## 유형 분류
- 버그 카테고리: regression (deprecation 래퍼 도입 시 타입 보존 누락)
- 서브시스템: django 클래스 기반 제네릭 뷰 (django/views/generic)
- 증상 타입: 크래시 (DB 백엔드의 파라미터 바인딩 예외)
- 로컬라이제이션 신호: problem_statement에 "SimpleLazyObject", "TemplateView.get_context_data()'s kwargs", hints_text의 "Regression in 4ed534758cb..." 커밋 지목 — `SimpleLazyObject`로 kwargs를 감싸는 코드가 곧 범인.

## 골드패치 분석
- 건드린 파일/함수: `django/views/generic/base.py:_wrap_url_kwargs_with_deprecation_warning`
- 근본 원인: deprecation 경고를 lazy하게 발생시키려고 각 값을 `@SimpleLazyObject` 데코레이터로 감쌌는데, `SimpleLazyObject`는 호출 시 임의의 객체를 반환하는 범용 lazy 프록시라 원본 타입(str 등)을 보존하지 못한다. ORM/DB 백엔드는 이 프록시 타입을 인식하지 못해 바인딩에서 폭발한다.
- 수정 요지: import를 `SimpleLazyObject` → `lazy`로 교체. `access_value` 클로저에 붙은 `@SimpleLazyObject` 데코레이터를 제거하고, `context_kwargs[key] = lazy(access_value, type(value))()`로 바꿈. `lazy(func, *resultclasses)`는 결과 타입을 명시적으로 알려주므로, 생성된 lazy 객체가 원본 `type(value)`(예: str)처럼 동작해 ORM 필터/슬라이싱과 호환되면서도 접근 시점에야 deprecation 경고가 발생하는 동작을 유지한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_template_params_filtering` — URL kwarg(`artist_name`)를 받아 `Artist.objects.get(name=artist_name)`로 실제 DB 쿼리에 사용하는 시나리오를 검증.
- 증명 방식: `Artist.objects.create(name='Rene Magritte')` 후 `ArtistView.as_view()(rf.get('/'), artist_name=artist.name)` 호출. 픽스 전이면 `artist_name`이 SimpleLazyObject라 ORM 쿼리에서 크래시. 픽스 후엔 str 호환 lazy 객체라 정상 조회되어 `response.context_data['artist'] == artist`가 통과. 실제 DB가 필요해 테스트 클래스가 `SimpleTestCase` → `TestCase`로 바뀌고 `Artist` 모델을 import.

## 공략 포인트 (뭘 조져야)
- localization 전략: 스택트레이스가 sqlite operations로 끝나 헷갈리지만, 입력 타입이 `SimpleLazyObject`라는 단서가 핵심. `grep SimpleLazyObject django/views/generic/base.py`로 바로 `_wrap_url_kwargs_with_deprecation_warning`에 도달. hints의 regression 커밋이 결정적.
- 함정/난이도: DB 레이어를 고치려는 유혹(잘못된 방향). 진짜 수정은 뷰 헬퍼 한 곳. `SimpleLazyObject`를 단순히 벗기면 deprecation 경고의 lazy 평가가 깨지므로, 경고 lazy 발생 + 타입 보존을 동시에 만족하는 `lazy(func, type(value))()` 패턴이 정답. `django.utils.functional`의 `lazy` 시그니처(결과 클래스 인자)를 알아야 함.
- 우리 에이전트 관점: 표면 증상(DB 바인딩 에러)에 끌려 백엔드/모델을 뒤지면 발산. `lazy`와 `SimpleLazyObject`의 의미 차이(타입 보존 여부)를 이해하지 못하면 단순 unwrap으로 deprecation 경고 동작을 회귀시킬 위험이 있다. 단일 파일·2줄 수정이라 로컬라이즈만 정확하면 쉬운 픽스.
