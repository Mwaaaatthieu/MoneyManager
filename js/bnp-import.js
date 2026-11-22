/*
 * Import de relevés de compte BNP Paribas au format PDF.
 * Tout se passe localement : le PDF est lu dans le navigateur (pdf.js), rien n'est envoyé.
 *
 * Fonctions pures (testables dans Node) :
 *   extractPages(pdfjsLib, data)  → [{ items: [{ str, x, y, w }] }]
 *   parseStatement(pages)        → { period, openingBalance, closingBalance, totals, operations, check, warnings }
 *   suggest(op, userRules)       → { category, recurring, ignore }
 */
(function (root) {
  'use strict';

  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const RE_DAY = /^\d{2}\.\d{2}$/;
  const RE_AMOUNT = /^\d{1,3}(?: ?\d{3})*,\d{2}$/;

  const parseAmount = (s) => Number(String(s).replace(/\s/g, '').replace(',', '.'));
  const round2 = (x) => Math.round(x * 100) / 100;
  const pad = (n) => String(n).padStart(2, '0');

  // ------------------------------------------------------------ extraction pdf.js

  async function extractPages(pdfjsLib, data) {
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push({
        items: tc.items.filter((it) => it.str && it.str.trim())
          .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })),
      });
    }
    await doc.destroy();
    return pages;
  }

  // ------------------------------------------------------------ mise en lignes / segments

  /** Regroupe les éléments en lignes (même ordonnée), puis en segments (mots proches). */
  function toLines(items) {
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      let line = lines.find((l) => Math.abs(l.y - it.y) <= 2.5);
      if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
      line.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      l.segs = [];
      for (const it of l.items) {
        const last = l.segs[l.segs.length - 1];
        const gap = last ? it.x - last.end : Infinity;
        if (last && gap <= 6) {
          last.text += (gap > 1 ? ' ' : '') + it.str.trim();
          last.end = Math.max(last.end, it.x + it.w);
        } else {
          l.segs.push({ text: it.str.trim(), x: it.x, end: it.x + it.w });
        }
      }
      l.text = l.segs.map((s) => s.text).join(' ');
    }
    return lines;
  }

  /** Repère l'en-tête « Date | Nature des opérations | Valeur | Débit | Crédit » d'une page. */
  function findHeader(lines) {
    for (const l of lines) {
      const t = l.text.replace(/\s/g, '');
      if (!/Date/.test(t) || !/Débit/.test(t) || !/Crédit/.test(t)) continue;
      const find = (re) => l.segs.find((s) => re.test(s.text.replace(/\s/g, '')));
      const date = find(/^Date/), nature = find(/Nature/), valeur = find(/^Valeur/), debit = find(/^Débit/), credit = find(/^Crédit/);
      if (date && nature && valeur && debit && credit) {
        return { y: l.y, date: date.x, nature: nature.x, valeur: valeur.x, debitEnd: debit.end, creditEnd: credit.end };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ analyse du relevé

  function parsePeriod(text) {
    const re = new RegExp(`du (\\d{1,2}) (${MONTHS.join('|')}) (\\d{4}) au (\\d{1,2}) (${MONTHS.join('|')}) (\\d{4})`, 'i');
    const m = text.match(re);
    if (!m) return null;
    const d = (day, month, year) => `${year}-${pad(MONTHS.indexOf(month.toLowerCase()) + 1)}-${pad(day)}`;
    return { from: d(m[1], m[2], m[3]), to: d(m[4], m[5], m[6]) };
  }

  /** Titulaire (« M NOM PRENOM ») : sert à reconnaître les virements entre ses propres comptes. */
  function parseHolder(text) {
    const m = text.match(/^(?:M|MME|MLLE|MR|MONSIEUR|MADAME)\.? ([A-ZÀ-Ü'\- ]{3,}?)\s*$/m);
    return m ? m[1].trim() : null;
  }

  /** Date « JJ.MM » → ISO, en déduisant l'année à partir de la période du relevé. */
  function resolveDay(ddmm, period) {
    const [dd, mm] = ddmm.split('.');
    if (!period) return `${new Date().getFullYear()}-${mm}-${dd}`;
    const fromY = Number(period.from.slice(0, 4));
    const toY = Number(period.to.slice(0, 4));
    if (fromY === toY) return `${fromY}-${mm}-${dd}`;
    // période à cheval sur deux années (ex. décembre → janvier)
    return Number(mm) >= Number(period.from.slice(5, 7)) ? `${fromY}-${mm}-${dd}` : `${toY}-${mm}-${dd}`;
  }

  const ddmmyyToIso = (s) => `20${s.slice(4, 6)}-${s.slice(2, 4)}-${s.slice(0, 2)}`;

  function parseStatement(pages) {
    const warnings = [];
    const allText = pages.map((p) => toLines(p.items).map((l) => l.text).join('\n')).join('\n');
    const period = parsePeriod(allText);
    const holder = parseHolder(allText);
    if (!period) warnings.push('Période du relevé introuvable : l\'année des opérations est supposée être l\'année en cours.');

    const ops = [];
    let current = null;
    let openingBalance = null, closingBalance = null, totals = null, finished = false;

    for (const page of pages) {
      if (finished) break;
      const lines = toLines(page.items);
      const h = findHeader(lines);
      if (!h) continue;
      const amountOf = (l) => {
        const segs = l.segs.filter((s) => s.x > h.valeur + 25 && RE_AMOUNT.test(s.text));
        if (!segs.length) return null;
        const s = segs[segs.length - 1];
        const side = Math.abs(s.end - h.debitEnd) <= Math.abs(s.end - h.creditEnd) ? 'debit' : 'credit';
        return { value: parseAmount(s.text), side };
      };
      const labelOf = (l) => l.segs.filter((s) => s.x >= h.nature - 4 && s.x < h.valeur - 4).map((s) => s.text).join(' ').trim();

      for (const l of lines) {
        if (l.y >= h.y - 1) continue; // en-tête et au-dessus
        if (/BNP PARIBAS SA au capital/i.test(l.text)) break; // pied de page
        const label = labelOf(l);
        const dateSeg = l.segs.find((s) => Math.abs(s.x - h.date) < 12 && RE_DAY.test(s.text));

        if (/^SOLDE (CREDITEUR|DEBITEUR) AU/i.test(label)) {
          const a = amountOf(l);
          const v = a ? (a.side === 'credit' ? a.value : -a.value) : null;
          if (totals) { closingBalance = v; finished = true; break; }
          openingBalance = v;
          current = null;
          continue;
        }
        if (/^TOTAL DES OPERATIONS/i.test(label)) {
          const amounts = l.segs.filter((s) => s.x > h.valeur + 25 && RE_AMOUNT.test(s.text));
          totals = { debit: 0, credit: 0 };
          amounts.forEach((s) => {
            const side = Math.abs(s.end - h.debitEnd) <= Math.abs(s.end - h.creditEnd) ? 'debit' : 'credit';
            totals[side] = parseAmount(s.text);
          });
          current = null;
          continue;
        }

        if (dateSeg) {
          const a = amountOf(l);
          const valSeg = l.segs.find((s) => Math.abs(s.x - h.valeur) < 20 && RE_DAY.test(s.text));
          if (!a) { warnings.push(`Montant illisible pour la ligne du ${dateSeg.text} : « ${label} »`); current = null; continue; }
          current = {
            date: resolveDay(dateSeg.text, period),
            valueDate: valSeg ? resolveDay(valSeg.text, period) : null,
            amount: a.value,
            type: a.side === 'credit' ? 'income' : 'expense',
            lines: [label],
          };
          ops.push(current);
        } else if (current && label && !totals) {
          current.lines.push(label);
        }
      }
    }

    // Identifiant stable par opération (date, sens, montant, libellé, rang) pour éviter les doublons à l'import.
    const occurrences = {};
    const operations = ops.map((o) => {
      const raw = o.lines.join(' ').replace(/\s+/g, ' ').trim();
      const d = describe(raw);
      const date = d.purchaseDate || o.date;
      const base = `${o.date}|${o.type}|${o.amount.toFixed(2)}|${raw.slice(0, 48)}`;
      occurrences[base] = (occurrences[base] || 0) + 1;
      const tokens = holder ? holder.toUpperCase().split(/\s+/).filter((t) => t.length > 1) : [];
      const party = (d.counterparty || '').toUpperCase();
      const own = tokens.length > 0 && tokens.every((t) => party.split(/[^A-ZÀ-Ü'\-]+/).includes(t));
      return {
        date, bookingDate: o.date,
        transfer: own ? (/\bOU\b/.test(party) ? 'joint' : 'own') : null, valueDate: o.valueDate, month: date.slice(0, 7),
        type: o.type, amount: round2(o.amount), raw,
        kind: d.kind, label: d.label, detail: d.detail, key: d.key,
        importKey: `bnp|${base}|${occurrences[base]}`,
      };
    });

    // Aller-retour : un virement vers soi-même et un virement opposé du même montant à moins de 10 jours
    // sont deux mouvements internes (ex. « TEMP » puis « TEMP RETOUR »).
    const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
    operations.filter((o) => o.transfer === 'own' && !o.roundtrip).forEach((o) => {
      const twin = operations.find((x) => x !== o && !x.roundtrip && x.transfer !== 'joint' && x.type !== o.type
        && x.amount === o.amount && /^vir-/.test(x.kind) && days(x.date, o.date) <= 10);
      if (twin) { twin.transfer = 'own'; twin.roundtrip = true; o.roundtrip = true; }
    });

    const sumSide = (t) => round2(operations.filter((o) => o.type === t).reduce((s, o) => s + o.amount, 0));
    const debit = sumSide('expense');
    const credit = sumSide('income');
    const check = {
      debit, credit,
      totalsFound: !!totals,
      ok: !!totals && Math.abs(totals.debit - debit) < 0.005 && Math.abs(totals.credit - credit) < 0.005,
      balanceOk: openingBalance != null && closingBalance != null
        ? Math.abs(round2(openingBalance + credit - debit) - closingBalance) < 0.005 : null,
    };
    if (!operations.length) warnings.push('Aucune opération trouvée. Ce PDF est-il bien un relevé de compte BNP Paribas ?');
    else if (!totals) warnings.push('Ligne « TOTAL DES OPERATIONS » introuvable : impossible de vérifier les montants.');
    else if (!check.ok) warnings.push(`Écart avec les totaux du relevé (débits lus ${debit} / ${totals.debit}, crédits lus ${credit} / ${totals.credit}). Vérifiez les lignes.`);

    return { bank: 'BNP Paribas', period, holder, openingBalance, closingBalance, totals, operations, check, warnings };
  }

  // ------------------------------------------------------------ libellés

  const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-'/*.])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()).trim();
  const between = (s, start, ends) => {
    const i = s.indexOf(start);
    if (i < 0) return '';
    const rest = s.slice(i + start.length);
    let cut = rest.length;
    for (const e of ends) { const j = rest.indexOf(e); if (j >= 0 && j < cut) cut = j; }
    return rest.slice(0, cut).trim();
  };
  const normKey = (s, words) => s.toUpperCase().replace(/[^A-Z0-9*& ]/g, ' ').split(/\s+/)
    .filter((w) => w && !/^\d+$/.test(w)).slice(0, words || 3).join(' ');

  function motifText(motif, fallback) {
    const m = (motif || '').replace(/\b(?=[0-9A-F]*\d)(?=[0-9A-F]*[A-F])[0-9A-F]{16,}\b/g, '').replace(/\bWERO\b/, '').replace(/\s+/g, ' ').trim();
    return m ? 'Motif : ' + m.toLowerCase() : fallback;
  }

  /** Transforme le libellé brut de la banque en libellé lisible + clé de contrepartie (pour les règles). */
  function describe(raw) {
    let s = raw.replace(/\b[A-Z]{3}\s+\d[\d ]*,\d{2}\s*EUR\b/g, ' ') // montant en devise d'origine
      .replace(/CARTE\s+\d{4}X+\d{4}/g, ' ').replace(/\s+/g, ' ').trim();
    let m;

    if ((m = s.match(/^(?:FACTURE\(S\)\s*)?DU\s+(\d{6})\s+(.+)$/))) {
      const merchant = m[2].trim();
      return { kind: 'card', label: titleCase(merchant), detail: 'Carte', purchaseDate: ddmmyyToIso(m[1]), key: 'CB:' + normKey(merchant, 2) };
    }
    if ((m = s.match(/^REMBOURST CB DU (\d{6}) (.+)$/))) {
      return { kind: 'card-refund', label: 'Remboursement ' + titleCase(m[2]), detail: 'Remboursement carte', purchaseDate: ddmmyyToIso(m[1]), key: 'CB:' + normKey(m[2], 2) };
    }
    if (/^RETRAIT DAB/.test(s)) {
      return { kind: 'cash', label: 'Retrait d\'espèces', detail: 'Distributeur', key: 'DAB' };
    }
    if ((m = s.match(/^PRLV SEPA (.+?)(?= ECH\/| ID EMETTEUR| MDT\/| REF\/| LIB\/|$)/))) {
      const creditor = m[1].replace(/\s+\d+$/, '');
      const lib = between(s, 'LIB/', [' MDT/', ' REF/', ' ID EMETTEUR']);
      return { kind: 'prlv', label: titleCase(creditor), detail: lib ? 'Prélèvement · ' + lib.toLowerCase() : 'Prélèvement', key: 'PRLV:' + normKey(creditor.replace(/\./g, ''), 3) };
    }
    if (/^VIR(?:EMENT)?(?: SEPA)?(?: INSTANT)?(?: CPTE A CPTE)? EMIS/.test(s)) {
      const motif = between(s, '/MOTIF', ['/BEN', '/REFDO', '/REF']);
      const ben = between(s, '/BEN', ['/REFDO', '/REFBEN', '/REF', '/MOTIF']);
      return { kind: 'vir-out', label: 'Virement à ' + titleCase(ben || 'tiers'), detail: motifText(motif, 'Virement émis'), key: 'VIR>' + normKey(ben, 4), counterparty: ben };
    }
    if (/^VIR(?:EMENT)?(?: SEPA)?(?: INSTANT)?(?: CPTE A CPTE)? RECU/.test(s)) {
      const from = between(s, '/DE', ['/MOTIF', '/REF']);
      const motif = between(s, '/MOTIF', ['/REF', '/DE']);
      return { kind: 'vir-in', label: 'Virement de ' + titleCase(from || 'tiers'), detail: motifText(motif, 'Virement reçu'), key: 'VIR<' + normKey(from, 4), counterparty: from };
    }
    if ((m = s.match(/^VIREMENT FAVEUR TIERS(?: VR\.PERMANENT)?\s*(.*)$/))) {
      return { kind: 'vir-permanent', label: titleCase(m[1] || 'Virement permanent'), detail: 'Virement permanent', key: 'VIRP:' + normKey(m[1] || 'PERMANENT', 3) };
    }
    if (/^REMISE CHEQUES?/.test(s)) return { kind: 'cheque-in', label: 'Remise de chèques', detail: 'Chèque', key: 'REMISE CHQ' };
    if ((m = s.match(/^CHEQUE N?°? ?(\d+)/))) return { kind: 'cheque-out', label: 'Chèque n° ' + m[1], detail: 'Chèque', key: 'CHQ' };
    if (/^RETROCESSION/.test(s)) return { kind: 'bank-fee', label: 'Remise sur frais bancaires', detail: titleCase(s.replace(/^RETROCESSION\s*-?\s*/, '')), key: 'FRAIS BANCAIRES' };
    if (/^\*?(COMMISSIONS?|COTISATION|FRAIS|AGIOS|INTERETS DEBITEURS)/.test(s)) {
      return { kind: 'bank-fee', label: 'Frais bancaires', detail: titleCase(s.replace(/^\*/, '')), key: 'FRAIS BANCAIRES' };
    }
    return { kind: 'other', label: titleCase(s.slice(0, 60)), detail: '', key: 'AUTRE:' + normKey(s, 3) };
  }

  // ------------------------------------------------------------ catégorisation

  /** Règles par défaut (ordre important : la première qui correspond l'emporte). */
  const DEFAULT_RULES = [
    { re: /PRELEVEMENT A LA SOURCE|IMPOT PAS/, category: 'Impôts & taxes', recurring: true },
    { re: /DGFIP|D\.G\.F\.I\.P|IMPOT|TRESOR PUBLIC|FINANCES PUBLIQUES/, category: 'Impôts & taxes' },
    { re: /SALAIRE|PAIE\b|PAYE\b/, category: 'Salaire', type: 'income', recurring: true },
    { re: /CAF\b|ALLOCATION|POLE EMPLOI|FRANCE TRAVAIL/, category: 'Allocations', type: 'income' },
    { re: /CPAM|AMELI|MUTUELLE|HARMONIE|MGEN|ALAN\b|PRESTATIONS|REMBOURSEMENT/, category: 'Remboursement', type: 'income' },
    { re: /CARREFOUR|LECLERC|AUCHAN|LIDL|ALDI|INTERMARCHE|MONOPRIX|FRANPRIX|CASINO|PICARD|SUPER U|HYPER U|BIOCOOP|NATURALIA|GRAND FRAIS|COLRUYT|CORA\b|MARKET|PRIMEUR/, category: 'Alimentation' },
    { re: /BOULANG|PAIN\b|BURGER|MCDO|MC DONALD|KFC|RESTAU|BRASSE|BISTRO|PIZZ|SUSHI|FRICHTI|UBER ?EATS|DELIVEROO|CAFE|STARBUCKS|CHOCOLAT/, category: 'Restaurants & sorties' },
    { re: /BASIC FIT|FITNESS|NEOMA|DECATHLON|CINEMA|UGC|PATHE|FNAC SPECTACLE|DISNEY|NINTENDO|STEAM|PLAYSTATION|VELO/, category: 'Loisirs' },
    { re: /BOUYGUES|ORANGE|SFR|FREE MOBILE|FREE TELECOM|SOSH|RED BY|NETFLIX|SPOTIFY|DEEZER|CANAL|AMAZON PRIME|DISNEY PLUS|APPLE\.COM|GOOGLE \*/, category: 'Abonnements' },
    { re: /EDF|ENGIE|TOTALENERGIES|VEOLIA|SUEZ|EAU DE|ENERCOOP|GRDF/, category: 'Énergie' },
    { re: /TOTAL\b|ESSO|SHELL|\bBP\b|AVIA|STATION|SNCF|RATP|NAVIGO|TRANSILIEN|QARE|UBER(?! ?EATS)|BOLT|BLABLACAR|PEAGE|AUTOROUTE|APRR|SANEF|VINCI|PARKING|GARAGE|NORAUTO|MIDAS|FEU VERT/, category: 'Transport' },
    { re: /AMAZON|FNAC|DARTY|BOULANGER|ZARA|H&M|UNIQLO|KIABI|IKEA|LEROY MERLIN|CASTORAMA|ACTION\b|CDISCOUNT|VINTED/, category: 'Shopping' },
    { re: /PHARMA|MEDECIN|DOCTEUR|DR\b|DOCTOLIB|EUROFINS|LABO|DENTISTE|OPTIC|KINE|HOPITAL|CLINIQUE/, category: 'Santé' },
    { re: /ASSURANCE|MAIF|MACIF|MAAF|MATMUT|AXA|ALLIANZ|GMF|GROUPAMA|CARDIF|HISCOX|LUKO/, category: 'Assurances', recurring: true },
    { re: /LOYER|FONCIA|NEXITY|SYNDIC|BAILLEUR|COPROPRIETE/, category: 'Logement', recurring: true },
    { re: /PRET|ECHEANCE|CREDIT|COFIDIS|CETELEM|SOFINCO/, category: 'Crédit', recurring: true },
    { re: /COIFF|BARBER/, category: 'Shopping' },
    { re: /CADEAU|ANNIV/, category: 'Cadeaux' },
  ];

  // Les mots-clés doivent commencer un mot : « STATION » ne doit pas trouver « PRESTATIONS ».
  const wordReCache = new Map();
  function wordRe(re) {
    if (!wordReCache.has(re)) wordReCache.set(re, new RegExp('(?<![A-Z0-9À-Ü])(?:' + re.source + ')', re.flags));
    return wordReCache.get(re);
  }

  /**
   * Propose catégorie / caractère fixe / exclusion pour une opération.
   * userRules : { [key]: { category, recurring, ignore } } appris lors des imports précédents.
   */
  function suggest(op, userRules) {
    const learned = userRules && userRules[op.key];
    if (learned) return { category: learned.category, recurring: !!learned.recurring, ignore: !!learned.ignore, learned: true };

    const text = (op.raw + ' ' + op.label).toUpperCase();
    let recurring = op.kind === 'prlv' || op.kind === 'vir-permanent';
    if (/SOLDE IMPOT|REGULARISATION/.test(text)) recurring = false;

    // Virement reçu de son propre compte (Livret A, LDDS…) : importé, mais exclu des prédictions de revenus.
    if (op.transfer === 'own' && !op.roundtrip && op.type === 'income') return { category: 'Virement depuis épargne', recurring: false, ignore: false };
    // Virement émis vers son propre compte (Livret A…) : importé comme versement d'épargne (hors dépenses dans le bilan).
    if (op.transfer === 'own' && !op.roundtrip && op.type === 'expense') return { category: 'Versement sur épargne', recurring, ignore: false };
    if (op.transfer === 'own') return { category: 'Virements internes', recurring: false, ignore: true };
    if (op.transfer === 'joint') return { category: 'Compte joint', recurring, ignore: false };
    if (op.type === 'income' && /LIVRET|\bLDDS?\b|\bLEP\b|EPARGNE/.test(text)) return { category: 'Virement depuis épargne', recurring: false, ignore: false };
    if (op.kind === 'bank-fee') return { category: op.type === 'income' ? 'Remboursement' : 'Frais bancaires', recurring: false, ignore: false };
    if (op.kind === 'cash') return { category: 'Retraits d\'espèces', recurring: false, ignore: false };
    if (op.kind === 'card-refund') return { category: 'Remboursement', recurring: false, ignore: false };

    for (const r of DEFAULT_RULES) {
      if ((r.type || 'expense') !== op.type) continue;
      if (wordRe(r.re).test(text)) return { category: r.category, recurring: r.recurring != null ? r.recurring || recurring : recurring, ignore: false };
    }
    if (op.type === 'income') return { category: 'Autre revenu', recurring: false, ignore: false };
    if (op.kind === 'vir-out') return { category: 'Virements', recurring, ignore: false };
    return { category: 'Autre', recurring, ignore: false };
  }

  const BnpImport = { extractPages, toLines, findHeader, parsePeriod, parseHolder, parseStatement, describe, suggest, DEFAULT_RULES };
  if (typeof module !== 'undefined' && module.exports) module.exports = BnpImport;
  else root.BnpImport = BnpImport;
})(typeof window !== 'undefined' ? window : globalThis);
