'use strict';

const nodemailer = require('nodemailer');
const path       = require('path');

// Niveau → libellé couleur HTML
const NIVEAU_COULEUR = {
  1: { label: 'Niveau 1', color: '#43A047', bg: '#E8F5E9' },
  2: { label: 'Niveau 2', color: '#F57F17', bg: '#FFF9C4' },
  3: { label: 'Niveau 3', color: '#E65100', bg: '#FFF3E0' },
  4: { label: 'Niveau 4 — CRITIQUE', color: '#C62828', bg: '#FFEBEE' },
};

class MailerService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.intranet.banque.tn',
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER || 'noreply-cp@banque.tn',
        pass: process.env.SMTP_PASSWORD,
      },
      tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
    });
    this.from = '"Contrôle Permanent BQ" <noreply-cp@banque.tn>';
  }

  // ── Template HTML de base ─────────────────────────────
  _buildMailHtml(decl, { titre, intro, corps, footer = '' }) {
    const niv  = NIVEAU_COULEUR[decl.niveau] || NIVEAU_COULEUR[1];
    const mont = `${decl.ecart?.montant_dt || 0},${String(decl.ecart?.montant_mm || 0).padStart(3,'0')} DT`;
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;background:#F3F4F6;margin:0;padding:20px}
  .card{background:#fff;border-radius:10px;max-width:640px;margin:0 auto;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .header{background:#0D1B2A;padding:20px 28px;display:flex;align-items:center;gap:14px}
  .header-badge{width:40px;height:40px;background:#1A6FA8;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;flex-shrink:0;line-height:1}
  .header-title{font-size:16px;font-weight:700;color:#fff;margin:0}
  .header-sub{font-size:11px;color:#00B4D8;margin:2px 0 0;font-family:monospace}
  .niv-banner{background:${niv.bg};border-left:5px solid ${niv.color};padding:12px 20px;font-weight:700;color:${niv.color};font-size:13px}
  .body{padding:24px 28px;font-size:13px;color:#374151;line-height:1.7}
  h2{font-size:15px;color:#0D1B2A;margin:0 0 14px}
  .field-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}
  .field{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:10px 14px}
  .field-label{font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
  .field-val{font-size:13px;color:#111827;font-weight:600}
  .ref{font-family:monospace;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:4px;padding:8px 14px;font-size:13px;color:#1E40AF;font-weight:700;margin:14px 0}
  .footer-section{background:#F9FAFB;border-top:1px solid #E5E7EB;padding:16px 28px;font-size:11px;color:#6B7280}
  a{color:#1A6FA8}
</style></head><body>
<div class="card">
  <div class="header">
    <div class="header-badge">BQ</div>
    <div>
      <div class="header-title">Contrôle Permanent — Réseau Agences</div>
      <div class="header-sub">Système de déclaration BQ-CP-CAI-001</div>
    </div>
  </div>
  <div class="niv-banner">⚠ ${niv.label} — ${decl.ecart?.nature || 'MANQUANT'} de ${mont}</div>
  <div class="body">
    <h2>${titre}</h2>
    <p>${intro}</p>
    <div class="ref">Réf : ${decl.ref}</div>
    <div class="field-grid">
      <div class="field"><div class="field-label">Agence</div><div class="field-val">${decl.agence?.code || '—'}</div></div>
      <div class="field"><div class="field-label">Date constat</div><div class="field-val">${decl.ecart?.date_constat || '—'}</div></div>
      <div class="field"><div class="field-label">Caissier</div><div class="field-val">${decl.caissier?.nom || '—'}</div></div>
      <div class="field"><div class="field-label">Matricule</div><div class="field-val">${decl.caissier?.matricule || '—'}</div></div>
      <div class="field"><div class="field-label">Montant</div><div class="field-val">${mont}</div></div>
      <div class="field"><div class="field-label">Type caisse</div><div class="field-val">${decl.ecart?.type_caisse || '—'}</div></div>
    </div>
    ${corps}
  </div>
  <div class="footer-section">
    ${footer}
    <br>Cet e-mail est généré automatiquement — Ne pas répondre directement.<br>
    Accès au portail CP : <a href="${process.env.BASE_URL || 'https://cp-caisse.intranet.banque.tn'}">Portail Interne</a> &nbsp;·&nbsp; DSI : dsi@banque.tn<br>
    Conservez cet e-mail — Réf. réglementaire BQ-CP-CAI-001 Rév.03 — 2025
  </div>
</div></body></html>`;
  }

  // ── Nouvelle déclaration → CP Central ─────────────────
  async sendDeclarationNouveauCP(to, decl) {
    if (!to) return;
    const html = this._buildMailHtml(decl, {
      titre: 'Nouvelle déclaration de différence de caisse reçue',
      intro: `Une nouvelle déclaration a été soumise et nécessite votre traitement dans les meilleurs délais.`,
      corps: `<p><strong>Déclaration du caissier :</strong></p>
              <blockquote style="border-left:3px solid #1A6FA8;margin:0;padding:8px 14px;color:#4B5563;font-style:italic">
                ${decl.circonstances?.declaration_caissier || '—'}
              </blockquote>
              <p style="margin-top:12px">Veuillez vous connecter au portail pour prendre en charge ce dossier.</p>`,
      footer: `Délai réglementaire de traitement : dès réception. Niveau d'alerte : ${NIVEAU_COULEUR[decl.niveau]?.label}.`
    });
    return this.transporter.sendMail({
      from: this.from, to,
      subject: `[CP] Nouvelle déclaration ${decl.niveau >= 3 ? '🔴 URGENT ' : ''}— Agence ${decl.agence?.code} — Réf. ${decl.ref}`,
      html,
    });
  }

  // ── Nouvelle déclaration → Directeur d'agence ─────────
  async sendDeclarationNouveauDirecteur(to, decl) {
    if (!to) return;
    const html = this._buildMailHtml(decl, {
      titre: 'Déclaration de différence de caisse soumise',
      intro: `Une déclaration de différence de caisse a été soumise dans votre agence. Elle a été transmise au Contrôle Permanent Central.`,
      corps: `<p>Veuillez vous assurer que toutes les mesures conservatoires ont été prises par le superviseur.</p>`,
      footer: `Déclaration transmise conformément à la circulaire BCT en vigueur.`
    });
    return this.transporter.sendMail({
      from: this.from, to,
      subject: `[Agence ${decl.agence?.code}] Déclaration de caisse soumise — Réf. ${decl.ref}`,
      html,
    });
  }

  // ── Alerte Niveau 4 ───────────────────────────────────
  async sendAlerteNiveau4(decl) {
    const to = process.env.MAIL_ALERTE_N4 || 'direction.generale@banque.tn';
    const html = this._buildMailHtml(decl, {
      titre: '🔴 ALERTE NIVEAU 4 — Écart de caisse critique',
      intro: `Un écart de caisse de NIVEAU 4 a été détecté. Une action immédiate est requise.`,
      corps: `<p style="color:#C62828;font-weight:700">Critère N4 : montant supérieur à 1 000 DT ou récidive avérée.</p>
              <p>Le dossier a été automatiquement transmis au Contrôle Permanent Central et à la Direction Générale.</p>`,
      footer: `Ce message est généré automatiquement pour toute déclaration de niveau 4. Conservation : 10 ans.`
    });
    return this.transporter.sendMail({
      from: this.from, to,
      subject: `🔴 ALERTE N4 — Agence ${decl.agence?.code} — ${decl.ecart?.montant_dt} DT — ${decl.ref}`,
      html, priority: 'high',
    });
  }

  // ── Alerte récidive ───────────────────────────────────
  async sendAlerteRecidive(decl) {
    const to = process.env.MAIL_ALERTE_RECIDIVE || 'rh@banque.tn';
    const html = this._buildMailHtml(decl, {
      titre: '⚠ RÉCIDIVE DÉTECTÉE — Caissier en situation de récidive',
      intro: `Le caissier ${decl.caissier?.nom} (${decl.caissier?.matricule}) est en situation de récidive d'écart de caisse.`,
      corps: `<p>Conformément aux procédures internes, une revue des écarts précédents et une entrevue avec les Ressources Humaines sont recommandées.</p>`,
      footer: `Signalement automatique — Procédure disciplinaire à engager selon politique RH.`
    });
    return this.transporter.sendMail({
      from: this.from, to,
      subject: `⚠ Récidive — ${decl.caissier?.matricule} — Agence ${decl.agence?.code}`,
      html,
    });
  }

  // ── Déclaration validée → Agence ─────────────────────
  async sendDeclarationValidee(to, decl) {
    if (!to) return;
    const html = this._buildMailHtml(decl, {
      titre: '✅ Déclaration validée par le Contrôle Permanent',
      intro: `La déclaration de différence de caisse ci-dessous a été validée par la Direction du Contrôle Permanent.`,
      corps: `<p>Les mesures correctives notées dans le dossier doivent être mises en œuvre dans les délais impartis.</p>`,
      footer: 'Conservation du document : 10 ans. Un exemplaire doit être conservé à l\'agence.'
    });
    return this.transporter.sendMail({
      from: this.from, to,
      subject: `✅ Déclaration validée — Réf. ${decl.ref}`,
      html,
    });
  }
}

module.exports = MailerService;
