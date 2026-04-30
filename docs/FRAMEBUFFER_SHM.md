# CVD Framebuffer Shared Memory Format

CVD는 매 프레임을 POSIX 공유 메모리에 기록합니다.

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

- 헤더 구조체: `base/cvd/cuttlefish/host/libs/screen_connector/ring_buffer_manager.h` — `DisplayRingBufferHeader`
- 링 버퍼 구현: `base/cvd/cuttlefish/host/libs/screen_connector/ring_buffer_manager.cpp`
- 프레임 기록 연동: `base/cvd/cuttlefish/host/libs/screen_connector/screen_connector.h` — `InjectFrame()`

아키텍처 설명은 [SCREEN_CONNECTOR_SHM.md](SCREEN_CONNECTOR_SHM.md)를 참조하세요.

## 뷰어

```bash
pip install flask Pillow
python compositor/shm_viewer.py
# 브라우저에서 http://localhost:8090
```
