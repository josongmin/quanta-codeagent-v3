---
instance_id: django__django-14376
repo: django/django
base_commit: d06c5b358149c02a62da8a5469264d05f29ac659
version: 4.0
difficulty: <15 min fix
created_at: 2021-05-10T20:42:18Z
fail_to_pass: 3
pass_to_pass: 6
gold_files: [django/db/backends/mysql/base.py, django/db/backends/mysql/client.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L3
repair_strategy: S1 (+S2)
knowledge: K-API
flags: [regression-trap, cross-file-dep]
---

# django__django-14376

## 문제 요약
Django MySQL 백엔드가 `mysqlclient`에 연결 파라미터를 넘길 때 `db`, `passwd` kwargs를 사용하는데, mysqlclient가 이 두 키를 deprecated 처리하고 `database`, `password`를 권장한다. mysqlclient 1.3.8부터 새 키를 지원하고 Django가 요구하는 최소 버전이 그보다 높으므로, deprecation 경로를 피하기 위해 새 키 이름으로 교체해 달라는 요청이다. problem_statement는 `django/db/backends/mysql/base.py#L202-L205`를 직접 링크로 지목하고 `db`/`passwd` 문자열까지 박아준다.

## 유형 (정형화)
- **L (Localization) = L3 (Multi-site).** 이슈가 base.py 라인을 핀포인트로 찍어주지만(그 부분만 보면 L0), 실제 골드는 base.py와 client.py **두 파일을 함께** 바꿔야 하고 FAIL_TO_PASS 3개가 전부 `dbshell.test_mysql`이다. 즉 채점의 무게중심이 이슈가 지목하지 **않은** client.py에 있어, 진짜 localize 난점은 "두 번째 사이트를 스스로 발견"하는 데 있다 → L3. 한줄근거: 픽스가 ≥2 파일에 조율되어 함께 들어가야 하고, 그 중 하나는 이슈 포인터 밖이다.
- **S (Repair Strategy) = S1 (Direct-Map) + 보조 S2 (Constraint-Reasoning).** base.py는 `kwargs['db']→kwargs['database']`, `kwargs['passwd']→kwargs['password']`의 순수 기계적 키 리네임 = 정형 결함클래스(deprecated-API 치환)에 템플릿 매칭하는 S1. 다만 client.py의 `OPTIONS.get('database', OPTIONS.get('db', NAME))` 3단 폴백은 "새 키 우선 → deprecated 키 → NAME" 우선순위를 **추론으로 합성**해야 하므로 보조축 S2가 붙는다(단순 sed 치환이 아니라 하위호환 불변식을 따져야 함). 한줄근거: dominant는 명세대로의 직역 치환(S1)이지만, dbshell 폴백은 deprecated/non-deprecated 공존 시 우선순위를 의미추론으로 짜야 한다.
- **K (Knowledge) = K-API.** mysqlclient의 공개 kwargs 계약(`db`/`passwd` deprecated, `database`/`password` 권장, 1.3.8+ 지원)과 Django의 하위호환(기존에 `OPTIONS:{db:...}`로 설정한 사용자를 깨지 않음)을 정확히 맞춰야 한다. 일반 파이썬 추론(K-Gen)이 아니라 외부 API 계약·deprecation 정합이 병목 → K-API.
- **primary type = T-DirectMap.** 위치가 (이슈+테스트로) 명확하고 dominant 픽스가 S1 기계적 키 치환이다. L3로 다소 흩어져 있으나 그건 "조율된 design 변경"(T-DesignRefactor)도 "어디인지 미궁"(T-DiffuseLoc)도 아니다 — 두 사이트 모두 동일한 한 가지 변환(deprecated 키→새 키)을 적용하는 평행 치환이라 본질은 Direct-Map이다.

## 난이도 티어
**T3 (중간).** 공식 difficulty 라벨은 `<15 min fix`(prior로는 T1~T2)이지만 에이전트 관점에서 한 단계 올려 T3로 본다. 근거:
- **파일수/줄수:** 2파일·~8줄(base 2헌크급 + client 2헌크). 줄수 자체는 작아 T1~T2 쪽 신호.
- **localize 직접성(상향 압력):** 이슈가 base.py만 핀포인트하고 client.py는 **언급하지 않는다**. 그런데 FAIL_TO_PASS 3개가 전부 `dbshell.test_mysql` = client.py 경로다. base.py만 고치고 종료하면 0/3. "이슈가 안 짚어준 두 번째 사이트를 테스트 도메인(dbshell)에서 역추적"하는 게 핵심 난점이고, 이 false-easy 함정이 T1에서 T3로 미는 주된 피처다.
- **repro:** 네이티브 스택트레이스/재현코드 없음(deprecation은 silent). has-repro 부재 → easiness 신호 없음, 상향.
- **도메인:** django db backend + mysqlclient API 계약(K-API). 얕지만 외부 라이브러리 deprecation 맥락 필요.
- **P2P trap(regression):** PASS_TO_PASS 6개가 같은 `MySqlDbshellCommandTestCase`에 몰려 있고(`test_basic_params_specified_in_settings`, `test_can_connect_using_sockets`, `test_crash_password_does_not_leak`, `test_options_charset`, `test_ssl_certificate_is_added` 등), 변수명 `db→database` 리네임 시 하단 `if db:` 분기를 놓치면 인접 dbshell 동작이 깨진다. 좁지만 실재하는 trap → 중간 압력.

종합하면 줄수는 작지만 "이슈 포인터 밖 두 번째 사이트 발견 + deprecated 하위호환 폴백 + 인접 dbshell P2P 보호"가 겹쳐 단순 T1 한 줄 치환이 아니다. 공식 라벨과 다른 이유: 공식 시간라벨은 **gold를 이미 아는 개발자의 구현시간**이라 "client.py를 빠뜨리는 localize 함정"이 시간에 안 잡힌다 — 에이전트는 바로 여기서 0/3을 맞는다.

## 골드패치 분석
- **건드린 파일·함수:**
  - `django/db/backends/mysql/base.py` → `DatabaseWrapper.get_connection_params`
  - `django/db/backends/mysql/client.py` → `DatabaseClient.settings_to_cmd_args_env` (classmethod)
- **근본 원인:** base.py가 mysqlclient 연결 시 `kwargs['db']` / `kwargs['passwd']`를 채워 mysqlclient가 deprecated 마킹한 인자 경로를 탄다. client.py(dbshell)는 `OPTIONS`에서 옛 키 `db`만 조회(`OPTIONS.get('db', NAME)`)해 사용자가 새 키 `database`로 설정해도 인지하지 못한다.
- **수정 요지:**
  - base.py: `kwargs['db'] = NAME` → `kwargs['database'] = NAME`, `kwargs['passwd'] = PASSWORD` → `kwargs['password'] = PASSWORD`. 순수 키 리네임.
  - client.py: `db = OPTIONS.get('db', NAME)` → `database = OPTIONS.get('database', OPTIONS.get('db', NAME))`로 중첩 폴백 도입(새 키 `database` 우선 → deprecated `db` → `settings_dict['NAME']`). 동시에 로컬 변수 `db`를 `database`로 리네임하고, 명령 인자 추가 분기 `if db: args += [db]` → `if database: args += [database]`로 일관 교체. (password/passwd는 base 동일 패턴이나 client에서는 기존에 이미 `OPTIONS.get('password', OPTIONS.get('passwd', PASSWORD))` 폴백이 있어 이번 헌크 대상은 database 쪽.)

## 검증 (test_patch)
대상: `tests/dbshell/test_mysql.py`, `MySqlDbshellCommandTestCase`.
- **FAIL_TO_PASS (3개):**
  - `test_options_override_settings_proper_values`: `OPTIONS` 키를 `('database','password')`와 `('db','passwd')` 두 조합으로 `subTest` 순회 → 새 키든 deprecated 키든 양쪽 모두 dbname/password가 명령 인자·env(`MYSQL_PWD`)에 정확히 반영되는지 확인. deprecated 폴백 생존을 강제.
  - `test_options_non_deprecated_keys_preferred` (구 `test_options_password`에서 개명): `OPTIONS`에 `database`/`db`, `password`/`passwd`를 **동시에** 넣고 non-deprecated 값(`optiondbname`/`optionpassword`)이 deprecated 값(`deprecatedoptiondbname`/`deprecatedoptionpassword`)을 이기는지 확인 → 중첩 `get` 폴백 **순서**가 정확해야만 통과.
  - `test_parameters`: 기존 회귀 보호 테스트(파라미터 전달 경로).
- **픽스 증명:** 첫 테스트가 "새 키 단독 동작 + deprecated 키 하위호환"을, 둘째 테스트가 "공존 시 새 키 우선순위"를 못박는다. 골드의 `OPTIONS.get('database', OPTIONS.get('db', NAME))` 중첩 순서가 정확해야만 두 테스트가 동시에 green이 된다.
- **overfit 관점:** FAIL_TO_PASS가 단일 special-case가 아니라 (a)새키단독 (b)구키단독 (c)양키공존-우선순위의 **3축을 교차**로 덮어 overfit 여지가 작다. `'database'` 우선만 하드코딩하고 `db` 폴백을 빼면 첫 테스트의 `('db','passwd')` 조합이 깨지고, 반대로 `db`만 보면 둘째 테스트가 깨진다 → special-case 통과 불가. overfit-risk 낮음(그래서 플래그 미부여).
- **regression 관점:** PASS_TO_PASS 6개가 같은 클래스라 변수 리네임 누락(`if db:`)이나 socket/charset/ssl/password-leak 경로 회귀가 즉시 잡힌다. regression-trap 플래그 부여 근거.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 `base.py#L202-L205` 링크 + "db", "passwd" 문자열 → `get_connection_params`로 직행(L0 부분). **여기서 멈추면 안 됨.** 결정적 신호는 FAIL_TO_PASS가 전부 `dbshell.test_mysql`이라는 점 — 채점 도메인이 base.py가 아니라 dbshell이다. `db`/`passwd`/`OPTIONS` 키를 레포 전역 grep하면 `mysql/client.py:settings_to_cmd_args_env`의 `OPTIONS.get('db', NAME)`이 잡힌다. 즉 "이슈 포인터(base) → 테스트 도메인(dbshell) → 두 번째 사이트(client)"로 역추적해야 L3를 완주.
2. **픽스(왜 올바른 일반화인가):** base.py는 명세 그대로 `db→database`, `passwd→password` 치환(S1). client.py는 단순 리네임이 아니라 `OPTIONS.get('database', OPTIONS.get('db', NAME))` 3단 폴백을 새로 만든다. 이게 올바른 일반화인 이유: 기존 사용자가 `OPTIONS:{'db':...}`로 설정해둔 케이스를 **깨지 않으면서**(하위호환) 새 키 `database`를 우선 채택하기 때문. `database`로 단순 교체만 하면 deprecated 키 사용자가 침묵 회귀하고, `db`만 두면 이슈 목적을 못 이룬다 — 두 키를 우선순위로 공존시키는 것이 정확한 스펙.
3. **regression 안전:** PASS_TO_PASS의 socket(`test_can_connect_using_sockets`)·charset(`test_options_charset`)·ssl(`test_ssl_certificate_is_added`)·password-leak(`test_crash_password_does_not_leak`)·기본설정(`test_basic_params_specified_in_settings`)을 깨지 않아야 한다. 핵심 함정은 로컬 변수 `db`를 `database`로 리네임할 때 하단 `if db: args += [db]` 분기를 **함께** 고치는 것 — 누락하면 NameError 또는 빈 인자로 다수 P2P가 동시에 붉어진다.
4. **함정 회피(오라클 없는 에이전트가 틀릴 지점):**
   - **false-easy 종료:** base.py 한 줄만 고치고 "<15분 fix 완료"로 끝내기 → FAIL_TO_PASS 0/3. dbshell 테스트가 채점 핵심임을 놓침. 회피책: 픽스 전에 FAIL_TO_PASS 경로(`dbshell.test_mysql`)를 먼저 읽어 진짜 채점 사이트를 확인.
   - **하위호환 파괴:** client.py를 `OPTIONS.get('database', NAME)`로 평면 치환 → `('db','passwd')` 조합 테스트 깨짐. 회피책: deprecated 키를 fallback에 보존(중첩 get).
   - **우선순위 역전:** `OPTIONS.get('db', OPTIONS.get('database', NAME))`처럼 deprecated를 먼저 조회 → `test_options_non_deprecated_keys_preferred`에서 deprecated 값이 이겨 실패. 회피책: non-deprecated 키를 바깥(우선) get에 둔다.
   - **변수 리네임 부분적용:** 선언만 바꾸고 사용처(`if db:`) 미반영 → P2P 회귀. 회피책: 변수 스코프 전체를 일괄 치환.
