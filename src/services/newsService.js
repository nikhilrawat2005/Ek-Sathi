/**
 * newsService.js
 * Free top-headlines via RSS feeds (NO API key required).
 * Caches per-feed for 30 minutes. Uses a tiny regex RSS parser
 * (no extra dependency) that handles RSS 2.0 <item> entries.
 */

const crypto = require('crypto');
const { db, FieldValue } = require('../config/firebase');

/**
 * Make a deterministic safe Firestore doc ID from link
 */
function makeDocId(link) {
  return crypto.createHash('sha256').update(String(link).trim().toLowerCase()).digest('hex').slice(0, 32);
}

// ─────────────────────────────────────────────────────────
// Category → feed URL(s). All are public, key-free RSS feeds.
// ─────────────────────────────────────────────────────────
const FEEDS = {
  top:    [
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms',
  ],
  india:  [
    'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms',
    'https://www.thehindu.com/feeder/default.rss',
  ],
  world:  [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
  ],
  tech:   [
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://feeds.arstechnica.com/arstechnica/index',
    'https://feeds.bbci.co.uk/news/technology/rss.xml',
    'https://hnrss.org/frontpage',
  ],
  ai:     [
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://feeds.bbci.co.uk/news/technology/rss.xml',
    'https://feeds.feedburner.com/oreilly/radar/atom',
  ],
  sports: [
    'https://www.espncricinfo.com/rss/content/story/feeds/0.xml',
    'https://feeds.bbci.co.uk/sport/cricket/rss.xml',
  ],
  business: [
    'https://feeds.bbci.co.uk/news/business/rss.xml',
  ],
};

const CACHE = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function cached(key, fn) {
  const hit = CACHE.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  CACHE.set(key, { value, expires: Date.now() + CACHE_TTL });
  return value;
}

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BobBackend/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '') // strip any leftover HTML tags
    .trim();
}

function parseRSS(xml) {
  const items = [];
  const itemRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < 30) {
    const body = m[1];
    const rawTitle = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1];
    const title = decodeEntities(rawTitle);

    let rawLink = (body.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [, ''])[1];
    if (!rawLink) {
      // Atom feed href
      const atomLink = body.match(/<link[^>]+href=["']([^"']+)["']/);
      if (atomLink) rawLink = atomLink[1];
    }
    const link = decodeEntities(rawLink).trim();

    let rawDesc = (body.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [, ''])[1];
    if (!rawDesc) {
      rawDesc = (body.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [, ''])[1];
    }
    let description = decodeEntities(rawDesc);

    // If description is just HN points & comments URL, format it cleanly
    if (description.includes('Article URL:') || description.includes('Comments URL:')) {
      const pts = (description.match(/Points:\s*(\d+)/i) || [, ''])[1];
      const cms = (description.match(/# Comments:\s*(\d+)/i) || [, ''])[1];
      if (pts || cms) {
        description = `Trending on Hacker News: ${pts ? pts + ' upvotes' : ''}${pts && cms ? ' · ' : ''}${cms ? cms + ' community comments' : ''}. Tap to explore discussion & source.`;
      } else {
        description = 'Trending discussion on Hacker News. Tap to read the full source and community insights.';
      }
    }

    // Clean up excessive whitespace
    description = description.replace(/\s+/g, ' ').trim();
    if (description.length > 280) {
      description = description.slice(0, 277).trim() + '...';
    }

    // Extract pubDate if available
    const rawDate = (body.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/) || [, ''])[1];
    let publishedAt = '';
    if (rawDate) {
      try {
        const d = new Date(decodeEntities(rawDate));
        if (!isNaN(d.getTime())) {
          publishedAt = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }
      } catch (_) {}
    }

    if (title && link) {
      items.push({
        title,
        link,
        description: description || 'Click to read full coverage, breakdown, and technical background.',
        publishedAt: publishedAt || 'Latest update'
      });
    }
  }
  return items;
}

/**
 * Save / Update scraped news items in Firestore (global_news)
 * Automatically updates existing documents if link matches.
 */
async function syncNewsToFirestore(category, articles) {
  if (!db || !Array.isArray(articles) || articles.length === 0) return;
  try {
    const coll = db.collection('global_news');
    const batch = db.batch ? db.batch() : null;
    const now = Date.now();

    for (const item of articles) {
      if (!item.link) continue;
      const docId = makeDocId(item.link);
      const docRef = coll.doc(docId);
      const payload = {
        id: docId,
        title: item.title,
        link: item.link,
        description: item.description || '',
        publishedAt: item.publishedAt || '',
        category,
        updatedAt: now,
        lastScrapedAt: now,
      };

      if (batch) {
        batch.set(docRef, payload, { merge: true });
      } else {
        await docRef.set(payload, { merge: true });
      }
    }

    if (batch) {
      await batch.commit();
    }
  } catch (err) {
    console.warn(`[newsService] syncNewsToFirestore error (${category}):`, err.message);
  }
}

/**
 * Fetch headlines for a category.
 * Reads from Firestore or falls back / syncs with RSS.
 * Returns [{ title, link, description, publishedAt }, ...] (max `limit`).
 */
async function getNews(category = 'top', limit = 5) {
  const cat = (FEEDS[category] ? category : 'top');
  const urls = FEEDS[cat];

  const items = await cached(`news:${cat}`, async () => {
    // 1. Try reading fresh records from Firestore first (within 30 mins)
    try {
      if (db) {
        const snap = await db.collection('global_news')
          .where('category', '==', cat)
          .orderBy('updatedAt', 'desc')
          .limit(limit * 2)
          .get();

        if (!snap.empty) {
          const docs = snap.docs.map(d => d.data());
          // If latest document is fresher than 30 mins, return cached Firestore items
          const newest = docs[0]?.updatedAt || 0;
          if (Date.now() - newest < CACHE_TTL && docs.length >= Math.min(limit, 5)) {
            return docs;
          }
        }
      }
    } catch (e) {
      // ignore & continue to live scrape
    }

    // 2. Perform live scrape
    const collected = [];
    const settled = await Promise.allSettled(urls.map(url => fetchText(url)));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        collected.push(...parseRSS(r.value));
      }
    }
    // de-dupe by title
    const seen = new Set();
    const unique = [];
    for (const it of collected) {
      const key = String((it && it.title) || '').toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(it);
      }
    }

    // 3. Upsert / update items into Firestore in background
    if (unique.length > 0) {
      syncNewsToFirestore(cat, unique).catch(() => {});
    }

    return unique;
  });

  return items.slice(0, limit);
}

/**
 * Periodic full sync for all news categories to Firestore
 */
async function syncAllNewsToFirestore() {
  const results = {};
  for (const cat of Object.keys(FEEDS)) {
    try {
      const articles = await getNews(cat, 25);
      results[cat] = articles.length;
    } catch (err) {
      results[cat] = 0;
    }
  }
  return results;
}

/** Compact numbered list ready for the LLM context. */
function formatNews(headlines) {
  if (!headlines || !headlines.length) return null;
  return headlines
    .map((h, i) => `${i + 1}. ${h.title}`)
    .join('\n');
}

module.exports = { getNews, syncNewsToFirestore, syncAllNewsToFirestore, formatNews, FEEDS, parseRSS };
