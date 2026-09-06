// Splint Tracker — Cloudflare Worker
// Serves the static index.html (via the ASSETS binding) and the /api/* data
// endpoints (backed by D1), gated by Cloudflare Access on the custom domain.

const TABLE_COLUMNS = {
  splint_masterdata: ['asset_id','asset_name','asset_category','asset_subcategory','asset_category_old','notes','release_date','min_horizon','max_horizon','eroi'],
  splint_prices: ['id','asset_id','asset_name','month','price_date','price','currency'],
  splint_transactions: ['transaction_id','transaction_type','asset_id','transaction_date','money_amount','money_currency','price_per_splint','price_currency','fees','fees_currency','confirmation_doc','day1_profit','fx_rate'],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function requireAccess(request, env) {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email') || '';
  const allowed = (env.ALLOWED_EMAIL || '').toLowerCase();
  if (allowed && email.toLowerCase() !== allowed) {
    return { ok: false, email, response: json({ error: 'not authorized', email }, 403) };
  }
  return { ok: true, email };
}

function sanitizeSelect(table, select) {
  if (!select || select === '*') return '*';
  const allowed = new Set(TABLE_COLUMNS[table]);
  const cols = select.split(',').map(c => c.trim()).filter(c => allowed.has(c));
  return cols.length ? cols.join(',') : '*';
}

async function handleWhoami(request, env) {
  const access = requireAccess(request, env);
  if (!access.ok) return access.response;
  return json({ authorized: true, email: access.email });
}

async function handleTable(request, env, table) {
  const access = requireAccess(request, env);
  if (!access.ok) return access.response;
  if (!Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, table)) return json({ error: 'unknown table' }, 404);

  const url = new URL(request.url);

  if (request.method === 'GET') {
    const select = sanitizeSelect(table, url.searchParams.get('select'));
    const { results } = await env.DB.prepare(`SELECT ${select} FROM ${table}`).all();
    return json(results);
  }

  if (request.method === 'POST') {
    const rows = await request.json();
    if (!Array.isArray(rows) || rows.length === 0) return json([]);

    const allowedCols = new Set(TABLE_COLUMNS[table]);
    const onConflict = (url.searchParams.get('on_conflict') || '')
      .split(',').map(c => c.trim()).filter(c => allowedCols.has(c));

    const cols = Object.keys(rows[0]).filter(c => allowedCols.has(c));
    const updateCols = cols.filter(c => !onConflict.includes(c));

    const placeholders = '(' + cols.map(() => '?').join(',') + ')';
    let sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`;
    if (onConflict.length) {
      sql += ` ON CONFLICT(${onConflict.join(',')}) DO UPDATE SET ` +
        (updateCols.length ? updateCols.map(c => `${c}=excluded.${c}`).join(',') : `${onConflict[0]}=excluded.${onConflict[0]}`);
    }

    const stmt = env.DB.prepare(sql);
    const batch = rows.map(r => stmt.bind(...cols.map(c => r[c] ?? null)));

    const CHUNK = 50;
    for (let i = 0; i < batch.length; i += CHUNK) {
      await env.DB.batch(batch.slice(i, i + CHUNK));
    }
    return json(rows);
  }

  if (request.method === 'DELETE') {
    const allowedCols = new Set(TABLE_COLUMNS[table]);
    const conditions = [];
    const values = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (!allowedCols.has(k)) continue;
      if (v.startsWith('eq.')) { conditions.push(`${k} = ?`); values.push(v.slice(3)); }
    }
    if (!conditions.length) return json({ error: 'no filters given, refusing to delete whole table' }, 400);
    const sql = `DELETE FROM ${table} WHERE ${conditions.join(' AND ')}`;
    await env.DB.prepare(sql).bind(...values).run();
    return new Response(null, { status: 204 });
  }

  return json({ error: 'method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/whoami') return handleWhoami(request, env);

    const tableMatch = url.pathname.match(/^\/api\/([a-zA-Z_]+)$/);
    if (tableMatch) return handleTable(request, env, tableMatch[1]);

    // Everything else: serve the static site (index.html etc.)
    return env.ASSETS.fetch(request);
  },
};
