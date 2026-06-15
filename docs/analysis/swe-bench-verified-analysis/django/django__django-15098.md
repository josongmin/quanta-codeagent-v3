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
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S4)
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

# django__django-15098

## 문제 요약
`i18n_patterns`가 script와 region을 동시에 가진 로케일(예: `en-latn-us`, `en-Latn-US`)을 인식하지 못해 해당 URL prefix가 404를 반환한다. `LANGUAGES`에 등록돼 있어도 RFC 5646 형식의 `lang-script-region` 3-subtag 코드는 URL 경로에서 언어로 매칭되지 않는다. 사용자는 `/en-latn-us/`와 `/en-Latn-US/`가 `en-us`처럼 200을 반환하길 기대했고, problem_statement에 RFC 5646 langtag 문법(`language ["-" script] ["-" region]`)을 그대로 인용했다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 `get_language_from_path` 흐름을 직접 언급하고, hints_text에서 메인테이너가 "정규식 확장 vs settings.LANGUAGES 참조"를 논의한 뒤 채택안이 regex임을 밝힌다. 결함은 모듈 레벨 상수 `language_code_prefix_re` 하나. grep 한 방으로 도달 가능 → L0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S4 보조).** 고칠 지점(`language_code_prefix_re`)은 자명하지만, *올바른 quantifier*를 추론으로 합성해야 한다. `?`(0~1) → `{0,2}`(0~2)가 정답인 이유는 RFC 5646 langtag 깊이(`script` 1개 + `region` 1개 = 추가 subtag 최대 2개)라는 **명세적 불변식**에서 도출되며, 단순히 `*`(무제한)로 넓히면 `/de-simple-page/` 같은 일반 페이지를 언어로 흡수한다. 즉 "체크 추가"가 아니라 엣지케이스 경계를 따져 정확한 상한을 합성하는 S2. 동시에 주어진 FAIL_TO_PASS는 `{0,2}`가 아니라 `{0,3}`·`{0,4}`·`+`로도 통과하므로 픽스가 과소명세돼 있어 S4(CEGIS) 색채가 보조로 깔린다 — overfit/overgeneralize 양쪽 위험.
- **K (Knowledge) = K-Domain.** django i18n의 URL locale prefix 매칭 파이프라인(`LocaleMiddleware` → `get_language_from_path` → `language_code_prefix_re`) 구조 지식과, RFC 5646 langtag 문법 지식이 둘 다 필요. 일반 파이썬 추론만으론 "왜 추가 subtag가 정확히 최대 2개인가"를 정당화 못 한다.
- **primary type = T-ConstraintReason.** 위치는 명확(L0)하나 난점이 "올바른 정규식 quantifier를 명세 불변식으로부터 합성"하는 S2 추론에 있다. T-DirectMap이 아닌 이유: None-guard/상수교체 같은 기계적 템플릿이 아니라, RFC langtag 깊이라는 도메인 명세를 정규식 반복 경계로 번역하는 추론이 본질.

## 난이도 티어
**T3 (중간).** 공식 라벨은 "15 min - 1 hour"(prior로는 T3 근방).
- 미는 피처: 단일 파일·단일 라인(`gold_files` 1개, 패치 1줄)이고 has-repro(완전한 재현 절차 + 기대 동작 명시)라 localize는 trivial → 아래로 당김.
- 위로 당기는 피처: (1) **올바른 상한 `{0,2}` 합성이 비자명** — `*`/`+`로 과확장하면 PASS_TO_PASS의 page-with-dash 계열이 깨지는 regression-trap이 존재. (2) **K-Domain** — RFC 5646 깊이 근거가 없으면 상한을 임의로 고르게 되고 overfit. (3) PASS_TO_PASS 88개로 인접 i18n 동작 표면이 넓다.
- 종합: L0이라 T-DiffuseLoc류 상향은 없지만, S2 추론 + regression-trap + overfit-risk가 T1/T2의 "픽스 자명" 프로파일을 벗어나게 한다. 그래서 T2가 아닌 **T3**. T4까지 가지 않는 이유는 cross-file 조율이 없고 수정 규모가 1줄로 극소이기 때문. 공식 시간라벨과 일치한다.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/translation/trans_real.py` — 모듈 레벨 정규식 상수 `language_code_prefix_re`.
- 근본 원인: 기존 `r'^/(\w+([@-]\w+)?)(/|$)'`의 `([@-]\w+)?`는 `-`(region/variant) 또는 `@`(modifier) 추가 subtag를 **최대 1개**까지만 허용. `en-latn-us`는 `-latn`과 `-us` 두 개의 추가 subtag라 전체 매칭에 실패하고, `get_language_from_path`가 언어 prefix를 추출하지 못해 404로 떨어진다.
- 수정 요지: 반복 한정자를 `?`(0~1) → `{0,2}`(0~2)로 변경해 `([@-]\w+){0,2}`로 만든다. 이로써 `lang` / `lang-region` / `lang-script-region`(3-subtag)까지 매칭된다. 상한을 정확히 2로 둔 것이 핵심 — RFC 5646에서 `script`(1) + `region`(1)이 추가 subtag 최대치이므로, 무제한 `*` 대신 명세 깊이만큼만 보수적으로 확장해 `/de-simple-page/`(추가 subtag 2개 초과 / 페이지 경로)가 언어로 오인되지 않게 한다.

## 검증 (test_patch)
- FAIL_TO_PASS (2개): `test_get_language_from_path_real`, `test_get_supported_language_variant_null` (둘 다 `i18n.tests.MiscTests`).
- 동작: `test_get_language_from_path_real`이 `LANGUAGES`에 `en-latn-us`, `en-Latn-US`, `de-1996`, `de-ch-1901`, `i-mingo`, `kl-tunumiit`, `nan-hani-tw` 등 3-subtag/특수 코드를 추가하고, `trans_real.get_language_from_path`에 다수 경로를 subTest 루프로 단언한다. 예: `g('/en-latn-us/') == 'en-latn-us'`, `g('/de-ch-1901/') == 'de-ch-1901'`, 대소문자 보존 `g('/en-Latn-US/') == 'en-Latn-US'`. 픽스 전엔 이들이 모두 `None`이라 RED.
- 픽스 증명: `{0,2}` 적용 시 3-subtag가 추출돼 GREEN. 동시에 **과확장 음성 케이스** `g('/de-simple-page-test/') is None`을 단언해 상한이 페이지 경로를 언어로 흡수하지 않음을 검증. 기존 `/de-simple-page/`(추가 subtag 2개라 `{0,2}`로 잡힘)는 테스트가 `/de-simple-page-test/`(3개)로 교체했고 `test_page_with_dash`도 같은 경로로 동기화 — 이게 regression 경계를 명시적으로 못박는 paired-control.
- overfit·regression 관점: FAIL_TO_PASS는 `{0,2}`를 **과소명세**한다 — 테스트에 등장하는 최장 코드가 3-subtag뿐이라 `{0,3}`/`{0,4}`/`+`로도 통과한다(S4 위험). 다만 `/de-simple-page-test/ → None` 음성 케이스가 `+`/`{0,3}+`의 과확장을 일부 차단하는 약한 CEGIS 반례 역할을 한다. regression-trap은 PASS_TO_PASS 88개 중 `test_page_with_dash`, `test_other_lang_with_prefix`, `test_get_supported_language_variant_real` 등 i18n URL 매칭 계열 — 상한을 너무 크게 잡으면 이들이 깨진다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 증상이 "404"라 URL resolver/middleware를 먼저 의심하기 쉽지만, problem_statement가 `get_language_from_path`를 직접 거명하고 hints가 regex 채택을 확정한다. 추적: `i18n_patterns` 404 → `LocaleMiddleware` → `get_language_from_path` → 모듈 상수 `language_code_prefix_re`. `trans_real.py`에서 이 정규식 한 줄에 도달하면 끝(L0).
2. **픽스와 올바른 일반화:** `([@-]\w+)?`의 한정자 `?`를 `{0,2}`로 바꾼다. *왜 `{0,2}`가 올바른 일반화인가* — RFC 5646 langtag는 `language ["-" script] ["-" region]`로, language 본체 뒤에 추가될 수 있는 subtag(script + region)가 정확히 최대 2개다. 따라서 `{0,2}`는 테스트 케이스에 끼워 맞춘 매직넘버가 아니라 명세에서 도출된 상한 → overfit이 아닌 올바른 일반화. `*`/`+`(무제한)는 명세를 넘어 임의 dash 경로까지 흡수하므로 과일반화다.
3. **regression 안전:** PASS_TO_PASS 88개 중 i18n URL 매칭 계열(`test_page_with_dash`, `test_other_lang_with_prefix`, `test_unprefixed_language_other_than_accept_language`, `test_get_supported_language_variant_real`)을 안 깨야 한다. 핵심은 "페이지 경로를 언어로 오인 금지" — `{0,2}` 상한이 추가 subtag 3개 이상 경로(`/de-simple-page-test/`)를 배제하므로 안전. 대소문자 보존(`en-Latn-US`)은 정규식이 `\w+`로 케이스 무관 캡처하고 하류 매칭이 보존하므로 자동 통과, 별도 처리 불필요.
4. **함정 회피:** 오라클 없는 에이전트의 3대 오답 — (a) hints의 "settings.LANGUAGES를 참조하라" 대안을 따라 `get_language_from_path` 내부 로직을 재작성(채택안은 regex라 over-engineering). (b) 한정자를 `*`/`+`로 무한 확장해 `/de-simple-page/`류를 흡수, page-with-dash 테스트 회귀. (c) 404 증상에 낚여 URL resolver/middleware를 수정(엉뚱한 파일). 회피법: 명세(RFC langtag 최대 깊이 2)에서 상한을 도출하고, 음성 케이스(`/de-...-.../ → None`)를 스스로 추가해 과확장을 self-check.
