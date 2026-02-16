'use strict';
require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const cors        = require('cors');
const { Pool }    = require('pg');
const winston     = require('winston');

// ═══════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log',   level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    ...(process.env.NODE_ENV !== 'production'
      ? [new winston.transports.Console({ format: winston.format.simple() })]
      : [])
  ]
});

// ═══════════════════════════════════════════════════════════
// DATABASE POOL (PostgreSQL)
// ═══════════════════════════════════════════════════════════
const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'cp_declarations',
  user:     process.env.DB_USER     || 'cp_app',
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  max:      20,    // Connexions simultanées max
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

db.on('error', (err) => {
  logger.error('Erreur pool PostgreSQL inattendue', { error: err.message });
});

// Vérification connexion au démarrage
db.query('SELECT NOW()').then(() => {
  logger.info('Connexion PostgreSQL établie');
}).catch(err => {
  logger.error('Impossible de se connecter à PostgreSQL', { error: err.message });
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════
// APPLICATION EXPRESS
// ═══════════════════════════════════════════════════════════
const app = express();

// ── Partager le db pool et logger dans toutes les routes ──
app.locals.db     = db;
app.locals.logger = logger;

// ── Sécurité HTTP headers ─────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      frameAncestors: ["'none'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// ── CORS — Intranet uniquement ────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://cp-caisse.intranet.banque.tn',
    'http://localhost:3001'  // Développement local
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Agent-Code'],
  credentials: true,
  maxAge: 86400
}));

// ── Compression ───────────────────────────────────────────
app.use(compression());

// ── Body parsing ──────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting ─────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Trop de requêtes. Réessayez dans 15 minutes.' } },
  skip: (req) => req.path === '/api/v1/health', // Ne pas limiter le health check
});
app.use('/api/', apiLimiter);

// ── Request ID Middleware ─────────────────────────────────
const { v4: uuidv4 } = require('uuid');
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-ID', req.requestId);
  // Logger chaque requête entrante
  logger.info('Requête entrante', {
    method:    req.method,
    path:      req.path,
    ip:        req.ip,
    requestId: req.requestId,
    userAgent: req.get('user-agent'),
  });
  next();
});

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════
const authRoutes         = require('./routes/auth');
const declarationsRoutes = require('./routes/declarations');
const referentielsRoutes = require('./routes/referentiels');
const auditRoutes        = require('./routes/audit');
const statsRoutes        = require('./routes/stats');

app.use('/api/v1/auth',          authRoutes);
app.use('/api/v1/declarations',  declarationsRoutes);
app.use('/api/v1/referentiels',  referentielsRoutes);
app.use('/api/v1/audit',         auditRoutes);
app.use('/api/v1/stats',         statsRoutes);

// ── Health Check ──────────────────────────────────────────
app.get('/api/v1/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status:    'OK',
      timestamp: new Date().toISOString(),
      version:   '3.0.0',
      database:  'connected',
      uptime:    process.uptime()
    });
  } catch (err) {
    res.status(503).json({ status: 'ERROR', database: 'disconnected' });
  }
});

// ═══════════════════════════════════════════════════════════
// GESTION ERREURS GLOBALE
// ═══════════════════════════════════════════════════════════

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} introuvable.` },
    meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
  });
});

// Handler global
app.use((err, req, res, next) => {
  logger.error('Erreur non gérée', { error: err.message, stack: err.stack, requestId: req.requestId });

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: {
      code:    err.code    || 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'Une erreur interne est survenue. Contactez la DSI.'
        : err.message,
    },
    meta: { timestamp: new Date().toISOString(), request_id: req.requestId }
  });
});

// ═══════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT) || 3000;
const server = app.listen(PORT, '127.0.0.1', () => {
  logger.info(`Serveur BQ-CP démarré sur le port ${PORT}`, { env: process.env.NODE_ENV, version: '3.0.0' });
  console.log(`\n  ✅ BQ-CP Backend v3.0.0 démarré`);
  console.log(`  🌐 http://127.0.0.1:${PORT}/api/v1/health\n`);
});

// Graceful shutdown
const shutdown = (signal) => {
  logger.info(`Signal ${signal} reçu — arrêt en cours`);
  server.close(() => {
    db.end(() => {
      logger.info('Connexions fermées — arrêt complet');
      process.exit(0);
    });
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, db };
