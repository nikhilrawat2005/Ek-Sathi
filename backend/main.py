"""
Ek Sathi — FastAPI Backend
Handles: Tech News, Opportunity Finder, Health
Runs on port 8000. Node.js backend still on 4646 (chat/study/resume).
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import news, opportunities

app = FastAPI(
    title="Ek Sathi FastAPI",
    description="AI Student Companion — FastAPI backend for Tech News & Opportunities",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ──────────────────────────────────────────────────────────────────
app.include_router(news.router,          prefix="/api/news",          tags=["Tech News"])
app.include_router(opportunities.router, prefix="/api/opportunities",  tags=["Opportunities"])


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "ek-sathi-fastapi"}
