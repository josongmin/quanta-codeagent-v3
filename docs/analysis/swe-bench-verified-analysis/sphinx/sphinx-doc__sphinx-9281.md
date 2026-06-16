---
instance_id: sphinx-doc__sphinx-9281
repo: sphinx-doc/sphinx
base_commit: 8ec06e9a1bd862cd713b9db748e039ccc7b3e15b
version: "4.1"
difficulty: "<15 min fix"
created_at: 2021-05-29T17:16:30Z
fail_to_pass: 1
pass_to_pass: 38
gold_files: [sphinx/util/inspect.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
autodoc이 함수 시그니처의 기본값으로 `enum.Enum` 멤버를 렌더링할 때 `<MyEnum.ValueA: 10>` 처럼 꺾쇠와 내부값이 그대로 노출되어 보기 흉하다. 원인은 sphinx가 기본값을 `repr()`로 문자열화하는데, Python의 `Enum.__repr__`가 `repr()`의 "eval하면 값이 복원되는 문자열" 관례를 지키지 않기 때문이다. 기대 출력은 `MyEnum.ValueA`. 이슈는 "autodoc에서 Enum을 special-case 처리하라"고 직접 처방한다.

## 유형 (정형화)
- **L (Localization) = L1.** 이슈가 파일명을 직접 주진 않지만 "default value를 repr로 만든다"는 메커니즘 서술이 강한 포인터다. `repr()` 기반 기본값 문자열화 책임지점은 `sphinx/util/inspect.py`의 `object_description()` 한 곳으로 짧은 탐색에 수렴한다(dict/set/frozenset special-case가 이미 줄지어 있어 패턴이 자명).
- **S (Strategy) = S1 (+S5).** 결함클래스가 "정형: 특정 타입에 대한 special-case 분기 추가"라 기계적 템플릿 매칭이다(기존 set/frozenset 분기를 그대로 복제). 다만 "무엇을 출력해야 올바른가"(`ClassName.member` 형태)는 코드만으론 안 나오고 이슈 본문의 expected 출력에서 스펙을 재구성해야 하므로 S5가 보조로 붙는다.
- **K (Knowledge) = K-Domain.** Python `enum` 의미론(멤버는 `.name`/`.__class__.__name__`를 가지며 `repr`이 비관례적이라는 점)과 sphinx autodoc이 기본값을 `object_description`으로 직렬화한다는 프레임워크 내부지식이 필요하다.
- **primary = T-DirectMap.** 위치는 좁게 수렴하고, 픽스는 "기존 분기 옆에 isinstance 분기 한 개 추가"라는 기계적 직접매핑이다. 추론 합성(S2)이나 후보탐색(S3)이 본질이 아니다.

## 난이도 티어
**T2 (쉬움).** 구조 피처: 1파일·실질 추가 3줄(+`if`→`elif` 변환 4줄)·단일 함수·has-repro(최소 재현 레포 + 명확한 expected/actual). localize는 "repr로 기본값 만든다"는 단서로 거의 직행. 다만 T1이 아닌 이유: (1) 픽스가 이슈에 글자그대로 적혀있진 않아 expected 출력에서 형태를 추론(S5)해야 하고, (2) Enum 의미론이라는 도메인 지식이 가볍게 요구되며, (3) 분기 순서/위치가 fall-through 버그를 만들 수 있는 regression-trap이 있다. 공식 라벨 "<15 min fix"와 일치한다(개발자 구현시간 기준 사소).

## 골드패치 분석
- **파일·함수:** `sphinx/util/inspect.py`의 `object_description(object)`.
- **근본원인:** `object_description`은 dict/set/frozenset만 special-case하고 나머지는 전부 `repr(object)` fallback으로 보낸다. `Enum` 멤버는 그 fallback에 떨어져 `<MyEnum.ValueA: 10>`이 그대로 나온다(memory-address 정규화 정도만 거침).
- **수정요지:** (1) 기존 `set`/`frozenset` 분기의 선행 `if`들을 `elif`로 묶어 상호배타 체인으로 정리하고, (2) 그 체인에 `elif isinstance(object, enum.Enum): return "%s.%s" % (object.__class__.__name__, object.name)` 분기를 fallback `repr` 직전에 추가한다. 즉 Enum이면 클래스명+멤버명만으로 깔끔히 직렬화한다.

## 검증 (test_patch)
- **FAIL_TO_PASS:** `tests/test_util_inspect.py::test_object_description_enum` — 로컬 `MyEnum(FOO=1, BAR=2)`를 정의하고 `inspect.object_description(MyEnum.FOO) == "MyEnum.FOO"`를 단언. 픽스 전엔 `<MyEnum.FOO: 1>`라 실패, 후엔 새 `elif enum.Enum` 분기가 `"MyEnum.FOO"`를 반환해 통과한다.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇지만, 픽스가 `.__class__.__name__`/`.name`을 쓰는 일반식이라 특정 멤버에 special-case하지 않는다 — 모든 Enum 멤버에 일반화된다. CEGIS 우회 여지가 낮다.
- **regression 관점:** 38개 PASS_TO_PASS 중 `test_dictionary_sorting`, `test_set_sorting(_fallback)`, `test_frozenset_sorting(_fallback)`, `test_dict_customtype`가 핵심 — `if`→`elif` 전환과 새 분기가 기존 dict/set/frozenset 경로를 깨지 않아야 함을 보증한다. 새 분기는 fallback `repr` 앞에 놓여 일반 객체 경로도 보존된다.

## 모범답안 (오라클 기반)
1. **localize:** 이슈의 "default value를 repr로 만든다 + Enum repr이 관례 위반"이라는 메커니즘 서술 → autodoc이 기본값을 직렬화하는 단일 책임지점 `sphinx/util/inspect.py::object_description`를 grep("repr", "object_description")로 찾는다. dict/set/frozenset special-case가 이미 줄지어 있어 "여기에 한 줄 더"가 자명해진다.
2. **픽스와 일반화 근거:** `elif isinstance(object, enum.Enum): return "%s.%s" % (object.__class__.__name__, object.name)`. `.__class__.__name__`+`.name`을 쓰므로 임의 Enum 멤버에 보편적으로 동작(특정 값 하드코딩 아님) — 이슈 expected `MyEnum.ValueA`의 일반형이라 overfit이 아니다.
3. **regression 안전:** dict/set/frozenset 분기와 일반 `repr` fallback을 모두 보존해야 한다. 새 분기를 fallback **앞**에 두고, 선행 분기들을 `elif` 체인으로 묶어 한 객체가 두 분기에 걸리지 않게 한다(set 정렬 실패 fallback 경로도 그대로 유지).
4. **함정 회피:** (a) `if`/`elif` 혼용 함정 — set/frozenset 정렬이 `TypeError`로 `pass`된 뒤 아래 독립 `if`로 흘러가는 기존 구조에 새 `if`를 무신경하게 추가하면 의도치 않은 중복평가가 생긴다. 골드패치는 일부러 `if`→`elif`로 정리한다. (b) 출력 형태 함정 — `str(object)`(`MyEnum.FOO` 같지만 버전의존)나 `repr` 후처리로 꺾쇠만 벗기는 미봉책은 깨지기 쉽다. `__class__.__name__`+`.name` 조합이 버전 무관 정답이다. (c) Enum이 set·dict와 함께 sortable이라 set 분기에 잘못 흡수될 수 있으니 분기 순서·배타성을 확인해야 한다.
