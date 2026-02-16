'use strict';

const express = require('express');
const Joi     = require('joi');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const { authenticate, authorize, agenceFilter } = require('../middleware/authenticate');
const MailerService = require('../services/mailer');
const PdfService    = require('../services/pdf');

// ── Schéma de validation Joi ───────────────────────────────
const declarationSchema = Joi.object({
  agence: Joi.object({
    code:   Joi.string().length(3).pattern(/^\d{3}$/).required(),
    region: Joi.string().max(60).optional(),
  }).required(),

  caissier: Joi.object({
    matricule:    Joi.string().max(20).required(),
    nom:          Joi.string().min(2).max(100).required(),
    grade:        Joi.string().max(40).optional().allow(''),
    fonction:     Joi.string().valid(
      'Caissier Principal', 'Caissier Adjoint', 'Stagiaire Caissier', 'Autre'
    ).required(),
    fonctionAutre: Joi.string().max(60).optional().allow(''),
  }).required(),

  ecart: Joi.object({
    date_constat:  Joi.string().isoDate().required(),
    heure_constat: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required(),
    heure_arrete:  Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).optional().allow(''),
    montant_dt:    Joi.number().integer().min(0).required(),
    montant_mm:    Joi.number().integer().min(0).max(999).default(0),
    nature:        Joi.string().valid('MANQUANT', 'EXCEDENT').required(),
    type_caisse:   Joi.string().max(50).required(),
    caisseAutre:   Joi.string().max(60).optional().allow(''),
  }).required(),

  niveau: Joi.number().integer().min(1).max(4).required(),

  circonstances: Joi.object({
    declaration_caissier: Joi.string().min(20).max(2000).required(),
    observations_sup:     Joi.string().min(10).max(2000).required(),
    causes:               Joi.array().items(Joi.string()).min(1).required(),
  }).required(),

  mesures: Joi.object({
    actions: Joi.array().items(Joi.string()).optional(),
    autres:  Joi.string().max(500).optional().allow(''),
  }).optional(),

  recidive: Joi.object({
    oui:      Joi.boolean().required(),
    nb_ecarts: Joi.when('oui', { is: true, then: Joi.number().integer().min(1).required() }),
  }).required(),

  ref_client: Joi.string().max(60).optional(),
});

// ─── Helper : Réponse JSON standard ───────────────────────
const apiResponse = (res, status, data, meta = {}) => {
  res.status(status).json({
    success: status < 400,
    ...(status < 400 ? { data } : { error: data }),
    meta: { timestamp: new Date().toISOString(), ...meta }
  });
};

// ─── Helper : Calcul niveau auto selon montant ────────────
function calcNiveau(montantDT) {
  if (montantDT < 20)              return 1;
  if (montantDT < 200)             return 2;
  if (montantDT <= 1000)           return 3;
  return 4;
}

// ─── Helper : Écriture audit log ─────────────────────────
async function writeAudit(db, { declaration_id, acteur, action, ancien_statut, nouveau_statut, ip, details }) {
  await db.query(
    `INSERT INTO audit_log
     (id, declaration_id, acteur_matricule, acteur_role, action,
      ancien_statut, nouveau_statut, ip_address, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      uuidv4(), declaration_id,
      acteur.matricule, acteur.role, action,
      ancien_statut || null, nouveau_statut || null,
      ip, JSON.stringify(details || {})
    ]
  );
}

// ════════════════════════════════════════════════════════════
// POST /api/v1/declarations — Créer une déclaration
// ════════════════════════════════════════════════════════════
router.post('/', authenticate, authorize('CAISSIER', 'SUPERVISEUR', 'CP', 'ADMIN'), async (req, res, next) => {
  const db     = req.app.locals.db;
  const logger = req.app.locals.logger;

  // 1. Validation du corps de la requête
  const { error: validErr, value: body } = declarationSchema.validate(req.body, { abortEarly: false });
  if (validErr) {
    return apiResponse(res, 400, {
      code:    'VALIDATION_ERROR',
      message: 'Données invalides',
      details: validErr.details.map(d => ({ field: d.path.join('.'), message: d.message }))
    });
  }

  // 2. Règles métier supplémentaires
  const dateConstat = new Date(body.ecart.date_constat);
  if (dateConstat > new Date()) {
    return apiResponse(res, 422, { code: 'DATE_FUTURE', message: 'La date du constat ne peut pas être dans le futur.' });
  }

  // Vérifier que l'agence existe en base
  const agenceCheck = await db.query('SELECT code FROM agences WHERE code = $1 AND actif = true', [body.agence.code]);
  if (agenceCheck.rowCount === 0) {
    return apiResponse(res, 422, { code: 'AGENCE_INCONNUE', message: `Agence ${body.agence.code} non trouvée dans le référentiel.` });
  }

  // Un caissier ne peut déclarer que pour son agence
  if (req.user.role === 'CAISSIER' && req.user.agence !== body.agence.code) {
    return apiResponse(res, 403, { code: 'AGENCE_MISMATCH', message: 'Vous ne pouvez déclarer que pour votre propre agence.' });
  }

  // Recalcul niveau (sécurité côté serveur — le client ne peut pas mentir)
  const niveauCalcule = body.recidive.oui ? 4 : calcNiveau(body.ecart.montant_dt);
  const niveauFinal   = Math.max(body.niveau, niveauCalcule); // Prendre le plus élevé

  const declId = uuidv4();
  const ref    = body.ref_client || `DC-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${declId.slice(0,8).toUpperCase()}`;

  // 3. Transaction base de données
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Insérer la déclaration
    const insertResult = await client.query(
      `INSERT INTO declarations
       (id, ref, statut, niveau, agence_code, caissier_matricule, caissier_nom,
        caissier_grade, caissier_fonction, date_constat, heure_constat, heure_arrete,
        montant_dt, montant_mm, nature, type_caisse,
        declaration_caissier, observations_superviseur, recidive, nb_ecarts_recidive,
        mesures_autres, declarant_matricule, ip_soumission)
       VALUES ($1,$2,'SOUMIS',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id, ref, statut, niveau, created_at`,
      [
        declId, ref, niveauFinal, body.agence.code,
        body.caissier.matricule, body.caissier.nom, body.caissier.grade || null,
        body.caissier.fonction, body.ecart.date_constat, body.ecart.heure_constat,
        body.ecart.heure_arrete || null, body.ecart.montant_dt, body.ecart.montant_mm || 0,
        body.ecart.nature, body.ecart.type_caisse,
        body.circonstances.declaration_caissier, body.circonstances.observations_sup,
        body.recidive.oui, body.recidive.nb_ecarts || null,
        body.mesures?.autres || null, req.user.matricule, req.ip
      ]
    );

    // Insérer les causes
    for (const cause of body.circonstances.causes) {
      await client.query(
        'INSERT INTO decl_causes (declaration_id, cause) VALUES ($1, $2)',
        [declId, cause]
      );
    }

    // Insérer les mesures
    for (const mesure of (body.mesures?.actions || [])) {
      await client.query(
        'INSERT INTO decl_mesures (declaration_id, mesure) VALUES ($1, $2)',
        [declId, mesure]
      );
    }

    // Récupérer la région pour la notification
    const agenceInfo = await client.query(
      'SELECT a.nom, r.nom as region, r.cp_email, a.dir_email FROM agences a JOIN regions r ON a.region_id = r.id WHERE a.code = $1',
      [body.agence.code]
    );

    // Écrire l'audit (dans la même transaction)
    await writeAudit(db, {
      declaration_id: declId,
      acteur: req.user,
      action: 'CREATION',
      nouveau_statut: 'SOUMIS',
      ip: req.ip,
      details: { ref, niveau: niveauFinal }
    });

    await client.query('COMMIT');

    const row = insertResult.rows[0];
    const agInfo = agenceInfo.rows[0] || {};

    // 4. Notifications (asynchrones — ne bloquent pas la réponse)
    const mailer = new MailerService();
    const declData = { ...body, ref, niveau: niveauFinal, id: declId };

    Promise.all([
      mailer.sendDeclarationNouveauCP(agInfo.cp_email, declData),
      mailer.sendDeclarationNouveauDirecteur(agInfo.dir_email, declData),
      ...(niveauFinal === 4 ? [mailer.sendAlerteNiveau4(declData)] : []),
      ...(body.recidive.oui ? [mailer.sendAlerteRecidive(declData)] : []),
    ]).catch(err => logger.error('Erreur envoi notification', { error: err.message, declId }));

    // 5. Génération PDF (asynchrone)
    const pdfService = new PdfService();
    pdfService.generate(declId, declData)
      .then(pdfPath => db.query('UPDATE declarations SET pdf_path = $1 WHERE id = $2', [pdfPath, declId]))
      .catch(err => logger.error('Erreur génération PDF', { error: err.message, declId }));

    logger.info('Déclaration créée', { declId, ref, niveau: niveauFinal, agence: body.agence.code });

    return apiResponse(res, 201, {
      id:             row.id,
      ref:            row.ref,
      statut:         row.statut,
      niveau:         row.niveau,
      horodatage_srv: row.created_at,
      pdf_url:        `/api/v1/declarations/${row.id}/pdf`,
      notification:   { envoyee: true, destinataires: [agInfo.cp_email, agInfo.dir_email].filter(Boolean) }
    }, { request_id: req.requestId });

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Erreur création déclaration', { error: err.message, stack: err.stack });
    next(err);
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════
// GET /api/v1/declarations — Lister les déclarations
// ════════════════════════════════════════════════════════════
router.get('/', authenticate, authorize('SUPERVISEUR', 'DIRECTEUR', 'CP', 'ADMIN'), async (req, res, next) => {
  const db = req.app.locals.db;
  try {
    const {
      agence, statut, niveau,
      date_debut, date_fin,
      page  = 1, limit = 20,
      sort  = '-created_at'
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset   = (pageNum - 1) * limitNum;

    const conditions = [];
    const params     = [];
    let   p          = 1;

    // Filtrage par agence selon rôle
    const agenceFiltree = agenceFilter(req);
    if (agenceFiltree) { conditions.push(`d.agence_code = $${p++}`); params.push(agenceFiltree); }
    else if (agence)   { conditions.push(`d.agence_code = $${p++}`); params.push(agence); }

    if (statut)     { conditions.push(`d.statut = $${p++}`);    params.push(statut.toUpperCase()); }
    if (niveau)     { conditions.push(`d.niveau = $${p++}`);    params.push(parseInt(niveau)); }
    if (date_debut) { conditions.push(`d.date_constat >= $${p++}`); params.push(date_debut); }
    if (date_fin)   { conditions.push(`d.date_constat <= $${p++}`); params.push(date_fin); }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Tri sécurisé
    const sortMap = {
      'created_at': 'd.created_at ASC', '-created_at': 'd.created_at DESC',
      'montant':    'd.montant_dt ASC',  '-montant':    'd.montant_dt DESC',
      'niveau':     'd.niveau ASC',      '-niveau':     'd.niveau DESC',
    };
    const orderBy = sortMap[sort] || 'd.created_at DESC';

    const [rows, countResult] = await Promise.all([
      db.query(
        `SELECT d.id, d.ref, d.statut, d.niveau, d.created_at,
                d.montant_dt, d.montant_mm, d.nature,
                d.agence_code, a.nom as agence_nom,
                d.caissier_matricule, d.caissier_nom
         FROM declarations d
         JOIN agences a ON a.code = d.agence_code
         ${whereClause}
         ORDER BY ${orderBy}
         LIMIT $${p} OFFSET $${p+1}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*) FROM declarations d ${whereClause}`, params)
    ]);

    const total = parseInt(countResult.rows[0].count);

    return apiResponse(res, 200, rows.rows, {
      request_id: req.requestId,
      pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) }
    });

  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// GET /api/v1/declarations/:id — Détail
// ════════════════════════════════════════════════════════════
router.get('/:id', authenticate, async (req, res, next) => {
  const db = req.app.locals.db;
  try {
    const row = await db.query(
      `SELECT d.*, a.nom as agence_nom,
              COALESCE(json_agg(DISTINCT c.cause) FILTER (WHERE c.cause IS NOT NULL), '[]') as causes,
              COALESCE(json_agg(DISTINCT m.mesure) FILTER (WHERE m.mesure IS NOT NULL), '[]') as mesures
       FROM declarations d
       JOIN agences a ON a.code = d.agence_code
       LEFT JOIN decl_causes  c ON c.declaration_id = d.id
       LEFT JOIN decl_mesures m ON m.declaration_id = d.id
       WHERE d.id = $1
       GROUP BY d.id, a.nom`,
      [req.params.id]
    );

    if (row.rowCount === 0) {
      return apiResponse(res, 404, { code: 'NOT_FOUND', message: 'Déclaration introuvable.' });
    }

    const decl = row.rows[0];

    // Contrôle d'accès — un caissier ne voit que ses propres déclarations
    if (req.user.role === 'CAISSIER' && decl.declarant_matricule !== req.user.matricule) {
      return apiResponse(res, 403, { code: 'ACCESS_DENIED', message: 'Accès non autorisé à cette déclaration.' });
    }

    return apiResponse(res, 200, decl, { request_id: req.requestId });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// PATCH /api/v1/declarations/:id — Mettre à jour
// ════════════════════════════════════════════════════════════
const TRANSITIONS_VALIDES = {
  'SOUMIS':     ['EN_COURS', 'REJETE'],
  'EN_COURS':   ['EN_ENQUETE', 'VALIDE', 'REJETE'],
  'EN_ENQUETE': ['VALIDE', 'REJETE'],
  'VALIDE':     ['CLOTURE'],
  'REJETE':     ['SOUMIS'],
  'CLOTURE':    [],
};

router.patch('/:id', authenticate, authorize('SUPERVISEUR', 'DIRECTEUR', 'CP', 'ADMIN'), async (req, res, next) => {
  const db = req.app.locals.db;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT * FROM declarations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return apiResponse(res, 404, { code: 'NOT_FOUND', message: 'Déclaration introuvable.' });
    }

    const decl         = current.rows[0];
    const { statut, cp_central } = req.body;

    let updates = [];
    let params  = [];
    let p       = 1;

    // Validation de la transition de statut
    if (statut) {
      const transitionsAutorisees = TRANSITIONS_VALIDES[decl.statut] || [];
      if (!transitionsAutorisees.includes(statut)) {
        await client.query('ROLLBACK');
        return apiResponse(res, 409, {
          code: 'STATUT_INCOMPATIBLE',
          message: `Transition ${decl.statut} → ${statut} non autorisée. Transitions possibles : ${transitionsAutorisees.join(', ') || 'aucune'}.`
        });
      }
      updates.push(`statut = $${p++}`); params.push(statut);
      updates.push(`statut_updated_at = NOW()`);
      updates.push(`statut_updated_by = $${p++}`); params.push(req.user.matricule);
    }

    // Champs CP Central
    if (cp_central) {
      if (cp_central.traite_par) { updates.push(`cp_traite_par = $${p++}`); params.push(cp_central.traite_par); }
      if (cp_central.n_dossier)  { updates.push(`cp_n_dossier  = $${p++}`); params.push(cp_central.n_dossier);  }
      if (cp_central.commentaire){ updates.push(`cp_commentaire = $${p++}`); params.push(cp_central.commentaire); }
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return apiResponse(res, 400, { code: 'EMPTY_UPDATE', message: 'Aucune modification fournie.' });
    }

    params.push(req.params.id);
    await client.query(
      `UPDATE declarations SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${p}`,
      params
    );

    // Audit
    await writeAudit(db, {
      declaration_id: req.params.id,
      acteur: req.user,
      action: statut ? 'CHANGEMENT_STATUT' : 'MODIFICATION',
      ancien_statut: decl.statut,
      nouveau_statut: statut || decl.statut,
      ip: req.ip,
      details: { cp_central }
    });

    await client.query('COMMIT');
    return apiResponse(res, 200, { id: req.params.id, statut: statut || decl.statut }, { request_id: req.requestId });

  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// ════════════════════════════════════════════════════════════
// GET /api/v1/declarations/:id/pdf — Télécharger le PDF
// ════════════════════════════════════════════════════════════
router.get('/:id/pdf', authenticate, async (req, res, next) => {
  const db  = req.app.locals.db;
  const fs  = require('fs');
  try {
    const row = await db.query('SELECT pdf_path, ref FROM declarations WHERE id = $1', [req.params.id]);
    if (row.rowCount === 0 || !row.rows[0].pdf_path) {
      return apiResponse(res, 404, { code: 'PDF_NOT_FOUND', message: 'PDF non encore généré pour cette déclaration.' });
    }
    const pdfPath = row.rows[0].pdf_path;
    if (!fs.existsSync(pdfPath)) {
      return apiResponse(res, 404, { code: 'PDF_FILE_MISSING', message: 'Fichier PDF introuvable sur le serveur.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.rows[0].ref}.pdf"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) { next(err); }
});

module.exports = router;
