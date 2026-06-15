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
---

# django__django-10999

## 문제 요약
`parse_duration()`이 일부 음수 duration 문자열(예: `-1:15:30`, `-00:01:01`)을 제대로 파싱하지 못한다. `standard_duration_re` 정규식의 `hours` 그룹 뒤 lookahead `(?=\d+:\d+)`에 `-?`가 없어서 음수 시간이 포함된 형식이 매칭되지 않거나, 각 필드에 개별적으로 `-?`가 붙어 있어 부호가 일관되지 않게 적용됐다. 사용자는 선행 `-` 하나가 전체 값을 음수화하기를 기대한다(`-01:01` => -61초).

## 유형 분류
- 버그 카테고리: edge-case / validation (정규식 부호 처리)
- 서브시스템: django.utils dateparse (duration 파싱)
- 증상 타입: silent-wrong / 매칭 실패 (잘못된 timedelta 또는 None)
- 로컬라이제이션 신호: problem_statement이 `django/utils/dateparse`의 `standard_duration_re`를 직접 인용하고 깨진 정규식 라인까지 명시 → 단일 파일·단일 정규식으로 곧장 연결됨.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/dateparse.py` : 모듈 레벨 `standard_duration_re` (정규식 리터럴)
- 근본 원인: 각 시간 필드(`hours`/`minutes`/`seconds`)에 개별적으로 `-?`가 붙어 있어, lookahead에는 부호 처리가 없는 비대칭 상태였다. 그래서 선행 `-`가 "전체 값"을 음수화하는 게 아니라 콜론 뒤 개별 부호처럼 들쭉날쭉 동작했다.
- 수정 요지: 개별 필드의 `-?`를 모두 제거(`hours`/`minutes`/`seconds`는 `\d+`만)하고, 맨 앞에 단일 `(?P<sign>-?)` 캡처 그룹을 도입했다. 이로써 선행 마이너스 한 개가 전체 duration의 부호로 통일되고, 콜론 뒤 마이너스(`-01:-01`)는 더 이상 매칭되지 않아 `None`이 된다. 부호 적용은 `parse_duration()`이 `sign` 그룹을 읽어 전체 값에 곱하는 기존 흐름이 처리한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_negative`, `test_parse_postgresql_format`
- `test_negative`가 기댓값을 바꿔 부호 통일을 증명한다: `-15:30` => `minutes=-15, seconds=-30`(이전엔 seconds가 +30), `-1:15:30` => `hours=-1, minutes=-15, seconds=-30`. 신규 케이스: `-00:01:01` => -61초, `-01:01` => -61초, 그리고 `-01:-01` => `None`(콜론 뒤 마이너스는 비유효). 즉 "선행 `-` = 전체 음수, 내부 `-` = 무효" 규칙을 입력→출력으로 못박는다.

## 공략 포인트 (뭘 조져야)
- localization: problem_statement이 파일·정규식·깨진 라인을 그대로 줘서 거의 free. `standard_duration_re`만 보면 된다.
- 함정: 단순히 lookahead에 `-?`를 추가하는 problem_statement의 "제안된 fix"를 그대로 따르면 안 된다. 그건 `-01:-01` 같은 잘못된 입력까지 통과시켜 오답이다. 골드는 오히려 개별 `-?`를 빼고 단일 `sign` 그룹으로 의미를 재정의한다(hints의 Tim 코멘트가 이 결정을 설명).
- 우리 에이전트 관점: 제안된 패치를 복붙하면 `-01:-01 => None` 케이스에서 실패한다. 또 `sign` 그룹을 도입하면 `parse_duration()`이 이 그룹을 실제로 소비하는지(전체 값에 부호 적용) 확인해야 한다 — 정규식만 고치고 소비부를 점검 안 하면 `sign`이 무시될 위험. 테스트 기댓값이 +→-로 뒤집힌 점을 놓치면 "기존 동작 보존"으로 잘못 판단하기 쉽다.
