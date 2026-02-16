'use strict';

// ══════════════════════════════════════════════════════════
// routes/stats.js
// ══════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/authenticate');

// GET /api/v1/stats — Tableau de bord CP
router.get('/', authenticate, authorize('CP', 'ADMIN', 'DIRECTEUR'), async (req, res, next) => {
  const db = req.app.locals.db;
  const { annee, mois, agence } = req.query;
  const now   = new Date();
  const y     = annee || now.getFullYear();
  const m     = mois  || now.getMonth() + 1;

  try {
    const [totaux, parNiveau, parStatut, parRegion, evolution] = await Promise.all([

      // Totaux du mois
      db.query(`
        SELECT
          COUNT(*)                                          AS total,
          COUNT(*) FILTER (WHERE niveau = 4)               AS n4,
          COUNT(*) FILTER (WHERE recidive = true)          AS recidives,
          SUM(montant_dt)                                   AS montant_total,
          ROUND(AVG(montant_dt), 2)                         AS montant_moyen,
          COUNT(*) FILTER (WHERE statut = 'CLOTURE')        AS clotures,
          COUNT(*) FILTER (WHERE statut IN ('SOUMIS','EN_COURS','EN_ENQUETE')) AS en_cours
        FROM declarations
        WHERE EXTRACT(YEAR FROM date_constat) = $1
          AND EXTRACT(MONTH FROM date_constat) = $2
          ${agence ? 'AND agence_code = $3' : ''}
      `, agence ? [y, m, agence] : [y, m]),

      // Par niveau
      db.query(`
        SELECT niveau, COUNT(*) AS nb, SUM(montant_dt) AS montant
        FROM declarations
        WHERE EXTRACT(YEAR FROM date_constat) = $1 AND EXTRACT(MONTH FROM date_constat) = $2
        GROUP BY niveau ORDER BY niveau
      `, [y, m]),

      // Par statut
      db.query(`
        SELECT statut, COUNT(*) AS nb
        FROM declarations
        WHERE EXTRACT(YEAR FROM date_constat) = $1 AND EXTRACT(MONTH FROM date_constat) = $2
        GROUP BY statut
      `, [y, m]),

      // Par région
      db.query(`
        SELECT r.nom AS region, COUNT(*) AS nb, SUM(d.montant_dt) AS montant
        FROM declarations d
        JOIN agences a ON a.code = d.agence_code
        JOIN regions  r ON r.id  = a.region_id
        WHERE EXTRACT(YEAR FROM d.date_constat) = $1
        GROUP BY r.nom ORDER BY nb DESC
      `, [y]),

      // Évolution 7 derniers jours
      db.query(`
        SELECT
          date_constat::date AS jour,
          COUNT(*) FILTER (WHERE nature = 'MANQUANT') AS manquants,
          COUNT(*) FILTER (WHERE nature = 'EXCEDENT') AS excedents
        FROM declarations
        WHERE date_constat >= NOW() - INTERVAL '7 days'
        GROUP BY date_constat::date ORDER BY jour
      `),
    ]);

    res.json({
      success: true,
      data: {
        periode:   { annee: y, mois: m },
        totaux:    totaux.rows[0],
        parNiveau: parNiveau.rows,
        parStatut: parStatut.rows,
        parRegion: parRegion.rows,
        evolution: evolution.rows,
      },
      meta: { timestamp: new Date().toISOString() }
    });
  } catch (err) { next(err); }
});

module.exports = router;
