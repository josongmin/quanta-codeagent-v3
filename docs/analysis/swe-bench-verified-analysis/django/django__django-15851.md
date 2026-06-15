---
instance_id: django__django-15851
repo: django/django
base_commit: b4817d20b9e55df30be0b1b2ca8c8bb6d61aab07
version: 4.2
difficulty: <15 min fix
created_at: 2022-07-18T01:36:33Z
fail_to_pass: 1
pass_to_pass: 8
gold_files: [django/db/backends/postgresql/client.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

# django__django-15851

## 문제 요약
`./manage.py dbshell -- -c "select * from some_table;"` 처럼 추가 인자를 넘기면 psql이 `extra command-line argument "-c" ignored` 경고를 내고 인자를 무시한다. psql은 모든 옵션이 데이터베이스 이름보다 **앞**에 와야 하는데, Django가 만든 argv는 dbname을 먼저 넣고 사용자 파라미터를 뒤에 붙여서 그렇다. 사용자는 넘긴 `-c` 옵션이 정상 적용되길 기대한다. 이슈 본문은 원인까지 직접 진단한다 — "args list just need to be constructed in the proper order, leaving the database name for the end of the args list."

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈가 "PostgreSQL", "psql", "dbshell"을 직접 지목하고 argv 조립 순서가 원인이라고 못박는다. `django/db/backends/postgresql/client.py`의 `settings_to_cmd_args_env`로 grep 한 방에 수렴. 다른 backend 탐색·데이터플로우 추적 불필요.
- **S (Repair Strategy) = S1 (Direct-Map).** 이슈가 사실상 픽스를 명세한다("leaving the database name for the end"). 결함 클래스는 정형화된 **statement-order bug**(두 append 순서 뒤집기)로, 새 식·조건을 추론으로 합성할 필요가 없다(S2 아님). 후보가 다수라 테스트로 수렴하는 G&V(S3/S4)도 아니다 — 정답 한 줄 이동이 결정론적으로 도출된다.
- **K (Knowledge) = K-Domain.** psql CLI의 인자 규약(옵션이 dbname보다 선행해야 함)이라는 외부 도구 계약 + django DB backend client 레이어 구조를 알아야 "왜 이 순서가 맞는지"를 확신할 수 있다. 순수 일반 파이썬 추론(K-Gen)만으로는 "psql이 dbname 뒤 옵션을 무시한다"를 알 수 없다. 다만 이슈 본문이 이 도메인 사실을 친절히 제공하므로 knowledge 병목은 약하다.
- **Primary type = T-DirectMap.** 위치가 L0로 명확하고 픽스가 S1 기계적(두 줄 swap)이다. T-LocTrivial과의 경계에 있으나, "psql은 옵션 선행" 규약(K-Domain)이 픽스 정당성에 개입하므로 순수 trivial보다 한 단계 위인 DirectMap이 맞다.
- **왜 이 strategy인가 (APR 관점):** PAR/TBar류 템플릿 수리에서 "argument-order / statement-reorder"는 표준 fix pattern이다. 실패 테스트는 정확히 `["psql", "--help", "dbname"]` 순서 한 가지만 통과시키므로 탐색 공간이 단일점으로 수축한다 — generate-&-validate 반복이나 counterexample 합성이 불필요한 전형적 Direct-Map.

## 난이도 티어
**Tier = T2 (쉬움).** 구조적 피처:
- 파일수 1개, 변경 2줄(한 statement를 위로 이동), 단일 함수 `settings_to_cmd_args_env` — 구조적 컷(1파일·<5줄 ≈ 48% solve)에서 가장 쉬운 구간.
- `loc_axis=L0` + `S1` — localize 노력 사실상 0, 픽스 자명.
- `has-repro` — 이슈에 네이티브 psql 경고 출력(`extra command-line argument "-c" ignored`)이 그대로 박혀 있어 가장 강한 easiness 신호.
- P2P trap 약함: PASS_TO_PASS 8개가 모두 파라미터 없음/인증 관련이라 순서 변경에 둔감.

T1(존나쉬움)이 아니라 T2인 이유: K-Gen이 아니라 **K-Domain**(psql 규약)이 픽스 정당성에 끼고, "다른 backend(mysql/oracle/sqlite)도 같은 패턴 → 전부 고쳐야 하나"라는 약한 과교정 유혹이 존재한다. T1의 "이슈가 픽스를 거의 적어줌 + K-Gen" 프로파일에서 knowledge 축 한 칸이 어긋난다.

**공식 라벨(<15 min fix)과 일치.** 개발자 구현시간 기준의 가장 쉬운 라벨이고, 에이전트 관점에서도 localize·overfit·regression 어느 축도 난이도를 끌어올리지 않으므로 재조정 없이 T2 유지.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/backends/postgresql/client.py` : `DatabaseClient.settings_to_cmd_args_env` (classmethod).
- **근본 원인:** argv 조립 시 `if dbname: args += [dbname]`를 먼저 실행한 뒤 `args.extend(parameters)`를 호출했다. 결과 argv가 `[psql, ..., dbname, --help]` 형태가 되어, psql이 dbname 이후에 온 옵션(`-c`, `--help` 등)을 "extra command-line argument"로 보고 무시한다.
- **수정 요지:** 두 statement의 순서를 뒤집는다. `args.extend(parameters)`를 host/port 인자 직후·dbname 추가 **이전**으로 끌어올려, 사용자 파라미터가 먼저 들어가고 dbname이 항상 argv 끝에 오도록 했다. 즉 `[psql, ..., --help, dbname]` 순서. psql의 "옵션 먼저, dbname 마지막" CLI 규약을 충족하는 한 줄 이동(statement-reorder).

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_parameters (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase)`.
- **동작/픽스 증명:** 테스트가 `settings_to_cmd_args_env({"NAME": "dbname"}, ["--help"])`의 기대값을 기존 `(["psql", "dbname", "--help"], None)`에서 `(["psql", "--help", "dbname"], None)`으로 바꾼다. 재현 입력은 dbname + 추가 파라미터 `--help`이고, 기대 출력은 dbname이 argv 마지막에 오는 것. 골드 swap 없이는 이 단언이 실패하므로 픽스를 직접 증명한다.
- **overfit 관점:** FAIL_TO_PASS가 1개(`--help` 단일 파라미터)로 얇아 `overfit-risk`를 의심할 수 있으나, 골드 픽스가 파라미터 개수·내용에 무관한 무조건 reorder(`args.extend(parameters)` 위치 이동)라 special-case 통과 여지가 없다. 따라서 overfit 위험은 실질적으로 없음 → 플래그 제외.
- **regression 관점:** PASS_TO_PASS 8개(`test_basic`/`test_passfile`/`test_service`/`test_ssl_certificate`/`test_crash_password_does_not_leak`/`test_nopass`/`test_accent`/`test_column`)는 파라미터가 비었거나(`parameters=[]` → `extend`가 no-op) 인증·SSL·passfile 환경변수 경로라 argv 내 dbname-vs-parameters 상대순서에 둔감. `regression-trap` 약함.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 "psql"/"PostgreSQL"/"dbshell" + "args list ... constructed in the proper order, leaving the database name for the end" 신호 → `django/db/backends/postgresql/client.py`의 `DatabaseClient.settings_to_cmd_args_env`로 직행. argv를 만드는 블록에서 `args += [dbname]`과 `args.extend(parameters)`의 상대 순서만 확인하면 됨.
2. **픽스와 올바른 일반화:** `args.extend(parameters)`를 dbname 추가 이전으로 이동시켜 dbname이 항상 argv 끝에 오게 한다. 이것이 overfit이 아니라 올바른 일반화인 이유 — psql CLI 계약은 "모든 옵션이 dbname 선행"을 **무조건** 요구하므로, 특정 파라미터(`--help`)가 아니라 임의 `parameters` 전체에 대해 reorder가 정답. 테스트의 단일 케이스를 넘어 도구 규약 수준에서 정당화된다.
3. **regression 안전:** `parameters=[]`인 모든 P2P(basic/nopass/passfile/service/ssl/accent 등)는 `extend([])`가 no-op이라 argv가 바이트 동일하게 유지된다. dbname 자체의 존재(`if dbname`) 가드도 건드리지 않아 NAME 없는 경로도 불변. 따라서 8개 P2P가 깨질 표면이 없다.
4. **함정 회피:** 오라클 없는 에이전트의 오류 후보 — (a) **과교정**: mysql/oracle/sqlite의 `client.py`도 유사 패턴이라 함께 고치고 싶어지나, 이 이슈·골드·테스트는 postgresql만 대상이며 다른 backend의 CLI 규약은 다르다(예: mysql은 옵션 순서 제약이 약함). 범위를 postgresql로 한정해야 함. (b) **잘못된 이동**: `args += [dbname]`를 삭제하거나 parameters를 host/port보다 앞으로 옮기면 다른 argv 순서가 되어 실패. 테스트 기대값이 정확히 `["psql", "--help", "dbname"]`이므로 "parameters를 dbname 직전"이라는 단 하나의 위치만 정답.
