#!/usr/bin/env python3
"""Draw the Moodboard icon: web/src/lib/assets/favicon.svg and extension/public/icon/<size>.png.

One shape list feeds both outputs, so they cannot drift apart. Standard library only.
Run from the repo root: python3 extension/scripts/icons.py
"""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIZES = [16, 32, 48, 96, 128]

# A moodboard: four image tiles of different sizes on a terracotta square. Units on a 64 grid.
# (x, y, w, h, corner radius, fill)
SHAPES = [
    (0, 0, 64, 64, 14, '#b4532a'),
    (10, 11, 22, 28, 3, '#f7f1e7'),
    (35, 11, 19, 16, 3, '#f0d6c4'),
    (35, 30, 19, 23, 3, '#f7f1e7'),
    (10, 42, 22, 11, 3, '#f0d6c4'),
]


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def inside(px, py, s):
    x, y, w, h, r, _ = s
    if not (x <= px <= x + w and y <= py <= y + h):
        return False
    dx = max(x + r - px, 0, px - (x + w - r))
    dy = max(y + r - py, 0, py - (y + h - r))
    return dx * dx + dy * dy <= r * r


def render(size, ss=4):
    """RGBA rows. Each pixel averages ss*ss samples; the last shape under a sample gives its colour."""
    rows = []
    k = 64 / (size * ss)
    for j in range(size):
        row = bytearray()
        for i in range(size):
            r = g = b = a = 0
            for sj in range(ss):
                for si in range(ss):
                    px, py = (i * ss + si + 0.5) * k, (j * ss + sj + 0.5) * k
                    top = None
                    for s in SHAPES:
                        if inside(px, py, s):
                            top = s
                    if top:
                        cr, cg, cb = rgb(top[5])
                        r, g, b, a = r + cr, g + cg, b + cb, a + 1
            n = ss * ss
            row += bytes((r // a, g // a, b // a, round(255 * a / n)) if a else (0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png(size):
    raw = b''.join(b'\x00' + row for row in render(size))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data))

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def svg():
    parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{f}"/>' for x, y, w, h, r, f in SHAPES]
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
            '<title>Moodboard</title>' + ''.join(parts) + '</svg>\n')


if __name__ == '__main__':
    (ROOT / 'web/src/lib/assets/favicon.svg').write_text(svg())
    out = ROOT / 'extension/public/icon'
    for n in SIZES:
        (out / f'{n}.png').write_bytes(png(n))
    print('wrote favicon.svg and', ', '.join(f'{n}.png' for n in SIZES))
