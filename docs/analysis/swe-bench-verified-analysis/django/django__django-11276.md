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
primary_type: T-DirectMap
tier: T4
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-API
flags: [regression-trap, overfit-risk]
---

# django__django-11276

## 문제 요약
`django.utils.html.escape()`는 Python 표준 라이브러리 `html.escape()`의 기능을 부분적으로 중복 구현하고 있다(`str.translate(_html_escapes)` 기반). 이슈는 이 자체 구현을 stdlib 버전으로 교체해 코드 중복을 제거하고 성능도 개선하자는 제안이다(Python bug #18020의 결론대로 `.translate()`보다 `.replace()`가 빠름, 템플릿 렌더링에서 escape는 매우 자주 호출됨, 약 4.03→2.45 usec). 핵심 caveat: stdlib `html.escape()`는 작은따옴표를 `&#39;`가 아니라 `&#x27;`로 인코딩한다. 이는 HTML상 기능적으로 동등하지만 **출력 리터럴이 바뀌는 backwards-incompatible 변경**이며, 이슈 본문이 직접 이 점을 경고한다.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement가 수정 대상을 파일·함수 단위로 직접 지목한다("django.utils.html.escape()를 stdlib html.escape()로"). grep 한 방이면 `escape()` 정의에 도달한다. 탐색 노력이 사실상 0이라 L1도 아닌 L0.
- **S1 Direct-Map (+S5 Spec-Inference)** — dominant는 S1. 이슈가 픽스를 거의 명세한다: `str(text).translate(_html_escapes)` → `html.escape(str(text))` 1:1 치환, 그리고 그 쌍에 해당하는 `unescape()`→`html.unescape()` 치환. 정형 결함클래스("중복 구현을 정규 stdlib API로 대체")에 템플릿 매칭된다. 보조로 S5가 붙는 이유: stdlib API가 Django 기존 escape 계약(`& < > " '` 5문자, `quote=True` 기본)과 정확히 일치하는지를 *문서·관례에서 재확인*해야 안전하게 치환할 수 있다. 즉 픽스 자체는 기계적이나 "치환이 의미적으로 동등한가"의 스펙 검증이 정당성의 핵심이다. 후보 패치를 여러 개 만들어 테스트로 수렴하는 S3/CEGIS가 아니므로 generate-&-validate는 아니다.
- **K-API (API-contract)** — 일반 파이썬 지식이 아니라 `html.escape(quote=True)`가 어떤 문자를 어떻게 매핑하는지(특히 `'`→`&#x27;`, `"`→`&quot;`)라는 stdlib **공개 API 계약**과, Django escape의 하위호환 계약(출력 리터럴이 공개 동작이라는 사실)을 정확히 맞추는 것이 병목이다. ORM/query-compiler 같은 django 내부 도메인지식(K-Domain)이 아니라 API 계약 정합성이라 K-API.

primary type = **T-DirectMap**: 위치가 명확하고(L0) 픽스가 기계적 치환(S1)이다. T-LocTrivial이 아닌 이유는 픽스가 "자명"하기만 한 게 아니라 출력 계약 동등성 검증(S5/K-API)을 동반하고, regression fallout이 광범위해 단순 1줄 트리비얼을 넘기 때문이다.

## 난이도 티어
**T4 (약간 어려움)**. 공식 라벨은 "15분-1시간"으로 T2~T3 수준을 시사하지만, 본 분석은 T4로 한 단계 올린다. 근거:

- **코어 패치는 작다** — `gold_files`는 단일 파일(`django/utils/html.py`), 실질 변경은 `import html` 추가 + `_html_escapes` dict 삭제 + `escape()` 1줄 교체 + 로컬 `unescape()` 삭제 + 3개 호출부 치환. 줄 수만 보면 T1~T2.
- **그러나 P2P/regression trap이 티어를 끌어올린다** — `&#39;→&#x27;` 변경이 **26개 FAIL_TO_PASS를 13개 테스트 파일에 걸쳐** 전파한다(admin_docs / auth_forms / forms / widget_tests / model_forms / template filter(addslashes·make_list·title·urlize·url) / utils_html / csrf / debug view). 출력 리터럴이 공개 계약이라, escape만 고치면 인접한 수백 개 렌더 동작(pass_to_pass=548)의 기대값이 어긋난다. 이 "넓은 P2P trap"이 루브릭상 T4의 명시 트리거다.
- **overfit-risk + 스펙 판단** — 에이전트가 코드만 고치고 테스트를 돌리면 26개가 깨져 "내 수정이 회귀를 냈다"고 오판하고 잘못된 revert를 시도하기 쉽다. 본질을 "출력 리터럴 변경을 backwards-incompatible로 수용"으로 인식해야 하는데, 이 판단은 시간 라벨에 안 잡힌다.
- localize 자체는 L0로 쉽고 K-Domain 깊이가 없어 T5까지는 아니다. → T4가 적정.

공식 라벨과 다른 이유: 공식 "15분-1시간"은 **숙련 django 개발자의 구현 시간**(치환은 빠르고 기대값 일괄 갱신은 기계적)을 반영한 것이다. 에이전트 관점에서는 (a) 출력 계약 변경이라는 메타 판단, (b) 광범위 P2P trap에서의 회귀 오판 위험이 추가 난이도를 만든다.

## 골드패치 분석
- **건드린 파일·함수**: `django/utils/html.py` 단일 파일.
  - 모듈 상단: `import html` 추가.
  - 모듈 레벨 `_html_escapes` translate 테이블(dict) 삭제.
  - `escape(text)`: 본문을 `mark_safe(str(text).translate(_html_escapes))` → `mark_safe(html.escape(str(text)))`로 교체(`@keep_lazy(str, SafeString)` 데코레이터·`mark_safe` 래핑 유지).
  - `urlize()` 내부 로컬 헬퍼 `unescape(text)` 정의 삭제(수동 `.replace()` 체인이던 것).
  - `urlize()` 내 3개 호출부를 stdlib `html.unescape()`로 치환: `trim_punctuation`의 `middle_unescaped = html.unescape(middle)`, 그리고 `simple_url_re`/`simple_url_2_re` 매치 분기의 `smart_urlquote(html.unescape(middle))` / `smart_urlquote('http://%s' % html.unescape(middle))`.
- **근본 원인**: 버그가 아니라 **의도적 중복 구현**. `_html_escapes` translate 테이블과 로컬 `unescape()`는 stdlib `html.escape`/`html.unescape`가 이미 제공하는 기능의 손수 만든 복제본이었고, translate 기반이라 replace 기반 stdlib보다 느렸다.
- **수정 요지**: escape/unescape 양쪽을 stdlib 정규 API로 1:1 대체해 중복 제거 + 성능 개선. 부수효과로 `'` 인코딩이 `&#39;`→`&#x27;`로 바뀐다(stdlib 표기).

## 검증 (test_patch)
- **FAIL_TO_PASS 동작(26개)**: 작은따옴표 escape 결과를 `&#39;`에서 `&#x27;`로 기대하도록 갱신된 테스트들. 코어 동등성은 `utils_tests.test_html.TestUtilsHtml.test_escape`가 escape 매핑 테이블을 `("'", '&#x27;')`로 바꿔 단언한다. 나머지는 escape를 거쳐 렌더되는 상위 동작: template filter(`addslashes02`, `make_list02`, `title1`, `urlize06`/`test_url_split_chars`/`test_wrapping_characters`, `url12`), `model_forms`/`auth` forms 렌더, `admin_docs` 메서드 인자 표시, `csrf`/`debug` view HTML, clearablefileinput 위젯 등에서 따옴표 리터럴을 `&#x27;`로 갱신.
- **픽스 증명 방식**: `test_escape`는 `"'"` 입력 → 출력이 `&#x27;`여야만 green이므로 새 stdlib escape 경로가 실제로 타야 통과한다(wiring 증명). `forms_tests/widget_tests/base.py`의 `check_html`은 정규화 한 줄을 추가(`output = output.replace('&#39;', '&#x27;')`)해 "Jinja2는 `&#39;`, Django는 이제 `&#x27;`"라는 렌더러 차이를 명시적으로 흡수한다 — 이는 코어 변경이 Django 렌더러에만 영향을 주고 Jinja2 경로는 불변임을 증거한다. `test_strip_tags`에는 `&#x27;` 입력 케이스가 *추가*되어 unescape/strip 경로가 새 엔티티 표기에서도 동등함을 확인한다.
- **overfit·regression 관점**: 
  - regression: pass_to_pass=548로 escape를 경유하는 인접 렌더 동작이 광범위하다. 골드는 `"` (`&quot;`), `<`/`>` (`&lt;`/`&gt;`), `&` (`&amp;`) 매핑을 그대로 유지(stdlib와 동일)하여 `'` 외 문자는 byte-identical 출력을 보장 → 이 P2P 대부분이 안 깨진다.
  - overfit: FAIL_TO_PASS가 26개로 두껍고 코어 단언(`test_escape` 5문자 매핑 + strip_tags 동등성)이 있어, `'`만 특수 치환하는 special-case 패치로는 5문자 전체 매핑·unescape 동등성 단언을 통과할 수 없다. 다만 에이전트가 escape 본문에서 `'`→`&#x27;`만 하드코딩하고 stdlib로 안 가면 성능/중복제거 의도는 못 살리고 unescape 경로 동등성에서 흠집날 수 있어 overfit-risk 플래그 유지.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 `django.utils.html.escape()`를 직접 명명 → 바로 `django/utils/html.py`의 `escape()` 정의와 모듈 상단 `_html_escapes` dict로 이동. 같은 모듈의 `urlize()` 내부에 짝을 이루는 로컬 `unescape()`가 있는지 즉시 스캔(중복 제거의 다른 절반). 탐색은 L0.
2. **픽스와 올바른 일반화**: `escape()` 본문을 `html.escape(str(text))`로 교체하고 `_html_escapes`를 삭제, 로컬 `unescape()`를 `html.unescape()`로 치환. 올바른 일반화인 이유 — 이슈가 요구한 건 "동작 동등 + stdlib 위임"이고, stdlib `html.escape(quote=True)` 기본 매핑(`& < > " '`)이 Django 기존 5문자 집합과 정확히 일치한다(차이는 오직 `'`의 표기 `&#39;`↔`&#x27;`, 둘은 HTML 동등). 따라서 stdlib 위임은 special-case가 아니라 **계약을 보존하는 정규화**다. escape와 unescape를 짝으로 바꿔야 entity 왕복 동등성도 유지된다.
3. **regression 안전**: pass_to_pass=548 — escape를 경유하는 거의 모든 form/widget/template/admin 렌더가 영향권. `"`→`&quot;`, `&`→`&amp;`, `<`/`>`→`&lt;`/`&gt;` 매핑을 stdlib가 동일하게 내므로 `'`를 포함하지 않는 출력은 byte-identical → 이 P2P가 안 깨진다. `urlize()`의 `smart_urlquote(html.unescape(...))` 경로도 stdlib unescape가 기존 5엔티티 + 추가 명명/숫자 엔티티를 동등 이상으로 처리해 URL 추출 동작을 보존한다. Jinja2 렌더러 경로는 코어를 안 타므로 `check_html`의 정규화 추가로 흡수.
4. **함정 회피**: 오라클 없는 에이전트의 최대 함정은 **"escape만 고치면 26개 테스트가 깨진다 → 내 패치가 회귀다"라고 오판해 revert**하는 것이다. 본질은 이슈가 명시한 "backwards-incompatible 출력 리터럴 변경을 *수용*"이므로, 깨지는 테스트는 회귀가 아니라 **기대값 업데이트 대상**이다(채점은 `gold_files`인 코드 패치만 보지만 self-verify 시 기대값 불일치에 빠짐). 두 번째 함정: `escape()`만 바꾸고 `urlize()`의 로컬 `unescape()` 삭제를 빠뜨리면 중복 제거가 절반만 되고 코드 정합성이 어긋난다 — escape를 바꾸면 같은 모듈에서 짝이 되는 unescape도 함께 stdlib로 옮겨야 한다. 세 번째: 보안 민감 함수(XSS escaping)이므로 `'`만 보고 나머지 4문자 매핑이 stdlib와 다를까 의심해 손으로 dict를 유지하려는 유혹 — `html.escape(quote=True)` 기본값을 확인하면 동일함이 증명되어 안전하게 위임 가능.
