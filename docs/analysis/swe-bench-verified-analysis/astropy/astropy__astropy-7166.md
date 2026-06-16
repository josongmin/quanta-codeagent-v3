---
instance_id: astropy__astropy-7166
repo: astropy/astropy
base_commit: 26d147868f8a891a6009a25cd6a8576d2e1bd747
version: "1.3"
difficulty: "<15 min fix"
created_at: 2018-02-07T15:05:31Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [astropy/utils/misc.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
`InheritDocstrings` 메타클래스가 property에 대해서는 docstring 상속을 못 한다. 원인은 메타클래스 내부에서 멤버를 거를 때 `inspect.isfunction(val)`만 쓰는데, property는 함수가 아니라 데이터 디스크립터라서 `isfunction`이 `False`를 반환하기 때문이다. 이슈 본문과 힌트가 곧장 `inspect.isdatadescriptor`를 대안으로 지목한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 클래스명(`InheritDocstrings`)·함수(`inspect.isfunction`)·증상(property 미동작)을 직접 지목. `grep InheritDocstrings`/`grep isfunction` 한 방이면 `astropy/utils/misc.py`의 `__init__` 루프로 즉시 수렴. localize 노력 사실상 0.
- **S1 (+S2)**: 힌트가 `inspect.isdatadescriptor`를 이미 명시 → 사실상 픽스를 명세하는 Direct-Map. 다만 단순 치환이 아니라 기존 함수 케이스를 보존하면서 OR로 확장해야 하므로(`isfunction(val) or isdatadescriptor(val)`) "property를 포함하되 기존 method 동작을 안 깨는 조건식"을 합성하는 약한 constraint-reasoning(S2)이 보조로 들어간다.
- **K-Domain**: 파이썬 데이터모델 지식(property = data descriptor, `isfunction`이 descriptor에 False)이 핵심. 일반 코드 추론보다 `inspect` 내부 분류 체계를 알아야 정확한 술어를 고른다.
- **primary type = T-DirectMap**: 위치가 명확하고 픽스가 "조건식에 술어 하나 추가"라는 기계적 형태. 이슈가 술어 이름까지 적어줘 템플릿 매칭에 가깝다.
- **왜 S1인가 (APR 관점)**: PAR/TBar류 fix-template("타입체크 술어 확장")에 그대로 매핑. 후보 패치를 여러 개 만들어 테스트로 거를 필요(S3/S4)가 없고, 의도된 스펙을 코드에서 역추론할 필요(S5)도 없다 — 이슈가 의도와 술어를 다 줬다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`misc.py`) 단일 함수, 실질 변경 3줄(조건문 1개), cross-file 의존 없음. localize 직접성 최상(L0), 이슈에 재현 시나리오와 픽스 방향이 모두 있음(has-repro). P2P trap 약함 — PASS_TO_PASS 6개가 `test_isiterable`/`test_JsonCustomEncoder` 등 `misc.py`의 무관한 유틸이라 인접 회귀 위험이 거의 없다. 공식 라벨 `<15 min fix`(=T1 prior)와 비교하면 한 단계 올려 T2로 둔다: property가 data descriptor라는 파이썬 데이터모델 지식(K-Domain)이 술어 선택에 개입하고, "치환이 아닌 OR 확장으로 기존 method 동작 보존"이라는 약한 추론이 붙어 순수 T1(이슈가 픽스를 그대로 적어줌)보다는 살짝 위다.

## 골드패치 분석
- **건드린 파일·함수**: `astropy/utils/misc.py`의 `InheritDocstrings.__init__` 내부 `is_public_member` 루프(나머지 변경은 파일 상단 빈 줄/import 정리 cosmetic).
- **근본원인**: docstring 상속 대상을 고르는 가드가 `inspect.isfunction(val)`뿐. property 객체는 함수가 아니라 data descriptor이므로 `isfunction`이 `False` → property는 루프 본문(`cls.__mro__[1:]`를 타고 super의 docstring을 끌어오는 부분)에 절대 진입하지 못한다.
- **수정요지**: 조건을 `(inspect.isfunction(val) or inspect.isdatadescriptor(val))`로 확장. property(및 다른 data descriptor)도 `__doc__ is None`이고 public이면 super 멤버의 docstring을 상속받게 된다. method 경로는 `isfunction` 가지로 그대로 유지되어 동작 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_inherit_docstrings` 하나. 테스트가 `Base`에 docstring `"BAR"`를 단 `@property bar`를, `Subclass`에서 docstring 없이 재정의(`return 42`)한 뒤 `Subclass.bar.__doc__ == "BAR"`를 단언한다. 픽스 전엔 `isfunction(property)`가 False라 상속이 안 일어나 `None` → 실패. 픽스 후 `isdatadescriptor`가 True라 상속되어 `"BAR"` → 통과. 기존 `__call__`(method) 단언도 그대로 유지해 회귀를 가드.
- **픽스 증명**: 테스트가 정확히 "property 재정의 시 docstring 미상속"이라는 근본원인을 때린다. `Base.bar.__doc__ is not None` 가드 안에서 단언하므로 환경 차이에 강건.
- **overfit·regression 관점**: FAIL_TO_PASS가 1개로 얇지만(overfit-risk 후보), 픽스가 `isdatadescriptor`라는 **표준 술어**라서 property 한 케이스에 특수화된 게 아니라 모든 data descriptor로 올바르게 일반화된다 — special-case 패치가 아님. 따라서 overfit-risk 플래그는 달지 않았다. method 경로 미변경 + P2P가 무관 유틸이라 regression-trap 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `InheritDocstrings` + `inspect.isfunction` 두 신호로 `grep`. `astropy/utils/misc.py`의 메타클래스 `__init__` 안 `is_public_member` 루프, 조건문 `if (inspect.isfunction(val) and is_public_member(key) and val.__doc__ is None):`에 즉시 도달.
2. **픽스**: property가 함수가 아니라 data descriptor라서 술어에 안 걸린다는 걸 인지. 힌트대로 `inspect.isdatadescriptor`를 OR로 추가. 이게 올바른 일반화인 이유 — `isproperty` 같은 좁은 술어가 아니라 `isdatadescriptor`를 써서 property뿐 아니라 임의의 data descriptor까지 동일 규칙으로 포괄. 치환이 아닌 OR이라 기존 method 상속을 그대로 보존.
3. **regression 안전**: `isfunction` 가지를 유지하므로 method docstring 상속(기존 `__call__` 테스트)이 안 깨진다. PASS_TO_PASS 6개는 `misc.py`의 독립 유틸이라 영향 없음 — 메타클래스 루프만 손대면 충분.
4. **함정 회피**: (a) `isfunction`을 `isdatadescriptor`로 **치환**해버리면 method가 data descriptor가 아니라 method 상속이 깨진다 — 반드시 OR 확장. (b) 힌트의 "이 클래스가 더 필요 없으면 deprecate" 논의에 휘둘려 픽스 대신 deprecation으로 빠지는 함정 — 테스트는 동작하는 상속을 요구하므로 fix가 정답. (c) `isdatadescriptor`는 method/일반 함수에도 일부 True가 될 수 있으나 함수는 이미 `isfunction` 가지로 잡히고 순서·OR 구조상 무해.
