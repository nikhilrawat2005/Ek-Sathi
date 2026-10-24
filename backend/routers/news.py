"""
Tech News Router
GET /api/news?category=tech&limit=10
Categories: tech, ai, top, india, world, sports, business
"""

from fastapi import APIRouter, Query
from services.news_service import get_news, FEEDS

router = APIRouter()


@router.get("")
async def fetch_news(
    category: str = Query("tech", description="News category"),
    limit: int = Query(10, ge=1, le=30, description="Max articles"),
):
    articles = await get_news(category=category, limit=limit)
    return {
        "category": category,
        "count": len(articles),
        "articles": articles,
    }


@router.get("/categories")
def list_categories():
    return {"categories": list(FEEDS.keys())}
