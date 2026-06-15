---
instance_id: django__django-10999
repo: django/django
base_commit: 36300ef336e3f130a0dadc1143163ff3d23dc843
version: "3.0"
difficulty: <15 min fix
created_at: 2019-02-16T07:44:50Z
fail_to_pass: 2
pass_to_pass: 10
gold_files: [django/utils/dateparse.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S4)
knowledge: K-Gen
flags: [overfit-risk, regression-trap, has-repro]
---

# django__django-10999

## 문제 요약
`parse_duration()`이 일부 음수 duration 문자열을 잘못 파싱한다. `django/utils/dateparse.py`의 `standard_duration_re` 정규식에서 `hours` 그룹 뒤 lookahead `(?=\d+:\d+)`에 `-?`가 없어, `-1:15:30` 같이 시/분/초가 모두 음수여야 하는 형식이 매칭되지 않거나 부호가 일관되지 않게 적용된다. 또한 각 필드(`hours`/`minutes`/`seconds`)에 개별 `-?`가 붙어 있어 콜론 뒤 마이너스(`-01:-01`)처럼 의미상 무효인 입력까지 통과한다. 합의된 의도는 "선행 `-` 하나가 전체 duration을 음수화"하고, 내부(콜론 뒤) 마이너스는 비유효(`None`)라는 것이다(`-01:01` => -61초, `-01:-01` => None).

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement이 `django/utils/dateparse`의 `standard_duration_re`를 정규식 리터럴째 인용하고, 깨진 라인(`hours` lookahead에 `-?` 부재)까지 지목한다. grep 한 방, 탐색 비용 거의 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S4 Counterexample-Guided)** — 고칠 위치는 자명하나, **올바른 정규식 구조를 의미 추론으로 합성**해야 한다. problem_statement이 제시한 "제안된 fix"(`(?=-?\d+:-?\d+)`)는 틀렸다 — 그걸 그대로 적용하면 `-01:-01` 같은 비유효 입력까지 통과한다. 골드는 그 제안을 따르지 않고 "선행 부호는 전체에, 내부 부호는 금지"라는 불변식을 재구성해 개별 `-?`를 제거하고 단일 `(?P<sign>-?)` 그룹을 도입한다. 이는 "조건을 생각으로 합성"하는 S2의 전형. 보조로 S4 — F2P 테스트가 부호 의미를 과소명세하기 쉬워(예: `sign` 없이 lookahead만 패치해도 일부 케이스 통과), `-01:-01 => None` 같은 **구별용 반례**를 통과해야만 올바른 일반화임이 드러난다.
- **K (Knowledge) = K-Gen** — 순수 정규식 + 일반 파이썬 추론으로 충분. django ORM/migrations 같은 프레임워크 내부지식 불필요. `parse_duration()`이 `sign` 그룹을 곱셈으로 소비하는 흐름만 일반적으로 추적하면 된다.
- **primary type = T-ConstraintReason** — L0로 위치는 명확하나 난점이 "올바른 정규식 식을 추론으로 합성"(개별 부호 제거 + 단일 sign 그룹)하는 데 있다. S1 기계적 가드가 아니라 의미 재정의이므로 T-DirectMap이 아니고, 위치 탐색이 어렵지 않아 T-DiffuseLoc도 아니다.

## 난이도 티어
**Tier = T3 (중간).** 공식 라벨은 `<15 min fix`(즉 prior로는 T1~T2). 이를 T3로 상향하는 구조적 피처:
- **단일 파일·단일 정규식, ~6줄** + has-repro(정규식·예시 입력 명시) → 본래 매우 쉬운 쪽으로 민다(T1 신호).
- 그러나 **S2/S4 추론 난점**이 시간라벨에 안 잡힌다: problem_statement이 제시한 "제안된 fix"가 **함정(틀린 답)**이라, 그대로 복붙하는 순진한 에이전트는 `-01:-01 => None`에서 실패한다. 올바른 일반화는 부호 의미를 재설계(`sign` 그룹)해야 하므로 기계적 1줄 수정이 아니다.
- **overfit-risk + regression-trap**: F2P가 부호 의미를 얇게 명세할 수 있고(special-case 통과 위험), P2P 10개(양수 duration·iso8601·postgresql·fractions 등)를 모두 보존해야 한다. 부호 처리를 바꾸면 양수 경로 회귀가 쉽게 난다.
- 공식 "개발자 구현시간"은 정답을 아는 코어 개발자 기준이라 짧지만, **오라클 없는 에이전트 관점**에선 함정 회피 + 부호 소비부 확인 + 회귀 안전까지 따져야 해 중간 난이도(T3)가 방어 가능하다.

## 골드패치 분석
- **건드린 파일/함수**: `django/utils/dateparse.py` — 모듈 레벨 `standard_duration_re` (정규식 리터럴 1개).
- **근본 원인**: 각 시간 필드 `hours`/`minutes`/`seconds`에 개별적으로 `-?`가 붙어 있고, `hours` lookahead `(?=\d+:\d+)`에는 부호가 없어 **비대칭**이었다. 그래서 (1) 시/분/초가 모두 음수여야 하는 형식이 lookahead 불일치로 안 잡히고, (2) 선행 `-`가 전체 값을 음수화하는 게 아니라 콜론 뒤 개별 부호처럼 들쭉날쭉 동작하며, (3) `-01:-01` 같은 의미상 무효 입력까지 통과했다.
- **수정 요지**: 개별 필드의 `-?`를 모두 제거(`hours`/`minutes`/`seconds`는 `\d+`만 남김)하고, 정규식 맨 앞 `days` 그룹 뒤에 단일 `(?P<sign>-?)` 캡처 그룹을 도입했다. 이로써 (a) 선행 마이너스 하나가 전체 duration의 부호로 통일되고, (b) 콜론 뒤 마이너스는 `\d+`만 허용되므로 더 이상 매칭되지 않아 `-01:-01 => None`, (c) lookahead `(?=\d+:\d+)`도 부호 없는 숫자와 정합. 부호 적용은 `parse_duration()`이 `sign` 그룹을 읽어 전체 `timedelta`에 곱하는 기존 흐름이 처리한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_negative`, `test_parse_postgresql_format`.
- **동작/픽스 증명**: `test_negative`가 기댓값을 갈아끼워 "선행 부호 = 전체 음수" 규칙을 입력→출력으로 못박는다. `-15:30` => `minutes=-15, seconds=-30`(이전엔 `seconds=+30`으로 부호 불일치), `-1:15:30` => `hours=-1, minutes=-15, seconds=-30`. 신규 케이스 `-00:01:01` => -61초, `-01:01` => -61초로 전체-음수화를 증명하고, **`-01:-01` => `None`**으로 콜론 뒤 마이너스가 비유효임을 못박는다. 이 마지막 케이스가 "lookahead에 `-?` 추가" 식 순진한 패치를 **반례로 reject**하는 결정적 가드다.
- **overfit 관점**: F2P가 음수 입력 다수 + None 경계까지 포함해 special-case 통과 여지를 좁혔다(overfit-risk는 있으나 `-01:-01 => None` 반례가 상당 부분 차단). 부호 의미만 맞추고 lookahead/필드 부호 정합을 빠뜨리면 일부 케이스에서 깨진다.
- **regression 관점**: P2P 10개(`test_days`/`test_seconds`/`test_minutes_seconds`/`test_hours_minutes_seconds`/`test_fractions_of_seconds`/`test_iso_8601`/`test_parse_python_format` 등)가 양수·iso8601·python format 경로를 보존하도록 강제한다. 양수 duration은 `sign`이 빈 문자열로 매칭돼 곱셈이 항등이어야 회귀가 없다 — 골드는 이를 만족.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement이 `django/utils/dateparse`의 `standard_duration_re`를 리터럴째 인용하고 깨진 라인(`hours` lookahead `-?` 부재)을 지목 → 곧장 `django/utils/dateparse.py`의 모듈 레벨 정규식과 그 소비처 `parse_duration()`으로 수렴. 탐색 거의 불필요(L0).
2. **픽스와 올바른 일반화 이유**: problem_statement의 "제안된 fix"(`(?=-?\d+:-?\d+)`)를 **따르지 않는다**. 대신 hints의 Tim/Adam 합의("선행 `-`만 유효, 콜론 뒤 `-`는 무효")를 불변식으로 채택 → 개별 필드 `-?` 제거 + 단일 `(?P<sign>-?)` 도입. 이게 overfit이 아닌 일반화인 이유: 단일 sign 그룹이 모든 입력에 대해 "전체 값 부호화"라는 **일관된 의미**를 강제하고, 내부 마이너스를 문법적으로 배제해 무한한 음수 입력공간 전체에 대해 옳다(특정 테스트값에 맞춘 special-case가 아님).
3. **regression 안전**: P2P의 양수·iso8601·postgresql·python-format·fractions 경로를 안 깨야 한다. 핵심은 `sign`이 빈 매칭일 때(양수) 부호 곱이 항등이어야 한다는 점 — `(?P<sign>-?)`는 0회 매칭 시 빈 문자열이고 `parse_duration()`이 이를 음수화로 해석하지 않으므로 양수 경로가 보존된다. 또 `\d+`로 좁힌 필드가 기존 양수 형식 매칭을 깨지 않는지 확인(깨지 않음).
4. **함정 회피**: (a) problem_statement의 제안 패치를 복붙하면 `-01:-01 => None`에서 실패 — "이슈가 적어준 fix"를 맹신하지 말고 hints의 의미 합의를 우선할 것. (b) 정규식만 고치고 `parse_duration()`이 `sign` 그룹을 실제로 곱셈에 소비하는지 점검 안 하면 부호가 무시될 위험 — 소비부 wiring 확인 필수. (c) `test_negative`의 기댓값이 `seconds=+30 → -30`으로 **뒤집힌** 점을 놓치면 "기존 동작 보존"으로 오판해 잘못된 패치를 정답으로 착각하기 쉽다.
