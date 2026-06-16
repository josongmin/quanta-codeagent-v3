---
instance_id: pytest-dev__pytest-6202
repo: pytest-dev/pytest
base_commit: 3a668ea6ff24b0c8f00498c3144c63bac561d925
version: "5.2"
difficulty: "<15 min fix"
created_at: 2019-11-16T07:45:21Z
fail_to_pass: 1
pass_to_pass: 72
gold_files: [src/_pytest/python.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`@pytest.mark.parametrize("a", ["..["])` 처럼 파라미터 ID에 `.[` 시퀀스가 들어가면, 테스트 리포트 헤드라인과 node 식별자에서 `test_boo[..[]`가 `test_boo[.[]`로 잘못 표시된다(`.[` 한 개가 `[`로 치환되어 사라짐). 같은 버그가 vscode-python의 test discovery 오류도 유발한다. 이슈 리포터가 직접 소스를 역추적해 `getmodpath`의 `return s.replace(".[", "[")` 한 줄을 원인으로 지목했다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)**: 이슈 본문이 `reports.py` → `nodes.py` → `python.py`의 호출 체인을 줄 번호까지 따라가 `return s.replace(".[", "[")` 정확한 라인을 지목했다. grep 한 방으로 끝난다.
- **S (Repair Strategy) = S1 (Direct-Map)**: 픽스가 사실상 명세되어 있다 — "해당 치환 라인을 `return s`로 바꾸라". 기계적 코드 삭제로, 조건식 합성이나 후보 탐색이 필요 없다.
- **K (Knowledge) = K-Domain**: 픽스 자체는 자명하지만 *왜 안전한가*를 판단하려면 pytest 내부 지식이 필요하다. 그 치환은 4.0에서 제거된 yield/generator 테스트(`test_gen.[0]` → `test_gen[0]`)를 위한 레거시 보정이었다(hints_text). 이 도메인 맥락 없이는 "삭제해도 회귀 없는가"를 확신할 수 없다.

primary type = **T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 삭제(S1)다. K-Domain은 회귀 안전성 판단에만 걸리고 픽스 도출을 지배하지 않으므로 T-DomainBound이 아니다. APR 관점에서 이슈가 결함 라인과 교체 코드를 모두 제시하므로 template/direct-map이 dominant 전략이다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`src/_pytest/python.py`), 실질 변경 2줄(1줄 삭제+1줄 단순화). 구조컷상 "1파일·<5줄 ≈ 48% solve" 구간.
- localize 직접성 최상(L0) — 이슈가 라인을 지목.
- `has-repro`: parametrize 재현 코드 + 실제 출력 헤드라인 제시(가장 강한 easiness 신호).
- 다만 도메인 회귀 판단(yield 테스트가 정말 제거됐는지)이 T1을 막는다 — 이슈가 픽스를 적어줘도 *왜 안전한가*는 별도 지식이 필요해 "픽스 거의 자명"인 T1보다 한 단계 위.
- P2P 72개가 모두 `test_collection.py`에 몰려 있어 약한 `regression-trap`이 존재하나, 변경 표면이 극히 좁아 실제 위험은 낮다.

공식 라벨 `<15 min fix`와 일치한다.

## 골드패치 분석

- **파일·함수**: `src/_pytest/python.py`의 `PyobjMixin.getmodpath()`.
- **근본원인**: `getmodpath`는 부모 노드 이름들을 `.`로 join한 뒤 `s.replace(".[", "[")`로 후처리했다. 이 치환은 4.0 이전 generator/yield 테스트에서 자동 생성 케이스 이름(`[0]`)이 부모와 join될 때 `test_gen.[0]` → `test_gen[0]`로 보정하기 위한 것이었다. yield 테스트가 4.0에서 제거됐으므로 이 치환은 더 이상 필요 없고, 오히려 파라미터 ID에 우연히 `.[`가 포함된 정상 케이스의 문자를 삼켜버린다.
- **수정요지**:
  ```python
  -        s = ".".join(parts)
  -        return s.replace(".[", "[")
  +        return ".".join(parts)
  ```
  레거시 후처리 치환을 제거하고 join 결과를 그대로 반환한다.

## 검증 (test_patch)

`testing/test_collection.py::Test_genitems::test_example_items1` (FAIL_TO_PASS, 1건).

테스트는 기존 `TestY(TestX): pass`를 `@pytest.mark.parametrize("arg0", [".["])`가 붙은 `testmethod_two`로 바꿔, ID에 의도적으로 `.[`를 심는다. 검증:
- `items[3].name == "testmethod_two[.[]"` — 수집된 node 이름에 `.[`가 보존.
- `items[3].getmodpath() == "TestY.testmethod_two[.[]"` — modpath에서 `.[`가 사라지지 않음. base_commit에서는 치환이 작동해 `TestY.testmethod_two[[]` 류로 깨지므로 RED, 패치 후 GREEN.
- 아이템 수 `3 → 4`로 늘려 parametrize 케이스가 실제 수집됐음도 함께 단언.

**overfit 관점**: 픽스가 라인 *삭제*라 특정 입력에 맞춘 special-case 추가가 아니다. 치환 자체를 없앴으므로 `.[`뿐 아니라 모든 입력에 대해 항등적으로 일반화된다 — CEGIS류 과소명세 위험 없음. F2P가 1건뿐이지만 픽스 형태가 일반화를 강제하므로 `overfit-risk` 플래그는 부여하지 않았다.

**regression 관점**: 동일 테스트가 비-parametrize 케이스(`getmodpath() == "TestX.testmethod_one"`, `stopatmodule=False` 경로)도 같이 단언해, 치환 제거가 평범한 modpath를 깨지 않음을 보장한다. P2P 72개 전 수집 동작이 유지되어야 한다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 이미 `reports.py:148` 헤드라인 → `nodes.py:437` `reportinfo()` → `python.py:306` `getmodpath()` → `return s.replace(".[", "[")`로 체인을 짚어준다. L0이므로 이 라인을 여는 것이 출발점.
2. **픽스**: 치환을 제거하고 `return ".".join(parts)`. 올바른 일반화인 이유 — 버그는 "특정 입력에서 잘못 동작"이 아니라 "치환 규칙 자체가 시대착오"다. 조건을 좁혀 `.[`만 살리는 패치(예: parametrize ID일 때만 skip)는 오히려 부정확한 부분 패치다. 루트(레거시 보정)를 제거하는 것이 정답.
3. **regression 안전**: yield/generator 테스트가 pytest 4.0에서 제거됐음을 확인(hints_text가 근거 제시)하면, 이 치환을 의지하던 유일한 사용처가 사라졌음이 보장된다. P2P의 일반 modpath/수집 동작(`TestX.testmethod_one` 등)은 치환과 무관하므로 안전.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) "치환이 왜 있나 모르겠다"며 보수적으로 `.[`만 보존하는 조건부 패치를 짜 과복잡화, (b) 치환 제거가 현재 4.x에서 회귀를 일으킬까 두려워 손대지 않고 헤드라인 렌더 쪽(`reports.py`)을 건드려 오localize. 회피법: hints의 "yield 테스트 4.0 제거" 사실(또는 git blame으로 치환 도입 맥락)을 확인해 치환이 dead code임을 입증한 뒤 통째로 삭제한다.
