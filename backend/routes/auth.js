'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const ldap    = require('ldapjs');
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

// Charger la clé privée RS256 pour signer les tokens
let JWT_PRIVATE_KEY;
try {
  JWT_PRIVATE_KEY = fs.readFileSync(
    process.env.JWT_PRIVATE_KEY_PATH || path.join(__dirname, '../keys/jwt-private.pem'), 'utf8'
  );
} catch {
  JWT_PRIVATE_KEY = process.env.JWT_SECRET || 'DEV_SECRET_CHANGER_EN_PROD';
  console.warn('[AUTH] ⚠ Clé privée JWT non trouvée — mode DEV');
}

const JWT_ALGORITHM = JWT_PRIVATE_KEY.includes('BEGIN RSA PRIVATE KEY') ? 'RS256' : 'HS256';

// ══════════════════════════════════════════════════════════
// Authentification LDAP / Active Directory
// ══════════════════════════════════════════════════════════
async function authenticateLDAP(matricule, password) {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({
      url:            process.env.LDAP_URL || 'ldap://ad.banque.tn:389',
      connectTimeout: 5000,
      timeout:        5000,
    });

    client.on('error', (err) => reject(new Error('LDAP_CONNECT_ERROR: ' + err.message)));

    // Bind avec le compte de service
    client.bind(
      process.env.LDAP_BIND_DN,
      process.env.LDAP_BIND_PASSWORD,
      (err) => {
        if (err) return reject(new Error('LDAP_BIND_FAILED'));

        // Recherche de l'utilisateur par matricule
        client.search(
          process.env.LDAP_BASE_DN,
          {
            scope:  'sub',
            filter: `(sAMAccountName=${ldap.escapeDN(matricule)})`,
            attributes: ['dn', 'cn', 'sAMAccountName', 'memberOf', 'department', 'mail', 'title'],
          },
          (err, searchRes) => {
            if (err) return reject(new Error('LDAP_SEARCH_ERROR'));

            let userDN   = null;
            let userAttrs = {};

            searchRes.on('searchEntry', (entry) => {
              userDN    = entry.objectName;
              userAttrs = entry.attributes.reduce((acc, a) => {
                acc[a.type] = a.values.length === 1 ? a.values[0] : a.values;
                return acc;
              }, {});
            });

            searchRes.on('end', () => {
              if (!userDN) return reject(new Error('USER_NOT_FOUND'));

              // Vérifier le mot de passe en bindant avec l'utilisateur
              client.bind(userDN, password, (bindErr) => {
                client.destroy();
                if (bindErr) return reject(new Error('INVALID_CREDENTIALS'));
                resolve({ dn: userDN, ...userAttrs });
              });
            });

            searchRes.on('error', () => reject(new Error('LDAP_SEARCH_ERROR')));
          }
        );
      }
    );
  });
}

// Mapper les groupes AD vers les rôles applicatifs
function mapGroupsToRole(memberOf) {
  if (!memberOf) return 'CAISSIER';
  const groups = Array.isArray(memberOf) ? memberOf : [memberOf];
  if (groups.some(g => g.includes('GRP-CP-ADMIN')))       return 'ADMIN';
  if (groups.some(g => g.includes('GRP-CP-CENTRAL')))     return 'CP';
  if (groups.some(g => g.includes('GRP-CP-DIRECTEUR')))   return 'DIRECTEUR';
  if (groups.some(g => g.includes('GRP-CP-SUPERVISEUR'))) return 'SUPERVISEUR';
  return 'CAISSIER';
}

// ══════════════════════════════════════════════════════════
// POST /api/v1/auth/login
// ══════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  const { matricule, password } = req.body;
  const db     = req.app.locals.db;
  const logger = req.app.locals.logger;

  if (!matricule || !password) {
    return res.status(400).json({
      success: false,
      error: { code: 'MISSING_CREDENTIALS', message: 'Matricule et mot de passe requis.' }
    });
  }

  try {
    let userInfo;
    const isDev = process.env.NODE_ENV !== 'production';

    if (isDev && process.env.LDAP_URL === undefined) {
      // ── Mode DEV : authentification simulée ────────────
      const agents = {
        'ADMIN-001': { role: 'ADMIN',      nom: 'Admin DSI',     agence: null,  region: null },
        'CP-001':    { role: 'CP',         nom: 'Mme GHARBI',    agence: null,  region: 'Grand Tunis' },
        'DIR-056':   { role: 'DIRECTEUR',  nom: 'M. BEN AMOR',   agence: '056', region: 'Grand Tunis' },
        'SUP-056':   { role: 'SUPERVISEUR',nom: 'M. CHAABANE',   agence: '056', region: 'Grand Tunis' },
        'CAI-001':   { role: 'CAISSIER',   nom: 'M. BEN SALAH',  agence: '056', region: 'Grand Tunis' },
      };
      userInfo = agents[matricule] || { role: 'CAISSIER', nom: matricule, agence: '056', region: 'Grand Tunis' };
    } else {
      // ── Mode PRODUCTION : authentification LDAP ─────────
      const ldapUser = await authenticateLDAP(matricule, password);
      userInfo = {
        nom:    ldapUser.cn || matricule,
        role:   mapGroupsToRole(ldapUser.memberOf),
        agence: ldapUser.department?.match(/\d{3}/)?.[0] || null,
        region: null,
        email:  ldapUser.mail,
      };
    }

    // Générer le JWT
    const jti   = uuidv4();
    const token = jwt.sign(
      {
        sub:    matricule,
        nom:    userInfo.nom,
        role:   userInfo.role,
        agence: userInfo.agence,
        region: userInfo.region,
        jti,
        iss:    process.env.JWT_ISSUER || 'bq-cp-intranet',
      },
      JWT_PRIVATE_KEY,
      { algorithm: JWT_ALGORITHM, expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    logger.info('Connexion réussie', { matricule, role: userInfo.role, ip: req.ip });

    res.json({
      success: true,
      data: {
        access_token: token,
        token_type:   'Bearer',
        expires_in:   8 * 3600,
        user: { matricule, nom: userInfo.nom, role: userInfo.role, agence: userInfo.agence }
      },
      meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
    });

  } catch (err) {
    logger.warn('Échec connexion', { matricule, error: err.message, ip: req.ip });
    const code = err.message === 'INVALID_CREDENTIALS' || err.message === 'USER_NOT_FOUND'
      ? 'INVALID_CREDENTIALS' : 'AUTH_ERROR';
    res.status(401).json({
      success: false,
      error: { code, message: 'Matricule ou mot de passe incorrect. Contactez la DSI si le problème persiste.' }
    });
  }
});

// ══════════════════════════════════════════════════════════
// POST /api/v1/auth/logout — Invalider le token (blacklist)
// ══════════════════════════════════════════════════════════
router.post('/logout', async (req, res) => {
  // En production : ajouter le jti à la table jwt_blacklist
  // await db.query('INSERT INTO jwt_blacklist(jti, expires_at) VALUES ($1, $2)', [jti, expiry]);
  res.json({ success: true, data: { message: 'Déconnexion réussie.' } });
});

// ══════════════════════════════════════════════════════════
// GET /api/v1/auth/me — Profil utilisateur courant
// ══════════════════════════════════════════════════════════
const { authenticate } = require('../middleware/authenticate');
router.get('/me', authenticate, (req, res) => {
  res.json({ success: true, data: req.user });
});

module.exports = router;
