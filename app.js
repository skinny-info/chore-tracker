'use strict';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── iOS install banner ────────────────────────────────────────────────────────
(function () {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = ('standalone' in navigator) && navigator.standalone;
  let dismissed = false;
  try { dismissed = !!localStorage.getItem('installBannerDismissed'); } catch (e) {}
  if (isIos && !isStandalone && !dismissed) {
    document.getElementById('installBanner').classList.remove('hidden');
  }
})();
function dismissBanner() {
  document.getElementById('installBanner').classList.add('hidden');
  try { localStorage.setItem('installBannerDismissed', '1'); } catch (e) {}
}

// ── Setup ─────────────────────────────────────────────────────────────────────
const { CHORES, evaluate, esc, ymd, weekStart, addDays, weekRangeLabel, logsInWeek, formatDate } = Core;

const AVATAR_EMOJIS = [
  '😀','😄','😎','🤩','🥳','😇','🤠','🦊','🐱','🐶',
  '🐼','🐨','🐸','🦁','🐯','🦄','🐙','🦋','🌟','⚡',
  '🍕','🍦','🎮','🎨','🏆','🚀','🎸','🌈','💎','🔥',
];
const AVATAR_BG = ['#E6F1FB', '#EEEDFE', '#E1F5EE', '#FAEEDA'];

const client = Core.createClient();
let children = [];
let logs = [];
let allowances = [];
let weekOffset = 0;            // 0 = this week, -1 = last week, …
const otherOpen = {};          // which child has the "One other task" text box open
const drafts = {};             // text typed into "Other" boxes, kept across re-renders
const lockUntil = {};          // short per-child lock against accidental double taps
let subscribed = false;
let avatarTargetId = null;

const $ = id => document.getElementById(id);

function viewWeekStart() { return addDays(weekStart(new Date()), weekOffset * 7); }

// ── Data ──────────────────────────────────────────────────────────────────────
async function loadChildren() {
  const { data, error } = await client.from('children').select('*').order('sort');
  if (error) { Core.toast('⚠️ ' + (error.message || 'Can’t reach the server')); return false; }
  children = data;
  return true;
}

async function loadWeek() {
  const ws = viewWeekStart();
  const we = addDays(ws, 7);
  const [l, a] = await Promise.all([
    client.from('chore_log').select('*')
      .gte('done_at', ws.toISOString()).lt('done_at', we.toISOString())
      .order('done_at', { ascending: false }),
    client.from('allowances').select('*').eq('week_start', ymd(ws)),
  ]);
  if (l.error || a.error) { Core.toast('⚠️ ' + ((l.error || a.error).message || 'Can’t reach the server')); return; }
  logs = l.data;
  allowances = a.data;
  render();
}

async function reloadAll() {
  if (await loadChildren()) await loadWeek();
}

async function boot() {
  await reloadAll();
  if (!subscribed) {
    subscribed = true;
    Core.subscribe(client, ['chore_log', 'allowances', 'children'], reloadAll);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function addLog(childId, chore, note) {
  if (weekOffset !== 0) return;
  if (Date.now() < (lockUntil[childId] || 0)) return;
  lockUntil[childId] = Date.now() + 400;

  const child = children.find(c => c.id === childId);
  const before = evaluate(logs.filter(l => l.child_id === childId)).ok;
  const { error } = await client.from('chore_log').insert({ child_id: childId, chore, note: note || null });
  if (error) { Core.toast('⚠️ Couldn’t save — check the internet'); return; }
  await loadWeek();
  popCard(childId);
  const after = evaluate(logs.filter(l => l.child_id === childId)).ok;
  if (!before && after) Core.toast('🎉 ' + child.name + ' earned this week’s allowance!');
}

async function removeLog(id) {
  if (weekOffset !== 0) return;
  const { error } = await client.from('chore_log').delete().eq('id', id);
  if (error) { Core.toast('⚠️ Couldn’t remove — check the internet'); return; }
  await loadWeek();
  Core.toast('Chore removed.');
}

// ── Edit what an "Other" chore was ────────────────────────────────────────────
let editLogId = null;

function openEditModal(id) {
  const l = logs.find(x => x.id === id);
  if (!l || weekOffset !== 0) return;
  editLogId = id;
  $('editInput').value = l.note || '';
  $('editModal').classList.remove('hidden');
  setTimeout(() => $('editInput').focus(), 150);
}
function closeEditModal() {
  $('editModal').classList.add('hidden');
  editLogId = null;
}
async function saveEdit() {
  if (!editLogId) return;
  const text = $('editInput').value.trim();
  if (!text) { Core.toast('Type what you did first.'); return; }
  const id = editLogId;
  const { error } = await client.from('chore_log').update({ note: text }).eq('id', id);
  if (error) { Core.toast('⚠️ Couldn’t save — check the internet'); return; }
  closeEditModal();
  await loadWeek();
  Core.toast('Saved ✓');
}
$('editModal').addEventListener('click', function (e) { if (e.target === this) closeEditModal(); });
$('editInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveEdit(); });

async function pickEmoji(em) {
  if (!avatarTargetId) return;
  const id = avatarTargetId;
  closeAvatarModal();
  const { error } = await client.from('children').update({ emoji: em }).eq('id', id);
  if (error) { Core.toast('⚠️ Couldn’t save avatar'); return; }
  await loadChildren();
  render();
}

function openAvatarModal(childId) {
  avatarTargetId = childId;
  const child = children.find(c => c.id === childId);
  const grid = $('emojiGrid');
  grid.innerHTML = '';
  AVATAR_EMOJIS.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'emoji-option' + (em === child.emoji ? ' selected' : '');
    btn.textContent = em;
    btn.addEventListener('click', () => pickEmoji(em));
    grid.appendChild(btn);
  });
  $('avatarModal').classList.remove('hidden');
}
function closeAvatarModal() {
  $('avatarModal').classList.add('hidden');
  avatarTargetId = null;
}
$('avatarModal').addEventListener('click', function (e) { if (e.target === this) closeAvatarModal(); });

function popCard(childId) {
  const card = document.querySelector('[data-card="' + childId + '"]');
  if (card) { card.classList.remove('popped'); void card.offsetWidth; card.classList.add('popped'); }
}

// ── Render ────────────────────────────────────────────────────────────────────
function cardHTML(child, idx, isCurrent) {
  const mine = logs.filter(l => l.child_id === child.id);
  const ev = evaluate(mine);
  const paid = allowances.find(a => a.child_id === child.id);

  let status;
  if (paid) status = { cls: 'paid', text: '💸 €' + Number(paid.amount).toFixed(2) + ' paid' };
  else if (ev.ok) status = { cls: 'earned', text: isCurrent ? '🎉 Allowance earned!' : '⏳ Earned — waiting for approval' };
  else if (isCurrent) status = { cls: '', text: ev.doneCount + ' of ' + ev.items.length + ' done' };
  else status = { cls: 'missed', text: 'Not earned this week' };

  const logId = { room: 'room', dishes: 'dishes' };
  const reqs = ev.items.map(i => {
    const n = i.id === 'other' ? ev.counts.bed + ev.counts.other : ev.counts[i.id];
    const inner = '<span class="req-check">' + (i.done ? '✓' : '') + '</span>' +
      '<span class="req-label">' + i.icon + ' ' + esc(i.label) + '</span>' +
      (isCurrent ? (n > 1 ? '<span class="chore-count">×' + n + '</span>' : '') + '<span class="req-plus">+</span>' : '');
    const row = isCurrent
      ? '<button class="req' + (i.done ? ' done' : '') + '" data-req="' + i.id + '" data-child="' + child.id + '">' + inner + '</button>'
      : '<div class="req' + (i.done ? ' done' : '') + '">' + inner + '</div>';
    const box = isCurrent && i.id === 'other' && otherOpen[child.id]
      ? '<div class="other-row"><span class="other-icon">📝</span>' +
        '<input class="other-input" type="text" placeholder="e.g. fed the dog" maxlength="30" enterkeyhint="done" data-child="' + child.id + '" value="' + esc(drafts[child.id] || '') + '">' +
        '<button class="other-submit" data-other="' + child.id + '"' + ((drafts[child.id] || '').trim() ? '' : ' disabled') + '>+</button></div>'
      : '';
    return row + box;
  }).join('');

  const buttons = isCurrent ? '' : '<p class="past-note">Past week — view only.</p>';

  const history = mine.length
    ? mine.map(l => {
        const ch = CHORES[l.chore] || CHORES.other;
        const label = l.chore === 'other' ? (l.note || 'Other') : ch.label;
        return '<div class="history-item"><span class="history-item-label">' + ch.icon + ' ' + esc(label) + '</span>' +
          '<span class="history-item-time">' + formatDate(l.done_at) + '</span>' +
          (isCurrent && l.chore === 'other' ? '<button class="history-item-edit" data-edit="' + l.id + '" title="Edit">✏️</button>' : '') +
          (isCurrent ? '<button class="history-item-remove" data-remove="' + l.id + '" title="Remove">×</button>'
                     : '<span style="width:26px;flex-shrink:0;"></span>') + '</div>';
      }).join('')
    : '<div class="empty-note">No chores logged yet.</div>';

  return '<div class="child-card' + (ev.ok ? ' ready' : '') + '" data-card="' + child.id + '">' +
    '<div class="child-header">' +
      '<button class="avatar-btn" style="background:' + AVATAR_BG[idx % AVATAR_BG.length] + ';" data-avatar="' + child.id + '" title="Change avatar">' +
        '<span style="line-height:1;">' + esc(child.emoji) + '</span><span class="avatar-edit-hint">✏️</span></button>' +
      '<div class="child-name">' + esc(child.name) + '</div>' +
      '<div class="week-status ' + status.cls + '">' + status.text + '</div>' +
    '</div>' +
    '<div class="section-label">This week’s goal</div><div class="req-list">' + reqs + '</div>' +
    buttons +
    '<div class="history-section"><div class="section-label">' + (isCurrent ? 'Done this week' : 'Done that week') + '</div>' + history + '</div>' +
  '</div>';
}

function render() {
  const ws = viewWeekStart();
  const isCurrent = weekOffset === 0;
  $('weekTitle').textContent = isCurrent ? 'This week' : weekOffset === -1 ? 'Last week' : weekRangeLabel(ws);
  $('weekSub').textContent = weekOffset >= -1 ? weekRangeLabel(ws) : '';
  $('weekNext').disabled = isCurrent;

  const active = document.activeElement;
  const focus = active && active.classList && active.classList.contains('other-input')
    ? { id: active.dataset.child, pos: active.selectionStart } : null;

  $('grid').innerHTML = children.map((c, i) => cardHTML(c, i, isCurrent)).join('');

  if (focus) {
    const el = document.querySelector('.other-input[data-child="' + focus.id + '"]');
    if (el) { el.focus(); try { el.setSelectionRange(focus.pos, focus.pos); } catch (e) {} }
  }
}

// ── Events (delegated, so re-rendering never loses them) ─────────────────────
function submitOther(childId) {
  const text = (drafts[childId] || '').trim();
  if (!text) return;
  drafts[childId] = '';
  otherOpen[childId] = false;
  addLog(childId, 'other', text);
}

$('grid').addEventListener('click', e => {
  const req = e.target.closest('[data-req]');
  if (req) {
    const cid = req.dataset.child;
    if (req.dataset.req === 'other') {
      otherOpen[cid] = !otherOpen[cid];
      render();
      if (otherOpen[cid]) { const el = document.querySelector('.other-input[data-child="' + cid + '"]'); if (el) el.focus(); }
      return;
    }
    return addLog(cid, req.dataset.req);
  }
  const other = e.target.closest('[data-other]');
  if (other) return submitOther(other.dataset.other);
  const ed = e.target.closest('[data-edit]');
  if (ed) return openEditModal(ed.dataset.edit);
  const rm = e.target.closest('[data-remove]');
  if (rm) return removeLog(rm.dataset.remove);
  const av = e.target.closest('[data-avatar]');
  if (av) return openAvatarModal(av.dataset.avatar);
});
$('grid').addEventListener('input', e => {
  if (!e.target.classList.contains('other-input')) return;
  const id = e.target.dataset.child;
  drafts[id] = e.target.value;
  const btn = e.target.closest('.other-row').querySelector('.other-submit');
  btn.disabled = !e.target.value.trim();
});
$('grid').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('other-input')) submitOther(e.target.dataset.child);
});

$('weekPrev').addEventListener('click', () => { weekOffset -= 1; loadWeek(); });
$('weekNext').addEventListener('click', () => { if (weekOffset < 0) { weekOffset += 1; loadWeek(); } });
$('signOut').addEventListener('click', () => { client && client.auth.signOut(); });

// ── Start ─────────────────────────────────────────────────────────────────────
if (!client) Core.showSetupNeeded();
else Core.initAuth(client, boot);
