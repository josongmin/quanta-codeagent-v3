---
instance_id: sphinx-doc__sphinx-9698
repo: sphinx-doc/sphinx
base_commit: f050a7775dfc9000f55d023d36d925a8d02ccfa8
version: "4.3"
difficulty: "<15 min fix"
created_at: 2021-10-03T04:04:04Z
fail_to_pass: 1
pass_to_pass: 45
gold_files: [sphinx/domains/python.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`py:method` 디렉티브에 `:property:` 옵션을 주면 인덱스 항목이 `meth5() (Class property)`처럼 괄호(`()`)를 달고 등록된다. property는 호출 가능한 메서드가 아니라 속성이므로 괄호가 없어야 한다(`py:property` 디렉티브로 직접 정의한 경우와 일관되게). 이슈에 재현 rst와 기대 동작이 명시되어 있다.

## 유형 (정형화)
- **L0 (Localization)**: 이슈가 `py:method` + `:property:` 인덱스 항목을 직접 지목. `sphinx/domains/python.py`의 `PyMethod.get_index_text`에서 `'property' in self.options` 분기 한 줄이 유일 후보. grep 한 방.
- **S1 (Repair)**: 픽스가 사실상 명세됨 — "괄호를 빼라". 포맷 문자열 `'%s() (%s property)'` → `'%s (%s property)'`로 `()` 두 글자만 삭제. 추론 합성 없는 기계적 문자열 수정. 같은 파일 `PyProperty.get_index_text`가 이미 `'%s (%s property)'`(괄호 없음)를 반환하므로 정답 포맷이 코드 안에 레퍼런스로 존재.
- **K-Domain**: 일반 파이썬 추론으로는 "괄호 제거가 맞다"를 확신하기 어렵고, sphinx 인덱스 컨벤션(property=속성이라 괄호 없음, method=호출가능이라 괄호 있음)을 알아야 분기 4개 중 property만 고친다는 결정을 내릴 수 있다.
- **primary = T-DirectMap**: 위치 명확(L0) + 기계적 픽스(S1). 이슈가 결함 클래스(잘못된 포맷 상수)와 수정 방향을 모두 적어주는 전형적 direct-map.
- APR 관점: 정답 포맷이 동일 모듈의 sibling 클래스에 이미 존재 → 후보 생성이 거의 결정적. SemFix류 제약 합성이 아니라 PAR/TBar식 템플릿(상수/포맷 교정) 매칭에 해당해 S1.

## 난이도 티어
- **T2 (쉬움)**: 1파일·1줄 변경(`()` 삭제), has-repro(재현 rst + 스크린샷 + 기대동작 명시). 공식 라벨도 `<15 min fix`로 일치.
- 구조적 피처: 파일 1개, 변경 줄 1줄, localize 직접성 최상(L0), 도메인 지식은 가볍게 필요(K-Domain이라 순수 T1은 아님). property/method/classmethod/staticmethod 4분기 중 property 분기만 골라야 한다는 점에서 "픽스가 거의 적혀 있는" T1보다 미세한 분기 식별이 들어가 T2.
- **P2P trap**: PASS_TO_PASS 46개 중 `test_pyproperty`, `test_pyclassmethod`, `test_pystaticmethod`, `test_pyattribute` 등 형제 분기 테스트가 다수 → property 분기만 건드리고 나머지 method/classmethod/staticmethod 포맷은 보존해야 함. 그래서 `regression-trap` 플래그. 다만 정답이 1분기 고립 수정이라 실제 회귀 위험은 낮음.

## 골드패치 분석
- 파일/함수: `sphinx/domains/python.py` — `PyMethod.get_index_text`.
- 근본원인: property는 `py:method :property:`로도, `py:property`로도 인덱스에 등록되는데, 전자(`PyMethod`) 경로의 포맷 문자열이 메서드용 `'%s() (%s property)'`를 그대로 써서 괄호가 남았다. 후자(`PyProperty.get_index_text`)는 이미 `'%s (%s property)'`로 괄호가 없어 두 경로가 불일치(inconsistency)했다.
- 수정요지: `elif 'property' in self.options:` 분기의 반환 포맷을 `_('%s() (%s property)')`에서 `_('%s (%s property)')`로 변경. classmethod/staticmethod/method 분기는 호출가능 객체라 `()`를 유지. 결과적으로 두 등록 경로가 동일 인덱스 텍스트를 산출하게 정합화.

## 검증 (test_patch)
- FAIL_TO_PASS: `tests/test_domain_py.py::test_pymethod_options`. `:property:` 옵션 메서드의 인덱스 엔트리 기대값을 `'meth5() (Class property)'` → `'meth5 (Class property)'`로 바꿔, 괄호가 제거되는지 검증한다(`doctree[1][1][8]`의 `addnodes.index` entries 단언).
- 픽스 증명: 포맷에서 `()`를 빼는 정확한 변경이 없으면 단언이 실패 → 픽스와 테스트가 1:1 대응.
- overfit 관점: FAIL_TO_PASS 1개로 얇지만, 변경이 포맷 상수 한 곳이라 special-case 회피 여지가 없어 overfit 위험은 실질적으로 없음(괄호를 빼는 일반화가 곧 정답). 단, 테스트는 property 분기만 검증하므로 다른 분기를 망가뜨리는 오교정은 P2P가 잡아야 함.
- regression 관점: `test_pyproperty`(이미 괄호 없음 기대)와 method/classmethod/staticmethod 테스트들이 P2P로 모두 통과해야 해, property 외 분기 보존을 보증.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 키워드 "index entry / parens / py:method / :property:" → `sphinx/domains/python.py`에서 인덱스 텍스트 생성 지점 검색 → `PyMethod.get_index_text`의 옵션별 4분기. `'property' in self.options` 분기가 유일 타겟.
2. **픽스**: 해당 분기 포맷 `'%s() (%s property)'` → `'%s (%s property)'`. 올바른 일반화인 이유 — 동일 파일 `PyProperty.get_index_text`가 이미 괄호 없는 동형 포맷을 사용하므로, 두 등록 경로를 동일 컨벤션으로 수렴시키는 것이 임의 패치가 아니라 기존 불변식(property=괄호 없음) 복원이다.
3. **regression 안전**: classmethod/staticmethod/method 분기의 `()`는 그대로 둬야 함(이들은 호출가능). `test_pyclassmethod`/`test_pystaticmethod`/`test_pyattribute`/`test_pyproperty` 등 P2P를 깨지 않는 것이 형제 분기 보존의 증거.
4. **함정 회피**: (a) `get_signature_prefix`의 `prefix.append(nodes.Text('property'))`(시그니처 표시용)를 인덱스 버그로 오인해 고치지 말 것 — 버그는 `get_index_text`의 포맷에만 있음. (b) 4분기 전부에서 `()`를 빼면 method/classmethod/staticmethod 인덱스가 깨져 P2P 회귀. property 분기 1개만 고립 수정해야 한다.
