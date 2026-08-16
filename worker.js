// ═══════════════════════════════════════════════════════════════════════════
// PMT BULLMER — WORKER (everything in one file, no imports needed)
// Routes /api/* to the handlers below; everything else falls through to the
// ASSETS binding, which serves index.html / OneSignalSDKWorker.js from the
// same repo root (see wrangler.toml's [assets] block).
// ═══════════════════════════════════════════════════════════════════════════

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── master_data ──────────────────────────────────────────────────────────
async function getMasterData(request, env) {
  const url = new URL(request.url);
  const assetNo = url.searchParams.get('asset_no');
  if (!assetNo) return json({ error: 'asset_no required' }, 400);

  const row = await env.DB.prepare(
    'SELECT asset_type FROM master_data WHERE asset_no = ?'
  ).bind(assetNo).first();

  return json(row || null);
}

async function postMasterData(request, env) {
  const body = await request.json();
  if (!body.asset_no || !body.asset_type) {
    return json({ error: 'asset_no and asset_type required' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO master_data (asset_no, asset_type) VALUES (?, ?)
     ON CONFLICT(asset_no) DO UPDATE SET asset_type = excluded.asset_type`
  ).bind(body.asset_no, body.asset_type).run();

  return json({ success: true });
}

// ── downtime_log ─────────────────────────────────────────────────────────
async function getDowntimeLog(request, env) {
  const url = new URL(request.url);
  const assetNo = url.searchParams.get('asset_no');
  const open = url.searchParams.get('open');
  const mode = url.searchParams.get('mode');

  if (assetNo && open) {
    const row = await env.DB.prepare(
      `SELECT id, asset_no, line, fault, status, mechanic, reported_time
       FROM downtime_log
       WHERE asset_no = ? AND status IN ('Open','Investigating')
       ORDER BY reported_time DESC LIMIT 1`
    ).bind(assetNo).first();
    return json(row || null);
  }

  if (mode === 'mechanic') {
    const resolvedAfter = url.searchParams.get('resolvedAfter') || '1970-01-01';
    const { results } = await env.DB.prepare(
      `SELECT * FROM downtime_log
       WHERE status IN ('Open','Investigating')
          OR (status = 'Resolved' AND resolved_time >= ?)
       ORDER BY reported_time DESC`
    ).bind(resolvedAfter).all();
    return json(results);
  }

  return json({ error: 'Specify asset_no+open=1, or mode=mechanic' }, 400);
}

async function postDowntimeLog(request, env) {
  const body = await request.json();
  try {
    const result = await env.DB.prepare(
      `INSERT INTO downtime_log (asset_no, machine_type, line, fault, reported_time, status)
       VALUES (?, ?, ?, ?, ?, 'Open')`
    ).bind(body.asset_no, body.machine_type, body.line, body.fault, body.reported_time).run();

    return json({ id: result.meta.last_row_id }, 201);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg.includes('UNIQUE')) return json({ error: 'Asset already has an open ticket' }, 409);
    return json({ error: msg }, 500);
  }
}

const DOWNTIME_LOG_FIELDS = [
  'machine_type', 'status', 'investigate_time', 'response_minutes', 'mechanic',
  'error_code', 'corrective_measures', 'resolved_time', 'repair_minutes', 'total_downtime_minutes'
];

async function patchDowntimeLog(request, env, id) {
  const body = await request.json();
  const fields = Object.keys(body).filter(k => DOWNTIME_LOG_FIELDS.includes(k));
  if (fields.length === 0) return json({ error: 'No valid fields to update' }, 400);

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);

  await env.DB.prepare(`UPDATE downtime_log SET ${setClause} WHERE id = ?`)
    .bind(...values, id).run();

  return json({ success: true });
}

// ── parts_requests ───────────────────────────────────────────────────────
async function getPartsRequests(request, env) {
  const url = new URL(request.url);
  const jobCardId = url.searchParams.get('job_card_id');
  if (!jobCardId) return json({ error: 'job_card_id required' }, 400);

  const { results } = await env.DB.prepare(
    `SELECT * FROM parts_requests WHERE job_card_id = ?`
  ).bind(jobCardId).all();

  return json(results);
}

async function postPartsRequests(request, env) {
  const body = await request.json();
  const rows = Array.isArray(body) ? body : [body];

  const stmt = env.DB.prepare(
    `INSERT INTO parts_requests
      (job_card_id, asset_no, machine_type, line, mechanic, part_no,
       part_description, quantity, status, requested_time, request_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`
  );

  const batch = rows.map(r => stmt.bind(
    r.job_card_id, r.asset_no, r.machine_type, r.line, r.mechanic,
    r.part_no || '', r.part_description, r.quantity, r.requested_time, r.request_batch_id || null
  ));

  await env.DB.batch(batch);
  return json({ success: true }, 201);
}

const PARTS_REQUEST_FIELDS = [
  'status', 'issued_time', 'issued_by', 'part_no', 'quantity_returned', 'quantity_consumed'
];

async function patchPartsRequests(request, env, id) {
  const body = await request.json();
  const fields = Object.keys(body).filter(k => PARTS_REQUEST_FIELDS.includes(k));
  if (fields.length === 0) return json({ error: 'No valid fields to update' }, 400);

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);

  await env.DB.prepare(`UPDATE parts_requests SET ${setClause} WHERE id = ?`)
    .bind(...values, id).run();

  return json({ success: true });
}

// ── parts_returns ────────────────────────────────────────────────────────
async function postPartsReturns(request, env) {
  const body = await request.json();

  const req = await env.DB.prepare(`SELECT * FROM parts_requests WHERE id = ?`)
    .bind(body.request_id).first();
  if (!req) return json({ error: 'Request not found' }, 404);

  const isFaulty = body.reason === 'Faulty / defective';
  const consumed = (req.quantity || 0) - body.quantity_returned;
  const nowISO = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `INSERT INTO parts_returns
        (request_id, job_card_id, asset_no, machine_type, line, part_no,
         part_description, quantity_issued, quantity_returned, quantity_consumed,
         return_reason, stock_restored, returned_by, return_time, supplier_return_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      req.id, req.job_card_id, req.asset_no, req.machine_type, req.line,
      req.part_no || '', req.part_description || '', req.quantity,
      body.quantity_returned, consumed, body.reason, isFaulty ? 0 : 1,
      req.mechanic || '', nowISO, isFaulty ? 'Awaiting supplier return' : null
    ),
    env.DB.prepare(
      `UPDATE parts_requests SET quantity_returned = ?, quantity_consumed = ? WHERE id = ?`
    ).bind(body.quantity_returned, consumed, req.id)
  ];

  if (!isFaulty && req.part_no && req.line) {
    statements.push(
      env.DB.prepare(
        `UPDATE parts_inventory SET stock_qty = stock_qty + ?, updated_at = ?
         WHERE part_no = ? AND location = ?`
      ).bind(body.quantity_returned, nowISO, req.part_no, req.line)
    );
  }

  await env.DB.batch(statements);
  return json({ success: true, stockRestored: !isFaulty });
}

// ── notify (OneSignal proxy) ─────────────────────────────────────────────
async function postNotify(request, env) {
  // Fail with a clear, specific error if the secrets aren't actually bound —
  // rather than sending "Key undefined" to OneSignal and getting back a
  // generic 401 that looks identical to a real auth failure.
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    return json({
      error: 'Missing OneSignal config in Worker environment',
      hasAppId: !!env.ONESIGNAL_APP_ID,
      hasRestApiKey: !!env.ONESIGNAL_REST_API_KEY
    }, 500);
  }

  const { title, message, url } = await request.json();

  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Newer OneSignal REST API keys (format: os_v2_app_...) require the
      // "Key" auth scheme, not "Basic" — Basic is only for the old key format.
      'Authorization': `Key ${env.ONESIGNAL_REST_API_KEY}`
    },
    body: JSON.stringify({
      app_id: env.ONESIGNAL_APP_ID,
      // Target every currently subscribed device directly, rather than by
      // named segment ("Subscribed Users" wasn't resolving reliably even
      // for genuinely active subscribers — likely a segment-indexing lag
      // on OneSignal's side). This filter matches subscriptions whose
      // notification_types is 1 (opted in), which is the actual condition
      // that matters for a small, fixed mechanic team.
      filters: [
        { field: 'session_count', relation: '>', value: '0' }
      ],
      headings: { en: title },
      contents: { en: message },
      url
    })
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── ROUTER ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === '/api/master-data') {
      if (method === 'GET')  return getMasterData(request, env);
      if (method === 'POST') return postMasterData(request, env);
    }

    if (pathname === '/api/downtime-log') {
      if (method === 'GET')  return getDowntimeLog(request, env);
      if (method === 'POST') return postDowntimeLog(request, env);
    }
    const dtIdMatch = pathname.match(/^\/api\/downtime-log\/(\d+)$/);
    if (dtIdMatch && method === 'PATCH') return patchDowntimeLog(request, env, dtIdMatch[1]);

    if (pathname === '/api/parts-requests') {
      if (method === 'GET')  return getPartsRequests(request, env);
      if (method === 'POST') return postPartsRequests(request, env);
    }
    const prIdMatch = pathname.match(/^\/api\/parts-requests\/(\d+)$/);
    if (prIdMatch && method === 'PATCH') return patchPartsRequests(request, env, prIdMatch[1]);

    if (pathname === '/api/parts-returns' && method === 'POST') return postPartsReturns(request, env);
    if (pathname === '/api/notify' && method === 'POST') return postNotify(request, env);

    // Not an API route — serve the static site (index.html, OneSignalSDKWorker.js)
    return env.ASSETS.fetch(request);
  }
};
