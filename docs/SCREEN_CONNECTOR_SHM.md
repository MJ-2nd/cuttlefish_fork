# ScreenConnector 기반 공유 메모리 프레임 저장

## 개요

CVD의 모든 게스트 프레임을 프론트엔드(WebRTC, VNC 등) 종류에 관계없이 POSIX 공유 메모리(`/dev/shm/`)에 자동 기록합니다.

외부 프로세스가 WebRTC/VNC 프로토콜 없이 `mmap()`만으로 실시간 프레임에 접근할 수 있습니다.

## 아키텍처

### 프레임 흐름

```
Guest Wayland Client (게스트 GPU)
        │
        ▼
WaylandServer → Surfaces::HandleSurfaceFrame()
        │
        ▼
ScreenConnector::InjectFrame()   ◄── 여기서 shm에 기록
        │
        ├──► WebRTC DisplayHandler
        ├──► VNC Server
        └──► (기타 프론트엔드)
```

### 왜 ScreenConnector 레이어인가?

#### 이전 방식 (WebRTC 전용)

```
ScreenConnector::InjectFrame()
        │
        ▼
WebRTC DisplayHandler callback  ◄── shm 기록이 여기에 있었음
        │
        ▼
RGBA→I420 변환 → WebRTC 스트리밍
```

이 방식의 문제점:
- **VNC 타겟에서 동작 안 함** — shm 기록 로직이 WebRTC `display_handler.cpp`에만 존재
- **프론트엔드 추가 시 코드 중복** — 새로운 프론트엔드마다 동일한 shm 코드를 복사해야 함
- **관심사 분리 위반** — 프레임 캡처는 프론트엔드의 책임이 아님

#### 현재 방식 (ScreenConnector 공통 레이어)

```
ScreenConnector::InjectFrame()  ◄── shm 기록이 여기로 이동
        │
        ├──► WebRTC DisplayHandler callback
        ├──► VNC Server callback
        └──► (기타 프론트엔드)
```

장점:
- **모든 프론트엔드에서 동작** — WebRTC, VNC, 향후 추가되는 프론트엔드 모두 자동 지원
- **코드 중복 없음** — 한 곳에서만 관리
- **원본 픽셀 캡처** — 프론트엔드별 변환(RGBA→I420 등) 이전의 원시 프레임 저장

### VNC에서 동작하는 이유

VNC 기반 CVD도 `ScreenConnector`를 사용합니다. 프레임 흐름:

```
Guest GPU → Wayland → ScreenConnector::InjectFrame() → VNC encoder
                              │
                              └──► /dev/shm/ 에 프레임 기록
```

`InjectFrame()`은 프론트엔드 콜백 호출 **이전에** 실행되므로, VNC든 WebRTC든 관계없이 모든 프레임이 공유 메모리에 기록됩니다.

## 구현 상세

### 초기화 (ScreenConnector 생성자)

```cpp
// screen_connector.h — 생성자 내부
shm_vm_index_ = instance.index();
std::string group_uuid =
    fmt::format("{}", config->ForDefaultEnvironment().group_uuid());
shm_frame_writer_ = std::make_unique<DisplayRingBufferManager>(
    shm_vm_index_, group_uuid);
```

`CuttlefishConfig`에서 VM 인덱스와 그룹 UUID를 읽어 `DisplayRingBufferManager`를 생성합니다.

### 디스플레이 버퍼 할당 (DisplayCreatedEvent)

```cpp
// screen_connector.h — SetDisplayEventCallback() 내부
void SetDisplayEventCallback(DisplayEventCallback event_callback) {
    auto wrapped = [this, cb = std::move(event_callback)](
                       const DisplayEvent& event) {
      // DisplayCreatedEvent 발생 시 shm 버퍼 할당
      std::visit([this](auto&& e) {
          if constexpr (std::is_same_v<DisplayCreatedEvent, T>) {
              shm_frame_writer_->CreateLocalDisplayBuffer(
                  shm_vm_index_, e.display_number,
                  e.display_width, e.display_height);
          }
      }, event);
      cb(event);  // 원래 콜백도 실행
    };
    sc_android_src_.SetDisplayEventCallback(std::move(wrapped));
}
```

게스트가 새 디스플레이를 생성하면, 프론트엔드 콜백 실행 전에 해당 해상도에 맞는 shm 링 버퍼를 할당합니다.

### 프레임 기록 (InjectFrame)

```cpp
// screen_connector.h — InjectFrame() 내부
if (shm_frame_writer_) {
    shm_frame_writer_->WriteFrame(shm_vm_index_, display_number,
                                  frame_bytes, frame_w * frame_h * 4);
}
```

모든 프레임이 프론트엔드 콜백보다 먼저 shm에 기록됩니다.

## 공유 메모리 포맷

공유 메모리 파일 위치와 헤더 포맷은 [FRAMEBUFFER_SHM.md](FRAMEBUFFER_SHM.md)를 참조하세요.

## 소스 코드 참조

| 파일 | 역할 |
|------|------|
| `host/libs/screen_connector/screen_connector.h` | shm 초기화, 프레임 기록, 디스플레이 이벤트 처리 |
| `host/libs/screen_connector/ring_buffer_manager.h` | `DisplayRingBufferHeader`, `DisplayRingBuffer`, `DisplayRingBufferManager` |
| `host/libs/screen_connector/ring_buffer_manager.cpp` | 링 버퍼 구현 (생성, 읽기, 쓰기) |

## 뷰어

```bash
pip install flask Pillow
python compositor/shm_viewer.py
# 브라우저에서 http://localhost:8090
```
