# 🏯 Online_Multiverse — 「산사 (Sansa Temple)」 역공학 분석 및 3D 웹 앱 구현 청사진

> **"말없이 같이 앉아 있는 온라인 절, 산사(山寺)"**  
> `https://sansatemple.com`에 대한 **REA(Reverse Engineer Anything)** 정밀 역공학 조사 보고서 및 이를 바탕으로 한 **실행 가능한 3D 온라인 멀티버스 웹 앱 구현 계획서**입니다.

---

## 📌 프로젝트 개요

**산사(`sansatemple.com`)**는 텍스트 채팅이나 음성 대화 없이, 최대 100명이 같은 서버(방)에 동자승 아바타로 머물며 **합장 인사, 절하기(108배/25배), 염주 돌리기, 목탁 치기, 향 올리기, 차/커피 나눔(CAFE25)**을 수행하는 **침묵 기반 3D 코프레즌스(Silent Co-presence) 웹 공간**입니다.

본 리포지토리(`Online_Multiverse`)는 REA 런타임·네트워크·번들 캡처 도구를 통해 확보한 **100% 실측 증거(Evidence)**를 기반으로 다음 두 가지를 제공합니다:
1. **역공학 심층 분석 문서 패키지 (`docs/01` ~ `docs/03`)**: 프론트엔드/3D 렌더링 최적화, 하이브리드 바이너리 WebSocket 프로토콜(`SNSD`), 수행 상태 머신 및 절차적 Web Audio 사운드 합성 엔진 명세.
2. **실행 가능한 3D 웹 앱 구현 계획서 (`docs/04`)**: 분석된 아키텍처를 바탕으로 `My_SideProject` 표준 기술 스택(`FastAPI` + `Three.js` + `Web Audio API` + Apple HIG 모바일 UX)으로 즉시 구축하기 위한 단계별 설계서.

---

## 🔬 1. REA 실측 증거 레지스트리 (Evidence Ledger)

본 분석의 모든 수치, 프로토콜 바이트 오프셋, 클래스/함수 시그니처는 아래 REA 캡처 증거에 의해 검증되었습니다.

| Evidence ID | 캡처 방식 및 대상 | 주요 확보 아티팩트 및 SHA-256 해시 |
| :--- | :--- | :--- |
| **`ev_4086dde464e9b39caa6eb04e1572ae9c8eab322aa3c4e8a746acbf64241a506d`** | `capture_browser_scenario` (`https://sansatemple.com/`, 라이브 런타임) | • **Live DOM** (`58,662` bytes): `a04d2316f2a9c72870c722a67a50eb80195ffe68365fffde0fda0ab288a4fe10`<br>• **A11y Tree** (`751` bytes): `c2c3dc6f3b0259a28ce3311dc9c367c6a0ec233b3b8c60fd548292488e2b4794`<br>• **Network & WS Events**: 총 `263`개 트랜잭션 및 `wss://sansatemple.com/presence` 핸드셰이크/프레임 |
| **`ev_88ba890507c24458b1f176133a7cf9b7dc45571aafadaf54ee2a7d0410f4bceb`** | `capture_browser_scenario` (코어 JS 모듈 5종 + CSS 번들 원문 추출) | • `index-BbexX-JI.js` (`2,958` bytes): `8c6092976fe5a820b7d4c5e471df16ad240ede69ceee3d7166992af3db4bfe34`<br>• `game-vJmMAgmy.js` (`1,424,255` bytes): `28b2c01b538cb61bb114176ed9f112854c6e50417dcfcac9d5cf876945b1d780`<br>• `presence-worker-D7eFbKrZ.js` (`3,489` bytes): `7be55c92b0e9e0ca22b81f0796bd6bd8a83fa6f3f67375639321b55825ec4cf5`<br>• `safari-scene-bleed-BChFMqZ0.js` (`2,380` bytes): `5924f5dc21a93c7e5d21e4a0db4bf3ff9cb21f68186dcbf78bdcfbd912a9bc1f`<br>• `visible-viewport-BjQS7hnI.js` (`1,105` bytes): `6b71f3eb6e09575c78f85f1379276bc9bf95bbcf6047cd9dc14be54ef706f452`<br>• `game-gKV003n6.css` (`174,897` bytes): `6d87518440e7c8995736345d3ccdc12f53a2a190a437fc1bb72e5df19a6760bd` |
| **`ev_5f4a20b7f2f7716c64312798bd576702bdefaba533dae6bdf6e042e0561b0e69`** | `capture_browser_scenario` (클라우드 폴백 번들, 매니페스트, 룸 API) | • `cloud-presence-DTocDxb1.js` (`242,866` bytes): `eea647608fc2c9169469d939b7639fcb096ce00a4f48b3db2b5845c67f4a520d`<br>• `manifest.webmanifest` (`579` bytes): `0aa8d967278ee6741b39c3a293637d2cb4a3b68ad8ce1595b3662140d59a220d`<br>• `GET /api/rooms?roomLimit=100` (`5,412` bytes): `54c4f5484d079e5555227459d0cf7003497f2cc63c403b868297b819ec85816e` |
| **`ev_a3ae5c262ed40b4c791b85b75a46c9aeb2c0e2ed65bc4411dc22832a80905f90`** | `export_evidence_bundle` (`58,434,222` bytes 전체 에셋 캡처) | • `/v/37821d4f60cfb916c0bd/assets/models/*.glb` (동자승, 삼존불, 소나무, 공양이 고양이) 및 PBR 텍스처 세트 |

---

## 🏛️ 2. 전체 시스템 아키텍처 요약

```mermaid
flowchart TB
  subgraph Browser["클라이언트 런타임 (Browser / PWA)"]
    Entry["index-BbexX-JI.js<br/>진입 게이트 · 폰트 웜업 · 퍼널 비콘"]
    Viewport["visible-viewport & safari-scene-bleed<br/>iOS Safari 동적 뷰포트 & 상단 블리드 보정"]
    Main["game-vJmMAgmy.js<br/>Three.js r180 3D 월드 · 수행 UI · 상태 머신"]
    Audio["class pP (Web Audio API)<br/>절차적 바람/산새 · 432Hz 범종 · 염주/목탁 합성"]
    TabLock["BroadcastChannel('sansa-render-owner-v1')<br/>멀티 탭 단일 WebGL 렌더러 소유권 제어"]
    Worker["presence-worker-D7eFbKrZ.js<br/>Dedicated WebSocket Worker"]
    SupaFallback["cloud-presence-DTocDxb1.js<br/>Supabase Auth + RPC + Realtime 폴백"]

    Entry --> Viewport
    Entry --> Main
    Main --> Audio
    Main --> TabLock
    Main <-->|"Transferable ArrayBuffer / JSON"| Worker
    Main -.->|"Fallback mode"| SupaFallback
  end

  subgraph Edge["Cloudflare Edge 서버 & CDN"]
    PresenceWS["wss://sansatemple.com/presence<br/>(protocol=2, wire=3, SNSD Binary Delta)"]
    RoomsAPI["GET /api/rooms?roomLimit=100<br/>(maru ~ maru-100, 방당 정원 100명)"]
    EntryAPI["POST /api/entry-stage<br/>(진입 단계 텔레메트리)"]
    Assets["/v/37821d4f60cfb916c0bd/assets/*<br/>(GLB 3D 모델 · PBR 텍스처 · 오디오)"]
  end

  Worker <-->|"WebSocket (JSON + Binary 0x534E5344)"| PresenceWS
  Main --> RoomsAPI
  Entry --> EntryAPI
  Main --> Assets
```

---

## 📂 3. 문서 구성 (Documentation Index)

각 문서는 **관측된 팩트(`Observed`)**, **구조적 추론(`Inferred`)**, **미관측 경계(`Unknown`)**를 엄격히 구분하여 작성되었습니다.

1. **[docs/01-architecture-and-rendering.md](file:///Users/bigstone/My_SideProject/online_multiverse/docs/01-architecture-and-rendering.md)**
   - 부트스트랩 파이프라인, 인앱 브라우저 대응, **Three.js r180** 씬 그래프(`garden` 마당 / `hall` 법당), **World Frame Cache**(더티 리전 캐싱: 메쉬 `224`개 / 리전 `54`개), **적응형 프레임 페이서(`class Vy`: 60/30/15 FPS)**, 멀티 탭 `BroadcastChannel` 제어 분석.
2. **[docs/02-presence-wire-protocol.md](file:///Users/bigstone/My_SideProject/online_multiverse/docs/02-presence-wire-protocol.md)**
   - 100개 룸(`maru` ~ `maru-100`, 정원 `100`명) 멀티플레이어 토폴로지, Web Worker(`presence-worker-D7eFbKrZ.js`) 메시지 브릿지, **`SNSD`(`0x534E5344`) 바이너리 델타 프레임 바이트 레이아웃(28B 헤더 + 30/38B 레코드)**, AOI Interest Bounds, Supabase `CloudPresence` 폴백 아키텍처 명세.
3. **[docs/03-practices-cafe25-and-audio.md](file:///Users/bigstone/My_SideProject/online_multiverse/docs/03-practices-cafe25-and-audio.md)**
   - 6대 수행 인터랙션(합장 인사, `4,800ms` 절하기 사이클, 108염주 드래그 오버레이, 108 BPM 목탁, 헌향 대기열 & 복전함), **CAFE25 × 산사**(무소유 선물 / 풀소유 25배 수행 & 5분 속도 `1.2x` 버프 / 배달 공유), **Web Audio API 절차적 합성 엔진(`class pP`)** 알고리즘 분석.
4. **[docs/04-implementation-plan.md](file:///Users/bigstone/My_SideProject/online_multiverse/docs/04-implementation-plan.md)**
   - 위 역공학 분석(`docs/01`~`03`)을 바탕으로 `My_SideProject/online_multiverse`에 **실제 실행 가능한 3D 온라인 산사 웹 앱(FastAPI WebSocket 서버 + Three.js 클라이언트)**을 구축하기 위한 상세 구현 계획서.

---

## 🚀 4. 실행 가능한 3D 웹 앱 구동 가이드 (Port `8860` · 듀얼 엔진 지원)

역공학 분석 명세(`docs/01`~`04`)에 기반하여 구현된 **독립형 3D 온라인 산사 멀티버스 웹 애플리케이션**이며, `server_manager`(Port `9999`) 통합 관제 대시보드에 등록되어 원클릭 제어 및 실시간 로그 스트리밍을 지원합니다.

### 4.1 듀얼 프론트엔드 라우트 (`/` 원본 100% 엔진 & `/clean` 모듈형 클린 엔진)
* **`GET /` ([`static/index.html`](file:///Users/bigstone/My_SideProject/online_multiverse/static/index.html) + [`static/assets/game-CLKObOjK.js`](file:///Users/bigstone/My_SideProject/online_multiverse/static/assets/game-CLKObOjK.js) + [`static/assets/presence-worker-C2UpTq6Q.js`](file:///Users/bigstone/My_SideProject/online_multiverse/static/assets/presence-worker-C2UpTq6Q.js))**:
  - 원본 `sansatemple.com`의 `1.42MB` 프로덕션 3D 월드 엔진을 로컬 FastAPI 백엔드([`main.py`](file:///Users/bigstone/My_SideProject/online_multiverse/main.py))와 100% 직결한 모드입니다.
  - 청연당(`堂緣淸`) 다포식 공포·서까래·한지 창호, 대나무 숲·단풍나무·은행나무 바람 버텍스 셰이더, 연못·오리·수련·다실(CAFE25) 내부 가구, A* 자동 길찾기(`Gd`/`WR`), 공양미 시주 금액 실시간 `1,000`원 단위 콤마 포맷팅 입력창까지 원본과 픽셀 단위로 100% 동일하게 동작합니다.
* **`GET /clean` ([`static/clean.html`](file:///Users/bigstone/My_SideProject/online_multiverse/static/clean.html) + [`static/app.js`](file:///Users/bigstone/My_SideProject/online_multiverse/static/app.js) + [`static/style.css`](file:///Users/bigstone/My_SideProject/online_multiverse/static/style.css))**:
  - 커스터마이징과 확장이 용이하도록 가독성 높은 클린 ES Module(`~2,920`줄)로 재구성한 **Three.js r180 + `GLTFLoader` + `MeshoptDecoder` + `SkeletonUtils`** 3D 렌더러 모드입니다.

### 4.2 주요 소스 파일 및 3D 에셋
* [`main.py`](file:///Users/bigstone/My_SideProject/online_multiverse/main.py): FastAPI 멀티룸(`maru` ~ `maru-100`, 방당 정원 `50`/`100`명) 서버, `/presence` WebSocket 엔드포인트, Big-Endian `SNS3`(`0x534E5333`, `1397642035`) 28B 헤더 + 30/38B 바이너리 델타 패킷 인코더/디코더 및 `--self-check` 검증기.
* [`static/presence-worker.js`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/presence-worker.js): 지수 백오프 재연결 및 Zero-copy `Transferable` `ArrayBuffer` 브릿지 워커.
* [`static/clean.html`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/clean.html) & [`static/style.css`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/style.css): Apple HIG 모바일 퍼스트 Thumb-Zone 하단 수행 바, $\ge 44\text{pt}$ 터치 타깃, `<dialog closedby="any">` 바텀 시트 모달(100개 서버 선택, CAFE25, 복전함 `1,000` 단위 콤마 포맷팅).
* [`static/app.js`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/app.js): **Three.js r180 + `GLTFLoader` + `MeshoptDecoder` + `SkeletonUtils`** 기반 3D 렌더링 엔진.
  - **6종의 실제 스컬프팅 `.glb` 3D 모델(`EXT_meshopt_compression` & `KHR_mesh_quantization`)**:
    - 동자승 아바타([`static/assets/monk.glb`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/monk.glb)): 17개 본(`hips`, `spine`, `chest`, `neck`, `head`, `upper_arm.L/R`, `forearm.L/R`, `hand.L/R`, `thigh.L/R`, `shin.L/R`, `foot.L/R`) + 2-Bone IK 합장/절 솔버 + 4종 승복 주름 모프 타깃(`restingFold`, `prayerCloth`, `bowCloth`, `kneelingCover`) 구동.
    - 고려 금동 아미타삼존불([`buddha.glb`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/models/buddha.glb), [`mahastamaprapta.glb`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/models/mahastamaprapta.glb), [`avalokitesvara.glb`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/models/avalokitesvara.glb)): 국립중앙박물관 스캔 금동불 메쉬 + 연화대좌(`LatheGeometry`).
    - 한국 소나무([`pine.glb`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/models/pine.glb)) 및 애니메이션 사찰 고양이 '공양이'([`gongyang-cat.glb`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/cafe25-v5/gongyang-cat.glb)).
  - **7종 3채널 PBR 재질 세트(`color.jpg` / `normal.jpg` / `roughness.jpg`) 및 IBL 환경 반사맵**:
    - `wood`, `stone`, `plaster`, `roof`, `cloth`, `ground`, `rock` PBR 노멀/러프니스 매핑.
    - [`woodland.jpg`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/environment/woodland.jpg) Equirectangular IBL 환경 반사맵, 후불탱화([`altar-wall-calm-20261102.jpg`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/altar-wall-calm-20261102.jpg)), CAFE25 설강화 원화([`snowdrop-artwork.webp`](file:///Users/bigstone/My_SideProject/Online_Multiverse/static/assets/cafe25-v12/snowdrop-artwork.webp)).
  - **6대 수행 & 절차적 사운드**: 합장, `4.8초` 절 사이클, 108염주 캔버스, 108 BPM 목탁, 헌향, CAFE25(무소유/풀소유 25배 속도 `1.2x` 버프/배달 엽서), **Web Audio API 절차적 사운드 합성기(`SoundEngine`)**, 적응형 프레임 페이서(`60/30/15 FPS`), 멀티 탭 `BroadcastChannel` 락.

### 4.3 서버 실행 및 자체 검증 명령어
```bash
# 1. SNS3 바이너리 프로토콜 및 100개 룸 무결성 셀프 체크
./.venv/bin/python main.py --self-check

# 2. 서버 기동 (기본 포트: 8860)
./start.sh
# 또는
./.venv/bin/python main.py 8860
```
* **원본 100% 3D 엔진 접속**: `http://localhost:8860/`
* **모듈형 클린 3D 엔진 접속**: `http://localhost:8860/clean`
* **상태 확인 API**: `GET http://localhost:8860/api/health`, `GET http://localhost:8860/api/rooms?roomLimit=20`

---

## 🧭 5. 핵심 역공학 인사이트 요약

* **극한의 저대역폭·저전력 설계**:
  - 100명이 동시에 접속해도 채팅이 없고 위치/포즈만 공유하므로, 서버는 JSON 대신 `0x534E5344` (`"SNSD"`) 매직 헤더를 가진 **고정 30바이트(절 수행 시 38바이트) 바이너리 구조체 배열**로 브로드캐스트하여 패킷 크기를 JSON 대비 약 **80% 이상 압축**합니다.
  - WebSocket 수신 및 재연결을 메인 스레드에서 분리된 **Dedicated Worker(`presence-worker-D7eFbKrZ.js`)**에서 처리하고, 바이너리 버퍼는 Zero-copy `Transferable` (`[buffer]`)로 넘겨 GC 스파이크와 프레임 드랍을 원천 차단합니다.
* **모바일 발열 및 배터리 방어**:
  - Three.js 씬 전체를 매 프레임 다시 그리는 대신, 월드 메쉬 `224`개를 `54`개 리전으로 분할한 **World Frame Cache**와 **적응형 프레임 페이서(`60fps` → `30fps` → `15fps`)**를 결합했습니다.
* **오디오 에셋 제로에 가까운 절차적 사운드**:
  - 용량이 큰 배경음악 스트리밍 대신 **Web Audio API 노이즈 버퍼 + 듀얼 LFO 필터**로 바람 소리를 실시간 생성하고, **432Hz 비정수 배음 합성**으로 범종 소리를, **듀얼 오실레이터 + 밴드패스 노이즈**로 염주 알 부딪히는 소리를 합성합니다.
