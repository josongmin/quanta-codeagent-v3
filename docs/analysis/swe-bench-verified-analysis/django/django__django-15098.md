---
instance_id: django__django-15098
repo: django/django
base_commit: 2c7846d992ca512d36a73f518205015c88ed088c
version: "4.1"
difficulty: 15 min - 1 hour
created_at: 2021-11-17T21:30:07Z
fail_to_pass: 2
pass_to_pass: 88
gold_files: [django/utils/translation/trans_real.py]
---

# django__django-15098

## 문제 요약
`i18n_patterns`가 script와 region을 동시에 가진 로케일(예: `en-latn-us`, `en-Latn-US`)을 인식하지 못해, 해당 URL prefix가 404를 반환한다. `LANGUAGES`에 등록돼 있어도 RFC 5646 형식의 `lang-script-region` 3-subtag 코드는 URL 경로에서 언어로 매칭되지 않는다. 사용자는 `/en-latn-us/`나 `/en-Latn-US/`가 `en-us`처럼 200을 반환하기를 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (정규식이 2-subtag까지만 커버)
- 서브시스템: django i18n / URL locale prefix 매칭 (`django.utils.translation.trans_real`)
- 증상 타입: 잘못된 출력 (유효한 로케일 URL이 매칭 실패 → 404)
- 로컬라이제이션 신호: problem_statement가 RFC 5646 langtag 문법(`language ["-" script] ["-" region]`)을 명시하고 `get_language_from_path` 흐름을 직접 언급. hints_text에서 메인테이너가 "정규식 확장 vs settings.LANGUAGES 참조"를 논의하고 결국 PR이 regex 방식임을 밝혀, `language_code_prefix_re` 정규식이 핵심임을 강하게 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/translation/trans_real.py` — 모듈 레벨 `language_code_prefix_re` 정규식 상수
- 근본 원인: 기존 정규식 `r'^/(\w+([@-]\w+)?)(/|$)'`의 `([@-]\w+)?`는 추가 subtag(`-region` 또는 `@modifier`)를 **최대 1개**까지만 허용. 따라서 `en-latn-us`처럼 `-latn`과 `-us` 두 개의 추가 subtag가 붙으면 전체 매칭에 실패하고, `get_language_from_path`가 언어를 추출하지 못한다.
- 수정 요지: 반복 횟수를 `?`(0~1회)에서 `{0,2}`(0~2회)로 변경해 `([@-]\w+){0,2}`로 만든다. 이로써 `lang`, `lang-region`, `lang-script-region`(3-subtag)까지 매칭. 상한을 2로 둬서 `/de-simple-page/`(3개 이상 segment) 같은 일반 페이지 경로가 언어로 오인되는 것을 방지 — 즉 무제한 `*` 대신 RFC 5646의 최대 깊이만큼만 확장한 보수적 수정.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_get_language_from_path_real`, `test_get_supported_language_variant_null` (i18n.tests.MiscTests)
- `test_get_language_from_path_real`은 `LANGUAGES`에 `en-latn-us`, `en-Latn-US`, `de-ch-1901`, `nan-hani-tw` 등 3-subtag 코드를 추가하고, `trans_real.get_language_from_path`에 다양한 경로를 넣어 기대 언어를 단언한다. 예: `g('/en-latn-us/') == 'en-latn-us'`, `g('/de-ch-1901/') == 'de-ch-1901'`, 대소문자 보존 `g('/en-Latn-US/') == 'en-Latn-US'`. 동시에 너무 넓게 잡지 않는지 검증 — `g('/de-simple-page-test/') is None`.
- 기존 `/de-simple-page/`(2-subtag라 정규식이 잡아버림)는 테스트가 `/de-simple-page-test/`(3-subtag)로 바꿔, `{0,2}` 상한이 page 경로를 언어로 오인하지 않음을 증명. `test_page_with_dash`도 같은 경로로 갱신.

## 공략 포인트 (뭘 조져야)
- localization 전략: `i18n_patterns` 매칭 실패 → URL prefix를 언어로 변환하는 지점은 `get_language_from_path`이고, 그 핵심은 모듈 상수 `language_code_prefix_re`. `trans_real.py`에서 이 정규식 하나만 보면 된다. 단일 파일·단일 라인 수정.
- 함정/난이도: (1) 정규식을 `*`로 무한 확장하면 `/de-simple-page/` 같은 일반 경로까지 언어로 흡수해 PASS_TO_PASS의 page-with-dash 류 테스트가 깨진다 — RFC 5646 최대 깊이(`{0,2}`)로 제한하는 게 정답. (2) hints가 "settings.LANGUAGES를 참조하라"는 대안 방향을 제시하지만 실제 채택안은 regex라, 잘못된 방향(get_language_from_path 내부 로직 재작성)으로 빠지기 쉽다. (3) 대소문자 보존(`en-Latn-US`)은 `get_supported_language_variant`/매칭 흐름이 이미 처리하므로 정규식만 고치면 자동 통과.
- 우리 에이전트 관점: 증상이 "404"라 URL resolver/middleware를 먼저 뒤질 위험. 실제 결함은 i18n 정규식 한 줄이므로, 404→`LocaleMiddleware`→`get_language_from_path`→`language_code_prefix_re`로 좁히는 추적이 핵심. `?`를 `{0,2}`로 바꾸되 `*`로 과확장하지 않는 절제가 난이도 포인트.
