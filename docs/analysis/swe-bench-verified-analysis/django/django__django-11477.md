---
instance_id: django__django-11477
repo: django/django
base_commit: e28671187903e6aca2428374fdd504fca3032aee
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-06-14T17:40:45Z
fail_to_pass: 3
pass_to_pass: 151
gold_files: [django/urls/resolvers.py]
---

# django__django-11477

## 문제 요약
URL 패턴에 optional named group(예: `(?:(?P<optional>...))?`)이 있고, 실제 URL에서 그 그룹이 매칭되지 않으면 `translate_url()`이 잘못된 URL을 생성한다. resolve가 캡처 안 된 optional 그룹을 `None`으로 반환하는데, 이후 reverse 경로에서 그 `None`이 literal 문자열 `'None'`으로 강제 변환되면서 resolve와 reverse 사이에 비대칭이 생긴다. 사용자는 optional 인자가 없을 때 원래 URL 그대로 번역되길 기대했지만, set_language로 언어를 바꾸면 깨진 URL로 인해 404가 발생한다.

## 유형 분류
- 버그 카테고리: 누락처리 / edge-case (optional regex group이 미캡처일 때 `None` 처리 누락)
- 서브시스템: django URL routing — `django.urls` resolver/reverse (URL dispatcher)
- 증상 타입: silent-wrong (잘못된 URL 생성 → 후속적으로 404 크래시)
- 로컬라이제이션 신호: problem_statement는 `translate_url()`을 가리키지만, hints_text가 "resolve() returns None for optional capture groups not captured / asymmetry between resolve() and reverse()"라고 명시하며 `django.urls.resolvers`의 `_reverse_with_prefix` 패치를 제안. 즉 진짜 원인은 i18n 레이어가 아니라 resolver의 매칭 단계.

## 골드패치 분석
- 건드린 파일/함수: `django/urls/resolvers.py` — `RegexPattern.match()` (153번째 줄 근처)
- 근본 원인: `match.groupdict()`는 정규식의 모든 named group을 반환하는데, 매칭되지 않은 optional group은 키는 존재하되 값이 `None`이다. 이 `None`이 kwargs에 그대로 실려 ResolverMatch까지 전파되고, reverse 시 `force_text(None)` → `'None'`으로 변환되어 비대칭을 유발했다.
- 수정 요지: kwargs를 만들 때 값이 `None`인 항목을 걸러낸다.
  ```python
  kwargs = {k: v for k, v in match.groupdict().items() if v is not None}
  ```
  바로 다음 줄 `args = () if kwargs else match.groups()` 로직 덕분에, optional 그룹만 빠지고 다른 named group이 남아 있으면 여전히 kwargs 경로를 타고, named group이 하나도 안 잡히면 positional args로 fallback한다. hints가 제안한 reverse 쪽이 아니라 매칭 시점(source)에서 `None`을 제거하는 방향으로 해결.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_re_path_with_optional_parameter` (urlpatterns) — optional 그룹 패턴 `^regex_optional/(?P<arg1>\d+)/(?:(?P<arg2>\d+)/)?` 에 대해 `/regex_optional/1/2/` → `{'arg1':'1','arg2':'2'}`, `/regex_optional/1/` → `{'arg1':'1'}` (arg2가 `None`으로 들어가지 않음)을 확인.
  - `test_translate_url_utility` (i18n.patterns) — `with-arguments/(?P<argument>...)/(?:(?P<optional>...).html)?` 패턴에서 optional 부분이 없는 `/en/with-arguments/regular-argument/`가 `'None'` 오염 없이 `/nl/...`로 올바르게 번역되는지 확인.
  - `test_two_variable_at_start_of_path_pattern` — kwargs 필터링이 일반 경로를 깨지 않는지 회귀 보호.
- 증명 방식: optional 그룹이 미캡처일 때 kwargs에서 그 키가 아예 빠지므로(`None` 아님), resolve→reverse 왕복이 대칭을 회복하여 입력 URL과 동일한(언어만 바뀐) URL이 재생성된다.

## 공략 포인트 (뭘 조져야)
- localization 전략: 증상은 `translate_url()`/`set_language`지만, 따라가면 reverse→resolve 왕복. `match.groupdict()`가 `None`을 흘리는 `RegexPattern.match()`가 single source of truth. problem_statement만 보고 `i18n/utils.py`의 `translate_url`을 파면 함정이다.
- 함정/난이도: (1) 골드는 1줄이지만 위치 특정이 핵심 — hints는 `_reverse_with_prefix`(reverse 쪽)를 제안하나 골드는 match 쪽을 고쳤다. 둘 다 증상은 잡지만 source-of-truth 수정이 더 깨끗. (2) `args = () if kwargs else match.groups()` 라인과의 상호작용을 이해해야 — 필터 후 kwargs가 빈 dict가 되면 positional fallback이 작동하는 미묘한 분기. (3) `path()`/converter 경로는 별도 `RoutePattern.match`라 영향 없음, re_path만 해당.
- 우리 에이전트 관점: 증상 문구("translate_url")에 끌려 i18n 레이어를 헤매면 다파일 삽질로 빠진다. 핵심은 "optional group 미캡처 시 `None` 누출"이라는 hints 단서를 잡아 `groupdict()` 호출부로 직행하는 것. 단일 파일/단일 줄 수정이라 일단 위치만 맞으면 픽스 자체는 자명.
