require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const chatRoute          = require('./routes/chat');
const sessionsRoute      = require('./routes/sessions');
const filesRoute         = require('./routes/files');
const hackathonsRoute    = require('./routes/hackathons');
const studyRoute         = require('./routes/study');

const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));

// Minimal security headers (no extra dependency)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Serve the frontend from public/
app.use(express.static(path.join(__dirname, '../public')));

// Health check — useful to verify the deploy is alive
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'ek-sathi-backend' }));

app.use('/api/chat',          chatRoute);
app.use('/api/sessions',      sessionsRoute);
app.use('/api/files',         filesRoute);
app.use('/api/hackathons',    hackathonsRoute);
app.use('/api/study',         studyRoute);

// 404 handler for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Catch-all error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

// Vercel imports this file as a serverless function (module.exports = app),
// but app.listen also lets it run standalone locally with `npm run dev`.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Ek Sathi backend running on port ${PORT}`));
}

module.exports = app;
