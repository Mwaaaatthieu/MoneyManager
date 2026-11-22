const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');
const P = C.DEFAULT_TAX_PARAMS;

test('gestion des mois', () => {
  assert.equal(C.addMonths('2026-11', 2), '2027-01');
  assert.equal(C.addMonths('2026-01', -1), '2025-12');
  assert.equal(C.monthsBetween('2026-11', '2027-09'), 10);
});

test('bilan mensuel', () => {
  const entries = [
    { month: '2026-10', type: 'income', amount: 2500, recurring: true },
    { month: '2026-10', type: 'expense', amount: 800, recurring: true, category: 'Logement' },
    { month: '2026-10', type: 'expense', amount: 200, recurring: false, category: 'Loisirs' },
  ];
  const s = C.monthSummary(entries, '2026-10');
  assert.equal(s.balance, 1500);
  assert.equal(s.fixedExpense, 800);
  assert.equal(s.variableExpense, 200);
  assert.equal(s.savingsRate, 0.6);
});

test('prévision : moyenne des 6 mois saisis + charges programmées', () => {
  const entries = [];
  for (let i = 1; i <= 8; i++) {
    const m = C.addMonths('2026-11', -i);
    entries.push({ month: m, type: 'income', amount: 3000, recurring: true });
    // loyer qui change : 1000 sur les 6 derniers mois, 2000 avant
    entries.push({ month: m, type: 'expense', amount: i <= 6 ? 1000 : 2000, recurring: true });
    entries.push({ month: m, type: 'expense', amount: 300, recurring: false });
  }
  const planned = [{ month: '2026-12', type: 'expense', amount: 1200, label: 'Taxe foncière' }];
  const f = C.forecast({ entries, planned }, '2026-11', 3, { includeVariable: false });
  assert.equal(f.window.length, 6);
  assert.equal(f.rows[0].savings, 2000);
  assert.equal(f.rows[1].savings, 800);
  assert.equal(f.rows[2].cumulative, 4800);
  const fv = C.forecast({ entries, planned }, '2026-11', 1, { includeVariable: true });
  assert.equal(fv.rows[0].savings, 1700);
});

test('provisions mensuelles', () => {
  const p = C.provisions([{ month: '2027-09', type: 'expense', amount: 1100 }], '2026-11');
  assert.equal(p.items[0].months, 11);
  assert.equal(p.totalPerMonth, 100);
});

test('abattement 10 % borné', () => {
  assert.equal(C.abattement10(30000, P), 3000);
  assert.equal(C.abattement10(3000, P), 504);
  assert.equal(C.abattement10(200000, P), 14426);
});

test('barème kilométrique', () => {
  assert.equal(C.kmAllowance(5, 4000), 2544);
  assert.equal(C.kmAllowance(5, 10000), 4965);
  assert.equal(C.kmAllowance(5, 25000), 10675);
  assert.equal(C.kmAllowance(5, 10000, true), 5958);
});

test('impôt : célibataire 30 000 € imposables', () => {
  // (29315-11497)*0.11 + (30000-29315)*0.30 = 1959.98 + 205.5 = 2165.48
  const r = C.impotRevenu(30000, 1, false, P);
  assert.equal(r.impot, 2165);
  assert.equal(r.tmi, 0.30);
});

test('impôt : décote', () => {
  // 20000 → (20000-11497)*0.11 = 935.33 ; décote = 889 - 0.4525*935.33 = 465.76
  const r = C.impotRevenu(20000, 1, false, P);
  assert.equal(r.impot, 470);
});

test('impôt : plafonnement du quotient familial', () => {
  const sans = C.impotRevenu(150000, 2, true, P).impot;
  const avec = C.impotRevenu(150000, 3, true, P);
  assert.ok(avec.plafonnementApplique);
  assert.equal(avec.impot, sans - 2 * 1791);
});

test('simulation : frais réels plus avantageux et régularisation', () => {
  const sim = C.simulateTax({
    couple: false, parts: 1, tauxPAS: 5,
    declarants: [{ netImposable: 30000, frais: { cv: 5, kmJour: 40, joursTrajet: 210 } }],
  });
  const d = sim.declarants[0];
  assert.equal(d.best, 'reels'); // 16 800 km → 0.357*16800+1395 = 7392.6 > 3000
  assert.equal(d.imposable, 30000 - 7392.6);
  assert.equal(sim.preleve, 1500);
  assert.ok(sim.regularisation > 0 === (sim.impot > 1500));
  assert.ok(sim.tauxIdealArrondi >= sim.impot / 30000 * 100);
});

// ---------- prédiction mensuelle (tendances) ----------
function history() {
  const e = [];
  const add = (month, type, label, category, amount, recurring) => e.push({ month, type, label, category, amount, recurring });
  // 6 mois de référence : mai → octobre 2026 ; mois courant = décembre (novembre, le mois précédent, est ignoré)
  ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((m, i) => {
    add(m, 'income', 'Salaire', 'Salaire', 3000, true);
    add(m, 'expense', 'Loyer', 'Logement', i < 5 ? 800 : 850, true); // loyer augmenté en octobre
    add(m, 'expense', 'Courses', 'Alimentation', 300 + i * 30, false); // tendance à la hausse : 300 → 450
    add(m, 'expense', 'Vacances', 'Loisirs', i === 2 ? 1200 : 0, false);
  });
  add('2026-09', 'income', 'Virement Livret A', 'Autre revenu', 1000, false); // libellé seul : PAS exclu
  add('2026-10', 'income', 'Virement de M. X', 'Virement depuis épargne', 500, false);
  add('2026-10', 'income', 'Vente Vinted', 'Autre revenu', 60, false);
  // mois précédent (novembre), incomplet : ne doit pas compter
  add('2026-11', 'expense', 'Courses', 'Alimentation', 5000, false);
  add('2026-11', 'income', 'Salaire', 'Salaire', 9999, true);
  return e;
}

test('prédiction : lignes fixes au dernier montant connu', () => {
  const p = C.predictMonth({ entries: history(), planned: [] }, '2026-12', '2026-12');
  assert.equal(p.window.length, 6);
  assert.equal(p.income.fixed, 3000);
  assert.equal(p.expense.byCategory.Logement, 850);
});

test('prédiction : moyenne pondérée des variables (tendance)', () => {
  const p = C.predictMonth({ entries: history(), planned: [] }, '2026-12', '2026-12');
  // courses : Σ(i+1)(300+30i)/21 = 8400/21 = 400 > moyenne simple 375
  assert.equal(p.expense.byCategory.Alimentation, 400);
  // vacances de juillet (poids 3/21)
  assert.equal(p.expense.byCategory.Loisirs, 171.43);
});

test('prédiction : le mois précédent celui en cours est ignoré', () => {
  const p = C.predictMonth({ entries: history(), planned: [] }, '2026-12', '2026-12');
  assert.deepEqual(p.window, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(p.skippedMonth, '2026-11');
  assert.equal(p.income.fixed, 3000);
});

test('prédiction : revenus ignorés uniquement selon la liste de catégories', () => {
  const ex = { income: [C.SAVINGS_CATEGORY] };
  const p = C.predictMonth({ entries: history(), planned: [] }, '2026-12', '2026-12', { exclude: ex });
  // « Virement Livret A » classé en Autre revenu reste compté (pas de détection par libellé) :
  // 1000×5/21 + 60×6/21 = 255,24 ; le virement en catégorie « Virement depuis épargne » est exclu
  assert.equal(p.income.variable, 255.24);
  assert.equal(p.excluded.count, 1);
  const all = C.predictMonth({ entries: history(), planned: [] }, '2026-12', '2026-12', { exclude: { income: [C.SAVINGS_CATEGORY, 'Autre revenu'] } });
  assert.equal(all.income.variable, 0);
});

test('prédiction : catégories de dépenses exclues et charges programmées', () => {
  const state = { entries: history(), planned: [{ month: '2026-12', type: 'expense', label: 'Taxe', category: 'Impôts & taxes', amount: 900 }] };
  const p = C.predictMonth(state, '2026-12', '2026-12', { exclude: { expense: ['Loisirs'] } });
  assert.equal(p.expense.byCategory.Loisirs, undefined);
  assert.equal(p.expense.planned, 900);
  assert.equal(p.expense.total, 850 + 400 + 900);
  assert.equal(p.balance, C.round2(p.income.total - p.expense.total));
});

test('prévisions 12 mois : mêmes exclusions que la prédiction mensuelle', () => {
  const f = C.forecast({ entries: history(), planned: [] }, '2026-12', 2, { includeVariable: true, exclude: { expense: ['Loisirs'] } });
  const p = C.predictMonth({ entries: history(), planned: [] }, '2026-12', '2026-12', { exclude: { expense: ['Loisirs'] } });
  assert.equal(f.rows[0].savings, p.balance);
});

// ---------- frais de repas ----------
test('repas : valeur du repas au foyer selon l\'année, modifiable', () => {
  assert.equal(C.repasFoyer(2024, P), 5.35);
  assert.equal(C.repasFoyer(2026, P), 5.5);
  assert.equal(C.repasFoyer(2031, P), 5.5); // année future : dernière valeur connue
  assert.equal(C.repasFoyer(2026, { ...P, repasForfait: 5.6 }), 5.6);
});

test('repas préparés à domicile sans justificatif : forfait par repas', () => {
  const fr = C.fraisReels({ nbRepasMaison: 218 }, { ...P, year: 2026 });
  assert.equal(fr.repas, 1199); // 218 × 5,50
  assert.equal(fr.repasDetail.maison.parRepas, 5.5);
});

test('repas achetés avec justificatifs : (prix − valeur au foyer − part employeur), prix plafonné', () => {
  const p26 = { ...P, year: 2026 };
  assert.equal(C.fraisReels({ nbRepas: 218, coutRepas: 12 }, p26).repas, 1417); // 218 × 6,50
  assert.equal(C.fraisReels({ nbRepas: 100, coutRepas: 12, partEmployeur: 4.5 }, p26).repas, 200); // 100 × 2,00
  const cher = C.fraisReels({ nbRepas: 10, coutRepas: 30 }, p26);
  assert.ok(cher.repasDetail.achetes.plafonne);
  assert.equal(cher.repas, C.round2(10 * (20.70 - 5.5)));
});

test('repas : prix saisi trop bas signalé (le cas des 33 €)', () => {
  const fr = C.fraisReels({ nbRepas: 218, coutRepas: 5.5 }, { ...P, year: 2026 });
  assert.equal(fr.repas, 0);
  assert.ok(fr.repasDetail.prixTropBas);
});

test('repas : les deux types se cumulent et la simulation utilise l\'année', () => {
  const sim = C.simulateTax({ year: 2026, couple: false, parts: 1,
    declarants: [{ netImposable: 30000, frais: { nbRepasMaison: 150, nbRepas: 68, coutRepas: 12 } }] });
  assert.equal(sim.declarants[0].fraisReels.repas, C.round2(150 * 5.5 + 68 * 6.5));
});

// ---------- épargne (Livret A) dans le bilan ----------
test('bilan : versements et retraits du Livret A sortis des dépenses et revenus, épargne réelle', () => {
  const entries = [
    { month: '2026-10', type: 'income', category: 'Salaire', amount: 3000 },
    { month: '2026-10', type: 'income', category: 'Virement depuis épargne', amount: 200 },
    { month: '2026-10', type: 'expense', category: 'Logement', amount: 900 },
    { month: '2026-10', type: 'expense', category: 'Versement sur épargne', amount: 700 },
    { month: '2026-09', type: 'expense', category: 'Versement sur épargne', amount: 999 },
  ];
  const s = C.savingsSummary(entries, '2026-10');
  assert.equal(s.income, 3000);
  assert.equal(s.expense, 900);
  assert.equal(s.deposits, 700);
  assert.equal(s.withdrawals, 200);
  assert.equal(s.savings, 500);
  assert.equal(s.balance, 2100);
  assert.equal(s.realSavingsRate, 500 / 3000);
  assert.equal(s.byCategory['Versement sur épargne'], undefined);
  // catégories personnalisées ; retrait supérieur aux versements → épargne négative
  const t = C.savingsSummary(entries, '2026-10', { expense: [], income: ['Virement depuis épargne'] });
  assert.equal(t.expense, 1600);
  assert.equal(t.savings, -200);
});
