'use strict';

const jwt  = require('jsonwebtoken');
const fs   = require('fs');
const path = require('path');

// Charger la clé publique RS256 (vérification signatures JWT)
let JWT_PUBLIC_KEY;
try {
  JWT_PUBLIC_KEY = fs.readFileSync(
    process.env.JWT_PUBLIC_KEY_PATH || path.join(__dirname, '../keys/jwt-public.pem'),
    'utf8'
  );
} catch (e) {
  // En développement, utiliser un secret symétrique (JAMAIS en production)
  JWT_PUBLIC_KEY = process.env.JWT_SECRET || 'DEV_SECRET_CHANGER_EN_PROD';
  console.warn('[AUTH] ⚠ Clé publique JWT non trouvée — utilisation du secret symétrique (DEV uniquement)');
}

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE : Authentification JWT
// ═══════════════════════════════════════════════════════════
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { code: 'TOKEN_MISSING', message: 'Token d\'authentification requis. Header: Authorization: Bearer <token>' },
      meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
    });
  }

  const token = authHeader.slice(7); // Supprimer "Bearer "

  try {
    const decoded = jwt.verify(token, JWT_PUBLIC_KEY, {
      algorithms: ['RS256', 'HS256'], // HS256 accepté en dev uniquement
      issuer:     process.env.JWT_ISSUER || 'bq-cp-intranet',
    });

    // Vérifier que le token n'est pas blacklisté (révocation)
    // En production : vérifier dans Redis ou table jwt_blacklist
    // checkBlacklist(decoded.jti, res, next);

    // Attacher l'utilisateur à la requête
    req.user = {
      matricule: decoded.sub,
      nom:       decoded.nom    || decoded.sub,
      role:      decoded.role   || 'CAISSIER',
      agence:    decoded.agence || null,
      region:    decoded.region || null,
      jti:       decoded.jti,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: { code: 'TOKEN_EXPIRED', message: 'Votre session a expiré. Veuillez vous reconnecter.' },
        meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
      });
    }
    return res.status(401).json({
      success: false,
      error: { code: 'TOKEN_INVALID', message: 'Token invalide ou malformé.' },
      meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
    });
  }
}

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE : Autorisation par rôle (RBAC)
// ═══════════════════════════════════════════════════════════
const ROLES_HIERARCHY = {
  'CAISSIER':    1,
  'SUPERVISEUR': 2,
  'DIRECTEUR':   3,
  'CP':          4,
  'ADMIN':       5,
};

function authorize(...rolesAutorisés) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Authentification requise.' },
        meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
      });
    }

    const userLevel = ROLES_HIERARCHY[req.user.role] || 0;
    const minLevel  = Math.min(...rolesAutorisés.map(r => ROLES_HIERARCHY[r] || 99));

    if (userLevel < minLevel) {
      req.app.locals.logger.warn('Accès refusé — rôle insuffisant', {
        matricule: req.user.matricule,
        role:      req.user.role,
        required:  rolesAutorisés,
        path:      req.path,
      });
      return res.status(403).json({
        success: false,
        error: {
          code:    'ROLE_INSUFFICIENT',
          message: `Action réservée aux rôles : ${rolesAutorisés.join(', ')}. Votre rôle : ${req.user.role}.`
        },
        meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
      });
    }

    next();
  };
}

// ═══════════════════════════════════════════════════════════
// HELPER : Filtrage par agence (Isolation des données)
// Un CAISSIER ou SUPERVISEUR ne voit que son agence
// Un DIRECTEUR voit toutes les déclarations de son agence
// CP et ADMIN voient tout
// ═══════════════════════════════════════════════════════════
function agenceFilter(req) {
  const role = req.user.role;
  if (['CP', 'ADMIN'].includes(role)) return null;          // Pas de filtre
  if (['CAISSIER', 'SUPERVISEUR', 'DIRECTEUR'].includes(role)) {
    return req.user.agence;                                  // Filtre sur agence de rattachement
  }
  return req.user.agence;
}

module.exports = { authenticate, authorize, agenceFilter };
