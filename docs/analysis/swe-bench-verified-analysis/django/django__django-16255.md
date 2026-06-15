---
instance_id: django__django-16255
repo: django/django
base_commit: 444b6da7cc229a58a2c476a52e45233001dc7073
version: 4.2
difficulty: <15 min fix
created_at: 2022-11-04T13:49:40Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/contrib/sitemaps/__init__.py]
---

# django__django-16255

## 문제 요약
sitemap이 항목(items)을 하나도 가지지 않지만 callable `lastmod`를 지원하는 경우, sitemap index 렌더링 시 `ValueError: max() arg is an empty sequence`가 발생한다. `get_latest_lastmod()`가 빈 리스트에 `max()`를 호출하기 때문이다. 사용자는 빈 sitemap이라면 단순히 `Last-Modified`가 없는(=None) 정상 응답을 기대한다.

## 유형 분류
- 버그 카테고리: edge-case (빈 컬렉션 미처리)
- 서브시스템: django.contrib.sitemaps (sitemap 프레임워크 / index 뷰)
- 증상 타입: 예외 (ValueError 크래시, 500 응답)
- 로컬라이제이션 신호: problem_statement에 전체 traceback이 그대로 제공됨 — `django/contrib/sitemaps/__init__.py", line 170, in get_latest_lastmod` / `return max([self.lastmod(item) for item in self.items()])`로 파일·함수·라인이 정확히 지목됨. 제안 패치까지 포함.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/sitemaps/__init__.py` : `Sitemap.get_latest_lastmod`
- 근본 원인: `self.items()`가 빈 시퀀스를 반환하면 리스트 컴프리헨션 결과가 `[]`가 되고, `max([])`는 `ValueError`를 던진다. 기존 `try/except TypeError`는 lastmod 값이 비교 불가능한 타입일 때만 잡고, 빈 시퀀스의 `ValueError`는 잡지 못한다.
- 수정 요지: `max(...)` 호출에 `default=None` 인자를 추가해 빈 시퀀스일 때 예외 대신 `None`을 반환하도록 했다. (`max([...])` → `max([...], default=None)`) problem_statement의 제안(`except (TypeError, ValueError)`) 대신, 메인테이너 힌트("default argument of max() can be used")를 따라 더 명시적이고 의도가 드러나는 방식을 채택했다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_callable_sitemod_no_items` — items가 비어있는 callable-lastmod sitemap의 index가 예외 없이 렌더링되는지 검증.
- 테스트가 픽스를 증명하는 방식: `urls/http.py`에 `CallableLastmodNoItemsSitemap`(`items()`가 `[]` 반환, callable `lastmod` 보유)을 추가하고 `/callable-lastmod-no-items/index.xml` 경로를 등록한다. 테스트는 이 URL을 GET하여 (1) 응답에 `Last-Modified` 헤더가 없고 (2) sitemapindex XML이 기대값과 일치함을 `assertXMLEqual`로 확인한다. 픽스 전에는 500(ValueError)이 나서 응답 자체를 받지 못한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: traceback이 `get_latest_lastmod`를 직접 가리키므로 해당 함수의 `max(...)` 호출 한 줄만 보면 된다. 단일 파일 단일 라인 수정.
- 함정/난이도 메모: 두 갈래의 해법이 존재 — (a) `except`에 `ValueError` 추가, (b) `max(..., default=None)`. 둘 다 동작하지만 골드는 (b)다. (a)를 선택하면 FAIL_TO_PASS는 통과하나 의도가 덜 명확하고, `else` 분기(callable이 아닌 lastmod)와의 일관성은 무관하므로 주의. callable이 아닌 경우(`else: return self.lastmod`)는 빈 items와 무관하니 건드리지 말 것.
- 우리 에이전트 관점: 막힐 지점이 거의 없는 1줄 edge-case 픽스. 리스크는 과잉 수정(except 절을 광범위하게 넓히거나 items 호출부를 리팩터)뿐이다. test_patch가 URL conf + 새 Sitemap 클래스를 요구하므로, 골드 코드 패치(`__init__.py`)만으로 충분하고 테스트는 채점 측에서 적용됨을 인지하면 된다.
