/* Shared helpers for the Chore Tracker and Kids Bank apps. */
(function (root) {
  'use strict';

  // ── Chores & weekly allowance rule ─────────────────────────────────────────
  const CHORES = {
    bed:    { label: 'Make bed',         icon: '🛏' },
    room:   { label: 'Clean room',       icon: '✨' },
    dishes: { label: 'Help with dishes', icon: '🍽' },
    other:  { label: 'Other',            icon: '📝' },
  };

  // To earn the weekly allowance a child needs ALL of these (edit here to change the rule).
  const REQUIREMENTS = [
    { id: 'room',   label: 'Clean room',       icon: '✨', test: c => c.room >= 1 },
    { id: 'dishes', label: 'Help with dishes', icon: '🍽', test: c => c.dishes >= 1 },
    { id: 'other',  label: 'One other task',   icon: '⭐', hint: 'make bed or other', test: c => c.bed + c.other >= 1 },
  ];

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');

  // ── Dates (weeks run Monday–Sunday, device local time) ─────────────────────
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { const p = String(s).slice(0, 10).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function weekStart(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return addDays(x, -((x.getDay() + 6) % 7));
  }
  function weekRangeLabel(ws) {
    const we = addDays(ws, 6);
    const left = ws.getDate() + (ws.getMonth() !== we.getMonth() ? ' ' + MONTHS[ws.getMonth()] : '');
    return left + ' – ' + we.getDate() + ' ' + MONTHS[we.getMonth()];
  }
  function formatDate(ts) {
    const d = new Date(ts);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function formatDay(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }

  function nextQuarterDate(now) {
    const d = new Date(now);
    for (const m of [0, 3, 6, 9]) if (m > d.getMonth()) return new Date(d.getFullYear(), m, 1);
    return new Date(d.getFullYear() + 1, 0, 1);
  }

  // ── Chore logic ────────────────────────────────────────────────────────────
  function logsInWeek(logs, ws) {
    const a = ws.getTime(), b = addDays(ws, 7).getTime();
    return logs.filter(l => { const t = new Date(l.done_at).getTime(); return t >= a && t < b; });
  }
  function countChores(logs) {
    const c = { bed: 0, room: 0, dishes: 0, other: 0 };
    logs.forEach(l => { if (c[l.chore] !== undefined) c[l.chore]++; });
    return c;
  }
  function evaluate(logs) {
    const counts = countChores(logs);
    const items = REQUIREMENTS.map(r => ({ id: r.id, label: r.label, icon: r.icon, hint: r.hint || '', done: !!r.test(counts) }));
    const doneCount = items.filter(i => i.done).length;
    return { counts, items, doneCount, ok: doneCount === items.length };
  }
  // Every fully finished Mon–Sun week from startWeek up to (not including) the current week.
  function completedWeeks(startWeek, now) {
    const out = [];
    let w = weekStart(parseYmd(startWeek));
    const cur = weekStart(now);
    while (w < cur) { out.push(w); w = addDays(w, 7); }
    return out;
  }

  // ── Misc ───────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n) { return '€' + Math.abs(Number(n)).toFixed(2); }

  function toast(msg) {
    if (typeof document === 'undefined') return;
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 4000);
  }

  // ── Supabase client, login, realtime ───────────────────────────────────────
  function createClient() {
    const c = root.APP_CONFIG || {};
    if (!c.SUPABASE_URL || /YOUR-PROJECT/.test(c.SUPABASE_URL) || !root.supabase) return null;
    return root.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }

  function overlay(id, html) {
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; el.className = 'login-overlay'; document.body.appendChild(el); }
    el.innerHTML = html;
    el.classList.remove('hidden');
    return el;
  }

  function showSetupNeeded() {
    overlay('setupOverlay',
      '<div class="login-card"><div class="login-emoji">🔧</div><h2>Almost there</h2>' +
      '<p class="login-text">Add your Supabase project URL and anon key to <b>shared/config.js</b>, then reload.</p></div>');
  }

  function initAuth(client, onSignedIn, onSignedOut) {
    let signedIn = false;

    function showLogin() {
      const el = overlay('loginOverlay',
        '<form class="login-card" autocomplete="on">' +
        '<div class="login-emoji">🔐</div><h2>Family sign-in</h2>' +
        '<input class="login-input" name="email" type="email" autocomplete="username" autocapitalize="none" placeholder="Email" required>' +
        '<input class="login-input" name="password" type="password" autocomplete="current-password" placeholder="Password" required>' +
        '<div class="login-error" id="loginError"></div>' +
        '<button class="login-btn" type="submit">Sign in</button></form>');
      el.querySelector('form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const btn = f.querySelector('button');
        btn.disabled = true;
        const { error } = await client.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
        btn.disabled = false;
        if (error) { document.getElementById('loginError').textContent = 'Wrong email or password.'; return; }
        enter();
      });
    }
    async function enter() {
      if (signedIn) return;
      signedIn = true;
      const el = document.getElementById('loginOverlay');
      if (el) el.classList.add('hidden');
      await onSignedIn();
    }

    client.auth.getSession().then(({ data }) => { data && data.session ? enter() : showLogin(); });
    client.auth.onAuthStateChange(evt => {
      if (evt === 'SIGNED_OUT') { signedIn = false; showLogin(); if (onSignedOut) onSignedOut(); }
    });
  }

  function subscribe(client, tables, cb) {
    let timer;
    const fire = () => { clearTimeout(timer); timer = setTimeout(cb, 250); };
    const ch = client.channel('db-' + Math.random().toString(36).slice(2));
    tables.forEach(table => ch.on('postgres_changes', { event: '*', schema: 'public', table }, fire));
    ch.subscribe();
    // iPads suspend background apps: refresh when the app comes back to the foreground
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fire(); });
    return ch;
  }

  const api = {
    CHORES, REQUIREMENTS, DAYS, MONTHS,
    ymd, parseYmd, addDays, weekStart, weekRangeLabel, formatDate, formatDay, nextQuarterDate,
    logsInWeek, countChores, evaluate, completedWeeks,
    esc, money, toast, createClient, showSetupNeeded, initAuth, subscribe,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
