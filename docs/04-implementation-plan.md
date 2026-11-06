# 04. `Online_Multiverse` 실행 가능한 3D 웹 앱 구현 계획서 (Implementation Plan)

> 본 문서는 `docs/01` ~ `docs/03`의 `sansatemple.com` 역공학 실측 분석(Option A)을 바탕으로, `My_SideProject/Online_Multiverse` 디렉토리에 **즉시 실행 가능하고 홈서버(`Server_Manager`)와 완벽히 호환되는 3D 온라인 산사 멀티버스 웹 애플리케이션**을 구축하기 위한 엔지니어링 구현 계획서입니다.

---

## 1. 🎯 요구사항 분석 & Ponytail 사다리 법칙 적용 설계

`My_SideProject` 전역 원칙인 **Ponytail 7단계 사다리 법칙**을 적용하여 불필요한 외부 의존성과 빌드 복잡도를 제거하고 가장 단순하고 견고한 아키텍처를 채택합니다.

| 사다리 단계 | 검토 내용 및 아키텍처 결정 |
| :--- | :--- |
| **1. YAGNI** | Cloudflare 유료 인프라나 외부 Supabase 클라우드 설정 없이, 로컬 맥북 및 맥미니 홈서버 단일 프로세스에서 즉시 100개 멀티룸과 `SNSD` 바이너리 프로토콜이 100% 동작하도록 설계합니다. |
| **2. 코드베이스 재사용** | `My_SideProject`의 `FastAPI` + `uvicorn` 서버 패턴(`Server_Manager`, `Stock_Manager`, `lotto_machine`)을 그대로 재사용하여 통합 관제 대시보드 연동성을 보장합니다. |
| **3. 표준 라이브러리 우선** | 바이너리 패킷(`0x534E5344` `"SNSD"`) 직렬화는 Python 내장 `struct.pack("<III d d", ...)` 및 `struct.pack("<H h B B d d d", ...)`로 처리하고, 클라이언트는 내장 `DataView` / `ArrayBuffer`를 사용합니다. |
| **4. 플랫폼 네이티브 기능** | 모달은 HTML5 `<dialog>` 바텀 시트, 사운드는 외부 MP3 없이 브라우저 내장 **Web Audio API 절차적 합성(`class SoundEngine`)**, 멀티 탭 제어는 내장 `BroadcastChannel`을 사용합니다. |
| **5. 기존 패키지 활용** | 백엔드는 이미 워크스페이스에 설치된 `fastapi`, `uvicorn`, `websockets`만 사용하며, 프론트엔드는 별도 Node/Vite 빌드 없이 ES Module Import Map(`three` CDN)으로 즉시 구동되도록 구성합니다. |

---

## 2. 🏛️ 목표 디렉토리 및 파일 구조 (`Online_Multiverse/`)

**Fewest Files Possible** 원칙에 따라 최소한의 파일로 전체 멀티플레이어 백엔드와 3D 웹 클라이언트를 구성합니다:

```text
Online_Multiverse/
├── README.md                              # 역공학 요약, 아키텍처 개요, 실행 가이드
├── docs/
│   ├── 01-architecture-and-rendering.md   # Three.js r180 & 저전력 렌더링 역공학 분석
│   ├── 02-presence-wire-protocol.md       # SNSD 바이너리 델타 & WebSocket 프로토콜 명세
│   ├── 03-practices-cafe25-and-audio.md   # 6대 수행, CAFE25, Web Audio 합성 알고리즘 분석
│   └── 04-implementation-plan.md          # 실행 가능한 3D 웹 앱 구현 계획서 (본 문서)
├── main.py                                # FastAPI 서버 (REST /api/rooms + WebSocket /presence + SNSD 바이너리 인코더)
└── static/
    ├── index.html                         # Apple HIG 모바일 퍼스트 HUD, <dialog> 바텀 시트, 3D/염주/목탁 캔버스
    ├── style.css                          # Apple Glassmorphism 다크 테마, 100dvh, Safe Area, >=44pt 터치 타깃
    ├── presence-worker.js                 # Dedicated WebSocket Worker (지수 백오프 재연결 + Zero-copy ArrayBuffer)
    └── app.js                             # Three.js 3D 산사(마당/법당), 수행 상태 머신, CAFE25, Web Audio 합성기
```

---

## 3. ⚙️ 백엔드 상세 설계 (`main.py` — Port `8860` 권장)

### 3.1 API 및 WebSocket 라우트 명세
1. **`GET /`**: `static/index.html` 서빙.
2. **`GET /api/rooms?roomLimit=100`**:
   - `maru` (서버 1) ~ `maru-100` (서버 100)까지 100개 방의 `{ id, number, capacity: 100, count }` 실시간 현황 반환.
3. **`POST /api/entry-stage`**:
   - 진입 퍼널 비콘(`entry-click`, `entered`) 수신 및 `204 No Content` 응답.
4. **`WS /presence`**:
   - 쿼리 파라미터(`room=auto|maru-XX`, `wire=3`, `cafe25=1`, `interest=1`) 파싱.
   - 입장 시 빈 슬롯(`seat: 0~99`)과 절차적 한국어 법명(형용사 20종 × 자연어 명사 20종 조합: 예 `"고요한 바람"`, `"따스한 솔잎"`, `"은은한 달빛"`) 및 승복 색상 팔레트를 자동 부여.
   - **초기 프레임 전송**:
     1. `{"type": "snapshot", "room": ..., "selfId": ..., "revision": ..., "serverTime": ..., "visitors": [...], "incenseQueue": [...]}`
     2. `{"type": "cafe25-state", "room": ..., "shared": [...], "owned": [...]}`
   - **실시간 델타 브로드캐스트 (`SNSD` Binary Frame)**:
     - Python `struct` 모듈로 28바이트 헤더(`0x534E5344`, `jsonByteLength`, `recordCount`, `revision`, `serverTime`) + UTF-8 JSON(입퇴장/이벤트) + 방문객별 30/38바이트 바이너리 레코드를 패킹하여 `websocket.send_bytes()`로 전송.

---

## 4. 🎨 프론트엔드 3D 월드 & 인터랙션 설계 (`static/app.js`)

### 4.1 3D 공간 (`garden` 마당 ↔ `hall` 법당) 및 절차적 스타일드 지오메트리
외부 대용량 `.glb` 파일이 없는 오프라인/로컬 환경에서도 즉시 아름다운 산사가 렌더링되도록 **Three.js 절차적 건축/조형 생성기(Procedural Temple & Monk Builder)**를 기본 내장하고, 선택적으로 `.glb` 모델이 존재할 경우 덮어쓰는 하이브리드 로더를 구현합니다:
* **마당 (`garden`)**:
  - 청연당 목조 법당 외관(기단, 배흘림기둥, 팔작지붕 기와), 석등과 연등 산책길, 연꽃 연못(수면 셰이더/반사)과 사찰 고양이 **'공양이'** 애니메이션 메쉬, 소나무 숲, 야외 벤치 20석, **CAFE25 공양소**.
* **법당 (`hall`)**:
  - 불단 위 **아미타삼존불**(본존 금동불좌상, 관세음보살, 대세지보살) 금빛 PBR 메쉬와 후불탱화 캔버스 텍스처, 촛불 포인트 라이트, 향로(실시간 연기 파티클), 복전함, **좌복(방석) 24석 그리드**.
* **동자승 아바타 (`MonkAvatar`)**:
  - 둥근 두상, 승복 몸통, 합장하는 두 팔과 다리 계층 구조, 머리 위 둥근 법명 이름표(`CanvasTexture` 캐싱) 및 합장/커피 온기 오라 이펙트.

### 4.2 저전력 렌더러 & 멀티 탭 제어
* **적응형 프레임 페이서 (`FramePacer`)**:
  - 카메라 조작/이동 중 **60 FPS**, 평상시 **30 FPS**, 원격 방문객 24명 초과 정지 상태 시 **15 FPS** 자동 전환.
* **멀티 탭 렌더 소유권 (`BroadcastChannel("sansa-render-owner-v1")`)**:
  - 비활성 탭의 WebGL 루프를 즉시 일시 정지하고 안내 배너를 표시하여 발열 방지.

### 4.3 6대 수행 & CAFE25 × 산사 완벽 구현
1. **합장 인사 (단축키 `3`)**: 합장 모션 + 머리 위 파동 링 + `bell()` 사운드 + 원격 브로드캐스트.
2. **절하기 (단축키 `1` / `Space`)**: `4.8초` 키프레임 보간(`prepare → lower → hold → rise → rest`) + 상단 `절 N배` 카운터(`localStorage` 영속화) + `SNSD` 38바이트 `bowAt` 동기화.
3. **108염주 돌리기 (단축키 `2`)**: 우측 인터랙티브 염주 캔버스 오버레이에서 드래그/휠/스페이스로 염주 알을 넘기며 `N알` 및 `108염주 N바퀴` 카운팅 + 나무 염주 마찰음(`bead()`) 재생.
4. **목탁 치기 (단축키 `5`)**: 수동 터치 타격 및 **108 BPM (`555.56ms`) 자동 목탁** 토글 + 목탁 타격 파동 애니메이션.
5. **향 올리기 & 복전함**: 불단 앞 헌향 대기열(`incenseQueue`) 참가/헌향 연출 및 복전함/공양하기 바텀 시트 모달.
6. **CAFE25 커피 공양**:
   - **무소유 (`gift`)**: 커피 내려서 서버 나눔 큐(`shared[]`)에 등록 및 타 방문객 수령 알림.
   - **풀소유 (`practice`)**: **25배(`0/25`) 절하기** 달성 후 음용 시 **5분(`300,000ms`)간 이동 속도 `1.2x` 및 황금빛 온기 오라 버프**.
   - **배달 (`delivery`)**: 안부 문구를 넣은 산사 커피 카드 PNG 이미지 즉시 생성 및 다운로드/공유.

### 4.4 Web Audio API 절차적 사운드 합성기 (`SoundEngine`)
외부 오디오 파일 없이도 작동하는 3채널(`ambient`, `chant`, `effects`) 합성기:
- **환경음 (`ambient`)**: 브라운/핑크 노이즈 + `0.07Hz`/`0.19Hz` 듀얼 LFO 필터 변조 바람 소리 + 절차적 산새 지저귐 + `2.6초` 컨볼루션 리버브.
- **염불 (`chant`)**: 차분한 저음 독경 배음 드론 합성 + 매일 KST `05:00 · 18:00` 합동 염불 시간 알림.
- **효과음 (`effects`)**: `432Hz` 비정수 배음(`[1, 2.71, 3.96, 5.43, 7.03]`) 범종 소리, `1,010Hz`/`1,470Hz` 염주 알 소리, 공명 필터 기반 목탁 타격음.

---

## 5. 🍎 Apple HIG & 모바일 UX 표준 반영 사항

1. **Thumb Zone 하단 플로팅 아일랜드 바 (`nav.game-modes`)**:
   - 핵심 수행 버튼(합장 인사, 절하기, 108염주, 목탁, 좌복 앉기/일어나기)을 화면 하단 중앙 플로팅 바에 배치하여 아이폰 한 손 조작성을 극대화합니다.
2. **터치 타깃 $\ge 44\times 44\text{pt}$ 보장**:
   - 모든 HUD 버튼, 서버 선택 아이템, 오디오 토글, 모달 닫기 버튼의 최소 크기를 `44px × 44px` 이상으로 강제하고 `:active { transform: scale(0.96); }` 감압 피드백을 부여합니다.
3. **네이티브 `<dialog>` 바텀 시트 모달**:
   - 서버 선택기(1~100 서버), CAFE25 커피 공양소, 복전함(공양하기) 모달을 모바일 하단 슬라이드업 바텀 시트로 구현하고 배경 터치 시 닫히도록 처리합니다.
4. **Apple Glassmorphism & Safe Area / `100dvh`**:
   - `backdrop-filter: blur(20px)`, `background: rgba(18, 18, 18, 0.75)`, `border: 1px solid rgba(255, 255, 255, 0.10)`, `height: 100dvh`, `padding-bottom: env(safe-area-inset-bottom, 16px)`를 전면 적용합니다.
5. **💰 금액/수치 `1,000` 단위 콤마(`,`) 포맷팅 필수**:
   - 복전함(공양하기) 내 후원 금액 프리셋/직접 입력 필드(`<input type="text" inputmode="numeric">`) 및 누적 수행 횟수 표시에 실시간 `toLocaleString('ko-KR')` 천 단위 콤마 포맷팅을 적용합니다.

---

## 6. 🚀 단계별 구현 마일스톤 및 검증 계획 (Verification Plan)

1. **Phase 1 — 백엔드 멀티룸 & `SNSD` 바이너리 프로토콜 서버 (`main.py`)**
   - 100개 룸(`maru` ~ `maru-100`) 상태 관리, WebSocket `/presence`, `SNSD`(`0x534E5344`) 패킷 인코더/디코더 구현.
   - **자체 검증 (Runnable Check)**: Python 셀프 테스트 스크립트로 `SNSD` 28바이트 헤더 + 30/38바이트 레코드 패킹/언패킹 무결성 `assert` 검증 및 `/api/rooms` 응답 테스트.
2. **Phase 2 — Three.js 3D 산사 월드(`garden`/`hall`) & 저전력 렌더러 (`static/app.js`)**
   - 마당/법당 3D 공간, 동자승 아바타, 좌복 착석, 적응형 프레임 페이서(`60/30/15 FPS`), 멀티 탭 `BroadcastChannel` 구현.
3. **Phase 3 — 6대 수행 오버레이(절/염주/목탁/헌향), CAFE25 & Web Audio 사운드 엔진**
   - `4.8초` 절 사이클, 108염주 드래그 캔버스, 108 BPM 목탁, CAFE25(무소유/풀소유 25배 버프/배달 카드), Web Audio 절차적 합성기 연결.
4. **Phase 4 — Apple HIG 모바일 UI 폴리싱 & 브라우저/런타임 검증**
   - 로컬 서버 기동 후 브라우저 시나리오 캡처를 통해 콘솔 에러 `0`건, WebSocket `SNSD` 바이너리 프레임 정상 송수신, 모든 수행 인터랙션 동작 확인 후 `README.md` 최신화 및 Git 커밋/푸시.
