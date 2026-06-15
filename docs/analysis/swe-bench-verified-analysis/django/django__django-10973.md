---
instance_id: django__django-10973
repo: django/django
base_commit: ddb293685235fd09e932805771ae97f72e817181
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-02-11T01:19:56Z
fail_to_pass: 5
pass_to_pass: 0
gold_files: [django/db/backends/postgresql/client.py]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L0
repair_strategy: S6 (+S1)
knowledge: K-Domain
flags: [overfit-risk, regression-trap]
---

# django__django-10973

## 문제 요약
PostgreSQL 백엔드의 `dbshell`(`DatabaseClient.runshell_db`)이 psql에 비밀번호를 넘길 때 임시 `.pgpass` 파일을 만들고 전역 `os.environ['PGPASSFILE']`로 가리키는 레거시 우회 방식을 쓰고 있었다. 이 방식은 (1) `NamedTemporaryFile` I/O, (2) `:`/`\`를 이스케이프하는 `_escape_pgpass`, (3) 전역 환경변수 오염 후 `finally` 정리, (4) 로케일 인코딩 실패 시 `UnicodeEncodeError` 폴백을 동반한다. Python 3.5(Django 2.1부터 최소 버전)에 추가된 `subprocess.run`은 서브프로세스에 커스텀 환경을 직접 넘길 수 있으므로, `PGPASSWORD`를 자식 프로세스 env에만 주입하면 이 복잡성 전체를 제거할 수 있다. 즉 버그 수정이 아니라 표준 API를 활용한 단순화/리팩터링 요청이다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 파일 경로(`django.db.backends.postgres.client`)와 기법(`subprocess.run`, `PGPASSWORD`)을 직접 지목한다. grep 한 방으로 `runshell_db` 본문에 도달. 탐색 노력 사실상 0.
- **S (Repair Strategy) = S6 Design-Refactor (+S1).** 한 줄 가드 추가가 아니라 lifecycle 재배치다: temp 파일 생성→이스케이프→전역 env set→finally cleanup 구조를 통째로 들어내고, 자식-스코프 env 복사본(`subprocess_env = os.environ.copy()`)에 `PGPASSWORD`를 주입하는 새 데이터 흐름으로 교체해야 한다. APR 관점에서 단일 표현식 합성(S2)이나 템플릿 결함 패턴(S1)으로 환원되지 않고, "collect env → process via run" 형태의 작은 구조 변경이므로 dominant는 S6. 잔여 S1 성격은 `if passwd:` 가드 한 줄에만 있다.
- **K (Knowledge) = K-Domain.** psql의 인증 경로(PGPASSFILE vs PGPASSWORD 환경변수 계약), `subprocess.run`의 `env`/`check` 파라미터 의미, 그리고 전역 `os.environ`을 건드리면 안 되는 이유(다른 테스트·프로세스 오염)를 알아야 올바른 픽스가 나온다. 순수 일반 파이썬 추론(K-Gen)만으로는 PGPASSWORD가 PGPASSFILE의 적법한 대체임을 확신하기 어렵다.
- **primary_type = T-DesignRefactor.** dominant 축이 S6(조율된 구조 변경)이기 때문. L0이라 T-DiffuseLoc 아니고, 기계적 가드/상수 변경이 아니라 블록 전체 재배치라 T-DirectMap 아니다. 의도는 이슈에 명시되어 있어(S5 아님) T-SpecInference도 아니다.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `15 min - 1 hour`(T2~T3 경계의 prior). 구조 피처로 재조정하면:
- localize 직접성: L0 — 이슈가 파일·기법을 적어줌 → 난이도를 끌어내림.
- 수정 범위: 단일 파일·단일 메서드, gold patch가 import 1줄·헬퍼 함수 1개 삭제 + 메서드 본문 재작성. 라인수는 적지만 "삭제 위주 + 새 데이터흐름"이라 1줄 가드보다 무겁다.
- repro: 네이티브 스택트레이스/재현코드 없음(개선 요청). has-repro 신호 부재가 난이도를 약간 올림.
- P2P trap: PASS_TO_PASS = **0** (광역 회귀 그물 없음) → regression 절대량은 낮음. 다만 *FAIL_TO_PASS 자체가 동시에 회귀 게이트*(test_basic/column/accent/sigint)를 겸하고, test_patch가 기대값을 escape 형태에서 raw 형태로 바꿔 박아서, "최소 변경" 본능으로 PGPASSFILE을 남기면 깨진다 → `regression-trap` 플래그.
- overfit 위험: FAIL_TO_PASS 5개로 얇은 편이고, 픽스 의도(전역 env 비오염, 이스케이프 제거)를 테스트가 부분적으로만 강제 → `overfit-risk` 플래그.

L0 + 작은 refactor + 도메인 계약 추론이 겹쳐 T2(쉬움)보다는 위, T4(constraint/멀티파일)보다는 아래인 **T3**가 적정. 공식 라벨과 큰 괴리는 없으나, "코드 단순화 요청"이라는 인지적 거리(리팩터를 끝까지 들어내야 그린)가 시간라벨보다 약간 더 까다롭게 만든다.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/backends/postgresql/client.py`
  - `DatabaseClient.runshell_db` (classmethod) 본문 재작성
  - 모듈 레벨 헬퍼 `_escape_pgpass(txt)` **삭제**
  - `from django.core.files.temp import NamedTemporaryFile` import **삭제**
- **근본 원인:** 버그가 아니라 레거시 우회. `.pgpass` 임시파일 방식은 임시파일 I/O, `:`/`\` 이스케이프(`_escape_pgpass`), 전역 `os.environ['PGPASSFILE']` 변경 후 `finally` 삭제, 로케일 인코딩 실패 시 `UnicodeEncodeError` 폴백이라는 불필요한 복잡성과 전역 상태 오염을 동반.
- **수정 요지:**
  - `subprocess_env = os.environ.copy()`로 자식용 env 복사본을 만들고, `if passwd:` 일 때만 `subprocess_env['PGPASSWORD'] = str(passwd)` 주입(전역 `os.environ` 불변).
  - `subprocess.check_call(args)` → `subprocess.run(args, check=True, env=subprocess_env)`로 교체(`check=True`로 비-제로 종료 시 예외 동등 보존).
  - 임시 `.pgpass` 생성·`_escape_pgpass`·`PGPASSFILE` set/cleanup 블록과 헬퍼·import를 전부 제거.
  - SIGINT를 `SIG_IGN`으로 무시했다가 `finally`에서 원복하는 try/finally 골격은 유지(동작 보존).

## 검증 (test_patch)
- **FAIL_TO_PASS (5개):** `test_accent`, `test_basic`, `test_column`, `test_nopass`, "SIGINT is ignored in Python and passed to psql to abort quries."(=`test_sigint_handler`의 docstring 라벨). PASS_TO_PASS = 0.
- **FAIL_TO_PASS 동작:** test_patch가 헬퍼 `_run_it`을 다시 짠다 — `subprocess.call`/`PGPASSFILE` 파일 읽기 대신 `subprocess.run`을 목킹(`_mock_subprocess_run(*args, env=os.environ, **kwargs)`)해, 자식에 전달된 `env`의 `PGPASSWORD` 값을 반환하고 `subprocess.CompletedProcess(...)`를 돌려준다.
- **픽스 증명:**
  - `test_basic`: 기대 PGPASSWORD가 `'somepassword'` (이전 pgpass 라인 `'somehost:444:dbname:someuser:somepassword'`에서 변경) → env 주입 경로 검증.
  - `test_column`: user `some:user`, password `some:password`에 대해 기대값 `'some:password'` — 이스케이프 제거로 `:`가 raw 보존됨을 검증(이전엔 `\:`). 기존 `test_escape_characters`는 이스케이프 개념이 사라져 **삭제**됨.
  - `test_accent`: 비ASCII 비밀번호 `sésame`를 그대로 PGPASSWORD로 전달 → 로케일 인코딩 폴백 제거가 회귀 없음을 증명.
  - `test_nopass`: 비밀번호 없을 때 PGPASSWORD 미설정(`None`) — `if passwd:` 가드 검증.
  - `test_sigint_handler`: 목 대상을 `subprocess.run`으로 바꿔 호출 시점에 SIGINT가 `SIG_IGN`이고, 복귀 후 원래 핸들러로 복원됨을 검증.
- **overfit 관점:** FAIL_TO_PASS가 5개로 얇다. 테스트는 "PGPASSWORD가 자식 env에 raw로 들어가는가"는 직접 검증하지만, *전역 `os.environ`이 오염되지 않았는가*는 명시적으로 단언하지 않는다(`env=os.environ` 기본 인자에 의존). 따라서 `os.environ`을 직접 set하고 cleanup하는 변종도 일부 테스트를 통과할 여지가 있어 overfit 위험이 잔존.
- **regression 관점:** P2P가 비어 광역 회귀망은 없지만, FAIL_TO_PASS의 기대값 자체가 escape→raw로 박혀 있어, 이스케이프/PGPASSFILE 잔재를 남기면 `test_column`/`test_basic`이 직접 깨진다 — 회귀 게이트가 FAIL_TO_PASS에 내장된 형태.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 `django.db.backends.postgres.client`(실경로 `django/db/backends/postgresql/client.py`)와 `subprocess.run`/`PGPASSWORD`를 직접 명시 → `DatabaseClient.runshell_db`로 즉시 진입. 함께 사는 `_escape_pgpass` 헬퍼와 `NamedTemporaryFile` import가 제거 대상임을 함수 본문 reachability로 확인.
2. **픽스(왜 올바른 일반화인가):** `os.environ.copy()`한 자식-스코프 env에만 `PGPASSWORD`를 넣는 것이 핵심. PGPASSWORD는 psql이 PGPASSFILE과 동등하게 인정하는 인증 채널이므로 기능 동치이고, 전역 `os.environ`을 건드리지 않아 다른 프로세스/테스트 오염이 사라진다. 이스케이프(`_escape_pgpass`)는 `.pgpass` *파일 포맷*(`:` 구분자) 때문에 필요했던 것이라, 파일이 사라지면 이스케이프도 의미를 잃는다 → 제거가 옳은 일반화(특정 테스트 통과용 하드코딩이 아님). `subprocess.run(..., check=True)`로 기존 `check_call`의 예외 의미를 보존.
3. **regression 안전:** P2P는 0이지만, FAIL_TO_PASS의 `test_column`(raw `:` 기대)·`test_accent`(비ASCII raw)·`test_nopass`(`None`)·`test_sigint_handler`(SIG_IGN/원복)를 동시에 만족해야 한다. SIGINT try/finally 골격을 보존하고, `if passwd:` 가드를 유지해 무비밀번호 경로에서 PGPASSWORD를 안 넣어야 `test_nopass`가 산다.
4. **함정 회피:** 오라클 없는 에이전트의 최빈 실패는 **"최소 변경" 본능** — PGPASSFILE 임시파일 경로를 그대로 두고 PGPASSWORD만 추가하는 것. 그러면 이스케이프 기대가 raw로 바뀐 `test_column`과 삭제된 `test_escape_characters` 가정과 충돌해 깨진다. 또 다른 함정은 전역 `os.environ['PGPASSWORD']`를 직접 set/cleanup하는 변종(테스트는 통과할 수 있으나 이슈 의도인 "전역 비오염"을 위반 → overfit). 정답은 우회 블록을 통째로 들어내고 `os.environ.copy()` 복사본에만 주입하는 것.
