---
instance_id: django__django-13809
repo: django/django
base_commit: bef6f7584280f1cc80e5e2d80b7ad073a93d26ec
version: "4.0"
difficulty: 15 min - 1 hour
created_at: 2020-12-24T15:31:35Z
fail_to_pass: 1
pass_to_pass: 245
gold_files: [django/core/management/commands/runserver.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

# django__django-13809

## 문제 요약
`runserver` 커맨드는 매 실행/리로드마다 `inner_run`에서 시스템 체크를 강제로 수행한다. 큰 프로젝트에서는 이게 15-20초씩 걸려 개발 중 reload가 매번 느려진다. 다른 management 커맨드들은 이미 `BaseCommand`의 `--skip-checks` 경로를 통해 체크를 끌 수 있는데 `runserver`만 자체 `inner_run` 경로라 그 혜택을 못 받는다. 일관성과 개발 생산성을 위해 `runserver`에도 `--skip-checks` 옵션을 추가해 달라는 기능 요청(feature, 결함 아님)이다. 사용자는 CI/CD에서만 체크를 켜고 로컬에서는 끄고 싶어한다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** problem_statement가 "runserver command"와 "--skip-checks option"을 제목과 본문에 그대로 박아준다. `grep "Performing system checks"` 또는 `runserver.py`의 `self.check()` 호출 한 방으로 정확한 수정 지점(`add_arguments` + `inner_run`)에 도달한다. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S5 Spec-Inference 보조).** 이슈가 픽스 형태를 사실상 명세한다("--skip-checks 옵션을 추가하라"). 결함클래스가 "정형화된 옵션 추가 + 가드"라 템플릿 매칭에 가깝다 → S1이 dominant. 보조로 S5가 약하게 붙는 이유: 이슈 본문이 "어디까지 건너뛸지"는 명시하지 않아(시스템 체크만? migration 체크까지?) **다른 커맨드의 `--skip-checks` 관례와 기존 동작 계약에서 스펙을 재구성**해야 정확히 "system check만 끄고 `check_migrations()`는 유지"라는 경계를 맞출 수 있다. 이 경계는 코드만으론 자명하지 않고 django의 관례 지식에서 온다.
- **K (Knowledge) = K-Domain.** 일반 파이썬으로 `if` 가드 한 줄은 쓸 수 있지만, "왜 `add_arguments`에 명시 추가가 필요한가"(runserver는 표준 `requires_system_checks`/`handle` 흐름이 아니라 `inner_run`을 거치므로 `BaseCommand`의 `--skip-checks` 처리에 무임승차 불가), "어디까지 끄는 게 올바른가"(migration 체크 유지)는 django management command 내부 구조 지식이 필요하다. argparse 일반 지식만으로는 `options['skip_checks']` KeyError나 과잉 비활성화로 오답을 낸다.

**primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적인 "옵션 추가 + boolean 가드"(S1)다. 추론 합성(S2)이나 후보 반복(S3/S4)이 아니라, 정형 패턴을 정확한 자리에 끼우는 매핑이 본질이라 T-DirectMap. (도메인 지식이 끼지만 병목이 "지식 검색"이 아니라 "옵션→가드 매핑"이라 T-DomainBound보다 T-DirectMap이 더 방어가능.)

## 난이도 티어
**T2 (쉬움).** 미는 구조적 피처:
- **1파일·소규모.** gold patch는 `runserver.py` 단일 파일, 실질 +8줄(옵션 1개 + `if` 가드). 1파일·<10줄은 가장 쉬운 구조 컷(≈48% solve 구간)에 속함.
- **L0 직접 localize + S1 기계적 픽스.** 찾는 비용도, 픽스 합성 비용도 낮다.
- **가벼운 스펙 경계 1개.** "migration 체크는 유지"라는 엣지가 하나 있어 순수 T1(존나쉬움, 이슈가 픽스를 거의 그대로 적어줌)보다 한 단계 위다. 이 경계를 놓치면 P2P가 깨진다.
- **regression-trap.** P2P가 245개로 넓고, 그중 migration warning 계열(`test_migration_warning_one_app`, `..._multiple_apps`, `check_migrations doesn't choke...`)이 `check_migrations()`를 가드에 잘못 넣으면 깨진다.

**공식 라벨("15 min - 1 hour")과 일치 방향.** 공식 라벨은 개발자 구현시간 기준이고, 여기선 옵션 정의 + 가드 + 테스트라 30분급이 타당하다. 에이전트 관점에서도 localize가 자명(repro성 신호는 없지만 이슈가 파일을 지목)해 라벨보다 더 어렵게 볼 이유가 없다. T1로 내리지 않은 건 migration 유지라는 스펙 경계 + 넓은 P2P trap 때문이고, T3 이상으로 올리지 않은 건 추론 합성/멀티사이트/깊은 도메인 탐색이 전부 없기 때문이다.

## 골드패치 분석
- **건드린 파일/함수:** `django/core/management/commands/runserver.py` → `Command.add_arguments`, `Command.inner_run`.
- **근본 원인:** `inner_run`이 `self.stdout.write("Performing system checks...")` + `self.check(display_num_errors=True)`를 무조건 호출하고, 이를 끌 CLI 인자가 정의돼 있지 않다. 다른 커맨드는 `BaseCommand`의 표준 `--skip-checks`/`requires_system_checks` 플로우로 체크를 건너뛰지만, `runserver`는 자체 `inner_run` 경로라 그 메커니즘을 타지 않아 옵션이 비어 있었다.
- **수정 요지:**
  1. `add_arguments`에 `parser.add_argument('--skip-checks', action='store_true', help='Skip system checks.')` 추가 — `options['skip_checks']`가 항상 존재하도록 보장(KeyError 방지).
  2. `inner_run`에서 `"Performing system checks..." write` + `self.check(...)` 두 줄을 `if not options['skip_checks']:` 가드로 감싼다. 플래그가 켜지면 출력과 체크가 함께 사라진다.
  3. `check_migrations()`는 **가드 밖에 그대로** 둬서 마이그레이션 경고는 항상 수행(기존 주석 "Need to check migrations here..."가 의도를 명시).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_skip_checks (admin_scripts.tests.ManageRunserver)`.
- **픽스 증명:** 테스트는 `runserver.run`, `BaseCommand.check_migrations`, `BaseCommand.check`를 mock한 뒤 양방향을 검증한다. (a) `call_command('runserver', use_reloader=False, skip_checks=True)` → 출력에 `'Performing system checks...'`가 **없고** `mocked_check.assert_not_called()`. (b) 같은 호출을 `skip_checks=False`로 → 메시지가 **있고** `mocked_check.assert_called()`. 즉 플래그 ON/OFF 양쪽 동작을 paired-control로 잡아, 가드를 거꾸로 달거나(`if options[...]`) 무조건 끄는 오답을 모두 잡는다.
- **overfit 관점:** F2P가 1개뿐이라 표면적으로는 얇지만, 그 1개가 ON/OFF 양방향 + 메시지 + 실제 `check` 호출 여부를 동시에 단언해 special-case 통과 여지가 작다. 다만 `check_migrations`도 mock으로 잡혀 있어 "migration 체크를 같이 꺼도 이 테스트는 통과"하는 빈틈이 있다 → 그 회귀는 F2P가 아니라 P2P(migration warning 계열)가 막는다.
- **regression 관점:** P2P 245개 중 `ManageRunserverMigrationWarning`/`check_migrations` 계열이 핵심 가드레일. `check_migrations()`를 가드 안에 넣으면 `skip_checks` 무관하게 migration 경고가 사라져 이들이 깨진다. 나머지 P2P(autoreload/admin_scripts 대량)는 본 변경과 무관해 minimal-diff면 안전.
- (test_autoreload.py의 `autoreload._exception = None` finally 추가는 본 픽스의 행위검증이 아니라 전역 상태 누수를 막는 **테스트 격리 보강**이다.)

## 모범답안 (오라클 기반)
1. **localize 경로.** 이슈 제목 "Add --skip-checks option to the runserver command" → `django/core/management/commands/runserver.py` 직행. 그 안에서 (a) `add_arguments`(인자 정의 위치)와 (b) `inner_run`의 `self.check(display_num_errors=True)` + `"Performing system checks..."` write 라인을 수정 타깃으로 확정. 기존 `--noreload` 인자가 `add_arguments`에 어떻게 등록됐는지 보면 추가 패턴이 그대로 드러난다.
2. **픽스 & 올바른 일반화.** `--skip-checks`를 `action='store_true'`로 추가하고, `inner_run`에서 system check 두 줄만 `if not options['skip_checks']:`로 감싼다. 이게 overfit이 아닌 이유: 다른 management 커맨드의 `--skip-checks` 의미(시스템 체크만 스킵, 다른 사전조건은 유지)와 **동일 시맨틱**을 재현하므로 테스트 1개를 넘어 프레임워크 관례에 일반화된다. 옵션을 `add_arguments`에 명시 추가하는 것도 단순 편의가 아니라, `runserver`가 `BaseCommand`의 `--skip-checks` 흐름을 타지 않으므로 `options['skip_checks']` 키 존재를 보장하는 필수 조치다.
3. **regression 안전.** `check_migrations()`는 반드시 가드 밖에 남긴다 — 이게 P2P의 `test_migration_warning_one_app/_multiple_apps`, "check_migrations doesn't choke..." 들을 보호한다. 또 system-check 메커니즘 자체(`BaseCommand.check`, `requires_system_checks`)는 손대지 않는다(autoreload/admin_scripts 대량 P2P 보호). 변경을 runserver.py 단일 파일·최소 헌크로 가두면 245개 P2P 표면에 닿지 않는다.
4. **함정 회피.** 오라클 없는 에이전트의 전형적 오답 3가지: (i) **과잉 비활성화** — `check_migrations()`까지 가드에 넣어버림(F2P는 mock 때문에 통과하지만 P2P migration 경고가 깨짐). (ii) **인자 누락** — `BaseCommand`에 `--skip-checks`가 이미 있다고 믿고 `add_arguments` 추가를 빼면, runserver는 그 흐름이 아니라서 `options['skip_checks']` KeyError. (iii) **가드 방향 오류** — `if options['skip_checks']:`로 거꾸로 달면 skip_checks=False일 때 체크가 안 돼 paired-control 테스트의 후반부가 깨짐. 회피법: "system check 두 줄만, `not` 가드로, migration은 유지, 단일 파일 최소 diff"라는 4-제약을 동시에 만족시키는 것.
