/* MoneyManager — interface. Données stockées localement (localStorage), aucune API. */
(function () {
  'use strict';
  const C = window.Calc;
  const KEY = 'moneymanager.v1';

  const DEFAULT_CATS = {
    expense: ['Logement', 'Alimentation', 'Transport', 'Énergie', 'Assurances', 'Abonnements', 'Santé',
      'Loisirs', 'Restaurants & sorties', 'Shopping', 'Enfants', 'Impôts & taxes', 'Crédit', 'Cadeaux',
      'Frais bancaires', 'Retraits d\'espèces', 'Virements', 'Compte joint', 'Virements internes', 'Autre'],
    income: ['Salaire', 'Prime', 'Allocations', 'Remboursement', 'Revenus locatifs', 'Autre revenu'],
  };

  // ---------------------------------------------------------------- état

  function blankDeclarant() {
    return {
      netImposable: '', forceMode: 'auto',
      frais: { cv: 5, electric: false, kmJour: '', joursTrajet: '', kmAutres: '', nbRepas: '', coutRepas: '',
        joursTeletravail: '', autres: [] },
    };
  }
  function defaultTax() {
    return {
      year: new Date().getFullYear(), couple: false, parts: 1, tauxPAS: '', dejaPreleve: '', autresRevenus: '',
      declarants: [blankDeclarant(), blankDeclarant()],
      params: JSON.parse(JSON.stringify(C.DEFAULT_TAX_PARAMS)),
    };
  }
  function defaultState() {
    return { version: 1, entries: [], planned: [], importRules: {}, settings: { includeVariable: true, theme: 'auto' }, tax: defaultTax() };
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      const d = defaultState();
      return {
        ...d, ...s,
        settings: { ...d.settings, ...(s.settings || {}) },
        tax: { ...d.tax, ...(s.tax || {}), params: { ...d.tax.params, ...((s.tax || {}).params || {}) } },
      };
    } catch (e) {
      console.error(e);
      return defaultState();
    }
  }
  let state = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('Enregistrement impossible : ' + e.message); }
  }

  const ui = { tab: 'month', month: C.monthKey(), imp: null };

  // ---------------------------------------------------------------- utilitaires

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
  const fmt0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const fmt2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const eur = (x) => (Math.abs(x - Math.round(x)) < 0.005 ? fmt0 : fmt2).format(x);
  const eur0 = (x) => fmt0.format(x);
  const signed = (x) => (x > 0 ? '+' : '') + eur(x);
  const pct = (x, d = 1) => (x == null ? '—' : (x * 100).toFixed(d).replace('.', ',') + ' %');
  const cls = (x) => (x > 0.004 ? 'pos' : x < -0.004 ? 'neg' : '');
  const MONTHS_SHORT = ['jan', 'fév', 'mar', 'avr', 'mai', 'jun', 'jul', 'aoû', 'sep', 'oct', 'nov', 'déc'];
  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  }
  const monthShort = (key) => MONTHS_SHORT[Number(key.split('-')[1]) - 1];

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function categories(type) {
    const used = new Set(DEFAULT_CATS[type]);
    state.entries.concat(state.planned).forEach((e) => { if ((e.type || 'expense') === type && e.category) used.add(e.category); });
    return [...used];
  }

  // ---------------------------------------------------------------- graphiques

  const charts = {};
  function niceTicks(min, max, n) {
    const span = max - min || 1;
    const raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + 1e-9; v += step) ticks.push(Math.round(v));
    return ticks;
  }
  const compact = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' k' : String(v));

  function barPath(x, w, yBase, yVal, r) {
    const h = Math.abs(yBase - yVal);
    if (h < 0.5) return '';
    r = Math.min(r, h, w / 2);
    if (yVal < yBase) { // barre vers le haut : coins arrondis en haut
      return `M${x},${yBase}V${yVal + r}Q${x},${yVal} ${x + r},${yVal}H${x + w - r}Q${x + w},${yVal} ${x + w},${yVal + r}V${yBase}Z`;
    }
    return `M${x},${yBase}V${yVal - r}Q${x},${yVal} ${x + r},${yVal}H${x + w - r}Q${x + w},${yVal} ${x + w},${yVal - r}V${yBase}Z`;
  }

  /** rows: [{month, ...}], series: [{key, cls, label}], tip(row) → html */
  function barChart(id, rows, series, tip, opts) {
    opts = opts || {};
    const W = 340, H = 190, padL = 34, padR = 4, padT = 8, padB = 22;
    const vals = rows.flatMap((r) => series.map((s) => r[s.key]));
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals, 1), 4);
    const min = ticks[0], max = ticks[ticks.length - 1];
    const y = (v) => padT + ((max - v) / (max - min || 1)) * (H - padT - padB);
    const band = (W - padL - padR) / rows.length;
    const gap = 2;
    const bw = Math.max(3, Math.min(16, (band * 0.72 - gap * (series.length - 1)) / series.length));
    const groupW = bw * series.length + gap * (series.length - 1);
    let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || '')}">`;
    ticks.forEach((t) => {
      out += `<line class="${t === 0 ? 'axis' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
      out += `<text x="${padL - 4}" y="${y(t) + 3.5}" text-anchor="end">${compact(t)}</text>`;
    });
    rows.forEach((r, i) => {
      const x0 = padL + i * band + (band - groupW) / 2;
      series.forEach((s, j) => {
        const v = r[s.key];
        const extra = typeof s.cls === 'function' ? s.cls(v) : s.cls;
        out += `<path class="${extra}" d="${barPath(x0 + j * (bw + gap), bw, y(0), y(v), 4)}"/>`;
      });
      out += `<text x="${padL + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${monthShort(r.month)}</text>`;
      out += `<rect class="hit" data-chart="${id}" data-i="${i}" x="${padL + i * band}" y="${padT}" width="${band}" height="${H - padT - padB}"/>`;
    });
    out += '</svg>';
    charts[id] = rows.map(tip);
    return out;
  }

  const tipEl = () => document.getElementById('tooltip');
  function showTip(target, ev) {
    const html = (charts[target.dataset.chart] || [])[Number(target.dataset.i)];
    if (!html) return;
    document.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
    target.classList.add('on');
    const t = tipEl();
    t.innerHTML = html; t.hidden = false;
    const r = t.getBoundingClientRect();
    let x = ev.clientX + 12, yy = ev.clientY - r.height - 12;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 12;
    if (x < 8) x = 8;
    if (yy < 8) yy = ev.clientY + 16;
    t.style.left = x + 'px'; t.style.top = yy + 'px';
  }
  function hideTip() {
    tipEl().hidden = true;
    document.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
  }
  const tipRow = (cssDot, label, value) =>
    `<div class="tr"><span>${cssDot ? `<i class="dot ${cssDot}"></i>` : ''}${label}</span><span class="num">${value}</span></div>`;

  // ---------------------------------------------------------------- vue : Mois

  function viewMonth() {
    const m = ui.month;
    const s = C.monthSummary(state.entries, m);
    const list = state.entries.filter((e) => e.month === m);
    const incomes = list.filter((e) => e.type === 'income').sort((a, b) => b.amount - a.amount);
    const expenses = list.filter((e) => e.type === 'expense')
      .sort((a, b) => (b.recurring - a.recurring) || (b.amount - a.amount));
    const imported = list.filter((e) => e.importKey).length;
    const planned = state.planned.filter((p) => p.month === m);
    const prev = C.addMonths(m, -1);
    const labels = new Set(list.map((e) => e.label.toLowerCase()));
    const toCopy = state.entries.filter((e) => e.month === prev && e.recurring && !labels.has(e.label.toLowerCase()));

    const item = (e) => `
      <li class="tap" data-action="edit-entry" data-id="${e.id}">
        <div class="grow">
          <div class="title">${esc(e.label)}${e.recurring ? '<span class="tag">fixe</span>' : ''}</div>
          <div class="meta">${e.date ? e.date.slice(8, 10) + '/' + e.date.slice(5, 7) + ' · ' : ''}${esc(e.category || '')}</div>
        </div>
        <div class="num ${e.type === 'income' ? 'pos' : ''}">${e.type === 'income' ? '+' : '−'}${eur(e.amount)}</div>
      </li>`;

    const cats = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]);
    const maxCat = cats.length ? cats[0][1] : 1;

    return `
      <div class="monthnav">
        <button class="iconbtn" data-action="month-prev" aria-label="Mois précédent">‹</button>
        <strong>${monthLabel(m)}</strong>
        <button class="iconbtn" data-action="month-next" aria-label="Mois suivant">›</button>
      </div>

      <div class="stats" style="margin-top:12px">
        <div class="stat"><div class="lbl"><i class="dot income"></i>Revenus</div><div class="val num">${eur0(s.income)}</div></div>
        <div class="stat"><div class="lbl"><i class="dot expense"></i>Dépenses</div><div class="val num">${eur0(s.expense)}</div>
          <div class="sub">fixes ${eur0(s.fixedExpense)} · variables ${eur0(s.variableExpense)}</div></div>
        <div class="stat wide"><div class="lbl">Solde du mois (épargne)</div>
          <div class="val num ${cls(s.balance)}">${signed(s.balance)}</div>
          <div class="sub">Taux d'épargne : ${pct(s.savingsRate)}</div></div>
      </div>

      <div class="row" style="margin-top:10px">
        <button class="btn small" data-action="open-import">📄 Importer un relevé PDF</button>
        ${imported ? `<span class="hint" style="align-self:center">${imported} ligne(s) importée(s)</span>` : ''}
      </div>

      ${toCopy.length ? `
      <div class="card">
        <h2>Charges et revenus récurrents</h2>
        <p class="hint">${toCopy.length} ligne(s) fixe(s) de ${monthLabel(prev)} ne sont pas encore dans ce mois.</p>
        <button class="btn primary block" data-action="copy-recurring">Reprendre les lignes fixes (${eur0(toCopy.reduce((a, e) => a + (e.type === 'income' ? e.amount : -e.amount), 0))} net)</button>
      </div>` : ''}

      ${planned.length ? `
      <div class="card">
        <h2>Programmé ce mois-ci</h2>
        <ul class="list">${planned.map((p) => `
          <li><div class="grow"><div class="title">${esc(p.label)}</div><div class="meta">${esc(p.category || '')}</div></div>
          <span class="num">${p.type === 'income' ? '+' : '−'}${eur(p.amount)}</span>
          <button class="btn small" data-action="realize" data-id="${p.id}">Valider</button></li>`).join('')}</ul>
        <p class="hint">« Valider » transforme la charge programmée en dépense réelle du mois.</p>
      </div>` : ''}

      <div class="card">
        <h2>Revenus</h2>
        ${incomes.length ? `<ul class="list">${incomes.map(item).join('')}</ul>` : '<div class="empty">Aucun revenu saisi.</div>'}
      </div>
      <div class="card">
        <h2>Dépenses</h2>
        ${expenses.length ? `<ul class="list">${expenses.map(item).join('')}</ul>` : '<div class="empty">Aucune dépense saisie. Touchez « + » pour commencer.</div>'}
      </div>

      ${cats.length ? `
      <div class="card">
        <h2>Répartition des dépenses</h2>
        <ul class="list">${cats.map(([c, v]) => `
          <li><div class="grow"><div class="kv" style="padding:0"><span>${esc(c)}</span><span class="num">${eur0(v)} · ${pct(v / s.expense, 0)}</span></div>
          <div class="bar-h" style="width:${Math.max(2, (v / maxCat) * 100)}%"></div></div></li>`).join('')}</ul>
      </div>` : ''}

      <button class="fab" data-action="new-entry" aria-label="Ajouter une ligne">+</button>`;
  }

  // ---------------------------------------------------------------- vue : Bilan

  function viewHistory() {
    const cur = C.monthKey();
    const months = [];
    for (let i = 11; i >= 0; i--) months.push(C.addMonths(cur, -i));
    const rows = months.map((m) => C.monthSummary(state.entries, m));
    const withData = rows.filter((r) => r.count > 0);
    const win = C.referenceWindow(state.entries, cur, 6);
    const avg = C.averages(state.entries, win);
    const avgInc = avg.recIncome + avg.varIncome;
    const avgExp = avg.recExpense + avg.varExpense;

    // catégories moyennes sur la fenêtre
    const catTotals = {};
    state.entries.filter((e) => e.type === 'expense' && win.includes(e.month))
      .forEach((e) => { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });
    const cats = Object.entries(catTotals).map(([c, v]) => [c, v / (win.length || 1)]).sort((a, b) => b[1] - a[1]);

    if (!withData.length) {
      return `<div class="card empty">Pas encore de données. Saisissez vos revenus et dépenses dans l'onglet « Mois »,
        ou chargez des données d'exemple depuis « Réglages ».</div>`;
    }

    const chart = barChart('hist', rows, [
      { key: 'income', cls: 'b-inc', label: 'Revenus' },
      { key: 'expense', cls: 'b-exp', label: 'Dépenses' },
    ], (r) => `<b>${monthLabel(r.month)}</b>${tipRow('income', 'Revenus', eur0(r.income))}${tipRow('expense', 'Dépenses', eur0(r.expense))}${tipRow('', 'Solde', `<span class="${cls(r.balance)}">${signed(Math.round(r.balance))}</span>`)}`,
    { label: 'Revenus et dépenses des 12 derniers mois' });

    return `
      <p class="hint">Moyennes calculées sur ${win.length} mois : ${win.map(monthShort).join(', ') || '—'} (mois en cours exclu).</p>
      <div class="stats">
        <div class="stat"><div class="lbl"><i class="dot income"></i>Revenus moyens</div><div class="val num">${eur0(avgInc)}</div><div class="sub">dont fixes ${eur0(avg.recIncome)}</div></div>
        <div class="stat"><div class="lbl"><i class="dot expense"></i>Dépenses moyennes</div><div class="val num">${eur0(avgExp)}</div><div class="sub">fixes ${eur0(avg.recExpense)} · var. ${eur0(avg.varExpense)}</div></div>
        <div class="stat wide"><div class="lbl">Épargne moyenne / mois</div><div class="val num ${cls(avgInc - avgExp)}">${signed(Math.round(avgInc - avgExp))}</div>
          <div class="sub">Taux d'épargne moyen : ${pct(avgInc > 0 ? (avgInc - avgExp) / avgInc : null)} · « reste à vivre » après charges fixes : ${eur0(avg.recIncome - avg.recExpense)}</div></div>
      </div>

      <div class="card">
        <h2>12 derniers mois</h2>
        <div class="legend"><span><i class="dot income"></i>Revenus</span><span><i class="dot expense"></i>Dépenses</span></div>
        ${chart}
        <details><summary>Voir le tableau</summary>
          <div class="scroll-x"><table class="data"><thead><tr><th>Mois</th><th>Revenus</th><th>Dépenses</th><th>Solde</th><th>Taux</th></tr></thead><tbody>
          ${rows.slice().reverse().filter((r) => r.count).map((r) => `<tr><td>${monthLabel(r.month)}</td><td class="num">${eur0(r.income)}</td><td class="num">${eur0(r.expense)}</td><td class="num ${cls(r.balance)}">${signed(Math.round(r.balance))}</td><td class="num">${pct(r.savingsRate, 0)}</td></tr>`).join('')}
          </tbody></table></div></details>
      </div>

      ${cats.length ? `<div class="card"><h2>Dépenses moyennes par catégorie</h2>
        <ul class="list">${cats.map(([c, v]) => `<li><div class="grow"><div class="kv" style="padding:0"><span>${esc(c)}</span><span class="num">${eur0(v)} / mois</span></div>
        <div class="bar-h" style="width:${Math.max(2, (v / cats[0][1]) * 100)}%"></div></div></li>`).join('')}</ul></div>` : ''}`;
  }

  // ---------------------------------------------------------------- vue : Prévisions

  function viewForecast() {
    const cur = C.monthKey();
    const inc = state.settings.includeVariable;
    const f = C.forecast(state, cur, 12, { includeVariable: inc });
    const prov = C.provisions(state.planned, cur);
    const total = f.rows[f.rows.length - 1].cumulative;
    const upcoming = state.planned.filter((p) => p.month >= cur).sort((a, b) => a.month.localeCompare(b.month));
    const past = state.planned.filter((p) => p.month < cur);
    const noData = f.window.length === 0;

    const chart = barChart('fc', f.rows, [
      { key: 'savings', cls: (v) => 'b-sav' + (v < 0 ? ' negative' : ''), label: 'Épargne prévue' },
    ], (r) => `<b>${monthLabel(r.month)}</b>${tipRow('', 'Revenus prévus', eur0(r.income))}${tipRow('', 'Dépenses prévues', eur0(r.expense))}${r.plannedExpense ? tipRow('', 'dont programmées', eur0(r.plannedExpense)) : ''}${tipRow('', 'Épargne', `<span class="${cls(r.savings)}">${signed(Math.round(r.savings))}</span>`)}${tipRow('', 'Cumul', eur0(r.cumulative))}`,
    { label: 'Épargne prévue sur 12 mois' });

    return `
      ${noData ? '<div class="card hint">Aucun historique : la prévision ne repose que sur les charges programmées. Saisissez quelques mois pour une estimation réaliste.</div>'
    : `<p class="hint">Projection basée sur la moyenne de ${f.window.length} mois (${f.window.map(monthShort).join(', ')}) + vos charges programmées.</p>`}
      <label class="check card" style="margin-top:8px"><input type="checkbox" data-action="toggle-variable" ${inc ? 'checked' : ''}>
        <span>Inclure la moyenne des dépenses <b>variables</b> (${eur0(f.averages.varExpense)}/mois)<br><span class="hint">Recommandé : sinon seules les charges fixes sont prises en compte.</span></span></label>

      <div class="stats">
        <div class="stat"><div class="lbl">Épargne prévue ce mois</div><div class="val num ${cls(f.rows[0].savings)}">${signed(Math.round(f.rows[0].savings))}</div></div>
        <div class="stat"><div class="lbl">Cumul sur 12 mois</div><div class="val num ${cls(total)}">${signed(Math.round(total))}</div></div>
        <div class="stat wide"><div class="lbl">À mettre de côté chaque mois pour les charges programmées</div>
          <div class="val num">${eur0(prov.totalPerMonth)}</div>
          <div class="sub">Épargne « libre » estimée ce mois : ${signed(Math.round(f.averages.recIncome + (inc ? f.averages.varIncome - f.averages.varExpense : 0) - f.averages.recExpense - prov.totalPerMonth))}</div></div>
      </div>

      <div class="card">
        <h2>Épargne prévue — 12 prochains mois</h2>
        <div class="legend"><span><i class="dot income"></i>Épargne</span><span><i class="dot expense"></i>Déficit</span></div>
        ${chart}
        <details><summary>Voir le tableau</summary><div class="scroll-x"><table class="data">
          <thead><tr><th>Mois</th><th>Revenus</th><th>Dépenses</th><th>dont prog.</th><th>Épargne</th><th>Cumul</th></tr></thead><tbody>
          ${f.rows.map((r) => `<tr><td>${monthShort(r.month)} ${r.month.slice(2, 4)}</td><td class="num">${eur0(r.income)}</td><td class="num">${eur0(r.expense)}</td><td class="num">${r.plannedExpense ? eur0(r.plannedExpense) : '—'}</td><td class="num ${cls(r.savings)}">${eur0(r.savings)}</td><td class="num">${eur0(r.cumulative)}</td></tr>`).join('')}
          </tbody></table></div></details>
      </div>

      <div class="card">
        <h2>Charges programmées</h2>
        <p class="hint">Régularisation d'impôts, taxe foncière, assurance annuelle, vacances…</p>
        ${upcoming.length ? `<ul class="list">${upcoming.map((p) => {
    const pv = prov.items.find((x) => x.id === p.id);
    return `<li class="tap" data-action="edit-planned" data-id="${p.id}"><div class="grow"><div class="title">${esc(p.label)}</div>
            <div class="meta">${monthLabel(p.month)}${pv ? ` · ${eur0(pv.perMonth)}/mois sur ${pv.months} mois` : ''}</div></div>
            <span class="num ${p.type === 'income' ? 'pos' : ''}">${p.type === 'income' ? '+' : '−'}${eur(p.amount)}</span></li>`;
  }).join('')}</ul>` : '<div class="empty">Aucune charge programmée.</div>'}
        <button class="btn primary block" data-action="new-planned" style="margin-top:8px">Programmer une charge</button>
        ${past.length ? `<details style="margin-top:8px"><summary>${past.length} échéance(s) passée(s)</summary><ul class="list">${past.map((p) => `
          <li class="tap" data-action="edit-planned" data-id="${p.id}"><div class="grow"><div class="title">${esc(p.label)}</div><div class="meta">${monthLabel(p.month)}</div></div><span class="num">${eur(p.amount)}</span></li>`).join('')}</ul></details>` : ''}
      </div>`;
  }

  // ---------------------------------------------------------------- vue : Impôts

  const T = () => state.tax;
  function inputField(label, path, value, opts) {
    opts = opts || {};
    return `<label class="field"><span>${label}</span><input type="text" inputmode="decimal" data-bind="${path}" value="${esc(value)}" placeholder="${esc(opts.ph || '0')}"></label>`;
  }

  function viewTax() {
    const t = T();
    const decl = t.couple ? [0, 1] : [0];
    return `
      <p class="hint">Simulation de l'impôt sur les <b>revenus ${t.year}</b> (déclarés au printemps ${t.year + 1}). Paramètres : ${esc(t.params.label)}.</p>
      <div class="card">
        <h2>Foyer fiscal</h2>
        <div class="seg" role="group">
          <button data-action="tax-couple" data-v="0" class="${t.couple ? '' : 'on'}">Seul(e)</button>
          <button data-action="tax-couple" data-v="1" class="${t.couple ? 'on' : ''}">Couple (marié/pacsé)</button>
        </div>
        <div class="grid2">
          ${inputField('Nombre de parts', 'tax.parts', t.parts, { ph: t.couple ? '2' : '1' })}
          ${inputField('Taux de prélèvement actuel (%)', 'tax.tauxPAS', t.tauxPAS, { ph: 'ex. 7,5' })}
        </div>
        ${inputField('Autres revenus imposables nets (€/an)', 'tax.autresRevenus', t.autresRevenus)}
        ${inputField('Total déjà prélevé sur l\'année (€) — facultatif', 'tax.dejaPreleve', t.dejaPreleve, { ph: 'vide = calcul avec le taux' })}
        <p class="hint">Sans montant prélevé, l'outil suppose que votre taux actuel s'applique toute l'année.</p>
      </div>
      ${decl.map((i) => declarantForm(i)).join('')}
      <div id="tax-results">${taxResults()}</div>
      ${taxParamsForm()}`;
  }

  function declarantForm(i) {
    const d = T().declarants[i];
    const f = d.frais;
    const p = `tax.declarants.${i}`;
    return `
      <div class="card">
        <h2>${T().couple ? `Déclarant ${i + 1}` : 'Vos revenus'}</h2>
        ${inputField('Salaire net imposable annuel (€)', p + '.netImposable', d.netImposable)}
        <button class="btn small" data-action="estimate-salary" data-i="${i}">Estimer depuis mes saisies « Salaire »</button>
        <p class="hint">Le net imposable figure sur la fiche de paie de décembre (cumul annuel). Il est un peu supérieur au net versé.</p>

        <h3>Frais réels — trajets domicile-travail</h3>
        <div class="grid2">
          <label class="field"><span>Puissance fiscale</span><select data-bind="${p}.frais.cv">
            ${[3, 4, 5, 6, 7].map((cv) => `<option value="${cv}" ${Number(f.cv) === cv ? 'selected' : ''}>${cv === 3 ? '3 CV et moins' : cv === 7 ? '7 CV et plus' : cv + ' CV'}</option>`).join('')}
          </select></label>
          <label class="check" style="margin-top:22px"><input type="checkbox" data-bind="${p}.frais.electric" ${f.electric ? 'checked' : ''}><span>Électrique (+20 %)</span></label>
          ${inputField('Km aller (domicile → travail)', p + '.frais.kmJour', f.kmJour)}
          ${inputField('Jours travaillés sur site / an', p + '.frais.joursTrajet', f.joursTrajet, { ph: 'ex. 210' })}
        </div>
        ${inputField('Autres km professionnels / an', p + '.frais.kmAutres', f.kmAutres)}
        <p class="hint">Au-delà de 40 km aller, seuls 40 km sont admis sauf justification.</p>

        <h3>Repas et télétravail</h3>
        <div class="grid2">
          ${inputField('Repas pris hors domicile / an', p + '.frais.nbRepas', f.nbRepas)}
          ${inputField('Coût moyen d\'un repas (€)', p + '.frais.coutRepas', f.coutRepas)}
        </div>
        ${inputField('Jours de télétravail / an', p + '.frais.joursTeletravail', f.joursTeletravail)}

        <h3>Autres frais (formation, double résidence, matériel…)</h3>
        ${(f.autres || []).map((a, k) => `
          <div class="grid2" style="align-items:end">
            <label class="field"><span>Libellé</span><input type="text" data-bind="${p}.frais.autres.${k}.label" value="${esc(a.label)}"></label>
            <div style="display:flex;gap:6px;align-items:end"><label class="field" style="flex:1"><span>Montant (€)</span><input type="text" inputmode="decimal" data-bind="${p}.frais.autres.${k}.amount" value="${esc(a.amount)}"></label>
            <button class="iconbtn" style="margin:10px 0" data-action="del-frais" data-i="${i}" data-k="${k}" aria-label="Supprimer">×</button></div>
          </div>`).join('')}
        <button class="btn small" data-action="add-frais" data-i="${i}">+ Ajouter un frais</button>

        <h3>Option retenue</h3>
        <div class="seg">
          ${[['auto', 'La meilleure'], ['forfait', 'Forfait 10 %'], ['reels', 'Frais réels']].map(([v, l]) => `<button data-action="tax-mode" data-i="${i}" data-v="${v}" class="${(d.forceMode || 'auto') === v ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>`;
  }

  function taxInput() {
    const t = T();
    const numify = (o) => {
      const out = {};
      Object.keys(o).forEach((k) => { out[k] = k === 'electric' ? !!o[k] : k === 'autres' ? o[k].map((a) => ({ label: a.label, amount: num(a.amount) })) : num(o[k]); });
      return out;
    };
    return {
      couple: t.couple, parts: num(t.parts) || (t.couple ? 2 : 1), tauxPAS: num(t.tauxPAS),
      dejaPreleve: String(t.dejaPreleve).trim() === '' ? '' : num(t.dejaPreleve),
      autresRevenus: num(t.autresRevenus), params: t.params,
      declarants: t.declarants.map((d) => ({ netImposable: num(d.netImposable), forceMode: d.forceMode, frais: numify(d.frais) })),
    };
  }

  function taxResults() {
    const r = C.simulateTax(taxInput());
    const t = T();
    if (r.assiettePAS <= 0) return '<div class="card empty">Renseignez votre salaire net imposable pour lancer la simulation.</div>';

    const declBlocks = r.declarants.map((d, i) => {
      const better = d.best === 'reels'
        ? `<strong class="pos">Frais réels plus avantageux (+${eur0(d.gain)} de déduction)</strong>Vous êtes <b>au-dessus</b> de l'abattement de 10 %.`
        : `<strong>Forfait 10 % plus avantageux</strong>Vos frais réels sont <b>en dessous</b> de l'abattement (il manque ${eur0(d.gain)}).`;
      return `
        <h3>${t.couple ? `Déclarant ${i + 1}` : 'Déduction pour frais'}</h3>
        <div class="kv"><span>Abattement forfaitaire 10 %</span><span class="num">${eur0(d.abattement)}</span></div>
        <div class="kv"><span>Frais réels</span><span class="num">${eur0(d.fraisReels.total)}</span></div>
        <div class="hint" style="padding-left:8px">km ${eur0(d.fraisReels.km)} · repas ${eur0(d.fraisReels.repas)} · télétravail ${eur0(d.fraisReels.teletravail)} · autres ${eur0(d.fraisReels.autres)}</div>
        <div class="verdict">${better}${d.mode !== d.best ? `<div class="hint neg">Attention : vous avez forcé l'option « ${d.mode === 'reels' ? 'frais réels' : 'forfait'} ».</div>` : ''}</div>`;
    }).join('');

    const regul = r.regularisation;
    const verdict = Math.abs(regul) < 20
      ? '<strong class="pos">Votre taux actuel est bien calibré</strong>Pas de régularisation significative à prévoir.'
      : regul > 0
        ? `<strong class="neg">Régularisation à prévoir : ${eur0(regul)}</strong>Prélevée à partir de septembre ${t.year + 1}${regul > 300 ? ' (sur 4 mois, de septembre à décembre)' : ''}.`
        : `<strong class="pos">Remboursement attendu : ${eur0(-regul)}</strong>Versé en général fin juillet ${t.year + 1}.`;

    const tauxIdeal = r.tauxIdealArrondi;
    return `
      <div class="card">
        <h2>Résultat de la simulation</h2>
        ${declBlocks}
        <h3>Impôt du foyer</h3>
        <div class="kv"><span>Revenu net imposable</span><span class="num">${eur0(r.revenuImposable)}</span></div>
        <div class="kv"><span>Tranche marginale (TMI)</span><span class="num">${pct(r.tmi, 0)}</span></div>
        ${r.decote ? `<div class="kv"><span>Décote appliquée</span><span class="num">−${eur0(r.decote)}</span></div>` : ''}
        ${r.plafonnementApplique ? '<div class="hint">Plafonnement du quotient familial appliqué.</div>' : ''}
        ${r.nonRecouvre ? '<div class="hint">Impôt inférieur à 61 € : non recouvré.</div>' : ''}
        <div class="kv total"><span>Impôt estimé</span><span class="num">${eur0(r.impot)}</span></div>
        <div class="kv"><span>Prélevé à la source ${String(t.dejaPreleve).trim() === '' ? `(taux ${pct(num(t.tauxPAS) / 100)})` : ''}</span><span class="num">${eur0(r.preleve)}</span></div>
        <div class="verdict">${verdict}</div>

        <h3>Taux conseillé</h3>
        <div class="kv total"><span>Taux de prélèvement adapté</span><span class="num">${String(tauxIdeal.toFixed(1)).replace('.', ',')} %</span></div>
        <p class="hint">= impôt estimé ÷ revenus soumis au prélèvement (${eur0(r.assiettePAS)}), arrondi au dixième supérieur.
          Pour l'appliquer : impots.gouv.fr › Gérer mon prélèvement à la source › Actualiser suite à une hausse ou baisse de revenus.
          ${num(t.tauxPAS) && tauxIdeal < num(t.tauxPAS) ? 'Une baisse de taux n\'est acceptée que si l\'écart est supérieur à 10 % et 200 €.' : ''}</p>
        ${Math.abs(regul) >= 20 ? `<button class="btn primary block" data-action="plan-regul">${regul > 0 ? 'Programmer la régularisation dans mes prévisions' : 'Ajouter le remboursement à mes prévisions'}</button>` : ''}
      </div>`;
  }

  function taxParamsForm() {
    const p = T().params;
    return `
      <div class="card">
        <details><summary>Paramètres fiscaux (barème, plafonds…)</summary>
          <p class="hint">Valeurs par défaut : ${esc(C.DEFAULT_TAX_PARAMS.label)}. Mettez-les à jour chaque année sur impots.gouv.fr.</p>
          <label class="field"><span>Année des revenus simulés</span><input type="text" inputmode="numeric" data-bind="tax.year" value="${esc(T().year)}"></label>
          <h3>Tranches (limite haute par part)</h3>
          ${p.brackets.map((b, k) => `
            <div class="grid2">
              <label class="field"><span>Tranche ${k + 1} jusqu'à (€)</span><input type="text" inputmode="decimal" data-bind="tax.params.brackets.${k}.upTo" value="${b.upTo == null ? '' : b.upTo}" placeholder="∞" ${b.upTo == null ? 'disabled' : ''}></label>
              <label class="field"><span>Taux (décimal)</span><input type="text" inputmode="decimal" data-bind="tax.params.brackets.${k}.rate" value="${b.rate}"></label>
            </div>`).join('')}
          <div class="grid2">
            ${[['abattementMin', 'Abattement 10 % min'], ['abattementMax', 'Abattement 10 % max'], ['plafondDemiPart', 'Plafond par demi-part'],
    ['decoteSingle', 'Décote personne seule'], ['decoteCouple', 'Décote couple'], ['decoteRate', 'Taux de décote'],
    ['repasForfait', 'Valeur repas au domicile'], ['repasPlafond', 'Plafond coût repas'],
    ['teletravailJour', 'Télétravail €/jour'], ['teletravailPlafond', 'Télétravail plafond']]
    .map(([k, l]) => inputField(l, 'tax.params.' + k, p[k])).join('')}
          </div>
          <button class="btn small danger" data-action="reset-params">Rétablir les valeurs par défaut</button>
        </details>
      </div>`;
  }

  function setPath(path, value) {
    const keys = path.split('.');
    let o = state;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }

  // ---------------------------------------------------------------- vue : Import de relevé

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      const base = new URL('js/vendor/pdfjs/', document.baseURI);
      pdfjsPromise = import(new URL('pdf.min.mjs', base).href).then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href;
        return lib;
      }).catch((e) => { pdfjsPromise = null; throw e; });
    }
    return pdfjsPromise;
  }

  async function readStatement(file) {
    ui.imp = { loading: true, fileName: file.name };
    render();
    try {
      const lib = await loadPdfjs();
      const pages = await window.BnpImport.extractPages(lib, new Uint8Array(await file.arrayBuffer()));
      const st = window.BnpImport.parseStatement(pages);
      const known = new Set(state.entries.map((e) => e.importKey).filter(Boolean));
      const rows = st.operations.map((op) => {
        const sug = window.BnpImport.suggest(op, state.importRules);
        const duplicate = known.has(op.importKey);
        return { op, sug, include: !duplicate && !sug.ignore, category: sug.category, recurring: sug.recurring, duplicate };
      });
      ui.imp = { fileName: file.name, st, rows };
    } catch (e) {
      console.error(e);
      ui.imp = { error: e.message || String(e), fileName: file.name };
    }
    render();
  }

  function importTotals() {
    const sel = ui.imp.rows.filter((r) => r.include);
    return {
      n: sel.length,
      out: sel.filter((r) => r.op.type === 'expense').reduce((a, r) => a + r.op.amount, 0),
      in: sel.filter((r) => r.op.type === 'income').reduce((a, r) => a + r.op.amount, 0),
    };
  }
  const importFooter = () => {
    const t = importTotals();
    return `Importer ${t.n} ligne(s) · −${eur0(t.out)} / +${eur0(t.in)}`;
  };

  function viewImport() {
    const imp = ui.imp;
    const picker = `
      <label class="btn primary block">Choisir un relevé PDF<input type="file" accept="application/pdf,.pdf" data-action="import-pdf" hidden></label>`;
    if (!imp) {
      return `
        <div class="card">
          <h2>Importer un relevé BNP Paribas</h2>
          <p class="hint">Téléchargez votre relevé de compte (PDF) depuis mabanque.bnpparibas ou l'application
          Mes Comptes, puis sélectionnez-le ici. Le fichier est analysé <b>sur cet appareil</b> : il n'est ni envoyé ni conservé.</p>
          ${picker}
        </div>
        <div class="card">
          <h2>Comment ça marche</h2>
          <p class="hint">1. Les opérations sont lues et vérifiées avec le « Total des opérations » du relevé.<br>
          2. Une catégorie est proposée pour chaque ligne ; les prélèvements sont marqués « fixes ».<br>
          3. Vous corrigez si besoin et décochez ce que vous ne voulez pas compter (virements entre vos comptes…).<br>
          4. Vos corrections sont retenues pour les prochains imports. Les lignes déjà importées sont ignorées.</p>
        </div>
        <button class="btn block" data-action="close-import">Retour</button>`;
    }
    if (imp.loading) return `<div class="card empty">Lecture de « ${esc(imp.fileName)} »…</div>`;
    if (imp.error) {
      return `<div class="card"><h2>Lecture impossible</h2><p class="hint neg">${esc(imp.error)}</p>${picker}</div>
        <button class="btn block" data-action="close-import">Retour</button>`;
    }

    const st = imp.st;
    const dups = imp.rows.filter((r) => r.duplicate).length;
    const months = [...new Set(imp.rows.map((r) => r.op.month))].sort();
    const manual = state.entries.filter((e) => !e.importKey && months.includes(e.month)).length;
    const fmtD = (iso) => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '?';
    const catOptions = (type, current) => {
      const list = categories(type);
      if (!list.includes(current)) list.push(current);
      return list.map((c) => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
    };

    const rowHtml = (r, i) => `
      <li style="flex-wrap:wrap;${r.include ? '' : 'opacity:.55'}">
        <input type="checkbox" data-imp="include" data-i="${i}" ${r.include ? 'checked' : ''} ${r.duplicate ? 'disabled' : ''}
          style="width:22px;height:22px;accent-color:var(--accent)" aria-label="Importer cette ligne">
        <div class="grow">
          <div class="title">${esc(r.op.label)}</div>
          <div class="meta">${fmtD(r.op.date).slice(0, 5)} · ${esc(r.op.detail || '')}${r.duplicate ? ' · <b>déjà importée</b>' : ''}${r.op.transfer === 'own' ? ' · entre vos comptes' : ''}${r.sug.learned ? ' · règle apprise' : ''}</div>
        </div>
        <div class="num ${r.op.type === 'income' ? 'pos' : ''}">${r.op.type === 'income' ? '+' : '−'}${eur(r.op.amount)}</div>
        <div style="flex-basis:100%;display:flex;gap:8px;align-items:center;padding-left:32px">
          <select data-imp="category" data-i="${i}" style="flex:1;min-height:36px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);padding:0 8px;font-size:14px">${catOptions(r.op.type, r.category)}</select>
          <label class="check" style="min-height:36px;gap:6px;font-size:.85rem"><input type="checkbox" data-imp="recurring" data-i="${i}" ${r.recurring ? 'checked' : ''} style="width:18px;height:18px">fixe</label>
        </div>
      </li>`;

    return `
      <div class="card">
        <h2>${esc(st.bank)} · ${st.period ? `du ${fmtD(st.period.from)} au ${fmtD(st.period.to)}` : esc(imp.fileName)}</h2>
        <div class="kv"><span>Opérations lues</span><span class="num">${st.operations.length}</span></div>
        <div class="kv"><span>Débits / crédits</span><span class="num">−${eur(st.check.debit)} / +${eur(st.check.credit)}</span></div>
        ${st.openingBalance != null ? `<div class="kv"><span>Solde début → fin</span><span class="num">${eur(st.openingBalance)} → ${eur(st.closingBalance)}</span></div>` : ''}
        <div class="verdict">${st.check.ok
    ? '<strong class="pos">✓ Montants vérifiés</strong>Les totaux correspondent exactement au « Total des opérations » du relevé.'
    : '<strong class="neg">⚠ Vérification incomplète</strong>' + st.warnings.map(esc).join('<br>')}</div>
        ${dups ? `<p class="hint">${dups} opération(s) déjà importée(s) précédemment : ignorée(s).</p>` : ''}
        ${manual ? `<p class="hint">⚠ ${manual} ligne(s) saisie(s) à la main existent déjà sur ${months.map(monthShort).join(', ')}. Supprimez-les ensuite si elles font doublon (ex. loyer).</p>` : ''}
        <p class="hint">Un relevé couvre souvent deux mois partiels : importez aussi le relevé suivant pour compléter.</p>
      </div>

      <div class="row">
        <button class="btn small" data-action="imp-all" data-v="1">Tout cocher</button>
        <button class="btn small" data-action="imp-all" data-v="0">Tout décocher</button>
        <button class="btn small" data-action="close-import">Annuler</button>
      </div>

      ${months.map((m) => `
        <div class="card">
          <h2 style="text-transform:capitalize">${monthLabel(m)}</h2>
          <ul class="list">${imp.rows.map((r, i) => (r.op.month === m ? rowHtml(r, i) : '')).join('')}</ul>
        </div>`).join('')}

      <div style="position:sticky;bottom:calc(76px + var(--safe-b));padding-top:6px">
        <button class="btn primary block" data-action="imp-confirm" id="imp-confirm" style="box-shadow:0 6px 18px rgba(0,0,0,.22)">${importFooter()}</button>
      </div>`;
  }

  function confirmImport() {
    const imp = ui.imp;
    const now = Date.now().toString(36);
    let added = 0;
    imp.rows.forEach((r) => {
      const op = r.op;
      // Apprentissage : on retient le choix de l'utilisateur s'il diffère de la proposition.
      // Pas pour les virements émis : un même bénéficiaire reçoit des virements pour des motifs variés.
      const changed = r.category !== r.sug.category || r.recurring !== r.sug.recurring || (!r.duplicate && r.include === r.sug.ignore);
      if (changed && !r.duplicate && op.kind !== 'vir-out') {
        state.importRules[op.key] = { category: r.category, recurring: r.recurring, ignore: !r.include };
      }
      if (!r.include || r.duplicate) return;
      state.entries.push({
        id: uid(), month: op.month, date: op.date, type: op.type, label: op.label, category: r.category,
        amount: op.amount, recurring: r.recurring, importKey: op.importKey, source: 'bnp-pdf', batch: now,
      });
      added++;
    });
    save();
    const months = imp.rows.filter((r) => r.include).map((r) => r.op.month).sort();
    ui.imp = null;
    ui.tab = 'month';
    if (months.length) ui.month = months[months.length - 1];
    render(); window.scrollTo(0, 0);
    toast(`${added} opération(s) importée(s)`);
  }

  // ---------------------------------------------------------------- vue : Réglages

  function viewSettings() {
    const th = state.settings.theme;
    return `
      <div class="card">
        <h2>Apparence</h2>
        <div class="seg">${[['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => `<button data-action="theme" data-v="${v}" class="${th === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div class="card">
        <h2>Installer sur le téléphone</h2>
        <p class="hint"><b>iPhone (Safari)</b> : bouton Partager › « Sur l'écran d'accueil ».<br>
        <b>Android (Chrome)</b> : menu ⋮ › « Installer l'application » / « Ajouter à l'écran d'accueil ».<br>
        L'application fonctionne ensuite hors connexion.</p>
      </div>
      <div class="card">
        <h2>Sauvegarde</h2>
        <p class="hint">Vos données restent uniquement sur cet appareil. Exportez-les régulièrement pour ne rien perdre
        (ou pour les transférer sur un autre appareil).</p>
        <div class="row">
          <button class="btn" data-action="export">Exporter (JSON)</button>
          <label class="btn">Importer<input type="file" accept="application/json,.json" data-action="import" hidden></label>
        </div>
        <p class="hint">${state.entries.length} ligne(s) saisie(s) · ${state.planned.length} charge(s) programmée(s).</p>
      </div>
      <div class="card">
        <h2>Import de relevés</h2>
        <p class="hint">Relevés de compte BNP Paribas (PDF). Le fichier est lu sur cet appareil et n'est jamais envoyé.
        ${Object.keys(state.importRules || {}).length} règle(s) de catégorisation apprise(s).</p>
        <div class="row">
          <button class="btn" data-action="open-import">Importer un relevé</button>
          ${Object.keys(state.importRules || {}).length ? '<button class="btn danger" data-action="reset-rules">Oublier les règles</button>' : ''}
        </div>
      </div>
      <div class="card">
        <h2>Données</h2>
        <div class="row">
          <button class="btn" data-action="demo">Charger un exemple</button>
          <button class="btn danger" data-action="reset">Tout effacer</button>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- feuilles (formulaires)

  const sheet = () => document.getElementById('sheet');

  function openEntryForm(kind, item) {
    // kind: 'entry' | 'planned'
    const isNew = !item;
    const e = item || {
      type: 'expense', label: '', amount: '', category: '', recurring: kind === 'entry',
      month: kind === 'entry' ? ui.month : C.addMonths(C.monthKey(), 1),
    };
    const title = kind === 'entry' ? (isNew ? 'Nouvelle ligne' : 'Modifier la ligne') : (isNew ? 'Programmer une charge' : 'Charge programmée');
    sheet().innerHTML = `
      <form method="dialog" id="entry-form">
        <h2>${title}</h2>
        <div class="seg" style="margin:10px 0">
          <button type="button" data-type="expense" class="${e.type !== 'income' ? 'on' : ''}">Dépense</button>
          <button type="button" data-type="income" class="${e.type === 'income' ? 'on' : ''}">Revenu</button>
        </div>
        <input type="hidden" name="type" value="${e.type || 'expense'}">
        <label class="field"><span>Libellé</span><input name="label" required value="${esc(e.label)}" placeholder="${kind === 'planned' ? 'ex. Taxe foncière' : 'ex. Loyer'}" autocomplete="off"></label>
        <div class="grid2">
          <label class="field"><span>Montant (€)</span><input name="amount" required inputmode="decimal" value="${esc(e.amount)}" placeholder="0,00"></label>
          <label class="field"><span>Mois</span><input name="month" type="month" required value="${e.month}"></label>
        </div>
        <label class="field"><span>Catégorie</span><input name="category" list="cat-list" value="${esc(e.category)}" placeholder="Choisir ou saisir" autocomplete="off"></label>
        <datalist id="cat-list"></datalist>
        ${kind === 'entry' ? `<label class="check"><input type="checkbox" name="recurring" ${e.recurring ? 'checked' : ''}><span>Fixe / récurrente (revient chaque mois)</span></label>`
    : `${isNew ? `<label class="field"><span>Répéter</span><select name="repeat"><option value="0">Une seule fois</option><option value="1">Tous les mois (12 mois)</option><option value="3">Tous les trimestres (4 fois)</option><option value="12">Tous les ans (3 ans)</option></select></label>` : ''}`}
        <div class="row" style="margin-top:14px">
          ${isNew ? '' : '<button type="button" class="btn danger" data-sheet="delete">Supprimer</button>'}
          <button type="button" class="btn" data-sheet="cancel">Annuler</button>
          <button type="submit" class="btn primary">Enregistrer</button>
        </div>
      </form>`;
    const form = sheet().querySelector('form');
    const fillCats = () => {
      form.querySelector('#cat-list').innerHTML = categories(form.type.value).map((c) => `<option value="${esc(c)}">`).join('');
    };
    fillCats();
    form.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
      form.type.value = b.dataset.type;
      form.querySelectorAll('[data-type]').forEach((x) => x.classList.toggle('on', x === b));
      fillCats();
    }));
    form.querySelector('[data-sheet="cancel"]').addEventListener('click', () => sheet().close());
    const del = form.querySelector('[data-sheet="delete"]');
    if (del) del.addEventListener('click', () => {
      if (!confirm('Supprimer cette ligne ?')) return;
      const coll = kind === 'entry' ? 'entries' : 'planned';
      state[coll] = state[coll].filter((x) => x.id !== item.id);
      save(); sheet().close(); render();
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const amount = Math.abs(num(form.amount.value));
      if (!amount) { form.amount.focus(); return; }
      const data = {
        type: form.type.value, label: form.label.value.trim(), amount, month: form.month.value,
        category: form.category.value.trim() || (form.type.value === 'income' ? 'Autre revenu' : 'Autre'),
      };
      if (kind === 'entry') {
        data.recurring = form.recurring.checked;
        if (isNew) state.entries.push({ id: uid(), ...data });
        else Object.assign(item, data);
      } else if (isNew) {
        const step = Number(form.repeat.value);
        const n = step === 0 ? 1 : step === 1 ? 12 : step === 3 ? 4 : 3;
        const group = n > 1 ? uid() : undefined;
        for (let k = 0; k < n; k++) state.planned.push({ id: uid(), group, ...data, month: C.addMonths(data.month, k * step) });
      } else Object.assign(item, data);
      save(); sheet().close(); render();
      toast('Enregistré');
    });
    sheet().showModal();
    if (isNew) setTimeout(() => form.label.focus(), 50);
  }

  // ---------------------------------------------------------------- actions

  function estimateSalary(i) {
    const year = T().year;
    const cur = C.monthKey();
    const yearMonths = [];
    for (let m = 1; m <= 12; m++) yearMonths.push(year + '-' + String(m).padStart(2, '0'));
    const sal = state.entries.filter((e) => e.type === 'income' && /salaire|prime/i.test(e.category || ''));
    if (!sal.length) { toast('Aucun revenu de catégorie « Salaire » ou « Prime » saisi.'); return; }
    let total = 0, missing = 0;
    yearMonths.forEach((m) => {
      const v = sal.filter((e) => e.month === m).reduce((a, e) => a + e.amount, 0);
      if (v > 0) total += v; else if (m >= cur) missing++;
    });
    const win = C.referenceWindow(state.entries, cur, 6);
    const avgSal = win.length ? sal.filter((e) => win.includes(e.month) && e.recurring).reduce((a, e) => a + e.amount, 0) / win.length : 0;
    const est = Math.round(total + missing * avgSal);
    T().declarants[i].netImposable = String(est);
    save(); render();
    toast(`Estimation : ${eur0(total)} saisis + ${missing} mois × ${eur0(avgSal)} (net versé, à ajuster)`);
  }

  function planRegul() {
    const r = C.simulateTax(taxInput());
    const y = T().year + 1;
    const label = `Régularisation impôt ${T().year}`;
    state.planned = state.planned.filter((p) => p.tag !== 'regul-' + T().year);
    const tag = 'regul-' + T().year;
    if (r.regularisation > 0) {
      const parts = r.regularisation > 300 ? 4 : 1;
      for (let k = 0; k < parts; k++) {
        state.planned.push({ id: uid(), tag, type: 'expense', label: label + (parts > 1 ? ` (${k + 1}/4)` : ''), category: 'Impôts & taxes',
          amount: C.round2(r.regularisation / parts), month: `${y}-${String(9 + k).padStart(2, '0')}` });
      }
    } else {
      state.planned.push({ id: uid(), tag, type: 'income', label: `Remboursement impôt ${T().year}`, category: 'Remboursement',
        amount: C.round2(-r.regularisation), month: `${y}-07` });
    }
    save();
    toast('Ajouté aux charges programmées (onglet Prévisions)');
  }

  function demoData() {
    const cur = C.monthKey();
    const e = [];
    const add = (month, type, label, category, amount, recurring) => e.push({ id: uid(), month, type, label, category, amount, recurring });
    for (let i = 8; i >= 1; i--) {
      const m = C.addMonths(cur, -i);
      const jitter = (base, spread) => Math.round(base + (Math.sin(i * 7.3) * spread));
      add(m, 'income', 'Salaire', 'Salaire', 2850, true);
      add(m, 'expense', 'Loyer', 'Logement', 890, true);
      add(m, 'expense', 'Électricité', 'Énergie', 78, true);
      add(m, 'expense', 'Box internet + mobile', 'Abonnements', 45, true);
      add(m, 'expense', 'Assurance habitation', 'Assurances', 22, true);
      add(m, 'expense', 'Crédit auto', 'Crédit', 260, true);
      add(m, 'expense', 'Courses', 'Alimentation', jitter(420, 60), false);
      add(m, 'expense', 'Carburant', 'Transport', jitter(140, 30), false);
      add(m, 'expense', 'Sorties / restaurants', 'Loisirs', jitter(160, 70), false);
      if (i % 3 === 0) add(m, 'expense', 'Vêtements', 'Shopping', 120, false);
      if (i === 5) add(m, 'income', 'Prime', 'Prime', 900, false);
    }
    const y = Number(cur.slice(0, 4));
    const p = [
      ['Assurance auto annuelle', 'Assurances', 540, `${y + 1}-01`],
      ['Vacances d\'été', 'Loisirs', 1500, `${y + 1}-07`],
      ['Régularisation impôt', 'Impôts & taxes', 420, `${y + 1}-09`],
      ['Taxe foncière', 'Impôts & taxes', 980, `${y + 1}-10`],
    ];
    const planned = p.filter((x) => x[3] >= cur).map(([label, category, amount, month]) => ({ id: uid(), type: 'expense', label, category, amount, month }));
    return { entries: e, planned };
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const name = `moneymanager-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Sauvegarde MoneyManager' }).catch(() => {});
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function applyTheme() {
    const th = state.settings.theme;
    if (th === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', th);
  }

  const handlers = {
    'month-prev': () => { ui.month = C.addMonths(ui.month, -1); render(); },
    'month-next': () => { ui.month = C.addMonths(ui.month, 1); render(); },
    'new-entry': () => openEntryForm('entry'),
    'edit-entry': (el) => openEntryForm('entry', state.entries.find((x) => x.id === el.dataset.id)),
    'new-planned': () => openEntryForm('planned'),
    'edit-planned': (el) => openEntryForm('planned', state.planned.find((x) => x.id === el.dataset.id)),
    'copy-recurring': () => {
      const labels = new Set(state.entries.filter((e) => e.month === ui.month).map((e) => e.label.toLowerCase()));
      const prev = C.addMonths(ui.month, -1);
      const add = state.entries.filter((e) => e.month === prev && e.recurring && !labels.has(e.label.toLowerCase()))
        .map((e) => ({ ...e, id: uid(), month: ui.month }));
      state.entries.push(...add); save(); render();
      toast(`${add.length} ligne(s) ajoutée(s) — modifiez les montants si besoin`);
    },
    realize: (el) => {
      const p = state.planned.find((x) => x.id === el.dataset.id);
      if (!p) return;
      state.entries.push({ id: uid(), month: p.month, type: p.type || 'expense', label: p.label, category: p.category, amount: p.amount, recurring: false });
      state.planned = state.planned.filter((x) => x !== p);
      save(); render(); toast('Ajoutée aux dépenses du mois');
    },
    'open-import': () => { ui.tab = 'import'; ui.imp = null; render(); window.scrollTo(0, 0); },
    'close-import': () => { ui.imp = null; ui.tab = 'month'; render(); window.scrollTo(0, 0); },
    'imp-all': (el) => { ui.imp.rows.forEach((r) => { if (!r.duplicate) r.include = el.dataset.v === '1'; }); render(); },
    'imp-confirm': confirmImport,
    'reset-rules': () => { if (confirm('Oublier toutes les règles de catégorisation apprises ?')) { state.importRules = {}; save(); render(); } },
    'toggle-variable': (el) => { state.settings.includeVariable = el.checked; save(); render(); },
    'tax-couple': (el) => {
      T().couple = el.dataset.v === '1';
      const p = num(T().parts);
      if (T().couple && p < 2) T().parts = 2;
      if (!T().couple && p === 2) T().parts = 1;
      save(); render();
    },
    'tax-mode': (el) => { T().declarants[Number(el.dataset.i)].forceMode = el.dataset.v; save(); render(); },
    'add-frais': (el) => { T().declarants[Number(el.dataset.i)].frais.autres.push({ label: '', amount: '' }); save(); render(); },
    'del-frais': (el) => { T().declarants[Number(el.dataset.i)].frais.autres.splice(Number(el.dataset.k), 1); save(); render(); },
    'estimate-salary': (el) => estimateSalary(Number(el.dataset.i)),
    'plan-regul': planRegul,
    'reset-params': () => { if (confirm('Rétablir les paramètres fiscaux par défaut ?')) { T().params = JSON.parse(JSON.stringify(C.DEFAULT_TAX_PARAMS)); save(); render(); } },
    theme: (el) => { state.settings.theme = el.dataset.v; save(); applyTheme(); render(); },
    export: exportData,
    demo: () => {
      if ((state.entries.length || state.planned.length) && !confirm('Remplacer vos données actuelles par l\'exemple ?')) return;
      Object.assign(state, demoData()); save(); render(); toast('Exemple chargé');
    },
    reset: () => {
      if (!confirm('Effacer toutes les données de cet appareil ? (pensez à exporter avant)')) return;
      state = defaultState(); save(); applyTheme(); render();
    },
  };

  document.addEventListener('click', (ev) => {
    const hit = ev.target.closest('.hit');
    if (hit) { showTip(hit, ev); return; }
    if (!ev.target.closest('#tooltip')) hideTip();
    const el = ev.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const h = handlers[el.dataset.action];
    if (h) h(el, ev);
  });
  document.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const hit = ev.target.closest && ev.target.closest('.hit');
    if (hit) showTip(hit, ev); else if (!tipEl().hidden) hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.action === 'toggle-variable') handlers['toggle-variable'](el);
    if (el.dataset.action === 'import' && el.files[0]) {
      el.files[0].text().then((txt) => {
        const s = JSON.parse(txt);
        if (!Array.isArray(s.entries)) throw new Error('fichier invalide');
        if (!confirm(`Importer ${s.entries.length} ligne(s) ? Les données actuelles seront remplacées.`)) return;
        localStorage.setItem(KEY, JSON.stringify(s));
        state = load(); applyTheme(); render(); toast('Import réussi');
      }).catch((e) => toast('Import impossible : ' + e.message));
    }
    if (el.dataset.bind && (el.tagName === 'SELECT' || el.type === 'checkbox')) bindInput(el);
    if (el.dataset.action === 'import-pdf' && el.files[0]) readStatement(el.files[0]);
    if (el.dataset.imp && ui.imp && ui.imp.rows) {
      const r = ui.imp.rows[Number(el.dataset.i)];
      if (el.dataset.imp === 'include') { r.include = el.checked; el.closest('li').style.opacity = el.checked ? '' : '.55'; }
      if (el.dataset.imp === 'recurring') r.recurring = el.checked;
      if (el.dataset.imp === 'category') r.category = el.value;
      const btn = document.getElementById('imp-confirm');
      if (btn) btn.textContent = importFooter();
    }
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.dataset.bind && ev.target.type !== 'checkbox' && ev.target.tagName !== 'SELECT') bindInput(ev.target);
  });

  function bindInput(el) {
    const path = el.dataset.bind;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (path.startsWith('tax.params.') || path === 'tax.year') v = num(v);
    setPath(path, v);
    save();
    const res = document.getElementById('tax-results');
    if (res) res.innerHTML = taxResults();
  }

  // ---------------------------------------------------------------- rendu

  const VIEWS = {
    month: ['Mois', viewMonth],
    history: ['Bilan', viewHistory],
    forecast: ['Prévisions', viewForecast],
    tax: ['Impôts', viewTax],
    settings: ['Réglages', viewSettings],
    import: ['Importer un relevé', viewImport],
  };
  function render() {
    hideTip();
    const [title, fn] = VIEWS[ui.tab];
    document.getElementById('view-title').textContent = title;
    document.getElementById('view').innerHTML = fn();
    const tabFor = ui.tab === 'import' ? 'month' : ui.tab;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabFor));
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
    ui.tab = b.dataset.tab;
    if (ui.tab === 'month') ui.month = ui.month || C.monthKey();
    render(); window.scrollTo(0, 0);
  }));

  applyTheme();
  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
