# CVD Framebuffer 공유 메모리

## 개요

WebRTC `DisplayHandler`가 매 프레임을 POSIX 공유 메모리(`/dev/shm/`)에 기록합니다.
외부 프로세스가 WebRTC 프로토콜 없이 `mmap()`만으로 실시간 프레임에 접근할 수 있습니다.

## 아키텍처

### 프레임 흐름 (Crosvm + WebRTC)

```
Guest GPU (virtio-gpu)
        │
        ▼
Crosvm ──► Wayland socket (--wayland-sock)
        │
        ▼
WaylandServer → Surfaces::HandleSurfaceFrame()
        │
        ▼
ScreenConnector::InjectFrame()
        │
        ▼
WebRTC DisplayHandler callback  ◄── 여기서 /dev/shm에 기록
        │
        ├──► RGBA→I420 변환 → WebRTC 스트리밍
        └──► DisplayRingBufferManager::WriteFrame() → /dev/shm/
```

### 적용 범위

| VM 매니저 | 프론트엔드 | shm 저장 | 이유 |
|-----------|-----------|----------|------|
| Crosvm | WebRTC | O | Wayland → ScreenConnector → DisplayHandler 경로 |
| QEMU | QEMU 내장 VNC | X | framebuffer가 Cuttlefish를 거치지 않음 |

QEMU는 자체 VNC 서버(`-vnc 127.0.0.1:port`)로 framebuffer를 직접 렌더링합니다.
Cuttlefish의 `ScreenConnector`나 `DisplayHandler`를 거치지 않으므로 shm 저장이 불가합니다.

## 구현 위치

shm 로직은 `display_handler.cpp`에 있습니다.

### 1. 초기화 (DisplayHandler 생성자)

```cpp
// display_handler.cpp — 생성자
auto cvd_config = CuttlefishConfig::Get();
auto instance = cvd_config->ForDefaultInstance();
shm_vm_index_ = instance.index();
std::string group_uuid =
    fmt::format("{}", cvd_config->ForDefaultEnvironment().group_uuid());
shm_frame_writer_ = std::make_unique<DisplayRingBufferManager>(
    shm_vm_index_, group_uuid);
```

### 2. 디스플레이 버퍼 할당 (DisplayCreatedEvent)

```cpp
// display_handler.cpp — SetDisplayEventCallback 내부
if (shm_frame_writer_) {
    shm_frame_writer_->CreateLocalDisplayBuffer(
        shm_vm_index_, e.display_number,
        e.display_width, e.display_height);
}
```

### 3. 프레임 기록 (GetScreenConnectorCallback)

```cpp
// display_handler.cpp — 매 프레임 콜백
if (shm_writer) {
    shm_writer->WriteFrame(
        shm_vm_index, display_number, frame_pixels,
        frame_width * frame_height * 4);
}
```

## 공유 메모리 파일 위치

```
/dev/shm/cf_shmem_display_{vm_index}_{display_index}_{group_uuid}
```

- `vm_index`: CVD 그룹 내 VM 번호 (보통 0)
- `display_index`: 디스플레이 번호 (보통 0)
- `group_uuid`: CVD 그룹 고유 식별자

## 메모리 레이아웃

```
+--------+--------+--------+--------------------+
| Offset | Size   | Type   | Field              |
+--------+--------+--------+--------------------+
| 0      | 4 byte | uint32 | display_width      |
| 4      | 4 byte | uint32 | display_height     |
| 8      | 4 byte | uint32 | bpp (bytes/pixel)  |
| 12     | 4 byte | uint32 | last_valid_frame_index |
+--------+--------+--------+--------------------+
| 16     | W*H*4  |  bytes | Frame 0            |
| 16 + W*H*4      |  bytes | Frame 1            |
| 16 + 2*W*H*4    |  bytes | Frame 2            |
+------------------+--------+--------------------+
```

### 헤더 필드 설명

| 필드 | 설명 |
|------|------|
| `display_width` | 프레임 가로 해상도 (픽셀) |
| `display_height` | 프레임 세로 해상도 (픽셀) |
| `bpp` | 픽셀당 바이트 수. 항상 `4` (BGRA 32bit) |
| `last_valid_frame_index` | 가장 최근에 기록된 프레임 슬롯 번호 (0, 1, 2 순환) |

## 프레임 읽기 방법

1. 헤더 16바이트를 읽어 `w`, `h`, `bpp`, `frame_idx` 파싱
2. 최신 프레임 오프셋 계산: `16 + (frame_idx % 3) * w * h * bpp`
3. 해당 오프셋에서 `w * h * bpp` 바이트 읽기
4. 픽셀 포맷은 BGRA (DRM_FORMAT_ARGB8888, little-endian 순서: B, G, R, A)

## Python 예시

```python
import mmap, os, struct

fd = os.open("/dev/shm/cf_shmem_display_0_0_<uuid>", os.O_RDONLY)
mm = mmap.mmap(fd, 0, access=mmap.ACCESS_READ)

w, h, bpp, frame_idx = struct.unpack_from("IIII", mm, 0)
offset = 16 + (frame_idx % 3) * w * h * bpp
pixels = mm[offset : offset + w * h * bpp]  # BGRA raw bytes
```

## 소스 코드 참조

| 파일 | 역할 |
|------|------|
| `host/frontend/webrtc/display_handler.cpp` | shm 초기화, 버퍼 할당, 프레임 기록 |
| `host/frontend/webrtc/display_handler.h` | `shm_frame_writer_`, `shm_vm_index_` 멤버 |
| `host/libs/screen_connector/ring_buffer_manager.h` | `DisplayRingBufferHeader`, `DisplayRingBuffer`, `DisplayRingBufferManager` |
| `host/libs/screen_connector/ring_buffer_manager.cpp` | 링 버퍼 구현 (생성, 읽기, 쓰기) |

## 뷰어

```bash
pip install flask Pillow
python compositor/shm_viewer.py
# 브라우저에서 http://localhost:8090
```
