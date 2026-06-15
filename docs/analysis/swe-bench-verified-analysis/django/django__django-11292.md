---
instance_id: django__django-11292
repo: django/django
base_commit: eb16c7260e573ec513d84cb586d96bdf508f3173
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-04-27T14:23:07Z
fail_to_pass: 1
pass_to_pass: 31
gold_files: [django/core/management/base.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-11292

## 문제 요약
관리 명령(management command)은 이미 `skip_checks`라는 stealth 옵션(파서에 정의되지 않은 내부 옵션)을 가지고 있지만, 커맨드라인에서는 노출되지 않는다. 사용자는 `--skip-checks` 플래그를 CLI에서 직접 줘서 시스템 체크를 건너뛰고 싶어한다. 개발 환경에서 system check 에러를 당장 고치지 않고 작업을 진행하기 위한 편의 기능 요청이며, "잘못된 출력" 버그가 아니라 **이미 내부적으로 존재하는 기능을 공개 CLI 인터페이스로 승격**하는 작업이다.

## 유형 (정형화)

**3축 점수**

- **L = L1 (Traceable)** — problem_statement가 "management commands", "skip_checks stealth option"을 명시적으로 지목한다. `skip_checks` / `stealth_options` / `requires_system_checks`를 grep하면 `django/core/management/base.py`의 `BaseCommand`로 단번에 수렴한다. 단, 픽스가 한 클래스 안에서 **4개 site**(`create_parser`의 인자 추가, `base_stealth_options` 정리, `execute`의 옵션 읽기, `DjangoHelpFormatter.show_last` 정렬)에 걸쳐 함께 바뀌어야 해서 L0의 "심볼 한 방"보다는 약간의 내부 구조 파악이 필요 → L1.
- **S = S1 (+S6)** — 이슈가 사실상 픽스를 명세한다("expose this option on the command line"). 핵심은 `parser.add_argument('--skip-checks', action='store_true')` 추가라는 기계적 매핑(Direct-Map)이다. 단순 한 줄이 아니라, 이미 stealth로 존재하던 옵션을 **real argparse 인자로 승격하면서 동반되는 정합성 정리**(stealth 목록에서 제거 + `options.get` → `options[...]` 강건화 + help 정렬)가 따라붙으므로 작은 구조 변경 S6를 보조로 둔다. 추론으로 식을 합성하는 S2도, 테스트로 후보를 수렴시키는 S3/S4도 아니다 — 정답 형태가 결정적이라 overfit 위험이 낮다.
- **K = K-Domain** — django management command 인프라 내부 지식(stealth option 개념, `requires_system_checks` 게이트, `BaseCommand.create_parser`/`execute` lifecycle, argparse 공통 옵션 정렬 규약)을 알아야 "어디에 무엇을 어떤 조건으로" 넣을지 판단된다. 일반 파이썬 추론(K-Gen)만으로는 조건부 추가나 stealth 정리의 필요성을 도출하기 어렵다.

**primary type = T-DirectMap** — 위치가 명확하고(L1) 픽스가 기계적 매핑(S1: stealth 옵션 → CLI 플래그 노출)이다. 진짜 난점이 "어디인지 찾기"(T-DiffuseLoc)도, "올바른 식 추론"(T-ConstraintReason)도, "스펙 재구성"(T-SpecInference)도 아니다. 이슈가 픽스 형태를 거의 적어주는 Direct-Map에 가장 잘 들어맞는다.

**왜 이 repair strategy인가 (APR 관점)** — PAR/TBar 류 템플릿 수리에서 "기존 내부 기능을 공개 인터페이스로 매핑"은 결함 클래스가 아니라 **기능 추가의 정형 패턴**이다. 정답 패치 공간이 사실상 유일(`--skip-checks` store_true)하고, 테스트 피드백 없이도 이슈만으로 패치를 도출할 수 있어 Generate-&-Validate(S3/S4)의 후보 폭발/overfit 위험이 없다. 다만 단일 add_argument로 끝내면 `requires_system_checks=False` 명령에 무의미한 플래그가 붙고 stealth 이중정의가 남으므로, S6(coordinated cleanup)가 정확성에 필수다.

## 난이도 티어

**Tier = T3 (중간)**

이 티어로 미는 구조적 피처:
- **파일/줄수**: 단일 파일(`base.py`) 1개, 4 헌크 ~15줄. ICLR 2024의 "1파일·소규모" 구간(≈48% solve)에 들어 T5 이상은 배제된다.
- **localize 직접성**: L1 — grep으로 바로 수렴하지만 한 클래스 안 4 site를 조율해야 해서 L0 T1/T2의 "한 줄 자명"보다 위.
- **domain 지식(K-Domain)**: 루브릭상 K-Domain이 dominant면 최소 T4 후보지만, 여기서는 도메인 지식이 *깊은 call-chain 추적*이 아니라 *얕은 관용(stealth/requires_system_checks 규약)* 수준이라 T4까지 끌어올리지 않는다.
- **P2P trap (regression-trap)**: PASS_TO_PASS 31개 중 `test_call_command_no_checks`, `test_check_migrations`, "BaseCommand.create_parser() passes kwargs to CommandParser" 등이 `create_parser`/`execute`/`call_command` 경로를 직접 검증한다. `options.get` → `options[...]` 전환과 stealth 제거가 이 경로를 깨면 회귀가 난다 — 이게 T2가 아닌 T3로 올리는 핵심.
- **repro**: 테스트가 깨진 settings + 플래그로 명확한 재현을 제공(has-repro)해 난이도를 낮추는 방향.

**공식 라벨과의 정합** — 공식 difficulty는 "15 min - 1 hour"로 T2~T3 경계. 개발자 구현시간 기준으론 빠른 작업이지만, 에이전트 관점에서 (a) 조건부 추가의 필요성, (b) stealth 목록 정리, (c) call_command 회귀 회피라는 세 가지 정합성 항목이 시간라벨에 안 잡히는 함정이라 T3로 둔다. 공식 라벨보다 한 단계 보수적으로 잡는 이유는 "표면상 한 줄 add_argument"라는 착시 때문이다.

## 골드패치 분석

- **건드린 파일/함수**: `django/core/management/base.py`
  - `DjangoHelpFormatter.show_last` (집합 리터럴) — `'--skip-checks'` 추가
  - `BaseCommand.base_stealth_options` — `('skip_checks', 'stderr', 'stdout')` → `('stderr', 'stdout')`
  - `BaseCommand.create_parser()` — 조건부 `parser.add_argument('--skip-checks', action='store_true', ...)`
  - `BaseCommand.execute()` — `options.get('skip_checks')` → `options['skip_checks']`
- **근본 원인**: `skip_checks`가 stealth option으로만 존재하고 argparse 파서에 정의된 적이 없어 CLI에서 전달할 경로가 없었다. `execute()`는 부재를 견디려 `options.get('skip_checks')`로 안전하게 읽고 있었다(즉 기능 자체는 내부 호출(`call_command`)에서만 쓰였다).
- **수정 요지**:
  1. `create_parser()`에서 `self.requires_system_checks`가 True일 때만 `--skip-checks` (store_true) 인자를 추가 — 체크가 없는 명령엔 무의미한 플래그를 노출하지 않음(조건부가 정확성의 일부).
  2. `skip_checks`가 이제 실제 파서 인자가 되었으므로 `base_stealth_options`에서 `'skip_checks'`를 제거 — 더 이상 stealth가 아니며, 남기면 stealth/real 이중정의로 의미 충돌.
  3. `execute()`에서 `options.get('skip_checks')` → `options['skip_checks']` — `requires_system_checks=True` 명령은 인자가 항상 정의되므로 직접 인덱싱으로 의도(존재 보장)를 드러냄.
  4. `--skip-checks`를 `DjangoHelpFormatter.show_last`에 추가해 help 출력 시 공통 옵션처럼 뒤로 정렬(일관성).

## 검증 (test_patch)

- **FAIL_TO_PASS (1)**: `test_skip_checks (user_commands.tests.CommandRunTests)`
- **동작**: 테스트는 일부러 `STATICFILES_DIRS = '"foo"'`(튜플/리스트 아님)로 `staticfiles.E001` system check 에러가 나도록 settings를 작성한 뒤, `set_option --skip-checks --set foo`를 **실제 서브프로세스**(`run_manage`)로 실행한다.
- **픽스 증명**: `--skip-checks`가 없으면 system check가 E001을 stderr에 뱉어야 하지만, 플래그가 동작하면 `execute()`의 `requires_system_checks and not options['skip_checks']` 게이트가 `self.check()`를 건너뛰어 `assertNoOutput(err)`(에러 없음) + stdout `'Set foo'`가 성립한다. 재현 입력(깨진 settings + 플래그) → 기대 출력(에러 없이 정상 수행)의 인과가 직접 증명된다.
- **overfit 관점**: 정답 패치 형태가 결정적(store_true 플래그 + 게이트 연결)이라 special-case로 통과할 여지가 거의 없다 → overfit-risk 플래그 미부여. 단 FAIL_TO_PASS가 1개뿐이라 "`requires_system_checks=False` 명령엔 플래그가 안 붙는다"는 조건부의 음성 케이스는 직접 검증되지 않는다(얇음). 그래도 잘못 구현하면 PASS_TO_PASS 쪽이 깨지므로 사실상 보호된다.
- **regression 관점**: PASS_TO_PASS 31개가 `create_parser`/`execute`/`call_command` 경로를 광범위하게 덮는다(regression-trap 부여). 특히 `test_call_command_no_checks`는 `call_command`가 `skip_checks`를 처리하는 경로를 검증하므로 stealth 제거와 `options[...]` 전환이 이 경로를 깨지 않아야 한다 — `call_command`는 파서를 거치지 않을 수 있어 `skip_checks` 키 존재 보장이 미묘하다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 "management commands"의 "skip_checks stealth option"을 직접 명명 → `skip_checks` 또는 `stealth_options` 또는 `requires_system_checks`를 grep → `django/core/management/base.py`의 `BaseCommand`로 즉시 수렴. 거기서 옵션이 정의되는 `create_parser()`와 소비되는 `execute()`를 함께 읽으면 "파서엔 없고 execute에서 `.get`으로만 읽힌다"는 비대칭이 드러나 픽스 지점이 확정된다.

2. **픽스와 왜 올바른 일반화인가**: 핵심은 `create_parser()`에 `--skip-checks` (store_true)를 추가해 내부 옵션을 CLI로 승격하는 것. 이를 **`if self.requires_system_checks:` 아래에서만 추가**하는 게 올바른 일반화다 — 체크를 안 하는 명령에 "체크 건너뛰기" 플래그는 무의미/혼란이기 때문. 동반 정리(stealth 목록에서 제거, `execute`의 `.get` → 직접 인덱싱)는 "이제 이 키는 항상 존재한다"는 새 불변식을 코드에 반영하는 것이라 overfit이 아니라 정합성 강화다. 테스트 한 개에만 맞춘 special-case(예: 특정 명령에만 플래그 추가)가 아니라 모든 `requires_system_checks` 명령에 일률 적용하므로 일반적.

3. **regression 안전**: PASS_TO_PASS의 `test_call_command_no_checks`, `test_check_migrations`, `test_command*`, "create_parser() passes kwargs" 등이 깨지면 안 된다. 위험 포인트 — `execute`를 `options['skip_checks']`로 바꾸면 `call_command`가 `skip_checks` 키 없이 부르는 경로에서 KeyError가 날 수 있으나, django는 `call_command` 측에서 `skip_checks` 기본값을 채워주므로(그리고 stealth가 아닌 real default이므로) 안전하다. 조건부 추가를 빠뜨려 `requires_system_checks=False` 명령에 플래그를 달면 그 명령군 테스트가 깨질 수 있다.

4. **함정 회피(오라클 없는 에이전트가 틀릴 지점)**:
   - 함정 A: `parser.add_argument('--skip-checks')` 한 줄만 추가하고 끝내기 → `requires_system_checks=False` 명령에 무의미 플래그가 붙고, stealth 이중정의가 남는다. **회피**: 조건부 추가 + `base_stealth_options`에서 `'skip_checks'` 제거를 한 쌍으로 처리.
   - 함정 B: `execute`의 `.get` → `[...]` 전환을 안 하면 동작은 하지만 의도가 안 드러나고, 반대로 무지성 전환은 `call_command` 경로에서 KeyError 위험. **회피**: `requires_system_checks` 게이트와 `call_command` 기본값 주입을 함께 확인.
   - 함정 C: help 정렬(`show_last`)을 빼먹기 — 기능엔 무관하나 골드의 일관성 항목. 테스트로는 안 잡히지만 SOTA 패치라면 챙김.
   - 함정 D: FAIL_TO_PASS가 1개라 "초록"에 안주하면 조건부 음성 케이스를 놓친 채 overfit성으로 통과할 수 있다 — 자체적으로 `requires_system_checks=False` 명령에 플래그가 안 붙는지 점검하는 게 올바른 마무리.
