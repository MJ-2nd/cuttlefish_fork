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
shm_path: str = ""


def find_shm_file() -> str:
    """Auto-detect a cf_shmem_display_* file in /dev/shm/."""
    candidates = sorted(glob.glob("/dev/shm/cf_shmem_display_*"))
    if not candidates:
        raise FileNotFoundError(
            "No /dev/shm/cf_shmem_display_* files found. Is CVD running?"
        )
    print(f"Found shared memory files: {candidates}")
    return candidates[0]


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


def generate_mjpeg():
    """Generator that yields MJPEG frames from shared memory."""
    from PIL import Image

    fd = os.open(shm_path, os.O_RDONLY)
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
            # b, g, r, a = img.split()
            # img = Image.merge("RGB", (r, g, b))

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


@app.route("/")
def index():
    return (
        "<html><body style='margin:0;background:#000'>"
        "<img src='/stream' style='max-width:100vw;max-height:100vh'>"
        "</body></html>"
    )


@app.route("/stream")
def stream():
    return Response(
        generate_mjpeg(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def main():
    global shm_path

    parser = argparse.ArgumentParser(description="CVD Shared Memory Viewer")
    parser.add_argument(
        "--shm",
        default=None,
        help="Path to shared memory file (auto-detect if omitted)",
    )
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    shm_path = args.shm or find_shm_file()
    print(f"Using shared memory: {shm_path}")
    print(f"Open http://{args.host}:{args.port} in your browser")

    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
