const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { auditResume, auditResumeBuffer, buildAuditReportPdf } = require('../services/resumeAuditService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// POST /api/resume/audit — multipart (field 'file' + optional 'targetJobDescription')
//          OR JSON body { text, targetJobDescription }
router.post('/audit', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const jd = String(req.body && (req.body.targetJobDescription || req.body.jd || '')).trim();
    if (req.file) {
      const { audit, fileName, charCount, pageCount } = await auditResumeBuffer(req.file.buffer, req.file.originalname, jd);
      return res.json({ status: 'ok', audit, fileName, charCount, pageCount, source: 'file' });
    }
    const text = String((req.body && (req.body.text || req.body.resumeText)) || '').trim();
    if (!text) return res.status(400).json({ error: 'Koi file ya resume text nahi mila — PDF/DOCX upload karo ya text paste karo.' });
    const audit = await auditResume({ resumeText: text, targetJobDescription: jd });
    return res.json({ status: 'ok', audit, fileName: 'Pasted text', charCount: text.length, source: 'text' });
  } catch (err) {
    const status = /too short|text.*lom|50 characters/i.test(String(err.message)) ? 400 : 500;
    res.status(status).json({ error: err.message || 'Audit failed' });
  }
});

// POST /api/resume/audit-pdf — { audit, fileName } → application/pdf
router.post('/audit-pdf', requireAuth, async (req, res) => {
  try {
    const { audit, fileName } = req.body || {};
    if (!audit || typeof audit.atsScore !== 'number') return res.status(400).json({ error: 'audit object missing (atsScore required)' });
    const buf = await buildAuditReportPdf(audit, fileName || 'resume');
    const safe = String(fileName || 'resume').replace(/[^a-zA-Z0-9 _\-()]/g, '_').replace(/\.[^.]+$/, '').slice(0, 70) || 'resume';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}_ATS_Report.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message || 'PDF build failed' });
  }
});

module.exports = router;