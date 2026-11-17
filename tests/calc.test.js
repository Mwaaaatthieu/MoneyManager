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
