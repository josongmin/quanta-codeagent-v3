---
instance_id: django__django-15103
repo: django/django
base_commit: dd528cb2cefc0db8b91a7ff0a2bc87305b976597
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-11-19T15:57:54Z
fail_to_pass: 2
pass_to_pass: 17
gold_files: [django/template/defaultfilters.py, django/utils/html.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L3
repair_strategy: S1 (+S6)
knowledge: K-API
flags: [regression-trap, cross-file-dep]
---

# django__django-15103

## 문제 요약
`json_script`는 값을 JSON 인코딩해서 `<script type="application/json">` 태그로 감싸주는 유틸 함수(`django/utils/html.py`)이자, 이를 노출하는 템플릿 필터(`django/template/defaultfilters.py`)다. 현재 `element_id` 인자가 위치 필수 인자라서 id가 필요 없는 use-case(예: `<template>` 안에 `<script>`를 넣어 id로 참조할 필요가 없을 때)에서 쓸 수 없다. 이슈는 "보안상으로도 다른 이유로도 id가 필수일 근거가 없고, optional로 만들어도 기존 테스트를 깨지 않더라"며 `element_id`를 optional로 완화해 달라는 enhancement 요청이다.

## 유형 (정형화)
- **L = L3 (Multi-site)** — 동일 이름 함수가 `utils/html.py`의 실구현과 `defaultfilters.py`의 필터 래퍼 **두 곳에 동시 존재**하고, FAIL_TO_PASS가 양쪽을 각각 검증하므로 두 시그니처가 **함께** 바뀌어야 한다. 각 지점 자체는 pinpoint(L0급)지만 조율된 멀티사이트라는 점이 지배적이라 L3. (단순 grep으로 위치 자체는 즉시 확정되므로 L2의 "후보 다수/탐색 부담"과는 다르다.)
- **S = S1 (+S6)** — 이슈가 사실상 픽스를 명세한다("element_id를 optional로"). 기본 메커니즘은 기본값 부여(`element_id=None`)라는 정형 결함클래스(기본값 추가)에 템플릿 매칭되는 기계적 픽스라 dominant는 S1. 다만 `utils/html.py` 본문에서 단일 `format_html(...)` 호출을 `if element_id:` 분기로 갈라 template/args를 모으는 collect-then-format 형태의 소규모 구조 변경이 따라붙어 보조로 S6.
- **K = K-API (API-contract)** — 핵심은 공개 API의 호출 계약을 하위호환적으로 완화하는 것이다. 기존 id-있는 호출자가 깨지지 않게 인자 순서/출력 포맷을 보존해야 하므로 일반 추론(K-Gen)이 아니라 공개 시그니처 계약 정합성이 병목이다. django 내부 도메인지식(ORM/query-compiler 등)은 불필요해 K-Domain은 아니다.
- **primary type = T-DirectMap** — 위치가 명확(L3지만 각 site는 자명)하고 픽스가 "기본값 부여 + id 유무 분기"라는 기계적 매핑이다. 진짜 어려움이 localize에 있는 것도(T-DiffuseLoc 아님), 식·조건을 추론으로 합성해야 하는 것도(T-ConstraintReason 아님), 스펙을 재구성해야 하는 것도(T-SpecInference 아님) 아니다. 이슈→픽스 매핑이 거의 직결이라 T-DirectMap.
- **왜 이 strategy인가 (APR 관점)** — 이슈 본문이 의도된 동작("id 없이도 렌더")과 픽스 방향("optional로")을 명시하므로, generate-&-validate 식 다중 후보 탐색(S3)이나 테스트 너머 일반화(S4)가 필요 없다. PAR/TBar식 결함 템플릿("required param → default param + presence guard")에 바로 들어맞는 S1이 정답이고, 본문 분기는 부수적 S6 마이크로리팩터다.

## 난이도 티어
**T2 (쉬움).** 공식 difficulty 라벨은 "15 min - 1 hour"(개발자 구현시간 기준)인데, 이는 PR 작성·문서·테스트까지 포함한 시간이라 에이전트 난이도와 다소 어긋난다. 구조적 피처로 재조정하면:
- **티어를 낮추는 요인**: 2파일·총 ~12줄 변경, localize 직접성 최상(이슈가 `json_script`/`element_id`를 그대로 거명), 픽스가 S1 기계적, 도메인지식 불필요(K-API라도 계약이 단순). 1파일·<5줄급은 아니지만 멀티사이트가 둘 다 자명해 사실상 T1에 가깝다.
- **T1로 떨어뜨리지 않고 T2에 두는 이유**: (1) has-repro가 아니다 — 네이티브 스택트레이스가 없는 enhancement형 이슈라 "재현코드 존재"의 강한 easiness 신호가 빠진다. (2) **cross-file-dep / L3 조율** — 동일 함수가 두 곳에 있다는 사실을 모르면 한 곳만 고치고 FAIL_TO_PASS 한 건을 놓친다. (3) **regression-trap** — PASS_TO_PASS 17건 중 `test_json_script`(id 있는 기존 케이스)가 있어, 분기·인자 순서·출력 포맷을 보존하지 못하면 회귀한다.
- 다만 이 trap들은 모두 얕고 정형적이라 T4(constraint추론/도메인지식/넓은 P2P)나 T5(멀티헌크 overfit 고위험)로 올릴 근거는 없다. → **T2 확정.**

## 골드패치 분석
- **건드린 파일·함수**:
  - `django/utils/html.py : json_script(value, element_id)` — 실구현.
  - `django/template/defaultfilters.py : json_script(value, element_id)` — `@register.filter(is_safe=True)`로 등록된 필터 래퍼(내부에서 `_json_script`로 위임).
- **근본 원인**: 두 정의 모두 `element_id`가 **위치 필수 인자**였고, `utils/html.py` 본문이 `format_html('<script id="{}" type="application/json">{}</script>', element_id, mark_safe(json_str))`처럼 id를 항상 출력 포맷에 박아 넣어 id 생략을 구조적으로 불가능하게 했다.
- **수정 요지**:
  - `utils/html.py`: 시그니처를 `element_id=None`으로 변경. 본문을 분기 — `if element_id:`면 기존 `'<script id="{}" type="application/json">{}</script>'` 템플릿에 `args=(element_id, mark_safe(json_str))`, 아니면 id 없는 `'<script type="application/json">{}</script>'` 템플릿에 `args=(mark_safe(json_str),)`. 마지막에 `return format_html(template, *args)`로 단일화.
  - `defaultfilters.py`: 필터 래퍼 시그니처도 `element_id=None`으로 맞추고, docstring을 "tag (with an optional id)."로 갱신. 위임 로직(`_json_script(value, element_id)`)은 불변.

## 검증 (test_patch)
- **FAIL_TO_PASS (2건, JSON 배열 길이와 일치)**:
  - `test_json_script_without_id` (utils_tests.test_html.TestUtilsHtml): `json_script({'key': 'value'})`를 id 인자 없이 호출해 `<script type="application/json">{"key": "value"}</script>`가 나오는지 `assertHTMLEqual`로 확인 → 실구현 시그니처 완화를 증명.
  - `test_without_id` (template_tests.filter_tests.test_json_script.JsonScriptTests): 템플릿 `{{ value|json_script }}`(필터 인자 없이)를 렌더해 `<script type="application/json">{}</script>`를 확인 → 필터 래퍼 시그니처 완화를 증명.
- **픽스 증명 논리**: 픽스 전에는 id 없는 호출이 `TypeError`(필수 인자 누락)로 실패한다. 픽스 후 (1) 호출이 예외 없이 동작하고 (2) 출력 태그에서 `id` 속성이 사라진 형태가 나와야 통과한다. 두 테스트가 각각 실구현과 필터 래퍼를 짚으므로 L3 멀티사이트 양쪽을 강제한다.
- **overfit 관점**: FAIL_TO_PASS가 2건뿐이고 id-있는 출력 경로는 새 테스트로 직접 재검증하지 않으므로(기존 `test_json_script`에 의존), 누군가 분기 없이 `id=""`를 그냥 포맷해도 새 테스트 2건은 통과시킬 수 있는 약간의 overfit 여지가 있다. 단 그 경우 PASS_TO_PASS `test_json_script`가 깨지므로 전체 그린은 불가 — 테스트 스위트 결합이 overfit을 차단한다(overfit-risk 플래그를 달지 않은 이유).
- **regression 관점**: PASS_TO_PASS 17건, 특히 `test_json_script`(id 있는 기존 동작)가 가드. 분기 안에서 기존 템플릿 문자열·인자 순서를 바이트 동일하게 보존했는지가 회귀 안전의 핵심 → regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `json_script`(함수)와 `element_id`(인자)를 직접 거명 → `grep -rn "def json_script" django/`로 두 정의를 즉시 확보한다. 결정적으로 **두 곳 모두**가 grep 결과에 뜬다는 점을 인지해야 한다: `utils/html.py`의 실구현과 `defaultfilters.py`의 필터 래퍼. FAIL_TO_PASS가 utils와 template 양쪽 테스트로 나뉘는 것도 두 site를 동시에 고치라는 신호.
2. **픽스와 올바른 일반화 이유**: 두 시그니처를 `element_id=None`으로 바꾼 뒤, `utils/html.py` 본문에서 `if element_id:`로 분기해 id-있는 템플릿/id-없는 템플릿을 각각 `format_html`로 렌더한다. 이게 올바른 일반화인 이유 — (a) 기본값을 빈 문자열이 아닌 `None`으로 두고 truthiness 분기를 써서, id 미지정과 "빈 id" 둘 다 id 없는 출력으로 자연 수렴(빈 문자열 falsy)하면서 (b) id 있는 호출의 출력은 한 글자도 바뀌지 않는다. 즉 새 동작을 추가하되 기존 계약을 정확히 보존하는 하위호환 확장(K-API).
3. **regression 안전**: PASS_TO_PASS `test_json_script`(id 인자 있는 기존 케이스)와 `test_basic`(필터 id 케이스)을 깨면 안 된다. 따라서 `if` 분기의 참(true) 브랜치는 원래 템플릿 문자열 `'<script id="{}" type="application/json">{}</script>'`와 인자 순서 `(element_id, mark_safe(json_str))`를 **그대로** 재사용해야 한다. `format_html(template, *args)` 단일화는 두 경로의 escape 동작(`format_html`의 HTML-safe 처리)을 동일하게 유지하므로 안전하다.
4. **함정 회피 (오라클 없는 에이전트가 틀릴 지점)**:
   - **단일파일 패치로 종료**: `utils/html.py`만 고치고 끝내면 `defaultfilters.py` 필터 래퍼가 여전히 `element_id` 필수라 `test_without_id`(template)가 깨진다. L3임을 놓치는 게 가장 흔한 실패.
   - **빈 문자열 직삽**: `element_id=''` 기본값에 분기 없이 그대로 포맷하면 `<script id="" ...>`가 남아 기대 출력(`id` 속성 부재)과 불일치 → 분기(`if element_id:`)가 필수.
   - **출력 포맷 임의 변경**: id-있는 경로의 속성 순서나 공백을 손대면 `test_json_script` 회귀. 기존 문자열을 건드리지 말 것.
   - **docstring 누락**: 기능엔 무해하나 골드패치는 필터 docstring을 "(with an optional id)"로 갱신 — 동작 동등성엔 영향 없으므로 테스트 통과엔 무관(여기서 틀려도 그린).
