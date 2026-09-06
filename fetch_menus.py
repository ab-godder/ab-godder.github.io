"""
Regenerates data/menus.json from UC Berkeley Dining's public menu backend
(https://dining.berkeley.edu/menus/). Run this daily to keep the static
site's data fresh:

    python fetch_menus.py

Uses only the Python standard library (no pip installs required).
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

AJAX_URL = "https://dining.berkeley.edu/wp-admin/admin-ajax.php"
OUT_PATH = Path(__file__).parent / "data" / "menus.json"
DAY_OFFSETS = range(-1, 7)  # Yesterday .. +6 days, matches the site's own date picker
EXCLUDED_LOCATIONS = {"Bear Market", "Cub Market"}  # convenience stores, no real menu data


def fetch_date_html(date_str: str) -> str:
    data = urllib.parse.urlencode(
        {"action": "cald_filter_xml", "location": "", "mealperiod": "", "date": date_str}
    ).encode()
    req = urllib.request.Request(
        AJAX_URL,
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (compatible; BerkeleyDiningMenuFetcher/1.0)",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _first(pattern, text, default=""):
    m = re.search(pattern, text, re.S)
    return m.group(1).strip() if m else default


def parse_locations(html_text: str):
    locations = []
    for chunk in html_text.split('<li class="location-name ')[1:]:
        name = _first(r'<span class="cafe-title">(.*?)</span>', chunk)
        if not name or name in EXCLUDED_LOCATIONS:
            continue
        status = _first(r'<span class="status[^"]*">(.*?)</span>', chunk)
        times_block = _first(r'<div class="times">(.*?)</div>', chunk)
        hours = [h.strip() for h in re.findall(r"<span>(.*?)</span>", times_block, re.S) if h.strip()]

        meals = []
        for mchunk in chunk.split('<li class="preiod-name ')[1:]:
            meal_name = _first(r'<span>(.*?)<span class="accordion-icon">', mchunk)
            if not meal_name:
                continue
            categories = []
            for cchunk in mchunk.split('<div class="cat-name">')[1:]:
                cat_name = _first(r"^\s*<span>(.*?)</span>", cchunk)
                items = []
                for ichunk in cchunk.split('<li class="recip')[1:]:
                    tag_str = _first(r'^([^"]*)"', ichunk)
                    tags = [t for t in tag_str.split() if t]
                    item_name = _first(r"<span>(.*?)</span>", ichunk)
                    icons = re.findall(r'<span class="allg-tooltip">(.*?)</span>', ichunk)
                    if item_name:
                        items.append({"name": item_name, "tags": tags, "icons": icons})
                if cat_name and items:
                    categories.append({"name": cat_name, "items": items})
            if categories:
                meals.append({"name": meal_name, "categories": categories})

        locations.append(
            {
                "slug": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
                "name": name,
                "status": status,
                "hours": hours,
                "meals": meals,
            }
        )
    return locations


def date_label(d: datetime, today: datetime) -> str:
    delta = (d.date() - today.date()).days
    if delta == -1:
        return "Yesterday"
    if delta == 0:
        return "Today"
    if delta == 1:
        return "Tomorrow"
    return d.strftime("%a, %b %-d") if hasattr(d, "strftime") else d.strftime("%a, %b %d")


def main():
    today = datetime.now()
    dates_meta = []
    by_date = {}

    for offset in DAY_OFFSETS:
        d = today + timedelta(days=offset)
        date_str = d.strftime("%Y%m%d")
        try:
            html_text = fetch_date_html(date_str)
        except urllib.error.URLError as e:
            print(f"  ! failed to fetch {date_str}: {e}")
            continue

        try:
            label = date_label(d, today)
        except ValueError:
            label = d.strftime("%a, %b %d").replace(" 0", " ")

        locations = parse_locations(html_text)
        dates_meta.append(
            {"date": date_str, "label": label, "display": d.strftime("%a, %b %d").replace(" 0", " ")}
        )
        by_date[date_str] = {"locations": locations}
        print(f"  {date_str} ({label}): {len(locations)} locations")
        time.sleep(0.4)

    output = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "dates": dates_meta,
        "by_date": by_date,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
