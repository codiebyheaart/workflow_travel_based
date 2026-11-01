const fs = require('node:fs');
const path = require('node:path');
const out = path.join(__dirname, '..', 'workflows');
fs.mkdirSync(out, { recursive: true });
let sequence = 0;
function node(name, type, typeVersion, parameters, position) { sequence++; return { id: `7c8130be-8301-4b70-8000-${String(sequence).padStart(12,'0')}`, name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters }; }
function connect(...names) { const result={}; for(let i=0;i<names.length-1;i++) result[names[i]]={main:[[{node:names[i+1],type:'main',index:0}]]}; return result; }
function write(filename, workflow) { fs.writeFileSync(path.join(out, filename), JSON.stringify({ ...workflow, pinData:{}, active:false, settings:{executionOrder:'v1'}, tags:[] },null,2)+'\n'); }

write('01-inbound-processing.json', {
  name:'TrailDesk 01 — Process WhatsApp Enquiry',
  nodes:[
    { ...node('Inbound Job','webhook',2.1,{httpMethod:'POST',path:'traildesk-process',responseMode:'responseNode',options:{}},[-500,0]), webhookId:'9b7834a8-8f4b-44b2-9b6d-51c6d238e38d' },
    { ...node('Process and Reply','httpRequest',4.2,{method:'POST',url:'http://127.0.0.1:4100/internal/process',sendHeaders:true,headerParameters:{parameters:[{name:'x-internal-key',value:"={{ $('Inbound Job').first().json.headers['x-internal-key'] }}"}]},sendBody:true,contentType:'json',specifyBody:'json',jsonBody:"={{ JSON.stringify({ jobId: $('Inbound Job').first().json.body.jobId }) }}",options:{timeout:30000}},[-200,0]),retryOnFail:true,maxTries:3,waitBetweenTries:1000 },
    node('Acknowledge Job','respondToWebhook',1.4,{respondWith:'json',responseBody:'={{ $json }}',options:{responseCode:200}},[100,0])
  ],
  connections:connect('Inbound Job','Process and Reply','Acknowledge Job')
});

write('02-google-sheets-sync.json', {
  name:'TrailDesk 02 — Sync Leads to Google Sheets',
  nodes:[
    node('Every 15 Minutes','scheduleTrigger',1.3,{rule:{interval:[{field:'minutes',minutesInterval:15}]}},[-600,0]),
    node('Read Lead Snapshot','httpRequest',4.2,{method:'GET',url:'http://127.0.0.1:4100/internal/leads',sendHeaders:true,headerParameters:{parameters:[{name:'x-internal-key',value:'={{ $env.TRAILDESK_INTERNAL_API_KEY }}'}]},options:{timeout:30000}},[-350,0]),
    node('One Item Per Lead','code',2,{jsCode:'return $input.all().flatMap(item => (Array.isArray(item.json) ? item.json : [item.json]).map(row => ({ json: row })));'},[-100,0]),
    node('Upsert Google Sheet','googleSheets',4.7,{resource:'sheet',operation:'appendOrUpdate',documentId:{__rl:true,value:'REPLACE_WITH_SPREADSHEET_ID',mode:'id'},sheetName:{__rl:true,value:'Leads',mode:'name'},columns:{mappingMode:'autoMapInputData',value:{},matchingColumns:['id'],schema:[]},options:{}},[150,0])
  ],
  connections:connect('Every 15 Minutes','Read Lead Snapshot','One Item Per Lead','Upsert Google Sheet')
});
write('03-google-sheets-import.json', {
  name:'TrailDesk 03 — Import Existing Google Sheet Customers',
  nodes:[
    node('Manual Import','manualTrigger',1,{},[-600,0]),
    node('Read Customer Sheet','googleSheets',4.7,{resource:'sheet',operation:'read',documentId:{__rl:true,value:'REPLACE_WITH_SPREADSHEET_ID',mode:'id'},sheetName:{__rl:true,value:'Customers',mode:'name'},options:{}},[-350,0]),
    node('Collect Valid Customers','code',2,{jsCode:'const rows = $input.all().map(i => i.json).filter(r => r.phone && r.name).map(r => ({ phone: String(r.phone), name: String(r.name) })); return [{ json: { rows } }];'},[-100,0]),
    node('Import to TrailDesk','httpRequest',4.2,{method:'POST',url:'http://127.0.0.1:4100/internal/customers/import',sendHeaders:true,headerParameters:{parameters:[{name:'x-internal-key',value:'={{ $env.TRAILDESK_INTERNAL_API_KEY }}'}]},sendBody:true,contentType:'json',specifyBody:'json',jsonBody:'={{ JSON.stringify($json) }}',options:{timeout:30000}},[150,0])
  ],
  connections:connect('Manual Import','Read Customer Sheet','Collect Valid Customers','Import to TrailDesk')
});
console.log('Wrote three importable n8n workflows to workflows/.');
