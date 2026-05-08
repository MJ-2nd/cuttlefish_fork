#!/usr/bin/env python3
"""CVD Shared Memory Framebuffer Viewer — MJPEG stream over HTTP."""

import argparse
import glob
import io
import mmap
import os
import struct
import time

from flask import Flask, Response

HEADER_SIZE = 16  # 4x uint32: width, height, bpp, last_valid_frame_index

app = Flask(__name__)
shm_paths: list[str] = []

COMPOSITE_MODES = {
    "overlap": "Full Overlap — 디스플레이를 순서대로 겹침",
    "split_h": "Side-by-Side Split — 좌우 절반 분할",
    "split_v": "Vertical Split — 상하 절반 분할",
    "blend": "Alpha Blend — 반투명 오버레이",
    "pip": "Picture-in-Picture — 메인 + 우하단 서브",
}


def find_shm_files() -> list[str]:
    """Auto-detect cf_shmem_display_* files in /dev/shm/."""
    candidates = sorted(glob.glob("/dev/shm/cf_shmem_display_*"))
    if not candidates:
        raise FileNotFoundError(
            "No /dev/shm/cf_shmem_display_* files found. Is CVD running?"
        )
    print(f"Found shared memory files: {candidates}")
    return candidates


def read_frame(mm: mmap.mmap) -> tuple[int, int, bytes] | None:
    """Read the latest frame from the mmap'd ring buffer.

    Returns (width, height, rgba_bytes) or None if header is invalid.
    """
    header = mm[:HEADER_SIZE]
    w, h, bpp, frame_idx = struct.unpack_from("IIII", header)

    if w == 0 or h == 0 or bpp == 0:
        return None

    frame_size = w * h * bpp
    offset = HEADER_SIZE + (frame_idx % 3) * frame_size

    if offset + frame_size > mm.size():
        return None

    return w, h, mm[offset : offset + frame_size]


def open_shm(path: str) -> mmap.mmap:
    """Open a shared memory file and return an mmap object."""
    fd = os.open(path, os.O_RDONLY)
    file_size = os.fstat(fd).st_size
    return mmap.mmap(fd, file_size, access=mmap.ACCESS_READ)


def read_frame_as_image(mm: mmap.mmap):
    """Read a frame and return a PIL Image, or None."""
    from PIL import Image

    result = read_frame(mm)
    if result is None:
        return None
    w, h, pixel_data = result
    img = Image.frombytes("RGBA", (w, h), pixel_data)
    return img


def composite_overlap(images):
    """Layer all images on top of each other (last on top)."""
    from PIL import Image

    base = images[0].copy().convert("RGBA")
    for img in images[1:]:
        layer = img.convert("RGBA").resize(base.size)
        base.paste(layer, (0, 0), layer)
    return base.convert("RGB")


def composite_split_h(images):
    """Side-by-side horizontal split: each display gets equal horizontal slice."""
    from PIL import Image

    n = len(images)
    base = images[0].copy().convert("RGB")
    w, h = base.size
    strip_w = w // n

    for i, img in enumerate(images):
        resized = img.convert("RGB").resize((w, h))
        x_start = i * strip_w
        x_end = w if i == n - 1 else (i + 1) * strip_w
        crop = resized.crop((x_start, 0, x_end, h))
        base.paste(crop, (x_start, 0))
    return base


def composite_split_v(images):
    """Vertical split: each display gets equal vertical slice."""
    from PIL import Image

    n = len(images)
    base = images[0].copy().convert("RGB")
    w, h = base.size
    strip_h = h // n

    for i, img in enumerate(images):
        resized = img.convert("RGB").resize((w, h))
        y_start = i * strip_h
        y_end = h if i == n - 1 else (i + 1) * strip_h
        crop = resized.crop((0, y_start, w, y_end))
        base.paste(crop, (0, y_start))
    return base


def composite_blend(images):
    """Alpha blend all images together with equal weight."""
    from PIL import Image

    base = images[0].copy().convert("RGB").resize(images[0].size)
    weight = 1.0 / len(images)

    for i, img in enumerate(images):
        resized = img.convert("RGB").resize(base.size)
        if i == 0:
            from PIL import ImageChops
            import numpy as np

            result_data = np.array(resized, dtype=np.float32) * weight
        else:
            import numpy as np

            result_data += np.array(resized, dtype=np.float32) * weight

    import numpy as np

    return Image.fromarray(result_data.astype(np.uint8), "RGB")


def composite_pip(images):
    """Picture-in-Picture: first display full size, others as thumbnails."""
    base = images[0].copy().convert("RGB")
    w, h = base.size
    pip_scale = 4  # sub-displays are 1/4 size
    pip_w, pip_h = w // pip_scale, h // pip_scale
    margin = 10

    for i, img in enumerate(images[1:]):
        thumb = img.convert("RGB").resize((pip_w, pip_h))
        x = w - pip_w - margin - i * (pip_w + margin)
        y = h - pip_h - margin
        if x < 0:
            x = margin
        base.paste(thumb, (x, y))
    return base


COMPOSITE_FUNCS = {
    "overlap": composite_overlap,
    "split_h": composite_split_h,
    "split_v": composite_split_v,
    "blend": composite_blend,
    "pip": composite_pip,
}


def generate_mjpeg(path: str):
    """Generator that yields MJPEG frames from shared memory."""
    from PIL import Image

    fd = os.open(path, os.O_RDONLY)
    file_size = os.fstat(fd).st_size
    mm = mmap.mmap(fd, file_size, access=mmap.ACCESS_READ)

    try:
        while True:
            result = read_frame(mm)
            if result is None:
                time.sleep(0.1)
                continue

            w, h, pixel_data = result

            # BGRA (DRM_FORMAT_ARGB8888 in little-endian) -> RGB
            img = Image.frombytes("RGBA", (w, h), pixel_data)
            img = img.convert("RGB")

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            frame = buf.getvalue()

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            )

            time.sleep(0.033)  # ~30 fps
    finally:
        mm.close()
        os.close(fd)


def generate_composite_mjpeg(paths: list[str], mode: str):
    """Generator that yields composited MJPEG frames from multiple shm files."""
    composite_fn = COMPOSITE_FUNCS[mode]
    mmaps = [open_shm(p) for p in paths]

    try:
        while True:
            images = []
            for mm in mmaps:
                img = read_frame_as_image(mm)
                if img is not None:
                    images.append(img)

            if len(images) < 2:
                time.sleep(0.1)
                continue

            composited = composite_fn(images)

            buf = io.BytesIO()
            composited.save(buf, format="JPEG", quality=80)
            frame = buf.getvalue()

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            )

            time.sleep(0.033)  # ~30 fps
    finally:
        for mm in mmaps:
            mm.close()


@app.route("/")
def index():
    # Individual streams
    items = ""
    for i, path in enumerate(shm_paths):
        label = os.path.basename(path)
        items += (
            f"<div style='text-align:center'>"
            f"<div style='color:#aaa;margin-bottom:4px;font-family:monospace'>{label}</div>"
            f"<img src='/stream/{i}' style='max-width:100%;max-height:90vh'>"
            f"</div>"
        )

    # Composite mode links (only if multiple displays)
    composite_section = ""
    if len(shm_paths) >= 2:
        mode_links = ""
        for mode, desc in COMPOSITE_MODES.items():
            mode_links += (
                f"<a href='/composite/{mode}' "
                f"style='color:#4fc3f7;text-decoration:none;font-family:monospace;"
                f"display:block;margin:6px 0;padding:8px 12px;"
                f"border:1px solid #333;border-radius:4px'>"
                f"{desc}</a>"
            )
        composite_section = (
            f"<div style='width:100%;text-align:center;margin-top:16px;"
            f"border-top:1px solid #333;padding-top:16px'>"
            f"<div style='color:#fff;font-family:monospace;font-size:16px;"
            f"margin-bottom:8px'>Composite Modes</div>"
            f"{mode_links}</div>"
        )

    return (
        "<html><body style='margin:0;padding:8px;background:#000;"
        "display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:flex-start'>"
        f"{items}{composite_section}"
        "</body></html>"
    )


@app.route("/stream/<int:idx>")
def stream(idx):
    if idx < 0 or idx >= len(shm_paths):
        return "Invalid stream index", 404
    return Response(
        generate_mjpeg(shm_paths[idx]),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/composite/<mode>")
def composite_view(mode):
    if mode not in COMPOSITE_MODES:
        return f"Unknown mode. Available: {', '.join(COMPOSITE_MODES.keys())}", 404
    if len(shm_paths) < 2:
        return "Need at least 2 displays for compositing", 400

    # Navigation bar
    nav_links = " | ".join(
        f"<a href='/composite/{m}' style='color:{'#fff' if m == mode else '#4fc3f7'};"
        f"text-decoration:none;font-family:monospace'>{m}</a>"
        for m in COMPOSITE_MODES
    )
    nav = (
        f"<div style='text-align:center;padding:8px;font-family:monospace'>"
        f"<a href='/' style='color:#4fc3f7;text-decoration:none;margin-right:16px'>← Back</a>"
        f"{nav_links}</div>"
    )

    desc = COMPOSITE_MODES[mode]
    return (
        f"<html><body style='margin:0;padding:0;background:#000;color:#fff'>"
        f"{nav}"
        f"<div style='text-align:center;padding:4px;font-family:monospace;color:#aaa'>{desc}</div>"
        f"<div style='text-align:center'>"
        f"<img src='/composite_stream/{mode}' style='max-width:100%;max-height:85vh'>"
        f"</div></body></html>"
    )


@app.route("/composite_stream/<mode>")
def composite_stream(mode):
    if mode not in COMPOSITE_FUNCS:
        return "Unknown mode", 404
    return Response(
        generate_composite_mjpeg(shm_paths, mode),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def main():
    global shm_paths

    parser = argparse.ArgumentParser(description="CVD Shared Memory Viewer")
    parser.add_argument(
        "--shm",
        nargs="*",
        default=None,
        help="Path(s) to shared memory file(s) (auto-detect if omitted)",
    )
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    shm_paths = args.shm if args.shm else find_shm_files()
    print(f"Using shared memory: {shm_paths}")
    print(f"Streaming {len(shm_paths)} display(s)")
    if len(shm_paths) >= 2:
        print(f"Composite modes available: {', '.join(COMPOSITE_MODES.keys())}")
    print(f"Open http://{args.host}:{args.port} in your browser")

    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
