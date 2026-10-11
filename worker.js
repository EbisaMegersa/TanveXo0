/* TapCoin API v4 — dynamic tasks, withdrawals, device cap, admin */
const ENERGY_MAX = 500, ENERGY_REGEN = 1, TAP_COST = 1, MAX_TAPS_SEC = 12;
const POINTS_PER_INVITE = 5, BOOST_MAX = 10, DAY = 86400, SPIN_COST = 100;
const MAX_ACCOUNTS_PER_DEVICE = 2;
const MIN_WITHDRAW = 5000; /* ← minimum coins to withdraw */
const STREAK_REWARDS = [10, 25, 50, 75, 100, 150, 250];
const SPIN_PRIZES = [
  { coins:5, w:28 }, { coins:10, w:22 }, { coins:15, w:18 }, { coins:25, w:12 },
  { coins:50, w:10 }, { coins:100, w:6 }, { coins:250, w:3 }, { energy:true, w:1 }
];
function pickPrize(){ let r = Math.random()*100, a = 0; for (let i=0;i<SPIN_PRIZES.length;i++){ a += SPIN_PRIZES[i].w; if (r < a) return i; } return 0; }
const TASK_TYPES = ['taps','invites','daily','boost','link'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data, X-Admin-Key',
  'Access-Control-Max-Age': '86400'
};
const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const now = () => Math.floor(Date.now() / 1000);
const bannedResp = row => ({ ok: false, error: (row && row.ban_reason) ? row.ban_reason : 'Account banned', locked: true });

let dbReady = null;
function initDb(env) {
  if (!dbReady) {
    dbReady = (async () => {
      const t0 = now();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY, name TEXT, username TEXT,
        balance INTEGER NOT NULL DEFAULT 0, total_earned INTEGER NOT NULL DEFAULT 0,
        taps INTEGER NOT NULL DEFAULT 0, energy REAL NOT NULL DEFAULT 500, energy_ts INTEGER NOT NULL DEFAULT 0,
        boost INTEGER NOT NULL DEFAULT 1, daily_streak INTEGER NOT NULL DEFAULT 0,
        last_daily INTEGER NOT NULL DEFAULT 0, daily_claims INTEGER NOT NULL DEFAULT 0,
        tasks TEXT NOT NULL DEFAULT '[]', channel_clicked INTEGER NOT NULL DEFAULT 0,
        referred_by INTEGER, invited INTEGER NOT NULL DEFAULT 0,
        device_id TEXT, banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, last_spin INTEGER NOT NULL DEFAULT 0,
        migrated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS referrals (
        referrer INTEGER NOT NULL, user_id INTEGER PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, type TEXT NOT NULL,
        reward INTEGER NOT NULL, goal INTEGER NOT NULL DEFAULT 1, link TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS task_claims (
        user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, claimed_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, task_id)
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS task_clicks (
        user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, clicked_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, task_id)
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT,
        amount INTEGER NOT NULL, method TEXT NOT NULL, address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, processed_at INTEGER
      )`).run();
      const alters = [
        'ALTER TABLE users ADD COLUMN device_id TEXT',
        'ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN ban_reason TEXT',
        'ALTER TABLE users ADD COLUMN last_spin INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0'
      ];
      for (const a of alters) { try { await env.DB.prepare(a).run(); } catch(e) {} }
      /* seed the 7 classic tasks once */
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first();
      if (!c || c.n === 0) {
        const seed = [
          ['Tap the coin 100 times','taps',50,100],['Tap the coin 1,000 times','taps',250,1000],
          ['Claim a daily bonus','daily',25,1],['Invite your first friend','invites',100,1],
          ['Invite 5 friends','invites',500,5],['Upgrade your tap boost','boost',75,1],
          ['Join our news channel','link',50,1]
        ];
        for (let i = 0; i < seed.length; i++) {
          await env.DB.prepare('INSERT OR IGNORE INTO tasks (id,title,type,reward,goal,link,active,created_at) VALUES (?,?,?,?,?,?,1,?)')
            .bind(i + 1, seed[i][0], seed[i][1], seed[i][2], seed[i][3], seed[i][1] === 'link' ? '' : null, t0).run();
        }
      }
    })().catch(e => { dbReady = null; throw e; });
  }
  return dbReady;
}

async function verifyInitData(initData, botToken) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash || !botToken) return null;
    p.delete('hash');
    const check = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
    const enc = new TextEncoder();
    const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(botToken));
    const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(check));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return null;
    const ad = parseInt(p.get('auth_date') || '0', 10);
    if (!ad || now() - ad > 86400) return null;
    const u = JSON.parse(p.get('user') || 'null');
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

function regen(row) {
  const t = now();
  if (row.energy < ENERGY_MAX) row.energy = Math.min(ENERGY_MAX, row.energy + Math.max(0, t - row.energy_ts) * ENERGY_REGEN);
  row.energy_ts = t;
  return row;
}

async function getRow(env, id) {
  const r = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(id).first();
  if (r) r.tasks = JSON.parse(r.tasks || '[]');
  return r || null;
}
async function friendsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT name, created_at FROM referrals WHERE referrer = ? ORDER BY created_at DESC LIMIT 100').bind(id).all();
  return (results || []).map(r => ({ name: r.name || 'Friend', ts: r.created_at * 1000 }));
}
async function claimsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT task_id FROM task_claims WHERE user_id = ?').bind(id).all();
  return (results || []).map(r => r.task_id);
}
async function clicksOf(env, id) {
  const { results } = await env.DB.prepare('SELECT task_id FROM task_clicks WHERE user_id = ?').bind(id).all();
  return (results || []).map(r => r.task_id);
}
async function withdrawalsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT id, amount, method, address, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all();
  return (results || []).map(r => ({ id: r.id, amount: r.amount, method: r.method, address: r.address, status: r.status, ts: r.created_at * 1000 }));
}

async function saveRow(env, row) {
  await env.DB.prepare(`UPDATE users SET name=?, username=?, balance=?, total_earned=?, taps=?, energy=?, energy_ts=?,
    boost=?, daily_streak=?, last_daily=?, daily_claims=?, tasks=?, channel_clicked=?, invited=?,
    device_id=?, banned=?, ban_reason=?, last_spin=?, migrated=?, updated_at=? WHERE user_id=?`)
    .bind(row.name, row.username, row.balance, row.total_earned, row.taps, row.energy, row.energy_ts,
      row.boost, row.daily_streak, row.last_daily, row.daily_claims, JSON.stringify(row.tasks || []),
      row.channel_clicked ? 1 : 0, row.invited, row.device_id || null, row.banned ? 1 : 0,
      row.ban_reason || null, row.last_spin || 0, row.migrated ? 1 : 0, now(), row.user_id).run();
}

function toClient(row, friends, claimed, clicked) {
  return {
    balance: row.balance, totalEarned: row.total_earned, taps: row.taps, energy: row.energy,
    boost: row.boost, referrals: row.invited, dailyStreak: row.daily_streak, lastDaily: row.last_daily * 1000,
    dailyClaims: row.daily_claims, channelClicked: !!row.channel_clicked,
    tasksClaimed: claimed || [], tasksClicked: clicked || [],
    lastSpin: (row.last_spin || 0) * 1000, friends: friends || []
  };
}

/* one-time migration of old hardcoded task ids (1..7 match seeded ids) */
async function migrateUser(env, row) {
  if (row.migrated) return;
  const order = ['taps100','taps1000','daily','invite1','invite5','boost1','channel'];
  const t = now();
  const old = row.tasks || [];
  for (const o of old) {
    const i = order.indexOf(o);
    if (i >= 0) await env.DB.prepare('INSERT OR IGNORE INTO task_claims (user_id, task_id, claimed_at) VALUES (?,?,?)').bind(row.user_id, i + 1, t).run();
  }
  if (row.channel_clicked) await env.DB.prepare('INSERT OR IGNORE INTO task_clicks (user_id, task_id, clicked_at) VALUES (?,?,?)').bind(row.user_id, 7, t).run();
  row.tasks = []; row.migrated = 1;
}

async function apiInit(env, tgUser, body) {
  const t = now();
  const dev = (body && body.dev) ? String(body.dev).slice(0, 64) : null;
  let row = await getRow(env, tgUser.id);
  if (!row) {
    const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Player';
    let lockDev = false;
    if (dev) {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE device_id = ?').bind(dev).first();
      if (c && c.n >= MAX_ACCOUNTS_PER_DEVICE) lockDev = true;
    }
    await env.DB.prepare(`INSERT OR IGNORE INTO users (user_id, name, username, energy, energy_ts, tasks, device_id, banned, ban_reason, created_at, updated_at)
      VALUES (?, ?, ?, 500, ?, '[]', ?, ?, ?, ?, ?)`)
      .bind(tgUser.id, name, tgUser.username || null, t, dev,
        lockDev ? 1 : 0,
        lockDev ? 'Device limit reached — max ' + MAX_ACCOUNTS_PER_DEVICE + ' accounts per device' : null,
        t, t).run();
    row = await getRow(env, tgUser.id);
    if (row && !row.banned) {
      const ref = parseInt(body && body.ref, 10);
      if (row && !row.referred_by && ref && ref !== tgUser.id) {
        const referrer = await getRow(env, ref);
        if (referrer && !referrer.banned) {
          let allowed = true;
          if (dev) {
            const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE device_id = ? AND referred_by IS NOT NULL').bind(dev).first();
            if (c && c.n >= MAX_ACCOUNTS_PER_DEVICE) allowed = false;
          }
          if (allowed) {
            referrer.balance += POINTS_PER_INVITE;
            referrer.invited += 1;
            await saveRow(env, referrer);
            await env.DB.prepare('INSERT OR IGNORE INTO referrals (referrer, user_id, name, created_at) VALUES (?, ?, ?, ?)')
              .bind(ref, tgUser.id, name, t).run();
            await env.DB.prepare('UPDATE users SET referred_by=? WHERE user_id=?').bind(ref, tgUser.id).run();
          }
        }
      }
    }
  }
  if (!row) return { ok: false, error: 'Could not create user' };
  if (row.banned) return bannedResp(row);
  await migrateUser(env, row);
  regen(row);
  await saveRow(env, row);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
}

async function apiSync(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found — reload the app' };
  if (row.banned) return bannedResp(row);
  const t = now();
  regen(row);
  const elapsed = Math.max(0, t - row.updated_at);
  const claimed = Math.max(0, Math.min(Math.floor(body.taps || 0), Math.floor(row.energy / TAP_COST), elapsed * MAX_TAPS_SEC + 30));
  if (claimed > 0) {
    const gain = claimed * row.boost;
    row.balance += gain; row.total_earned += gain; row.taps += claimed;
    row.energy = Math.max(0, row.energy - claimed * TAP_COST);
  }
  row.energy_ts = t; row.updated_at = t;
  await saveRow(env, row);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
}

async function apiDaily(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const t = now();
  if (t - row.last_daily < DAY) return { ok: false, error: 'Bonus already claimed — come back tomorrow' };
  row.daily_streak = (row.last_daily > 0 && t - row.last_daily < 2 * DAY)
    ? (row.daily_streak >= STREAK_REWARDS.length ? 1 : row.daily_streak + 1) : 1;
  const reward = STREAK_REWARDS[row.daily_streak - 1];
  row.balance += reward; row.total_earned += reward; row.daily_claims += 1;
  row.last_daily = t; row.updated_at = t;
  await saveRow(env, row);
  return { ok: true, reward, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
}

function dynProgress(row, t, clicked) {
  switch (t.type) {
    case 'taps': return row.taps;
    case 'invites': return row.invited;
    case 'daily': return row.daily_claims;
    case 'boost': return row.boost - 1;
    case 'link': return clicked ? 1 : 0;
    default: return 0;
  }
}

async function apiTasks(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const { results } = await env.DB.prepare('SELECT id, title, type, reward, goal, link FROM tasks WHERE active = 1 ORDER BY id').all();
  return { ok: true, tasks: results || [] };
}

async function apiTask(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const id = parseInt(body.id, 10);
  const t = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!t || !t.active) return { ok: false, error: 'Task not found' };
  const tnow = now();
  /* link task: record the click first */
  if (t.type === 'link' && body.click) {
    if (!t.link) return { ok: false, error: 'Task link is not set yet' };
    const ex = await env.DB.prepare('SELECT user_id FROM task_clicks WHERE user_id = ? AND task_id = ?').bind(tgUser.id, id).first();
    if (!ex) await env.DB.prepare('INSERT INTO task_clicks (user_id, task_id, clicked_at) VALUES (?,?,?)').bind(tgUser.id, id, tnow).run();
    return { ok: true, clicked: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
  }
  const claimed = await claimsOf(env, tgUser.id);
  if (claimed.includes(id)) return { ok: false, error: 'Already claimed' };
  const clicked = (await clicksOf(env, tgUser.id)).includes(id);
  if (dynProgress(row, t, clicked) < t.goal) return { ok: false, error: 'Task not finished yet' };
  await env.DB.prepare('INSERT INTO task_claims (user_id, task_id, claimed_at) VALUES (?,?,?)').bind(tgUser.id, id, tnow).run();
  row.balance += t.reward; row.total_earned += t.reward; row.updated_at = tnow;
  await saveRow(env, row);
  return { ok: true, reward: t.reward, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
}

function boostCost(b) { return Math.round(100 * Math.pow(1.8, b - 1) / 10) * 10; }

async function apiBoost(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (row.boost >= BOOST_MAX) return { ok: false, error: 'Max boost reached' };
  const cost = boostCost(row.boost);
  if (row.balance < cost) return { ok: false, error: 'Need ' + (cost - row.balance) + ' more coins' };
  row.balance -= cost; row.boost += 1; row.updated_at = now();
  await saveRow(env, row);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
}

async function apiSpin(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const t = now();
  regen(row);
  const free = t - (row.last_spin || 0) >= DAY;
  if (!free) {
    if (row.balance < SPIN_COST) return { ok: false, error: 'Need ' + (SPIN_COST - row.balance) + ' more coins to spin' };
    row.balance -= SPIN_COST;
  }
  row.last_spin = t;
  const idx = pickPrize();
  const p = SPIN_PRIZES[idx];
  const prize = { index: idx };
  if (p.energy) { row.energy = ENERGY_MAX; prize.energy = true; }
  else { row.balance += p.coins; row.total_earned += p.coins; prize.coins = p.coins; }
  row.updated_at = t;
  await saveRow(env, row);
  return { ok: true, prize, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
}

/* ================= WITHDRAWALS (user) ================= */
async function apiWithdraw(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const amount = Math.floor(parseInt(body.amount, 10) || 0);
  const method = String(body.method || '').trim().slice(0, 40);
  const address = String(body.address || '').trim().slice(0, 120);
  if (!method) return { ok: false, error: 'Choose a withdrawal method' };
  if (address.length < 4) return { ok: false, error: 'Enter your wallet / account details' };
  if (!amount || amount < MIN_WITHDRAW) return { ok: false, error: 'Minimum withdrawal is ' + MIN_WITHDRAW + ' coins' };
  if (amount > row.balance) return { ok: false, error: 'Not enough coins' };
  row.balance -= amount; row.updated_at = now();
  await saveRow(env, row);
  await env.DB.prepare('INSERT INTO withdrawals (user_id, name, amount, method, address, status, created_at) VALUES (?,?,?,?,?,\'pending\',?)')
    .bind(tgUser.id, row.name, amount, method, address, now()).run();
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await clicksOf(env, tgUser.id)) };
}

async function apiWithdrawals(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  return { ok: true, withdrawals: await withdrawalsOf(env, tgUser.id) };
}

/* ================= ADMIN ================= */
function adminOk(request, env) {
  const key = request.headers.get('X-Admin-Key') || '';
  return !!env.ADMIN_PASSWORD && key.length > 0 && key === env.ADMIN_PASSWORD;
}
async function adminStats(env) {
  const agg = await env.DB.prepare('SELECT COUNT(*) AS users, COALESCE(SUM(balance),0) AS coins, COALESCE(SUM(total_earned),0) AS earned, COALESCE(SUM(taps),0) AS taps, COALESCE(SUM(invited),0) AS invites FROM users').first();
  const nd = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').bind(now() - 86400).first();
  const top = await env.DB.prepare('SELECT user_id, name, balance, invited, taps, banned, device_id, created_at FROM users ORDER BY balance DESC LIMIT 25').all();
  const recent = await env.DB.prepare('SELECT user_id, name, balance, invited, banned, device_id, created_at FROM users ORDER BY created_at DESC LIMIT 25').all();
  const tasks = await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all();
  const wds = await env.DB.prepare("SELECT * FROM withdrawals ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 50").all();
  const pend = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM withdrawals WHERE status = 'pending'").first();
  return { ok: true,
    stats: { users: agg.users, coins: agg.coins, earned: agg.earned, taps: agg.taps, invites: agg.invites, new24: nd ? nd.n : 0 },
    pendingWd: { n: pend ? pend.n : 0, amt: pend ? pend.amt : 0 },
    top: top.results || [], recent: recent.results || [],
    tasks: tasks.results || [], withdrawals: wds.results || [] };
}
async function adminTaskAction(env, body) {
  const t = now();
  if (body.action === 'add') {
    const title = String(body.title || '').trim().slice(0, 80);
    const type = String(body.type || '');
    const reward = Math.floor(parseInt(body.reward, 10) || 0);
    const goal = Math.max(1, Math.floor(parseInt(body.goal, 10) || 1));
    const link = String(body.link || '').trim().slice(0, 200) || null;
    if (!title) return { ok: false, error: 'Title required' };
    if (!TASK_TYPES.includes(type)) return { ok: false, error: 'Type must be: ' + TASK_TYPES.join(', ') };
    if (reward < 1 || reward > 1000000) return { ok: false, error: 'Reward must be 1..1000000' };
    if (type === 'link' && !link) return { ok: false, error: 'Link tasks need a URL' };
    await env.DB.prepare('INSERT INTO tasks (title, type, reward, goal, link, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .bind(title, type, reward, goal, link, t).run();
    return { ok: true };
  }
  const id = parseInt(body.id, 10);
  if (!id) return { ok: false, error: 'Task id required' };
  if (body.action === 'toggle') {
    await env.DB.prepare('UPDATE tasks SET active = 1 - active WHERE id = ?').bind(id).run();
    return { ok: true };
  }
  if (body.action === 'delete') {
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
    return { ok: true };
  }
  if (body.action === 'setlink') {
    const link = String(body.link || '').trim().slice(0, 200);
    await env.DB.prepare('UPDATE tasks SET link = ? WHERE id = ?').bind(link || null, id).run();
    return { ok: true };
  }
  return { ok: false, error: 'Unknown action' };
}
async function adminWdAction(env, body) {
  const id = parseInt(body.id, 10);
  if (!id) return { ok: false, error: 'Withdrawal id required' };
  const w = await env.DB.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(id).first();
  if (!w) return { ok: false, error: 'Withdrawal not found' };
  if (w.status !== 'pending') return { ok: false, error: 'Already processed' };
  const t = now();
  if (body.action === 'paid') {
    await env.DB.prepare("UPDATE withdrawals SET status = 'paid', processed_at = ? WHERE id = ?").bind(t, id).run();
    return { ok: true, result: 'paid' };
  }
  if (body.action === 'reject') {
    await env.DB.prepare("UPDATE withdrawals SET status = 'rejected', processed_at = ? WHERE id = ?").bind(t, id).run();
    await env.DB.prepare('UPDATE users SET balance = balance + ? WHERE user_id = ?').bind(w.amount, w.user_id).run();
    return { ok: true, result: 'rejected + refunded ' + w.amount + ' coins' };
  }
  return { ok: false, error: 'Unknown action' };
}
async function adminAction(env, body) {
  const id = parseInt(body.userId, 10);
  if (!id) return { ok: false, error: 'userId required' };
  const t = now();
  if (body.action === 'add') {
    await env.DB.prepare('UPDATE users SET balance = MAX(0, balance + ?), updated_at=? WHERE user_id=?').bind(parseInt(body.amount, 10) || 0, t, id).run();
  } else if (body.action === 'set') {
    await env.DB.prepare('UPDATE users SET balance = MAX(0, ?), updated_at=? WHERE user_id=?').bind(parseInt(body.amount, 10) || 0, t, id).run();
  } else if (body.action === 'ban') {
    await env.DB.prepare("UPDATE users SET banned=1, ban_reason='Banned by admin', updated_at=? WHERE user_id=?").bind(t, id).run();
  } else if (body.action === 'unban') {
    await env.DB.prepare('UPDATE users SET banned=0, ban_reason=NULL, updated_at=? WHERE user_id=?').bind(t, id).run();
  } else return { ok: false, error: 'Unknown action' };
  const r = await env.DB.prepare('SELECT user_id, name, balance, banned, ban_reason FROM users WHERE user_id=?').bind(id).first();
  return { ok: true, user: r };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url).pathname;
    if (url === '/') return j({ ok: true, msg: 'TapCoin API v4 is running' });
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch (e) {} }
    try {
      if (url === '/api/admin/stats') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminStats(env));
      }
      if (url === '/api/admin/action') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminAction(env, body));
      }
      if (url === '/api/admin/task_action') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminTaskAction(env, body));
      }
      if (url === '/api/admin/wd_action') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminWdAction(env, body));
      }
      if (request.method !== 'POST') return j({ ok: false, error: 'Use POST' }, 405);
      await initDb(env);
      const initData = request.headers.get('X-Telegram-Init-Data') || '';
      const tgUser = await verifyInitData(initData, env.BOT_TOKEN || '');
      if (!tgUser) return j({ ok: false, error: env.BOT_TOKEN ? 'Auth failed — open the app from Telegram' : 'BOT_TOKEN secret is not set in Worker settings' }, 401);
      switch (url) {
        case '/api/init':        return j(await apiInit(env, tgUser, body));
        case '/api/sync':        return j(await apiSync(env, tgUser, body));
        case '/api/daily':       return j(await apiDaily(env, tgUser));
        case '/api/tasks':       return j(await apiTasks(env, tgUser));
        case '/api/task':        return j(await apiTask(env, tgUser, body));
        case '/api/boost':       return j(await apiBoost(env, tgUser));
        case '/api/spin':        return j(await apiSpin(env, tgUser));
        case '/api/withdraw':    return j(await apiWithdraw(env, tgUser, body));
        case '/api/withdrawals': return j(await apiWithdrawals(env, tgUser));
      }
      return j({ ok: false, error: 'Unknown endpoint' }, 404);
    } catch (e) {
      return j({ ok: false, error: 'Server error: ' + (e && e.message ? e.message : String(e)) }, 500);
    }
  }
};
