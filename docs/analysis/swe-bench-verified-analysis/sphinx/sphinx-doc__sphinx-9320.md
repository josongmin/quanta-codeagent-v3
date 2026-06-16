---
instance_id: sphinx-doc__sphinx-9320
repo: sphinx-doc/sphinx
base_commit: e05cef574b8f23ab1b57f57e7da6dee509a4e230
version: "4.1"
difficulty: "<15 min fix"
created_at: 2021-06-11T13:29:04Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [sphinx/cmd/quickstart.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro]
---

## 문제 요약
기존 `conf.py`가 있는 폴더에서 `sphinx-quickstart`를 실행하면 "Please enter a new root path (or just Enter to exit)" 프롬프트가 뜬다. 그러나 Enter(빈 입력)를 누르면 종료되지 않고 "Please enter a valid path name." 에러가 반복된다. 기대 동작은 Enter 시 즉시 종료(exit status 1)다. 프롬프트가 "just Enter to exit"라고 안내하지만 검증 함수가 빈 문자열을 거부해서 종료 분기에 도달하지 못한다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 정확한 심볼명을 주진 않지만 "Please enter a new root path (or just Enter to exit)" 프롬프트 문자열로 `grep` 한 방에 `ask_user`의 해당 `do_prompt` 호출에 수렴한다. 약간의 탐색만 필요.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점은 명확하나, "빈 입력은 허용하되 비어있지 않으면 경로 검증"이라는 새 검증 불변식을 추론해 합성해야 한다. 단순 가드 추가(S1)가 아니라 검증 술어 자체를 조건 분기로 재정의하는 의미적 수정이다.
- **K (Knowledge) = K-Gen**: `do_prompt`/validator 콜백 패턴만 이해하면 충분하고, sphinx 도메인 내부 지식은 불필요하다.
- **Primary = T-ConstraintReason**: 위치는 거의 자명하지만 픽스의 본질이 "validator의 검증 조건을 어떻게 약화/분기할 것인가"라는 조건 합성에 있다. 빈 입력만 예외처리하는 올바른 술어를 생각으로 도출해야 한다.

왜 S2인가(APR 관점): 골드는 검증을 끄는 게 아니라(`allow_empty`로 바꾸면 잘못된 일반화 — 임의 비경로 입력도 통과시킴) 빈 문자열만 면제하는 `is_path_or_empty`를 신설한다. 정확한 불변식("empty ⇒ pass, else delegate to is_path")을 합성하는 SemFix류 의미적 수리다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`sphinx/cmd/quickstart.py`), 골드 변경 ~7줄(신규 함수 5줄 + 호출 인자 1줄 교체).
- Localize 직접성 높음: 프롬프트 리터럴이 유일 앵커, 후보 단일.
- `has-repro`: 이슈에 명확한 재현 절차(`sphinx-quickstart` 2회)와 스크린샷 존재 — 강한 easiness 신호.
- P2P trap 약함: PASS_TO_PASS 9개가 모두 quickstart 동작이지만 신규 validator는 추가만 하고 `is_path` 자체는 불변이라 인접 동작 회귀 위험 낮음.
- 도메인 지식 불필요(K-Gen).

공식 라벨 "<15 min fix"와 일치. L0+S1 자명 픽스가 아니라(validator를 어떻게 분기할지 한 박자 추론 필요) T1까지 내리지 않고 T2로 둔다.

## 골드패치 분석
- **건드린 파일/심볼**: `sphinx/cmd/quickstart.py` — 신규 함수 `is_path_or_empty(x)` 추가, `ask_user(d)` 내부의 재입력 `do_prompt(...)` 호출의 validator 인자를 `is_path` → `is_path_or_empty`로 교체.
- **근본 원인**: `do_prompt`는 validator가 `ValidationError`를 던지면 같은 프롬프트를 재요청하며 루프를 돈다. 기존 `is_path`는 `path.isdir(x)`가 False면(빈 문자열 `''` 포함) `ValidationError("Please enter a valid path name.")`를 던진다. 따라서 빈 입력이 `ask_user`로 반환되지 못하고, 그 아래 `if not d['path']: sys.exit(1)` 종료 분기에 영영 도달하지 못한다. 프롬프트 안내문("just Enter to exit")과 실제 검증 동작이 모순.
- **수정 요지**: `is_path_or_empty`는 `x == ''`이면 그대로 반환(검증 면제), 아니면 `is_path(x)`에 위임한다. 이제 빈 입력이 `do_prompt`를 통과해 `d['path']=''`로 반환되고, `if not d['path']: sys.exit(1)`가 실행되어 의도대로 종료한다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_exits_when_existing_confpy` — `monkeypatch`로 `os.path.isfile`을 항상 True로 만들어 "기존 conf.py 발견" `while` 루프에 진입시키고, 프롬프트에 빈 문자열을 주입(`mock_input`)한 뒤 `qs.ask_user(d)`가 `SystemExit`을 일으키는지 `pytest.raises(SystemExit)`로 확인한다. 픽스 전: 빈 입력이 `is_path`에서 막혀 `do_prompt`가 재프롬프트 루프를 돌아 `SystemExit`에 도달 못 함(테스트 hang/fail). 픽스 후: 빈 입력이 통과→`sys.exit(1)`→`SystemExit` 발생.
- **픽스 증명**: 테스트는 종료 경로의 end-to-end 동작(검증 통과 → 종료 분기 실행)을 직접 관찰한다.
- **overfit/regression 관점**: validator를 무력화(`allow_empty` 사용 등)하면 임의의 비경로 입력도 종료 없이 통과해 후속 `path.isfile` 검사가 오작동할 수 있다 — 골드는 빈 문자열만 면제하고 비어있지 않은 입력은 `is_path` 검증을 그대로 유지하므로 과적합 아님. 첫 프롬프트(`Root path for the documentation`, default `.`)는 여전히 `is_path`를 쓰므로 기존 9개 PASS_TO_PASS 경로는 불변. regression 표면 작음.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈의 프롬프트 문자열 "Please enter a new root path (or just Enter to exit)"를 코드에서 grep → `ask_user`의 기존-conf.py `while` 루프 내부 `do_prompt(..., '', is_path)`와 바로 아래 `if not d['path']: sys.exit(1)`를 발견. 안내문과 종료 분기는 있는데 빈 입력이 거기 못 닿는다는 모순을 식별.
2. **픽스**: validator가 빈 문자열을 거부하는 게 원인이므로, 빈 입력만 면제하고 나머지는 경로 검증을 유지하는 `is_path_or_empty`를 신설해 그 호출에만 주입. `is_path`를 통째로 약화하지 않는 게 올바른 일반화 — 종료 의도(빈 입력)와 유효 경로 검증을 둘 다 보존한다.
3. **regression 안전**: `is_path`는 손대지 않고 새 validator를 추가만 하므로, 첫 root-path 프롬프트와 다른 모든 quickstart 흐름(PASS_TO_PASS 9개: defaults/all_answers/extensions/build 등)은 동작 불변. 신규 함수는 기존 `is_path`에 위임해 비어있지 않은 경로의 검증 의미를 보존.
4. **함정 회피**: (a) validator를 `allow_empty`로 바꾸거나 검증을 통째로 제거하면 빈 입력 외 잘못된 경로도 통과시키는 over-generalization. (b) `do_prompt` 자체에 special-case를 박으면 다른 호출부에 부작용. (c) 첫 프롬프트의 `is_path`까지 바꾸면 불필요한 동작 변화. 오라클 없는 에이전트는 "검증을 끄면 되네"로 점프하기 쉬우나, 정답은 빈 문자열에 한정한 분기 validator를 새로 만들어 해당 호출에만 적용하는 것이다.
