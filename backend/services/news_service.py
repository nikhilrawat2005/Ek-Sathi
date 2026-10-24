"""
News Service — RSS fetcher (Python port of newsService.js)
Free, key-less. Caches 30 min per category.
"""

import asyncio
import time
from typing import List, Dict, Optional
import re
import httpx

# ── Feed URLs ────────────────────────────────────────────────────────────────
FEEDS: Dict[str, List[str]] = {
    "top": [
        "https://feeds.bbci.co.uk/news/rss.xml",
        "https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms",
    ],
    "india": [
        "https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms",
        "https://www.thehindu.com/feeder/default.rss",
    ],
    "world": [
        "https://feeds.bbci.co.uk/news/world/rss.xml",
    ],
    "tech": [
        "https://hnrss.org/frontpage",
        "https://feeds.bbci.co.uk/news/technology/rss.xml",
        "https://www.theverge.com/rss/index.xml",
        "https://techcrunch.com/feed/",
    ],
    "ai": [
        "https://hnrss.org/frontpage?q=AI+OR+LLM+OR+machine+learning",
        "https://feeds.bbci.co.uk/news/technology/rss.xml",
    ],
    "sports": [
        "https://feeds.bbci.co.uk/sport/cricket/rss.xml",
    ],
    "business": [
        "https://feeds.bbci.co.uk/news/business/rss.xml",
    ],
}

CACHE: Dict[str, Dict] = {}
CACHE_TTL = 30 * 60  # 30 minutes


def _cache_get(key: str):
    entry = CACHE.get(key)
    if entry and entry["expires"] > time.time():
        return entry["value"]
    return None


def _cache_set(key: str, value):
    CACHE[key] = {"value": value, "expires": time.time() + CACHE_TTL}


def _decode_entities(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    text = re.sub(r"<[^>]+>", "", text)  # strip HTML tags
    return text.strip()


def _parse_rss(xml: str) -> List[Dict]:
    items = []
    for m in re.finditer(r"<item>([\s\S]*?)</item>", xml):
        if len(items) >= 30:
            break
        body = m.group(1)
        title_m = re.search(r"<title>([\s\S]*?)</title>", body)
        link_m = re.search(r"<link>([\s\S]*?)</link>", body)
        desc_m = re.search(r"<description>([\s\S]*?)</description>", body)
        pub_m = re.search(r"<pubDate>([\s\S]*?)</pubDate>", body)

        title = _decode_entities(title_m.group(1) if title_m else "")
        link = (link_m.group(1) if link_m else "").strip()
        desc = _decode_entities(desc_m.group(1) if desc_m else "")
        pub = (pub_m.group(1) if pub_m else "").strip()

        if title and link:
            items.append({
                "title": title,
                "link": link,
                "description": desc[:200] if desc else "",
                "publishedAt": pub,
            })
    return items


async def _fetch_feed(url: str, timeout: int = 8) -> str:
    headers = {"User-Agent": "Mozilla/5.0 (compatible; EkSathi/1.0)"}
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            return r.text
    except Exception:
        return ""


async def get_news(category: str = "tech", limit: int = 10) -> List[Dict]:
    cat = category if category in FEEDS else "tech"
    cache_key = f"news:{cat}"

    cached = _cache_get(cache_key)
    if cached is not None:
        return cached[:limit]

    urls = FEEDS[cat]
    results = await asyncio.gather(*[_fetch_feed(u) for u in urls])

    collected = []
    for xml in results:
        if xml:
            collected.extend(_parse_rss(xml))

    # de-duplicate by title
    seen: set = set()
    unique = []
    for item in collected:
        key = item["title"].lower()
        if key and key not in seen:
            seen.add(key)
            unique.append(item)

    _cache_set(cache_key, unique)
    return unique[:limit]
