"""Renders the freetime app icon at every size Tauri needs. Pure Python, no dependencies.

    python scripts/make_icons.py icons

Design: a rounded tile with the brand gradient (violet -> pink -> orange), a white
clock whose hands point to 10:10 (a smile), and a small sparkle.
"""

import math
import struct
import sys
import zlib
from pathlib import Path

STOPS = [(0.0, (124, 92, 255)), (0.55, (255, 93, 143)), (1.0, (255, 184, 77))]


def gradient(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return [c0[i] + (c1[i] - c0[i]) * k for i in range(3)]
    return list(STOPS[-1][1])


def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def segment_distance(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby))
    return math.hypot(px - (ax + abx * t), py - (ay + aby * t))


def rounded_rect_distance(px, py, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    qx, qy = abs(px - cx) - hx, abs(py - cy) - hy
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def sparkle_coverage(x, y, sx, sy, sr, n=4):
    """Four-point star |dx|^.5 + |dy|^.5 <= 1, supersampled n*n."""
    inside = 0
    for i in range(n):
        for j in range(n):
            dx = abs(x + (i + 0.5) / n - sx) / sr
            dy = abs(y + (j + 0.5) / n - sy) / sr
            if math.sqrt(dx) + math.sqrt(dy) <= 1.0:
                inside += 1
    return inside / (n * n)


def render(size):
    s = size / 1024.0
    rect = (64 * s, 64 * s, 960 * s, 960 * s, 200 * s)
    cx, cy = 512 * s, 540 * s
    ring_r = 250 * s
    ring_half = max(30 * s, 0.9)  # keep strokes visible at 16 px
    hand_half = max(26 * s, 0.8)
    hands = [(390.8 * s, 470 * s), (676.5 * s, 445 * s)]  # 10 and 2 o'clock
    dot_r = max(40 * s, 1.0)
    sx, sy, sr = 790 * s, 250 * s, 90 * s
    draw_sparkle = size >= 32

    rows = []
    for y in range(size):
        row = bytearray([0])  # PNG filter: none
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            alpha = clamp01(0.5 - rounded_rect_distance(px, py, *rect))
            if alpha <= 0.0:
                row += b"\0\0\0\0"
                continue
            r, g, b = gradient(clamp01((px + py) / (2 * size)))
            dc = math.hypot(px - cx, py - cy)
            white = clamp01(0.5 - (abs(dc - ring_r) - ring_half))
            for hx, hy in hands:
                white = max(white, clamp01(0.5 - (segment_distance(px, py, cx, cy, hx, hy) - hand_half)))
            white = max(white, clamp01(0.5 - (dc - dot_r)))
            if draw_sparkle and abs(px - sx) <= sr + 1 and abs(py - sy) <= sr + 1:
                white = max(white, sparkle_coverage(x, y, sx, sy, sr))
            r, g, b = (c + (255 - c) * white for c in (r, g, b))
            row += bytes((round(r), round(g), round(b), round(255 * alpha)))
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def ico(images):
    """ICO file with PNG-compressed entries (supported since Windows Vista)."""
    count = len(images)
    out = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    data = b""
    for size, blob in images:
        dim = 0 if size >= 256 else size
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    return out + data


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "icons")
    out.mkdir(parents=True, exist_ok=True)
    cache = {size: render(size) for size in (16, 24, 32, 48, 64, 128, 256, 512)}
    (out / "32x32.png").write_bytes(cache[32])
    (out / "128x128.png").write_bytes(cache[128])
    (out / "128x128@2x.png").write_bytes(cache[256])
    (out / "icon.png").write_bytes(cache[512])
    (out / "icon.ico").write_bytes(ico([(s, cache[s]) for s in (16, 24, 32, 48, 64, 128, 256)]))
    print(f"icons written to {out}")


if __name__ == "__main__":
    main()
