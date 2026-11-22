// Tests de l'import de bulletins de salaire, sur un bulletin FICTIF reproduisant la mise en page Silae
// (positions des colonnes du tableau récapitulatif identiques, montants et noms inventés).
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/payslip-import.js');

const CW = 4.5;
const item = (x, y, str) => ({ str, x, y, w: str.length * CW });
const line = (y, cells) => cells.map(([x, str]) => item(x, y, str));

function silaePage({ netMois = '2 150.40', netAnnuel = '19 870.10', pasBase = '2 150.40', periode = 'Période : Mars 2026' } = {}) {
  return [
    ...line(810, [[70, '0000000##BULLETIN##03-2026##0000000001##EXEMPLE##Alice##000000000']]),
    ...line(800, [[60, 'SOCIETE EXEMPLE SAS'], [330, 'BULLETIN DE SALAIRE']]),
    ...line(791, [[335, periode]]),
    ...line(546, [[54, 'Salaire brut'], [415, '2 800.00']]),
    ...line(268, [[54, 'Net à payer avant impôt sur le revenu'], [404, '2 100.00']]),
    ...line(258, [[54, 'Impôt sur le revenu prélevé à la source - PAS'], [271, pasBase], [311, '- 4.5000'], [370, '96.77']]),
    ...line(249, [[118, 'Taux personnalisé']]),
    ...line(239, [[54, 'Impôt sur le revenu : cumul PAS annuel'], [271, '290.31']]),
    ...line(230, [[54, 'Net payé'], [415, '2 003.23']]),
    ...line(98, [[73, 'Jours'], [190, 'Brut'], [238, 'Base S.S.'], [291, 'Plafond S.S.'], [345, 'Net imposable'], [402, 'Ch. patronales'], [466, 'Total versé']]),
    ...line(86, [[22, 'Mensuel'], [90, '21.00'], [195, '2 800.00'], [253, '2 800.00'], [310, '4 005.00'], [368, netMois], [426, '1 200.00'], [483, '4 000.00']]),
    ...line(74, [[24, 'Annuel'], [86, '63.00'], [191, '8 400.00'], [249, '8 400.00'], [306, '12 015.00'], [364, netAnnuel], [422, '3 600.00'], [479, '12 000.00']]),
  ];
}

test('bulletin Silae : mois, net imposable mensuel et cumul, prélèvement à la source', () => {
  const r = P.parsePayslip([{ items: silaePage() }]);
  assert.equal(r.month, '2026-03');
  assert.equal(r.netImposable, 2150.4);
  assert.equal(r.cumulNetImposable, 19870.1);
  assert.equal(r.method, 'tableau récapitulatif');
  assert.deepEqual(r.pas, { base: 2150.4, taux: 4.5, montant: 96.77, cumul: 290.31, type: 'personnalisé' });
  assert.equal(r.brut, 2800);
  assert.equal(r.netPaye, 2003.23);
  assert.ok(r.check.ok);
  assert.deepEqual(r.warnings, []);
});

test('le net imposable est différent du net payé (celui versé sur le compte)', () => {
  const r = P.parsePayslip([{ items: silaePage() }]);
  assert.notEqual(r.netImposable, r.netPaye);
});

test('incohérence avec la base du prélèvement à la source signalée', () => {
  const r = P.parsePayslip([{ items: silaePage({ pasBase: '2 999.99' }) }]);
  assert.equal(r.check.pasBaseMatches, false);
  assert.equal(r.check.ok, false);
  assert.ok(r.warnings.some((w) => /diffère/.test(w)));
});

test('autre format : « Net imposable » sur une ligne, période en dates, virgules décimales', () => {
  const items = [
    ...line(800, [[60, 'BULLETIN DE PAIE']]),
    ...line(790, [[60, 'Période du 01/12/2025 au 31/12/2025']]),
    ...line(300, [[60, 'Net imposable'], [400, '1 845,20']]),
    ...line(290, [[60, 'Cumul net imposable'], [400, '21 530,75']]),
    ...line(280, [[60, 'Prélèvement à la source'], [250, '1 845,20'], [320, '0,00 %'], [400, '0,00']]),
  ];
  const r = P.parsePayslip([{ items }]);
  assert.equal(r.month, '2025-12');
  assert.equal(r.netImposable, 1845.2);
  assert.equal(r.cumulNetImposable, 21530.75);
  assert.equal(r.pas.montant, 0);
});

test('un document qui n\'est pas un bulletin est signalé', () => {
  const r = P.parsePayslip([{ items: line(700, [[50, 'Facture EDF']]) }]);
  assert.equal(r.netImposable, null);
  assert.equal(r.check.ok, false);
  assert.ok(r.warnings.length >= 2);
});

test('projection annuelle : cumul du dernier bulletin + mois restants à la moyenne récente', () => {
  const slips = [
    { month: '2026-08', netImposable: 3000, cumulNetImposable: 24000, pas: { montant: 300, cumul: 2400, taux: 10 } },
    { month: '2026-09', netImposable: 3100, cumulNetImposable: 27100, pas: { montant: 310, cumul: 2710, taux: 10 } },
    { month: '2026-10', netImposable: 3200, cumulNetImposable: 30300, pas: { montant: 320, cumul: 3030, taux: 10 } },
    { month: '2025-12', netImposable: 9999, cumulNetImposable: 99999 }, // autre année : ignoré
  ];
  const p = P.projectYear(slips, 2026);
  assert.equal(p.count, 3);
  assert.equal(p.knownNet, 30300);
  assert.equal(p.remaining, 2);
  assert.equal(p.avgNet, 3100);
  assert.equal(p.netImposable, 36500);
  assert.equal(p.pas, 3030 + 2 * 310);
  assert.equal(p.taux, 10);
  assert.equal(P.projectYear(slips, 2024), null);
});

test('projection sans cumul : somme des bulletins importés', () => {
  const p = P.projectYear([{ month: '2026-01', netImposable: 2000 }, { month: '2026-02', netImposable: 2000 }], 2026);
  assert.equal(p.knownNet, 4000);
  assert.equal(p.remaining, 10);
  assert.equal(p.netImposable, 24000);
});
