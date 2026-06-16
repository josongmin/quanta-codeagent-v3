---
instance_id: pylint-dev__pylint-7277
repo: pylint-dev/pylint
base_commit: 684a1d6aa0a6791e20078bc524f97c8906332390
version: "2.15"
difficulty: "<15 min fix"
created_at: 2022-08-08T23:07:49Z
fail_to_pass: 1
pass_to_pass: 122
gold_files: [pylint/__init__.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`pylint`을 `runpy.run_module('pylint', run_name="__main__", alter_sys=True)`로 프로그래밍적 실행하면, `modify_sys_path()`가 무조건 `sys.path[0]`을 제거해 사용자가 의도적으로 삽입한 첫 항목(예: 번들 라이브러리 경로)이 날아간다. 이슈 본문이 원인 라인과 수정안까지 직접 지목한다: 첫 항목이 `""`, `"."`, `os.getcwd()` 중 하나일 때만 제거하라는 가드 추가. docstring 자체가 "This will always be either '' or the working directory"라고 명시하므로, 코드를 docstring 계약에 맞추는 작업이다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 파일·함수·라인(`pylint/__init__.py#L99`, `modify_sys_path`)을 verbatim 지목. 탐색 0.
- **S (Repair Strategy) = S1 (+S2)**: 결함클래스가 정형(무조건 pop → 조건부 가드 추가)이라 S1 템플릿 매칭이 dominant. 다만 "어떤 조건이 안전한가"는 `("", ".", cwd)` 멤버십을 docstring·후속 PYTHONPATH 로직과 정합되게 추론해야 하므로 S2 보조. 이슈가 정확한 술어(`in ("", ".", os.getcwd())`)까지 적어줘서 S2 비중은 낮다.
- **K (Knowledge) = K-Gen**: `sys.path` 의미와 cwd 주입 관례만 알면 충분. pylint 내부 도메인지식 불필요.
- **Primary = T-DirectMap**: 위치 명확 + 기계적 가드 삽입(None/경계가드 계열의 "전치조건 추가"). 이슈가 픽스를 사실상 명세하므로 T-LocTrivial에 근접하나, 올바른 술어를 docstring과 정합시키는 최소 판단이 있어 DirectMap.

APR 관점: 실패 입력(임의 첫 항목)이 special-case 가드로 막히는 전형적 "guard insertion" 패턴 → SemFix류 조건합성이 아니라 PAR/TBar 템플릿(전치조건 삽입)에 해당.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개, 순변경 +3/-2(실질 1줄 가드 추가 + cwd 계산 위치 이동).
- localize 직접성 최상(이슈가 라인 지목) → has-repro까지 존재(runpy 재현 스니펫).
- 도메인지식 없음(K-Gen).
- 단, **regression-trap이 약하지 않음**: PASS_TO_PASS 121개가 전부 `tests/test_self.py`의 CLI 통합 시나리오라, `sys.path` 조작 변경이 병렬실행/플러그인 import/recursive 등 인접 동작을 깨면 광범위 실패. 가드를 잘못 좁히거나(예: cwd만 체크) `cwd` 계산 이동 순서를 흩트리면 회귀 가능.
공식 라벨 "<15 min fix"와 일치. L0+S1+has-repro라 T1에 가깝지만, 121 P2P trap과 첫 항목 형태(`""` 빈문자열까지 포함) 추론 때문에 T1이 아닌 T2로 둔다.

## 골드패치 분석
- **파일·함수**: `pylint/__init__.py`의 `modify_sys_path()`.
- **근본원인**: 함수 첫 줄 `sys.path.pop(0)`이 첫 항목의 정체를 검사하지 않고 무조건 제거. docstring은 "첫 항목은 항상 '' 또는 cwd"라 가정하지만, `runpy`/IDE 확장이 `alter_sys=True`로 임의 경로를 0번에 삽입하면 가정이 깨진다.
- **수정요지**:
  - `cwd = os.getcwd()`를 pop보다 **앞으로** 끌어올려(이전엔 pop 다음에 있었음) 가드 술어에서 즉시 사용 가능하게 함.
  - `sys.path.pop(0)` → `if sys.path[0] in ("", ".", cwd): sys.path.pop(0)`. 첫 항목이 cwd 계열일 때만 제거.
  - 이후 PYTHONPATH 분기(`env_pythonpath.startswith(":")` 등)는 그대로 유지.

## 검증 (test_patch)
FAIL_TO_PASS = `tests/test_self.py::TestRunTC::test_modify_sys_path` 1개. 기존 테스트에 4개 케이스 추가:
- `["", *default_paths]` → 첫 항목 제거됨(`paths[1:]`).
- `[".", *default_paths]` → 제거됨.
- `["/do_not_remove", *default_paths]` → **제거 안 됨**(`assert sys.path == paths`). ← 이게 버그 재현·픽스 증명 핵심.
- 기존 `[cwd, ...]` 케이스도 계속 통과.
**픽스 증명**: 가드가 없으면 `/do_not_remove`가 pop되어 `paths != sys.path`로 실패; 가드가 있으면 멤버십 불일치로 보존 → 통과.
**overfit 관점**: 가드 술어 `("", ".", cwd)` 3종을 모두 테스트가 커버(빈문자열/점/임의경로 음성 + cwd 양성)하므로 special-case overfit 여지 낮음. cwd만 체크하는 부분픽스는 `""`/`"."` 케이스에서 잡힌다.
**regression 관점**: 121개 P2P CLI 시나리오가 모두 정상 cwd-주입 경로(첫 항목이 cwd/""/".")라 가드 추가 후에도 동일하게 pop → 그린 유지. cwd 계산을 앞으로 옮긴 것도 부작용 없음(순수 지역변수).

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `pylint/__init__.py#L99`와 `modify_sys_path`를 직접 준다 → grep `modify_sys_path` → 함수 첫 줄 `sys.path.pop(0)`이 무가드 제거임을 확인. docstring의 "always be either '' or the working directory" 주석이 깨진 불변식을 명시.
2. **픽스·일반화 정당성**: 무조건 pop을 `if sys.path[0] in ("", ".", cwd): sys.path.pop(0)`로 전치조건화. 이게 올바른 일반화인 이유 — 함수의 의도는 "cwd 오염 제거"이지 "맹목적 첫 항목 제거"가 아니다. 술어를 cwd 단독이 아닌 `("", ".", cwd)` 3종으로 잡아야 빈문자열/상대점 표기까지 동일 의미로 처리(파이썬이 cwd를 이 세 형태 중 하나로 주입). `cwd` 정의를 pop 위로 끌어올려 가드에서 사용.
3. **regression 안전**: 121 P2P(test_self CLI 통합)는 모두 정상 진입(cwd/""/"." 첫 항목)이라 가드 통과 후 동일하게 pop되어야 그린 유지 — 술어를 과하게 좁히면(예: `== cwd`만) 빈문자열 케이스가 회귀. 후속 PYTHONPATH `pop(0)/pop(1)` 분기는 손대지 않아 issue#3636/#4161 동작 보존.
4. **함정 회피**: (a) cwd만 검사하고 `""`/`"."`를 빠뜨리는 부분픽스 — 음성 테스트가 있지만 추가된 `["", ...]`/`[".", ...]` 케이스가 잡는다. (b) `cwd` 정의를 그대로 pop 아래 둔 채 가드에서 참조 → `NameError`; 정의 이동이 필수. (c) 첫 항목 보존 대신 "특정 인덱스 탐색"으로 과설계하면 후속 PYTHONPATH 인덱스 로직(`pop(1)`)과 충돌. 최소 가드 1줄이 정답.
