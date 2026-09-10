# Ek Sathi — Learn • Build • Grow 🚀

> **Your AI Companion for Learning & Growth.**

Ek Sathi is a student-first AI companion that replaces the fragmented study
journey (GitHub, hackathons, internships, websites — sab alag platforms pe)
with **one local workspace**. Paste any public GitHub repo or website URL and
Ek Sathi turns it into an **interactive study environment** with Q&A — no LLM
key needed.

---

## ✨ Core Feature Cards

| # | Card | What it does |
|---|------|--------------|
| 1 | 🧪 **Project & Hackathon Lab** | Track hackathons, isolated chat per event, countdowns, auto radar |
| 2 | 📚 **GitHub & Website Study** | Analyze any public repo / website → interactive study notes + Q&A |
| 3 | 📝 **Career & Resume** | ATS-proof resume builder + career intelligence |
| 4 | 🔭 **Opportunity Finder** | Internships / hackathons discovery from one place |
| 5 | 📰 **Tech News** | Daily tech digest for students |
| 6 | 🧠 **My Memory** | Domain-isolated memory cards + monthly locked files |

Plus a central **AI chat** — study scheduling lives right inside the chat.

---

## 🚀 Run Locally

```bash
npm install
cp .env.example .env      # fill in values
npm run dev               # or: node src/server.js
```

Open **http://localhost:3000**

- Backend: Node + Express (`src/server.js`)
- Frontend: vanilla static app (`public/`)
- Local dev auth: `DEV_MODE=true` → bearer token `dev-local` (no Firebase login)

> 🔑 **No LLM key needed for the GitHub & Website Study card.** It uses the
> GitHub REST API + public page fetch only. Everything else (chat, memory, …)
> needs keys from `.env`.

---

## 🧪 GitHub & Website Study card

`POST /api/study/*` routes — all work without any LLM key:

- `POST /api/study/github` — `{ url | text }` → analyze repo (README, tree, key files)
- `POST /api/study/github/ask` — `{ url, question }` → Q&A on the analyzed repo
- `GET  /api/study/github/search` — `?q=...&limit=` → search public repos
- `GET  /api/study/github/user` — `?username=...` → profile + public repos
- `POST /api/study/website` — `{ url }` → decode public site (stack, structure, SEO)
- `POST /api/study/website/ask` — `{ url, question }` → Q&A from decoded site

---

## 🧑‍🤝‍🧑 Team (2026–27)

- **Nikhil Rawat** (Lead) + 3 members
- Guide: **Ms. Babli Kumari**
- ABES Engineering College

> ⚠️ Never commit `.env` or `*firebase-adminsdk*.json`. Only `.env.example`.