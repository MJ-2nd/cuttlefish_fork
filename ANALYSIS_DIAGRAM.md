# CVD 디스플레이 합성(Compositing) 및 오버레이 터치 분석 다이어그램

## 1. 변경 파일 관계도

```
frontend/src/operator/webui/src/app/view-pane/
├── view-pane.component.html  ← DOM 구조 (템플릿)
├── view-pane.component.scss  ← 스타일/레이아웃 (CSS)
└── view-pane.component.ts    ← 합성 엔진 + 터치 핸들링 (로직)

기타 관련 파일:
├── Dockerfile.overlay         ← 커스텀 Web UI를 포함한 Docker 이미지
├── docker-compose.yml         ← GPU 패스쓰루 + 포트매핑 설정
└── tools/fd_passing_test/     ← Unix socket FD 전달 테스트 유틸리티
```

---

## 2. 커밋 진화 타임라인 (10개 커밋)

```
시간순 →

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: iframe PIP 방식 (2026-03-24 ~ 03-25)                                          │
│                                                                                         │
│  cb782c7         c71c1d9        f93addd6       2dac35c9       3870ae8                   │
│  "own dockerfile" "dockerfile   "docker-compose "move pip     "add console              │
│                    modif"        example"        to center"    log for debugging"        │
│  ┌──────────┐   ┌──────────┐  ┌──────────┐   ┌──────────┐  ┌──────────┐               │
│  │ 오버레이  │   │ Dockerfile│  │ docker-  │   │ PIP 위치 │  │ 디버그   │               │
│  │ iframe   │→  │ 경로수정  │→ │ compose  │→  │ 우상단→  │→ │ 로그추가 │               │
│  │ 최초 추가 │   │          │  │ GPU설정  │   │ 중앙정렬 │  │          │               │
│  └──────────┘   └──────────┘  └──────────┘   └──────────┘  └──────────┘               │
│                                                                                         │
│  [html] iframe   [docker]      [docker]       [scss]         [ts]                       │
│  [scss] overlay   빌드경로      NVIDIA GPU     top:50%        console.log               │
│  [ts] getOverlay  수정          /dev/kvm       left:50%       overlayId 정보            │
│        Id()                     포트매핑       transform      출력                       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Canvas 기반 실시간 합성으로 전환 (2026-03-26)                                   │
│                                                                                         │
│  def7294ea                                                                              │
│  "real rendering"                                                                       │
│  ┌────────────────────────────────────────────┐                                         │
│  │ ★ 핵심 전환점: iframe PIP → Canvas 합성   │                                         │
│  │                                            │                                         │
│  │ [html] iframe 삭제 → canvas 요소 추가      │                                         │
│  │ [scss] .composite-container (absolute)     │                                         │
│  │        .composite-canvas (100% fill)       │                                         │
│  │        .composite-source-hidden (offscreen)│                                         │
│  │ [ts]  requestAnimationFrame 렌더링 루프    │                                         │
│  │       startCompositing() / runComposite()  │                                         │
│  │       AfterViewChecked 라이프사이클 통합   │                                         │
│  └────────────────────────────────────────────┘                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Phase 3: 버그 수정 & UI 개선 (2026-03-26)                                               │
│                                                                                         │
│  8a13cf23          270e65c1           24ed093f                                           │
│  "fix bugs"        "touch pass &     "transparent                                       │
│                     sidebar"          background"                                       │
│  ┌──────────┐    ┌──────────┐      ┌──────────┐                                        │
│  │ 중복iframe│    │ pointer- │      │ clearRect│                                        │
│  │ 제거,기존 │→   │ events:  │→     │ 투명배경 │                                        │
│  │ grid재사용│    │ none 추가│      │ CSS크기  │                                        │
│  └──────────┘    └──────────┘      │ 기반 좌표│                                        │
│                                    └──────────┘                                        │
│  [html] hidden    [scss]            [scss] object-fit                                   │
│    iframe 삭제    pointer-events     제거                                               │
│  [ts] 셀렉터     :none → 터치가    [ts] getBounding                                    │
│    수정           아래로 통과         ClientRect()                                       │
│    폴링1000ms                        기반 좌표 매핑                                     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Phase 4: 오버레이 터치 활성화 (2026-03-26)                                               │
│                                                                                         │
│  83c01806                                                                               │
│  "enable touch of overlay"                                                              │
│  ┌────────────────────────────────────────────┐                                         │
│  │ [html] .overlay-touch-target div 추가      │                                         │
│  │ [scss] pointer-events:auto, z-index:10     │                                         │
│  │ [ts]  setupOverlayTouchHandling()          │                                         │
│  │       좌표변환 → 합성 PointerEvent 생성    │                                         │
│  │       → CVD 2 video에 dispatchEvent        │                                         │
│  └────────────────────────────────────────────┘                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 최종 DOM 레이어 구조 (Z축)

```
 ┌─ ktd-grid-item (CVD 1) ─────────────────────────────────────────────────────┐
 │                                                                              │
 │  ┌─ .device-viewer-display (position: relative) ──────────────────────────┐  │
 │  │                                                                        │  │
 │  │  ┌─ .viewer-header ─────────────────────────────────────────────────┐  │  │
 │  │  │  "cvd-1/0"                                              [×]     │  │  │
 │  │  └─────────────────────────────────────────────────────────────────┘  │  │
 │  │                                                                        │  │
 │  │  ┌─ .fit-panel ────────────────────────────────────────────────────┐  │  │
 │  │  │                                                                  │  │  │
 │  │  │  ┌─ iframe (CVD 1 WebRTC 스트림) ─────────────────────────┐    │  │  │
 │  │  │  │                                                         │    │  │  │
 │  │  │  │  [z-index: 기본]  ← 터치 이벤트 수신 가능              │    │  │  │
 │  │  │  │                      (canvas가 pointer-events:none)     │    │  │  │
 │  │  │  │                                                         │    │  │  │
 │  │  │  │   ┌─────────────────────────────────────────────┐       │    │  │  │
 │  │  │  │   │  <video> (WebRTC)                           │       │    │  │  │
 │  │  │  │   │  CVD 1 화면                                 │       │    │  │  │
 │  │  │  │   └─────────────────────────────────────────────┘       │    │  │  │
 │  │  │  │   ┌─ 사이드바/컨트롤 ──┐                                │    │  │  │
 │  │  │  │   │ 볼륨, 전원, 회전   │                                │    │  │  │
 │  │  │  │   └────────────────────┘                                │    │  │  │
 │  │  │  └─────────────────────────────────────────────────────────┘    │  │  │
 │  │  │                                                                  │  │  │
 │  │  └──────────────────────────────────────────────────────────────────┘  │  │
 │  │                                                                        │  │
 │  │  ┌─ .composite-container (z-index:5, pointer-events:none) ─────────┐  │  │
 │  │  │  position:absolute, top:40px (헤더 아래)                         │  │  │
 │  │  │                                                                   │  │  │
 │  │  │  ┌─ canvas.composite-canvas ──────────────────────────────────┐  │  │  │
 │  │  │  │                                                             │  │  │  │
 │  │  │  │  [투명 배경 — clearRect()]                                  │  │  │  │
 │  │  │  │                                                             │  │  │  │
 │  │  │  │  ┌──────────────────────────────────────────────────────┐  │  │  │  │
 │  │  │  │  │ drawImage(mainVideo) — CVD 1 화면 복제               │  │  │  │  │
 │  │  │  │  │                                                      │  │  │  │  │
 │  │  │  │  │         ┌────────────────────┐                       │  │  │  │  │
 │  │  │  │  │         │ drawImage(overlay) │                       │  │  │  │  │
 │  │  │  │  │         │ CVD 2 화면 (30%)   │ ← 흰색 테두리        │  │  │  │  │
 │  │  │  │  │         │ 중앙 배치          │                       │  │  │  │  │
 │  │  │  │  │         └────────────────────┘                       │  │  │  │  │
 │  │  │  │  │                                                      │  │  │  │  │
 │  │  │  │  └──────────────────────────────────────────────────────┘  │  │  │  │
 │  │  │  └─────────────────────────────────────────────────────────────┘  │  │  │
 │  │  │                                                                   │  │  │
 │  │  │  ┌─ .overlay-touch-target (z-index:10, pointer-events:auto) ──┐  │  │  │
 │  │  │  │  position:absolute                                          │  │  │  │
 │  │  │  │  매 프레임마다 오버레이 그리기 좌표에 동기화                │  │  │  │
 │  │  │  │  (oX, oY, oW, oH)                                          │  │  │  │
 │  │  │  │                                                              │  │  │  │
 │  │  │  │  → 터치 이벤트를 캡처하여 CVD 2로 전달                     │  │  │  │
 │  │  │  └──────────────────────────────────────────────────────────────┘  │  │  │
 │  │  │                                                                   │  │  │
 │  │  └───────────────────────────────────────────────────────────────────┘  │  │
 │  │                                                                        │  │
 │  └────────────────────────────────────────────────────────────────────────┘  │
 │                                                                              │
 └──────────────────────────────────────────────────────────────────────────────┘

 ┌─ ktd-grid-item (CVD 2) ─────────────────────────────────────────────────────┐
 │  (별도 그리드 아이템 — 화면에 표시되지만 canvas 소스로도 사용됨)              │
 │                                                                              │
 │  ┌─ iframe (CVD 2 WebRTC 스트림) ───────────────────────────────────────┐   │
 │  │   <video> — compositing 소스 + touch dispatch 대상                    │   │
 │  └───────────────────────────────────────────────────────────────────────┘   │
 └──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Canvas 합성 렌더링 파이프라인

```
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │                          Angular 컴포넌트 라이프사이클                                │
 │                                                                                      │
 │  ngAfterViewChecked()                                                                │
 │  │                                                                                   │
 │  ├─ currentLayout.length >= 2 ?  ──── No ──→ (대기)                                  │
 │  │                                                                                   │
 │  └─ Yes ──→ canvas 존재?  ──── No ──→ (대기)                                         │
 │              │                                                                       │
 │              └─ Yes ──→ compositeActive = true                                       │
 │                         │                                                            │
 │                         ▼                                                            │
 │                    startCompositing(deviceId, overlayId)                              │
 └──────────────────────────┬───────────────────────────────────────────────────────────┘
                            │
                            ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │                        비디오 요소 탐색 (폴링)                                       │
 │                                                                                      │
 │  setInterval(1000ms) {                                                               │
 │    ┌─────────────────────────────────┐    ┌─────────────────────────────────┐        │
 │    │ mainIframe                      │    │ overlayIframe                   │        │
 │    │ = querySelector(                │    │ = querySelector(                │        │
 │    │   'iframe[title="cvd-1/0"]')    │    │   'iframe[title="cvd-2/0"]')    │        │
 │    │                                 │    │                                 │        │
 │    │    ↓ .contentDocument           │    │    ↓ .contentDocument           │        │
 │    │                                 │    │                                 │        │
 │    │ mainVideo                       │    │ overlayVideo                    │        │
 │    │ = .querySelector('video')       │    │ = .querySelector('video')       │        │
 │    └────────────┬────────────────────┘    └────────────┬────────────────────┘        │
 │                 │                                       │                            │
 │                 └───────────── 둘 다 videoWidth > 0? ───┘                            │
 │                                      │                                               │
 │                      Yes ────────────┤                                               │
 │                                      ▼                                               │
 │                        clearInterval() — 폴링 중지                                   │
 │                        setupOverlayTouchHandling()                                   │
 │                        runCompositeLoop(canvas, mainVideo, overlayVideo)              │
 └──────────────────────────┬───────────────────────────────────────────────────────────┘
                            │
                            ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │                     requestAnimationFrame 렌더링 루프 (~60fps)                       │
 │                                                                                      │
 │  render() {                                                                          │
 │                                                                                      │
 │    ① Canvas 크기 동기화                                                              │
 │    ┌───────────────────────────────────────────────────────┐                         │
 │    │ displayRect = canvas.getBoundingClientRect()          │                         │
 │    │ canvas.width  = displayRect.width   (CSS 표시 크기)   │                         │
 │    │ canvas.height = displayRect.height  (크기 변경 시만)  │                         │
 │    └───────────────────────────────────────────────────────┘                         │
 │                         │                                                            │
 │                         ▼                                                            │
 │    ② 투명하게 초기화                                                                 │
 │    ┌───────────────────────────────────────────────────────┐                         │
 │    │ ctx.clearRect(0, 0, w, h)                             │                         │
 │    │ → 투명해져서 아래 iframe의 사이드바/컨트롤이 보임     │                         │
 │    └───────────────────────────────────────────────────────┘                         │
 │                         │                                                            │
 │                         ▼                                                            │
 │    ③ 메인 비디오 (CVD 1) 그리기                                                      │
 │    ┌───────────────────────────────────────────────────────┐                         │
 │    │ vr = mainVideo.getBoundingClientRect()                │                         │
 │    │ ctx.drawImage(mainVideo, vr.left, vr.top,             │                         │
 │    │               vr.width, vr.height)                    │                         │
 │    │                                                       │                         │
 │    │ → iframe 내 video의 실제 위치/크기에 맞춰 그림        │                         │
 │    └───────────────────────────────────────────────────────┘                         │
 │                         │                                                            │
 │                         ▼                                                            │
 │    ④ 오버레이 비디오 (CVD 2) 그리기 — 30% 스케일, 중앙                               │
 │    ┌───────────────────────────────────────────────────────┐                         │
 │    │ scale = 0.3                                           │                         │
 │    │ oW = vr.width  * 0.3                                  │                         │
 │    │ oH = vr.height * 0.3                                  │                         │
 │    │ oX = vr.left + (vr.width  - oW) / 2  ← 수평 중앙     │                         │
 │    │ oY = vr.top  + (vr.height - oH) / 2  ← 수직 중앙     │                         │
 │    │                                                       │                         │
 │    │ ctx.drawImage(overlayVideo, oX, oY, oW, oH)          │                         │
 │    │ ctx.strokeRect(oX, oY, oW, oH)  ← 흰색 반투명 테두리 │                         │
 │    └───────────────────────────────────────────────────────┘                         │
 │                         │                                                            │
 │                         ▼                                                            │
 │    ⑤ 터치 타겟 위치 동기화                                                           │
 │    ┌───────────────────────────────────────────────────────┐                         │
 │    │ touchTarget.style.left   = oX                         │                         │
 │    │ touchTarget.style.top    = oY                         │                         │
 │    │ touchTarget.style.width  = oW                         │                         │
 │    │ touchTarget.style.height = oH                         │                         │
 │    │                                                       │                         │
 │    │ → 오버레이가 그려진 정확한 위치에 투명 터치 영역 배치  │                         │
 │    └───────────────────────────────────────────────────────┘                         │
 │                         │                                                            │
 │                         └──→ requestAnimationFrame(render)  ← 다음 프레임 예약       │
 │  }                                                                                   │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 터치 이벤트 전달 흐름 (오버레이 터치)

```
 사용자 손가락/마우스
        │
        ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │  이벤트 캡처 레이어                                                                  │
 │                                                                                      │
 │  composite-container (pointer-events: none)                                          │
 │    │                                                                                 │
 │    ├── canvas (pointer-events 상속: none) → 터치 통과                                │
 │    │                                                                                 │
 │    └── .overlay-touch-target (pointer-events: auto) ← 오버레이 영역만 터치 캡처     │
 │         │                                                                            │
 │         │  영역 밖 터치 → composite-container가 none이므로                           │
 │         │               → 아래 iframe(CVD 1)이 직접 수신 ✓                           │
 │         │                                                                            │
 │         │  영역 안 터치 → .overlay-touch-target이 캡처                               │
 │         │               → 아래 좌표 변환 로직 실행                                   │
 │         ▼                                                                            │
 └──────────────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │  좌표 변환 (setupOverlayTouchHandling)                                               │
 │                                                                                      │
 │  PointerEvent (pointerdown/move/up/cancel)                                           │
 │        │                                                                             │
 │        ├─ ① e.preventDefault() + e.stopPropagation()                                 │
 │        │    → 기본 동작 및 이벤트 버블링 차단                                        │
 │        │                                                                             │
 │        ├─ ② pointerdown → touchTarget.setPointerCapture(e.pointerId)                 │
 │        │    → 이후 pointermove/up이 타겟 밖에서도 계속 수신됨                        │
 │        │                                                                             │
 │        ├─ ③ 상대 좌표 계산 (0.0 ~ 1.0)                                              │
 │        │    relX = e.offsetX / touchTarget.offsetWidth                                │
 │        │    relY = e.offsetY / touchTarget.offsetHeight                               │
 │        │                                                                             │
 │        │    ┌───────────────────────────────────┐                                    │
 │        │    │  .overlay-touch-target             │                                    │
 │        │    │                                    │                                    │
 │        │    │     (0,0)──────────→ (1,0)         │                                    │
 │        │    │       │                │            │                                    │
 │        │    │       │   ● (relX,     │            │                                    │
 │        │    │       │      relY)     │            │                                    │
 │        │    │       │                │            │                                    │
 │        │    │     (0,1)──────────→ (1,1)         │                                    │
 │        │    └───────────────────────────────────┘                                    │
 │        │                                                                             │
 │        ├─ ④ CVD 2 비디오의 절대 좌표로 변환                                          │
 │        │    videoRect = overlayVideo.getBoundingClientRect()                          │
 │        │    clientX = videoRect.left + relX * video.offsetWidth                       │
 │        │    clientY = videoRect.top  + relY * video.offsetHeight                      │
 │        │                                                                             │
 │        └─ ⑤ 합성 이벤트 생성 & 디스패치                                              │
 │             iframeWindow = overlayIframe.contentWindow                                │
 │             syntheticEvent = new iframeWindow.PointerEvent(e.type, {                  │
 │               clientX, clientY,                                                       │
 │               pointerId, pointerType: 'touch',                                       │
 │               isPrimary, bubbles: true                                                │
 │             })                                                                        │
 │             overlayVideo.dispatchEvent(syntheticEvent)                                │
 │                                                                                      │
 │  ★ 핵심: iframe의 PointerEvent 생성자를 사용해야 cross-frame 호환성 확보             │
 │    (부모 window의 PointerEvent로 만들면 iframe 내부에서 instanceof 실패)              │
 └──────────────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │  CVD 2 iframe 내부                                                                   │
 │                                                                                      │
 │  overlayVideo <video> 요소                                                           │
 │        │                                                                             │
 │        ▼                                                                             │
 │  touch.js (Cuttlefish WebRTC 클라이언트)                                             │
 │        │ offsetX/offsetY → Android 터치 좌표로 변환                                  │
 │        ▼                                                                             │
 │  WebRTC DataChannel → Cuttlefish Host → CVD 2 Android 인스턴스                       │
 │                                                                                      │
 │  ★ touch.js는 video 요소의 pointerdown/move/up을 수신하고                            │
 │    offsetX/offsetY를 읽어서 Android 좌표로 변환함                                    │
 │    → 그래서 합성 이벤트에 정확한 clientX/Y가 필요함                                  │
 │      (브라우저가 clientX - videoRect.left = offsetX 로 계산)                          │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 터치 이벤트 라우팅 요약

```
                     사용자 터치/클릭
                           │
                           ▼
              ┌────────────────────────┐
              │ 어디를 터치했는가?      │
              └────────┬───────────────┘
                       │
          ┌────────────┼────────────────┐
          │            │                │
          ▼            ▼                ▼
    ┌──────────┐ ┌──────────────┐ ┌──────────────────┐
    │ 헤더영역  │ │ 오버레이     │ │ 그 외 영역       │
    │ (상단40px)│ │ 터치 타겟    │ │ (비디오/컨트롤)  │
    └────┬─────┘ └──────┬───────┘ └────────┬─────────┘
         │              │                   │
         ▼              ▼                   ▼
    드래그 핸들    좌표 변환 후          pointer-events:
    (그리드 이동)  CVD 2 video에         none 통과
                   합성 이벤트           ↓
                   dispatch             CVD 1 iframe이
                   ↓                    직접 수신
                   CVD 2 터치            ↓
                   입력 처리             CVD 1 터치
                                         입력 처리
```

---

## 7. 파일별 변경 요약

### `view-pane.component.html`
| 커밋 | 변경 내용 |
|------|-----------|
| cb782c7 | `@if (getOverlayId())` 블록 추가 — iframe 기반 PIP 오버레이 |
| def7294 | iframe → canvas 교체, hidden iframe 소스 추가 |
| 8a13cf2 | hidden iframe 제거 (기존 그리드 iframe 재사용) |
| 83c0180 | `.overlay-touch-target` div 추가 |

### `view-pane.component.scss`
| 커밋 | 변경 내용 |
|------|-----------|
| cb782c7 | `.composite-overlay` (position:absolute, 30%x30%, 우상단) |
| 2dac35c | 위치를 중앙(top:50%, left:50%, transform)으로 변경 |
| def7294 | `.composite-container` + `.composite-canvas` + `.composite-source-hidden` |
| 8a13cf2 | `.composite-source-hidden` 삭제 |
| 270e65c | `pointer-events: none` 추가, 사이드바 여백 |
| 24ed093 | 여백 원복, `object-fit` 제거 |
| 83c0180 | `.overlay-touch-target` (pointer-events:auto, z-index:10) |

### `view-pane.component.ts`
| 커밋 | 변경 내용 |
|------|-----------|
| cb782c7 | `getOverlayId()` — 레이아웃에 2개 이상 디바이스면 오버레이 ID 반환 |
| 3870ae8 | 디버그 console.log 추가 |
| def7294 | ★ `startCompositing()`, `runCompositeLoop()`, `stopCompositing()`, `AfterViewChecked` |
| 8a13cf2 | iframe 셀렉터 수정, 폴링 간격 1000ms, 캔버스 크기 최적화 |
| 24ed093 | `getBoundingClientRect()` 기반 좌표 매핑, `clearRect()` 투명 배경 |
| 83c0180 | ★ `setupOverlayTouchHandling()` — 좌표 변환 + 합성 이벤트 디스패치 |

---

## 8. 핵심 설계 결정

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │  왜 Canvas인가? (iframe PIP → Canvas 전환 이유)                     │
 │                                                                     │
 │  iframe PIP:   ✗ WebRTC 연결 중복 (대역폭 2배)                     │
 │                ✗ 위치/크기 커스터마이징 제한                         │
 │                ✗ cross-origin iframe 내부 접근 불가                  │
 │                                                                     │
 │  Canvas 합성:  ✓ 기존 WebRTC 연결 재사용 (video 요소만 참조)        │
 │                ✓ 자유로운 크기/위치 조정                             │
 │                ✓ 투명 배경으로 아래 UI 노출 가능                     │
 │                ✓ requestAnimationFrame으로 동기화                    │
 └─────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────┐
 │  왜 pointer-events: none + auto 조합인가?                           │
 │                                                                     │
 │  canvas 전체를 덮으면:                                              │
 │    ✗ CVD 1의 터치가 차단됨                                          │
 │    ✗ 사이드바 컨트롤(볼륨/전원) 클릭 불가                           │
 │                                                                     │
 │  해결:                                                              │
 │    composite-container  →  pointer-events: none  (모든 터치 통과)   │
 │    overlay-touch-target →  pointer-events: auto  (오버레이만 캡처)  │
 │                                                                     │
 │  결과: CVD 1 영역은 직접 터치, 오버레이 영역만 CVD 2로 전달         │
 └─────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────┐
 │  왜 iframe의 PointerEvent 생성자를 사용하는가?                      │
 │                                                                     │
 │  부모 window: new PointerEvent(...)                                 │
 │    → iframe 내부에서 event instanceof PointerEvent === false        │
 │    → touch.js가 이벤트를 무시할 수 있음                             │
 │                                                                     │
 │  iframe window: new iframeWindow.PointerEvent(...)                  │
 │    → iframe 내부에서 event instanceof PointerEvent === true ✓       │
 │    → touch.js가 정상적으로 처리 ✓                                   │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## 9. 전체 데이터 흐름 (End-to-End)

```
┌─────────┐     WebRTC      ┌──────────────┐     Angular       ┌──────────────────┐
│ CVD 1   │ ──────────────→ │ iframe 1     │ ──────────────→  │                  │
│ Android │   비디오 스트림   │ <video>      │   video 요소     │  Canvas 합성     │
│ 인스턴스│                  │ + touch.js   │   참조            │  렌더링 루프     │
└─────────┘                  └──────────────┘                   │                  │
                                                                │  mainVideo       │ → drawImage
┌─────────┐     WebRTC      ┌──────────────┐     Angular       │  overlayVideo    │ → drawImage(30%)
│ CVD 2   │ ──────────────→ │ iframe 2     │ ──────────────→  │                  │
│ Android │   비디오 스트림   │ <video>      │   video 요소     │  + touchTarget   │
│ 인스턴스│                  │ + touch.js   │   참조            │    위치 동기화   │
└─────────┘                  └──────────────┘                   └──────────────────┘
     ▲                            ▲                                     │
     │                            │                                     │
     │   WebRTC DataChannel       │  합성 PointerEvent                  │ 터치 캡처
     │   터치 좌표 전달            │  dispatchEvent                      │
     │                            │                                     │
     └────────────────────────────┴─────────────────────────────────────┘
                              오버레이 영역 터치 시
```
