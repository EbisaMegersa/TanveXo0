/* TapCoin API — Cloudflare Worker + D1 */
const ENERGY_MAX = 500, ENERGY_REGEN = 1, TAP_COST = 1, MAX_TAPS_SEC = 12;
const POINTS_PER_INVITE = 5, BOOST_MAX = 10, DAY = 86400;
const STREAK_REWARDS = [10, 25, 50, 75, 100, 150, 250];
const TASKS = {
  taps100:{reward:50,goal:100}, taps1000:{reward:250,goal:1000}, daily:{reward:25,goal:1},
  invite1:{reward:100,goal:1}, invite5:{reward:500,goal:5}, boost1:{reward:75,goal:1}, channel:{reward:50,goal:1}
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
  'Access-Control-Max-Age': '86400'
};
const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const now = () => Math.floor(Date.now() / 1000);

let dbReady = null;
function initDb(env) {
  if (!dbReady) {
    dbReady = (async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY, name TEXT, username TEXT,
        balance INTEGER NOT NULL DEFAULT 0, total_earned INTEGER NOT NULL DEFAULT 0,
        taps INTEGER NOT NULL DEFAULT 0, energy REAL NOT NULL DEFAULT 500, energy_ts INTEGER NOT NULL DEFAULT 0,
        boost INTEGER NOT NULL DEFAULT 1, daily_streak INTEGER NOT NULL DEFAULT 0,
        last_daily INTEGER NOT NULL DEFAULT 0, daily_claims INTEGER NOT NULL DEFAULT 0,
        tasks TEXT NOT NULL DEFAULT '[]', channel_clicked INTEGER NOT NULL DEFAULT 0,
        referred_by INTEGER, invited INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS referrals (
        referrer INTEGER NOT NULL, user_id INTEGER PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL
      )`).run();
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

async function saveRow(env, row) {
  await env.DB.prepare(`UPDATE users SET name=?, username=?, balance=?, total_earned=?, taps=?, energy=?, energy_ts=?,
    boost=?, daily_streak=?, last_daily=?, daily_claims=?, tasks=?, channel_clicked=?, invited=?, updated_at=? WHERE user_id=?`)
    .bind(row.name, row.username, row.balance, row.total_earned, row.taps, row.energy, row.energy_ts,
      row.boost, row.daily_streak, row.last_daily, row.daily_claims, JSON.stringify(row.tasks),
      row.channel_clicked ? 1 : 0, row.invited, now(), row.user_id).run();
}

function toClient(row, friends) {
  return {
    balance: row.balance, totalEarned: row.total_earned, taps: row.taps, energy: row.energy,
    boost: row.boost, referrals: row.invited, dailyStreak: row.daily_streak, lastDaily: row.last_daily * 1000,
    dailyClaims: row.daily_claims, completedTasks: row.tasks, channelClicked: !!row.channel_clicked,
    friends: friends || []
  };
}

async function apiInit(env, tgUser, body) {
  const t = now();
  let row = await getRow(env, tgUser.id);
  if (!row) {
    const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Player';
    await env.DB.prepare(`INSERT OR IGNORE INTO users (user_id, name, username, energy, energy_ts, tasks, created_at, updated_at)
      VALUES (?, ?, ?, 500, ?, '[]', ?, ?)`).bind(tgUser.id, name, tgUser.username || null, t, t, t).run();
    row = await getRow(env, tgUser.id);
    const ref = parseInt(body.ref, 10);
    if (row && !row.referred_by && ref && ref !== tgUser.id) {
      const referrer = await getRow(env, ref);
      if (referrer) {
        referrer.balance += POINTS_PER_INVITE;
        referrer.invited += 1;
        await saveRow(env, referrer);
        await env.DB.prepare('INSERT OR IGNORE INTO referrals (referrer, user_id, name, created_at) VALUES (?, ?, ?, ?)')
          .bind(ref, tgUser.id, name, t).run();
        await env.DB.prepare('UPDATE users SET referred_by=? WHERE user_id=?').bind(ref, tgUser.id).run();
      }
    }
  }
  if (!row) return { ok: false, error: 'Could not create user' };
  regen(row);
  await saveRow(env, row);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id)) };
}

async function apiSync(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found — reload the app' };
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
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id)) };
}

async function apiDaily(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  const t = now();
  if (t - row.last_daily < DAY) return { ok: false, error: 'Bonus already claimed — come back tomorrow' };
  row.daily_streak = (row.last_daily > 0 && t - row.last_daily < 2 * DAY)
    ? (row.daily_streak >= STREAK_REWARDS.length ? 1 : row.daily_streak + 1) : 1;
  const reward = STREAK_REWARDS[row.daily_streak - 1];
  row.balance += reward; row.total_earned += reward; row.daily_claims += 1;
  row.last_daily = t; row.updated_at = t;
  await saveRow(env, row);
  return { ok: true, reward, state: toClient(row, await friendsOf(env, tgUser.id)) };
}

function taskProgress(row, id) {
  switch (id) {
    case 'taps100': case 'taps1000': return row.taps;
    case 'daily': return row.daily_claims;
    case 'invite1': case 'invite5': return row.invited;
    case 'boost1': return row.boost - 1;
    case 'channel': return row.channel_clicked ? 1 : 0;
    default: return 0;
  }
}

async function apiTask(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  const def = TASKS[body.id];
  if (!def) return { ok: false, error: 'Unknown task' };
  if (body.id === 'channel' && body.click && !row.channel_clicked) {
    row.channel_clicked = 1; row.updated_at = now();
    await saveRow(env, row);
    return { ok: true, clicked: true, state: toClient(row, await friendsOf(env, tgUser.id)) };
  }
  if (row.tasks.includes(body.id)) return { ok: false, error: 'Already claimed' };
  if (taskProgress(row, body.id) < def.goal) return { ok: false, error: 'Task not finished yet' };
  row.tasks.push(body.id);
  row.balance += def.reward; row.total_earned += def.reward; row.updated_at = now();
  await saveRow(env, row);
  return { ok: true, reward: def.reward, state: toClient(row, await friendsOf(env, tgUser.id)) };
}

function boostCost(b) { return Math.round(100 * Math.pow(1.8, b - 1) / 10) * 10; }

async function apiBoost(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.boost >= BOOST_MAX) return { ok: false, error: 'Max boost reached' };
  const cost = boostCost(row.boost);
  if (row.balance < cost) return { ok: false, error: 'Need ' + (cost - row.balance) + ' more coins' };
  row.balance -= cost; row.boost += 1; row.updated_at = now();
  await saveRow(env, row);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id)) };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url).pathname;
    if (url === '/') return j({ ok: true, msg: 'TapCoin API is running' });
    if (request.method !== 'POST') return j({ ok: false, error: 'Use POST' }, 405);
    try {
      await initDb(env);
      const initData = request.headers.get('X-Telegram-Init-Data') || '';
      const tgUser = await verifyInitData(initData, env.BOT_TOKEN || '');
      if (!tgUser) return j({ ok: false, error: env.BOT_TOKEN ? 'Auth failed — open the app from Telegram' : 'BOT_TOKEN secret is not set in Worker settings' }, 401);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      switch (url) {
        case '/api/init':  return j(await apiInit(env, tgUser, body));
        case '/api/sync':  return j(await apiSync(env, tgUser, body));
        case '/api/daily': return j(await apiDaily(env, tgUser));
        case '/api/task':  return j(await apiTask(env, tgUser, body));
        case '/api/boost': return j(await apiBoost(env, tgUser));
      }
      return j({ ok: false, error: 'Unknown endpoint' }, 404);
    } catch (e) {
      return j({ ok: false, error: 'Server error: ' + (e && e.message ? e.message : String(e)) }, 500);
    }
  }
};
