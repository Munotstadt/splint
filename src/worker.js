// Splint Tracker — Cloudflare Worker
// Serves the static index.html (via the ASSETS binding) and the /api/* data
// endpoints (backed by D1), gated by Cloudflare Access on the custom domain.

const TABLE_COLUMNS = {
  splint_masterdata: ['asset_id','asset_name','asset_category','asset_subcategory','asset_category_old','notes','release_date','min_horizon','max_horizon','eroi'],
  splint_prices: ['id','asset_id','asset_name','month','price_date','price','currency'],
  splint_transactions: ['transaction_id','transaction_type','asset_id','transaction_date','money_amount','money_currency','price_per_splint','price_currency','fees','fees_currency','confirmation_doc','day1_profit','fx_rate'],
};

// Separate Securities D1 database (binding SECDB) — only security_prices is exposed, used by
// the Valuation page (SecurityID 21000). created_at/modified_at are left out here on purpose:
// the table defines DEFAULT (datetime('now')) for both, so omitting them from an INSERT lets
// SQLite fill them in itself.
const SEC_TABLE_COLUMNS = {
  security_prices: ['id','SecurityID','Price','Price_adjusted','Price_date','source'],
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

function sanitizeSelectFor(allowedCols, select) {
  if (!select || select === '*') return '*';
  const allowed = new Set(allowedCols);
  const cols = select.split(',').map(c => c.trim()).filter(c => allowed.has(c));
  return cols.length ? cols.join(',') : '*';
}

function sanitizeSelect(table, select) {
  return sanitizeSelectFor(TABLE_COLUMNS[table], select);
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

// Securities D1 database (binding SECDB) — read/insert only for security_prices, scoped by
// SecurityID. No update/delete: a valuation entry is always a new row (the table has no
// unique constraint on SecurityID+month the way splint_prices does), and the Valuation page
// only ever needs "the latest row per month" client-side.
async function handleSecTable(request, env, table) {
  const access = requireAccess(request, env);
  if (!access.ok) return access.response;
  if (!Object.prototype.hasOwnProperty.call(SEC_TABLE_COLUMNS, table)) return json({ error: 'unknown table' }, 404);

  const url = new URL(request.url);
  const allowedCols = new Set(SEC_TABLE_COLUMNS[table]);

  if (request.method === 'GET') {
    const select = sanitizeSelectFor(SEC_TABLE_COLUMNS[table], url.searchParams.get('select'));
    const securityId = url.searchParams.get('security_id');
    let sql = `SELECT ${select} FROM ${table}`;
    const binds = [];
    if (securityId) { sql += ` WHERE SecurityID = ?`; binds.push(securityId); }
    sql += ` ORDER BY Price_date ASC`;
    const { results } = await env.SECDB.prepare(sql).bind(...binds).all();
    return json(results);
  }

  if (request.method === 'POST') {
    const rows = await request.json();
    if (!Array.isArray(rows) || rows.length === 0) return json([]);

    const cols = Object.keys(rows[0]).filter(c => allowedCols.has(c) && c !== 'id');
    const placeholders = '(' + cols.map(() => '?').join(',') + ')';
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`;
    const stmt = env.SECDB.prepare(sql);
    const batch = rows.map(r => stmt.bind(...cols.map(c => r[c] ?? null)));

    const CHUNK = 10; // D1 rejects large multi-row INSERTs (SQLITE_TOOBIG) above ~10 rows
    for (let i = 0; i < batch.length; i += CHUNK) {
      await env.SECDB.batch(batch.slice(i, i + CHUNK));
    }
    return json(rows);
  }

  return json({ error: 'method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/whoami') return handleWhoami(request, env);

    const secTableMatch = url.pathname.match(/^\/api\/sec\/([a-zA-Z_]+)$/);
    if (secTableMatch) return handleSecTable(request, env, secTableMatch[1]);

    const tableMatch = url.pathname.match(/^\/api\/([a-zA-Z_]+)$/);
    if (tableMatch) return handleTable(request, env, tableMatch[1]);

    // Everything else: serve the static site (index.html etc.)
    return env.ASSETS.fetch(request);
  },
};
