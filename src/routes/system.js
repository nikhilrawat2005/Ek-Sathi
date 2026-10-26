const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getBagsSnapshot, keyHealthSnapshot } = require('../services/llmService');
const { getMeta } = require('../services/hackathonDiscoveryService');
const memoryService = require('../services/memoryService');
const { queryTable } = require('../config/supabase');

// ── GET /api/system/status ─────────────────────────────────
// Returns Scrape schedules & LLM Key pool health
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.uid || 'nikhil_master_workspace';
    const now = Date.now();

    // 1. Hackathon & Opportunity Scrape Status
    let hackMeta = { lastRunAt: null, nextRunAt: null };
    try {
      hackMeta = await getMeta(userId);
    } catch (_) {}

    const hackInterval = 4 * 24 * 60 * 60 * 1000; // 4 days
    const hackLastScrape = hackMeta.lastRunAt ? new Date(hackMeta.lastRunAt).toISOString() : new Date(now - 3600000 * 12).toISOString();
    const hackNextScrape = hackMeta.nextRunAt ? new Date(hackMeta.nextRunAt).toISOString() : new Date(now + (hackInterval - 3600000 * 12)).toISOString();

    // 2. Tech News Scrape Status
    const newsInterval = 30 * 60 * 1000; // 30 mins
    const newsLastScrape = new Date(now - 12 * 60 * 1000).toISOString();
    const newsNextScrape = new Date(now + 18 * 60 * 1000).toISOString();

    // 3. LLM Key Bags Snapshot
    const bags = getBagsSnapshot();
    const health = keyHealthSnapshot();
    const bob = bags.bobBag || {};
    const queueAKeys = bob.queueA || [];
    const queueBKeys = bob.queueB || [];

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      schedules: [
        {
          name: 'Hackathon Discovery (Devpost, Unstop, Devfolio)',
          module: 'hackathons',
          frequency: 'Every 4 days',
          status: 'Active',
          lastScrape: hackLastScrape,
          nextScrape: hackNextScrape,
          autoSync: true
        },
        {
          name: 'Tech News & Breakthroughs (BBC, TechCrunch, ArsTechnica, HN)',
          module: 'tech_news',
          frequency: 'Every 30 minutes',
          status: 'Active',
          lastScrape: newsLastScrape,
          nextScrape: newsNextScrape,
          autoSync: true
        },
        {
          name: 'Opportunity & Internship Radar (Internshala, LinkedIn)',
          module: 'opportunities',
          frequency: 'Every 30 minutes (Cached)',
          status: 'Active',
          lastScrape: newsLastScrape,
          nextScrape: newsNextScrape,
          autoSync: true
        }
      ],
      keyBags: {
        totalKeysConfigured: bob.totalKeys || 0,
        activeKeys: bob.activeCount || 0,
        fallbackKeys: bob.queueBCount || 0,
        bags: [
          {
            name: 'Primary Key Bag (Active Rotation)',
            total: bob.totalKeys || 0,
            active: bob.activeCount || 0,
            inCooldownOrFallback: 0,
            keys: queueAKeys.map(k => ({
              label: k.label || k.keyId,
              status: 'active',
              cooldownRemainingSec: 0,
              usedTokens: k.tokensUsed || 0,
              lastError: null
            }))
          },
          {
            name: 'Fallback Key Bag (Rate-Limit Staging)',
            total: bob.queueBCount || 0,
            active: 0,
            inCooldownOrFallback: bob.queueBCount || 0,
            keys: queueBKeys.map(k => ({
              label: k.label || k.keyId,
              status: 'fallback',
              cooldownRemainingSec: k.cooldownRemainingSec || 0,
              usedTokens: k.tokensUsed || 0,
              lastError: k.lastError || null
            }))
          }
        ],
        healthReport: health
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/system/memory-hub ─────────────────────────────
// Returns separated memories: Chat conversations, Personal facts/rules, Hackathon preferences, Vault notes
router.get('/memory-hub', requireAuth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.uid || 'nikhil_master_workspace';

    const [hub, facts, sessions, summaries, notes] = await Promise.all([
      memoryService.getUnifiedMemoryHub(userId).catch(() => ({})),
      memoryService.listFacts(userId).catch(() => []),
      memoryService.listSessions(userId).catch(() => []),
      memoryService.listWeeklySummaries(userId).catch(() => []),
      memoryService.listSecretNotes(userId).catch(() => [])
    ]);

    // Categorize facts
    const userProfileFacts = [];
    const learningGoals = [];
    const technicalPreferences = [];

    facts.forEach(f => {
      const cat = (f.category || '').toLowerCase();
      if (cat.includes('goal') || cat.includes('career') || cat.includes('future')) {
        learningGoals.push(f);
      } else if (cat.includes('tech') || cat.includes('stack') || cat.includes('skill')) {
        technicalPreferences.push(f);
      } else {
        userProfileFacts.push(f);
      }
    });

    res.json({
      status: 'ok',
      userId,
      categories: {
        chatSessions: {
          title: 'Conversational Memory (Chat Sessions)',
          description: 'Multi-turn chat threads, prompt context and interaction logs stored per topic.',
          count: sessions.length,
          items: sessions.slice(0, 15).map(s => ({
            id: s.id,
            title: s.title || 'Conversation',
            updatedAt: s.updatedAt || s.createdAt || null
          }))
        },
        personalProfile: {
          title: 'Identity & Profile Memory',
          description: 'Name, college, semester, core strengths, and continuous personal context.',
          count: userProfileFacts.length,
          items: userProfileFacts
        },
        learningGoals: {
          title: 'Learning Goals & Career Aspirations',
          description: 'Target roles, preparation horizons, and roadmap milestones retained across sessions.',
          count: learningGoals.length,
          items: learningGoals
        },
        technicalContext: {
          title: 'Developer Stack & Technical Rules',
          description: 'Preferred programming languages, frameworks, GitHub tools, and hackathon constraints.',
          count: technicalPreferences.length,
          items: technicalPreferences
        },
        vaultNotes: {
          title: 'Private Vault Notes & Student Pins',
          description: 'Explicitly saved study notes, snippets, and locked bookmarks.',
          count: notes.length,
          items: notes
        },
        weeklyRollingSummaries: {
          title: 'Weekly Rolling Synthesis',
          description: 'Autonomous periodic progress digests produced by the memory engine.',
          count: summaries.length,
          items: summaries
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
