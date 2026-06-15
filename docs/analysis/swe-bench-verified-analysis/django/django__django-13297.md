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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, regression]
---

# django__django-13297

## 문제 요약
Django 3.1에서 `TemplateView.get_context_data()`의 kwargs가 URL 캡처값을 원래 타입(예: str slug)이 아니라 `SimpleLazyObject`로 감싸서 반환한다. 그 결과 `get_object_or_404(Account, slug=offer_slug)`처럼 ORM 필터에 그 값을 직접 넘기면 `Error binding parameter 0 - probably unsupported type` 크래시가 난다(sqlite3 `_quote_params_for_last_executed_query`에서 폭발). 3.0에서는 그냥 동작했고, 사용자는 `str(offer_slug)`로 명시 변환해야만 회피할 수 있었다. URL kwargs를 context로 넘기는 것은 deprecated(#19878)지만 3.1/3.2에서는 여전히 동작해야 한다. hints가 회귀 도입 커밋 `4ed534758cb...`을 정확히 지목한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 `SimpleLazyObject` 심볼과 `TemplateView.get_context_data()`를 직접 지목하고, hints가 회귀 커밋 해시까지 준다. `grep SimpleLazyObject django/views/generic/base.py` 한 방이면 `_wrap_url_kwargs_with_deprecation_warning`의 `@SimpleLazyObject` 데코레이터에 도달한다. 표면 스택트레이스가 sqlite operations로 끝나는 미끼가 있지만, "입력 타입이 SimpleLazyObject"라는 명시 단서가 그 노이즈를 무력화한다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning), 보조 S5 (Spec-Inference).** 고칠 지점(2줄)은 자명하나, 단순히 `@SimpleLazyObject`를 벗기면 deprecation 경고의 lazy 평가라는 의도된 불변식이 깨진다. 올바른 픽스는 "값 접근 시점에 경고 발생"과 "원본 타입(str 등) 보존"이라는 **두 제약을 동시에 만족하는 식**을 추론으로 합성해야 한다 — 그게 `lazy(access_value, type(value))()`다. 기계적 가드/상수 교체(S1)가 아니라 의미 합성이라 S2. 보조로 S5: "URL kwargs는 deprecated여도 3.1/3.2에서 동작해야 하고, 경고는 접근 시에만"이라는 의도된 계약을 이슈 본문/deprecation 정책에서 재구성해야 정답 식이 나온다.
- **K (Knowledge) = K-Domain.** `django.utils.functional`의 `SimpleLazyObject`(범용 프록시, 타입 미보존) vs `lazy(func, *resultclasses)`(결과 클래스 인자로 타입 모방)의 의미 차이를 알아야 한다. 일반 파이썬 추론으로는 "왜 lazy 프록시가 ORM 바인딩에서 죽는지", "어떻게 타입을 흉내내게 하는지"를 도출할 수 없다 — django 내부 유틸리티 지식 의존.
- **Primary type = T-ConstraintReason.** 위치는 명확(L0)하나 픽스의 본질이 두 제약(lazy 경고 보존 + 타입 보존)을 만족하는 올바른 식의 추론 합성이라 T-DirectMap(기계적 S1)이 아니라 T-ConstraintReason. T-DomainBound와 경합하나, 도메인 지식은 "올바른 식을 합성하기 위한 재료"로 들어갈 뿐 병목이 localize가 아니라 reasoning이므로 ConstraintReason이 dominant.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 `<15 min fix`(가장 쉬운 prior)이지만, 그건 "정답을 아는 개발자의 구현시간"이라 2줄 수정이라 그렇게 잡힌다. 에이전트 난이도로 재조정하면:
- **위로 미는 피처:** (1) **S2 constraint 합성** — `SimpleLazyObject`를 벗기는 naive unwrap은 테스트를 통과시키지만(filtering 테스트만 보면) deprecation 경고의 lazy 동작을 회귀시킨다. 두 제약을 모두 만족하는 `lazy(func, type(value))()` 패턴을 도출하려면 django functional 도메인 지식 필요(K-Domain). (2) **regression-trap** — P2P 52개 중 `test_template_params_warning`(접근 시점 경고 검증)과 `test_template_params`가 lazy/경고 동작을 직접 검증하므로, 타입만 신경쓰고 lazy 경고를 깨면 인접 동작이 무너진다.
- **아래로 당기는 피처:** L0 pinpoint localize, 단일 파일, 2줄, has-repro(명확한 재현 코드 + 명시 타입 단서 + 회귀 커밋). 만약 S1 기계적이었으면 T2였을 것.
- **순효과:** localize는 거의 공짜지만 repair가 "단순 unwrap이라는 그럴듯한 오답"을 적극 유혹하고, 그 오답을 막으려면 도메인 지식 + 두 제약 추론이 필요해 T4. 공식 라벨(T1/T2급)과 갈리는 이유는 시간라벨이 overfit-trap(naive unwrap)과 lazy-warning regression-trap을 잡지 못하기 때문.

## 골드패치 분석
- **건드린 파일·함수:** `django/views/generic/base.py` 단일 파일. import 라인 + `_wrap_url_kwargs_with_deprecation_warning(url_kwargs)` 헬퍼.
- **근본 원인:** deprecation 경고를 "값 접근 시점"에 lazy하게 발생시키려고 `access_value` 클로저를 `@SimpleLazyObject`로 감쌌다. `SimpleLazyObject`는 호출 결과로 임의 객체를 반환하는 **범용 lazy 프록시**라 원본 값의 타입(str slug 등)을 보존/모방하지 못한다. ORM/DB 백엔드(`_quote_params_for_last_executed_query`)는 이 프록시 타입을 인식하지 못해 파라미터 바인딩에서 `unsupported type`으로 크래시한다.
- **수정 요지:** (1) import `SimpleLazyObject` → `lazy`. (2) `access_value` 클로저의 `@SimpleLazyObject` 데코레이터 제거. (3) `context_kwargs[key] = access_value` → `context_kwargs[key] = lazy(access_value, type(value))()`. `lazy(func, *resultclasses)`는 결과 클래스를 명시받아 생성된 lazy 객체가 `type(value)`(예: str)처럼 동작·메서드를 위임하므로 ORM 필터/문자열 연산과 호환되면서, 실제 호출은 접근 시점까지 지연되어 deprecation 경고의 lazy 발생 동작을 그대로 유지한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개): `test_template_params_filtering`** — URL kwarg(`artist_name`)를 `Artist.objects.get(name=artist_name)`로 실제 DB 쿼리에 넘기는 시나리오. `Artist.objects.create(name='Rene Magritte')` 후 `ArtistView.as_view()(self.rf.get('/'), artist_name=artist.name)`를 호출하고 `response.context_data['artist'] == artist`를 단언. 픽스 전: `artist_name`이 `SimpleLazyObject`라 ORM 쿼리 바인딩에서 크래시. 픽스 후: str 타입을 모방하는 lazy 객체라 정상 조회되어 통과. 실 DB가 필요해 테스트 클래스를 `SimpleTestCase` → `TestCase`로 바꾸고 `from .models import Artist`를 추가, `rf = RequestFactory()`를 클래스 속성으로 둠.
- **overfit 관점:** FAIL_TO_PASS가 1개뿐이고 "ORM 필터에서 안 죽는다"만 직접 검증한다. naive unwrap(`@SimpleLazyObject` 제거 후 `context_kwargs[key] = access_value()` 즉시 호출)도 이 테스트를 통과시킬 수 있어 **overfit/오답 함정이 실재**한다 — 다만 즉시 호출은 deprecation 경고를 즉시 발생시켜 lazy 계약을 깬다.
- **regression 관점:** 그 lazy 계약을 지키는 가드는 P2P 중 `test_template_params_warning` **단독**이다. 이 테스트는 데코레이터 없이 `with self.assertRaisesMessage(RemovedInDjango40Warning, ...): str(response.context['foo1'])`로 **접근 시점**에 경고가 나는지를 검증하므로, 즉시 호출 unwrap(`access_value()`로 raw str을 미리 넣어 경고를 조기 발생시킴)은 `str()` 접근 시 경고가 안 떠 `assertRaisesMessage`가 실패 → 적발된다. 반면 `test_template_params`는 `@ignore_warnings(category=RemovedInDjango40Warning)`가 걸려 있고 단지 `response.context['foo'] == 'bar'` 값 동등성만 단언하므로, 즉시 호출해 raw str을 넣어도 그대로 통과 — lazy 지연을 깨는 오답을 **잡지 못한다**. 골드의 `lazy(access_value, type(value))()`는 filtering(타입 보존)과 warning(접근-시점 lazy 경고)을 모두 만족하는 유일하게 깔끔한 형태.

## 모범답안 (오라클 기반)
1. **Localize:** 표면 스택트레이스(sqlite operations `unsupported type`)에 끌려가지 말 것. 핵심 신호 두 개 — 이슈 본문의 "offer_slug was of type 'SimpleLazyObject'"와 hints의 "Regression in 4ed534758cb...". `grep -rn SimpleLazyObject django/views/generic/base.py`로 `_wrap_url_kwargs_with_deprecation_warning`의 `@SimpleLazyObject` 데코레이터에 직행. DB/ORM 백엔드는 증상지일 뿐 수정지가 아니다.
2. **픽스(올바른 일반화):** 두 제약을 명시화한다 — (A) deprecation 경고는 값 접근 시점에 발생(lazy), (B) 값은 ORM/문자열 연산과 호환되도록 원본 타입을 모방. `SimpleLazyObject`는 (A)는 만족하나 (B) 실패. `django.utils.functional.lazy(func, *resultclasses)`가 `resultclasses`로 (B)를 메우면서 (A)를 유지. 그래서 `lazy(access_value, type(value))()`. 이게 overfit이 아닌 이유: 단일 테스트 입력(str slug)에 맞춘 `str()` 캐스팅이 아니라, **임의 URL 캡처 타입에 대해 `type(value)`로 일반화**하므로 int/uuid 등 다른 path converter에도 정합. naive 즉시 호출 unwrap보다 우월한 건 lazy 경고 계약을 보존하기 때문.
3. **regression 안전:** `test_template_params_warning`(접근 시 경고)·`test_template_params`(kwargs→context 전달)를 깨면 안 된다. 즉시 호출 unwrap은 경고를 조기 발생시켜 전자를 깬다. RedirectView/TemplateView 계열 P2P 다수는 헬퍼와 무관해 영향 없지만, 같은 헬퍼를 만지므로 lazy 지연 동작을 반드시 보존해야 한다.
4. **함정 회피:** (a) **방향 함정** — sqlite/operations나 모델 레이어를 고치려는 유혹. 진짜 수정은 뷰 헬퍼 한 곳. (b) **naive unwrap 함정** — `@SimpleLazyObject`만 떼고 끝내면(혹은 `access_value()` 즉시 호출) filtering 테스트는 통과하나 deprecation 경고의 lazy 동작을 회귀시켜 P2P에서 잡힌다. (c) **`str()` 하드코딩 함정** — `str(value)`로 캐스팅하면 이 테스트는 통과하나 비-str URL 캡처 타입에서 깨지는 overfit. 정답은 `type(value)`로 타입을 파라미터화해 일반화하는 것. 오라클 없는 에이전트는 (b)/(c) 중 하나로 빠지기 쉽고, 그걸 피하려면 `lazy` vs `SimpleLazyObject`의 의미 차이(타입 보존)를 도메인 지식으로 알아야 한다.
