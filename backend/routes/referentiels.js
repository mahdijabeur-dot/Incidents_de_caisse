'use strict';
// ══════════════════════════════════════════════════════════
// routes/referentiels.js — Référentiels agences, causes…
// ══════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/authenticate');

// Cache in-memory (24h)
const cache = {};
const CACHE_TTL = 24 * 3600 * 1000;
function getCache(key) {
  const c = cache[key];
  if (c && Date.now() - c.at < CACHE_TTL) return c.data;
  return null;
}
function setCache(key, data) { cache[key] = { data, at: Date.now() }; }
function clearCache(key) { delete cache[key]; }

// GET /api/v1/referentiels/agences
router.get('/agences', authenticate, async (req, res, next) => {
  try {
    const cached = getCache('agences');
    if (cached) return res.json({ success: true, data: cached, meta: { cache: true } });

    const db   = req.app.locals.db;
    const rows = await db.query(
      `SELECT a.code, a.nom, a.dir_email, r.nom as region
       FROM agences a JOIN regions r ON r.id = a.region_id
       WHERE a.actif = true ORDER BY a.code`
    );
    setCache('agences', rows.rows);
    res.json({ success: true, data: rows.rows, meta: { timestamp: new Date().toISOString() } });
  } catch (err) { next(err); }
});

// POST /api/v1/referentiels/agences — Admin uniquement
router.post('/agences', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const db  = req.app.locals.db;
    const { code, nom, region_id, dir_email } = req.body;
    await db.query(
      'INSERT INTO agences (code, nom, region_id, dir_email, actif) VALUES ($1,$2,$3,$4,true) ON CONFLICT (code) DO UPDATE SET nom=$2, region_id=$3, dir_email=$4',
      [code, nom, region_id, dir_email]
    );
    clearCache('agences');
    res.status(201).json({ success: true, data: { code, nom } });
  } catch (err) { next(err); }
});

// GET /api/v1/referentiels/causes
router.get('/causes', authenticate, async (req, res) => {
  res.json({ success: true, data: [
    'Erreur de comptage', 'Billet de valeur non détecté', 'Faux billet',
    'Omission de saisie', 'Double saisie', 'Erreur de change devises',
    'Vol ou disparition', 'Incident technique TPE', 'Autre (préciser)',
  ]});
});

// GET /api/v1/referentiels/types-caisse
router.get('/types-caisse', authenticate, async (req, res) => {
  res.json({ success: true, data: [
    'Caisse DT Principale', 'Caisse Devises', 'Caisse GAB/DAB',
    'Caisse Coffre', 'Caisse Monnaie', 'Autre',
  ]});
});

module.exports = router;
