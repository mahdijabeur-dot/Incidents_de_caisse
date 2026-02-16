'use strict';

const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/authenticate');

// GET /api/v1/audit — Journal global (CP/ADMIN uniquement)
router.get('/', authenticate, authorize('CP', 'ADMIN'), async (req, res, next) => {
  const db = req.app.locals.db;
  const { declaration_id, matricule, action, date_debut, date_fin, page = 1, limit = 50 } = req.query;

  const conditions = [];
  const params     = [];
  let p = 1;

  if (declaration_id) { conditions.push(`al.declaration_id = $${p++}`); params.push(declaration_id); }
  if (matricule)      { conditions.push(`al.acteur_matricule = $${p++}`); params.push(matricule); }
  if (action)         { conditions.push(`al.action = $${p++}`); params.push(action.toUpperCase()); }
  if (date_debut)     { conditions.push(`al.timestamp_srv >= $${p++}`); params.push(date_debut); }
  if (date_fin)       { conditions.push(`al.timestamp_srv <= $${p++}`); params.push(date_fin); }

  const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(200, parseInt(limit));
  const lim    = Math.min(200, parseInt(limit));

  try {
    const rows = await db.query(
      `SELECT al.id, al.timestamp_srv, al.acteur_matricule, al.acteur_role,
              al.action, al.ancien_statut, al.nouveau_statut, al.ip_address,
              al.details, d.ref as declaration_ref
       FROM audit_log al
       LEFT JOIN declarations d ON d.id = al.declaration_id
       ${where}
       ORDER BY al.timestamp_srv DESC
       LIMIT $${p} OFFSET $${p+1}`,
      [...params, lim, offset]
    );
    res.json({ success: true, data: rows.rows, meta: { timestamp: new Date().toISOString() } });
  } catch (err) { next(err); }
});

// GET /api/v1/audit/declaration/:id — Audit d'une déclaration
router.get('/declaration/:id', authenticate, async (req, res, next) => {
  const db = req.app.locals.db;
  try {
    const rows = await db.query(
      `SELECT al.*, d.ref as declaration_ref
       FROM audit_log al
       JOIN declarations d ON d.id = al.declaration_id
       WHERE al.declaration_id = $1
       ORDER BY al.timestamp_srv ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows.rows });
  } catch (err) { next(err); }
});

module.exports = router;
