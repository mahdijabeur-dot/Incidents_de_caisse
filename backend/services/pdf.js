'use strict';

const path = require('path');
const fs   = require('fs');

class PdfService {
  constructor() {
    this.archivePath = process.env.PDF_ARCHIVE_PATH || path.join(__dirname, '../../archives/pdf');
    if (!fs.existsSync(this.archivePath)) fs.mkdirSync(this.archivePath, { recursive: true });
  }

  // ── Générer le PDF d'une déclaration ─────────────────
  async generate(declId, decl) {
    let browser;
    try {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      const page = await browser.newPage();

      // Injecter le HTML du formulaire avec les données
      const html = this._buildPdfHtml(decl);
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

      // Dossier par année/mois pour l'archivage structuré
      const date   = new Date();
      const subDir = path.join(this.archivePath, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2,'0'));
      if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });

      const pdfPath = path.join(subDir, `${decl.ref || declId}.pdf`);

      await page.pdf({
        path:   pdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '15mm', bottom: '20mm', left: '15mm', right: '15mm' },
        displayHeaderFooter: true,
        headerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#6B7280;font-family:Arial">
          BQ-CP-CAI-001 — ${decl.ref} — CONFIDENTIEL
        </div>`,
        footerTemplate: `<div style="font-size:8px;width:100%;display:flex;justify-content:space-between;padding:0 15mm;color:#6B7280;font-family:Arial">
          <span>Direction du Contrôle Permanent — Conservation : 10 ans</span>
          <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`,
      });

      return pdfPath;
    } finally {
      if (browser) await browser.close();
    }
  }

  // ── HTML → PDF (formulaire figé, données injectées) ──
  _buildPdfHtml(decl) {
    const mont = `${decl.ecart?.montant_dt || 0},${String(decl.ecart?.montant_mm || 0).padStart(3,'0')} DT`;
    const niveauLabel = ['','N1 — Faible','N2 — Modéré','N3 — Élevé','N4 — Critique'][decl.niveau] || '—';
    const now  = new Date().toLocaleString('fr-TN');
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<style>
  @page { size: A4; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #111; background: #fff; line-height: 1.5; }
  .page { max-width: 100%; }
  .header { background: #0D1B2A; color: #fff; padding: 16px 20px; display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
  .header-title { font-size: 14px; font-weight: 700; }
  .header-ref { font-size: 10px; color: #00B4D8; font-family: monospace; margin-top: 3px; }
  .section { border: 1px solid #E5E7EB; border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
  .section-title { background: #1F2937; color: #fff; padding: 7px 14px; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .section-body { padding: 12px 14px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  .field { }
  .field-label { font-size: 9px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 700; margin-bottom: 2px; }
  .field-val { font-weight: 600; color: #111827; border-bottom: 1px solid #E5E7EB; padding-bottom: 3px; min-height: 18px; }
  .niv-badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: 700; font-size: 12px;
    background: ${['','#E8F5E9','#FFF9C4','#FFF3E0','#FFEBEE'][decl.niveau] || '#F3F4F6'};
    color: ${['','#1B5E20','#F57F17','#E65100','#C62828'][decl.niveau] || '#374151'};
  }
  .text-block { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 4px; padding: 8px 12px; font-size: 11px; line-height: 1.6; min-height: 40px; }
  .sig-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 8px; }
  .sig-box { border: 1px solid #D1D5DB; border-radius: 6px; padding: 10px; text-align: center; }
  .sig-label { font-size: 9px; color: #6B7280; text-transform: uppercase; font-weight: 700; margin-bottom: 4px; }
  .sig-nom { font-size: 10px; font-weight: 600; margin-bottom: 30px; }
  .sig-line { border-top: 1px solid #9CA3AF; margin-top: 4px; }
  .stamp { border: 2px solid #C62828; color: #C62828; font-weight: 700; padding: 4px 12px; display: inline-block; transform: rotate(-3deg); font-size: 10px; letter-spacing: 1px; }
  .footer-note { text-align: center; font-size: 9px; color: #9CA3AF; margin-top: 16px; border-top: 1px solid #E5E7EB; padding-top: 10px; }
</style></head><body>
<div class="page">
  <div class="header">
    <div style="background:#1A6FA8;width:44px;height:44px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;flex-shrink:0">BQ</div>
    <div>
      <div class="header-title">DÉCLARATION DE DIFFÉRENCE DE CAISSE</div>
      <div class="header-ref">Réf : ${decl.ref || '—'} &nbsp;·&nbsp; BQ-CP-CAI-001 Rév.03 — 2025 &nbsp;·&nbsp; Généré le ${now}</div>
    </div>
    <div style="margin-left:auto"><span class="niv-badge">${niveauLabel}</span></div>
  </div>

  <div class="section">
    <div class="section-title">1 — Identification de l'agence</div>
    <div class="section-body">
      <div class="grid">
        <div class="field"><div class="field-label">Code agence</div><div class="field-val">${decl.agence?.code || '—'}</div></div>
        <div class="field"><div class="field-label">Région</div><div class="field-val">${decl.agence?.region || '—'}</div></div>
        <div class="field"><div class="field-label">Date du constat</div><div class="field-val">${decl.ecart?.date_constat || '—'}</div></div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">2 — Identité du caissier</div>
    <div class="section-body">
      <div class="grid">
        <div class="field"><div class="field-label">Nom & Prénom</div><div class="field-val">${decl.caissier?.nom || '—'}</div></div>
        <div class="field"><div class="field-label">Matricule</div><div class="field-val">${decl.caissier?.matricule || '—'}</div></div>
        <div class="field"><div class="field-label">Fonction</div><div class="field-val">${decl.caissier?.fonction || '—'}</div></div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">3 — Écart constaté</div>
    <div class="section-body">
      <div class="grid">
        <div class="field"><div class="field-label">Montant écart</div><div class="field-val" style="font-size:14px;font-weight:800;color:#C62828">${mont}</div></div>
        <div class="field"><div class="field-label">Nature</div><div class="field-val">${decl.ecart?.nature || '—'}</div></div>
        <div class="field"><div class="field-label">Type caisse</div><div class="field-val">${decl.ecart?.type_caisse || '—'}</div></div>
        <div class="field"><div class="field-label">Heure constat</div><div class="field-val">${decl.ecart?.heure_constat || '—'}</div></div>
        <div class="field"><div class="field-label">Heure arrêté</div><div class="field-val">${decl.ecart?.heure_arrete || '—'}</div></div>
        <div class="field"><div class="field-label">Récidive</div><div class="field-val">${decl.recidive?.oui ? 'OUI — ' + (decl.recidive.nb_ecarts || 'N/A') + ' écart(s)' : 'NON'}</div></div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">4 — Déclaration du caissier</div>
    <div class="section-body"><div class="text-block">${decl.circonstances?.declaration_caissier || '—'}</div></div>
  </div>

  <div class="section">
    <div class="section-title">5 — Observations du superviseur</div>
    <div class="section-body"><div class="text-block">${decl.circonstances?.observations_sup || '—'}</div></div>
  </div>

  <div class="section">
    <div class="section-title">6 — Signatures</div>
    <div class="section-body">
      <div class="sig-grid">
        <div class="sig-box"><div class="sig-label">Le Caissier</div><div class="sig-nom">${decl.caissier?.nom || '—'}</div><div class="sig-line"></div></div>
        <div class="sig-box"><div class="sig-label">Le Superviseur</div><div class="sig-nom">&nbsp;</div><div class="sig-line"></div></div>
        <div class="sig-box"><div class="sig-label">Le Directeur d'Agence</div><div class="sig-nom">&nbsp;</div><div class="sig-line"></div></div>
      </div>
    </div>
  </div>

  <div class="footer-note">
    3 exemplaires obligatoires : Agence (1) · Contrôle Permanent (2) · Caissier (3) &nbsp;·&nbsp; Conservation : 10 ans &nbsp;·&nbsp; CONFIDENTIEL
  </div>
</div></body></html>`;
  }
}

module.exports = PdfService;
