-- ══════════════════════════════════════════════════════════════════
-- BQ-CP-CAI-001 — Schéma PostgreSQL 15
-- Déclarations de Différence de Caisse
-- BQ-DSI-DB-001 Rév.03 — 2025
-- ══════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Types ENUM ────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE statut_declaration AS ENUM ('SOUMIS','EN_COURS','EN_ENQUETE','VALIDE','CLOTURE','REJETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE nature_ecart AS ENUM ('MANQUANT','EXCEDENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE role_agent AS ENUM ('CAISSIER','SUPERVISEUR','DIRECTEUR','CP','ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE action_audit AS ENUM (
    'CREATION','MODIFICATION','CHANGEMENT_STATUT','CONSULTATION',
    'NOTIFICATION_MAIL','PDF_GENERE','CONNEXION','DECONNEXION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════
-- TABLE : regions
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS regions (
  id        SERIAL       PRIMARY KEY,
  nom       VARCHAR(60)  NOT NULL UNIQUE,
  cp_email  VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════════
-- TABLE : agences
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agences (
  code       CHAR(3)      PRIMARY KEY,
  nom        VARCHAR(100) NOT NULL,
  region_id  INTEGER      NOT NULL REFERENCES regions(id),
  dir_email  VARCHAR(120),
  actif      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agences_region ON agences(region_id);
CREATE INDEX IF NOT EXISTS idx_agences_actif  ON agences(actif);

-- ══════════════════════════════════════════════════════════════════
-- TABLE : agents
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agents (
  matricule   VARCHAR(20)  PRIMARY KEY,
  nom_prenom  VARCHAR(100) NOT NULL,
  grade       VARCHAR(50),
  role        role_agent   NOT NULL DEFAULT 'CAISSIER',
  agence_code CHAR(3)      REFERENCES agences(code),
  email       VARCHAR(120),
  actif       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agents_agence ON agents(agence_code);
CREATE INDEX IF NOT EXISTS idx_agents_role   ON agents(role);

-- ══════════════════════════════════════════════════════════════════
-- TABLE : declarations (table principale)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS declarations (
  -- Identification
  id                   UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                  VARCHAR(60)    NOT NULL UNIQUE,
  statut               statut_declaration NOT NULL DEFAULT 'SOUMIS',
  niveau               SMALLINT       NOT NULL CHECK (niveau BETWEEN 1 AND 4),

  -- Agence
  agence_code          CHAR(3)        NOT NULL REFERENCES agences(code),

  -- Caissier déclarant
  caissier_matricule   VARCHAR(20)    NOT NULL,
  caissier_nom         VARCHAR(100)   NOT NULL,
  caissier_grade       VARCHAR(50),
  caissier_fonction    VARCHAR(60)    NOT NULL,

  -- Écart
  date_constat         DATE           NOT NULL CHECK (date_constat <= CURRENT_DATE),
  heure_constat        TIME           NOT NULL,
  heure_arrete         TIME,
  montant_dt           INTEGER        NOT NULL CHECK (montant_dt >= 0),
  montant_mm           SMALLINT       NOT NULL DEFAULT 0 CHECK (montant_mm BETWEEN 0 AND 999),
  nature               nature_ecart   NOT NULL,
  type_caisse          VARCHAR(60)    NOT NULL,

  -- Circonstances
  declaration_caissier     TEXT       NOT NULL CHECK (length(declaration_caissier) >= 20),
  observations_superviseur TEXT       NOT NULL,
  recidive             BOOLEAN        NOT NULL DEFAULT FALSE,
  nb_ecarts_recidive   SMALLINT,
  mesures_autres       TEXT,

  -- CP Central
  cp_traite_par        VARCHAR(100),
  cp_n_dossier         VARCHAR(40),
  cp_commentaire       TEXT,

  -- Traçabilité
  declarant_matricule  VARCHAR(20)    NOT NULL,
  statut_updated_at    TIMESTAMPTZ,
  statut_updated_by    VARCHAR(20),
  ip_soumission        INET,
  pdf_path             TEXT,

  -- Timestamps
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ
);

-- Index déclarations
CREATE INDEX IF NOT EXISTS idx_decl_agence     ON declarations(agence_code);
CREATE INDEX IF NOT EXISTS idx_decl_statut     ON declarations(statut);
CREATE INDEX IF NOT EXISTS idx_decl_niveau     ON declarations(niveau);
CREATE INDEX IF NOT EXISTS idx_decl_date       ON declarations(date_constat DESC);
CREATE INDEX IF NOT EXISTS idx_decl_caissier   ON declarations(caissier_matricule);
CREATE INDEX IF NOT EXISTS idx_decl_declarant  ON declarations(declarant_matricule);
CREATE INDEX IF NOT EXISTS idx_decl_created    ON declarations(created_at DESC);

-- Trigger : updated_at automatique
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_declarations_updated ON declarations;
CREATE TRIGGER trg_declarations_updated
  BEFORE UPDATE ON declarations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════════════
-- TABLE : decl_causes (relation N-N via table de jonction)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS decl_causes (
  id             SERIAL   PRIMARY KEY,
  declaration_id UUID     NOT NULL REFERENCES declarations(id) ON DELETE CASCADE,
  cause          VARCHAR(100) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_causes_decl ON decl_causes(declaration_id);

-- ══════════════════════════════════════════════════════════════════
-- TABLE : decl_mesures
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS decl_mesures (
  id             SERIAL   PRIMARY KEY,
  declaration_id UUID     NOT NULL REFERENCES declarations(id) ON DELETE CASCADE,
  mesure         VARCHAR(120) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesures_decl ON decl_mesures(declaration_id);

-- ══════════════════════════════════════════════════════════════════
-- TABLE : audit_log (IMMUABLE — pas de UPDATE ni DELETE)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_log (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id    UUID          REFERENCES declarations(id),
  timestamp_srv     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  acteur_matricule  VARCHAR(20)   NOT NULL,
  acteur_role       VARCHAR(20)   NOT NULL,
  action            action_audit  NOT NULL,
  ancien_statut     VARCHAR(20),
  nouveau_statut    VARCHAR(20),
  ip_address        INET,
  user_agent        TEXT,
  payload_hash      CHAR(64),     -- SHA-256 du corps JSON soumis
  details           JSONB,
  CONSTRAINT audit_log_immutable CHECK (TRUE) -- Sentinel
);

-- Index audit
CREATE INDEX IF NOT EXISTS idx_audit_decl      ON audit_log(declaration_id);
CREATE INDEX IF NOT EXISTS idx_audit_acteur    ON audit_log(acteur_matricule);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp_srv DESC);

-- Règles d'immuabilité PostgreSQL
CREATE OR REPLACE RULE audit_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- TABLE : jwt_blacklist (tokens révoqués)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS jwt_blacklist (
  jti         UUID        PRIMARY KEY,
  matricule   VARCHAR(20) NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
-- Nettoyage automatique des tokens expirés
CREATE INDEX IF NOT EXISTS idx_jwt_expires ON jwt_blacklist(expires_at);

-- ══════════════════════════════════════════════════════════════════
-- DONNÉES INITIALES : Régions tunisiennes
-- ══════════════════════════════════════════════════════════════════
INSERT INTO regions (nom, cp_email) VALUES
  ('Grand Tunis',     'cp.grand-tunis@banque.tn'),
  ('Nord-Est',        'cp.nord-est@banque.tn'),
  ('Nord-Ouest',      'cp.nord-ouest@banque.tn'),
  ('Centre',          'cp.centre@banque.tn'),
  ('Centre-Est',      'cp.centre-est@banque.tn'),
  ('Centre-Ouest',    'cp.centre-ouest@banque.tn'),
  ('Sud-Est',         'cp.sud-est@banque.tn'),
  ('Sud-Ouest',       'cp.sud-ouest@banque.tn')
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- DONNÉES INITIALES : Échantillon d'agences
-- ══════════════════════════════════════════════════════════════════
INSERT INTO agences (code, nom, region_id, dir_email) VALUES
  ('001', 'Agence Centrale Tunis',      1, 'dir.001@banque.tn'),
  ('002', 'Belvédère',                   1, 'dir.002@banque.tn'),
  ('003', 'Lac I',                       1, 'dir.003@banque.tn'),
  ('056', 'Ariana',                      1, 'dir.056@banque.tn'),
  ('060', 'Gare Tunis',                  1, 'dir.060@banque.tn'),
  ('100', 'Agence Centrale Sousse',      5, 'dir.100@banque.tn'),
  ('104', 'Sfax Port',                   7, 'dir.104@banque.tn'),
  ('129', 'La Marsa',                    1, 'dir.129@banque.tn')
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- AGENT ADMIN PAR DÉFAUT (à modifier immédiatement en production)
-- ══════════════════════════════════════════════════════════════════
INSERT INTO agents (matricule, nom_prenom, role, email) VALUES
  ('ADMIN-001', 'Administrateur DSI', 'ADMIN', 'dsi@banque.tn')
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS) — Isolation par agence
-- ══════════════════════════════════════════════════════════════════
ALTER TABLE declarations ENABLE ROW LEVEL SECURITY;

-- Politique : Un agent ne voit que les déclarations de son agence
-- (sauf CP et ADMIN — gérés au niveau applicatif)
-- Note : En production, utiliser app.set_config('app.agence_code', ...) dans la connexion
CREATE POLICY decl_agence_policy ON declarations
  USING (
    agence_code = current_setting('app.agence_code', true)
    OR current_setting('app.role', true) IN ('CP', 'ADMIN')
  );

-- Permettre au rôle applicatif de tout lire (bypass via BYPASSRLS ou SUPERUSER)
-- En production, le compte cp_app doit avoir BYPASSRLS pour la politique applicative
-- ALTER ROLE cp_app BYPASSRLS;

-- ══════════════════════════════════════════════════════════════════
-- VUE : Déclarations enrichies (pour le dashboard)
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_declarations AS
SELECT
  d.id, d.ref, d.statut, d.niveau, d.created_at, d.date_constat,
  d.montant_dt, d.montant_mm,
  CONCAT(d.montant_dt, ',', LPAD(d.montant_mm::TEXT, 3, '0'), ' DT') AS montant_affiche,
  d.nature, d.type_caisse, d.recidive,
  d.agence_code, a.nom AS agence_nom, r.nom AS region_nom,
  d.caissier_matricule, d.caissier_nom, d.caissier_fonction,
  d.cp_traite_par, d.cp_n_dossier,
  d.declarant_matricule
FROM declarations d
JOIN agences a ON a.code = d.agence_code
JOIN regions  r ON r.id  = a.region_id;

COMMENT ON VIEW v_declarations IS 'Vue enrichie déclarations — Dashboard CP';
COMMENT ON TABLE audit_log IS 'Journal immuable — Pas de UPDATE/DELETE autorisé';
COMMENT ON TABLE declarations IS 'BQ-CP-CAI-001 — Conservation 10 ans obligatoire (BCT)';
