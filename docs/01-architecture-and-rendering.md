# 01. 프론트엔드 아키텍처 & Three.js r180 렌더링 엔진 분석

> **근거 증거 (Evidence IDs)**:
> - `ev_4086dde464e9b39caa6eb04e1572ae9c8eab322aa3c4e8a746acbf64241a506d` (라이브 DOM, 캔버스 속성, 네트워크 로드 시퀀스)
> - `ev_88ba890507c24458b1f176133a7cf9b7dc45571aafadaf54ee2a7d0410f4bceb` (`index-BbexX-JI.js`, `game-vJmMAgmy.js`, `safari-scene-bleed-BChFMqZ0.js`, `visible-viewport-BjQS7hnI.js`, `game-gKV003n6.css`)
> - `ev_a3ae5c262ed40b4c791b85b75a46c9aeb2c0e2ed65bc4411dc22832a80905f90` (`*.glb` 모델 및 PBR 텍스처 에셋 번들)

---

## 1. 모듈 번들링 및 부트스트랩 파이프라인 (`Observed`)

`https://sansatemple.com`은 **Vite** 기반 ES Module 코드 스플리팅 구조를 사용하며, 초기 진입 지연을 최소화하기 위해 경량 엔트리 스크립트(`2,958` bytes)가 먼저 실행된 뒤 본 게임 엔진(`1,424,255` bytes)을 지연 로드합니다.

### 1.1 스크립트 구성 및 역할

| 파일 경로 | 크기 (Bytes) | SHA-256 | 핵심 역할 |
| :--- | :---: | :--- | :--- |
| `/assets/index-BbexX-JI.js` | `2,958` | `8c609297...fe34` | 엔트리 게이트(`#entry`), 인앱 브라우저 감지, 폰트 웜업, `/api/entry-stage` 비콘 전송, `game-vJmMAgmy.js` 동적 임포트 |
| `/assets/visible-viewport-BjQS7hnI.js` | `1,105` | `6b71f3eb...f452` | `window.visualViewport` 기반 CSS 커스텀 프로퍼티(`--app-height`, `--vv-offset-top`, `--vv-offset-left`) 실시간 동기화 |
| `/assets/safari-scene-bleed-BChFMqZ0.js` | `2,380` | `5924f5dc...bc1f` | iOS Safari 상단 주소창/노치 영역과 3D 씬 배경색(`#24251f` 등)을 매칭하기 위해 `canvas` 상단 픽셀을 샘플링하여 `<meta name="theme-color">` 및 `--safari-top-bleed-color`에 주입 |
| `/assets/game-vJmMAgmy.js` | `1,424,255` | `28b2c01b...b780` | **Three.js r180** 코어 + 산사 3D 월드(마당/법당) + 동자승 애니메이션 + 수행 오버레이(염주/목탁) + CAFE25 + Web Audio 합성기 |
| `/assets/presence-worker-D7eFbKrZ.js` | `3,489` | `7be55c92...4cf5` | 메인 스레드에서 분리된 WebSocket Dedicated Worker (`wss://sansatemple.com/presence` 통신 전담) |
| `/assets/cloud-presence-DTocDxb1.js` | `242,866` | `eea64760...520d` | `@supabase/supabase-js` (`realtime-js/2.118.0`) 기반 `CloudPresence` 폴백 모듈 |
| `/assets/game-gKV003n6.css` | `174,897` | `6d875184...60bd` | 전체 UI 레이아웃, 다크 산사 테마, 글래스모피즘 HUD, 반응형 모달 및 수행 오버레이 스타일 |

### 1.2 부트스트랩 시퀀스 (`index-BbexX-JI.js`)
1. **인앱 브라우저 감지**:
   - 정규식 `/KAKAOTALK|Instagram|FBAN|FBAV|Line\/|NAVER\(inapp|DaumApps|EverytimeApp|Blind|Threads/i`로 모바일 인앱 웹뷰 여부를 판별하여 `document.documentElement.classList.toggle("in-app-browser", ...)`를 설정합니다.
2. **퍼널 텔레메트리 (`POST /api/entry-stage`)**:
   - 세션당 고유 `id`(`crypto.randomUUID()`)를 생성하고 사용자가 입장 버튼(`#enter`)을 누르거나 자동 진입할 때 `navigator.sendBeacon("/api/entry-stage", Blob)` 또는 `fetch(..., { keepalive: true })`로 진입 단계를 보고합니다.
3. **CSS & 폰트 병렬 프리로드**:
   - `/assets/game-gKV003n6.css` 스타일시트와 Google Fonts(`Noto Serif KR`, `Nanum Myeongjo`, `Song Myung`)를 `document.fonts.load`로 최대 `240ms` 타임아웃 내에서 웜업하여 3D 캔버스 내 한글 닉네임 스프라이트 렌더링 시 폰트 깨짐(FOIT/FOUT)을 방지합니다.

---

## 2. DOM 계층 및 UI 아키텍처 (`Observed`)

라이브 DOM 캡처(`ev_4086dde4...`)에서 확인된 루트 `#app`의 런타임 속성과 하위 계층은 다음과 같습니다:

```html
<div id="app"
     data-space="garden"
     data-World-cache="refresh"
     data-world-cache-meshes="224"
     data-world-cache-regions="54"
     data-presence-transport="worker">
  <!-- 1. 3D 메인 캔버스 -->
  <canvas class="scene" data-engine="three.js r180" width="1280" height="720"></canvas>

  <!-- 2. 진입 인트로 화면 (#entry) -->
  <section id="entry" class="entry hidden" aria-hidden="true">...</section>

  <!-- 3. 염주 & 목탁 전용 인터랙티브 오버레이 -->
  <div id="beads-host" class="beads-host" hidden>...</div>
  <div id="moktak-host" class="moktak-host" hidden>...</div>

  <!-- 4. 상/하단 HUD 오버레이 (.hud) -->
  <div class="hud">
    <!-- 우측 상단 컨트롤러 (.top-right-controls): 공간 이동(법당/마당), 염불, 환경음, 효과음, 시점, 사진 촬영, 공양하기 -->
    <!-- 상단 중앙 수행 카운터 (#bow-counter, #beads-counter) -->
    <!-- 좌측 상단 현재 인원 & 100개 서버 선택기 (#visitor-counter, #server-picker-dialog) -->
    <!-- 불단 헌향 & 복전함 컨트롤 (.devotional-controls) -->
    <!-- CAFE25 커피 공양 컨텍스트 액션 (.cafe25-context-actions) -->
    <!-- 하단 수행 모드 바 (nav.game-modes): 합장 인사(#hello), 절하기(#game-bow), 염주 돌리기, 목탁 열기(#game-moktak) -->
  </div>
</div>
```

---

## 3. 3D 공간 설계 (`garden` 마당 vs `hall` 법당) (`Observed`)

`#app[data-space]` 값에 따라 두 개의 주요 공간이 전환되며, 두 공간 모두 동일한 멀티플레이어 룸 내에서 좌표계로 구분됩니다.

### 3.1 외부 마당 (`data-space="garden"`)
* **지형 및 조경**:
  - 중앙 마당과 연등 산책길, 소나무(`pine.glb`) 군락, 바위 및 돌담.
  - **연꽃 연못 & 서호(West Lake)**: 수면 반사/파문 효과와 연꽃 오브젝트, 연못가를 거니는 사찰 고양이 **'공양이'**(`gongyang-cat.glb` + 커스텀 바이너리 모션 데이터 `gongyang-cat-fit-v1.bin`).
  - **야외 좌석 (총 20석)**: 10개의 벤치 × 2슬롯(`lotus-seat-*`, `cafe-seat-*`, `west-lake-seat-*`)이 배치되어 있으며, 방문객이 벤치에 앉아 쉬거나 새(`updateSeatBirds`)와 교감할 수 있습니다.
  - **청연당 (법당 건물 외관)**: 마당 북쪽에 위치한 목조 불전 건축물로, 입구 영역에 접근하거나 상단 `#space-toggle`(`법당 들어가기`) 버튼을 누르면 법당 내부(`hall`)로 진입합니다.
  - **CAFE25 × 산사 협업 구역**: 마당 한편에 마련된 차/커피 공양소 및 **최종원 작가의 『설강화』** 작품 감상 오브젝트(`#snowdrop-artwork-dialog`).

### 3.2 법당 내부 (`data-space="hall"`)
* **불단 (Altar) — 아미타삼존불**:
  1. **본존불 (`buddha.glb`)**: 고려 불화 『수월관음도』의 금니 문양에서 영감을 받은 금동불좌상.
  2. **좌협시 관세음보살 (`avalokitesvara.glb`)**: 보관 위에 화불(化佛)을 모시고 연꽃가지를 든 자비의 보살.
  3. **우협시 대세지보살 (`mahastamaprapta.glb`)**: 보관 위에 보병(寶甁)을 모시고 합장한 지혜의 보살.
  4. **후불탱화 (`/assets/altar-wall-calm-20261102.jpg`)**: 아미타삼존불 뒤편 벽면을 채우는 고요한 불화 텍스처.
* **좌복 (Cushions) 그리드**:
  - 법당 마루 바닥에 격자형으로 배치된 방석(좌복) 배열(`cushion: 0 ~ N`).
  - 방문객이 빈 좌복을 클릭하거나 `좌복에 앉기`를 실행하면 해당 좌복 인덱스(`cushion`)를 점유하여 가부좌/절하기 자세(`pose="kneel"`)로 전환됩니다.
* **향로 (Incense Burner) & 복전함 (Donation Box)**:
  - 불단 앞 중앙 향로에서 대기열(`incenseQueue`) 순서대로 1명씩 나아가 향을 사르는 헌향 의식이 진행되며, 옆의 복전함을 클릭하면 후원 모달(`#support-dialog`)이 열립니다.

### 3.3 3D 모델 및 PBR 재질 에셋 목록 (`ev_4086dde4...`, `ev_a3ae5c26...`)

모든 무거운 정적 에셋은 콘텐츠 해시 버전 프리픽스(`/v/37821d4f60cfb916c0bd/assets/...`)를 통해 장기 캐싱(`Cache-Control: immutable`)됩니다:

| 분류 | 에셋 경로 | 용도 |
| :--- | :--- | :--- |
| **캐릭터** | `/v/37821d4f60cfb916c0bd/assets/models/monk.glb` | 플레이어 및 원격 방문객 동자승 아바타 메쉬/스켈레톤 |
| **불상** | `/v/37821d4f60cfb916c0bd/assets/models/buddha.glb` | 법당 본존 금동불좌상 |
| **보살상** | `/v/37821d4f60cfb916c0bd/assets/models/avalokitesvara.glb` | 관세음보살 입상 |
| **보살상** | `/v/37821d4f60cfb916c0bd/assets/models/mahastamaprapta.glb` | 대세지보살 입상 |
| **조경** | `/v/37821d4f60cfb916c0bd/assets/models/pine.glb` | 산사 경내 소나무 모델 |
| **동물** | `/assets/models/gongyang-cat.glb` + `gongyang-cat-fit-v1.bin` | 사찰 고양이 '공양이' 메쉬 및 키프레임 바이너리 |
| **환경맵** | `/v/37821d4f60cfb916c0bd/assets/textures/env/woodland.jpg` | PBR 금속/유광 반사용 환경 텍스처 |
| **PBR 재질** | `/v/37821d4f60cfb916c0bd/assets/textures/{wood,stone,plaster,roof,cloth,ground,rock}/{color,normal,roughness}.jpg` | 목재, 석재, 회벽, 기와지붕, 승복/좌복 천, 마당 흙, 바위 PBR 3종 세트 |

---

## 4. 렌더링 최적화 & 저전력 엔지니어링 (`Observed`)

최대 100명의 동자승이 동시에 렌더링되는 웹 환경(특히 아이폰/안드로이드 모바일 브라우저)에서 발열과 배터리 소모를 줄이기 위해 4가지 핵심 최적화 기법이 적용되어 있습니다.

### 4.1 World Frame Cache & Damage Region 추적
DOM 루트 `#app`에 실시간 기록되는 속성:
- `data-world-cache="refresh"` (또는 `"reuse"`)
- `data-world-cache-meshes="224"`
- `data-world-cache-regions="54"`

**동작 원리 (`game-vJmMAgmy.js`)**:
1. 씬 내 정적 건축물·지형 메쉬 `224`개를 바운딩 박스 기준 `54`개의 공간 리전(Region)으로 분할합니다.
2. 카메라 시점(`camera.matrixWorldInverse`, `projectionMatrix`)이 변하지 않는 정적 응시 상태에서는 배경 전체를 재계산하는 대신, 아바타 이동·향 연기·촛불 흔들림이 발생한 **더티 리전(Damage Region)**만 갱신 여부를 판별하여 불필요한 드로우콜과 셰이더 연산을 생략합니다.

### 4.2 적응형 프레임 페이서 (`class Vy`)
`requestAnimationFrame`이 무조건 60Hz/120Hz로 도는 것을 막기 위해 `class Vy`가 프레임 간격(`intervalMs`)을 동적으로 조절합니다:

```javascript
// game-vJmMAgmy.js 내 class Vy (복원 요약)
class FramePacer {
  intervalMs({ now, remoteCount, remoteDanceActive, cameraDragging }) {
    if (cameraDragging || now < this.boostUntil) return 1000 / 60; // 16.67ms (60 FPS)
    if (remoteCount > 24 && !remoteDanceActive) return 1000 / 15;  // 66.67ms (15 FPS)
    return 1000 / 30;                                              // 33.33ms (30 FPS)
  }
}
```
* 사용자 입력(포인터 드래그, 줌, 이동 키) 발생 시 `noteInteraction()`이 호출되어 `900ms` 동안 **60 FPS** 부스트 모드로 즉시 전환됩니다.
* 조작 없이 가만히 앉아 명상할 때는 **30 FPS**(원격 인원 24명 초과 시 **15 FPS**)로 자동 감속되어 모바일 GPU 점유율을 절반 이하로 낮춥니다.

### 4.3 군중 배칭 (`crowdBatches`) 및 이름표(Nameplate) 컬링
* 원격 방문객 아바타(`monk.glb`)는 가시 영역(Frustum) 및 카메라 거리에 따라 LOD/업데이트 주기가 차등 적용됩니다.
* 각 동자승 머리 위의 법명/별칭 캔버스 텍스처(`CanvasTexture`)는 매 프레임 재생성하지 않고 별칭 문자열과 색상을 키로 캐싱하며, 화면 밖 아바타는 즉시 컬링합니다.

### 4.4 멀티 탭 단일 렌더러 소유권 (`BroadcastChannel`)
동일 브라우저에서 `sansatemple.com`을 여러 탭에 띄웠을 때 WebGL 컨텍스트 경합을 막기 위해 `BroadcastChannel("sansa-render-owner-v1")`과 `localStorage("sansa-active-render-owner-v1")`를 결합한 락(Lock) 프로토콜을 구동합니다:
- 새로운 탭이 포커스를 얻으면 `{ type: "claim", tabId, claimedAt }` 브로드캐스트 메시지를 발송합니다.
- 기존 탭은 즉시 3D 렌더 루프를 중단(`render-paused-banner` 표시: *"다른 산사 탭이 활성화되어 이 탭의 화면 그리기를 잠시 멈췄습니다"*)하고, 클릭 시 다시 소유권을 회수합니다.
