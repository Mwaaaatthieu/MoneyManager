/*
 * Moteur de calcul de MoneyManager — fonctions pures, sans accès au DOM.
 * Utilisable dans le navigateur (window.Calc) et dans Node (require) pour les tests.
 */
(function (root) {
  'use strict';

  // ---------- Mois (format "AAAA-MM") ----------

  function monthKey(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function addMonths(key, n) {
    const [y, m] = key.split('-').map(Number);
    const idx = y * 12 + (m - 1) + n;
    return Math.floor(idx / 12) + '-' + String((idx % 12) + 1).padStart(2, '0');
  }

  function monthsBetween(from, to) {
    const [y1, m1] = from.split('-').map(Number);
    const [y2, m2] = to.split('-').map(Number);
    return (y2 * 12 + m2) - (y1 * 12 + m1);
  }

  const round2 = (x) => Math.round(x * 100) / 100;
  const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);

  // ---------- Bilan mensuel ----------

  function monthSummary(entries, month) {
    const list = entries.filter((e) => e.month === month);
    const inc = list.filter((e) => e.type === 'income');
    const exp = list.filter((e) => e.type === 'expense');
    const income = sum(inc, (e) => e.amount);
    const expense = sum(exp, (e) => e.amount);
    const byCategory = {};
    exp.forEach((e) => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
    return {
      month,
      count: list.length,
      income: round2(income),
      expense: round2(expense),
      fixedExpense: round2(sum(exp.filter((e) => e.recurring), (e) => e.amount)),
      variableExpense: round2(sum(exp.filter((e) => !e.recurring), (e) => e.amount)),
      balance: round2(income - expense),
      savingsRate: income > 0 ? (income - expense) / income : null,
      byCategory,
    };
  }

  // ---------- Prévisions ----------

  /**
   * Fenêtre de référence : les mois (au plus `size`) précédant `current`
   * pour lesquels au moins une saisie existe, parmi les 6 derniers mois calendaires.
   * Si aucun, on prend les `size` mois saisis les plus récents avant `current`.
   */
  function referenceWindow(entries, current, size) {
    size = size || 6;
    const withData = new Set(entries.map((e) => e.month));
    const calendar = [];
    for (let i = 1; i <= size; i++) calendar.push(addMonths(current, -i));
    let win = calendar.filter((m) => withData.has(m));
    if (win.length === 0) {
      win = [...withData].filter((m) => m < current).sort().reverse().slice(0, size);
    }
    return win.sort();
  }

  function averages(entries, months) {
    const n = months.length;
    if (!n) return { recIncome: 0, varIncome: 0, recExpense: 0, varExpense: 0, months: [] };
    const set = new Set(months);
    const list = entries.filter((e) => set.has(e.month));
    const pick = (type, rec) => sum(list.filter((e) => e.type === type && !!e.recurring === rec), (e) => e.amount) / n;
    return {
      recIncome: round2(pick('income', true)),
      varIncome: round2(pick('income', false)),
      recExpense: round2(pick('expense', true)),
      varExpense: round2(pick('expense', false)),
      months,
    };
  }

  // ---------- Tendances et prédiction ----------

  /** Virements venant de l'épargne (Livret A, LDDS, LEP…) : ce ne sont pas des revenus. */
  const SAVINGS_RE = /livret|\bldds?\b|\blep\b|[ée]pargne/i;
  const SAVINGS_CATEGORY = 'Virement depuis épargne';

  /** L'opération est-elle écartée du calcul des tendances ? exclude = { expense: [catégories], income: [catégories] } */
  function isTrendExcluded(e, exclude) {
    const list = (exclude && exclude[e.type]) || [];
    if (list.includes(e.category)) return true;
    return e.type === 'income' && SAVINGS_RE.test((e.label || '') + ' ' + (e.category || ''));
  }

  /**
   * Prédit les revenus et dépenses du mois `target` à partir de l'historique antérieur à `current`.
   * - lignes fixes : dernier montant connu (si vues dans les 2 derniers mois de référence) ;
   * - lignes variables : moyenne par catégorie sur ≤ 6 mois, pondérée (le mois le plus récent compte le plus) ;
   * - + charges/revenus programmés du mois cible ; catégories exclues et virements d'épargne écartés.
   */
  function predictMonth(state, current, target, options) {
    options = options || {};
    const exclude = options.exclude || {};
    const entries = state.entries || [];
    const win = referenceWindow(entries, current, 6);
    const inWin = new Set(win);
    const used = entries.filter((e) => inWin.has(e.month));
    const kept = used.filter((e) => !isTrendExcluded(e, exclude));
    const excluded = used.filter((e) => isTrendExcluded(e, exclude));

    // Lignes fixes : somme par (sens, libellé) et par mois, on garde le mois le plus récent.
    const recent = new Set(win.slice(-2));
    const recByKey = {};
    kept.filter((e) => e.recurring && recent.has(e.month)).forEach((e) => {
      const key = e.type + '|' + String(e.label || e.category || '').trim().toLowerCase();
      const cur = recByKey[key];
      if (!cur || e.month > cur.month) recByKey[key] = { type: e.type, label: e.label, category: e.category, amount: e.amount, month: e.month };
      else if (e.month === cur.month) cur.amount += e.amount;
    });
    const recurringLines = Object.values(recByKey).map((l) => ({ ...l, amount: round2(l.amount) }))
      .sort((a, b) => b.amount - a.amount);

    // Lignes variables : moyenne pondérée par catégorie.
    const weights = {};
    win.forEach((m, i) => { weights[m] = i + 1; });
    const totalWeight = sum(win.map((m) => weights[m]));
    const variable = { income: {}, expense: {} };
    kept.filter((e) => !e.recurring).forEach((e) => {
      const bucket = variable[e.type];
      const cat = e.category || 'Autre';
      bucket[cat] = (bucket[cat] || 0) + (e.amount * weights[e.month]) / totalWeight;
    });

    const planned = (state.planned || []).filter((p) => p.month === target);
    const side = (type) => {
      const byCategory = {};
      recurringLines.filter((l) => l.type === type).forEach((l) => { const c = l.category || 'Autre'; byCategory[c] = (byCategory[c] || 0) + l.amount; });
      Object.entries(variable[type]).forEach(([c, v]) => { byCategory[c] = (byCategory[c] || 0) + v; });
      const pl = planned.filter((p) => (p.type === 'income' ? 'income' : 'expense') === type);
      pl.forEach((p) => { const c = p.category || 'Autre'; byCategory[c] = (byCategory[c] || 0) + p.amount; });
      Object.keys(byCategory).forEach((c) => { byCategory[c] = round2(byCategory[c]); });
      const fixed = round2(sum(recurringLines.filter((l) => l.type === type), (l) => l.amount));
      const vari = round2(sum(Object.values(variable[type])));
      const plannedSum = round2(sum(pl, (p) => p.amount));
      return { fixed, variable: vari, planned: plannedSum, total: round2(fixed + vari + plannedSum), byCategory };
    };
    const income = side('income');
    const expense = side('expense');
    return {
      month: target,
      window: win,
      income,
      expense,
      balance: round2(income.total - expense.total),
      recurringLines,
      plannedItems: planned,
      excluded: {
        count: excluded.length,
        savingsIncome: round2(sum(excluded.filter((e) => e.type === 'income'), (e) => e.amount) / (win.length || 1)),
        expense: round2(sum(excluded.filter((e) => e.type === 'expense'), (e) => e.amount) / (win.length || 1)),
      },
    };
  }

  /**
   * Projection sur `horizon` mois à partir de `current` (inclus), avec la même méthode que predictMonth.
   * options.includeVariable : intègre les dépenses/revenus variables ; options.exclude : catégories écartées.
   */
  function forecast(state, current, horizon, options) {
    options = options || {};
    const base = predictMonth({ ...state, planned: [] }, current, current, options);
    const avg = {
      recIncome: base.income.fixed, varIncome: base.income.variable,
      recExpense: base.expense.fixed, varExpense: base.expense.variable, months: base.window,
    };
    const planned = state.planned || [];
    const rows = [];
    let cumulative = 0;
    for (let i = 0; i < horizon; i++) {
      const month = addMonths(current, i);
      const p = planned.filter((x) => x.month === month);
      const plannedExpense = sum(p.filter((x) => x.type !== 'income'), (x) => x.amount);
      const plannedIncome = sum(p.filter((x) => x.type === 'income'), (x) => x.amount);
      const income = avg.recIncome + (options.includeVariable ? avg.varIncome : 0) + plannedIncome;
      const expense = avg.recExpense + (options.includeVariable ? avg.varExpense : 0) + plannedExpense;
      const savings = income - expense;
      cumulative += savings;
      rows.push({
        month,
        income: round2(income),
        expense: round2(expense),
        plannedExpense: round2(plannedExpense),
        plannedIncome: round2(plannedIncome),
        planned: p,
        savings: round2(savings),
        cumulative: round2(cumulative),
      });
    }
    return { window: base.window, averages: avg, rows };
  }

  /** Montant à mettre de côté chaque mois pour couvrir les charges programmées à venir. */
  function provisions(planned, current) {
    const items = (planned || [])
      .filter((p) => p.type !== 'income' && p.month >= current)
      .map((p) => {
        const months = monthsBetween(current, p.month) + 1;
        return { ...p, months, perMonth: round2(p.amount / months) };
      })
      .sort((a, b) => a.month.localeCompare(b.month));
    return { items, totalPerMonth: round2(sum(items, (i) => i.perMonth)) };
  }

  // ---------- Impôt sur le revenu (France) ----------

  /**
   * Paramètres par défaut : barème 2025 appliqué aux revenus 2024 (LFI 2025).
   * Tous modifiables dans l'application — à mettre à jour chaque année.
   */
  const DEFAULT_TAX_PARAMS = {
    label: 'Barème 2025 (revenus 2024)',
    brackets: [
      { upTo: 11497, rate: 0 },
      { upTo: 29315, rate: 0.11 },
      { upTo: 83823, rate: 0.30 },
      { upTo: 180294, rate: 0.41 },
      { upTo: null, rate: 0.45 },
    ],
    abattementMin: 504,
    abattementMax: 14426,
    plafondDemiPart: 1791,
    decoteSingle: 889,
    decoteCouple: 1470,
    decoteRate: 0.4525,
    seuilRecouvrement: 61,
    repasForfait: 5.35, // valeur d'un repas pris au domicile
    repasPlafond: 20.70, // plafond du coût d'un repas retenu
    teletravailJour: 2.70,
    teletravailPlafond: 659.70,
  };

  /** Barème kilométrique automobile (frais réels) — revenus 2024. */
  const BAREME_KM = {
    3: [[0.529, 0], [0.316, 1065], [0.370, 0]],
    4: [[0.606, 0], [0.340, 1330], [0.407, 0]],
    5: [[0.636, 0], [0.357, 1395], [0.427, 0]],
    6: [[0.665, 0], [0.374, 1457], [0.447, 0]],
    7: [[0.697, 0], [0.394, 1515], [0.470, 0]],
  };

  function kmAllowance(cv, km, electric) {
    if (!km || km <= 0) return 0;
    const c = Math.min(7, Math.max(3, Math.round(cv || 3)));
    const t = BAREME_KM[c];
    const [a, b] = km <= 5000 ? t[0] : km <= 20000 ? t[1] : t[2];
    const v = km * a + b;
    return round2(electric ? v * 1.2 : v);
  }

  function abattement10(netImposable, params) {
    if (!netImposable || netImposable <= 0) return 0;
    const raw = netImposable * 0.1;
    const v = Math.min(params.abattementMax, Math.max(params.abattementMin, raw));
    return round2(Math.min(v, netImposable));
  }

  function fraisReels(input, params) {
    const i = input || {};
    const km = kmAllowance(i.cv, (i.kmJour || 0) * 2 * (i.joursTrajet || 0) + (i.kmAutres || 0), i.electric);
    const coutRetenu = Math.min(i.coutRepas || 0, params.repasPlafond);
    const repas = round2(Math.max(0, coutRetenu - params.repasForfait) * (i.nbRepas || 0));
    const teletravail = round2(Math.min((i.joursTeletravail || 0) * params.teletravailJour, params.teletravailPlafond));
    const autres = round2(sum(i.autres || [], (x) => Number(x.amount) || 0));
    return { km, repas, teletravail, autres, total: round2(km + repas + teletravail + autres) };
  }

  function baremeImpot(revenuParPart, brackets) {
    let impot = 0;
    let prev = 0;
    for (const b of brackets) {
      const top = b.upTo == null ? Infinity : b.upTo;
      if (revenuParPart > prev) impot += (Math.min(revenuParPart, top) - prev) * b.rate;
      prev = top;
    }
    return impot;
  }

  /**
   * Impôt brut après quotient familial (avec plafonnement) et décote.
   * couple : true si déclaration commune (2 parts de base).
   */
  function impotRevenu(revenuImposable, parts, couple, params) {
    const R = Math.max(0, revenuImposable);
    const baseParts = couple ? 2 : 1;
    const p = Math.max(baseParts, parts || baseParts);
    const avecQF = baremeImpot(R / p, params.brackets) * p;
    const sansQF = baremeImpot(R / baseParts, params.brackets) * baseParts;
    const demiParts = Math.round((p - baseParts) * 2);
    const plafonne = sansQF - demiParts * params.plafondDemiPart;
    let impot = Math.max(avecQF, plafonne);
    const plafonnementApplique = plafonne > avecQF;

    const forfait = couple ? params.decoteCouple : params.decoteSingle;
    const seuil = forfait / params.decoteRate;
    let decote = 0;
    if (impot < seuil) decote = Math.max(0, Math.min(impot, forfait - params.decoteRate * impot));
    impot -= decote;
    const nonRecouvre = impot > 0 && impot < params.seuilRecouvrement;
    if (nonRecouvre) impot = 0;
    return {
      impot: Math.round(impot),
      decote: Math.round(decote),
      plafonnementApplique,
      nonRecouvre,
      tmi: marginalRate(R / p, params.brackets),
    };
  }

  function marginalRate(revenuParPart, brackets) {
    let prev = 0;
    for (const b of brackets) {
      const top = b.upTo == null ? Infinity : b.upTo;
      if (revenuParPart <= top && revenuParPart >= prev) return b.rate;
      prev = top;
    }
    return brackets[brackets.length - 1].rate;
  }

  /**
   * Simulation complète du foyer.
   * tax = { couple, parts, autresRevenus, declarants: [{ netImposable, frais: {...}, forceMode }],
   *         tauxPAS (%), dejaPreleve (optionnel), params }
   */
  function simulateTax(tax) {
    const params = { ...DEFAULT_TAX_PARAMS, ...(tax.params || {}) };
    const declarants = (tax.declarants || []).slice(0, tax.couple ? 2 : 1).map((d) => {
      const net = Number(d.netImposable) || 0;
      const abat = abattement10(net, params);
      const fr = fraisReels(d.frais, params);
      const best = fr.total > abat ? 'reels' : 'forfait';
      const mode = d.forceMode === 'reels' || d.forceMode === 'forfait' ? d.forceMode : best;
      const deduction = mode === 'reels' ? Math.min(fr.total, net) : abat;
      return {
        netImposable: net,
        abattement: abat,
        fraisReels: fr,
        best,
        mode,
        gain: round2(Math.abs(fr.total - abat)),
        deduction: round2(deduction),
        imposable: round2(net - deduction),
      };
    });
    const totalNet = sum(declarants, (d) => d.netImposable);
    const revenuImposable = sum(declarants, (d) => d.imposable) + (Number(tax.autresRevenus) || 0);
    const res = impotRevenu(revenuImposable, Number(tax.parts) || (tax.couple ? 2 : 1), !!tax.couple, params);

    const assiettePAS = totalNet + (Number(tax.autresRevenus) || 0);
    const tauxIdeal = assiettePAS > 0 ? res.impot / assiettePAS : 0;
    const tauxPAS = (Number(tax.tauxPAS) || 0) / 100;
    const hasDeja = tax.dejaPreleve !== '' && tax.dejaPreleve != null && !isNaN(Number(tax.dejaPreleve));
    const preleve = hasDeja ? Number(tax.dejaPreleve) : assiettePAS * tauxPAS;
    const regularisation = res.impot - preleve;

    return {
      params,
      declarants,
      revenuImposable: round2(revenuImposable),
      ...res,
      assiettePAS: round2(assiettePAS),
      tauxIdeal, // à arrondir à 0,1 point pour le taux personnalisé
      tauxIdealArrondi: Math.ceil(tauxIdeal * 1000) / 10,
      preleve: round2(preleve),
      regularisation: round2(regularisation), // > 0 : à payer ; < 0 : remboursement
    };
  }

  const Calc = {
    monthKey, addMonths, monthsBetween, round2,
    monthSummary, referenceWindow, averages, forecast, provisions,
    predictMonth, isTrendExcluded, SAVINGS_CATEGORY,
    DEFAULT_TAX_PARAMS, BAREME_KM, kmAllowance, abattement10, fraisReels,
    baremeImpot, impotRevenu, simulateTax,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof window !== 'undefined' ? window : globalThis);
