'use strict';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const { evaluate, esc, ymd, parseYmd, weekStart, addDays, weekRangeLabel, logsInWeek, completedWeeks,
        formatDate, formatDay, nextQuarterDate, money } = Core;

const BG = ['#1e3a5c', '#2d1e5c', '#1e5c3a', '#5c3a1e'];
const TX_META = {
  deposit:   { icon: '⬆️', cls: 'deposit',   sign: +1, label: 'Deposit' },
  spend:     { icon: '🛍',  cls: 'spend',     sign: -1, label: 'Spend' },
  donate:    { icon: '💝',  cls: 'donate',    sign: -1, label: 'Donate' },
  interest:  { icon: '📈',  cls: 'interest',  sign: +1, label: 'Interest' },
  allowance: { icon: '🎉',  cls: 'allowance', sign: +1, label: 'Allowance' },
  opening:   { icon: '🏦',  cls: 'opening',   sign: +1, label: 'Opening balance' },
};
const ECB_URL = 'https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=jsondata&lastNObservations=1';

const client = Core.createClient();
let children = [];
let settings = null;
let txs = [];
let choreLogs = [];
let allowances = [];
let activeChild = null;
try { activeChild = localStorage.getItem('bankActiveChild'); } catch (e) {}   // remembered per device
let subscribed = false;

const $ = id => document.getElementById(id);
const fmtSigned = n => (n >= 0 ? '+€' : '-€') + Math.abs(n).toFixed(2);
const childBg = idx => BG[idx % BG.length];

// ── Data ──────────────────────────────────────────────────────────────────────
async function loadAll() {
  const [c, s] = await Promise.all([
    client.from('children').select('*').order('sort'),
    client.from('settings').select('*').eq('id', 1).single(),
  ]);
  if (c.error || s.error) { Core.toast('⚠️ ' + ((c.error || s.error).message || 'Can’t reach the server')); return false; }
  children = c.data;
  settings = s.data;
  if (!activeChild || !children.some(x => x.id === activeChild)) activeChild = children[0] && children[0].id;

  const since = parseYmd(settings.start_week).toISOString();
  const [t, l, a] = await Promise.all([
    client.from('transactions').select('*').order('occurred_at', { ascending: true }).limit(5000),
    client.from('chore_log').select('child_id,chore,done_at').gte('done_at', since).limit(5000),
    client.from('allowances').select('*'),
  ]);
  if (t.error || l.error || a.error) { Core.toast('⚠️ ' + ((t.error || l.error || a.error).message || 'Can’t reach the server')); return false; }
  txs = t.data; choreLogs = l.data; allowances = a.data;
  render();
  return true;
}

async function refreshRate() {
  try {
    const res = await fetch(ECB_URL);
    if (!res.ok) throw new Error('ecb');
    const json = await res.json();
    const series = Object.values(json.dataSets[0].series)[0];
    const obs = series.observations;
    const last = Object.keys(obs).sort((a, b) => Number(a) - Number(b)).pop();
    const rate = parseFloat(obs[last][0]);
    if (isFinite(rate) && Math.abs(rate - Number(settings.ecb_rate)) > 0.0001) {
      const { error } = await client.from('settings')
        .update({ ecb_rate: rate, ecb_rate_updated: new Date().toISOString() }).eq('id', 1);
      if (!error) settings.ecb_rate = rate;
    }
  } catch (e) { /* keep the last stored rate */ }
}

async function boot() {
  if (!(await loadAll())) return;
  if (!subscribed) {
    subscribed = true;
    Core.subscribe(client, ['transactions', 'chore_log', 'allowances', 'children', 'settings'], loadAll);
  }
  await refreshPinStatus();
  await refreshRate();
  const { data: paid } = await client.rpc('catch_up_interest');
  if (paid > 0) { await loadAll(); Core.toast('📈 Quarterly interest paid'); }
  else render();
}

// ── Derived data ──────────────────────────────────────────────────────────────
function txsFor(childId) { return txs.filter(t => t.child_id === childId); }
function balanceOf(childId) { return Math.round(txsFor(childId).reduce((s, t) => s + Number(t.amount), 0) * 100) / 100; }

function weekStatuses(childId) {
  const mine = choreLogs.filter(l => l.child_id === childId);
  const paidSet = new Set(allowances.filter(a => a.child_id === childId).map(a => a.week_start));
  return completedWeeks(settings.start_week, new Date()).map(w => {
    const ev = evaluate(logsInWeek(mine, w));
    const key = ymd(w);
    const state = paidSet.has(key) ? 'paid' : ev.ok ? 'pending' : 'missed';
    return { week: w, key, ev, state };
  });
}
function pendingFor(childId) { return weekStatuses(childId).filter(w => w.state === 'pending'); }
function pendingTotal() { return children.reduce((n, c) => n + pendingFor(c.id).length, 0); }

// ── Transaction modal ─────────────────────────────────────────────────────────
let txType = 'deposit';

function openTxModal(childId, type) {
  activeChild = childId;
  txType = type || 'deposit';
  const child = children.find(c => c.id === childId);
  $('txModalTitle').textContent = child.name + '’s Account';
  $('txAmount').value = '';
  $('txNote').value = '';
  document.querySelectorAll('.tx-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === txType));
  $('txModal').classList.remove('hidden');
  setTimeout(() => $('txAmount').focus(), 150);
}
function closeTxModal() { $('txModal').classList.add('hidden'); }

async function confirmTx() {
  const amount = parseFloat($('txAmount').value);
  const note = $('txNote').value.trim();
  if (!amount || amount <= 0) { Core.toast('Please enter a valid amount.'); return; }
  const meta = TX_META[txType];
  const delta = Math.round(amount * meta.sign * 100) / 100;
  if (delta < 0 && balanceOf(activeChild) + delta < 0) { Core.toast('Not enough balance!'); return; }
  const { error } = await client.from('transactions')
    .insert({ child_id: activeChild, type: txType, amount: delta, note: note || meta.label });
  if (error) { Core.toast('⚠️ Couldn’t save — check the internet'); return; }
  closeTxModal();
  await loadAll();
  const child = children.find(c => c.id === activeChild);
  Core.toast(meta.icon + ' ' + money(amount) + ' ' + (meta.sign > 0 ? 'added to ' : 'taken from ') + child.name + '’s account');
}

// ── Opening balance ───────────────────────────────────────────────────────────
function openOpeningModal() {
  $('openingAmount').value = '';
  $('openingModal').classList.remove('hidden');
  setTimeout(() => $('openingAmount').focus(), 150);
}
function closeOpeningModal() { $('openingModal').classList.add('hidden'); }

async function confirmOpening() {
  const amount = parseFloat($('openingAmount').value);
  if (isNaN(amount) || amount < 0) { Core.toast('Please enter a valid amount.'); return; }
  const id = activeChild;
  const del = await client.from('transactions').delete().eq('child_id', id).eq('type', 'opening');
  if (del.error) { Core.toast('⚠️ Couldn’t save — check the internet'); return; }
  if (amount > 0) {
    const ins = await client.from('transactions')
      .insert({ child_id: id, type: 'opening', amount: Math.round(amount * 100) / 100, note: 'Opening balance' });
    if (ins.error) { Core.toast('⚠️ Couldn’t save — check the internet'); return; }
  }
  closeOpeningModal();
  await loadAll();
  Core.toast('🏦 Opening balance set to ' + money(amount));
}

// ── Parent PIN ────────────────────────────────────────────────────────────────
// The PIN is checked on the server (never in this file), so it can't be read or bypassed here.
let pinSet = false;
let pinAction = null;       // { run(pin) -> rpc result, onOk(code) }
let setPinThen = null;      // what to do after a PIN has just been created

const PIN_MESSAGES = {
  bad_pin: 'Wrong PIN. Try again.',
  locked: 'Too many wrong tries. Try again in 15 minutes.',
  no_pin: 'No parent PIN is set yet.',
  not_eligible: 'That week doesn’t qualify for an allowance.',
  bad_week: 'That week can’t be approved.',
  invalid: 'The PIN must be 4–8 digits.',
};
const isPin = s => /^[0-9]{4,8}$/.test(s);

async function refreshPinStatus() {
  const { data, error } = await client.rpc('parent_pin_is_set');
  if (!error) pinSet = data === true;
}

function openPinModal(opts) {
  pinAction = { run: opts.run, onOk: opts.onOk };
  $('pinTitle').textContent = opts.title;
  $('pinText').textContent = opts.text;
  $('pinConfirm').textContent = opts.confirmLabel || 'Confirm';
  $('pinInput').value = '';
  $('pinError').textContent = '';
  $('pinModal').classList.remove('hidden');
  setTimeout(() => $('pinInput').focus(), 150);
}
function closePinModal() {
  $('pinModal').classList.add('hidden');
  $('pinInput').value = '';
  pinAction = null;
}

async function confirmPin() {
  if (!pinAction) return;
  const pin = $('pinInput').value.trim();
  if (!isPin(pin)) { $('pinError').textContent = 'Enter your 4–8 digit PIN.'; return; }
  const btn = $('pinConfirm');
  btn.disabled = true;
  const { data, error } = await pinAction.run(pin);
  btn.disabled = false;
  if (error) { $('pinError').textContent = 'Server error: ' + (error.message || 'check the internet'); return; }
  if (data === 'ok' || data === 'already') {
    const act = pinAction;
    closePinModal();
    await act.onOk(data);
    return;
  }
  $('pinError').textContent = PIN_MESSAGES[data] || 'Something went wrong. Try again.';
  $('pinInput').value = '';
  if (data === 'not_eligible' || data === 'bad_week') { await loadAll(); return; }
  $('pinInput').focus();
}

function openSetPinModal(opts) {
  opts = opts || {};
  setPinThen = opts.then || null;
  $('setPinTitle').textContent = pinSet ? 'Change parent PIN' : 'Create parent PIN';
  $('setPinText').textContent = opts.intro ||
    (pinSet ? 'Enter your current PIN, then choose a new one.'
            : 'Choose a 4–8 digit PIN. You’ll enter it to approve allowances.');
  $('oldPinGroup').classList.toggle('hidden', !pinSet);
  ['oldPin', 'newPin', 'newPin2'].forEach(id => { $(id).value = ''; });
  $('setPinError').textContent = '';
  $('setPinModal').classList.remove('hidden');
  setTimeout(() => $(pinSet ? 'oldPin' : 'newPin').focus(), 150);
}
function closeSetPinModal() { $('setPinModal').classList.add('hidden'); setPinThen = null; }

async function confirmSetPin() {
  const oldv = $('oldPin').value.trim(), n1 = $('newPin').value.trim(), n2 = $('newPin2').value.trim();
  const err = $('setPinError');
  if (pinSet && !isPin(oldv)) { err.textContent = 'Enter your current PIN.'; return; }
  if (!isPin(n1)) { err.textContent = 'The new PIN must be 4–8 digits.'; return; }
  if (n1 !== n2) { err.textContent = 'The two new PINs don’t match.'; return; }
  const btn = $('setPinConfirm');
  btn.disabled = true;
  const { data, error } = await client.rpc('set_parent_pin', { p_new: n1, p_old: pinSet ? oldv : null });
  btn.disabled = false;
  if (error) { err.textContent = 'Server error: ' + (error.message || 'check the internet'); return; }
  if (data === 'ok') {
    const then = setPinThen;
    pinSet = true;
    closeSetPinModal();
    Core.toast('🔐 Parent PIN saved');
    if (then) then();
    return;
  }
  err.textContent = data === 'bad_pin' ? 'Current PIN is wrong.' : (PIN_MESSAGES[data] || 'Something went wrong.');
  if (data === 'bad_pin') { $('oldPin').value = ''; }
}

// ── Allowance approval (PIN required) ─────────────────────────────────────────
async function openAllowanceModal(childId, weekKey) {
  await refreshPinStatus();
  if (!pinSet) {
    openSetPinModal({
      intro: 'First, create a parent PIN. You’ll enter it each time you approve an allowance.',
      then: () => openAllowanceModal(childId, weekKey),
    });
    return;
  }
  const child = children.find(c => c.id === childId);
  const amount = money(settings.allowance_amount);
  openPinModal({
    title: 'Approve allowance',
    text: child.name + ' completed all chores for the week of ' + weekRangeLabel(parseYmd(weekKey)) +
          '. Enter your PIN to pay ' + amount + '.',
    confirmLabel: 'Pay ' + amount,
    run: pin => client.rpc('approve_allowance', { p_child: childId, p_week: weekKey, p_pin: pin }),
    onOk: async code => {
      await loadAll();
      Core.toast(code === 'already' ? 'That week was already paid.' : '🎉 ' + amount + ' paid to ' + child.name + '!');
    },
  });
}

// ── Remove a transaction ──────────────────────────────────────────────────────
async function removeTx(id) {
  const tx = txs.find(t => t.id === id);
  if (!tx || tx.type === 'interest') return;
  if (tx.type === 'allowance') {
    // Undoing a paid allowance also needs the parent PIN
    await refreshPinStatus();
    if (!pinSet) { Core.toast('Create a parent PIN first (Parent PIN, at the bottom).'); return; }
    openPinModal({
      title: 'Undo allowance',
      text: 'Remove this ' + money(tx.amount) + ' allowance? That week goes back to “to approve”.',
      confirmLabel: 'Remove',
      run: pin => client.rpc('remove_allowance', { p_tx: id, p_pin: pin }),
      onOk: async () => { await loadAll(); Core.toast('Removed — that week is waiting for approval again.'); },
    });
    return;
  }
  const { error } = await client.from('transactions').delete().eq('id', id);
  if (error) { Core.toast('⚠️ Couldn’t remove — check the internet'); return; }
  await loadAll();
  Core.toast(tx.type === 'allowance' ? 'Removed — that week is pending again.' : 'Transaction removed.');
}

// ── Chart ─────────────────────────────────────────────────────────────────────
function drawChart(canvas, list) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 300;
  const H = 110;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const sorted = [...list].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  if (!sorted.length) {
    ctx.fillStyle = 'rgba(148,180,212,0.4)';
    ctx.font = '12px -apple-system';
    ctx.textAlign = 'center';
    ctx.fillText('No transactions yet', W / 2, H / 2);
    return;
  }
  const pts = [{ ts: new Date(sorted[0].occurred_at).getTime(), bal: 0 }];
  let run = 0;
  sorted.forEach(t => {
    run = Math.max(0, Math.round((run + Number(t.amount)) * 100) / 100);
    pts.push({ ts: new Date(t.occurred_at).getTime(), bal: run });
  });
  pts.push({ ts: Date.now(), bal: run });

  const minTs = pts[0].ts, maxTs = pts[pts.length - 1].ts;
  const maxBal = Math.max(...pts.map(p => p.bal), 0.01);
  const pad = { top: 10, right: 10, bottom: 22, left: 44 };
  const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
  const toX = ts => pad.left + ((ts - minTs) / (maxTs - minTs || 1)) * cw;
  const toY = b => pad.top + (1 - b / maxBal) * ch;

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach(f => {
    const y = pad.top + f * ch;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
  });
  ctx.fillStyle = 'rgba(148,180,212,0.6)';
  ctx.font = '10px -apple-system';
  ctx.textAlign = 'right';
  [0, 0.5, 1].forEach(f => {
    const v = maxBal * (1 - f);
    ctx.fillText('€' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)), pad.left - 4, pad.top + f * ch + 4);
  });

  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(79,156,249,0.3)');
  grad.addColorStop(1, 'rgba(79,156,249,0.02)');
  ctx.beginPath();
  ctx.moveTo(toX(pts[0].ts), toY(pts[0].bal));
  pts.forEach(p => ctx.lineTo(toX(p.ts), toY(p.bal)));
  ctx.lineTo(toX(pts[pts.length - 1].ts), toY(0));
  ctx.lineTo(toX(pts[0].ts), toY(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = '#4f9cf9';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(toX(p.ts), toY(p.bal)) : ctx.lineTo(toX(p.ts), toY(p.bal)));
  ctx.stroke();

  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(toX(last.ts), toY(last.bal), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#4f9cf9';
  ctx.fill();
  ctx.strokeStyle = '#0b1929';
  ctx.lineWidth = 2;
  ctx.stroke();

  const M = Core.MONTHS;
  ctx.fillStyle = 'rgba(148,180,212,0.5)';
  ctx.textAlign = 'left';
  const d0 = new Date(minTs), d1 = new Date(maxTs);
  ctx.fillText(d0.getDate() + ' ' + M[d0.getMonth()], pad.left, H - 5);
  ctx.textAlign = 'right';
  ctx.fillText(d1.getDate() + ' ' + M[d1.getMonth()], pad.left + cw, H - 5);
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderHeader() {
  const rate = settings ? Number(settings.ecb_rate) : null;
  $('rateLabel').textContent = rate === null ? 'Loading…'
    : 'ECB rate ' + rate.toFixed(2) + '% p.a. · interest paid Jan/Apr/Jul/Oct';
  $('nextBadge').textContent = 'Next interest\n' + formatDay(nextQuarterDate(new Date()));

  const n = settings ? pendingTotal() : 0;
  const badge = $('pendingBadge');
  badge.classList.toggle('hidden', n === 0);
  badge.textContent = '💰 ' + n + ' to approve';

  try { if (activeChild) localStorage.setItem('bankActiveChild', activeChild); } catch (e) {}
  const tabs = $('accountTabs');
  tabs.innerHTML = '';
  children.forEach((child, i) => {
    const btn = document.createElement('button');
    btn.className = 'account-tab' + (child.id === activeChild ? ' active' : '');
    btn.innerHTML =
      '<div class="tab-avatar" style="background:' + childBg(i) + ';">' + esc(child.emoji) + '</div>' +
      '<div class="tab-info"><div class="tab-name">' + esc(child.name) + '</div>' +
      '<div class="tab-balance">' + money(balanceOf(child.id)) + '</div></div>' +
      (pendingFor(child.id).length ? '<span class="tab-dot"></span>' : '');
    btn.addEventListener('click', () => { activeChild = child.id; render(); });
    tabs.appendChild(btn);
  });
}

function renderMain() {
  const idx = children.findIndex(c => c.id === activeChild);
  const child = children[idx];
  if (!child) { $('mainContent').innerHTML = ''; return; }
  const mine = txsFor(child.id);
  const bal = balanceOf(child.id);
  const [euros, cents] = bal.toFixed(2).split('.');
  const amount = money(settings.allowance_amount);

  // Pending allowance cards
  const pending = pendingFor(child.id);
  const pendingHTML = pending.map(p =>
    '<div class="allow-card">' +
      '<div class="allow-top"><div><div class="allow-title">🎉 Allowance earned</div>' +
      '<div class="allow-week">Week of ' + weekRangeLabel(p.week) + '</div></div>' +
      '<div class="allow-title">' + amount + '</div></div>' +
      '<div class="allow-ticks">' + p.ev.items.map(i => '<span class="ok">✓ ' + esc(i.label) + '</span>').join('') + '</div>' +
      '<button class="allow-approve" data-approve-week="' + p.key + '">Approve ' + amount + '</button>' +
    '</div>').join('');

  // Weekly summary: this week + recent completed weeks
  const now = new Date();
  const thisWs = weekStart(now);
  const mineLogs = choreLogs.filter(l => l.child_id === child.id);
  const cur = evaluate(logsInWeek(mineLogs, thisWs));
  const past = weekStatuses(child.id).slice(-4).reverse();
  const stateLabel = { paid: '💸 Paid', pending: '⏳ To approve', missed: 'Not earned' };
  const weekRows =
    '<div class="week-row"><div><div class="week-row-label">This week · ' + weekRangeLabel(thisWs) + '</div>' +
      '<div class="week-row-sub">' + cur.items.map(i => (i.done ? '✓ ' : '○ ') + esc(i.label)).join('  ·  ') + '</div></div>' +
      '<div class="week-state ' + (cur.ok ? 'pending' : 'now') + '">' + (cur.ok ? 'Earned ✓' : cur.doneCount + '/' + cur.items.length + ' done') + '</div></div>' +
    past.map(w =>
      '<div class="week-row"><div><div class="week-row-label">' + weekRangeLabel(w.week) + '</div>' +
        '<div class="week-row-sub">' + w.ev.items.map(i => (i.done ? '✓ ' : '○ ') + esc(i.label)).join('  ·  ') + '</div></div>' +
        '<div class="week-state ' + w.state + '">' + stateLabel[w.state] + '</div></div>').join('');

  // Statement with running balance
  let run = 0;
  const runMap = {};
  mine.forEach(t => { run = Math.round((run + Number(t.amount)) * 100) / 100; runMap[t.id] = Math.max(0, run); });
  const rows = mine.length
    ? [...mine].reverse().slice(0, 30).map(t => {
        const meta = TX_META[t.type] || { icon: '💳', cls: 'deposit', label: t.type };
        const cr = Number(t.amount) >= 0;
        return '<div class="tx-row"><div class="tx-icon-wrap ' + meta.cls + '">' + meta.icon + '</div>' +
          '<div class="tx-body"><div class="tx-desc">' + esc(t.note || meta.label) + '</div>' +
          '<div class="tx-date-str">' + formatDate(t.occurred_at) + '</div></div>' +
          '<div class="tx-right"><div class="tx-amount ' + (cr ? 'cr' : 'dr') + '">' + fmtSigned(Number(t.amount)) + '</div>' +
          '<div class="tx-running-bal">Bal: ' + money(runMap[t.id]) + '</div></div>' +
          (t.type === 'interest' ? '<span style="width:28px;flex-shrink:0;"></span>'
            : '<button class="tx-remove-btn" data-remove="' + t.id + '">×</button>') + '</div>';
      }).join('')
    : '<div class="empty-state">No transactions yet.<br>Use the buttons above to get started.</div>';

  $('mainContent').innerHTML =
    '<div class="hero-card">' +
      '<div class="hero-top"><div><div class="hero-account-label">Savings Account</div><div class="hero-name">' + esc(child.name) + '</div></div>' +
      '<div class="hero-avatar" style="background:' + childBg(idx) + ';">' + esc(child.emoji) + '</div></div>' +
      '<div class="hero-balance-label">Available Balance</div>' +
      '<div class="hero-balance">€' + euros + '<span class="cents">.' + cents + '</span></div>' +
      '<div class="hero-meta">' +
        '<div class="hero-meta-item"><div class="hero-meta-label">Interest rate</div><div class="hero-meta-value">' + Number(settings.ecb_rate).toFixed(2) + '% p.a.</div></div>' +
        '<div class="hero-meta-item"><div class="hero-meta-label">Next interest</div><div class="hero-meta-value">' + formatDay(nextQuarterDate(now)) + '</div></div>' +
        '<div class="hero-meta-item"><div class="hero-meta-label">Weekly allowance</div><div class="hero-meta-value">' + amount + '</div></div>' +
      '</div>' +
    '</div>' +
    (pendingHTML ? '<div class="section"><div class="section-header"><div class="section-title">Waiting for approval</div></div>' + pendingHTML + '</div>' : '') +
    '<div class="quick-actions">' +
      '<button class="quick-btn deposit" data-action="deposit"><div class="quick-icon">⬆️</div><div class="quick-label">Deposit</div></button>' +
      '<button class="quick-btn spend" data-action="spend"><div class="quick-icon">🛍</div><div class="quick-label">Spend</div></button>' +
      '<button class="quick-btn donate" data-action="donate"><div class="quick-icon">💝</div><div class="quick-label">Donate</div></button>' +
      '<button class="quick-btn opening" data-opening="1"><div class="quick-icon">🏦</div><div class="quick-label">Set Opening</div></button>' +
    '</div>' +
    '<div class="section"><div class="section-header"><div class="section-title">Balance History</div></div>' +
      '<div class="chart-card"><canvas class="balance-chart" id="balChart" style="height:110px;"></canvas></div></div>' +
    '<div class="section"><div class="section-header"><div class="section-title">Weekly chores</div></div>' +
      '<div class="week-card">' + weekRows + '</div></div>' +
    '<div class="section"><div class="section-header"><div class="section-title">Statement</div></div>' +
      '<div class="statement-card">' + rows + '</div></div>';

  requestAnimationFrame(() => drawChart($('balChart'), mine));
}

function render() {
  if (!settings) return;
  renderHeader();
  renderMain();
}

// ── Sanity check: the page (index.html) must match this script ───────────────
(function () {
  const need = ['mainContent', 'accountTabs', 'pendingBadge', 'pinSettings', 'signOut', 'pinModal', 'setPinModal', 'rateLabel'];
  const missing = need.filter(id => !document.getElementById(id));
  if (missing.length) {
    document.body.innerHTML = '<div style="padding:24px;font:18px/1.5 -apple-system,sans-serif;color:#fff;background:#0b1a33;min-height:100vh">' +
      '<h2>Bank page is out of date</h2><p>index.html is missing: <b>' + missing.join(', ') + '</b>.</p>' +
      '<p>Replace bank/index.html in the repo with the latest version, wait a minute, then reload.</p></div>';
    throw new Error('bank/index.html is missing: ' + missing.join(', '));
  }
})();

// ── Events ────────────────────────────────────────────────────────────────────
$('mainContent').addEventListener('click', e => {
  const act = e.target.closest('[data-action]');
  if (act) return openTxModal(activeChild, act.dataset.action);
  if (e.target.closest('[data-opening]')) return openOpeningModal();
  const ap = e.target.closest('[data-approve-week]');
  if (ap) return openAllowanceModal(activeChild, ap.dataset.approveWeek);
  const rm = e.target.closest('[data-remove]');
  if (rm) return removeTx(rm.dataset.remove);
});

$('pendingBadge').addEventListener('click', () => {
  const c = children.find(ch => pendingFor(ch.id).length);
  if (c) { activeChild = c.id; render(); window.scrollTo(0, 0); }
});
$('signOut').addEventListener('click', () => { client && client.auth.signOut(); });
$('pinSettings').addEventListener('click', async () => { await refreshPinStatus(); openSetPinModal(); });
$('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') confirmPin(); });
['oldPin', 'newPin', 'newPin2'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') confirmSetPin(); }));

document.querySelectorAll('.tx-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    txType = btn.dataset.type;
    document.querySelectorAll('.tx-type-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});
['txModal', 'openingModal'].forEach(id => {
  $(id).addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });
});
$('pinModal').addEventListener('click', function (e) { if (e.target === this) closePinModal(); });
$('setPinModal').addEventListener('click', function (e) { if (e.target === this) closeSetPinModal(); });

// ── Start ─────────────────────────────────────────────────────────────────────
if (!client) Core.showSetupNeeded();
else Core.initAuth(client, boot);
