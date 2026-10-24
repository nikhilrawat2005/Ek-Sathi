const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const discovery = require('../services/hackathonDiscoveryService');

// In-memory cache for opportunities
let oppCache = { data: null, expires: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 mins

// GET /api/opportunities?type=all|internship|hackathon
router.get('/', async (req, res) => {
  try {
    const filterType = req.query.type || 'all';

    // Check cache
    if (!oppCache.data || Date.now() > oppCache.expires) {
      // 1. Static high-value opportunities
      const defaultOpportunities = [
        {
          title: "Web Development Internships",
          company: "Internshala",
          link: "https://internshala.com/internships/web-development-internship",
          type: "internship",
          source: "Internshala",
          tags: ["web", "frontend", "backend"],
          stipend: "Varies",
          deadline: "Rolling",
          description: "Explore top frontend, backend, and full stack internships across startups and MNCs."
        },
        {
          title: "Machine Learning / AI Internships",
          company: "Internshala",
          link: "https://internshala.com/internships/machine-learning-internship",
          type: "internship",
          source: "Internshala",
          tags: ["ai", "ml", "python"],
          stipend: "Varies",
          deadline: "Rolling",
          description: "Work on computer vision, NLP, and deep learning engineering roles."
        },
        {
          title: "Python / Data Science Internships",
          company: "Internshala",
          link: "https://internshala.com/internships/python-internship",
          type: "internship",
          source: "Internshala",
          tags: ["python", "data science"],
          stipend: "Varies",
          deadline: "Rolling",
          description: "Data analysis, backend automation, and pipeline development roles."
        },
        {
          title: "Android App Development Internships",
          company: "Internshala",
          link: "https://internshala.com/internships/android-app-development-internship",
          type: "internship",
          source: "Internshala",
          tags: ["android", "mobile", "kotlin"],
          stipend: "Varies",
          deadline: "Rolling",
          description: "Native and cross-platform mobile application development."
        },
        {
          title: "React / Full-Stack Internships",
          company: "Internshala",
          link: "https://internshala.com/internships/reactjs-internship",
          type: "internship",
          source: "Internshala",
          tags: ["react", "fullstack", "javascript"],
          stipend: "Varies",
          deadline: "Rolling",
          description: "Modern JavaScript and web UI internship opportunities."
        },
        {
          title: "Software Engineering Internships on LinkedIn",
          company: "LinkedIn",
          link: "https://www.linkedin.com/jobs/search/?keywords=software%20engineering%20intern&f_TP=1%2C2",
          type: "internship",
          source: "LinkedIn",
          tags: ["software", "engineering", "intern"],
          stipend: "Competitive",
          deadline: "Rolling",
          description: "Direct job openings updated hourly from top tech organizations."
        },
        {
          title: "Browse CSE Hackathons on Unstop",
          company: "Unstop",
          link: "https://unstop.com/hackathons?domain=Computer+Science",
          type: "hackathon",
          source: "Unstop",
          tags: ["hackathon", "cse", "coding"],
          deadline: "Rolling",
          description: "National & global collegiate hackathons and coding challenges."
        },
        {
          title: "Devfolio Hackathons",
          company: "Devfolio",
          link: "https://devfolio.co/hackathons",
          type: "hackathon",
          source: "Devfolio",
          tags: ["web3", "ai", "hackathon"],
          deadline: "Rolling",
          description: "Community-driven hackathons with builder bounties and mentorship."
        }
      ];

      // 2. Fetch live Devpost RSS items
      try {
        const devpostRes = await fetch('https://devpost.com/hackathons.rss?challenge_type[]=online', { timeout: 6000 });
        if (devpostRes.ok) {
          const xml = await devpostRes.text();
          const itemRe = /<item>([\s\S]*?)<\/item>/g;
          let m;
          while ((m = itemRe.exec(xml)) !== null && defaultOpportunities.length < 25) {
            const body = m[1];
            const title = ((body.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1] || '')
              .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
            const link = ((body.match(/<link>([\s\S]*?)<\/link>/) || [, ''])[1] || '').trim();
            const desc = ((body.match(/<description>([\s\S]*?)<\/description>/) || [, ''])[1] || '')
              .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim().slice(0, 200);

            if (title && link) {
              defaultOpportunities.push({
                title,
                company: "Devpost",
                link,
                type: "hackathon",
                source: "Devpost",
                description: desc,
                tags: ["hackathon", "online", "tech"],
                deadline: "See link"
              });
            }
          }
        }
      } catch (_) {
        // Fallback to defaults
      }

      oppCache = { data: defaultOpportunities, expires: Date.now() + CACHE_TTL };
    }

    let results = oppCache.data || [];
    if (filterType === 'internship') {
      results = results.filter(i => i.type === 'internship');
    } else if (filterType === 'hackathon') {
      results = results.filter(i => i.type === 'hackathon');
    }

    res.json({
      type: filterType,
      count: results.length,
      opportunities: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
