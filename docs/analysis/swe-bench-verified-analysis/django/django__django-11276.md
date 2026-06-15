---
instance_id: django__django-11276
repo: django/django
base_commit: 28d5262fa3315690395f04e3619ed554dbaf725b
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-04-24T12:35:05Z
fail_to_pass: 26
pass_to_pass: 548
gold_files: [django/utils/html.py]
---

# django__django-11276

## 문제 요약
`django.utils.html.escape()`는 Python 표준 라이브러리 `html.escape()`의 기능을 부분적으로 중복 구현하고 있다. 이슈는 이 자체 구현(`str.translate(_html_escapes)` 기반)을 stdlib 버전으로 교체해 코드 중복을 제거하고 성능도 개선하자는 제안이다(`.translate()`보다 `.replace()`가 빠름, 약 4.03→2.45 usec). 단, `html.escape()`는 작은따옴표를 `&#39;`가 아니라 `&#x27;`로 인코딩하므로 이는 HTML상 동등하지만 리터럴 텍스트가 바뀌는 backwards-incompatible 변경이다.

## 유형 분류
- 버그 카테고리: API-contract (리팩토링/표준화 — 동작 동등하되 출력 리터럴 변경)
- 서브시스템: django utils / HTML escaping (템플릿 렌더링 전반에 사용)
- 증상 타입: silent-wrong 아님 — 기능적으로는 정상, 중복 구현 + 출력 리터럴 차이가 핵심
- 로컬라이제이션 신호: problem_statement가 파일·함수를 직접 지목(`django.utils.html.escape()`)하므로 로컬라이제이션은 거의 자명. 난이도는 "어디"가 아니라 `&#39;→&#x27;` 변경이 유발하는 광범위한 테스트 fallout 처리에 있음.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/html.py` — `escape()`, 그리고 `urlize()` 내부의 로컬 헬퍼 `unescape()` 및 호출부(`trim_punctuation`, `is_email_simple` 주변 블록)
- 근본 원인: 버그라기보다 의도적 중복. `_html_escapes` translate 테이블과 로컬 `unescape()`는 stdlib `html.escape`/`html.unescape`가 이미 제공하는 기능의 손수 만든 복제본이었다.
- 수정 요지:
  - 파일 상단에 `import html` 추가.
  - 모듈 레벨 `_html_escapes` dict 삭제.
  - `escape()` 본문을 `str(text).translate(_html_escapes)` → `html.escape(str(text))`로 교체(`mark_safe` 래핑 유지).
  - `urlize()` 내부 로컬 `unescape()` 함수 정의를 삭제하고 3개 호출부를 모두 stdlib `html.unescape()`로 치환(`middle_unescaped` 계산, `simple_url_re`/`simple_url_2_re` 매치 시 `smart_urlquote(...)`).

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: 26개 테스트가 작은따옴표 escape 결과를 `&#39;`에서 `&#x27;`로 기대하도록 갱신됨. 대표적으로 `utils_tests.test_html.TestUtilsHtml.test_escape`의 escape 매핑 테이블이 `("'", '&#x27;')`로 바뀌고, urlize/title/make_list/addslashes/url-tag 필터, model_forms·auth forms·csrf·debug view 렌더 결과의 따옴표 리터럴이 전부 갱신된다.
- 테스트가 픽스를 증명하는 방식: 예) `test_escape`는 `"'"` 입력에 대해 출력이 `&#x27;`인지 단언 → 새 stdlib 기반 escape를 통과해야만 green. `widget_tests/base.py`의 `check_html`은 Jinja2가 `&#39;`를 쓰는 반면 Django는 이제 `&#x27;`를 쓴다는 차이를 명시적으로 흡수(`output.replace('&#39;', '&#x27;')`)하여 두 렌더러 출력을 정규화한다. `test_strip_tags`에는 `&#x27;` 입력 케이스가 추가되어 unescape 경로의 동등성도 확인한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 `django/utils/html.py`의 `escape()`를 직접 명명 → 단일 파일 코어 수정. stdlib `html.escape`/`html.unescape`로 1:1 치환이 정석.
- 함정/난이도 메모:
  - 코어 수정은 2~3줄이지만 `&#39;→&#x27;` 변경이 26개 FAIL_TO_PASS를 가로질러 퍼진다. 에이전트가 `escape()`만 고치고 멈추면 대량 테스트가 깨지므로, 실제 골드는 테스트 기대값까지 일괄 갱신했다(test_patch 범위 = 13개 테스트 파일).
  - `urlize()` 내부 로컬 `unescape()` 삭제를 빠뜨리기 쉬움 — escape만 바꾸면 중복 제거가 절반만 됨. 골드는 `html.unescape()`로 함께 치환했다(엔티티 동등성 유지).
  - 보안 민감 함수(XSS escaping)라 `'` 외 문자(`& < > "`)의 매핑이 stdlib와 동일한지 확인 필요 — stdlib `html.escape(quote=True)` 기본값이 `"`→`&quot;`, `'`→`&#x27;`로 Django 의도와 일치.
- 우리 에이전트 관점 막힐 지점: 로컬라이제이션은 쉬우나, 코드 변경만으로는 테스트가 깨져 "수정이 회귀를 냈다"고 오판할 위험. 이 문제의 본질은 "출력 리터럴 변경을 backwards-incompatible로 수용하고 기대값을 전역 업데이트"하는 것이며, 코드 패치(`gold_files`)만 채점에 쓰이지만 에이전트가 self-verify로 테스트를 돌리면 기대값 불일치에 막혀 잘못된 revert를 시도할 수 있다.
