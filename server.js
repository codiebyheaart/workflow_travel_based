const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}
process.env.DEMO_MODE ??= 'true';
const db = require('./lib');
const PORT = Number(process.env.PORT || 4100);
if (process.env.DEMO_MODE !== 'true' && (!process.env.DASHBOARD_TOKEN || !process.env.INTERNAL_API_KEY || !process.env.N8N_PROCESS_URL || !process.env.META_APP_SECRET || !process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_NUMBER_ID)) {
  throw new Error('Live mode requires dashboard, internal, n8n, and Meta credentials. See .env.example.');
}

function json(res, status, body) { const data = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' }); res.end(data); }
function text(res, status, body, contentType = 'text/plain; charset=utf-8') { res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }); res.end(body); }
function equal(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function authorized(req) { return process.env.DEMO_MODE === 'true' && !process.env.DASHBOARD_TOKEN || equal(req.headers.authorization, `Bearer ${process.env.DASHBOARD_TOKEN}`); }
function internal(req) { return equal(req.headers['x-internal-key'], process.env.INTERNAL_API_KEY); }
async function body(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); } return Buffer.concat(chunks); }
function parse(raw) { try { return JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid JSON'); } }
function verifyMeta(raw, header) { return !!process.env.META_APP_SECRET && equal(header, `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex')}`); }
function verifyStripe(raw, header) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(String(header || '').split(',').map(x => x.split('=')));
  const stamp = Number(parts.t);
  if (!stamp || Math.abs(Date.now() / 1000 - stamp) > 300) return false;
  return String(header).split(',').filter(x => x.startsWith('v1=')).some(x => equal(x.slice(3), crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${stamp}.${raw}`).digest('hex')));
}
function leadDetail(leadId) { const s = db.getState(); return { lead: s.leads.find(l => l.id === leadId), messages: s.messages.filter(m => m.leadId === leadId), bookings: s.bookings.filter(b => b.leadId === leadId), events: s.events.filter(e => e.leadId === leadId).slice(0, 40) }; }
function stateView() { const s = db.getState(); return { metrics: db.metrics(), leads: [...s.leads].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)), bookings: s.bookings, team: s.team, events: s.events.slice(0, 12), catalog: db.catalog, jobs: s.jobs.filter(j => j.status === 'failed').slice(-10).reverse(), demo: process.env.DEMO_MODE === 'true' }; }
async function sendWhatsApp(phone, message) {
  if (process.env.DEMO_MODE === 'true') return 'simulated';
  const response = await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/${process.env.META_PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } }) });
  if (!response.ok) throw new Error(`Meta send HTTP ${response.status}`);
  return 'sent';
}
async function notifyTeam(lead) {
  if (!process.env.TEAM_NOTIFY_URL) return;
  try { await fetch(process.env.TEAM_NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `TrailDesk handoff: ${lead.name} (${lead.phone}) assigned to ${lead.assignee || 'queue'}. Open the dashboard to review.` }) }); }
  catch (e) { db.event('notification_failed', lead.id, e.message); }
}
async function dispatch(job) {
  if (process.env.DEMO_MODE === 'true' && !process.env.N8N_PROCESS_URL) return db.processJob(job.id);
  const response = await fetch(process.env.N8N_PROCESS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY }, body: JSON.stringify({ jobId: job.id }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`n8n HTTP ${response.status}`);
}
async function drain() {
  const pending = db.getState().jobs.filter(j => ['pending', 'failed'].includes(j.status) && j.attempts < 4).slice(0, 20);
  for (const job of pending) {
    if (job.status === 'failed') job.attempts++;
    try { await dispatch(job); } catch (error) { job.status = 'failed'; job.lastError = error.message; db.save(); db.event('dispatch_failed', null, error.message); }
  }
}
let draining = false;
setInterval(async () => { if (draining) return; draining = true; try { await drain(); } finally { draining = false; } }, 5000).unref();

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;
  try {
    if (route === '/health') return json(res, 200, { ok: true, mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'live', failedJobs: db.getState().jobs.filter(j => j.status === 'failed').length });
    if (route === '/webhook/meta' && req.method === 'GET') return text(res, url.searchParams.get('hub.mode') === 'subscribe' && equal(url.searchParams.get('hub.verify_token'), process.env.META_VERIFY_TOKEN) ? 200 : 403, url.searchParams.get('hub.mode') === 'subscribe' && equal(url.searchParams.get('hub.verify_token'), process.env.META_VERIFY_TOKEN) ? url.searchParams.get('hub.challenge') || '' : 'Forbidden');
    if (route === '/webhook/meta' && req.method === 'POST') {
      const raw = await body(req);
      if (!verifyMeta(raw, req.headers['x-hub-signature-256'])) return json(res, 403, { error: 'Invalid signature' });
      const payload = parse(raw);
      let accepted = 0;
      for (const entry of payload.entry || []) for (const change of entry.changes || []) for (const message of change.value?.messages || []) {
        if (message.type !== 'text') continue;
        const contact = (change.value.contacts || []).find(c => c.wa_id === message.from);
        const queued = db.enqueue({ messageId: message.id, phone: message.from, name: contact?.profile?.name, text: message.text?.body, source: 'whatsapp' });
        if (!queued.duplicate) accepted++;
      }
      return json(res, 200, { accepted });
    }
    if (route === '/webhook/stripe' && req.method === 'POST') {
      const raw = await body(req);
      if (!verifyStripe(raw, req.headers['stripe-signature'])) return json(res, 403, { error: 'Invalid signature' });
      const evt = parse(raw); const session = evt.data?.object;
      if (evt.type === 'checkout.session.completed' && session?.payment_status === 'paid') {
        const booking = db.getState().bookings.find(b => b.stripeSessionId === session.id && b.id === session.metadata?.booking_id);
        if (booking && booking.status !== 'paid' && booking.amountCents === session.amount_total && session.currency === 'usd') { booking.status = 'paid'; booking.paidAt = db.now(); db.save(); db.event('payment_received', booking.leadId, booking.id); }
      }
      return json(res, 200, { received: true });
    }
    if (route === '/internal/process' && req.method === 'POST') {
      if (!internal(req)) return json(res, 401, { error: 'Unauthorized' });
      const input = parse(await body(req));
      const job = await db.processJob(input.jobId);
      const lead = db.findLead(job.phone);
      if (lead?.status === 'human') await notifyTeam(lead);
      return json(res, 200, { jobId: job.id, status: job.status, leadId: lead?.id });
    }
    if (route === '/internal/leads' && req.method === 'GET') {
      if (!internal(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, db.getState().leads.map(l => ({ id:l.id, phone:l.phone, name:l.name, source:l.source, grade:l.grade, status:l.status, assignee:l.assignee || '', created_at:l.createdAt, updated_at:l.updatedAt, follow_up_at:l.followUpAt || '' })));
    }
    if (route === '/internal/customers/import' && req.method === 'POST') {
      if (!internal(req)) return json(res, 401, { error: 'Unauthorized' });
      const input = parse(await body(req));
      if (!Array.isArray(input.rows) || input.rows.length > 5000) return json(res, 400, { error: 'rows must be an array of at most 5000' });
      let added = 0;
      for (const row of input.rows) {
        const phone = db.normalizePhone(row.phone);
        if (phone.length < 10 || db.findLead(phone)) continue;
        db.getState().leads.push({ id: db.id(), phone, name: String(row.name || 'Guest').slice(0,80), source:'google_sheet', grade:'cold', status:'bot', assignee:null, createdAt:db.now(), updatedAt:db.now(), lastInboundAt:null, followUpAt:null, optedOut:false }); added++;
      }
      if (added) { db.save(); db.event('sheet_import', null, `${added} customers added`); }
      return json(res, 200, { added, total: input.rows.length });
    }
    if (route.startsWith('/api/') && !authorized(req)) return json(res, 401, { error: 'Set DASHBOARD_TOKEN and send Authorization: Bearer token' });
    if (route === '/api/state' && req.method === 'GET') return json(res, 200, stateView());
    if (route === '/api/demo/inbound' && req.method === 'POST') {
      if (process.env.DEMO_MODE !== 'true') return json(res, 404, { error: 'Demo disabled' });
      const input = parse(await body(req)); const { job, duplicate } = db.enqueue({ ...input, source: 'demo' });
      if (!duplicate) await db.processJob(job.id);
      return json(res, 200, { jobId: job.id, duplicate, leadId: db.findLead(job.phone)?.id });
    }
    if (route === '/api/demo/seed' && req.method === 'POST') {
      if (process.env.DEMO_MODE !== 'true') return json(res, 404, { error: 'Demo disabled' });
      const samples = [
        ['15550100101', 'Morgan Lee', 'What gear do I need for Angels Landing?'],
        ['15550100102', 'Sam Rivera', 'Can I book Vernal Fall for June 2027 for 4 people?'],
        ['15550100103', 'Casey Brown', 'Can you offer a discount on a Grand Canyon hike?'],
        ['15550100104', 'Avery Quinn', 'Hi, just exploring options.']
      ];
      for (let i = 0; i < samples.length; i++) { const [phone, name, message] = samples[i]; const { job } = db.enqueue({ messageId: `demo-seed-${i}`, phone, name, text: message, source: 'demo' }); await db.processJob(job.id); }
      return json(res, 200, stateView());
    }
    const detail = route.match(/^\/api\/leads\/([a-f0-9-]+)$/);
    if (detail && req.method === 'GET') { const result = leadDetail(detail[1]); return result.lead ? json(res, 200, result) : json(res, 404, { error: 'Lead not found' }); }
    const action = route.match(/^\/api\/leads\/([a-f0-9-]+)\/action$/);
    if (action && req.method === 'POST') {
      const lead = db.getState().leads.find(l => l.id === action[1]); if (!lead) return json(res, 404, { error: 'Lead not found' });
      const input = parse(await body(req));
      if (input.type === 'assign') { if (!db.getState().team.some(a => a.id === input.assignee && a.available)) return json(res, 400, { error: 'Choose an available team member' }); lead.assignee = input.assignee; lead.status = 'human'; }
      else if (input.type === 'resolve') { lead.status = 'resolved'; }
      else if (input.type === 'reopen') { lead.status = 'human'; lead.assignee ||= db.chooseAssignee(); }
      else if (input.type === 'grade') { if (!['hot', 'warm', 'cold'].includes(input.grade)) return json(res, 400, { error: 'Invalid grade' }); lead.grade = input.grade; }
      else if (input.type === 'followup') { const when = new Date(input.at); if (isNaN(when.getTime())) return json(res, 400, { error: 'Invalid date' }); lead.followUpAt = when.toISOString(); }
      else return json(res, 400, { error: 'Invalid action' });
      lead.updatedAt = db.now(); db.save(); db.event(input.type, lead.id, input.assignee || input.grade || input.at || '');
      return json(res, 200, leadDetail(lead.id));
    }
    const reply = route.match(/^\/api\/leads\/([a-f0-9-]+)\/reply$/);
    if (reply && req.method === 'POST') {
      const lead = db.getState().leads.find(l => l.id === reply[1]); if (!lead) return json(res, 404, { error: 'Lead not found' });
      const input = parse(await body(req)); const message = String(input.text || '').trim();
      if (!message || message.length > 1000) return json(res, 400, { error: 'Reply must be 1–1000 characters' });
      if (process.env.DEMO_MODE !== 'true' && (!lead.lastInboundAt || Date.now() - Date.parse(lead.lastInboundAt) > 24 * 3600000)) return json(res, 409, { error: 'Outside 24-hour service window; use an approved template' });
      const delivery = await sendWhatsApp(lead.phone, message);
      db.getState().messages.push({ id: db.id(), leadId: lead.id, externalId: null, direction: 'out', author: input.author || 'Team', text: message, at: db.now(), delivery }); lead.updatedAt = db.now(); db.save();
      return json(res, 200, leadDetail(lead.id));
    }
    const checkout = route.match(/^\/api\/bookings\/([a-f0-9-]+)\/checkout$/);
    if (checkout && req.method === 'POST') {
      const booking = db.getState().bookings.find(b => b.id === checkout[1]); if (!booking) return json(res, 404, { error: 'Booking not found' });
      if (!process.env.STRIPE_SECRET_KEY || !process.env.PUBLIC_BASE_URL) return json(res, 409, { error: 'Stripe and public base URL are not configured' });
      if (booking.stripeSessionId) return json(res, 200, { url: booking.checkoutUrl, status: booking.status });
      const input = parse(await body(req)); const cents = Number(input.amountCents);
      if (!Number.isInteger(cents) || cents < 100) return json(res, 400, { error: 'Staff-confirmed amount in cents required' });
      const lead = db.getState().leads.find(l => l.id === booking.leadId);
      const form = new URLSearchParams({ mode: 'payment', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(cents), 'line_items[0][price_data][product_data][name]': `Trek booking request ${booking.id.slice(0, 8)}`, 'line_items[0][quantity]': '1', success_url: `${process.env.PUBLIC_BASE_URL}/?payment=return`, cancel_url: `${process.env.PUBLIC_BASE_URL}/?payment=cancel`, 'metadata[booking_id]': booking.id, 'metadata[lead_id]': lead.id });
      const stripe = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `booking-${booking.id}` }, body: form });
      const session = await stripe.json(); if (!stripe.ok || !session.id || !session.url) throw new Error(`Stripe HTTP ${stripe.status}: ${session.error?.message || 'Unable to create session'}`);
      booking.amountCents = cents; booking.stripeSessionId = session.id; booking.checkoutUrl = session.url; booking.status = 'awaiting_payment'; db.save(); db.event('checkout_created', lead.id, booking.id);
      return json(res, 200, { url: session.url, status: booking.status });
    }
    if (route === '/api/export.csv' && req.method === 'GET') {
      const escape = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
      const rows = [['id','phone','name','source','grade','status','assignee','created_at','updated_at','follow_up_at'], ...db.getState().leads.map(l => [l.id,l.phone,l.name,l.source,l.grade,l.status,l.assignee,l.createdAt,l.updatedAt,l.followUpAt])];
      res.setHeader('Content-Disposition', 'attachment; filename="traildesk-leads.csv"'); return text(res, 200, rows.map(r => r.map(escape).join(',')).join('\r\n'), 'text/csv; charset=utf-8');
    }
    if (route === '/' || route === '/index.html' || route === '/app.js' || route === '/styles.css') {
      const filename = route === '/' ? 'index.html' : route.slice(1);
      const type = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
      return text(res, 200, fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8'), `${type}; charset=utf-8`);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, /Invalid JSON|too large|are required|not found/i.test(error.message) ? 400 : 500, { error: error.message }); }
}
if (require.main === module) http.createServer(handler).listen(PORT, process.env.DEMO_MODE === 'true' ? '127.0.0.1' : '0.0.0.0', () => console.log(`TrailDesk ${process.env.DEMO_MODE === 'true' ? 'demo' : 'live'} on http://127.0.0.1:${PORT}`));
module.exports = { handler, verifyMeta, verifyStripe };
