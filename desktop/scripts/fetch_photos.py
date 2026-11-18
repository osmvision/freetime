"""Fetches one free-license photo per built-in idea (Openverse: CC BY, CC BY-SA, CC0 or public
domain photos from Flickr; Wikimedia Commons for pinned files), resizes it for the app, records its credit.

    python scripts/fetch_photos.py            # fetch missing photos
    python scripts/fetch_photos.py --sheet    # also build a contact sheet to review them

Photos land in ui/img/ideas/<id>.jpg; credits in ui/img/ideas/credits.json (shown in Settings).
Run it again after adding ideas. To swap a photo, change its query in QUERIES (or add
"id": "File:Name.jpg" to PINNED) and delete the old file.
"""

import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "ui" / "img" / "ideas"
API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia's bot policy asks for a way to reach whoever runs the script. Set
# FREETIME_PHOTO_CONTACT (a URL or email) to get through their rate limits faster.
UA = "freetime-photo-fetch/0.2 ({})".format(
    os.environ.get("FREETIME_PHOTO_CONTACT") or "open-source leisure app; one-off asset build")
WIDTH = 960
FREE = ("cc0", "cc by", "cc-by", "public domain", "pd")

QUERIES = {
    "run-5k": "jogging park runner",
    "bike-explore": "cycling country road bicycle",
    "hiit-home": "burpees workout",
    "yoga-flow": "yoga pose",
    "mobility": "stretching woman",
    "pushup-ladder": "push-up",
    "core": "plank exercise",
    "shadowboxing": "boxing gloves",
    "dance-workout": "zumba class",
    "jump-rope": "skipping rope",
    "calisthenics-park": "street workout",
    "pickup-football": "amateur football match",
    "basketball": "basketball hoop",
    "badminton": "badminton player racket",
    "frisbee": "ultimate frisbee",
    "table-tennis": "table tennis",
    "swim": "swimming pool lanes",
    "bouldering": "climbing gym",
    "skate": "skateboarding",
    "hike": "hiking trail mountains",
    "rustlings": "laptop programming",
    "advent-of-code": "computer code screen",
    "language-sprint": "dictionary",
    "touch-typing": "computer keyboard",
    "wikipedia-random": "library books shelves",
    "free-lecture": "lecture hall",
    "juggling": "juggling",
    "card-trick": "playing cards hand",
    "sketch-window": "sketchbook drawing",
    "make-a-beat": "synthesizer keyboard",
    "pixel-art": "pixel art sprite",
    "micro-story": "typewriter writing",
    "photo-walk": "street photographer camera",
    "tiny-game": "video game controller",
    "origami": "origami crane",
    "walk-podcast": "walking path autumn",
    "power-nap": "hammock",
    "breathing": "meditation",
    "read-chapter": "reading a book",
    "full-album": "vinyl record turntable",
    "reset-room": "living room interior",
    "stargazing": "milky way night sky",
    "call-friend": "phone call smiling",
    "picnic": "picnic blanket park",
    "karaoke": "karaoke",
    "volunteer": "volunteers cleanup",
    "invite-over": "friends dinner table",
    "new-recipe": "cooking kitchen",
    "aglio-olio": "spaghetti",
    "bake": "cookies baking",
    "smoothie": "fruit smoothie glass",
    "cook-off": "cooking together",
    "new-restaurant": "street food",
    "chess-puzzles": "chess board",
    "chess-blitz": "chess pieces",
    "map-quiz": "world map",
    "board-games": "board game",
    "browser-party": "friends laughing",
    "stairs-workout": "running stairs",
    "trail-run": "trail running mountains",
    "pilates": "pilates mat",
    "paddle": "kayaking",
    "sunset-walk": "sunset sea",
    "sign-language": "sign language",
    "documentary-notes": "documentary film",
    "learn-a-song": "acoustic guitar playing",
    "constellations": "constellation night sky",
    "repair-something": "repair tools workbench",
    "future-letter": "handwritten letter",
    "mini-comic": "comic strip drawing",
    "build-something": "lego bricks",
    "video-diary": "vlogging camera",
    "watercolor": "watercolor painting",
    "windowsill-herbs": "herbs pot windowsill",
    "long-bath": "bubble bath",
    "jigsaw": "jigsaw puzzle",
    "tea-ritual": "tea cup teapot",
    "three-good-things": "notebook journal pen",
    "detox-hour": "reading book armchair",
    "viewpoint": "city viewpoint panorama",
    "family-call": "video call laptop",
    "mini-tournament": "table football",
    "market-together": "farmers market",
    "petanque": "petanque boules",
    "kind-messages": "texting smartphone",
    "themed-movie-night": "popcorn movie night",
    "homemade-pizza": "homemade pizza",
    "three-ingredient-dessert": "chocolate mousse",
    "meal-prep": "meal prep containers",
    "lemonade": "lemonade pitcher",
    "pancake-dinner": "pancakes stack",
    "speedrun-level": "game controller",
    "new-free-game": "pc gaming setup",
    "daily-puzzle": "crossword newspaper",
    "finish-abandoned-game": "video game screen",
}

PINNED: dict[str, str] = {}  # idea -> "File:Name.jpg" on Wikimedia Commons
OVERRIDE_INDEX: dict[str, int] = {  # idea -> which search result to take when the first one is off
    "mobility": 3,
    "frisbee": 2,
    "card-trick": 4,
    "make-a-beat": 7,
    "video-diary": 1,
    "detox-hour": 5,
    "daily-puzzle": 4,
    "wikipedia-random": 3,
    "micro-story": 6,
    "stairs-workout": 1,
    "paddle": 1,
    "kind-messages": 5,
    "market-together": 7,
    "long-bath": 6,
    "bouldering": 4,
    "calisthenics-park": 6,
}


def get(url: str) -> bytes:
    """GET with a polite retry: Wikimedia answers 429 when asked too fast."""
    for attempt in range(4):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 3:
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 60 * (attempt + 1)
            print(f"   429, waiting {wait}s", flush=True)
            time.sleep(wait + 5)
    raise RuntimeError("unreachable")


def strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


def search(query: str, quality: bool) -> list[dict]:
    q = f"{query} filetype:bitmap" + (" incategory:Quality_images" if quality else "")
    params = {
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": "6",
        "gsrsearch": q, "gsrlimit": "8", "prop": "imageinfo",
        "iiprop": "url|size|extmetadata", "iiurlwidth": str(WIDTH),
    }
    data = json.loads(get(API + "?" + urllib.parse.urlencode(params)))
    pages = sorted(data.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 99))
    return pages


OPENVERSE = "https://api.openverse.org/v1/images/"
LICENSE_NAMES = {"by": "CC BY", "by-sa": "CC BY-SA", "cc0": "CC0", "pdm": "Public domain"}


def openverse(query: str) -> list[dict]:
    """Openverse (openly licensed images, here from Flickr): free, no key, 200 searches a day.
    Returns choices in the same shape as usable(); NC and ND licenses are never requested."""
    params = {"q": query, "license": "by,by-sa,cc0,pdm", "aspect_ratio": "wide", "source": "flickr",
              "mature": "false", "page_size": "8"}
    data = json.loads(get(OPENVERSE + "?" + urllib.parse.urlencode(params)))
    out = []
    for r in data.get("results", []):
        url = r.get("url") or ""
        if not url.startswith("https://") or (r.get("width") or 0) < 800:
            continue
        version = r.get("license_version") or ""
        name = LICENSE_NAMES.get(r.get("license"), (r.get("license") or "").upper())
        out.append({
            "title": r.get("title") or "Untitled",
            "thumb": url,
            "page": r.get("foreign_landing_url") or "",
            "author": (r.get("creator") or "Unknown").strip(),
            "license": f"{name} {version}".strip() if r.get("license") not in ("cc0", "pdm") else name,
            "license_url": r.get("license_url") or "",
        })
    return out


def pinned(title: str) -> list[dict]:
    params = {"action": "query", "format": "json", "titles": title, "prop": "imageinfo",
              "iiprop": "url|size|extmetadata", "iiurlwidth": str(WIDTH)}
    return list(json.loads(get(API + "?" + urllib.parse.urlencode(params)))["query"]["pages"].values())


def usable(page: dict) -> dict | None:
    info = (page.get("imageinfo") or [{}])[0]
    meta = info.get("extmetadata", {})
    license_name = strip_html(meta.get("LicenseShortName", {}).get("value", ""))
    if not license_name.lower().startswith(FREE) and "public domain" not in license_name.lower():
        return None
    w, h = info.get("width", 0), info.get("height", 0)
    if not w or not h or w < h * 1.15:  # landscape only
        return None
    # Commons' own 960px thumbnail: small and fast. The original (resized here) only as a
    # fallback, and only when it isn't huge.
    thumb = info.get("thumburl") or (info.get("url") if info.get("size", 0) <= 15_000_000 else None)
    if not thumb:
        return None
    return {
        "title": page["title"],
        "thumb": thumb,
        "page": info.get("descriptionurl"),
        "author": strip_html(meta.get("Artist", {}).get("value", "")) or "Unknown",
        "license": license_name,
        "license_url": meta.get("LicenseUrl", {}).get("value", ""),
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # photo titles in any language, even on a Windows console
    OUT.mkdir(parents=True, exist_ok=True)
    credits_path = OUT / "credits.json"
    credits = json.loads(credits_path.read_text(encoding="utf-8")) if credits_path.exists() else {}
    for idea, query in QUERIES.items():
        target = OUT / f"{idea}.jpg"
        if target.exists() and idea in credits:
            continue
        try:
            fetch_one(idea, query, target, credits, credits_path)
        except (urllib.error.URLError, OSError) as e:
            print(f"!! {idea}: skipped ({e}), run again later", flush=True)
        time.sleep(4)  # Openverse allows 20 searches a minute

    if "--restamp" in sys.argv:
        restamp(credits)
    if "--sheet" in sys.argv:
        contact_sheet()


def origin_note(c: dict) -> str:
    """The provenance note embedded in each JPEG (a COM segment)."""
    return (f"Sourced stock photo, not generated. Origin: {c['title']} ({c['page']}), by {c['author']}, "
            f"license {c['license']}. Resized to {WIDTH}px by desktop/scripts/fetch_photos.py.")


def fetch_one(idea: str, query: str, target: Path, credits: dict, credits_path: Path) -> None:
    if idea in PINNED:
        choices = [c for c in map(usable, pinned(PINNED[idea])) if c]
    else:
        choices = openverse(query)
        if not choices and "--commons" in sys.argv:
            choices = [c for c in map(usable, search(query, True) + search(query, False)) if c]
    img = None
    for choice in choices[OVERRIDE_INDEX.get(idea, 0):]:
        try:
            img = Image.open(io.BytesIO(get(choice["thumb"])))
            break
        except (urllib.error.HTTPError, OSError) as e:  # a photo taken down since: try the next one
            print(f"   {idea}: {choice['thumb']} failed ({e}), trying the next result", flush=True)
    if img is None:
        print(f"!! {idea}: nothing usable for '{query}'", flush=True)
        return
    img.draft("RGB", (WIDTH * 2, WIDTH * 2))  # fast JPEG downscale on decode
    img = img.convert("RGB")
    img.thumbnail((WIDTH, WIDTH), Image.LANCZOS)
    img.save(target, "JPEG", quality=78, optimize=True, progressive=True, comment=origin_note(choice).encode("utf-8"))
    credits[idea] = {k: choice[k] for k in ("title", "page", "author", "license", "license_url")}
    print(f"ok {idea}: {choice['title']} ({choice['license']})", flush=True)
    credits_path.write_text(json.dumps(credits, indent=2, ensure_ascii=False), encoding="utf-8")


def restamp(credits: dict) -> None:
    """Rewrites the provenance note of every photo from credits.json, without re-encoding it."""
    for idea, c in credits.items():
        path = OUT / f"{idea}.jpg"
        if not path.exists():
            continue
        data = path.read_bytes()
        note = origin_note(c).encode("utf-8")
        com = b"\xff\xfe" + (len(note) + 2).to_bytes(2, "big") + note
        i, out = 2, bytearray(data[:2])  # FFD8
        while i < len(data) and data[i] == 0xFF and data[i + 1] not in (0xDA, 0xD9):
            size = int.from_bytes(data[i + 2:i + 4], "big")
            if data[i + 1] != 0xFE:  # drop old comments, keep everything else
                out += data[i:i + 2 + size]
            i += 2 + size
        out += com + data[i:]
        path.write_bytes(bytes(out))


def contact_sheet() -> None:
    from PIL import ImageDraw
    ids = [i for i in QUERIES if (OUT / f"{i}.jpg").exists()]
    cols, tw, th = 8, 240, 150
    sheet = Image.new("RGB", (cols * tw, max(1, (len(ids) + cols - 1) // cols) * (th + 18)), "white")
    draw = ImageDraw.Draw(sheet)
    for n, i in enumerate(ids):
        im = Image.open(OUT / f"{i}.jpg")
        im.thumbnail((tw, th))
        x, y = (n % cols) * tw, (n // cols) * (th + 18)
        sheet.paste(im, (x, y))
        draw.text((x + 3, y + th + 2), i, fill="black")
    sheet.save(Path(sys.argv[-1]) if sys.argv[-1].endswith(".png") else OUT.parent / "contact-sheet.png")


if __name__ == "__main__":
    main()
