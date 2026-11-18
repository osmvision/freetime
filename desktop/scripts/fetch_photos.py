"""Fetches one free-license photo per built-in idea from Wikimedia Commons ("Quality images"),
resizes it for the app, and records its credit.

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
    "hiit-home": "push-up exercise",
    "yoga-flow": "yoga pose",
    "mobility": "stretching exercise",
    "pushup-ladder": "push-up",
    "core": "plank exercise",
    "shadowboxing": "boxing gloves",
    "dance-workout": "dancing people",
    "jump-rope": "skipping rope",
    "calisthenics-park": "outdoor gym pull-up",
    "pickup-football": "amateur football match",
    "basketball": "basketball hoop",
    "badminton": "badminton",
    "frisbee": "frisbee",
    "table-tennis": "table tennis",
    "swim": "swimming pool lanes",
    "bouldering": "bouldering",
    "skate": "skateboarding",
    "hike": "hiking trail mountains",
    "rustlings": "laptop programming",
    "advent-of-code": "computer code screen",
    "language-sprint": "dictionary",
    "touch-typing": "computer keyboard",
    "wikipedia-random": "library bookshelves",
    "free-lecture": "lecture hall",
    "juggling": "juggling",
    "card-trick": "playing cards",
    "sketch-window": "sketchbook drawing",
    "make-a-beat": "synthesizer",
    "pixel-art": "pixel art",
    "micro-story": "typewriter",
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
    "call-friend": "smartphone",
    "picnic": "picnic",
    "karaoke": "karaoke",
    "volunteer": "volunteers",
    "invite-over": "friends dinner table",
    "new-recipe": "cooking kitchen",
    "aglio-olio": "spaghetti",
    "bake": "cookies baking",
    "smoothie": "smoothie",
    "cook-off": "cooking together",
    "new-restaurant": "street food",
    "chess-puzzles": "chess board",
    "chess-blitz": "chess pieces",
    "map-quiz": "world map",
    "board-games": "board game",
    "browser-party": "friends laughing",
    "stairs-workout": "stairs city",
    "trail-run": "trail running mountains",
    "pilates": "pilates mat",
    "paddle": "kayak sea",
    "sunset-walk": "sunset sea",
    "sign-language": "sign language",
    "documentary-notes": "documentary film",
    "learn-a-song": "acoustic guitar playing",
    "constellations": "constellation night sky",
    "repair-something": "repair tools workbench",
    "future-letter": "handwritten letter",
    "mini-comic": "comic strip drawing",
    "build-something": "lego bricks",
    "video-diary": "smartphone video recording",
    "watercolor": "watercolor painting",
    "windowsill-herbs": "herbs pot windowsill",
    "long-bath": "bathtub relaxing",
    "jigsaw": "jigsaw puzzle",
    "tea-ritual": "tea cup teapot",
    "three-good-things": "notebook journal pen",
    "detox-hour": "reading book window",
    "viewpoint": "city viewpoint panorama",
    "family-call": "video call laptop",
    "mini-tournament": "table football",
    "market-together": "outdoor market stalls",
    "petanque": "petanque boules",
    "kind-messages": "smartphone message",
    "themed-movie-night": "home cinema popcorn",
    "homemade-pizza": "homemade pizza",
    "three-ingredient-dessert": "chocolate mousse",
    "meal-prep": "meal prep containers",
    "lemonade": "lemonade pitcher",
    "pancake-dinner": "pancakes stack",
    "speedrun-level": "game controller",
    "new-free-game": "pc gaming setup",
    "daily-puzzle": "crossword puzzle",
    "finish-abandoned-game": "video game screen",
}

PINNED: dict[str, str] = {}


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
    if not info.get("url") or info.get("size", 0) > 15_000_000:
        return None
    return {
        "title": page["title"],
        # The original file: a static download. Asking Commons to render thumbnails gets
        # rate-limited quickly, so the resize happens here instead.
        "thumb": info["url"],
        "page": info.get("descriptionurl"),
        "author": strip_html(meta.get("Artist", {}).get("value", "")) or "Unknown",
        "license": license_name,
        "license_url": meta.get("LicenseUrl", {}).get("value", ""),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    credits_path = OUT / "credits.json"
    credits = json.loads(credits_path.read_text(encoding="utf-8")) if credits_path.exists() else {}
    for idea, query in QUERIES.items():
        target = OUT / f"{idea}.jpg"
        if target.exists() and idea in credits:
            continue
        try:
            fetch_one(idea, query, target, credits, credits_path)
        except urllib.error.HTTPError as e:
            print(f"!! {idea}: skipped ({e.code}), run again later", flush=True)
        time.sleep(20)

    if "--sheet" in sys.argv:
        contact_sheet()


def fetch_one(idea: str, query: str, target: Path, credits: dict, credits_path: Path) -> None:
    choice = None
    sources = [lambda: pinned(PINNED[idea])] if idea in PINNED else [lambda: search(query, True), lambda: search(query, False)]
    for source in sources:
        for page in source():
            choice = usable(page)
            if choice:
                break
        if choice:
            break
    if not choice:
        print(f"!! {idea}: nothing usable for '{query}'", flush=True)
        return
    img = Image.open(io.BytesIO(get(choice["thumb"])))
    img.draft("RGB", (WIDTH * 2, WIDTH * 2))  # fast JPEG downscale on decode
    img = img.convert("RGB")
    img.thumbnail((WIDTH, WIDTH), Image.LANCZOS)
    origin = (f"Sourced stock photo, not generated. Origin: Wikimedia Commons, {choice['title']} ({choice['page']}), "
              f"by {choice['author']}, license {choice['license']}. Resized to {WIDTH}px by desktop/scripts/fetch_photos.py.")
    img.save(target, "JPEG", quality=78, optimize=True, progressive=True, comment=origin.encode("utf-8"))
    credits[idea] = {k: choice[k] for k in ("title", "page", "author", "license", "license_url")}
    print(f"ok {idea}: {choice['title']} ({choice['license']})", flush=True)
    credits_path.write_text(json.dumps(credits, indent=2, ensure_ascii=False), encoding="utf-8")


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
