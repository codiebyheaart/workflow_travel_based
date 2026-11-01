const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DEMO_MODE = 'true';
const db = require('../lib');
const { verifyMeta, verifyStripe } = require('../server');

test('deduplicates inbound WhatsApp IDs and answers only sourced example facts', async () => {
  db.resetForTests();
  const first = db.enqueue({ messageId:'wamid.1', phone:'+1 (555) 010-1000', name:'Guest', text:'What gear for Angels Landing?' });
  assert.equal(first.duplicate, false);
  assert.equal(db.enqueue({ messageId:'wamid.1', phone:'15550101000', text:'Repeat' }).duplicate, true);
  await db.processJob(first.job.id);
  const state = db.getState();
  assert.equal(state.leads.length, 1);
  assert.equal(state.messages.length, 2);
  assert.equal(state.leads[0].grade, 'warm');
  assert.match(state.messages[1].text, /nps\.gov/);
  await db.processJob(first.job.id);
  assert.equal(state.messages.length, 2);
});

test('booking is a request, bargaining routes to an available human, and opt-out stops follow-up', async () => {
  db.resetForTests();
  const a = db.enqueue({ messageId:'booking-1', phone:'15550101234', name:'Buyer', text:'I want to book Angels Landing for June 2027 for 4 people' });
  await db.processJob(a.job.id);
  assert.equal(db.getState().leads[0].grade, 'hot');
  assert.equal(db.getState().bookings[0].status, 'request');
  assert.equal(db.getState().bookings[0].amountCents, null);
  const b = db.enqueue({ messageId:'bargain-1', phone:'15550101234', text:'Can you offer a discount?' });
  await db.processJob(b.job.id);
  assert.equal(db.getState().leads[0].status, 'human');
  assert.ok(db.getState().leads[0].assignee);
  const c = db.enqueue({ messageId:'stop-1', phone:'15550101234', text:'STOP' });
  await db.processJob(c.job.id);
  assert.equal(db.getState().leads[0].optedOut, true);
});

test('validates Meta and Stripe webhook signatures', () => {
  const raw = Buffer.from('{"test":true}');
  process.env.META_APP_SECRET = 'example-secret';
  const meta = `sha256=${crypto.createHmac('sha256','example-secret').update(raw).digest('hex')}`;
  assert.equal(verifyMeta(raw, meta), true);
  assert.equal(verifyMeta(raw, 'sha256=wrong'), false);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_example';
  const t = Math.floor(Date.now()/1000);
  const sig = crypto.createHmac('sha256', 'whsec_example').update(`${t}.${raw}`).digest('hex');
  assert.equal(verifyStripe(raw, `t=${t},v1=${sig}`), true);
  assert.equal(verifyStripe(raw, `t=${t-1000},v1=${sig}`), false);
});

test('n8n workflows have valid connections and no embedded credentials', () => {
  const dir = path.join(__dirname,'..','workflows');
  const files = fs.readdirSync(dir).filter(x=>x.endsWith('.json'));
  assert.equal(files.length, 3);
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir,file),'utf8');
    const flow = JSON.parse(raw), names = new Set(flow.nodes.map(n=>n.name));
    for (const [from, outputs] of Object.entries(flow.connections)) {
      assert.ok(names.has(from));
      for (const branch of outputs.main) for (const edge of branch) assert.ok(names.has(edge.node));
    }
    assert.doesNotMatch(raw,/sk_live_|sk_test_|EAAG[A-Za-z0-9]+/);
  }
});
