#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# BQ-CP-CAI-001 — Script de déploiement automatisé
# Usage : sudo bash deploy.sh [install|update|rollback]
# Testé sur Ubuntu 22.04 LTS / Debian 12
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Couleurs ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

# ── Configuration ──────────────────────────────────────────────────
APP_NAME="bq-cp-caisse"
APP_USER="bq-cp"
APP_DIR="/var/www/cp-caisse"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_DIR="$APP_DIR/frontend"
LOG_DIR="/var/log/bq-cp"
KEY_DIR="/etc/bq-cp/keys"
BACKUP_DIR="/var/backups/bq-cp"
SERVICE_NAME="bq-cp-backend"
NODE_VERSION="20"

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }
err()  { echo -e "${RED}[✗] ERREUR : $1${NC}"; exit 1; }
step() { echo -e "\n${BLUE}${BOLD}══ $1 ══${NC}"; }

# ── Vérifications préliminaires ────────────────────────────────────
preflight_checks() {
  step "Vérifications préliminaires"
  [[ $EUID -ne 0 ]] && err "Ce script doit être exécuté en tant que root (sudo)"
  command -v nginx   >/dev/null || err "Nginx non installé"
  command -v psql    >/dev/null || warn "PostgreSQL client non trouvé — ignoré"
  log "Prérequis vérifiés"
}

# ── Installation des dépendances système ──────────────────────────
install_system_deps() {
  step "Installation des dépendances système"
  apt-get update -qq
  apt-get install -y -qq \
    nginx curl git build-essential \
    chromium-browser \
    postgresql-client \
    logrotate
  log "Dépendances système installées"

  # Node.js 20 LTS via NodeSource
  if ! command -v node >/dev/null || [[ $(node -v | grep -oP '\d+' | head -1) -lt $NODE_VERSION ]]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
    log "Node.js $(node -v) installé"
  else
    log "Node.js $(node -v) déjà à jour"
  fi
}

# ── Création de l'utilisateur système ─────────────────────────────
create_app_user() {
  step "Création de l'utilisateur applicatif"
  if ! id "$APP_USER" &>/dev/null; then
    useradd --system --shell /usr/sbin/nologin --home "$APP_DIR" "$APP_USER"
    log "Utilisateur $APP_USER créé"
  else
    log "Utilisateur $APP_USER existe déjà"
  fi
}

# ── Structure des répertoires ──────────────────────────────────────
setup_directories() {
  step "Création de la structure de répertoires"
  mkdir -p "$BACKEND_DIR" "$FRONTEND_DIR" "$LOG_DIR" "$KEY_DIR" "$BACKUP_DIR"
  mkdir -p "$BACKEND_DIR/logs"

  chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"
  chmod 750 "$KEY_DIR"
  log "Répertoires créés"
}

# ── Génération des clés JWT ────────────────────────────────────────
generate_jwt_keys() {
  step "Génération des clés JWT (RS256)"
  if [[ ! -f "$KEY_DIR/jwt-private.pem" ]]; then
    openssl genrsa -out "$KEY_DIR/jwt-private.pem" 2048 2>/dev/null
    openssl rsa -in "$KEY_DIR/jwt-private.pem" \
                -pubout -out "$KEY_DIR/jwt-public.pem" 2>/dev/null
    chmod 640 "$KEY_DIR/jwt-private.pem"
    chmod 644 "$KEY_DIR/jwt-public.pem"
    chown "$APP_USER:$APP_USER" "$KEY_DIR"/*.pem
    log "Clés JWT générées dans $KEY_DIR"
  else
    log "Clés JWT déjà présentes — aucune action"
  fi
}

# ── Déploiement des fichiers ───────────────────────────────────────
deploy_files() {
  step "Déploiement des fichiers applicatifs"
  local SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  # Backend
  cp -r "$SCRIPT_DIR/../backend/"* "$BACKEND_DIR/"
  chown -R "$APP_USER:$APP_USER" "$BACKEND_DIR"
  log "Backend déployé dans $BACKEND_DIR"

  # Frontend
  cp -r "$SCRIPT_DIR/../frontend/"* "$FRONTEND_DIR/"
  chown -R "$APP_USER:$APP_USER" "$FRONTEND_DIR"
  log "Frontend déployé dans $FRONTEND_DIR"
}

# ── Fichier .env ───────────────────────────────────────────────────
setup_env() {
  step "Configuration du fichier .env"
  if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    cp "$(dirname "$0")/.env.example" "$BACKEND_DIR/.env"
    chown "$APP_USER:$APP_USER" "$BACKEND_DIR/.env"
    chmod 640 "$BACKEND_DIR/.env"
    warn ".env copié depuis .env.example — CONFIGUREZ les valeurs avant de continuer !"
    warn "Éditez : nano $BACKEND_DIR/.env"
  else
    log ".env déjà configuré"
  fi
}

# ── Installation des dépendances Node ─────────────────────────────
install_node_deps() {
  step "Installation des dépendances Node.js (production)"
  cd "$BACKEND_DIR"
  sudo -u "$APP_USER" npm install --production --silent
  log "Dépendances npm installées"
}

# ── Service systemd ────────────────────────────────────────────────
setup_systemd() {
  step "Configuration du service systemd"
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=BQ Contrôle Permanent — Backend API (BQ-CP-CAI-001)
Documentation=https://cp-caisse.intranet.banque.tn/docs/api-spec.html
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$BACKEND_DIR
EnvironmentFile=$BACKEND_DIR/.env
ExecStart=/usr/bin/node server.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/backend.log
StandardError=append:$LOG_DIR/backend-error.log

# Sécurité
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$LOG_DIR $APP_DIR/archives

# Limites
LimitNOFILE=65536
MemoryLimit=512M
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  log "Service $SERVICE_NAME configuré"
}

# ── Configuration Nginx ────────────────────────────────────────────
setup_nginx() {
  step "Configuration Nginx"
  cp "$(dirname "$0")/nginx.conf" "/etc/nginx/sites-available/$APP_NAME.conf"
  ln -sf "/etc/nginx/sites-available/$APP_NAME.conf" "/etc/nginx/sites-enabled/$APP_NAME.conf"

  # Ajouter la zone de rate limiting dans nginx.conf si absente
  if ! grep -q "login_limit" /etc/nginx/nginx.conf; then
    sed -i '/http {/a\    limit_req_zone $binary_remote_addr zone=login_limit:10m rate=10r/m;\n    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/m;' /etc/nginx/nginx.conf
    log "Zones de rate limiting ajoutées à nginx.conf"
  fi

  nginx -t && log "Configuration Nginx valide" || err "Configuration Nginx invalide — vérifiez les logs"
}

# ── Base de données ────────────────────────────────────────────────
init_database() {
  step "Initialisation de la base de données"
  warn "Assurez-vous que PostgreSQL est démarré et que l'utilisateur cp_app existe."
  warn "Commandes à exécuter en tant que postgres :"
  echo -e "  ${CYAN}sudo -u postgres psql -c \"CREATE USER cp_app WITH PASSWORD 'MOT_DE_PASSE';\"${NC}"
  echo -e "  ${CYAN}sudo -u postgres psql -c \"CREATE DATABASE cp_declarations OWNER cp_app;\"${NC}"
  echo -e "  ${CYAN}sudo -u postgres psql -d cp_declarations -f $BACKEND_DIR/db/schema.sql${NC}"
}

# ── Logrotate ──────────────────────────────────────────────────────
setup_logrotate() {
  step "Configuration de la rotation des logs"
  cat > "/etc/logrotate.d/$APP_NAME" <<EOF
$LOG_DIR/*.log {
    daily
    missingok
    rotate 90
    compress
    delaycompress
    notifempty
    create 640 $APP_USER $APP_USER
    postrotate
        systemctl reload $SERVICE_NAME 2>/dev/null || true
    endscript
}
EOF
  log "Logrotate configuré (rotation quotidienne, 90 jours)"
}

# ── Démarrage ──────────────────────────────────────────────────────
start_services() {
  step "Démarrage des services"
  systemctl start "$SERVICE_NAME"
  systemctl reload nginx
  sleep 3

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "Service $SERVICE_NAME démarré ✓"
  else
    err "Échec démarrage $SERVICE_NAME — journalctl -u $SERVICE_NAME -n 50"
  fi

  # Health check
  if curl -sf http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1; then
    log "Health check OK ✓"
  else
    warn "Health check non disponible — vérifiez la configuration .env"
  fi
}

# ── Sauvegarde avant mise à jour ───────────────────────────────────
backup_before_update() {
  step "Sauvegarde avant mise à jour"
  local TS=$(date +%Y%m%d_%H%M%S)
  local BDIR="$BACKUP_DIR/$TS"
  mkdir -p "$BDIR"
  cp -r "$BACKEND_DIR" "$BDIR/backend" 2>/dev/null || true
  cp -r "$FRONTEND_DIR" "$BDIR/frontend" 2>/dev/null || true
  log "Sauvegarde créée : $BDIR"
  echo "$TS" > "$BACKUP_DIR/.last_backup"
}

# ── Résumé final ───────────────────────────────────────────────────
print_summary() {
  echo ""
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${GREEN}  BQ-CP-CAI-001 — Déploiement terminé ✓${NC}"
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  🌐 URL Intranet : ${CYAN}https://cp-caisse.intranet.banque.tn${NC}"
  echo -e "  ⚙️  API Health  : ${CYAN}http://127.0.0.1:3000/api/v1/health${NC}"
  echo -e "  📋 Frontend    : ${CYAN}$FRONTEND_DIR${NC}"
  echo -e "  📁 Logs        : ${CYAN}$LOG_DIR${NC}"
  echo -e "  🔑 Clés JWT    : ${CYAN}$KEY_DIR${NC}"
  echo ""
  echo -e "  ${YELLOW}Prochaines étapes :${NC}"
  echo    "    1. Configurer $BACKEND_DIR/.env avec les vrais paramètres"
  echo    "    2. Installer le certificat TLS dans /etc/ssl/banque/"
  echo    "    3. Initialiser la base de données (voir instructions ci-dessus)"
  echo    "    4. systemctl restart $SERVICE_NAME"
  echo    "    5. Test : curl https://cp-caisse.intranet.banque.tn/api/v1/health"
  echo ""
}

# ══════════════════════════════════════════════════════════════════
# POINT D'ENTRÉE PRINCIPAL
# ══════════════════════════════════════════════════════════════════
ACTION="${1:-install}"

case "$ACTION" in
  install)
    echo -e "\n${BOLD}${BLUE}  BQ-CP-CAI-001 — Installation complète${NC}\n"
    preflight_checks
    install_system_deps
    create_app_user
    setup_directories
    generate_jwt_keys
    deploy_files
    setup_env
    install_node_deps
    setup_systemd
    setup_nginx
    setup_logrotate
    init_database
    start_services
    print_summary
    ;;
  update)
    echo -e "\n${BOLD}${BLUE}  BQ-CP-CAI-001 — Mise à jour${NC}\n"
    preflight_checks
    backup_before_update
    systemctl stop "$SERVICE_NAME" || true
    deploy_files
    install_node_deps
    systemctl start "$SERVICE_NAME"
    systemctl reload nginx
    log "Mise à jour terminée"
    ;;
  rollback)
    echo -e "\n${BOLD}${YELLOW}  BQ-CP-CAI-001 — Rollback${NC}\n"
    LAST=$(cat "$BACKUP_DIR/.last_backup" 2>/dev/null || err "Aucune sauvegarde trouvée")
    systemctl stop "$SERVICE_NAME"
    cp -r "$BACKUP_DIR/$LAST/backend/"  "$BACKEND_DIR/"
    cp -r "$BACKUP_DIR/$LAST/frontend/" "$FRONTEND_DIR/"
    systemctl start "$SERVICE_NAME"
    log "Rollback vers $LAST effectué"
    ;;
  *)
    echo "Usage : sudo bash deploy.sh [install|update|rollback]"
    exit 1
    ;;
esac
