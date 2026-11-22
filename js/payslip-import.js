/*
 * Import de bulletins de salaire au format PDF (testé sur le modèle Silae, très répandu).
 * Lecture 100 % locale : pdf.js extrait le texte et ses positions, ce module retrouve les montants utiles à l'impôt.
 *
 *   parsePayslip(pages)          → { month, netImposable, cumulNetImposable, brut, netPaye, pas, check, warnings }
 *   projectYear(payslips, year)  → salaire net imposable et prélèvement à la source projetés sur l'année
 */
(function (root) {
  'use strict';

  const Bnp = typeof module !== 'undefined' && module.exports ? require('./bnp-import.js') : root.BnpImport;
  const toLines = Bnp.toLines;
  const extractPages = Bnp.extractPages;

  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const RE_NUM = /^-?\s?\d{1,3}(?:[\s .]\d{3})*(?:[.,]\d{1,4})?$|^-?\s?\d+(?:[.,]\d{1,4})?$/;
  const round2 = (x) => Math.round(x * 100) / 100;
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /** « 1 234.56 », « 1 234,56 », « 1.234,56 », « - 7.5000 » → nombre. */
  function parseNum(s) {
    let t = String(s).replace(/[\s ]/g, '');
    if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(',', '.');
    const n = Number(t);
    return isNaN(n) ? null : n;
  }
  const numSegs = (line) => line.segs.filter((s) => RE_NUM.test(s.text.trim()));
  /** Nombres d'une ligne, lus dans le texte (robuste si plusieurs montants sont accolés dans un même bloc). */
  const RE_TOKEN = /(?:^|[^\d.,])(-\s?)?(\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{1,4})?)(?![\d])/g;
  function numTokens(text) {
    const out = [];
    for (const m of String(text).matchAll(RE_TOKEN)) out.push({ text: (m[1] || '') + m[2], v: parseNum((m[1] ? '-' : '') + m[2]) });
    return out;
  }
  const lastNum = (line) => { const n = numTokens(line.text); return n.length ? n[n.length - 1].v : null; };

  function parsePeriod(lines, allText) {
    const t = norm(allText);
    let m = t.match(new RegExp(`periode\\s*:?\\s*(?:du\\s*)?(${MONTHS.map(norm).join('|')})\\s+(\\d{4})`));
    if (m) return `${m[2]}-${String(MONTHS.map(norm).indexOf(m[1]) + 1).padStart(2, '0')}`;
    m = t.match(/periode\s*:?\s*du\s*\d{2}\/(\d{2})\/(\d{4})/);
    if (m) return `${m[2]}-${m[1]}`;
    m = t.match(/##(\d{2})-(\d{4})##/); // en-tête technique Silae
    if (m) return `${m[2]}-${m[1]}`;
    m = t.match(/(?:mois|periode)\s*:?\s*(\d{2})\/(\d{4})/);
    if (m) return `${m[2]}-${m[1]}`;
    return null;
  }

  /**
   * Tableau récapitulatif : une ligne d'en-tête contenant « Net imposable », puis des lignes
   * « Mensuel »/« Période » et « Annuel »/« Cumul ». On prend la valeur alignée sous la colonne.
   */
  function readSummaryColumn(lines, label) {
    for (let i = 0; i < lines.length; i++) {
      const items = lines[i].items;
      let col = null;
      // Le libellé peut être un seul élément (« Net imposable ») ou découpé en plusieurs (« Net », « imposable »).
      for (let k = 0; k < items.length && !col; k++) {
        let acc = '';
        for (let j = k; j < items.length; j++) {
          acc = (acc ? acc + ' ' : '') + norm(items[j].str.trim()).replace(/\s+/g, ' ');
          if (acc === label) { col = { start: items[k].x, end: items[j].x + items[j].w }; break; }
          if (!label.startsWith(acc)) break;
        }
      }
      if (!col) continue;
      const pick = (line) => {
        let best = null, bestScore = -Infinity;
        for (const s of numSegs(line)) {
          const overlap = Math.min(s.end, col.end) - Math.max(s.x, col.start);
          const score = overlap > 0 ? overlap : -Math.abs((s.x + s.end) / 2 - (col.start + col.end) / 2);
          if (score > bestScore) { bestScore = score; best = s; }
        }
        return best && bestScore > -25 ? parseNum(best.text) : null;
      };
      let monthly = null, cumul = null;
      for (const l of lines.slice(i + 1, i + 6)) {
        const head = norm(l.segs[0] ? l.segs[0].text : '');
        if (monthly == null && /^(mensuel|periode|mois)\b/.test(head)) monthly = pick(l);
        else if (cumul == null && /^(annuel|cumul|cumuls|annee)\b/.test(head)) cumul = pick(l);
      }
      if (monthly != null || cumul != null) return { monthly, cumul };
    }
    return null;
  }

  function parsePayslip(pages) {
    const warnings = [];
    const lines = pages.flatMap((p) => toLines(p.items));
    const allText = lines.map((l) => l.text).join('\n');
    const nt = norm(allText);
    const month = parsePeriod(lines, allText);
    if (!month) warnings.push('Mois du bulletin introuvable.');

    let netImposable = null, cumulNetImposable = null, method = null;
    const table = readSummaryColumn(lines, 'net imposable');
    if (table) {
      netImposable = table.monthly; cumulNetImposable = table.cumul; method = 'tableau récapitulatif';
    }
    // Autres modèles : « Net imposable 1 234,56 » ou « Cumul net imposable … » sur une même ligne.
    for (const l of lines) {
      const t = norm(l.text);
      if (!/net (fiscal )?imposable/.test(t)) continue;
      const v = lastNum(l);
      if (v == null) continue;
      if (/cumul|annuel/.test(t)) { if (cumulNetImposable == null) cumulNetImposable = v; } else if (netImposable == null) { netImposable = v; method = method || 'ligne « Net imposable »'; }
    }

    // Prélèvement à la source : base, taux, montant ; puis son cumul annuel.
    const pas = { base: null, taux: null, montant: null, cumul: null, type: null };
    for (let i = 0; i < lines.length; i++) {
      const t = norm(lines[i].text);
      if (/cumul/.test(t) && /(pas|prelev|impot sur le revenu)/.test(t)) {
        if (pas.cumul == null) pas.cumul = lastNum(lines[i]);
        continue;
      }
      if (pas.montant == null && /(preleve|prelevement) a la source|impot sur le revenu.*\bpas\b/.test(t)) {
        const nums = numTokens(lines[i].text);
        if (!nums.length) continue;
        pas.montant = Math.abs(nums[nums.length - 1].v);
        const tauxSeg = nums.slice(0, -1).find((n) => /[.,]\d{3,4}$/.test(n.text.trim()) || Math.abs(n.v) < 60);
        if (tauxSeg) pas.taux = Math.abs(tauxSeg.v);
        const baseSeg = nums.slice(0, -1).find((n) => n !== tauxSeg);
        if (baseSeg) pas.base = Math.abs(baseSeg.v);
        const around = norm(lines.slice(i, i + 3).map((l) => l.text).join(' '));
        pas.type = /personnalis/.test(around) ? 'personnalisé' : /neutre|non personnalis/.test(around) ? 'neutre' : /individualis/.test(around) ? 'individualisé' : null;
      }
    }

    let netPaye = null, brut = null;
    for (const l of lines) {
      const t = norm(l.text);
      if (netPaye == null && /^net paye\b/.test(t)) netPaye = lastNum(l);
      if (brut == null && /^salaire brut\b/.test(t)) brut = lastNum(l);
    }

    // Contrôle : la base du prélèvement à la source est le net imposable du mois.
    const check = {
      pasBaseMatches: pas.base != null && netImposable != null ? Math.abs(pas.base - netImposable) < 0.02 : null,
      ok: false,
    };
    check.ok = netImposable != null && check.pasBaseMatches !== false;
    if (netImposable == null) warnings.push('Net imposable introuvable : ce PDF est-il bien un bulletin de salaire ?');
    else if (check.pasBaseMatches === false) warnings.push(`Le net imposable lu (${netImposable}) diffère de la base du prélèvement à la source (${pas.base}). Vérifiez le montant.`);
    if (!/bulletin|salaire|paie/.test(nt)) warnings.push('Ce document ne ressemble pas à un bulletin de salaire.');

    return {
      month, netImposable: netImposable == null ? null : round2(netImposable),
      cumulNetImposable: cumulNetImposable == null ? null : round2(cumulNetImposable),
      brut, netPaye, pas, method, check, warnings,
    };
  }

  /**
   * Projection annuelle à partir des bulletins d'une année (pour un déclarant).
   * Connu = cumul annuel du dernier bulletin (ou somme des bulletins si pas de cumul) ;
   * mois restants estimés à la moyenne des 3 derniers bulletins.
   */
  function projectYear(payslips, year) {
    const list = (payslips || []).filter((p) => p.month && p.month.startsWith(year + '-')).sort((a, b) => a.month.localeCompare(b.month));
    if (!list.length) return null;
    const last = list[list.length - 1];
    const lastMonth = Number(last.month.slice(5, 7));
    const recent = list.slice(-3);
    const avg = (f) => recent.reduce((a, p) => a + (f(p) || 0), 0) / recent.length;

    const knownNet = last.cumulNetImposable != null ? last.cumulNetImposable : list.reduce((a, p) => a + p.netImposable, 0);
    const knownMonths = last.cumulNetImposable != null ? lastMonth : list.length;
    const remaining = Math.max(0, 12 - knownMonths);
    const avgNet = avg((p) => p.netImposable);

    const pasKnown = last.pas && last.pas.cumul != null ? last.pas.cumul : list.reduce((a, p) => a + ((p.pas && p.pas.montant) || 0), 0);
    const avgPas = avg((p) => p.pas && p.pas.montant);

    return {
      year, count: list.length, lastMonth: last.month, fromCumul: last.cumulNetImposable != null,
      knownNet: round2(knownNet), knownMonths, remaining, avgNet: round2(avgNet),
      netImposable: round2(knownNet + remaining * avgNet),
      pasKnown: round2(pasKnown), avgPas: round2(avgPas), pas: round2(pasKnown + remaining * avgPas),
      taux: last.pas ? last.pas.taux : null, tauxType: last.pas ? last.pas.type : null,
    };
  }

  const Payslip = { extractPages, parsePayslip, projectYear, parseNum };
  if (typeof module !== 'undefined' && module.exports) module.exports = Payslip;
  else root.PayslipImport = Payslip;
})(typeof window !== 'undefined' ? window : globalThis);
