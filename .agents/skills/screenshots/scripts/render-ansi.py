#!/usr/bin/env python3
"""Render `tmux capture-pane -e -p` output (ANSI text) to a PNG terminal screenshot.

usage: render-ansi.py IN.ansi OUT.png [--from REGEX] [--cursor X,Y] [--title TEXT] [--fixed COLSxROWS]

  --from REGEX   drop every line above the first one matching REGEX (hides the omp splash)
  --cursor X,Y   0-based pane cell of the cursor (tmux `#{cursor_x} #{cursor_y}`), drawn as a block
  --title TEXT   window title in the title bar
  --fixed CxR    GIF frames: the whole pane as exactly C columns x R rows (no cropping, no --from, square corners)

Needs Pillow. Fonts: Fira Code (+ fallbacks) for text, Twemoji for emoji (Pillow cannot draw COLRv1 Noto Color Emoji).
"""

import argparse
import re
import unicodedata
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFont

RGB = tuple[int, int, int]

# shortcut: Fedora font paths, make configurable when a second machine regenerates screenshots.
FONT_DIR = "/usr/share/fonts"
TEXT_FONTS = [  # first font that has the glyph wins
    "fira-code/FiraCode-Regular.ttf",
    "nerd-fonts/SymbolsNerdFont-Regular.ttf",
    "google-noto-vf/NotoSansMono[wght].ttf",
    "gdouros-symbola/Symbola.ttf",
]
BOLD_FONT = "fira-code/FiraCode-Bold.ttf"
EMOJI_FONT = "twemoji/Twemoji.ttf"  # bitmap font, only size 61 exists
EMOJI_SIZE = 61

SIZE = 20  # font px; cell = glyph advance x SIZE*1.5
DEF_FG: RGB = (201, 209, 217)
DEF_BG: RGB = (22, 24, 30)
PAD, BAR, RADIUS = 22, 40, 12

SGR = re.compile(r"\x1b\[([0-9;:]*)m")
ANY_ESC = re.compile(r"\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)")
NON_SGR_ESC = re.compile(
    r"\x1b\[[0-9;:?]*[A-HJKSTfhlnsu]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)"
)

BASE16: list[RGB] = [
    (0, 0, 0),
    (205, 49, 49),
    (13, 188, 121),
    (229, 229, 16),
    (36, 114, 200),
    (188, 63, 188),
    (17, 168, 205),
    (229, 229, 229),
    (102, 102, 102),
    (241, 76, 76),
    (35, 209, 139),
    (245, 245, 67),
    (59, 142, 234),
    (214, 112, 214),
    (41, 184, 219),
    (255, 255, 255),
]
CUBE_LEVELS = [0, 95, 135, 175, 215, 255]


def xterm256(n: int) -> RGB:
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        return (CUBE_LEVELS[n // 36], CUBE_LEVELS[n // 6 % 6], CUBE_LEVELS[n % 6])
    g = 8 + (n - 232) * 10
    return (g, g, g)


@dataclass(slots=True)
class Cell:
    ch: str
    fg: RGB
    bg: RGB
    bold: bool
    dim: bool
    ul: bool
    wide: bool


Row = list[
    Cell | None
]  # one entry per terminal column; a wide char is followed by a None filler


def is_emoji(ch: str) -> bool:
    o = ord(ch)
    return o >= 0x1F000 or o in (0x2728, 0x2705, 0x274C, 0x2B50, 0x26A1)


def char_width(ch: str) -> int:
    if (
        unicodedata.combining(ch)
        or unicodedata.category(ch) in ("Mn", "Cf")
        or ch == "\ufe0f"
    ):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in "WF" else 1


def parse(text: str) -> list[Row]:
    """Turn ANSI text into rows of cells."""
    rows: list[Row] = []
    for raw in text.split("\n"):
        fg: RGB | None = None
        bg: RGB | None = None
        bold = dim = ul = rev = False
        row: Row = []
        pos = 0
        line = NON_SGR_ESC.sub("", raw)
        while pos < len(line):
            m = SGR.match(line, pos)
            if m:
                pos = m.end()
                p = [int(x) if x else 0 for x in re.split(r"[;:]", m.group(1))] or [0]
                i = 0
                while i < len(p):
                    c = p[i]
                    if c == 0:
                        fg = bg = None
                        bold = dim = ul = rev = False
                    elif c == 1:
                        bold = True
                    elif c == 2:
                        dim = True
                    elif c == 4:
                        ul = True
                    elif c == 7:
                        rev = True
                    elif c == 22:
                        bold = dim = False
                    elif c == 24:
                        ul = False
                    elif c == 27:
                        rev = False
                    elif 30 <= c <= 37:
                        fg = xterm256(c - 30)
                    elif 90 <= c <= 97:
                        fg = xterm256(c - 90 + 8)
                    elif 40 <= c <= 47:
                        bg = xterm256(c - 40)
                    elif 100 <= c <= 107:
                        bg = xterm256(c - 100 + 8)
                    elif c == 39:
                        fg = None
                    elif c == 49:
                        bg = None
                    elif c in (38, 48) and i + 1 < len(p):
                        col: RGB | None = None
                        if p[i + 1] == 2 and i + 4 < len(p):
                            col = (p[i + 2], p[i + 3], p[i + 4])
                            i += 4
                        elif p[i + 1] == 5 and i + 2 < len(p):
                            col = xterm256(p[i + 2])
                            i += 2
                        if col:
                            if c == 38:
                                fg = col
                            else:
                                bg = col
                    i += 1
                continue
            if line[pos] == "\x1b":
                pos += 1
                continue
            ch = line[pos]
            pos += 1
            w = char_width(ch)
            if w == 0:
                continue
            f, b = (fg or DEF_FG), (bg or DEF_BG)
            if rev:
                f, b = b, f
            row.append(Cell(ch, f, b, bold, dim, ul, w == 2))
            if w == 2:
                row.append(None)
        rows.append(row)
    return rows


def glyph_bits(font: ImageFont.FreeTypeFont, ch: str) -> bytes:
    """The glyph's pixels: a missing glyph draws the font's .notdef box, so equal bytes mean missing."""
    im = Image.new("L", (SIZE * 2, SIZE * 2))
    ImageDraw.Draw(im).text((0, 0), ch, font=font, fill=255)
    return im.tobytes()


class Fonts:
    def __init__(self) -> None:
        self.text: list[ImageFont.FreeTypeFont] = [
            ImageFont.truetype(f"{FONT_DIR}/{p}", SIZE) for p in TEXT_FONTS
        ]
        self.bold: ImageFont.FreeTypeFont = ImageFont.truetype(
            f"{FONT_DIR}/{BOLD_FONT}", SIZE
        )
        self.notdef: list[bytes] = [glyph_bits(f, "\U0010fffe") for f in self.text]
        self.emoji: ImageFont.FreeTypeFont = ImageFont.truetype(
            f"{FONT_DIR}/{EMOJI_FONT}", EMOJI_SIZE
        )
        self.cw: int = round(self.text[0].getlength("M"))
        self.ch: int = round(SIZE * 1.5)
        self.cache: dict[tuple[str, bool], ImageFont.FreeTypeFont] = {}
        self.emoji_cache: dict[tuple[str, int], Image.Image | None] = {}

    def pick(self, ch: str, bold: bool) -> ImageFont.FreeTypeFont:
        key = (ch, bold)
        if key not in self.cache:
            self.cache[key] = self._lookup(ch, bold)
        return self.cache[key]

    def _lookup(self, ch: str, bold: bool) -> ImageFont.FreeTypeFont:
        if bold and glyph_bits(self.bold, ch) != self.notdef[0]:
            return self.bold
        for font, nd in zip(self.text, self.notdef, strict=True):
            if glyph_bits(font, ch) != nd:
                return font
        return self.text[0]

    def emoji_img(self, ch: str, size: int) -> Image.Image | None:
        key = (ch, size)
        if key not in self.emoji_cache:
            im = Image.new("RGBA", (EMOJI_SIZE * 2, EMOJI_SIZE * 2), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((0, 0), ch, font=self.emoji, embedded_color=True)
            box = im.getbbox()
            cropped: Image.Image | None = im.crop(box) if box else None
            self.emoji_cache[key] = (
                cropped.resize((size, size), Image.Resampling.LANCZOS)  # pyright: ignore[reportUnknownMemberType] Pillow stub gap
                if cropped
                else None
            )
        return self.emoji_cache[key]


# U+2580.. block elements drawn geometrically so they tile without gaps: (x0, y0, x1, y1, alpha) in cell fractions
BLOCKS: dict[str, tuple[float, float, float, float, float]] = {
    "\u2588": (0, 0, 1, 1, 1),
    "\u2580": (0, 0, 1, 0.5, 1),
    "\u2584": (0, 0.5, 1, 1, 1),
    "\u258c": (0, 0, 0.5, 1, 1),
    "\u2590": (0.5, 0, 1, 1, 1),
    "\u2591": (0, 0, 1, 1, 0.25),
    "\u2592": (0, 0, 1, 1, 0.5),
    "\u2593": (0, 0, 1, 1, 0.75),
}

# Box drawing drawn as lines so they connect across rows (font glyphs leave gaps at this line height):
# (left, right, up, down, thick). Rounded corners (U+256D..2570) are drawn square.
BOX: dict[str, tuple[int, int, int, int, int]] = {
    "\u2500": (1, 1, 0, 0, 0),
    "\u2501": (1, 1, 0, 0, 1),
    "\u2502": (0, 0, 1, 1, 0),
    "\u2503": (0, 0, 1, 1, 1),
    "\u250c": (0, 1, 0, 1, 0),
    "\u2510": (1, 0, 0, 1, 0),
    "\u2514": (0, 1, 1, 0, 0),
    "\u2518": (1, 0, 1, 0, 0),
    "\u251c": (0, 1, 1, 1, 0),
    "\u2524": (1, 0, 1, 1, 0),
    "\u252c": (1, 1, 0, 1, 0),
    "\u2534": (1, 1, 1, 0, 0),
    "\u253c": (1, 1, 1, 1, 0),
    "\u256d": (0, 1, 0, 1, 0),
    "\u256e": (1, 0, 0, 1, 0),
    "\u256f": (1, 0, 1, 0, 0),
    "\u2570": (0, 1, 1, 0, 0),
}


def mix(a: RGB, b: RGB, t: float) -> RGB:
    return (
        round(a[0] * t + b[0] * (1 - t)),
        round(a[1] * t + b[1] * (1 - t)),
        round(a[2] * t + b[2] * (1 - t)),
    )


def render(
    rows: list[Row],
    cursor: tuple[int, int] | None,
    title: str,
    fonts: Fonts,
    rounded: bool = True,
) -> Image.Image:
    cw, chh = fonts.cw, fonts.ch
    ncols = max((len(r) for r in rows), default=1)
    w, h = ncols * cw + 2 * PAD, len(rows) * chh + 2 * PAD + BAR
    img = Image.new("RGBA", (w, h), (*DEF_BG, 255))
    d = ImageDraw.Draw(img)
    # backgrounds first so a wide glyph or emoji can overlap the next cell
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if c and c.bg != DEF_BG:
                x0 = PAD + x * cw
                d.rectangle(
                    (
                        x0,
                        PAD + BAR + y * chh,
                        x0 + cw * (2 if c.wide else 1) - 1,
                        PAD + BAR + (y + 1) * chh - 1,
                    ),
                    fill=c.bg,
                )
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if not c or c.ch == " ":
                if c and c.ul:
                    ly = PAD + BAR + (y + 1) * chh - 3
                    d.line((PAD + x * cw, ly, PAD + (x + 1) * cw - 1, ly), fill=c.fg)
                continue
            px, py = PAD + x * cw, PAD + BAR + y * chh
            fg = mix(c.fg, c.bg, 0.55) if c.dim else c.fg
            if c.ch in BLOCKS:
                x0, y0, x1, y1, a = BLOCKS[c.ch]
                d.rectangle(
                    (
                        px + round(x0 * cw),
                        py + round(y0 * chh),
                        px + round(x1 * cw) - 1,
                        py + round(y1 * chh) - 1,
                    ),
                    fill=mix(fg, c.bg, a),
                )
            elif c.ch in BOX:
                left, right, up, down, thick = BOX[c.ch]
                cx, cy = px + cw // 2, py + chh // 2
                segs = (
                    (left, (px, cy, cx, cy)),
                    (right, (cx, cy, px + cw - 1, cy)),
                    (up, (cx, py, cx, cy)),
                    (down, (cx, cy, cx, py + chh - 1)),
                )
                for on, seg in segs:
                    if on:
                        d.line(seg, fill=fg, width=2 if thick else 1)
            elif is_emoji(c.ch):
                size = round(chh * 0.8)
                e = fonts.emoji_img(c.ch, size)
                if e:
                    ex = (
                        px
                        + (cw * (2 if c.wide else 1) - size) // 2
                        + (0 if c.wide else cw // 4)
                    )
                    img.alpha_composite(e, (ex, py + (chh - size) // 2))
            else:
                d.text(
                    (px, py + (chh - SIZE) // 2 - 2),
                    c.ch,
                    font=fonts.pick(c.ch, c.bold),
                    fill=fg,
                )
            if c.ul:
                d.line((px, py + chh - 3, px + cw - 1, py + chh - 3), fill=fg)
    if cursor and cursor[1] < len(rows):
        cx, cy = cursor
        x0, y0 = PAD + cx * cw, PAD + BAR + cy * chh
        d.rectangle((x0, y0 + 2, x0 + cw - 1, y0 + chh - 3), fill=(79, 140, 255))
        under = rows[cy][cx] if cx < len(rows[cy]) else None
        if under and under.ch != " " and not is_emoji(under.ch):
            d.text(
                (x0, y0 + (chh - SIZE) // 2 - 2),
                under.ch,
                font=fonts.pick(under.ch, False),
                fill=DEF_BG,
            )
    # title bar
    d.rectangle((0, 0, w, BAR), fill=mix(DEF_BG, (255, 255, 255), 0.93))
    dots: tuple[RGB, ...] = ((255, 95, 86), (255, 189, 46), (39, 201, 63))
    for i, col in enumerate(dots):
        d.ellipse(
            (PAD + i * 24, BAR // 2 - 7, PAD + i * 24 + 14, BAR // 2 + 7), fill=col
        )
    if title:
        tf = fonts.text[0]
        d.text(
            ((w - tf.getlength(title)) / 2, BAR // 2 - SIZE // 2 - 1),
            title,
            font=tf,
            fill=(139, 148, 158),
        )
    if rounded:
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), RADIUS, fill=255)
        img.putalpha(mask)
        ImageDraw.Draw(img).rounded_rectangle(
            (0, 0, w - 1, h - 1), RADIUS, outline=(48, 54, 61, 255)
        )
    else:
        ImageDraw.Draw(img).rectangle((0, 0, w - 1, h - 1), outline=(48, 54, 61, 255))
    return img


class Args(argparse.Namespace):
    src: str = ""
    out: str = ""
    start: str | None = None
    cursor: str | None = None
    title: str = ""
    fixed: str | None = None


def main() -> None:
    ap = argparse.ArgumentParser()
    _ = ap.add_argument("src")
    _ = ap.add_argument("out")
    _ = ap.add_argument("--from", dest="start")
    _ = ap.add_argument("--cursor")
    _ = ap.add_argument("--title", default="")
    _ = ap.add_argument("--fixed")
    a = ap.parse_args(namespace=Args())
    with open(a.src, encoding="utf-8") as fh:
        text = fh.read().rstrip("\n")
    rows = parse(text)
    cursor: tuple[int, int] | None = None
    # GIF frames: the whole pane as COLSxROWS, same size every frame, square corners
    if a.fixed:
        cols, nrows = (int(v) for v in a.fixed.split("x"))
        rows = rows[:nrows] + [[] for _ in range(nrows - len(rows))]
        for r in rows:
            del r[cols:]
            r.extend([None] * (cols - len(r)))
        if a.cursor:
            cx, cy = (int(v) for v in a.cursor.split(","))
            cursor = (cx, cy)
        render(rows, cursor, a.title, Fonts(), rounded=False).save(a.out)
        return
    plain = [ANY_ESC.sub("", SGR.sub("", ln)) for ln in text.split("\n")]
    top = 0
    if a.start:
        found = next((i for i, ln in enumerate(plain) if re.search(a.start, ln)), None)
        if found is None:
            raise SystemExit(f"--from {a.start!r} matches no line")
        top = found
    rows = rows[top:]
    while rows and not any(c and (c.ch != " " or c.bg != DEF_BG) for c in rows[-1]):
        _ = rows.pop()  # trailing blank rows
    for r in rows:  # trailing blank cells
        while r and (r[-1] is None or (r[-1].ch == " " and r[-1].bg == DEF_BG)):
            _ = r.pop()
    width = max((len(r) for r in rows), default=0)
    if a.cursor:
        cx, cy = (int(v) for v in a.cursor.split(","))
        if cy >= top:
            cursor = (cx, cy - top)
            width = max(width, cursor[0] + 1)
            while len(rows) <= cursor[1]:
                rows.append([])
    for r in rows:
        r.extend([None] * (width - len(r)))
    render(rows, cursor, a.title, Fonts()).save(a.out)


if __name__ == "__main__":
    main()
