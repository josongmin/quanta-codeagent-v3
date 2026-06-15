---
instance_id: django__django-14315
repo: django/django
base_commit: 187118203197801c6cb72dc8b06b714b23b6dd3d
version: 4.0
difficulty: <15 min fix
created_at: 2021-04-26T12:39:01Z
fail_to_pass: 11
pass_to_pass: 0
gold_files: [django/db/backends/base/client.py, django/db/backends/postgresql/client.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, cross-file-dep]
---

# django__django-14315

## 문제 요약
DB 클라이언트의 `runshell`이 일부 경우에 `os.environ`을 존중하지 않는 버그다. postgresql 클라이언트의 `settings_to_cmd_args_env`가 추가 환경변수가 없을 때 `None`이 아니라 빈 dict `{}`를 반환하는데, `runshell`은 `if env:` (truthy 검사)로 분기하므로 빈 dict는 falsy라서 `{**os.environ, **env}` 병합 로직을 건너뛴다. 그 결과 빈 env `{}`가 그대로 `subprocess.run(env={})`에 전달되어 자식 프로세스가 부모의 `os.environ`을 전혀 상속받지 못한다(`PATH` 등 누락). problem_statement이 회귀를 도입한 커밋 `bbe6fbb`의 R23-R26 라인까지 링크로 명시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈 본문이 "postgresql client returns empty dict instead of None for env"라고 함수 시맨틱을 직접 적어주고, 회귀 커밋 `bbe6fbb` 링크의 R23-R26(=`base/client.py`의 `runshell`)을 지목한다. grep 한 방으로 `settings_to_cmd_args_env`/`runshell`에 도달. 탐색 부담 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조).** dominant는 S1 — 이슈가 "빈 dict 대신 None을 반환해야 한다"고 픽스를 사실상 명세하므로, "빈 컬렉션 → None 정규화"라는 정형 결함클래스(empty-vs-None / truthy-vs-None 혼동)에 템플릿 매칭된다. 보조 S2가 붙는 이유: 단순히 `if env:`를 지우는 게 아니라, `{}`(=환경을 비움)와 `None`(=부모 env 상속)의 `subprocess.run` 의미 차이를 추론해 "추가 env 없음 → None → os.environ 상속"이라는 올바른 불변식을 합성해야 한다. 무작정 후보를 던지는 G&V가 아니라 의미를 따져 한 번에 맞히는 결정이라 S3/S4가 아니다.
- **K (Knowledge) = K-Gen.** 필요한 지식은 "`subprocess.run(env=None)`은 부모 환경 상속, `env={}`는 빈 환경"이라는 표준 라이브러리 시맨틱뿐. django ORM/query-compiler 같은 프레임워크 내부지식 불필요. 일반 파이썬 추론으로 충분.
- **Primary = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적 정규화(S1: 빈 dict→None 가드)다. 이슈가 픽스를 거의 적어주지만 두 파일 조율과 subprocess 의미 추론이 약하게 들어가 순수 T-LocTrivial보다 한 칸 위, T-DirectMap이 정확.

## 난이도 티어
**T2 (쉬움).** 미는 구조적 피처:
- localize 직접성 L0 + has-repro(회귀 커밋 R23-R26 라인 링크 = 가장 강한 easiness 신호) → T1 쪽으로 강하게 당김.
- 픽스가 2파일(`base/client.py`, `postgresql/client.py`)에 걸친 **조율된** 변경(`cross-file-dep`)이라는 점이 T1에서 T2로 한 칸 올린다. base만 고쳐도 동작은 맞지만 postgresql 반환 계약(`None`)까지 안 맞추면 FAIL_TO_PASS 부분 실패 — "한 줄이면 끝"으로 오판하기 쉬운 함정.
- 픽스 규모는 양쪽 합쳐 ~3줄로 매우 작고(1파일·<5줄 ≈ 48% solve 구간 근처), `{}`↔`None` 시맨틱 차이라는 가벼운 엣지추론만 요구.
- PASS_TO_PASS = 0이라 별도 regression-trap 압력 없음.

공식 라벨 `<15 min fix`(=T1 prior)와 **거의 일치**. T2로 한 칸 올린 유일한 이유는 단일 라인 패치가 아니라 두 파일을 함께 바꿔야 전체 FAIL_TO_PASS가 통과한다는 cross-file 조율 요구(개발자 시간엔 안 잡히지만 에이전트 부분-수정 위험엔 잡힘) 때문.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/base/client.py` — `BaseDatabaseClient.runshell`
  - `django/db/backends/postgresql/client.py` — `DatabaseClient.settings_to_cmd_args_env`
- 근본 원인: postgresql의 `settings_to_cmd_args_env`는 누적용 `env = {}`로 시작해 옵션(PGSSLKEY, PGPASSFILE 등)이 하나도 없으면 빈 dict를 그대로 반환한다. `runshell`은 `if env:` truthy 검사로 분기하므로 `{}`(falsy)는 `{**os.environ, **env}` 병합을 건너뛰고, `subprocess.run(args, env={}, check=True)`가 호출돼 `os.environ`이 완전히 무시된 빈 환경으로 자식 프로세스가 뜬다.
- 수정 요지:
  1. `runshell`: `if env: env = {**os.environ, **env}` (else 분기 없음) → `env = {**os.environ, **env} if env else None`. env가 비어 있으면 `{}`가 아니라 `None`을 넘겨 subprocess가 부모 `os.environ`을 상속하게 한다.
  2. postgresql `settings_to_cmd_args_env`: `return args, env` → `return args, (env or None)`. 빈 dict를 호출지점에서 `None`으로 정규화. 두 변경이 합쳐져 "추가 env 없음 → None → os.environ 상속"이라는 계약을 호출자·피호출자 양쪽에서 일관되게 만든다.

## 검증 (test_patch)
- FAIL_TO_PASS(11개) 동작:
  - `test_runshell_use_environ` (backends.base.test_client) — 신규. `settings_to_cmd_args_env` 반환을 `([], None)`과 `([], {})` 두 입력으로 `subTest` 순회하며, `mock.patch('subprocess.run')` + `mock.patch.object(BaseDatabaseClient, 'settings_to_cmd_args_env', return_value=([], env))`로 주입 후 `runshell(None)` → `run.assert_called_once_with([], env=None, check=True)`로 두 입력 모두 `env=None`으로 정규화돼 전달됨을 단언.
  - postgresql 측(`test_nopass`, `test_parameters` 등 `dbshell.test_postgresql`의 9개) — 기대 반환값을 `{}`에서 `None`으로 갱신. `settings_to_cmd_args_env({...}) == ([...], None)` 형태.
- 픽스 증명: 픽스 전엔 base의 `if env:`가 `{}`를 falsy로 받아 `subprocess.run(env={})`를 호출 → `assert_called_once_with(..., env=None)` 실패. postgresql 테스트는 `{}` 반환을 기대값 `None`과 비교해 실패. 두 파일 수정 후 `runshell`은 None을 넘기고 `settings_to_cmd_args_env`는 None을 반환해 양쪽 단언 통과.
- overfit·regression 관점: `test_runshell_use_environ`이 `[None, {}]` 두 케이스를 모두 도는 paired-input 구조라 "빈 dict만 None으로" 같은 special-case 통과를 막는다 — overfit 위험 낮음. PASS_TO_PASS = 0이라 인접 동작 회귀 압력은 없으나, postgresql 외 다른 백엔드(mysql/oracle/sqlite client)의 기존 반환 기대를 깨면 안 되므로 base 변경은 그들에게도 안전한(빈→None) 방향이라는 점이 일반화의 근거.

## 모범답안 (오라클 기반)
1. **Localize 경로.** 이슈의 "postgresql client returns empty dict instead of None for env"와 회귀 커밋 `bbe6fbb` R23-R26 링크 → `django/db/backends/base/client.py`의 `runshell`로 직행. 거기서 `if env:` 분기를 보고, `settings_to_cmd_args_env`가 어디서 `{}`를 반환하는지 역추적 → `django/db/backends/postgresql/client.py`의 `env = {}` 누적 반환을 발견. 두 파일이 호출자/피호출자 쌍.
2. **픽스와 일반화 근거.** 핵심 통찰: `subprocess.run(env=None)`은 부모 `os.environ` 상속, `env={}`는 빈 환경. 따라서 "추가 env 없음"은 `{}`가 아니라 `None`으로 표현해야 한다. base에서 `... if env else None`로 빈 경우 None을 넘기고, postgresql에서 `env or None`으로 반환을 정규화. 이는 special-case가 아니라 모든 백엔드/모든 "추가 env 없음" 상황에 일관 적용되는 계약이라 올바른 일반화다.
3. **Regression 안전.** PASS_TO_PASS가 비어 있어 명시적 trap은 없지만, base 변경은 mysql/oracle/sqlite 등 다른 클라이언트의 `runshell`에도 영향. 이들이 env가 있을 때 `{**os.environ, **env}`를 그대로 받고 없을 때 None을 받는 건 모두 정상 상속 동작이므로 안전. postgresql 테스트 기대값을 `{}`→`None`으로 갱신한 것과 호출자 정규화가 일관돼 모순 없음.
4. **함정 회피.** 오라클 없는 에이전트의 전형적 실패: (a) base의 `runshell`만 `... if env else None`로 고치고 만족 — 동작은 맞지만 `dbshell/test_postgresql.py`의 `test_nopass`/`test_parameters`가 반환값 `None`을 기대하므로 부분 실패. (b) `{}`와 `None`을 동치로 취급해 `if env is not None:` 같은 잘못된 가드를 넣으면 빈 dict가 여전히 통과. 회피법: subprocess `env` 시맨틱(None=상속, {}=빈)을 명확히 구분하고, FAIL_TO_PASS가 postgresql 반환 계약(`None`)까지 요구함을 인지해 **두 파일 모두** 정규화할 것.
