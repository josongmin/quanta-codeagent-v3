---
instance_id: sphinx-doc__sphinx-9711
repo: sphinx-doc/sphinx
base_commit: 81a4fd973d4cfcb25d01a7b0be62cdb28f82406d
version: "4.3"
difficulty: "<15 min fix"
created_at: 2021-10-06T15:08:03Z
fail_to_pass: 1
pass_to_pass: 0
gold_files: [sphinx/extension.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-API
flags: [overfit-risk]
---

## 문제 요약

`needs_extensions`의 최소 버전 검증이 버전을 문자열 비교로 한다. 그래서 문자열 사전순으로 `'0.6' > '0.10'`이 되어, 마이너 버전이 두 자리(>9)로 올라간 확장(예: sphinx-gallery 0.10.0)이 최소 요구 0.6.0을 만족함에도 "버전이 낮다"며 빌드가 실패한다. 의미적 버전 비교(0.6 < 0.10)로 고쳐야 한다.

## 유형 (정형화)

- **L0 (Localization)**: 이슈가 에러 메시지("This project needs the extension ... at least in version ...")와 `needs_extensions` 심볼을 직접 지목한다. 메시지/심볼 grep 한 방에 `sphinx/extension.py`의 `verify_needs_extensions`로 수렴. 단일 함수, 직접 포인터.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나, 단순 가드 추가가 아니라 비교 의미론 자체를 교체해야 한다. 문자열 `>` → 의미적 버전 객체 비교로 바꾸되, `'unknown version'`·비-PEP440 버전 같은 엣지를 인식하고 폴백을 합성해야 함. 템플릿 매칭(S1)이 아니라 불변식("버전 순서 ≠ 문자열 순서")을 따져 올바른 조건식을 짜는 작업.
- **K-API (Knowledge)**: 정답은 `packaging.version.Version`/`InvalidVersion` API 계약을 정확히 써야 한다. Sphinx가 이미 의존하는 `packaging`을 끌어와 PEP 440 비교를 하고, 파싱 실패 시에만 기존 문자열 비교로 폴백하는 하위호환 처리가 핵심.

primary type = **T-ConstraintReason**: 위치는 L0로 자명하지만 픽스가 기계적 가드가 아니라 "올바른 비교 의미론 + 폴백 조건"의 추론 합성이라서 S1이 아닌 S2가 dominant.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 1개·함수 1개·실질 +12줄(단일 헌크) → scope는 T1~T2급.
- localize 직접성 L0, 에러 메시지로 즉시 수렴 → 쉬움 쪽.
- 그러나 repro가 외부 패키지(mplcursors/sphinx-gallery 0.10) 설치를 요구해 로컬 즉시 재현은 아님(`has-repro` 미부여) → 동작은 명확하나 검증 손맛은 약함.
- P2P가 비어 있어(regression-trap 없음) 인접 동작 파손 위험은 낮지만, 동시에 회귀 안전망도 없어 픽스 자유도가 크다.
- 핵심 난점은 "버전 비교를 어떤 라이브러리/규칙으로 하고, 비표준 버전을 어떻게 폴백하느냐"의 판단(S2+K-API). 자명한 한 줄 픽스(T1)는 아니다.

공식 라벨은 `<15 min fix`(T1~T2 prior). 구현 시간은 짧지만, 단순 가드가 아닌 비교 의미론 교체 + 엣지 폴백 + `packaging` 채택 결정이 들어가 구조적으로 **T3**으로 한 단계 올린다.

## 골드패치 분석

- **파일/함수**: `sphinx/extension.py`의 `verify_needs_extensions(app, config)`.
- **근본 원인**: 기존 조건 `if extension.version == 'unknown version' or reqversion > extension.version:`에서 `reqversion > extension.version`이 둘 다 **str**이라 사전순 비교가 된다. `'0.6' > '0.10'`이 True가 되어, 실제로는 더 높은 버전(0.10)이 요구 최소(0.6)보다 낮다고 오판된다.
- **수정 요지**: `from packaging.version import InvalidVersion, Version` import 추가 후, 단일 표현식을 `fulfilled` 플래그 분기로 재작성.
  - `extension.version == 'unknown version'` → `fulfilled = False`(버전 미상이면 요구 충족 불가, 기존 동작 보존).
  - 그 외엔 `Version(reqversion) > Version(extension.version)`로 **의미적** 비교; 이게 True면 미충족.
  - `InvalidVersion`(PEP 440 파싱 실패) 발생 시 기존 `reqversion > extension.version` **문자열 비교로 폴백** — 비표준 버전 문자열에 대한 하위호환 유지.
  - 최종 `if not fulfilled:`에서 기존 `VersionRequirementError` raise 경로 그대로.

## 검증 (test_patch)

신규 `tests/test_extension.py::test_needs_extensions` (FAIL_TO_PASS 1개)가 3가지를 본다:
1. 빈 `needs_extensions == {}` → 통과(에러 없음).
2. 요구 `'3.9'`, 로드 `'3.10'` → `verify_needs_extensions`가 **통과해야** 함. 버그 코드에선 `'3.9' > '3.10'`(문자열)이 True라 잘못 raise → 이 단언이 정확히 회귀를 잡는다. 픽스 후 `Version('3.9') < Version('3.10')`이라 통과.
3. 요구 `'3.11'`, 로드 `'3.10'` → 정상적으로 `VersionRequirementError` raise(`pytest.raises`).

**픽스 증명**: 케이스 2가 두 자리 마이너(>9) 비교의 핵심 회귀로, 문자열 비교를 의미적 비교로 바꿔야만 그린이 된다. 케이스 3은 "여전히 진짜 미달은 막아야 함"을 보장(over-correction 방지).

**overfit 관점**(`overfit-risk` 표기): 테스트가 `'unknown version'` 경로와 `InvalidVersion` 폴백 경로를 직접 검증하지 않는다. 즉 골드의 try/except 폴백은 FAIL_TO_PASS로 강제되지 않아, 에이전트가 `Version(...)` 비교만 넣고 폴백을 빠뜨려도 테스트는 통과한다(비표준 버전에서만 깨지는 잠재 회귀). regression 관점은 P2P=0이라 인접 파손 위험은 낮음.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 에러 문구 "This project needs the extension ... at least in version ..."를 grep → `sphinx/extension.py`의 `verify_needs_extensions` 단일 함수. 이슈가 "string-like 비교"라고 원인까지 명시하므로 비교 라인 `reqversion > extension.version`이 바로 용의선.

2. **픽스와 일반화 근거**: 문자열 `>`를 PEP 440 의미 비교로 교체. Sphinx가 이미 `packaging`을 의존하므로 `packaging.version.Version`이 정답 도구(임의 정규식/split 파싱 재발명은 비-올바름). `Version(reqversion) > Version(extension.version)`은 `0.6 < 0.10`을 올바르게 처리하고, 자릿수 무관하게 일반화된다 — 특정 입력(3.9/3.10)에 맞춘 overfit이 아니라 버전 순서 불변식 자체를 고친 것.

3. **regression 안전**: `'unknown version'` 분기를 반드시 유지해야 한다(기존 "버전 미상 = 미충족" 동작). 정상 미달(요구 3.11 > 로드 3.10) raise 경로도 보존. P2P는 비어 있지만 같은 함수의 기존 동작 두 가지(미상·진짜 미달)를 깨지 않는 게 안전망.

4. **함정 회피**: 오라클 없는 에이전트의 실수 지점은 **비표준 버전 폴백 누락**이다. `Version(...)`은 PEP 440 비준수 문자열(예: 날짜·git hash형 버전)에 `InvalidVersion`을 던지므로, 이를 try/except로 감싸 옛 문자열 비교로 폴백하지 않으면 기존에 통과하던 비표준-버전 확장이 깨진다. 테스트가 이 경로를 강제하지 않으므로(overfit-risk), 골드처럼 `except InvalidVersion: reqversion > extension.version` 폴백을 명시적으로 넣는 것이 올바른 일반화다. 또 `'unknown version'`을 `Version()`에 그냥 넣으면 예외가 나므로, 그 분기를 비교보다 **먼저** 처리해야 한다.
