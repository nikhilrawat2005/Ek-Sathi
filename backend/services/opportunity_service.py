"""
Opportunity Finder Service
Discovers internships & hackathons from free public sources.
No API key required — uses public RSS/HTML endpoints.
"""

import asyncio
import time
import re
import httpx
from typing import List, Dict, Optional

CACHE: Dict[str, Dict] = {}
CACHE_TTL = 4 * 60 * 60  # 4 hours


def _cache_get(key: str):
    entry = CACHE.get(key)
    if entry and entry["expires"] > time.time():
        return entry["value"]
    return None


def _cache_set(key: str, value):
    CACHE[key] = {"value": value, "expires": time.time() + CACHE_TTL}


async def _fetch(url: str, timeout: int = 12) -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            return r.text
    except Exception as e:
        return ""


def _strip_html(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", text).strip()


# ── Internshala RSS ──────────────────────────────────────────────────────────
async def _fetch_internshala() -> List[Dict]:
    """
    Internshala doesn't expose a public RSS, so we surface the main categories
    as static deep links students can directly click — no scraping needed.
    """
    return [
        {
            "title": "Web Development Internships",
            "company": "Internshala",
            "link": "https://internshala.com/internships/web-development-internship",
            "type": "internship",
            "source": "Internshala",
            "tags": ["web", "frontend", "backend"],
            "stipend": "Varies",
            "deadline": "Rolling",
        },
        {
            "title": "Machine Learning / AI Internships",
            "company": "Internshala",
            "link": "https://internshala.com/internships/machine-learning-internship",
            "type": "internship",
            "source": "Internshala",
            "tags": ["ai", "ml", "python"],
            "stipend": "Varies",
            "deadline": "Rolling",
        },
        {
            "title": "Python / Data Science Internships",
            "company": "Internshala",
            "link": "https://internshala.com/internships/python-internship",
            "type": "internship",
            "source": "Internshala",
            "tags": ["python", "data science"],
            "stipend": "Varies",
            "deadline": "Rolling",
        },
        {
            "title": "Android App Development Internships",
            "company": "Internshala",
            "link": "https://internshala.com/internships/android-app-development-internship",
            "type": "internship",
            "source": "Internshala",
            "tags": ["android", "mobile", "java", "kotlin"],
            "stipend": "Varies",
            "deadline": "Rolling",
        },
        {
            "title": "React / Full-Stack Internships",
            "company": "Internshala",
            "link": "https://internshala.com/internships/reactjs-internship",
            "type": "internship",
            "source": "Internshala",
            "tags": ["react", "fullstack", "javascript"],
            "stipend": "Varies",
            "deadline": "Rolling",
        },
    ]


# ── Devpost Hackathons RSS ───────────────────────────────────────────────────
async def _fetch_devpost() -> List[Dict]:
    xml = await _fetch("https://devpost.com/hackathons.rss?challenge_type[]=online")
    if not xml:
        return []

    items = []
    for m in re.finditer(r"<item>([\s\S]*?)</item>", xml):
        if len(items) >= 15:
            break
        body = m.group(1)
        title_m = re.search(r"<title>([\s\S]*?)</title>", body)
        link_m = re.search(r"<link>([\s\S]*?)</link>", body)
        desc_m = re.search(r"<description>([\s\S]*?)</description>", body)

        title = _strip_html(title_m.group(1) if title_m else "")
        link = (link_m.group(1) if link_m else "").strip()
        desc = _strip_html(desc_m.group(1) if desc_m else "")

        if title and link:
            items.append({
                "title": title,
                "company": "Devpost",
                "link": link,
                "type": "hackathon",
                "source": "Devpost",
                "description": desc[:300] if desc else "",
                "tags": ["hackathon", "online", "tech"],
                "deadline": "See link",
            })
    return items


# ── Unstop Hackathons (static curated) ──────────────────────────────────────
async def _fetch_unstop() -> List[Dict]:
    return [
        {
            "title": "Browse CSE Hackathons on Unstop",
            "company": "Unstop",
            "link": "https://unstop.com/hackathons?domain=Computer+Science",
            "type": "hackathon",
            "source": "Unstop",
            "tags": ["hackathon", "cse", "ai", "web"],
            "deadline": "Rolling",
            "description": "Find the latest CSE hackathons on Unstop — India's largest student opportunity platform.",
        },
        {
            "title": "Browse Internships on Unstop",
            "company": "Unstop",
            "link": "https://unstop.com/internships",
            "type": "internship",
            "source": "Unstop",
            "tags": ["internship", "tech", "engineering"],
            "deadline": "Rolling",
            "description": "Discover paid & unpaid internships for engineering students.",
        },
    ]


# ── LinkedIn Jobs (public open search) ──────────────────────────────────────
async def _fetch_linkedin() -> List[Dict]:
    return [
        {
            "title": "Software Engineering Intern — Search on LinkedIn",
            "company": "LinkedIn",
            "link": "https://www.linkedin.com/jobs/search/?keywords=software%20engineering%20intern&f_TP=1%2C2",
            "type": "internship",
            "source": "LinkedIn",
            "tags": ["software", "engineering", "intern"],
            "deadline": "Rolling",
            "description": "Search for SDE internships posted in the last 24 hours on LinkedIn.",
        },
        {
            "title": "AI/ML Engineer Intern — Search on LinkedIn",
            "company": "LinkedIn",
            "link": "https://www.linkedin.com/jobs/search/?keywords=machine+learning+intern&f_TP=1%2C2",
            "type": "internship",
            "source": "LinkedIn",
            "tags": ["ml", "ai", "python", "intern"],
            "deadline": "Rolling",
            "description": "ML internships from top companies on LinkedIn.",
        },
    ]


# ── Main aggregator ──────────────────────────────────────────────────────────
async def get_opportunities(filter_type: Optional[str] = None) -> List[Dict]:
    cache_key = f"opportunities:{filter_type or 'all'}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    internshala, devpost, unstop, linkedin = await asyncio.gather(
        _fetch_internshala(),
        _fetch_devpost(),
        _fetch_unstop(),
        _fetch_linkedin(),
    )

    all_items = internshala + devpost + unstop + linkedin

    if filter_type == "internship":
        all_items = [i for i in all_items if i.get("type") == "internship"]
    elif filter_type == "hackathon":
        all_items = [i for i in all_items if i.get("type") == "hackathon"]

    _cache_set(cache_key, all_items)
    return all_items
