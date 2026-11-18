"""Builds the website into _site/ (GitHub Pages publishes that folder, see .github/workflows/pages.yml).

    python site/build.py            # then open _site/index.html, or serve it: python -m http.server -d _site

It reuses what the app already ships, so nothing is copied by hand: the fonts, the icon, the idea
photos and titles (with their French), the privacy policy (docs/privacy.md) and the photo credits.
"""

import html
import json
import re
import shutil
import tomllib
from pathlib import Path

import markdown
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = ROOT / "_site"
UI = ROOT / "desktop" / "ui"

# The ideas on the moving tape, in order.
TAPE = ["run-5k", "aglio-olio", "bouldering", "stargazing", "board-games", "homemade-pizza", "juggling",
        "paddle", "origami", "watercolor", "frisbee", "picnic", "make-a-beat", "smoothie", "petanque",
        "micro-story", "chess-puzzles", "hike"]

FONTS = ["barlow-condensed-latin-600-normal", "barlow-condensed-latin-700-normal",
         "barlow-condensed-latin-800-normal", "barlow-latin-400-normal", "barlow-latin-500-normal",
         "barlow-latin-600-normal", "courier-prime-latin-400-normal", "courier-prime-latin-700-normal"]


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def duration(lo: int, hi: int) -> str:
    def f(m: int) -> str:
        return f"{m} min" if m < 60 else (f"{m // 60}h{m % 60:02d}" if m % 60 else f"{m // 60}h")
    return f"{f(lo)}–{f(hi)}" if lo != hi else f(lo)


def french_titles() -> dict[str, str]:
    """English idea title -> French, from the app's dictionary (ui/js/i18n-fr.js, `ideas`)."""
    src = (UI / "js" / "i18n-fr.js").read_text(encoding="utf-8")
    block = src[src.index("export const ideas = {"):src.index("export const ideaDetails")]
    return {m[0]: m[1] for m in re.findall(r"^  '((?:[^'\\]|\\.)+)': \['((?:[^'\\]|\\.)+)'", block, re.M)}


def tape_html() -> str:
    ideas = {a["id"]: a for a in tomllib.loads((ROOT / "core" / "data" / "activities.toml").read_text(encoding="utf-8"))["activity"]}
    fr = french_titles()
    out = []
    for i in TAPE:
        a = ideas[i]
        title = a["title"]
        out.append(
            f'<article class="idea"><img src="img/ideas/{i}.jpg" alt="" width="84" height="84" loading="lazy">'
            f'<div><b data-fr="{esc(fr.get(title, title))}">{esc(title)}</b>'
            f'<span>{duration(a["min"], a["max"])}</span></div></article>')
    return "\n        ".join(out)


def page(title: str, body: str, description: str) -> str:
    """A reading page (privacy, credits) with the site's header and footer."""
    index = (SITE / "index.html").read_text(encoding="utf-8")
    head = index[:index.index("<main")]
    foot = index[index.index("</main>") + len("</main>"):]
    head = re.sub(r"<title>.*?</title>", f"<title>{esc(title)}</title>", head, flags=re.S)
    head = re.sub(r'<meta name="description" content=".*?">', f'<meta name="description" content="{esc(description)}">', head, flags=re.S)
    # On a reading page the section links point back to the home page.
    head = re.sub(r'href="#(how|together|privacy|faq)"', r'href="./#\1"', head)
    return (head + '<main id="main" class="doc"><div class="wrap narrow">'
            '<a class="back" href="./" data-i18n>← Back to freetime</a>\n' + body + "</div></main>" + foot)


def privacy_html() -> str:
    md = (ROOT / "docs" / "privacy.md").read_text(encoding="utf-8")
    body = markdown.markdown(md, extensions=["tables"])
    return page("Privacy policy · freetime", body, "How freetime handles your data: what stays on your PC, what the optional online profile stores, and your rights.")


def credits_html() -> str:
    credits = json.loads((UI / "img" / "ideas" / "credits.json").read_text(encoding="utf-8"))
    items = []
    for idea, c in sorted(credits.items()):
        lic = f'<a href="{esc(c["license_url"])}">{esc(c["license"])}</a>' if c.get("license_url") else esc(c["license"])
        items.append(f'<li><a href="{esc(c["page"])}">{esc(idea.replace("-", " "))}</a>: {esc(c["author"])}, {lic}</li>')
    body = ('<h1 data-i18n>Photo credits</h1>'
            '<p data-i18n>Photos of the built-in ideas, with their authors and free licenses.</p>'
            f'<ul class="credit-list">{"".join(items)}</ul>')
    return page("Photo credits · freetime", body, "Authors and licenses of the photos used for freetime's built-in ideas.")


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SITE, OUT, ignore=shutil.ignore_patterns("build.py", "__pycache__"))
    (OUT / "fonts").mkdir()
    for f in FONTS:
        shutil.copy(UI / "fonts" / f"{f}.woff2", OUT / "fonts")
    shutil.copy(UI / "fonts" / "NOTICE.txt", OUT / "fonts")
    shutil.copy(ROOT / "desktop" / "icons" / "128x128.png", OUT / "img" / "icon.png")
    (OUT / "img" / "ideas").mkdir()
    for i in TAPE:  # 168 px squares (84 px at 2x): the 960 px originals would weigh ~1.4 MB here
        im = Image.open(UI / "img" / "ideas" / f"{i}.jpg").convert("RGB")
        side = min(im.size)
        im = im.crop(((im.width - side) // 2, (im.height - side) // 2, (im.width + side) // 2, (im.height + side) // 2))
        im.resize((168, 168), Image.LANCZOS).save(OUT / "img" / "ideas" / f"{i}.jpg", "JPEG", quality=80, optimize=True)

    index = (OUT / "index.html").read_text(encoding="utf-8").replace("<!-- IDEAS -->", tape_html())
    (OUT / "index.html").write_text(index, encoding="utf-8")
    (OUT / "privacy.html").write_text(privacy_html(), encoding="utf-8")
    (OUT / "credits.html").write_text(credits_html(), encoding="utf-8")
    (OUT / ".nojekyll").write_text("")
    print(f"built {OUT}")


if __name__ == "__main__":
    main()
