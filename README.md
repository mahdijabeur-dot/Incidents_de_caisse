# BQ-CP-CAI-001 — Pack de Déploiement Web Complet
**Direction du Contrôle Permanent — Déclarations de Différence de Caisse**
Référence : BQ-DSI-DEPLOY-001 Rév.03 — 2025 | CONFIDENTIEL DSI

---

## Structure du pack

```
bq-cp-caisse/
├── frontend/
│   ├── index.html              ← Portail principal (tableau de bord)
│   └── formulaire.html         ← Formulaire BQ-CP-CAI-001 v3
│
├── backend/
│   ├── server.js               ← Point d'entrée Express + sécurité
│   ├── package.json            ← Dépendances Node.js
│   ├── routes/
│   │   ├── auth.js             ← Connexion LDAP/AD → JWT
│   │   ├── declarations.js     ← CRUD déclarations (route principale)
│   │   ├── referentiels.js     ← Agences, causes, types de caisse
│   │   ├── stats.js            ← Dashboard KPI pour le CP Central
│   │   └── audit.js            ← Journal immuable des événements
│   ├── middleware/
│   │   └── authenticate.js     ← Vérification JWT + RBAC 5 rôles
│   ├── services/
│   │   ├── mailer.js           ← Notifications email (6 templates)
│   │   └── pdf.js              ← Génération PDF via Puppeteer
│   └── db/
│       └── schema.sql          ← Schéma PostgreSQL 15 complet
│
├── deploy/
│   ├── nginx.conf              ← Configuration Nginx (TLS + sécurité)
│   ├── .env.example            ← Template variables d'environnement
│   └── deploy.sh               ← Script d'installation automatisé
│
└── docs/
    └── api-spec.html           ← Documentation API interactive
```

---

## Prérequis serveur

| Composant     | Version minimum | Notes                                    |
|---------------|-----------------|------------------------------------------|
| Ubuntu/Debian | 22.04 / 12      | Serveur dans le VLAN intranet banque     |
| Node.js       | 20 LTS          | Installé automatiquement par deploy.sh   |
| Nginx         | 1.22+           | Serveur web + reverse proxy              |
| PostgreSQL    | 15+             | Sur serveur dédié réseau isolé           |
| Chromium      | Dernier stable  | Requis pour Puppeteer (génération PDF)   |
| Accès LDAP    | Active Directory| Pour l'authentification des agents       |

---

## Installation rapide

### 1. Préparer PostgreSQL (sur le serveur DB)
```bash
sudo -u postgres psql <<EOF
CREATE USER cp_app WITH PASSWORD 'MOT_DE_PASSE_SECURISE';
CREATE DATABASE cp_declarations OWNER cp_app;
\c cp_declarations
-- Appliquer le schéma :
\i /chemin/vers/backend/db/schema.sql
EOF
```

### 2. Copier le pack sur le serveur applicatif
```bash
scp -r bq-cp-caisse/ admin@10.x.x.x:/tmp/
ssh admin@10.x.x.x
cd /tmp/bq-cp-caisse
```

### 3. Lancer l'installation automatisée
```bash
sudo bash deploy/deploy.sh install
```

### 4. Configurer les paramètres réels
```bash
sudo nano /var/www/cp-caisse/backend/.env
# Remplir : DB_PASSWORD, LDAP_*, SMTP_*, etc.
```

### 5. Initialiser la base et redémarrer
```bash
sudo -u postgres psql -d cp_declarations -f /var/www/cp-caisse/backend/db/schema.sql
sudo systemctl restart bq-cp-backend
```

### 6. Installer le certificat TLS
```bash
# Copier les fichiers PKI internes :
sudo cp banque.crt /etc/ssl/banque/cp-caisse.crt
sudo cp banque.key /etc/ssl/banque/cp-caisse.key
sudo nginx -t && sudo systemctl reload nginx
```

### 7. Vérifier le déploiement
```bash
curl https://cp-caisse.intranet.banque.tn/api/v1/health
# Réponse attendue : {"status":"OK","database":"connected",...}
```

---

## Rôles et accès

| Rôle       | Créer | Voir (agence) | Voir (tout) | Valider | Admin |
|------------|-------|---------------|-------------|---------|-------|
| CAISSIER   | ✓     | ✓ (propre)    | ✗           | ✗       | ✗     |
| SUPERVISEUR| ✓     | ✓             | ✗           | Partiel | ✗     |
| DIRECTEUR  | ✗     | ✓             | ✗           | ✓       | ✗     |
| CP CENTRAL | ✗     | ✓             | ✓           | ✓       | ✗     |
| ADMIN DSI  | ✓     | ✓             | ✓           | ✓       | ✓     |

Groupes Active Directory à créer :
- `GRP-CP-ADMIN`, `GRP-CP-CENTRAL`, `GRP-CP-DIRECTEUR`, `GRP-CP-SUPERVISEUR`

---

## Endpoints API principaux

```
POST   /api/v1/auth/login              → Connexion (LDAP → JWT)
GET    /api/v1/auth/me                 → Profil utilisateur

POST   /api/v1/declarations            → Créer une déclaration
GET    /api/v1/declarations            → Lister (filtres + pagination)
GET    /api/v1/declarations/:id        → Détail
PATCH  /api/v1/declarations/:id        → Mettre à jour / changer statut
GET    /api/v1/declarations/:id/pdf    → Télécharger le PDF

GET    /api/v1/referentiels/agences    → Liste des 164 agences (cache 24h)
GET    /api/v1/referentiels/causes     → Causes probables
GET    /api/v1/stats                   → KPI du tableau de bord
GET    /api/v1/audit                   → Journal d'audit (CP/ADMIN)
GET    /api/v1/health                  → Health check
```

---

## Workflow des statuts

```
SOUMIS → EN_COURS → EN_ENQUETE → VALIDE → CLOTURE
         EN_COURS → REJETE     → SOUMIS  (correction)
```

---

## Sécurité — Points clés

- ✅ HTTPS TLS 1.2/1.3 obligatoire (certificat PKI interne)
- ✅ JWT RS256 (clé asymétrique 2048 bits, expiry 8h)
- ✅ Authentification LDAP/Active Directory
- ✅ RBAC 5 niveaux avec isolation par agence
- ✅ Rate limiting : 10 tentatives/login/15min
- ✅ En-têtes HTTP de sécurité (HSTS, CSP, X-Frame-Options…)
- ✅ Journal d'audit immuable (PostgreSQL RULE NO DELETE/UPDATE)
- ✅ Validation Joi côté serveur (pas de confiance client)
- ✅ Logs Winston structurés (JSON) avec rotation quotidienne
- ✅ Graceful shutdown (SIGTERM/SIGINT)

---

## Conformité réglementaire

| Exigence               | Implémentation                              |
|------------------------|---------------------------------------------|
| Conservation 10 ans    | PDF archivé + BDD + NAS chiffré AES-256    |
| Niveaux BCT N1-N4      | Calcul automatique + override récidive N4   |
| Délai transmission <1h | Avertissement non bloquant + alerte e-mail  |
| 3 exemplaires          | Mention sur le PDF généré                   |
| Référence BCT          | BQ-CP-CAI-001 Rév.03 — 2025                |
| Séparation des fonctions| Déclarant ≠ Validateur (contrôle serveur) |
| Traçabilité totale     | Audit log immuable toutes actions           |

---

## Mise à jour et rollback

```bash
# Mise à jour (sauvegarde automatique avant)
sudo bash deploy/deploy.sh update

# Rollback vers la dernière version sauvegardée
sudo bash deploy/deploy.sh rollback
```

---

## Support DSI

- **Email** : dsi@banque.tn
- **Référence document** : BQ-DSI-DEPLOY-001
- **Documentation API** : https://cp-caisse.intranet.banque.tn/docs/api-spec.html
