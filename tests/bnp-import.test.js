// Tests de l'import de relevés BNP Paribas, sur un relevé FICTIF reconstitué
// (positions des colonnes identiques au format réel, données inventées).
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../js/bnp-import.js');

const CHAR_W = 5;
/** Construit les éléments de texte d'une ligne : [[x, "texte"], ...] → mots positionnés. */
function line(y, cells) {
  const items = [];
  for (const [x0, text] of cells) {
    let x = x0;
    for (const word of text.split(' ')) {
      items.push({ str: word, x, y, w: word.length * CHAR_W });
      x += word.length * CHAR_W + 3;
    }
  }
  return items;
}
// Colonnes : Date 28 · Nature 68 · Valeur 307 · Débit (fin 446) · Crédit (fin 546)
const right = (end, text) => [end - text.length * CHAR_W, text];
const op = (y, date, label, valeur, amount, side) => line(y, [[28, date], [68, label], [312, valeur], right(side === 'D' ? 446 : 546, amount)]);
const header = (y) => line(y, [[29, 'Date'], [68, 'Nature des opérations'], [307, 'Valeur'], [420, 'Débit'], [516, 'Crédit']]);

const page1 = [
  ...line(822, [[210, 'RELEVE DE COMPTE CHEQUES']]),
  ...line(810, [[268, 'du 20 décembre 2025 au 20 janvier 2026']]),
  ...line(773, [[346, 'MME DUPONT CLAIRE']]),
  ...header(729),
  ...line(715, [[68, 'SOLDE CREDITEUR AU 20.12.2025'], right(546, '1 000,00')]),
  ...op(700, '22.12', 'FACTURE(S) CARTE 0000XXXXXXXX1234', '22.12', '42,10', 'D'),
  ...line(690, [[68, 'DU 201225 CARREFOUR CITY PARIS']]),
  ...op(680, '22.12', 'DU 211225 STATION TOTAL LYON', '22.12', '60,00', 'D'),
  ...op(670, '28.12', 'PRLV SEPA FREE MOBILE ECH/281225 ID', '28.12', '19,99', 'D'),
  ...line(660, [[68, 'EMETTEUR/FR00ZZZ000000 MDT/ABC REF/XYZ']]),
  ...line(650, [[68, 'LIB/FORFAIT MOBILE']]),
  ...op(640, '30.12', 'VIR SEPA RECU /DE SOCIETE EXEMPLE SAS', '30.12', '2 500,00', 'C'),
  ...line(630, [[68, '/MOTIF SALAIRE DECEMBRE /REF 123']]),
  ...line(400, [[20, 'BNP PARIBAS SA au capital de 2 203 201 214 € - Siège social']]),
  ...line(390, [[480, '000000000000']]),
];
const page2 = [
  ...header(729),
  ...op(711, '05.01', 'VIR SEPA INSTANT EMIS /MOTIF EPARGNE', '05.01', '300,00', 'D'),
  ...line(701, [[68, '/BEN DUPONT CLAIRE /REFDO']]),
  ...line(691, [[68, 'ABCDEF0123456789ABCDEF0123456789 /REFBEN']]),
  ...op(680, '06.01', 'VIR SEPA INSTANT RECU /DE MME DUPONT', '06.01', '300,00', 'C'),
  ...line(670, [[68, 'CLAIRE /MOTIF RETOUR']]),
  ...op(660, '06.01', 'VIR SEPA INSTANT RECU /DE MUTUELLE XYZ', '06.01', '12,00', 'C'),
  ...line(650, [[68, 'PRESTATIONS /MOTIF REGLEMENT']]),
  ...op(640, '07.01', 'VIREMENT FAVEUR TIERS VR.PERMANENT', '07.01', '650,00', 'D'),
  ...line(630, [[68, 'LOYER APPARTEMENT']]),
  ...op(620, '08.01', '*COMMISSIONS COTISATION A UNE OFFRE', '08.01', '8,00', 'D'),
  ...line(600, [[68, 'TOTAL DES OPERATIONS'], right(446, '1 080,09'), right(546, '2 812,00')]),
  ...line(590, [[68, 'SOLDE CREDITEUR AU 20.01.2026'], right(546, '2 731,91')]),
  ...line(560, [[68, '* Commissions sur services et opérations bancaires. Total : +8,00']]),
];

const st = B.parseStatement([{ items: page1 }, { items: page2 }]);
const byLabel = (re) => st.operations.find((o) => re.test(o.label));

test('période, titulaire, soldes et contrôle des totaux', () => {
  assert.deepEqual(st.period, { from: '2025-12-20', to: '2026-01-20' });
  assert.equal(st.holder, 'DUPONT CLAIRE');
  assert.equal(st.openingBalance, 1000);
  assert.equal(st.closingBalance, 2731.91);
  assert.equal(st.operations.length, 9);
  assert.ok(st.check.ok, JSON.stringify(st.check));
  assert.ok(st.check.balanceOk);
  assert.deepEqual(st.warnings, []);
});

test('le pied de page et les références ne polluent pas les libellés', () => {
  const sal = byLabel(/Societe Exemple/);
  assert.ok(!/BNP PARIBAS|000000000000/.test(sal.raw), sal.raw);
});

test('opérations carte : commerçant et date d\'achat (année déduite à cheval sur 2 ans)', () => {
  const c = byLabel(/Carrefour/);
  assert.equal(c.kind, 'card');
  assert.equal(c.label, 'Carrefour City Paris');
  assert.equal(c.date, '2025-12-20');
  assert.equal(c.type, 'expense');
  assert.equal(c.amount, 42.1);
  const v = st.operations.find((o) => o.bookingDate === '2026-01-05');
  assert.equal(v.month, '2026-01');
});

test('prélèvements, virements et frais', () => {
  const free = byLabel(/Free Mobile/);
  assert.equal(free.kind, 'prlv');
  assert.match(free.detail, /forfait mobile/);
  const sal = byLabel(/Societe Exemple/);
  assert.equal(sal.type, 'income');
  assert.equal(sal.amount, 2500);
  assert.equal(byLabel(/Loyer/).kind, 'vir-permanent');
  assert.equal(byLabel(/Frais bancaires/).amount, 8);
});

test('virements entre ses propres comptes repérés (aller et retour)', () => {
  const out = st.operations.find((o) => o.kind === 'vir-out');
  const back = st.operations.find((o) => o.kind === 'vir-in' && o.amount === 300);
  assert.equal(out.transfer, 'own');
  assert.equal(back.transfer, 'own');
  assert.ok(!/ABCDEF0123/.test(out.detail));
  assert.equal(B.suggest(out, {}).ignore, true);
});

test('catégorisation par défaut', () => {
  const cat = (re) => B.suggest(byLabel(re), {});
  assert.equal(cat(/Carrefour/).category, 'Alimentation');
  assert.equal(cat(/Total Lyon/).category, 'Transport');
  assert.equal(cat(/Free Mobile/).category, 'Abonnements');
  assert.equal(cat(/Free Mobile/).recurring, true);
  assert.equal(cat(/Societe Exemple/).category, 'Salaire');
  assert.equal(cat(/Loyer/).category, 'Logement');
  assert.equal(cat(/Frais bancaires/).category, 'Frais bancaires');
  // « PRESTATIONS » ne doit pas être pris pour « STATION » (carburant)
  assert.equal(cat(/Mutuelle Xyz/).category, 'Remboursement');
});

test('les règles apprises priment', () => {
  const c = byLabel(/Carrefour/);
  const s = B.suggest(c, { [c.key]: { category: 'Courses', recurring: false, ignore: false } });
  assert.equal(s.category, 'Courses');
  assert.ok(s.learned);
});

test('identifiants d\'import stables et uniques', () => {
  const again = B.parseStatement([{ items: page1 }, { items: page2 }]);
  assert.deepEqual(again.operations.map((o) => o.importKey), st.operations.map((o) => o.importKey));
  assert.equal(new Set(st.operations.map((o) => o.importKey)).size, st.operations.length);
});

test('un PDF qui n\'est pas un relevé est signalé', () => {
  const r = B.parseStatement([{ items: line(700, [[50, 'Facture EDF n° 123']]) }]);
  assert.equal(r.operations.length, 0);
  assert.ok(r.warnings.length > 0);
});

test('virement reçu de son propre compte (Livret A) : importé comme « Virement depuis épargne »', () => {
  const extra = [
    ...header(729),
    ...op(711, '10.01', 'VIR CPTE A CPTE RECU /DE MME DUPONT CLAIRE', '10.01', '150,00', 'C'),
    ...line(701, [[68, '/MOTIF COMPLEMENT']]),
    ...op(690, '11.01', 'VIR SEPA RECU /DE BANQUE EXEMPLE', '11.01', '40,00', 'C'),
    ...line(680, [[68, '/MOTIF VIREMENT LIVRET A']]),
    ...line(600, [[68, 'TOTAL DES OPERATIONS'], right(546, '190,00')]),
  ];
  const r = B.parseStatement([{ items: [...line(810, [[268, 'du 01 janvier 2026 au 31 janvier 2026']]), ...line(773, [[346, 'MME DUPONT CLAIRE']]), ...extra] }]);
  assert.equal(r.operations.length, 2);
  const own = r.operations[0];
  assert.equal(own.transfer, 'own');
  assert.ok(!own.roundtrip);
  assert.deepEqual(B.suggest(own, {}), { category: 'Virement depuis épargne', recurring: false, ignore: false });
  assert.equal(B.suggest(r.operations[1], {}).category, 'Virement depuis épargne');
  // l'aller-retour du relevé principal reste ignoré
  const back = st.operations.find((o) => o.kind === 'vir-in' && o.amount === 300);
  assert.ok(back.roundtrip);
  assert.equal(B.suggest(back, {}).ignore, true);
});

test('virement émis vers son propre compte (Livret A) : importé comme « Versement sur épargne »', () => {
  const items = [
    ...line(810, [[268, 'du 01 février 2026 au 28 février 2026']]),
    ...line(773, [[346, 'MME DUPONT CLAIRE']]),
    ...header(729),
    ...op(711, '03.02', 'VIR CPTE A CPTE EMIS /MOTIF LIVRET A', '03.02', '400,00', 'D'),
    ...line(701, [[68, '/BEN MME DUPONT CLAIRE']]),
    ...line(600, [[68, 'TOTAL DES OPERATIONS'], right(446, '400,00')]),
  ];
  const r = B.parseStatement([{ items }]);
  assert.equal(r.operations.length, 1);
  assert.equal(r.operations[0].transfer, 'own');
  assert.deepEqual(B.suggest(r.operations[0], {}), { category: 'Versement sur épargne', recurring: false, ignore: false });
});
