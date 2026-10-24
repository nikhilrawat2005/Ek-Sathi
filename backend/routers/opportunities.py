"""
Opportunity Finder Router
GET /api/opportunities?type=all|internship|hackathon
"""

from fastapi import APIRouter, Query
from typing import Optional
from services.opportunity_service import get_opportunities

router = APIRouter()


@router.get("")
async def fetch_opportunities(
    type: Optional[str] = Query(None, description="Filter: internship | hackathon | all"),
):
    items = await get_opportunities(filter_type=type)
    return {
        "type": type or "all",
        "count": len(items),
        "opportunities": items,
    }
