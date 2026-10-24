const express = require('express');
const router = express.Router();
const { getNews, FEEDS } = require('../services/newsService');

// GET /api/news?category=tech&limit=10
router.get('/', async (req, res) => {
  try {
    const category = req.query.category || 'tech';
    const limit = parseInt(req.query.limit, 10) || 10;
    const articles = await getNews(category, Math.min(Math.max(limit, 1), 30));
    res.json({
      category,
      count: articles.length,
      articles,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/categories
router.get('/categories', (req, res) => {
  res.json({ categories: Object.keys(FEEDS) });
});

module.exports = router;
