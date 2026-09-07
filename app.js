/* Field CRM - offline PWA
   Plan a visit, do the visit, keep the record against the account.
   State lives in IndexedDB. Nothing leaves the device unless shared.

   Storage names are load-bearing: GitHub Pages puts every repo on one
   origin, so this app shares an origin with the live Belt Call Log.
   Database 'fieldcrm', cache prefix 'fieldcrm-', localStorage 'fcrm.'.
   Never the beltcall names - that is the other app's data. */

const DB_NAME = 'fieldcrm', DB_VER = 3;
const LS = k => 'fcrm.' + k;
let db, dbReady = null, REF = null, call = null, screen = 'home', photoTarget = null;

/* ---------- storage ---------- */
function openDB(){
  if(dbReady) return dbReady;
  dbReady = new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(DB_NAME, DB_VER); }
    catch(e){ rej(new Error('this browser is blocking local storage')); return; }
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if(!d.objectStoreNames.contains('calls')) d.createObjectStore('calls', {keyPath:'id'});
      // v2: accounts move out of a single kv blob into their own store, keyed on
      // the CRM account name. 1,201 records is too much to rewrite wholesale on
      // every change, and the account view (step 6) reads them one at a time.
      if(!d.objectStoreNames.contains('accounts')) d.createObjectStore('accounts', {keyPath:'a'});
      // v3: the schedule. Owned by the desktop, sent to the phone as a plan file.
      if(!d.objectStoreNames.contains('appts')) d.createObjectStore('appts', {keyPath:'id'});
    };
    r.onsuccess = e => { db = e.target.result; res(db); };
    r.onerror = () => rej(r.error || new Error('the database would not open'));
    r.onblocked = () => rej(new Error('another copy of this app is open - close it and reopen'));
  });
  dbReady.catch(() => { dbReady = null; });   // let the next attempt try again
  return dbReady;
}
async function ready(){
  if(db) return db;
  await openDB();
  if(!db) throw new Error('local storage unavailable');
  return db;
}
async function kvGet(k){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('kv','readonly').objectStore('kv').get(k);
    t.onsuccess = ()=>res(t.result); t.onerror = ()=>rej(t.error);
  });
}
async function kvSet(k,v){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('kv','readwrite').objectStore('kv').put(v,k);
    t.onsuccess = ()=>res(); t.onerror = ()=>rej(t.error);
  });
}
async function callsPut(c){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('calls','readwrite').objectStore('calls').put(c);
    t.onsuccess = ()=>res(); t.onerror = ()=>rej(t.error);
  });
}
async function callsDel(id){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('calls','readwrite').objectStore('calls').delete(id);
    t.onsuccess = ()=>res(); t.onerror = ()=>rej(t.error);
  });
}
async function accAll(){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('accounts','readonly').objectStore('accounts').getAll();
    t.onsuccess = ()=>res(t.result||[]); t.onerror = ()=>rej(t.error);
  });
}
// One transaction for the whole book. Opening 1,201 of them is the difference
// between a second and a minute on a phone.
async function accReplaceAll(list){
  const d = await ready();
  return new Promise((res,rej)=>{
    const tx = d.transaction('accounts','readwrite'), st = tx.objectStore('accounts');
    st.clear();
    for(const a of list) st.put(a);
    tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); tx.onabort = ()=>rej(tx.error);
  });
}
async function accMerge(list){
  const d = await ready();
  return new Promise((res,rej)=>{
    const tx = d.transaction('accounts','readwrite'), st = tx.objectStore('accounts');
    for(const a of list) st.put(a);
    tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error); tx.onabort = ()=>rej(tx.error);
  });
}
async function apptsAll(){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('appts','readonly').objectStore('appts').getAll();
    t.onsuccess = ()=>res(t.result||[]); t.onerror = ()=>rej(t.error);
  });
}
async function apptsPut(ap){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('appts','readwrite').objectStore('appts').put(ap);
    t.onsuccess = ()=>res(); t.onerror = ()=>rej(t.error);
  });
}
async function apptsDel(id){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('appts','readwrite').objectStore('appts').delete(id);
    t.onsuccess = ()=>res(); t.onerror = ()=>rej(t.error);
  });
}
async function callsAll(){
  const d = await ready();
  return new Promise((res,rej)=>{
    const t = d.transaction('calls','readonly').objectStore('calls').getAll();
    t.onsuccess = ()=>res(t.result||[]); t.onerror = ()=>rej(t.error);
  });
}

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(msg){
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 2200);
}
function todayISO(){
  const d = new Date(), p = n => (n<10?'0':'')+n;
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
}
function ddmmyyyy(iso){
  if(!iso) return '';
  const p = iso.split('-'); return p[2]+'/'+p[1]+'/'+p[0];
}
function saveCall(){
  if(!call) return;
  call.updated = Date.now();
  // keep the account history index in step, so the account view is right the
  // moment you come back out of a call rather than after the next home render
  const list = CALLS_BY_ACCT.get(call.customer);
  if(list){
    const i = list.findIndex(c => c.id === call.id);
    if(i >= 0) list[i] = call; else list.unshift(call);
  } else if(call.customer){
    CALLS_BY_ACCT.set(call.customer, [call]);
  }
  return callsPut(call);
}

/* ---------- zones ---------- */
/* Lookup order is account override -> spelling correction -> suburb table -> Z12,
   and an override wins outright. suburbOf() is a line-for-line port of the build
   script's Python and must stay that way; if the two drift the zone map and the
   app disagree about where a site is. ZONE_DATA ships in zones.js and carries
   geography only. The overrides and the spelling map contain customer account
   names, so they live in IndexedDB and are loaded from a file that never enters
   the repository. */
const ZONES = (typeof ZONE_DATA !== 'undefined' && ZONE_DATA.zones) ? ZONE_DATA.zones : {};
const ZONE_ORDER = (typeof ZONE_DATA !== 'undefined' && ZONE_DATA.zoneOrder) ? ZONE_DATA.zoneOrder : Object.keys(ZONES);
const SUB2ZONE = {};
/* Known fault carried over from the planner: SUB2ZONE is built in zone order and
   the later zone wins, so ST. KILDA is claimed by Z19 and then taken by Z7. A new
   unpinned St Kilda account lands in whichever is last. Not fixed here - it needs
   a decision about which zone owns the suburb, not a code change. */
ZONE_ORDER.forEach(z => (ZONES[z] ? ZONES[z].subs : []).forEach(x => SUB2ZONE[x.toUpperCase()] = z));

let OVERRIDES = {acctZone:{}, spelling:{}, loaded:null};

function titleCase(s){ return s.toLowerCase().replace(/\b[a-z]/g, m => m.toUpperCase()); }
function suburbOf(name){
  const n = String(name).replace(/\u00a0/g,' ').trim();
  const parts = n.split(/\s-\s*|\s*-\s/);
  if(parts.length === 1) return null;
  return parts[parts.length-1].replace(/\(.*?\)/g,'').trim().toUpperCase();
}
function zoneOf(acctName, sub){
  if(OVERRIDES.acctZone[acctName]) return OVERRIDES.acctZone[acctName];   // overrides win outright
  if(!sub) return 'Z12';
  const canon = (OVERRIDES.spelling[sub] || titleCase(sub)).toUpperCase();
  return SUB2ZONE[canon] || SUB2ZONE[sub] || 'Z12';
}
function zoneName(z){ return ZONES[z] ? (z + ' ' + ZONES[z].name) : (z || 'unzoned'); }
/* CAMBRIDGE NZ resolves to Z24 Tasmania and PICTON NZ to Z1 Sydney, because the
   suburb name matches an Australian one and nothing in the lookup knows about the
   country. Both are wrong answers rather than near misses. Rather than guess, the
   import counts them and says so, so they can be pinned with an override. */
function looksNZ(sub, zone){
  if(!sub) return false;
  if(!/\bNZ\b|NEW ZEALAND/.test(sub)) return false;
  const z = ZONES[zone];
  return !z || !/NZ|NEW ZEALAND/i.test(z.cov || '');
}

/* ---------- contact ranking ---------- */
/* The Job Role picklist in the export's hiddenSheet is authoritative and holds 17
   values. The planner ranked 9 of them; the other 8 fell to 99 and sorted below a
   blank role, which put Hygienic / Sanitation - someone you want on a belt call -
   at the bottom of every contact list. The full picklist is ranked here. The nine
   the planner already ranked keep their order relative to each other; the eight
   new ones are slotted around them. Order matters: engineer - packaging is tested
   before engineer, or it never matches. */
const RANK_RULES = [
  [/engineer\s*[-\/]\s*packaging/, 8],
  [/maintenance/, 1],
  [/plant\s*manager/, 2],
  [/engineer/, 3],
  [/operations|production/, 4],
  [/hygien|sanitation/, 5],
  [/purchasing/, 6],
  [/project\s*manager/, 7],
  [/quality\s*assurance|\bqa\b|compliance/, 9],
  [/c-?suite|president|owner/, 10],
  [/product\s*manager/, 11],
  [/research|development|\br\s*&\s*d\b/, 12],
  [/consultant|contractor/, 13],
  [/sales/, 14],
  [/marketing/, 15],
  [/accounting/, 16],
  [/unknown/, 17]
];
function roleRank(r){
  const s = String(r||'').toLowerCase();
  for(const [re,n] of RANK_RULES) if(re.test(s)) return n;
  return 99;
}

/* ---------- phone ---------- */
/* The planner handled +61 and 61 only, so every New Zealand mobile fell through to
   'check' and printed exactly as stored. NZ is handled here, but only when the
   source carried an explicit +64 or 64 prefix. A bare 021... is ambiguous - it is
   a valid NZ mobile and a valid Australian Sydney landline - and guessing would
   reformat Australian numbers wrongly. Ambiguous numbers still return 'check'. */
function normPhone(v){
  const s = String(v==null?'':v).trim();
  if(!s) return ['','none'];
  let t = s.replace(/[\s()\-\.]/g,'');
  let nz = false;
  if(t.startsWith('+64')){ nz = true; t = '0'+t.slice(3); }
  else if(t.startsWith('0064')){ nz = true; t = '0'+t.slice(4); }
  else if(/^64[23479]/.test(t) && t.length > 9){ nz = true; t = '0'+t.slice(2); }
  else if(t.startsWith('+61')) t = '0'+t.slice(3);
  else if(t.startsWith('61') && t.length > 10) t = '0'+t.slice(2);
  if(nz){
    if(/^02\d{7,8}$/.test(t)) return [t.slice(0,3)+' '+t.slice(3,6)+' '+t.slice(6), 'mobile'];
    if(/^0\d{7,8}$/.test(t))  return [t.slice(0,2)+' '+t.slice(2,5)+' '+t.slice(5), 'landline'];
    return [s, 'check'];
  }
  if(/^\d{10}$/.test(t)){
    if(t.startsWith('04')) return [t.slice(0,4)+' '+t.slice(4,7)+' '+t.slice(7), 'mobile'];
    return ['('+t.slice(0,2)+') '+t.slice(2,6)+' '+t.slice(6), 'landline'];
  }
  return [s, 'check'];
}

/* ================= belt reference data =================
   Ported from Belt Call Log v13. Reads Plant_Audit_Template_1.xlsm and keeps the
   catalogue in kv under beltref: every valid Series > Style > Material > Colour,
   the link geometry the width check needs, and the sprocket table. */

/* ---------- belt reference import ----------
   Read straight out of Plant_Audit_Template_1.xlsm so the app stays in step with the
   workbook rather than carrying its own copy of the catalogue. Three sheets matter:

     Belt Audit Data      Series_Ind / Belt_Style_Ind / Material_Ind / COLOR_IND
                          -> every valid Series > Style > Material > Colour combination
                          Series_Ind / Belt_Style_Ind / Material_Ind / Current_Lnk_Wth_Mm /
                          Belt_Link_Increment / Minimum_Width_In_L / Protrusion_Thk_Mm
                          -> link geometry, which is what makes the width check possible
     SPROCKET SPILL DATA  Belt Series / Bore Description / Size Description / Material /
                          Description / Part Number
     BELT DATA            Series + Pitch, and the master lists the FORM sheet validates against

   Both blocks on 'Belt Audit Data' repeat the same three header names, so columns are found
   relative to an anchor that appears once (COLOR_IND, Current_Lnk_Wth_Mm, Belt Series) rather
   than by a bare name lookup, which would silently pick up the wrong block. */
const REF_SHEETS = ['Belt Audit Data','SPROCKET SPILL DATA','BELT DATA'];
const norm = s => String(s==null?'':s).replace(/\s+/g,' ').trim().toLowerCase();
const cell = v => (v==null ? '' : String(v).trim());
const num  = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

function findSheet(wb, want){
  if(wb.Sheets[want]) return wb.Sheets[want];
  const k = wb.SheetNames.find(n => norm(n) === norm(want));
  if(!k) throw new Error('sheet "'+want+'" is not in that workbook');
  return wb.Sheets[k];
}
function headerRow(rows, anchor){
  for(let i=0; i<Math.min(rows.length, 8); i++){
    if((rows[i]||[]).some(v => norm(v) === anchor)) return i;
  }
  throw new Error('could not find the "'+anchor+'" column');
}
function colAt(H, name, anchor, dir){
  const t = norm(name);
  if(dir < 0){ for(let i=anchor-1; i>=0; i--) if(H[i]===t) return i; }
  else { for(let i=anchor+1; i<H.length; i++) if(H[i]===t) return i; }
  throw new Error('could not find the "'+name+'" column');
}
function colOf(H, name){
  const i = H.indexOf(norm(name));
  if(i < 0) throw new Error('could not find the "'+name+'" column');
  return i;
}
function uniqSort(arr){
  return [...new Set(arr.filter(x => x !== '' && x != null))].sort((a,b)=>{
    const na = Number(a), nb = Number(b);
    const A = a !== '' && !isNaN(na), B = b !== '' && !isNaN(nb);
    if(A && B) return na - nb;
    if(A) return -1;
    if(B) return 1;
    return String(a).localeCompare(String(b));
  });
}

async function importRef(file){
  toast('Reading workbook - this takes a moment...');
  await new Promise(r => setTimeout(r, 60));     // let the toast paint before we block the thread
  const buf = await file.arrayBuffer();
  const opts = {type:'array', cellStyles:false, cellNF:false, cellHTML:false, cellFormula:false};
  let wb = XLSX.read(buf, Object.assign({sheets:REF_SHEETS}, opts));
  if(!REF_SHEETS.every(n => wb.SheetNames.includes(n) && wb.Sheets[n])) wb = XLSX.read(buf, opts);
  const grid = ws => XLSX.utils.sheet_to_json(ws, {header:1, raw:true, blankrows:true, defval:''});

  /* combinations and link geometry */
  const bad = grid(findSheet(wb, 'Belt Audit Data'));
  const bh = headerRow(bad, 'color_ind');
  const BH = (bad[bh]||[]).map(norm);
  const cCol = colOf(BH, 'COLOR_IND');
  const cSer = colAt(BH, 'Series_Ind', cCol, -1);
  const cSty = colAt(BH, 'Belt_Style_Ind', cCol, -1);
  const cMat = colAt(BH, 'Material_Ind', cCol, -1);
  const gLw  = colOf(BH, 'Current_Lnk_Wth_Mm');
  const gSer = colAt(BH, 'Series_Ind', gLw, -1);
  const gSty = colAt(BH, 'Belt_Style_Ind', gLw, -1);
  const gMat = colAt(BH, 'Material_Ind', gLw, -1);
  const gInc = colAt(BH, 'Belt_Link_Increment', gLw, 1);
  const gMin = colAt(BH, 'Minimum_Width_In_L', gLw, 1);
  const gPro = colAt(BH, 'Protrusion_Thk_Mm', gLw, 1);
  if(gSer === cSer) throw new Error('the geometry block on "Belt Audit Data" is missing');

  const combos = [], geom = [];
  for(let i=bh+1; i<bad.length; i++){
    const r = bad[i] || [];
    if(cell(r[cSer])) combos.push([cell(r[cSer]), cell(r[cSty]), cell(r[cMat]), cell(r[cCol])]);
    if(cell(r[gSer])) geom.push([cell(r[gSer]), cell(r[gSty]), cell(r[gMat]),
      num(r[gLw]), num(r[gInc]) || 1, num(r[gMin]), num(r[gPro])]);
  }

  /* sprockets */
  const spl = grid(findSheet(wb, 'SPROCKET SPILL DATA'));
  const sh = headerRow(spl, 'belt series');
  const SH = (spl[sh]||[]).map(norm);
  const sSer = colOf(SH, 'Belt Series');
  const sBor = colAt(SH, 'Bore Description', sSer, 1);
  const sPd  = colAt(SH, 'Size Description', sSer, 1);
  const sMat = colAt(SH, 'Material', sSer, 1);
  const sDsc = colAt(SH, 'Description', sSer, 1);
  const sPn  = colAt(SH, 'Part Number', sSer, 1);
  const sprockets = [];
  for(let i=sh+1; i<spl.length; i++){
    const r = spl[i] || [];
    if(!cell(r[sSer])) continue;
    sprockets.push([cell(r[sSer]), cell(r[sBor]), cell(r[sPd]), cell(r[sMat]), cell(r[sDsc]), cell(r[sPn])]);
  }

  /* master lists and per-series pitch */
  const bd = grid(findSheet(wb, 'BELT DATA'));
  const dh = headerRow(bd, 'rod material');
  const DH = (bd[dh]||[]).map(norm);
  const dSer = colOf(DH, 'Series'), dPit = colOf(DH, 'Pitch');
  const dMat = colOf(DH, 'Material'), dCol = colOf(DH, 'Colour');
  const dRod = colOf(DH, 'Rod Material'), dFlt = colOf(DH, 'Flight Style');
  const dSg  = colOf(DH, 'Sideguard Style'), dInd = colOf(DH, 'Indent');

  const pitch = {}, materials = [], colours = [], rods = [], flightTypes = [], sideguardTypes = [];
  const indentGroups = [];
  for(let i=dh+1; i<bd.length; i++){
    const r = bd[i] || [];
    const s = cell(r[dSer]);
    if(/^series[_ ]/i.test(s)){
      const p = num(r[dPit]);
      if(p > 0) pitch[s.replace(/^series[_ ]/i,'')] = p;
    }
    if(cell(r[dMat])) materials.push(cell(r[dMat]));
    if(cell(r[dCol])) colours.push(cell(r[dCol]));
    if(cell(r[dRod])) rods.push(cell(r[dRod]));
    if(cell(r[dFlt])) flightTypes.push(cell(r[dFlt]));
    if(cell(r[dSg]))  sideguardTypes.push(cell(r[dSg]));
    const iv = cell(r[dInd]);
    if(iv){
      const head = iv.match(/^-{2,}\s*(.+?)\s*-{2,}$/);
      if(head) indentGroups.push([head[1], []]);
      else if(indentGroups.length) indentGroups[indentGroups.length-1][1].push(iv);
    }
  }

  if(!combos.length) throw new Error('no belt combinations found - check the workbook is the right one');
  if(!sprockets.length) throw new Error('no sprocket rows found on "SPROCKET SPILL DATA"');

  const payload = {
    combos, geom, sprockets, pitch, indentGroups,
    materials, colours, rods, flightTypes, sideguardTypes,
    imported: Date.now(),
    counts: {combos:combos.length, geom:geom.length, sprockets:sprockets.length,
             series:new Set(combos.map(c=>c[0])).size}
  };
  await kvSet('beltref', payload);
  await logLoad(file.name || 'plant audit workbook', 'beltref',
    payload.combos.length + ' belt combinations, ' + payload.sprockets.length + ' sprocket rows');
  REF = payload;
  renderRefStat(); renderHomeSetup(); buildBeltRef();
  toast('Loaded '+payload.counts.combos+' belt specs and '+payload.counts.sprockets+' sprockets');
}
function renderRefStat(){
  const el = $('refStat');
  if(!el) return;
  if(!REF){ el.textContent = 'No data loaded.'; return; }
  const d = new Date(REF.imported);
  el.innerHTML = '<b>'+REF.counts.combos+'</b> belt specs across <b>'+REF.counts.series+'</b> series, <b>'+
    REF.counts.sprockets+'</b> sprockets, <b>'+REF.counts.geom+'</b> geometry rows<br>Imported '+
    d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
/* renderManStat and the manuals screen arrive with the manual library port.
   Left out rather than left dangling against markup that is not here yet. */

function renderHomeSetup(){
  const el = $('homeSetup');
  if(!el) return;
  const missing = [];
  if(!ACCOUNTS.length) missing.push('contact database');
  if(!REF) missing.push('belt reference data');
  if(!missing.length){ el.className = 'msg'; el.innerHTML = ''; return; }
  el.className = 'msg info show';
  el.innerHTML = 'No '+missing.join(' or ')+' loaded yet. <span class="lnk" data-go="home">see Data on the home screen</span>';
}

/* ---------- one importer ---------- */
/* Planner schema, call-log dedupe. .xlsx goes through SheetJS, .csv through the
   parser below; both land in the same array of header-keyed rows and take the
   same path from there. */
const CAD = {'High':'P1 Monthly','Medium':'P2 Quarterly','Low':'P3 Half-yearly','No Focus':'P4 Validate & rate'};
const FOCUS_RANK = {'High':0,'Medium':1,'Low':2,'No Focus':3};

/* Column names as they appear in the ANZ Active Food Contacts view. Matching is
   case-insensitive, whitespace-tolerant, and accepts the '(Account Name) (Account)'
   suffix on the account-level fields, so a minor export change will not break it.
   A renamed column will. The leading space on ' Full Name' is real. */
const COL = {
  cid:'(Do Not Modify) Contact', chk:'(Do Not Modify) Row Checksum', mod:'(Do Not Modify) Modified On',
  ctype:'Contact Type', full:'Full Name', first:'First Name', last:'Last Name',
  acct:'Account Name', role:'Job Role', title:'Job Title',
  e1:'Email 1', e2:'Email 2', e3:'Email 3', mob:'Mobile',
  mgr:'Account Manager', tier:'Account Tier', foc:'Account Focus', rep:'Account Representative',
  lad:'Last Activity Date', lastAppt:'Last Appointment', team:'Industry Team', seg:'Segment'
};
function pick(row, name){
  const want = name.trim().toLowerCase();
  if(row[name] != null) return String(row[name]).trim();
  const k = Object.keys(row).find(x => {
    const h = x.replace(/\u00a0/g,' ').trim().toLowerCase();
    return h === want || h.startsWith(want + ' (');
  });
  return k && row[k] != null ? String(row[k]).replace(/\u00a0/g,' ').trim() : '';
}
function parseCsv(text){
  const rows=[]; let f='', row=[], q=false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(q){
      if(c === '"'){ if(text[i+1] === '"'){ f+='"'; i++; } else q=false; } else f+=c;
    } else if(c === '"'){ q=true; }
    else if(c === ','){ row.push(f); f=''; }
    else if(c === '\n'){ row.push(f); rows.push(row); row=[]; f=''; }
    else if(c !== '\r'){ f+=c; }
  }
  if(f.length || row.length){ row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
function csvToObjects(text){
  const rows = parseCsv(text);
  if(rows.length < 2) throw new Error('that file has headers but no data rows');
  const hdr = rows[0];
  return rows.slice(1).map(r => {
    const o = {};
    hdr.forEach((h,i) => o[h] = r[i] == null ? '' : r[i]);
    return o;
  });
}
async function readRows(file){
  const name = (file.name||'').toLowerCase();
  if(name.endsWith('.csv')){
    return {rows: csvToObjects(await file.text()), hidden: null};
  }
  if(typeof XLSX === 'undefined'){
    throw new Error('the spreadsheet library has not loaded - open the app online once, or import a .csv');
  }
  const wb = XLSX.read(await file.arrayBuffer(), {type:'array'});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {defval:'', raw:false});
  /* hiddenSheet maps every visible header to its Dynamics schema name and carries
     the account entity GUID. It is the shape Dynamics accepts back through the
     import wizard, so it is kept whole for the write-back path rather than being
     read as CRM metadata and discarded. Losing it loses the round trip. */
  let hidden = null;
  const hs = wb.SheetNames.find(n => n.toLowerCase() === 'hiddensheet');
  if(hs) hidden = XLSX.utils.sheet_to_json(wb.Sheets[hs], {header:1, defval:''});
  return {rows, hidden};
}

function buildAccounts(rows){
  const groups = {};
  for(const r of rows){
    const nm = pick(r, COL.acct);
    if(!nm) continue;
    (groups[nm] = groups[nm] || []).push(r);
  }
  const out = [];
  for(const nm of Object.keys(groups)){
    const rs = groups[nm];
    const sub = suburbOf(nm), z = zoneOf(nm, sub);
    const disp = sub ? (OVERRIDES.spelling[sub] || titleCase(sub)) : '';
    const foc = pick(rs[0], COL.foc) || 'No Focus';

    // latest Last Activity Date across the account's rows, and days since
    let last = '', lastT = -1;
    for(const r of rs){
      const v = pick(r, COL.lad); if(!v) continue;
      const t = Date.parse(v); if(!isNaN(t) && t > lastT){ lastT = t; last = v; }
    }
    let lastAppt = '', laT = -1;
    for(const r of rs){
      const v = pick(r, COL.lastAppt); if(!v) continue;
      const t = Date.parse(v); if(!isNaN(t) && t > laT){ laT = t; lastAppt = v; }
    }

    /* Call-log dedupe: collapse duplicate contacts within the account, keeping the
       row that scores highest on completeness. The (Do Not Modify) values belong to
       a specific row, so the winning row's identifiers are the ones kept - writing
       back under a losing row's checksum would be rejected. */
    const seen = {};
    for(const r of rs){
      let n = pick(r, COL.full);
      if(!n || n === '.' || n === '. .') n = (pick(r,COL.first)+' '+pick(r,COL.last)).trim();
      if(!n || n === '.') continue;
      const emails = [pick(r,COL.e1), pick(r,COL.e2), pick(r,COL.e3)].filter(Boolean);
      const [p, pk] = normPhone(pick(r, COL.mob));
      const role = pick(r, COL.role);
      const score = (emails.length?2:0) + (p?2:0) + (role?1:0);
      const k = n.toLowerCase();
      if(!seen[k] || score > seen[k]._s){
        seen[k] = {n:n, r:role, t:pick(r,COL.title), p:p, pk:pk, e:emails,
                   ct:pick(r,COL.ctype), id:pick(r,COL.cid), chk:pick(r,COL.chk),
                   mod:pick(r,COL.mod), _s:score};
      }
    }
    const cs = Object.values(seen)
      .map(c => { delete c._s; return c; })
      .sort((a,b) => roleRank(a.r) - roleRank(b.r) || a.n.localeCompare(b.n));

    out.push({
      a:nm, sub:disp, z:z, tier:pick(rs[0],COL.tier), foc:foc, cad:CAD[foc]||CAD['No Focus'],
      seg:pick(rs[0],COL.seg), team:pick(rs[0],COL.team), mgr:pick(rs[0],COL.mgr),
      rep:pick(rs[0],COL.rep), last:last, lastAppt:lastAppt,
      idle: lastT > 0 ? Math.round((Date.now()-lastT)/86400000) : null,
      c:cs
    });
  }
  out.sort((a,b) => (FOCUS_RANK[a.foc] ?? 3) - (FOCUS_RANK[b.foc] ?? 3) ||
    a.sub.localeCompare(b.sub) || a.a.localeCompare(b.a));
  return out;
}

let ACCOUNTS = [], ACC_BY_NAME = new Map(), META = null;
function indexAccounts(list){
  ACCOUNTS = list;
  ACC_BY_NAME = new Map(list.map(a => [a.a, a]));
}
async function loadAccounts(){
  indexAccounts(await accAll());
  APPTS = await apptsAll();
  REF = await kvGet('beltref') || null;
  await loadUse();
  WEEKS = await kvGet('weeks') || {};
  MGR_OF = await kvGet('mgrOf') || {};
  LOAD_LOG = await kvGet('loadLog') || [];
  META = await kvGet('meta') || null;
  const ov = await kvGet('overrides');
  if(ov) OVERRIDES = Object.assign({acctZone:{}, spelling:{}}, ov);
}

async function importCrm(file){
  toast('Reading file...');
  const {rows, hidden} = await readRows(file);
  if(!rows.length) throw new Error('no rows found in that file');
  if(!rows.some(r => pick(r, COL.acct))) throw new Error('no "Account Name" column found');
  const list = buildAccounts(rows);
  if(!list.length) throw new Error('no accounts could be read from that file');

  await accReplaceAll(list);
  const mgrCount = {}, repCount = {};
  for(const a of list){
    if(a.mgr) mgrCount[a.mgr] = (mgrCount[a.mgr]||0)+1;
    if(a.rep) repCount[a.rep] = (repCount[a.rep]||0)+1;
  }
  const contacts = list.reduce((n,a) => n + a.c.length, 0);
  const meta = {
    imported: Date.now(),
    source: file.name || 'import',
    rows: rows.length,
    counts: {accounts:list.length, contacts:contacts},
    managers: Object.keys(mgrCount).sort((a,b) => mgrCount[b]-mgrCount[a]),
    reps: Object.keys(repCount).sort((a,b) => repCount[b]-repCount[a]),
    hiddenSheet: hidden,          // kept whole for the Dynamics write-back path
    unzoned: list.filter(a => a.z === 'Z12').length,
    nzSuspect: list.filter(a => looksNZ(suburbOf(a.a), a.z)).map(a => a.a),
    noEmail: list.reduce((n,a) => n + a.c.filter(c => !c.e.length).length, 0),
    noMobile: list.reduce((n,a) => n + a.c.filter(c => c.pk === 'none').length, 0),
    phoneCheck: list.reduce((n,a) => n + a.c.filter(c => c.pk === 'check').length, 0),
    unranked: list.reduce((n,a) => n + a.c.filter(c => roleRank(c.r) === 99).length, 0)
  };
  await kvSet('meta', meta);
  META = meta;
  indexAccounts(list);
  await logLoad(file.name || 'CRM export', 'crm',
    list.length + ' accounts, ' + contacts + ' contacts, ' + rows.length + ' rows read');
  // the planner's rule, kept: an appointment against an account that no longer
  // exists is dropped rather than left pointing at nothing
  const orphans = APPTS.filter(ap => !ACC_BY_NAME.has(ap.acct));
  for(const ap of orphans) await apptsDel(ap.id);
  if(orphans.length){
    APPTS = APPTS.filter(ap => ACC_BY_NAME.has(ap.acct));
    meta.orphanedAppts = orphans.length;
  }
  const lostMoves = Object.keys(MGR_OF).filter(n => !ACC_BY_NAME.has(n));
  if(lostMoves.length){
    lostMoves.forEach(n => { delete MGR_OF[n]; });
    await saveMgrOf();
    meta.orphanedMoves = lostMoves.length;
  }
  Object.keys(WEEKS).forEach(k => { if(!ZONES[(WEEKS[k]||{}).zone]) delete WEEKS[k]; });
  await saveWeeks();
  plan.zone = '';
  renderDbStat();
  fillManagers();
  toast('Imported '+list.length+' accounts');
}

async function importOverrides(file){
  const o = JSON.parse(await file.text());
  if(!o || (!o.acctZone && !o.spelling)) throw new Error('that file has no acctZone or spelling map');
  OVERRIDES = {acctZone:o.acctZone||{}, spelling:o.spelling||{}, loaded:Date.now(),
               file: file.name || 'zone-overrides.json'};
  await kvSet('overrides', OVERRIDES);
  renderDbStat();
  await logLoad(file.name || 'zone-overrides.json', 'overrides',
    Object.keys(OVERRIDES.acctZone).length + ' account pins, ' +
    Object.keys(OVERRIDES.spelling).length + ' spelling corrections');
  toast('Loaded ' + (file.name || 'zone overrides') + ' - ' +
    Object.keys(OVERRIDES.acctZone).length + ' pins, ' +
    Object.keys(OVERRIDES.spelling).length + ' spellings');
}

function renderDbStat(){
  const el = $('dbStat');
  if(!META){ el.textContent = 'No data loaded.'; return; }
  const d = new Date(META.imported);
  const ov = Object.keys(OVERRIDES.acctZone).length;
  el.innerHTML =
    '<b>'+META.counts.accounts+'</b> accounts, <b>'+META.counts.contacts+'</b> contacts<br>'+
    'Imported '+d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+
    ' from '+esc(META.source)+'<br>'+
    ov+' zone override'+(ov===1?'':'s')+' loaded';
  renderImportReport();
}
function renderImportReport(){
  const el = $('impReport');
  if(!el) return;
  if(!META){ el.innerHTML = ''; return; }
  const L = [];
  L.push(META.unzoned+' account'+(META.unzoned===1?'':'s')+' fell to Z12 Interstate / Unconfirmed');
  if(META.nzSuspect && META.nzSuspect.length)
    L.push('<span class="flagline">'+META.nzSuspect.length+' New Zealand site'+
      (META.nzSuspect.length===1?'':'s')+' resolved to an Australian zone &mdash; pin with an override</span>');
  L.push(META.noEmail+' contacts without an email, '+META.noMobile+' without a mobile');
  if(META.phoneCheck) L.push(META.phoneCheck+' phone numbers did not normalise and print as stored');
  if(META.unranked) L.push(META.unranked+' contacts have a job role outside the picklist and sort last');
  if(META.orphanedMoves) L.push(META.orphanedMoves+' manager reassignment'+
    (META.orphanedMoves===1?'':'s')+' pointed at accounts not in this export and were dropped');
  if(META.orphanedAppts) L.push('<span class="flagline">'+META.orphanedAppts+
    ' planned appointment'+(META.orphanedAppts===1?'':'s')+
    ' pointed at accounts that are not in this export and were dropped</span>');
  if(!META.hiddenSheet) L.push('<span class="flagline">No hiddenSheet in that file &mdash; the Dynamics write-back path needs the original .xlsx</span>');
  el.innerHTML = '<ul class="rep">'+L.map(x=>'<li>'+x+'</li>').join('')+'</ul>';
}
function fillManagers(){
  const sel = $('cMgr'); sel.innerHTML = '';
  const list = (META && META.managers.length) ? META.managers : ['Unassigned'];
  list.forEach(m => { const o = document.createElement('option'); o.textContent = m; sel.appendChild(o); });
  const saved = localStorage.getItem(LS('mgr'));
  if(saved && list.includes(saved)) sel.value = saved;
  updateMgrHint();
}
function updateMgrHint(){
  if(!META) return;
  const m = $('cMgr').value;
  const n = ACCOUNTS.filter(a => a.mgr === m).length;
  $('mgrHint').textContent = n + ' accounts for ' + m + ' - search covers all accounts';
}

/* ---------- navigation ---------- */
const TITLES = {
  home:['Field CRM',''], account:['New call','Account'], contacts:['New call','Contacts'],
  accounts:['Accounts',''], acct:['Account',''], plan:['Plan',''], today:['Today',''],
  dash:['Call','Menu'], belt:['Add belt',''], project:['Add project',''],
  note:['General note',''], health:['Health check',''], compile:['Compile','']
};
/* ---------- navigation ----------
   Screens are swapped, but every move is also pushed onto the browser history,
   so the Android back gesture moves back a screen instead of closing the app.
   Before this, the app was a single history entry: one swipe from the middle of
   a call and you were out of an installed PWA with no obvious way back in.

   The URL never changes. A hash would survive a reload but would also mean a
   cold start could land on a screen whose data has not been read yet, so state
   objects carry the screen instead.

   Dialogs get their own entry, so a back gesture with the appointment dialog
   open closes the dialog rather than leaving the screen behind it. */

const DIALOGS = ['dlg','mvdlg','rdlg'];
function openDialogs(){
  return DIALOGS.filter(id => { const d = $(id); return d && d.hasAttribute('open'); });
}
function closeDialogsNow(){
  DIALOGS.forEach(id => {
    const d = $(id);
    if(!d || !d.hasAttribute('open')) return;
    if(d.close) d.close(); else d.removeAttribute('open');
  });
  dlgAppt = null; editingAppt = null; movingAppt = null;
}
// Push an entry when a dialog opens, so back closes it. Called by the openers.
function pushDialog(id){
  try { history.pushState({screen: screen, dialog: id}, '', location.href); } catch(e){}
}

/* Screens that read the open call. Reaching one without a call - a stale history
   entry after the call was closed, a back gesture into a finished call - threw on
   the first property read and left a blank screen with no way forward. */
const CALL_SCREENS = ['dash','belt','project','note','health','compile'];
function showScreen(name){
  if(CALL_SCREENS.includes(name) && !call) name = 'home';
  screen = name;
  document.querySelectorAll('.scr').forEach(s=>s.classList.remove('on'));
  $('s-'+name).classList.add('on');
  $('back').style.display = (name==='home') ? 'none' : 'block';
  $('title').textContent = TITLES[name] ? TITLES[name][0] : 'Field CRM';
  $('subtitle').textContent = call ? (call.customer + (call.site?' - '+call.site:'')) : 'No call open';
  const inCall = call && ['dash','belt','project','note','health','compile'].includes(name);
  $('bar').style.display = inCall ? 'flex' : 'none';
  window.scrollTo(0,0);
  if(name==='dash') renderDash();
  if(name==='compile') renderCompileStat();
  if(name==='home') renderHome();
  if(name==='accounts') renderBrowse();
  if(name==='plan') renderPlan();
  if(name==='today'){ renderToday(); $('title').textContent = todayView==='today' ? 'Today' : 'This week'; }
  // the plan breaks out of the phone column; everything else stays in it
  document.body.classList.toggle('planning', name === 'plan');
}
function go(name, replace){
  /* Re-showing the same screen is a redraw, not a move. Pushing an entry for it
     would mean two back presses to leave a screen you never navigated twice. */
  const same = (name === screen) || replace;
  showScreen(name);
  try {
    const st = {screen: name};
    if(same) history.replaceState(st, '', location.href);
    else history.pushState(st, '', location.href);
  } catch(e){ /* history unavailable - the app still works, the gesture does not */ }
}
window.addEventListener('popstate', e => {
  const st = e.state || {screen:'home'};
  // a dialog was open and the entry behind it has been reached: just close it
  if(openDialogs().length && !st.dialog){ closeDialogsNow(); return; }
  if(st.dialog) return;      // going forward into a dialog entry: leave it be
  showScreen(st.screen || 'home');
});
/* The header button now asks the browser to go back, so it and the gesture can
   never disagree about where "back" is. From home there is nowhere to go. */
$('back').addEventListener('click', ()=>{
  if(screen === 'home') return;
  if(history.length > 1) history.back();
  else go('home');
});

function renderHomeCounts(){
  if(!ACCOUNTS.length){
    $('acctInfo').textContent = 'Nothing loaded';
    $('dueInfo').textContent = 'Nothing loaded';
    return;
  }
  const mgr = $('cMgr').value;
  const mine = ACCOUNTS.filter(a => a.mgr === mgr).length;
  $('acctInfo').textContent = mine + ' yours of ' + ACCOUNTS.length;
  const cv = coverage(mgr);
  $('dueInfo').textContent = (cv.due + cv.never)
    ? (cv.due + cv.never) + ' to book' + (cv.booked ? ', ' + cv.booked + ' already in' : '')
    : (cv.booked ? cv.booked + ' booked, nothing else due' : 'nothing due');
  renderPlanCount();
}

/* ---------- the account record ---------- */
/* Cadence stops being a label here. The planner's `idle` counts days since CRM
   activity, which moves when anyone touches the record for any reason. What is
   actually wanted is days since you were last there, and now that visits are
   stored the app can work that out from its own calls.

   Both are kept and shown side by side, because they answer different questions
   and they disagree often enough to be worth seeing. `due` is computed from your
   own visits where there are any, and falls back to the CRM date where there are
   none - otherwise every account you have not yet visited would read as overdue
   on day one. */
const CAD_DAYS = {'P1 Monthly':30, 'P2 Quarterly':91, 'P3 Half-yearly':182, 'P4 Validate & rate':365};
let CALLS_BY_ACCT = new Map();

function indexCalls(all){
  CALLS_BY_ACCT = new Map();
  for(const c of all){
    if(!c.customer) continue;
    const k = c.customer;
    if(!CALLS_BY_ACCT.has(k)) CALLS_BY_ACCT.set(k, []);
    CALLS_BY_ACCT.get(k).push(c);
  }
  CALLS_BY_ACCT.forEach(list => list.sort((a,b) => (b.when||b.updated||0) - (a.when||a.updated||0)));
}
function callsFor(name){ return CALLS_BY_ACCT.get(name) || []; }
function callWhen(c){
  if(c.when) return c.when;
  // dates are stored DD/MM/YYYY; fall back to the record timestamp
  const p = String(c.date||'').split('/');
  if(p.length === 3){ const t = Date.parse(p[2]+'-'+p[1]+'-'+p[0]); if(!isNaN(t)) return t; }
  return c.updated || 0;
}
function lastVisit(name){
  const list = callsFor(name).filter(c => c.status !== 'cancelled' && c.status !== 'missed');
  if(!list.length) return null;
  return Math.max(...list.map(callWhen));
}
function daysSince(t){ return t == null ? null : Math.floor((Date.now()-t)/86400000); }
/* An account with a visit already booked is not a job to do. Left out of this,
   the Due list keeps naming accounts that are already handled, which is the
   fastest way to make a list nobody reads. Booked is its own state. */
function nextBooked(name){
  const t = todayISOdate();
  const dates = APPTS
    .filter(ap => ap.acct === name && ap.date >= t &&
                  !['cancelled','missed','done'].includes(apStatus(ap)))
    .map(ap => ap.date).sort();
  return dates.length ? dates[0] : null;
}
/* Days since the account was last covered, whether that is past its cadence,
   which clock the answer came from, and whether something is already in the
   diary. state is what the UI reads:
     covered  inside its cadence
     booked   past it, but a visit is planned
     due      past it, nothing planned
     never    no visit and no CRM activity to go on */
function dueState(a){
  const target = CAD_DAYS[a.cad] || CAD_DAYS['P4 Validate & rate'];
  const booked = nextBooked(a.a);
  const lv = lastVisit(a.a);
  let days = null, basis = 'never', over = true;
  if(lv != null){ days = daysSince(lv); basis = 'visit'; over = days > target; }
  else if(a.idle != null){ days = a.idle; basis = 'crm'; over = a.idle > target; }
  const state = !over ? 'covered' : (booked ? 'booked' : (basis === 'never' ? 'never' : 'due'));
  return {days, over, basis, target, booked, state};
}
/* Booked accounts are excluded by default. They are still past cadence, and the
   caller can ask for them, but they are not work outstanding. */
function overdueAccounts(mgr, opts){
  opts = opts || {};
  return ACCOUNTS
    .filter(a => !mgr || effMgr(a) === mgr)
    .map(a => ({a:a, d:dueState(a)}))
    .filter(x => x.d.over && (opts.includeBooked || !x.d.booked))
    .sort((x,y) => (FOCUS_RANK[x.a.foc] ?? 3) - (FOCUS_RANK[y.a.foc] ?? 3) ||
                   (y.d.days ?? 99999) - (x.d.days ?? 99999));
}
// How the book stands, for one manager or for everyone.
function coverage(mgr){
  const out = {covered:0, booked:0, due:0, never:0, total:0};
  ACCOUNTS.forEach(a=>{
    if(mgr && effMgr(a) !== mgr) return;
    out.total++;
    out[dueState(a).state]++;
  });
  return out;
}
function dueLabel(d){
  if(d.booked) return 'booked ' + dayLabel(d.booked) +
    (d.days == null ? '' : ', ' + d.days + ' days since your last call');
  if(d.basis === 'never') return 'never covered';
  const who = d.basis === 'visit' ? 'since your last call' : 'since CRM activity';
  return d.days + ' days ' + who + (d.over ? ' - past ' + d.target : '');
}
const DUE_CLS = {covered:'done', booked:'open', due:'overdue', never:'overdue'};

/* ---------- account browse ---------- */
let browseScope = 'mine';
function renderBrowse(){
  const q = ($('abQ').value||'').trim().toLowerCase();
  const mgr = $('cMgr').value;
  const el = $('abRes');
  if(!ACCOUNTS.length){
    $('abHint').textContent = 'Import the CRM export first';
    el.innerHTML = '<p class="empty">No accounts loaded.</p>';
    return;
  }
  /* Scope applies to the list only while the search box is empty. Typing suspends
     it, because equipment builders, bearing suppliers and head offices routinely
     sit under another manager and you still have to call on them. */
  let pool;
  if(q){
    pool = ACCOUNTS.filter(a => a.a.toLowerCase().includes(q) ||
      (a.sub && a.sub.toLowerCase().includes(q)));
  } else if(browseScope === 'due'){
    pool = overdueAccounts(mgr).map(x => x.a);
  } else if(browseScope === 'mine'){
    pool = ACCOUNTS.filter(a => effMgr(a) === mgr);
  } else {
    pool = ACCOUNTS.slice();
  }
  const out = q
    ? pool.slice().sort((a,b)=>{
        const am = a.mgr===mgr, bm = b.mgr===mgr;
        if(am!==bm) return am?-1:1;
        return (FOCUS_RANK[a.foc] ?? 3) - (FOCUS_RANK[b.foc] ?? 3) || a.a.length - b.a.length;
      })
    : pool;
  const outOfZone = q ? out.filter(a => effMgr(a) !== mgr).length : 0;
  const cv = coverage(mgr);
  const cover = ACCOUNTS.length
    ? '<br><span class="cov">'+cv.covered+' covered &middot; '+cv.booked+' booked &middot; '+
      (cv.due+cv.never)+' to book, of '+cv.total+' yours</span>' : '';
  $('abHint').innerHTML = (out.length
    ? out.length+' account'+(out.length===1?'':'s')+(out.length>40?' - showing 40':'')+
      (outOfZone ? ' <span class="tag">'+outOfZone+' under another manager</span>' : '')
    : 'No matches') + cover;
  el.innerHTML = out.slice(0,40).map(a=>{
    const d = dueState(a);
    const meta = [a.sub, zoneName(a.z), a.cad].filter(Boolean).map(esc).join(' &middot; ');
    return '<button data-acct="'+esc(a.a)+'">'+
      '<span class="fd '+FOC_CLS[a.foc]+'"></span>'+esc(a.a)+
      (a.mgr===mgr ? '' : '<span class="tag">'+esc(a.mgr||'no manager')+'</span>')+
      (d.state === 'covered' ? '' : '<span class="st '+DUE_CLS[d.state]+'">'+
        (d.state === 'never' ? 'never' : d.state)+'</span>')+
      '<div class="mt">'+meta+' &middot; '+esc(dueLabel(d))+'</div></button>';
  }).join('');
  el.querySelectorAll('[data-acct]').forEach(b =>
    b.addEventListener('click', ()=>openAccount(b.dataset.acct)));
}
$('abQ').addEventListener('input', renderBrowse);
$('abScope').querySelectorAll('button').forEach(b => b.addEventListener('click', ()=>{
  browseScope = b.dataset.v;
  $('abScope').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  renderBrowse();
}));

/* ---------- account view ---------- */
let viewAcct = null, cameFromAcct = false;
function openAccount(name){
  viewAcct = ACC_BY_NAME.get(name);
  if(!viewAcct){ toast('That account is not in the database'); return; }
  renderAccount();
  go('acct');
}
function renderAccount(){
  const a = viewAcct;
  if(!a) return;
  const d = dueState(a);
  const lv = lastVisit(a.a);
  const rows = [
    ['Zone', zoneName(a.z) + (a.sub ? ' - '+a.sub : '')],
    ['Focus', a.foc],
    ['Cadence', a.cad + ' (every ' + d.target + ' days)'],
    ['Tier', a.tier],
    ['Segment', a.seg],
    ['Industry team', a.team],
    ['Account manager', effMgr(a) + (isMoved(a) ? ' (reassigned from '+(a.mgr||'unassigned')+')' : '')],
    ['Representative', a.rep],
    ['Next visit booked', d.booked ? dayLabel(d.booked) : ''],
    ['Last call logged here', lv ? new Date(lv).toLocaleDateString() + ' - ' + daysSince(lv) + ' days ago' : 'none'],
    ['Last CRM activity', a.last ? a.last + (a.idle != null ? ' - ' + a.idle + ' days ago' : '') : ''],
    ['Last appointment (CRM)', a.lastAppt]
  ];
  $('avHead').innerHTML =
    '<div class="avname"><span class="fd '+FOC_CLS[a.foc]+'"></span>'+esc(a.a)+
      (d.state === 'covered' ? '' : '<span class="st '+DUE_CLS[d.state]+'">'+
        (d.state === 'never' ? 'never covered' : d.state)+'</span>')+'</div>'+
    '<div class="avsub">'+esc(dueLabel(d))+'</div>'+
    '<dl class="kv">'+rows.filter(r=>r[1]).map(r=>
      '<dt>'+esc(r[0])+'</dt><dd>'+esc(r[1])+'</dd>').join('')+'</dl>';

  $('avContacts').innerHTML = a.c.length
    ? a.c.map(c=>{
        const email = c.e && c.e.length ? c.e[0] : '';
        const extra = c.e && c.e.length > 1 ? ' +'+(c.e.length-1) : '';
        return '<div class="ct"><span><div class="cn">'+esc(c.n)+'</div>'+
          '<div class="cr">'+esc(c.t || c.r || 'role not recorded')+'</div></span>'+
          '<span class="cp">'+
            (email ? esc(email)+esc(extra) : '<span class="miss">no email</span>')+'<br>'+
            (c.p ? esc(c.p)+(c.pk==='check'?' <span class="miss">check</span>':'')
                 : '<span class="miss">no mobile</span>')+
          '</span></div>';
      }).join('')
    : '<p class="empty">No contacts on file for this account.</p>';

  const hist = callsFor(a.a);
  $('avHistory').innerHTML = hist.length
    ? hist.map(c=>{
        const st = callStatus(c);
        const n = (c.entries||[]).length;
        const belts = (c.entries||[]).filter(e=>e.type==='belt').length;
        const bits = [n ? n+' entr'+(n===1?'y':'ies') : 'no report'];
        if(belts) bits.push(belts+' belt'+(belts===1?'':'s'));
        if(c.site) bits.push(c.site);
        return '<div class="card"><div class="hd"><span class="t">'+esc(c.date)+
          '<span class="st '+st.cls+'">'+st.label+'</span></span>'+
          '<button class="x" data-openc="'+esc(c.id)+'">Open</button></div>'+
          '<p class="meta">'+esc(bits.join(' \u00b7 '))+'</p></div>';
      }).join('')
    : '<p class="empty">No calls logged here yet.</p>';
  $('avHistory').querySelectorAll('[data-openc]').forEach(b =>
    b.addEventListener('click', async ()=>{
      const all = await callsAll();
      call = all.find(x => x.id === b.dataset.openc);
      if(call){ call.loose = call.loose || []; go('dash'); }
    }));
}
/* A planned visit that never happened, one that happened but was never written up,
   and one compiled and sent are three different things. Planned, cancelled and
   missed arrive with the scheduler; until then a call is created in progress. */
function callStatus(c){
  const s = c.status || (c.shared ? 'compiled' : (c.closed ? 'done' : 'in progress'));
  if(s === 'compiled') return {label:'compiled', cls:'compiled'};
  if(s === 'done') return {label:'done', cls:'done'};
  if(s === 'cancelled') return {label:'cancelled', cls:'done'};
  if(s === 'missed') return {label:'missed', cls:'overdue'};
  if(s === 'planned') return {label:'planned', cls:'open'};
  return {label:'open', cls:'open'};
}
$('avStart').addEventListener('click', ()=>{
  if(!viewAcct) return;
  $('cDate').value = todayISO();
  cameFromAcct = true;
  chooseAccount(viewAcct.a);
});

/* ================= the plan =================
   Ported from the Zone Call Planner. Behaviour is meant to be identical; what
   changed is where the data lives. The planner held 1,201 accounts baked into the
   file and kept the schedule in memory until you remembered to save a JSON file.
   Here accounts come from the import and appointments are written to IndexedDB on
   every change, which is the largest single thing this merge fixes.

   Planning is desktop-shaped on purpose. Drag and drop onto a calendar grid is a
   mouse gesture; the phone gets Today and This Week as a read-and-act list. */

const DAYNM = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const MONNM = ['January','February','March','April','May','June','July','August',
               'September','October','November','December'];
const LEVELS = [['High','high'],['Medium','med'],['Low','low'],['No Focus','none']];

function startOfWeek(d){ const x=new Date(d); const dow=(x.getDay()+6)%7; x.setDate(x.getDate()-dow); x.setHours(0,0,0,0); return x; }
function iso(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function parseIso(s){ const [a,b,c]=String(s).split('-').map(Number); return new Date(a,b-1,c); }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function isWeekday(d){ const g=d.getDay(); return g>=1 && g<=5; }
const todayISOdate = () => iso(new Date());

let APPTS = [];
const plan = {
  mgr:'', zone:'', view:'week', anchor:startOfWeek(new Date()),
  focus:new Set(LEVELS.map(l=>l[0])), q:'', seq:1, dueOnly:false
};

/* An appointment is one of three things:
     new      never downloaded, so it is not in Outlook at all
     changed  downloaded, then edited here - Outlook is holding a stale copy
     synced   downloaded and untouched since
   The revision string is everything that ends up in the invite. Move it to
   another day, retime it, retype the agenda or change who is listed and it goes
   back to changed. Dragging it to a new day counts. */
function apRev(ap){
  return [ap.acct, ap.type, ap.date, ap.start, ap.dur,
          (ap.agenda||'').trim(), (ap.contacts||[]).join('.'),
          // notes are part of the invite body, so writing them up flips it to
          // changed and the existing export button sweeps a week in one file
          sumRev(ap.callSummary)].join('|');
}
function apState(ap){
  if(!ap.exp) return 'new';
  return ap.exp === apRev(ap) ? 'synced' : 'changed';
}
const ST_LABEL = {new:'Not in Outlook yet', changed:'Edited since last download', synced:'In your Outlook calendar'};
const ST_SHORT = {new:'not downloaded', changed:'changed', synced:'in Outlook'};
function pendingAppts(list){ return (list||APPTS).filter(ap => apState(ap) !== 'synced'); }
/* Every write stamps the record. The exchange resolves an appointment edited on
   both sides newest-wins, and it cannot do that without knowing when. */
async function saveAppt(ap){ ap.touchedAt = Date.now(); await apptsPut(ap); }

/* ---------- filtering ---------- */
/* A search reaches the entire account book - every zone, every manager. Equipment
   builders, bearing suppliers and head offices routinely sit in someone else's
   zone or under someone else's name, and you still have to call on them. Zone and
   manager scope the rail only while nothing is being searched. */
function haystack(a){
  if(a._hay) return a._hay;
  const z = ZONES[a.z];
  const bits = [a.a, a.sub, a.z, z?z.name:'', a.tier, a.foc, a.seg, a.team, a.mgr, effMgr(a), a.rep];
  (a.c||[]).forEach(c => bits.push(c.n, c.r, c.t, (c.e||[])[0]));
  return (a._hay = bits.filter(Boolean).join(' ').toLowerCase());
}
// Every token has to land somewhere, so two words narrow rather than widen.
function matchQ(a){
  if(!plan.q) return true;
  const h = haystack(a);
  return plan.q.toLowerCase().split(/\s+/).filter(Boolean).every(t => h.includes(t));
}
const searching = () => plan.q.length > 0;
// Reassignment overrides the CRM manager everywhere, so scoping uses effMgr.
function inPlanScope(a){ return !plan.mgr || effMgr(a) === plan.mgr; }
function zoneAccounts(){ return ACCOUNTS.filter(a => a.z === plan.zone && inPlanScope(a)); }
function searchAll(){
  return ACCOUNTS.filter(matchQ).sort((x,y)=>
    (FOCUS_RANK[x.foc] ?? 3) - (FOCUS_RANK[y.foc] ?? 3) ||
    (x.z === plan.zone ? 0 : 1) - (y.z === plan.zone ? 0 : 1) ||
    ZONE_ORDER.indexOf(x.z) - ZONE_ORDER.indexOf(y.z) ||
    x.a.localeCompare(y.a));
}
function visibleAccounts(){
  const pool = (searching() ? searchAll() : zoneAccounts()).filter(a => plan.focus.has(a.foc));
  // "needs booking" means past cadence with nothing in the diary, not merely past
  return plan.dueOnly ? pool.filter(a => { const d = dueState(a); return d.over && !d.booked; }) : pool;
}

/* ---------- controls ---------- */
function fillPlanControls(){
  // whoever appears in the file, plus anyone accounts have been moved to
  const mgrs = allManagers().length ? allManagers()
             : (META && META.managers ? META.managers.slice().sort() : []);
  const zsel = $('pZone'), msel = $('pMgr');
  msel.innerHTML = '<option value="">Every manager</option>' +
    mgrs.map(m => '<option'+(m===plan.mgr?' selected':'')+'>'+esc(m)+'</option>').join('');
  // zones that actually hold an account, so an empty book does not list 31 of them
  const used = new Set(ACCOUNTS.map(a => a.z));
  const zlist = ZONE_ORDER.filter(z => used.has(z));
  if(!plan.zone && zlist.length) plan.zone = zlist[0];
  zsel.innerHTML = zlist.map(z =>
    '<option value="'+z+'"'+(z===plan.zone?' selected':'')+'>'+esc(zoneName(z))+'</option>').join('');
}
function renderDueToggle(){
  const el = $('pDueOnly');
  if(!el) return;
  const pool = searching() ? searchAll() : zoneAccounts();
  const n = pool.filter(a => { const d = dueState(a); return d.over && !d.booked; }).length;
  el.setAttribute('aria-pressed', String(plan.dueOnly));
  el.innerHTML = 'Needs booking<span class="n">'+n+'</span>';
  el.disabled = !n && !plan.dueOnly;
}
function renderChips(){
  const pool = searching() ? searchAll() : zoneAccounts();
  const by = {};
  pool.forEach(a => by[a.foc] = (by[a.foc]||0)+1);
  $('pChips').innerHTML = LEVELS.map(([lvl,cls])=>
    '<button type="button" class="chip '+cls+'" data-lvl="'+lvl+'" aria-pressed="'+
    plan.focus.has(lvl)+'"'+(by[lvl]?'':' disabled')+'>'+lvl+
    '<span class="n">'+(by[lvl]||0)+'</span></button>').join('');
  $('pChips').querySelectorAll('[data-lvl]').forEach(b => b.addEventListener('click', ()=>{
    const l = b.dataset.lvl;
    if(plan.focus.has(l)) plan.focus.delete(l); else plan.focus.add(l);
    if(!plan.focus.size) LEVELS.forEach(x => plan.focus.add(x[0]));
    renderPlan();
  }));
}
function renderRail(){
  const scope = $('pScope');
  if(searching()){
    const hits = searchAll();
    const out = hits.filter(a => a.z !== plan.zone).length;
    const others = plan.mgr ? hits.filter(a => effMgr(a) !== plan.mgr).length : 0;
    $('zTitle').textContent = 'Search: \u201c'+plan.q+'\u201d';
    $('zHub').textContent = hits.length+(hits.length===1?' account':' accounts')+' across the whole book';
    scope.hidden = false;
    scope.innerHTML = '<span></span><button type="button">Clear</button>';
    scope.querySelector('span').textContent =
      'Searching every zone and every manager' +
      (out ? ' \u2014 '+out+' outside '+plan.zone : '') +
      (others ? ', '+others+' not yours' : '');
    scope.querySelector('button').onclick = ()=>{ plan.q=''; $('pQ').value=''; renderPlan(); };
  } else {
    const z = ZONES[plan.zone];
    $('zTitle').textContent = plan.zone ? zoneName(plan.zone) : 'No zone';
    $('zHub').textContent = z ? (z.hub === 'n/a' ? 'no hub' : 'Hub: '+z.hub) : '';
    scope.hidden = true;
  }
  const list = $('pList'); list.innerHTML = '';
  const rows = visibleAccounts();
  if(!rows.length){
    list.innerHTML = '<div class="empty">'+(ACCOUNTS.length
      ? (searching() ? 'Nothing in the account book matches that at this focus level.'
                     : 'No accounts match this zone, manager and focus.')
      : 'Import the CRM export first.')+'</div>';
    return;
  }
  rows.forEach(a=>{
    const el = document.createElement('div');
    el.className = 'acct ' + FOC_CLS[a.foc];
    el.draggable = true; el.tabIndex = 0; el.dataset.acct = a.a;
    const d = dueState(a);
    const stale = d.over;
    el.innerHTML = '<div class="bar-c"></div>'+
      '<div><div class="nm"></div><div class="mt"></div></div>'+
      '<div class="cad"></div>';
    el.querySelector('.nm').textContent = a.a;
    const em = effMgr(a);
    const mb = document.createElement('button');
    mb.type = 'button';
    mb.className = 'mgrb' + (isMoved(a) ? ' moved' : '');
    mb.textContent = em ? em.split(/\s+/).map(x => x[0]).join('').toUpperCase() : '--';
    mb.title = (em || 'Unassigned') + (isMoved(a) ? ' (moved from '+(a.mgr||'unassigned')+')' : '') +
      ' - click to reassign';
    mb.draggable = false;
    mb.addEventListener('click', ev => { ev.stopPropagation(); openReassign({account:a.a}); });
    el.querySelector('.nm').appendChild(mb);
    const mt = el.querySelector('.mt');
    mt.textContent = [a.sub || 'no suburb', a.tier || 'no tier',
      a.c.length+(a.c.length===1?' contact':' contacts'), dueLabel(d)].join(' \u00b7 ');
    // Tag hits that sit outside the zone on screen, so a search result is never
    // mistaken for something on this trip.
    if(searching() && a.z !== plan.zone){
      const t = document.createElement('span'); t.className = 'zt';
      t.textContent = a.z; t.title = zoneName(a.z);
      mt.prepend(t);
    }
    if(stale) mt.classList.add('stale');
    el.querySelector('.cad').textContent = String(a.cad||'').split(' ')[0];
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', JSON.stringify({kind:'acct', acct:a.a}));
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('click', ()=>openDialog(null, {acct:a.a}));
    el.addEventListener('keydown', e=>{ if(e.key==='Enter') openDialog(null, {acct:a.a}); });
    list.appendChild(el);
  });
}

/* ---------- calendar ---------- */
function weekDays(){ const s = startOfWeek(plan.anchor); return [0,1,2,3,4].map(i => addDays(s,i)); }
function apptsOn(dISO){ return APPTS.filter(a => a.date === dISO).sort((x,y)=>x.start.localeCompare(y.start)); }
function apptFocusCls(ap){ const a = ACC_BY_NAME.get(ap.acct); return a ? FOC_CLS[a.foc] : 'none'; }

function renderCalendar(){
  const body = $('calBody'), TODAY = todayISOdate();
  body.innerHTML = '';
  $('calHint').textContent = APPTS.length
    ? APPTS.length+' appointment'+(APPTS.length===1?'':'s')+' planned'
    : 'Click an account, or drag it onto a day.';

  if(plan.view === 'week'){
    const days = weekDays();
    $('calTitle').textContent = days[0].getDate()+' '+MONNM[days[0].getMonth()].slice(0,3)+' \u2013 '+
      days[4].getDate()+' '+MONNM[days[4].getMonth()].slice(0,3)+' '+days[4].getFullYear();
    const grid = document.createElement('div'); grid.className = 'week';
    days.forEach((d,i)=>{
      const k = iso(d);
      const col = document.createElement('div');
      col.className = 'day' + (k === TODAY ? ' today' : '');
      col.innerHTML = '<div class="dh"><b>'+DAYNM[i]+'</b><span>'+d.getDate()+' '+
        MONNM[d.getMonth()].slice(0,3)+'</span></div>';
      const b = document.createElement('div'); b.className = 'dbody';
      apptsOn(k).forEach(ap => b.appendChild(apptEl(ap,false)));
      const add = document.createElement('button');
      add.className = 'add'; add.type = 'button'; add.textContent = '+ Add call';
      add.onclick = ()=>openDialog(null, {date:k});
      b.appendChild(add);
      col.appendChild(b);
      makeDrop(col, k);
      grid.appendChild(col);
    });
    body.appendChild(grid);
  } else {
    const y = plan.anchor.getFullYear(), m = plan.anchor.getMonth();
    $('calTitle').textContent = MONNM[m]+' '+y;
    const grid = document.createElement('div'); grid.className = 'month';
    DAYNM.forEach(n=>{ const h=document.createElement('div'); h.className='mh'; h.textContent=n.slice(0,3); grid.appendChild(h); });
    let cur = startOfWeek(new Date(y,m,1));
    const last = new Date(y,m+1,0);
    while(cur <= last || cur.getMonth() === m){
      for(let i=0;i<5;i++){
        const d = addDays(cur,i), k = iso(d);
        const cell = document.createElement('div');
        cell.className = 'mcell' + (d.getMonth()!==m ? ' out' : '') + (k===TODAY ? ' today' : '');
        cell.innerHTML = '<div class="n">'+d.getDate()+'</div>';
        apptsOn(k).forEach(ap => cell.appendChild(apptEl(ap,true)));
        cell.addEventListener('dblclick', ()=>openDialog(null, {date:k}));
        makeDrop(cell, k);
        grid.appendChild(cell);
      }
      cur = addDays(cur,7);
      if(cur.getMonth() !== m && cur > last) break;
    }
    body.appendChild(grid);
  }
}
function apptTitle(ap){ return ap.type+': '+ap.acct; }   // a colon, not a dash: account names contain hyphens
function apptEl(ap, pill){
  const a = ACC_BY_NAME.get(ap.acct);
  const st = apState(ap);
  const el = document.createElement('div');
  el.className = (pill ? 'pill ' : 'appt ') + 's-' + st;
  el.draggable = true; el.tabIndex = 0;
  const stTip = ST_LABEL[st] + (ap.expAt ? ' \u00b7 last downloaded '+new Date(ap.expAt).toLocaleString() : '');
  if(pill){
    el.textContent = ap.start+' '+ap.acct;
    el.title = apptTitle(ap)+'\n'+stTip;
  } else {
    el.innerHTML = '<div class="t"><i class="stx"></i><span></span></div>'+
                   '<div class="a"><i class="fd"></i><span></span></div><div class="k"></div>';
    el.querySelector('.t span').textContent = ap.start+' \u00b7 '+ap.dur+' min';
    const fd = el.querySelector('.fd');
    fd.className = 'fd ' + apptFocusCls(ap);
    fd.title = (a ? a.foc : 'No Focus') + ' focus';
    el.querySelector('.a span').textContent = ap.acct;
    el.querySelector('.k').textContent = (ap.unplanned ? 'unplanned \u00b7 ' : '')+
      ST_SHORT[st]+' \u00b7 '+ap.type+(a ? ' \u00b7 '+(a.sub||'no suburb') : '');
    el.title = stTip;
  }
  el.addEventListener('dragstart', e=>{
    e.dataTransfer.setData('text/plain', JSON.stringify({kind:'appt', id:ap.id}));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('drag');
  });
  el.addEventListener('dragend', ()=>el.classList.remove('drag'));
  el.addEventListener('click', e=>{ e.stopPropagation(); openDialog(ap.id); });
  el.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.stopPropagation(); openDialog(ap.id); } });
  return el;
}
function makeDrop(el, k){
  el.addEventListener('dragover', e=>{ e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', ()=>el.classList.remove('over'));
  el.addEventListener('drop', async e=>{
    e.preventDefault(); el.classList.remove('over');
    let p; try { p = JSON.parse(e.dataTransfer.getData('text/plain')); } catch(_){ return; }
    if(p.kind === 'appt'){
      const ap = APPTS.find(x => x.id === p.id);
      // moving it to another day is an edit, so it goes back to changed
      if(ap && ap.date !== k){ ap.date = k; await saveAppt(ap); renderPlan(); }
    } else if(p.kind === 'acct'){
      openDialog(null, {acct:p.acct, date:k});
    }
  });
}

/* ---------- appointment dialog ---------- */
let editingAppt = null, dlgAppt = null;
function openDialog(id, seed){
  seed = seed || {};
  let ap;
  if(id){
    ap = APPTS.find(x => x.id === id);
    if(!ap) return;
    editingAppt = id;
  } else {
    const acct = seed.acct || (visibleAccounts()[0]||{}).a;
    if(!acct){ toast('Pick an account first'); return; }
    const a = ACC_BY_NAME.get(acct);
    ap = {id:null, acct:acct, type:'Intralox site visit',
          date: seed.date || iso(weekDays()[0]), start:'09:00', dur:60, agenda:'',
          contacts: (a && a.c ? a.c.map((_,i)=>i) : [])};
    editingAppt = null;
  }
  const a = ACC_BY_NAME.get(ap.acct);
  $('dTitle').textContent = (id ? 'Edit ' : 'New ') + 'appointment \u2014 ' + ap.acct;
  $('dSub').textContent = a
    ? [zoneName(a.z), a.sub||'no suburb', a.foc+' focus', a.tier||'no tier',
       a.seg||'no segment', a.cad, a.mgr||'unassigned'].join(' \u00b7 ')
    : 'Not in the account database';
  $('dType').value = ap.type;
  $('dDate').value = ap.date;
  $('dTime').value = ap.start;
  $('dDur').value = String(ap.dur);
  $('dAgenda').value = ap.agenda || '';

  const box = $('dCts'); box.innerHTML = '';
  const cs = a && a.c ? a.c : [];
  cs.forEach((c,i)=>{
    const row = document.createElement('label'); row.className = 'ct';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.dataset.i = i; cb.checked = ap.contacts.includes(i);
    row.appendChild(cb);
    const l = document.createElement('div');
    l.innerHTML = '<div class="cn"></div><div class="cr"></div>';
    l.querySelector('.cn').textContent = c.n;
    l.querySelector('.cr').textContent = [c.r, c.t].filter(Boolean).join(' \u2014 ') || 'no role recorded';
    row.appendChild(l);
    const p = document.createElement('div'); p.className = 'cp';
    if(c.p){ p.textContent = c.p + (c.pk === 'check' ? ' (check)' : ''); if(c.pk === 'check') p.classList.add('miss'); }
    else { p.textContent = 'no number on file'; p.classList.add('miss'); }
    row.appendChild(p);
    box.appendChild(row);
  });
  const withP = cs.filter(c => c.p).length;
  const cover = $('dCover');
  cover.textContent = withP+' of '+cs.length+' contacts have a phone number on file. '+
    'Missing numbers are marked in the invite.';
  cover.className = 'note' + (withP === 0 ? ' warn' : '');

  const sync = $('dSync');
  if(id){
    const st = apState(ap);
    sync.hidden = false;
    sync.className = 'note sync' + (st==='synced' ? ' ok' : st==='changed' ? ' chg' : '');
    sync.textContent = ST_LABEL[st] +
      (ap.expAt ? ' \u00b7 downloaded '+new Date(ap.expAt).toLocaleString() : '') +
      (st === 'changed' ? '. Download again to update the Outlook entry.' : '');
  } else {
    sync.hidden = true;
  }
  $('dDel').hidden = !id;
  dlgAppt = ap;
  const dlg = $('dlg');
  if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
  pushDialog('dlg');
}
function closeDialog(){
  const dlg = $('dlg');
  if(!dlg.hasAttribute('open')){ dlgAppt = null; editingAppt = null; return; }
  // let popstate do the closing, so the history entry is consumed either way
  if(history.state && history.state.dialog === 'dlg'){ history.back(); return; }
  if(dlg.close) dlg.close(); else dlg.removeAttribute('open');
  dlgAppt = null; editingAppt = null;
}
async function saveDialog(){
  const ap = dlgAppt;
  if(!ap) return;
  ap.type = $('dType').value;
  ap.date = $('dDate').value;
  ap.start = $('dTime').value || '09:00';
  ap.dur = parseInt($('dDur').value,10) || 60;
  ap.agenda = $('dAgenda').value;
  ap.contacts = [...$('dCts').querySelectorAll('input:checked')].map(x => +x.dataset.i);
  // a call dropped on a weekend moves to the Monday rather than sitting there unseen
  const d = parseIso(ap.date);
  if(!isWeekday(d)) ap.date = iso(addDays(d, d.getDay()===0 ? 1 : 2));
  if(!editingAppt){
    ap.id = 'ap' + Date.now().toString(36) + (plan.seq++);
    APPTS.push(ap);
  }
  await saveAppt(ap);
  closeDialog();
  renderPlan();
}
async function deleteDialog(){
  if(!editingAppt) return;
  const ap = APPTS.find(x => x.id === editingAppt);
  if(!confirm('Delete '+(ap ? apptTitle(ap)+' on '+ap.date : 'this appointment')+'?')) return;
  await apptsDel(editingAppt);
  APPTS = APPTS.filter(x => x.id !== editingAppt);
  closeDialog();
  renderPlan();
}
$('dSave').addEventListener('click', ()=>saveDialog().catch(e=>{ console.error(e); toast('Could not save: '+e.message); }));
$('dCancel').addEventListener('click', closeDialog);
$('dDel').addEventListener('click', ()=>deleteDialog().catch(e=>{ console.error(e); toast('Could not delete: '+e.message); }));

/* ---------- plan wiring ---------- */
function renderPlan(){
  fillPlanControls();
  renderChips();
  renderDueToggle();
  renderRail();
  renderCalendar();
  renderTerritory();
  renderPlanCount();
}
function renderPlanCount(){
  const el = $('planInfo');
  if(!el) return;
  if(!APPTS.length){ el.textContent = 'Nothing planned'; return; }
  const p = pendingAppts(APPTS).length;
  el.textContent = APPTS.length+' planned'+(p ? ', '+p+' not in Outlook' : '');
}
$('pDueOnly').addEventListener('click', ()=>{ plan.dueOnly = !plan.dueOnly; renderPlan(); });
$('pQ').addEventListener('input', ()=>{ plan.q = $('pQ').value.trim(); renderPlan(); });
$('pMgr').addEventListener('change', ()=>{ plan.mgr = $('pMgr').value; renderPlan(); });
$('pZone').addEventListener('change', ()=>{ plan.zone = $('pZone').value; renderPlan(); });
$('pView').querySelectorAll('button').forEach(b => b.addEventListener('click', ()=>{
  plan.view = b.dataset.v;
  $('pView').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  renderCalendar(); renderTerritory();
}));
$('calPrev').addEventListener('click', ()=>{
  plan.anchor = plan.view === 'week' ? addDays(plan.anchor,-7)
    : new Date(plan.anchor.getFullYear(), plan.anchor.getMonth()-1, 1);
  renderCalendar(); renderTerritory();
});
$('calNext').addEventListener('click', ()=>{
  plan.anchor = plan.view === 'week' ? addDays(plan.anchor,7)
    : new Date(plan.anchor.getFullYear(), plan.anchor.getMonth()+1, 1);
  renderCalendar(); renderTerritory();
});
$('calToday').addEventListener('click', ()=>{
  plan.anchor = plan.view === 'week' ? startOfWeek(new Date()) : new Date();
  renderCalendar(); renderTerritory();
});

/* ================= territory weeks and reassignment =================

   A territory week is a whole-week banner saying which zone you are working,
   published into other people's calendars so they can see where you are without
   opening your calls. Deliberately not an appointment: an all-day Monday to
   Friday event marked FREE, so it never blocks your availability or anyone's
   free/busy lookup. Keyed by the Monday, one zone per week.

   Reassignment overrides the CRM's Account Manager everywhere in this app -
   filtering, zone counts, focus chips, invites, the high-focus cap. It never
   writes to Dynamics; the CSV is what goes to whoever does. */

let WEEKS = {}, MGR_OF = {};

const effMgr = a => (MGR_OF[a.a] !== undefined ? MGR_OF[a.a] : a.mgr);
const isMoved = a => MGR_OF[a.a] !== undefined && MGR_OF[a.a] !== a.mgr;
function allManagers(){
  const s = new Set();
  ACCOUNTS.forEach(a => { if(a.mgr) s.add(a.mgr); const e = effMgr(a); if(e) s.add(e); });
  return [...s].sort();
}
// No more than 5 High-focus accounts per manager per zone. Past that the answer
// is to split the zone, not to carry the load.
const HIGH_CAP = 5;

function wkRev(w){ return (w.zone||'')+'|'+(w.note||''); }
function wkState(w){ return !w.exp ? 'new' : (w.exp === wkRev(w) ? 'synced' : 'changed'); }
function weeksList(){
  return Object.keys(WEEKS).filter(k => WEEKS[k] && WEEKS[k].zone)
    .sort().map(k => Object.assign({mon:k}, WEEKS[k]));
}
function pendingWeeks(list){ return list.filter(w => wkState(w) !== 'synced'); }
async function saveWeeks(){ await kvSet('weeks', WEEKS); }
async function saveMgrOf(){ await kvSet('mgrOf', MGR_OF); }

/* Which weeks the current view covers. Counts and export buttons act on what is
   on screen, so this has to agree with the calendar. */
function viewWeeks(){
  if(plan.view === 'week') return [iso(startOfWeek(plan.anchor))];
  const y = plan.anchor.getFullYear(), m = plan.anchor.getMonth();
  const out = [];
  let cur = startOfWeek(new Date(y,m,1));
  const last = new Date(y,m+1,0);
  while(cur <= last || cur.getMonth() === m){
    out.push(iso(cur));
    cur = addDays(cur,7);
    if(cur.getMonth() !== m && cur > last) break;
  }
  return out;
}
// Where the calls that week actually are, so the marker can be suggested rather
// than typed from memory.
function suggestZone(mon){
  const start = parseIso(mon), end = addDays(start,4), n = {};
  APPTS.forEach(ap=>{
    const d = parseIso(ap.date);
    if(d < start || d > end) return;
    const a = ACC_BY_NAME.get(ap.acct);
    if(a) n[a.z] = (n[a.z]||0)+1;
  });
  const best = Object.keys(n).sort((x,y)=>n[y]-n[x])[0];
  return best ? {zone:best, n:n[best]} : null;
}

function renderTerritory(){
  const bar = $('terr');
  if(!bar) return;
  const mons = viewWeeks();
  bar.innerHTML = '';
  bar.className = 'terr';

  const lab = document.createElement('div');
  lab.className = 'tl';
  lab.textContent = plan.view === 'week' ? 'Territory this week' : 'Territory weeks';
  bar.appendChild(lab);

  mons.forEach(mon=>{
    const w = WEEKS[mon] || {};
    const box = document.createElement('div'); box.className = 'wk';
    if(plan.view !== 'week'){
      const l = document.createElement('label');
      const d = parseIso(mon);
      l.textContent = 'wk '+d.getDate()+' '+MONNM[d.getMonth()].slice(0,3);
      box.appendChild(l);
    }
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = ''; none.textContent = '\u2014 no marker \u2014';
    sel.appendChild(none);
    const sug = suggestZone(mon);
    ZONE_ORDER.filter(z => ZONES[z]).forEach(z=>{
      const o = document.createElement('option');
      o.value = z;
      o.textContent = zoneName(z) +
        (sug && sug.zone === z ? '  ('+sug.n+' call'+(sug.n===1?'':'s')+' booked)' : '');
      sel.appendChild(o);
    });
    sel.value = w.zone || '';
    /* Z12 is the unresolved bucket, not a geography. A week marker saying you
       are "in Z12" tells a colleague nothing about where you actually are. */
    if(w.zone === 'Z12') sel.title = 'Z12 is the catch-all for accounts whose suburb would not resolve. '+
      'It is not a place - pick the real region you will be in.';
    else if(!w.zone && sug) sel.title = 'Suggestion: '+sug.zone+' - '+sug.n+' call'+(sug.n===1?'':'s')+' booked that week';
    sel.onchange = async ()=>{
      if(!sel.value) delete WEEKS[mon];
      else WEEKS[mon] = Object.assign({}, WEEKS[mon]||{}, {zone: sel.value});
      await saveWeeks();
      renderTerritory();
    };
    box.appendChild(sel);
    bar.appendChild(box);
  });

  const list = weeksList().filter(w => mons.includes(w.mon));
  if(plan.view === 'week' && list.length){
    const w = list[0], st = wkState(w), z = ZONES[w.zone];
    const s = document.createElement('div');
    s.className = 'sum s-'+st;
    s.innerHTML = '<i class="stx"></i>';
    s.appendChild(document.createTextNode(
      (z && z.hub !== 'n/a' ? 'Hub '+z.hub+' \u00b7 ' : '') + ST_SHORT[st]));
    bar.appendChild(s);
  }

  const rt = document.createElement('div'); rt.className = 'rt';
  const pend = pendingWeeks(weeksList()).length;
  const b = document.createElement('button');
  b.className = 'btn'; b.type = 'button';
  b.textContent = 'Download week markers' + (pend ? ' ('+pend+')' : '');
  b.disabled = !weeksList().length;
  b.onclick = ()=>exportWeeks(pend ? 'pending' : 'all').catch(reportErr);
  rt.appendChild(b);
  bar.appendChild(rt);
}

/* ---------- week marker ICS ----------
   No VTIMEZONE and no VALUE=DATE-TIME anywhere here. An all-day event is a
   floating date, so the marker reads Monday to Friday in Perth, Auckland and
   Brisbane alike, without any of the Z12 assumed-timezone trouble. */
function dstamp(d){ const p = n => String(n).padStart(2,'0');
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate()); }
function buildWeekIcs(list){
  const L = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Intralox//Field CRM//EN',
             'CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Intralox territory weeks'];
  list.forEach(w=>{
    const z = ZONES[w.zone] || {name:'unzoned', hub:'n/a', cov:''};
    const mon = parseIso(w.mon), fri = addDays(mon,4);
    const who = plan.mgr || '';
    const calls = APPTS.filter(ap=>{
      const d = parseIso(ap.date); return d >= mon && d <= fri;
    });
    const inZone = calls.filter(ap=>{ const a = ACC_BY_NAME.get(ap.acct); return a && a.z === w.zone; });
    const txt = [];
    txt.push('Working ' + zoneName(w.zone));
    if(z.hub && z.hub !== 'n/a') txt.push('Hub: '+z.hub);
    if(z.cov && z.cov !== 'unresolved') txt.push('Covers: '+z.cov);
    txt.push('Week of '+mon.getDate()+' '+MONNM[mon.getMonth()]+' '+mon.getFullYear()+', Monday to Friday.');
    if(calls.length){
      txt.push('', calls.length+' call'+(calls.length===1?'':'s')+' planned'+
        (inZone.length !== calls.length ? ' ('+inZone.length+' in zone)' : '')+':');
      calls.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start))
        .forEach(ap=>{
          const a = ACC_BY_NAME.get(ap.acct);
          txt.push('  '+DAYNM[(parseIso(ap.date).getDay()+6)%7].slice(0,3)+' '+ap.start+
            '  '+ap.acct+(a && a.z !== w.zone ? '  ['+a.z+']' : ''));
        });
    } else {
      txt.push('', 'No calls booked yet.');
    }
    if(w.note) txt.push('', w.note);
    txt.push('', 'Availability marker only \u2014 shown as free, so it will not block bookings.');

    L.push('BEGIN:VEVENT');
    L.push('UID:wk-'+w.mon+'@field-crm.intralox');
    L.push('SEQUENCE:'+(w.icsSeq||0));
    L.push('DTSTAMP:'+stamp());
    L.push('LAST-MODIFIED:'+stamp());
    // DTEND on an all-day event is exclusive, so Saturday closes a Mon-Fri span
    L.push('DTSTART;VALUE=DATE:'+dstamp(mon));
    L.push('DTEND;VALUE=DATE:'+dstamp(addDays(mon,5)));
    L.push('SUMMARY:'+icsEsc((who ? who+' \u2014 ' : '')+w.zone+' '+z.name));
    L.push('LOCATION:'+icsEsc(z.hub && z.hub !== 'n/a' ? z.hub : z.name));
    L.push('DESCRIPTION:'+icsEsc(txt.join('\n')));
    L.push('CATEGORIES:'+icsEsc('Territory week,'+w.zone));
    // A week-long banner must never eat availability.
    L.push('TRANSP:TRANSPARENT');
    L.push('X-MICROSOFT-CDO-BUSYSTATUS:FREE');
    L.push('X-MICROSOFT-CDO-INTENDEDSTATUS:FREE');
    L.push('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE');
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
async function exportWeeks(mode){
  const all = weeksList();
  if(!all.length){ toast('No territory weeks set. Pick a zone above the calendar.'); return; }
  const list = mode === 'all' ? all : pendingWeeks(all);
  if(!list.length){ toast('Every week marker is already downloaded.'); return; }
  for(const w of list){
    const cur = WEEKS[w.mon];
    if(cur.icsSeq == null) cur.icsSeq = 0;
    else if(wkState(cur) === 'changed') cur.icsSeq++;
    w.icsSeq = cur.icsSeq;
  }
  downloadFile('territory-weeks-'+list[0].mon+(list.length>1?'-x'+list.length:'')+'.ics',
               buildWeekIcs(list), 'text/calendar;charset=utf-8');
  const now = Date.now();
  for(const w of list){ const cur = WEEKS[w.mon]; cur.exp = wkRev(cur); cur.expAt = now; }
  await saveWeeks();
  renderTerritory();
  toast(list.length+' week marker'+(list.length===1?'':'s')+' downloaded');
}

/* ---------- reassignment ---------- */
let rScopes = [], rPick = 0;
function scopeAccounts(sc){
  if(!sc) return [];
  if(sc.kind === 'account')  return ACCOUNTS.filter(a => a.a === sc.account);
  if(sc.kind === 'zone')     return ACCOUNTS.filter(a => a.z === sc.zone);
  if(sc.kind === 'filtered') return visibleAccounts();
  if(sc.kind === 'mgrzone')  return ACCOUNTS.filter(a => a.z === sc.zone && effMgr(a) === sc.from);
  return [];
}
function openReassign(seed){
  seed = seed || {};
  if(!ACCOUNTS.length){ toast('Import the CRM export first'); return; }
  rScopes = [];
  if(seed.account){
    const a = ACC_BY_NAME.get(seed.account);
    if(a) rScopes.push({kind:'account', account:seed.account, label:'This account only', detail:a.a});
  }
  const z = plan.zone;
  if(z && ZONES[z]){
    rScopes.push({kind:'zone', zone:z, label:'Every account in '+zoneName(z),
      detail: ACCOUNTS.filter(a => a.z === z).length+' accounts, all managers'});
    if(plan.mgr){
      rScopes.push({kind:'mgrzone', zone:z, from:plan.mgr,
        label: plan.mgr+"'s accounts in "+z,
        detail: ACCOUNTS.filter(a => a.z === z && effMgr(a) === plan.mgr).length+' accounts'});
    }
  }
  rScopes.push({kind:'filtered', label:'The '+visibleAccounts().length+' accounts currently listed',
    detail:'Respects the zone, manager, focus and search filters'});
  rPick = 0;

  const box = $('rScope'); box.innerHTML = '';
  rScopes.forEach((sc,i)=>{
    const l = document.createElement('label');
    l.dataset.on = (i === 0);
    l.innerHTML = '<input type="radio" name="rsc" value="'+i+'"'+(i===0?' checked':'')+'>'+
      '<div><div>'+esc(sc.label)+'</div><div class="sc-n">'+esc(sc.detail)+'</div></div>';
    l.querySelector('input').onchange = ()=>{
      rPick = i;
      [...box.children].forEach((c,j)=>c.dataset.on = (j === i));
      rRefresh();
    };
    box.appendChild(l);
  });

  const sel = $('rTo'); sel.innerHTML = '';
  allManagers().forEach(m=>{ const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
  const un = document.createElement('option'); un.value = '__none__'; un.textContent = 'Unassigned'; sel.appendChild(un);
  const nw = document.createElement('option'); nw.value = '__new__'; nw.textContent = 'Add a new manager\u2026'; sel.appendChild(nw);
  sel.onchange = ()=>{ $('rNewWrap').hidden = sel.value !== '__new__'; rRefresh(); };
  $('rNew').oninput = rRefresh;
  $('rNewWrap').hidden = true;
  rRefresh();
  const dlg = $('rdlg');
  if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
  pushDialog('rdlg');
}
function rTarget(){
  const v = $('rTo').value;
  if(v === '__new__') return $('rNew').value.trim();
  if(v === '__none__') return '';
  return v;
}
function rRefresh(){
  const sc = rScopes[rPick], to = rTarget();
  const accts = scopeAccounts(sc);
  const moving = accts.filter(a => effMgr(a) !== to);
  const hi = moving.filter(a => a.foc === 'High').length;
  const prev = $('rPreview');
  prev.className = 'note';
  prev.textContent = !to
    ? 'Moving '+moving.length+' of '+accts.length+' accounts to unassigned. '+
      'Unassigned accounts still appear under "Every manager".'
    : 'Moving '+moving.length+' of '+accts.length+' accounts to '+to+
      (hi ? ', including '+hi+' High-focus.' : '.')+
      (moving.length === 0 ? ' Nothing to do - they are already there.' : '');

  // Project the cap as it would stand after the move, not as it stands now.
  const after = {};
  ACCOUNTS.forEach(a=>{
    if(a.foc !== 'High') return;
    const m = moving.includes(a) ? to : effMgr(a);
    if(!m) return;
    (after[m] = after[m] || {})[a.z] = (after[m][a.z]||0)+1;
  });
  const cap = $('rCap'); cap.innerHTML = '';
  const rows = [];
  Object.keys(after).sort().forEach(m => Object.keys(after[m]).forEach(z => rows.push([m,z,after[m][z]])));
  const breaches = rows.filter(r => r[2] > HIGH_CAP);
  const show = breaches.length ? breaches
             : rows.filter(r => to && r[0] === to).sort((a,b)=>b[2]-a[2]).slice(0,6);
  if(!show.length){
    cap.innerHTML = '<div class="caprow"><span class="cz">No High-focus accounts affected.</span></div>';
  } else {
    cap.innerHTML = show.map(([m,z,n]) =>
      '<div class="caprow'+(n > HIGH_CAP ? ' over' : '')+'">'+
      '<span class="cz">'+esc(m)+' \u00b7 '+esc(zoneName(z))+'</span>'+
      '<span class="cn">'+n+' / '+HIGH_CAP+'</span></div>').join('');
  }
  if(breaches.length){
    prev.className = 'note warn';
    prev.textContent += ' This breaches the '+HIGH_CAP+' High-focus cap in '+breaches.length+
      ' manager/zone combination'+(breaches.length===1?'':'s')+' - the answer is to split the zone.';
  }
}
async function applyReassign(revert){
  const accts = scopeAccounts(rScopes[rPick]);
  if(revert){
    accts.forEach(a => { delete MGR_OF[a.a]; });
  } else {
    if($('rTo').value === '__new__' && !rTarget()){
      toast('Type a name for the new manager, or pick an existing one');
      return;
    }
    const to = rTarget();
    accts.forEach(a => { if(a.mgr === to) delete MGR_OF[a.a]; else MGR_OF[a.a] = to; });
  }
  await saveMgrOf();
  if(plan.mgr && !allManagers().includes(plan.mgr)) plan.mgr = '';
  ACCOUNTS.forEach(a => { delete a._hay; });   // manager is searchable, so recache
  closeReassign();
  renderPlan();
  toast((revert ? 'Put back to the CRM: ' : 'Reassigned ')+accts.length+' account'+(accts.length===1?'':'s'));
}
function closeReassign(){
  const dlg = $('rdlg');
  if(!dlg.hasAttribute('open')) return;
  if(history.state && history.state.dialog === 'rdlg'){ history.back(); return; }
  if(dlg.close) dlg.close(); else dlg.removeAttribute('open');
}
$('rApply').addEventListener('click', ()=>applyReassign(false).catch(reportErr));
$('rRevert').addEventListener('click', ()=>applyReassign(true).catch(reportErr));
$('rCancel').addEventListener('click', closeReassign);
$('pReassign').addEventListener('click', ()=>openReassign({}));

/* The CSV is the handover. Nothing here writes to Dynamics, so the moves have to
   leave in a form somebody can act on. */
function reassignCsv(){
  const rows = [['Account Name','Zone','Suburb','Account Focus','CRM Account Manager','Reassigned To']];
  ACCOUNTS.filter(isMoved).forEach(a => rows.push(
    [a.a, a.z, a.sub, a.foc, a.mgr||'', effMgr(a) || '(unassigned)']));
  return rows.map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\r\n')+'\r\n';
}
function exportReassignments(){
  const n = ACCOUNTS.filter(isMoved).length;
  if(!n){ toast('No accounts have been reassigned'); return; }
  downloadFile('manager-reassignments.csv', reassignCsv(), 'text/csv;charset=utf-8');
  toast(n+' reassignment'+(n===1?'':'s')+' written to CSV');
}

/* ================= notes back into Dynamics =================

   Two problems, one answer.

   Dynamics server-side sync reads DESCRIPTION, not X-ALT-DESC. Outlook reads the
   HTML. So both bodies are written, and both are built from the same data rather
   than one being derived from the other by stripping tags out of the other.

   Photos cannot go in a calendar invite at all: cid: has no MIME parts to point
   at in an .ics, external URLs are blocked until the recipient clicks through,
   and Outlook desktop blocks data: base64 outright. So the calendar copy is an
   index, not the record - it says what photos exist and which file has them. The
   full HTML with the images still goes to OneDrive by share sheet.

   And the calendar is not the system of record either. Notes that only ever
   reach Outlook leave the next CRM export showing those accounts idle and
   unrated, so call-notes.csv is the paste-ready route into Dynamics. */

/* The extra belt fields, in the order they read on a datasheet. Anything empty
   is dropped, so a belt logged without flights does not print eight blank rows. */
const BELT_DETAIL = [
  ['sprbore','Sprocket bore'], ['sprpd','Pitch diameter / teeth'], ['sprmat','Sprocket material'],
  ['sprvar','Sprocket variant'], ['sprspacers','Sprocket spacers'],
  ['sprhdret','Heavy duty retainers'], ['sprhdretqty','Retainer qty'],
  ['fstyle','Flight type'], ['flmat','Flight material'], ['fheight','Flight height (mm)'],
  ['frows','Flights every N rows'], ['fspacing','Flight spacing (mm)'],
  ['findent','Indent (mm)'], ['cnotch','Centre notch (mm)'],
  ['sgtype','Sideguard type'], ['sgmat','Sideguard material'], ['sgheight','Sideguard height (mm)']
];
function callSummary(c){
  if(!c) return null;
  const E = t => (c.entries||[]).filter(e => e.type === t);
  const photos = (c.entries||[]).reduce((n,e) =>
      n + (e.photos||[]).length + (e.detached ? e.detached.n : 0), 0) +
    (c.loose||[]).length + (c.looseDetached ? c.looseDetached.n : 0);
  return {
    date: c.date, type: c.type, site: c.site || '',
    status: c.status || (c.closed ? 'done' : 'in progress'),
    noReport: !!c.noReport && !(c.entries||[]).length,
    contacts: (c.contacts||[]).map(x => ({n:x.name, r:x.role||'', crm:x.crm !== false})),
    belts: E('belt').map(e => ({
      asset:e.asset, desc:e.beltdesc, series:e.series, style:e.style,
      width:e.width, clen:e.clength, frame:e.frame, beltlen:e.beltlen,
      mat:e.beltmat, colour:e.colour, rod:e.rodmat, retro:e.retrofit,
      sprk:e.sprocket, sprpn:e.sprpn, sprdrive:e.sprdrive, spridle:e.spridle,
      qc:e.qcontact,
      // the v13 form carries far more than the five flight fields v8 had
      flights: BELT_DETAIL.map(([k,label]) => [label, e[k]])
                 .filter(x => x[1] !== '' && x[1] != null && x[1] !== false && x[1] !== 'N/A')
    })),
    projects: E('project').map(e => ({
      name:e.project, status:e.status, next:e.next, target:e.target, owner:e.owner, notes:e.notes
    })),
    notes: E('note').map(e => ({topic:e.topic, text:e.text})),
    health: E('health').map(e => ({
      asset:e.asset, fault:e.fault, htype:e.htype, severity:e.severity, action:e.action
    })),
    photos: photos,
    file: c.sharedAs || ''
  };
}
// What the invite body actually says, so a change to it flips the appointment.
function sumRev(s){ return s ? JSON.stringify(s) : ''; }

const NO_OUTLOOK_EDITS =
  'Written in Field CRM. Do not type into this invite - re-downloading replaces the body ' +
  'and anything added in Outlook is lost.';

function notesText(s){
  if(!s) return '';
  const L = [], D = v => (v == null || String(v).trim() === '' || v === 'N/A') ? '\u2014' : String(v).trim();
  L.push('CALL NOTES \u2014 ' + s.date + (s.site ? ' \u00b7 ' + s.site : ''));
  if(s.noReport){
    L.push('', 'Visit completed. Nothing to report.');
  } else {
    if(s.contacts.length) L.push('Seen: ' + s.contacts.map(c =>
      c.n + (c.r ? ' (' + c.r + ')' : '') + (c.crm ? '' : ' [not in CRM]')).join(', '));
    s.belts.forEach((b,i)=>{
      L.push('', 'BELT ' + (i+1) + ' \u2014 ' + D(b.asset));
      L.push('  Belt: ' + D(b.desc) + '   Width: ' + D(b.width) + ' mm   Centre line: ' + D(b.clen) + ' m');
      L.push('  Belt material: ' + D(b.mat) + '   Rod: ' + D(b.rod) + '   Retrofit: ' + D(b.retro));
      L.push('  Sprockets: ' + D(b.sprk));
      b.flights.forEach(([k,v]) => L.push('  ' + k + ': ' + D(v)));
      if(b.qc) L.push('  Quote to: ' + b.qc);
    });
    s.health.forEach((h,i)=>{
      L.push('', 'HEALTH CHECK ' + (i+1) + ' \u2014 ' + D(h.asset));
      L.push('  ' + D(h.fault));
      L.push('  Type: ' + D(h.htype) + '   Severity: ' + D(h.severity));
      if(h.action) L.push('  Action: ' + h.action);
    });
    s.projects.forEach(p=>{
      L.push('', 'PROJECT \u2014 ' + D(p.name));
      L.push('  Status: ' + D(p.status) + '   Target: ' + D(p.target) + '   Owner: ' + D(p.owner));
      if(p.next) L.push('  Next: ' + p.next);
      if(p.notes) L.push('  ' + p.notes);
    });
    s.notes.forEach(n => L.push('', (n.topic || 'Note').toUpperCase(), '  ' + n.text));
  }
  // An index, not the record: the invite cannot carry the images.
  if(s.photos) L.push('', s.photos + ' photo' + (s.photos===1?'':'s') + ' taken. ' +
    (s.file ? 'Full notes with images: ' + s.file : 'Full notes with images shared to OneDrive.'));
  L.push('', NO_OUTLOOK_EDITS);
  return L.join('\n');
}
/* Built from the same data as the text, not by stripping the full HTML. Outlook
   converts the body to RTF and keeps only inline styles - a <style> block and
   every CSS class is discarded, so there are none here. */
function notesHtml(s){
  if(!s) return '';
  const F = 'font-family:Arial,Helvetica,sans-serif';
  const D = v => (v == null || String(v).trim() === '' || v === 'N/A') ? '&mdash;' : esc(String(v).trim());
  const H = t => '<p style="margin:16px 0 4px;color:#00708D;font-size:11px;letter-spacing:.08em">'+
    '<b>'+esc(t)+'</b></p>';
  const tbl = rows => '<table cellpadding="5" style="border-collapse:collapse;font-size:12px;'+
    'border:1px solid #CCCCCC;'+F+'">' + rows.map(([k,v]) =>
      '<tr><td style="background:#F7F8F8;color:#4D4D4F;border:1px solid #CCCCCC;white-space:nowrap">'+
      esc(k)+'</td><td style="border:1px solid #CCCCCC">'+D(v)+'</td></tr>').join('') + '</table>';

  let h = '<div style="'+F+';font-size:13px;color:#222222">';
  h += '<div style="border-left:4px solid #ED1C24;padding-left:10px;margin:14px 0 10px">'+
       '<div style="font-size:14px;font-weight:bold">Call notes &mdash; '+esc(s.date)+
       (s.site ? ' &middot; '+esc(s.site) : '')+'</div></div>';
  if(s.noReport){
    h += '<p>Visit completed. Nothing to report.</p>';
  } else {
    if(s.contacts.length) h += '<p style="font-size:12px;color:#4D4D4F">Seen: '+
      s.contacts.map(c => esc(c.n) + (c.r ? ' ('+esc(c.r)+')' : '') +
        (c.crm ? '' : ' <span style="color:#B2232F">[not in CRM]</span>')).join(', ')+'</p>';
    s.belts.forEach((b,i)=>{
      h += H('BELT '+(i+1)+' \u2014 '+(b.asset||''));
      h += tbl([['Belt', b.desc], ['Width (mm)', b.width], ['Centre line (m)', b.clen],
                ['Belt material', b.mat], ['Rod material', b.rod], ['Retrofit', b.retro],
                ['Sprockets', b.sprk]].concat(b.flights)
                .concat(b.qc ? [['Quote to', b.qc]] : []));
    });
    s.health.forEach((x,i)=>{
      h += H('HEALTH CHECK '+(i+1)+' \u2014 '+(x.asset||''));
      h += tbl([['Fault', x.fault], ['Type', x.htype], ['Severity', x.severity], ['Action', x.action]]);
    });
    s.projects.forEach(p=>{
      h += H('PROJECT \u2014 '+(p.name||''));
      h += tbl([['Status', p.status], ['Next action', p.next], ['Target', p.target],
                ['Owner', p.owner], ['Notes', p.notes]]);
    });
    s.notes.forEach(n=>{
      h += H((n.topic || 'Note').toUpperCase());
      h += '<div style="font-size:12.5px">'+esc(n.text).replace(/\n/g,'<br>')+'</div>';
    });
  }
  if(s.photos) h += '<p style="margin-top:14px;font-size:12px;color:#4D4D4F">'+
    '<b>'+s.photos+' photo'+(s.photos===1?'':'s')+' taken.</b> Images cannot travel in a calendar '+
    'invite. '+(s.file ? 'Full notes with images: '+esc(s.file) : 'Full notes with images shared to OneDrive.')+'</p>';
  h += '<p style="margin-top:16px;font-size:10px;color:#77787A;border-top:1px solid #E3E3E3;'+
       'padding-top:8px">'+esc(NO_OUTLOOK_EDITS)+'</p>';
  return h + '</div>';
}

/* ---------- call-notes.csv ---------- */
/* The monthly Dynamics push. One row per call, with the plain-text notes in a
   single cell, so it can be pasted or imported without unpicking anything. */
async function callNotesCsv(){
  const calls = (await callsAll())
    .filter(c => c.status === 'done' || c.status === 'compiled' || c.closed)
    .sort((a,b) => callWhen(a) - callWhen(b));
  const head = ['Account Name','Zone','Suburb','Account Manager','Call Date','Call Type','Site',
                'Status','Contacts','Belts','Projects','Health items','Photos','Notes file','Notes'];
  const rows = [head];
  for(const c of calls){
    const a = ACC_BY_NAME.get(c.customer);
    const s = callSummary(c);
    rows.push([
      c.customer, a ? a.z : (c.zone||''), a ? a.sub : (c.suburb||''),
      a ? (effMgr(a)||'') : (c.mgr||''),
      c.date, c.type, c.site || '', s.status,
      s.contacts.map(x => x.n).join('; '),
      s.belts.length, s.projects.length, s.health.length, s.photos,
      s.file, notesText(s)
    ]);
  }
  return {csv: rows.map(r => r.map(cell =>
    '"'+String(cell == null ? '' : cell).replace(/"/g,'""')+'"').join(',')).join('\r\n')+'\r\n',
    n: calls.length};
}
async function exportCallNotes(){
  const {csv, n} = await callNotesCsv();
  if(!n){ toast('No completed calls to export'); return; }
  downloadFile('call-notes.csv', csv, 'text/csv;charset=utf-8');
  toast(n+' call'+(n===1?'':'s')+' written to call-notes.csv');
}
$('exCallNotes').addEventListener('click', ()=>exportCallNotes().catch(reportErr));

/* ---------- ICS export ----------
   Outlook is the target and Outlook is fussy. Three things carry the whole
   thing and none of them are obvious:

   UID must not contain the date. Outlook keys off it. A date-bearing UID made a
   moved appointment arrive as a second entry and left the original sitting on
   the old day. A stable UID plus a rising SEQUENCE makes a re-download update
   the item in place.

   SEQUENCE rises only when the appointment has actually changed since it was
   last written. Bumping it every time would be harmless but noisy; never
   bumping it means Outlook silently ignores the update.

   The green state is set after the file is handed over, not before. If the
   download fails the appointment stays amber and gets written again. */

const TZDB = {
  'Australia/Sydney':   {std:['+1100','+1000','AEST','19700405T030000','FREQ=YEARLY;BYMONTH=4;BYDAY=1SU'],
                         dst:['+1000','+1100','AEDT','19701004T020000','FREQ=YEARLY;BYMONTH=10;BYDAY=1SU']},
  'Australia/Adelaide': {std:['+1030','+0930','ACST','19700405T030000','FREQ=YEARLY;BYMONTH=4;BYDAY=1SU'],
                         dst:['+0930','+1030','ACDT','19701004T020000','FREQ=YEARLY;BYMONTH=10;BYDAY=1SU']},
  'Australia/Brisbane': {std:['+1000','+1000','AEST','19700101T000000',null]},
  'Australia/Darwin':   {std:['+0930','+0930','ACST','19700101T000000',null]},
  'Australia/Perth':    {std:['+0800','+0800','AWST','19700101T000000',null]},
  'Pacific/Auckland':   {std:['+1300','+1200','NZST','19700405T030000','FREQ=YEARLY;BYMONTH=4;BYDAY=1SU'],
                         dst:['+1200','+1300','NZDT','19700927T020000','FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU']}
};
const TZ_FALLBACK = 'Australia/Sydney';
function zoneTz(z){ const zz = ZONES[z]; return (zz && zz.tz) || TZ_FALLBACK; }
function zoneTzAssumed(z){ const zz = ZONES[z]; return !zz || !!zz.tzAssumed; }

// ICS escaping. Deliberately not the HTML esc() above - different rules, and
// mixing them up puts backslashes in the invite body.
function icsEsc(s){
  return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/;/g,'\\;')
    .replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
}
/* RFC 5545 limits a line to 75 OCTETS, not 75 characters, and the planner's
   fold counted characters. The invite body is full of em dashes and middot
   separators, each three bytes in UTF-8, so a 73-character line was running to
   77 octets - over the limit on every appointment with a suburb in it. This
   folds on the byte count and never splits a character across two lines. */
function byteLen(s){
  if(typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return unescape(encodeURIComponent(s)).length;
}
function fold(line){
  const MAX = 75;
  if(byteLen(line) <= MAX) return line;
  const parts = [];
  let cur = '', used = 0, budget = MAX;
  // Array.from splits by code point, so a surrogate pair stays whole
  for(const ch of Array.from(line)){
    const n = byteLen(ch);
    if(used + n > budget){
      parts.push(cur);
      cur = ch; used = n;
      budget = MAX - 1;          // a continuation spends one octet on its leading space
    } else {
      cur += ch; used += n;
    }
  }
  if(cur) parts.push(cur);
  return parts[0] + parts.slice(1).map(p => '\r\n ' + p).join('');
}
function stamp(){ return new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''); }
function dtLocal(dISO, hhmm, addMin){
  const [y,m,d] = dISO.split('-').map(Number), [H,M] = hhmm.split(':').map(Number);
  const t = new Date(y, m-1, d, H, M + (addMin||0));
  const p = n => String(n).padStart(2,'0');
  return t.getFullYear()+p(t.getMonth()+1)+p(t.getDate())+'T'+p(t.getHours())+p(t.getMinutes())+'00';
}
function vtimezone(tzid){
  const z = TZDB[tzid];
  if(!z) return [];
  const L = ['BEGIN:VTIMEZONE','TZID:'+tzid];
  const blk = (kind, spec)=>{
    const [from,to,nm,dtstart,rrule] = spec;
    L.push('BEGIN:'+kind,'DTSTART:'+dtstart,'TZOFFSETFROM:'+from,'TZOFFSETTO:'+to,'TZNAME:'+nm);
    if(rrule) L.push('RRULE:'+rrule);
    L.push('END:'+kind);
  };
  blk('STANDARD', z.std);
  if(z.dst) blk('DAYLIGHT', z.dst);
  L.push('END:VTIMEZONE');
  return L;
}

function inviteParts(ap){
  const a = ACC_BY_NAME.get(ap.acct);
  const z = ZONES[a.z] || {name:'unzoned', hub:'n/a', cov:''};
  const cts = (ap.contacts||[]).map(i => a.c[i]).filter(Boolean);
  const withP = cts.filter(c => c.p).length;
  const d = dueState(a);
  const head = [
    ['Zone', zoneName(a.z) + (z.hub && z.hub !== 'n/a' ? ' (hub '+z.hub+')' : '')],
    ['Location', a.sub || 'suburb not derivable from the account name'],
    ['Focus / tier / segment', [a.foc, a.tier||'no tier', a.seg||'no segment'].join(' \u00b7 ')+' \u2014 '+a.cad],
    ['Account manager', (effMgr(a) || 'unassigned') +
       (isMoved(a) ? ' (reassigned here from '+(a.mgr||'unassigned')+')' : '')],
    ['Representative', a.rep || 'unassigned'],
    ['Last call logged', dueLabel(d)],
    ['Last CRM activity', a.last || 'none recorded'],
    ['Phone coverage', withP+' of '+cts.length+' listed contacts have a number on file']
  ];
  const agenda = (ap.agenda||'').trim() || 'No agenda entered.';
  const sum = ap.callSummary || null;

  const txt = [];
  head.forEach(([k,v]) => txt.push(k+': '+v));
  txt.push('', 'AGENDA', agenda, '', 'CONTACTS');
  cts.forEach(c=>{
    txt.push('- '+c.n+' | '+([c.r,c.t].filter(Boolean).join(' \u2014 ')||'no role recorded')+
      ' | '+(c.p ? c.p+(c.pk==='check'?' (check)':'') : 'NO NUMBER ON FILE')+
      ' | '+((c.e&&c.e[0])||'no email on file'));
  });
  if(d.over) txt.push('', 'This account is past its ' + a.cad + ' cadence: ' + dueLabel(d) + '.');
  // Dynamics server-side sync reads this body, not the HTML one.
  if(sum) txt.push('', '\u2014\u2014\u2014', notesText(sum));

  /* Outlook renders this as the invite body. Arial and inline styles only:
     Outlook will not have Roboto and cannot fetch a webfont, and it strips
     anything that is not inline. */
  const F = 'font-family:Arial,Helvetica,sans-serif';
  let html = '<html><body style="'+F+';font-size:13px;color:#222222">';
  html += '<div style="border-left:4px solid #ED1C24;padding-left:10px;margin:0 0 12px">'+
          '<div style="font-size:15px;font-weight:bold;color:#222222">'+esc(a.a)+'</div>'+
          '<div style="font-size:11px;color:#4D4D4F;letter-spacing:.04em;text-transform:uppercase">'+
          esc(ap.type)+'</div></div>';
  html += '<table cellpadding="3" style="border-collapse:collapse;font-size:12px">';
  head.forEach(([k,v])=>{ html += '<tr><td style="color:#77787A;padding-right:12px">'+esc(k)+
    '</td><td style="color:#222222"><b>'+esc(v)+'</b></td></tr>'; });
  html += '</table><p style="margin:14px 0 4px;color:#00708D;font-size:11px;letter-spacing:.08em"><b>AGENDA</b></p>'+
          '<div>'+esc(agenda).replace(/\n/g,'<br>')+'</div>';
  html += '<p style="margin:16px 0 4px;color:#00708D;font-size:11px;letter-spacing:.08em"><b>CONTACTS</b></p>';
  html += '<table cellpadding="6" style="border-collapse:collapse;font-size:12px;border:1px solid #CCCCCC">';
  html += '<tr style="background:#E3F0F5;color:#00708D">'+
          '<th align="left">Name</th><th align="left">Role / title</th>'+
          '<th align="left">Phone</th><th align="left">Email</th></tr>';
  cts.forEach((c,i)=>{
    const ph = c.p ? esc(c.p)+(c.pk==='check' ? ' <span style="color:#B2232F">(check)</span>' : '')
                   : '<span style="color:#B2232F">no number on file</span>';
    const em = (c.e&&c.e[0]) ? esc(c.e[0]) : '<span style="color:#B2232F">no email on file</span>';
    const bg = i%2 ? ' style="background:#F8F8F8"' : '';
    html += '<tr'+bg+'><td>'+esc(c.n)+'</td><td>'+
      esc([c.r,c.t].filter(Boolean).join(' \u2014 ')||'no role recorded')+
      '</td><td>'+ph+'</td><td>'+em+'</td></tr>';
  });
  html += '</table>';
  if(d.over) html += '<p style="color:#B2232F;margin-top:12px">Past its '+esc(a.cad)+' cadence: '+esc(dueLabel(d))+'.</p>';
  if(sum) html += '<hr style="border:0;border-top:1px solid #E3E3E3;margin:18px 0">' + notesHtml(sum);
  html += '<p style="margin-top:18px;font-size:10px;color:#77787A;border-top:1px solid #E3E3E3;padding-top:8px">'+
          'Intralox Field CRM \u00b7 built from the CRM export of '+
          esc(META && META.imported ? new Date(META.imported).toLocaleDateString() : 'unknown date')+'</p>';
  html += '</body></html>';
  return {txt: txt.join('\n'), html: html, tz: zoneTz(a.z), assumed: zoneTzAssumed(a.z)};
}

function buildIcs(list){
  const L = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Intralox//Field CRM//EN',
             'CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  const tzs = [...new Set(list.map(ap => {
    const a = ACC_BY_NAME.get(ap.acct);
    return zoneTz(a ? a.z : '');
  }))];
  tzs.forEach(t => L.push(...vtimezone(t)));
  list.forEach(ap=>{
    const p = inviteParts(ap), a = ACC_BY_NAME.get(ap.acct);
    L.push('BEGIN:VEVENT');
    L.push('UID:'+ap.id+'@field-crm.intralox');      // no date in the UID - see above
    L.push('SEQUENCE:'+(ap.icsSeq||0));
    L.push('DTSTAMP:'+stamp());
    L.push('LAST-MODIFIED:'+stamp());
    L.push('DTSTART;TZID='+p.tz+':'+dtLocal(ap.date, ap.start, 0));
    L.push('DTEND;TZID='+p.tz+':'+dtLocal(ap.date, ap.start, ap.dur));
    L.push('SUMMARY:'+icsEsc(apptTitle(ap)));
    L.push('LOCATION:'+icsEsc([a.sub, a.a].filter(Boolean).join(', ')));
    L.push('DESCRIPTION:'+icsEsc(p.txt));
    L.push('X-ALT-DESC;FMTTYPE=text/html:'+icsEsc(p.html));
    L.push('CATEGORIES:'+icsEsc(a.z+','+a.foc));
    // a site visit is time out of the office; a planned phone call is not
    L.push('X-MICROSOFT-CDO-BUSYSTATUS:'+(ap.type === 'Intralox site visit' ? 'OOF' : 'BUSY'));
    L.push('TRANSP:OPAQUE');
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

function inRange(ap){
  const d = parseIso(ap.date);
  if(plan.view === 'week'){ const s = startOfWeek(plan.anchor); return d >= s && d <= addDays(s,4); }
  return d.getFullYear() === plan.anchor.getFullYear() && d.getMonth() === plan.anchor.getMonth();
}
function downloadFile(name, text, mime){
  const b = new Blob([text], {type: mime || 'text/plain;charset=utf-8'});
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(u), 4000);
}
async function doExport(mode){
  const inView = APPTS.filter(inRange);
  if(!inView.length){ toast('Nothing planned in this '+plan.view+'. Add an appointment first.'); return; }
  const list = mode === 'all' ? inView : pendingAppts(inView);
  if(!list.length){ toast('Everything in this '+plan.view+' is already in your Outlook calendar.'); return; }
  if(mode === 'all' && list.length > pendingAppts(inView).length &&
     !confirm('Re-download all '+list.length+' appointment'+(list.length===1?'':'s')+' in this '+plan.view+
              '?\n\nOutlook will update the ones it already has rather than duplicate them.')) return;
  const assumed = list.filter(ap => { const a = ACC_BY_NAME.get(ap.acct); return zoneTzAssumed(a ? a.z : ''); });
  if(assumed.length && !confirm(assumed.length+' appointment'+(assumed.length===1?' is':'s are')+
     ' in a zone with no verified timezone. '+(assumed.length===1?'It':'They')+
     ' will be written as '+TZ_FALLBACK+'.\n\nDownload anyway?')) return;

  // SEQUENCE rises before the file is written, so Outlook accepts an edited
  // event as an update to the one it is already holding.
  for(const ap of list){
    if(ap.icsSeq == null) ap.icsSeq = 0;
    else if(apState(ap) === 'changed') ap.icsSeq++;
  }
  const name = 'field-calls-'+iso(plan.anchor)+(mode === 'all' ? '-all' : '')+'.ics';
  downloadFile(name, buildIcs(list), 'text/calendar;charset=utf-8');

  // Green only once the file has actually been handed over.
  const now = Date.now();
  for(const ap of list){ ap.exp = apRev(ap); ap.expAt = now; await saveAppt(ap); }
  renderPlan();
  toast(list.length+' appointment'+(list.length===1?'':'s')+' written to '+name);
}
$('pExport').addEventListener('click', ()=>doExport('pending').catch(e=>{ console.error(e); toast('Export failed: '+e.message); }));
$('pExportAll').addEventListener('click', ()=>doExport('all').catch(e=>{ console.error(e); toast('Export failed: '+e.message); }));

/* ================= Today and This Week =================
   The phone half of the planner. Read and act: what is on, tap to start, tap to
   close out, tap to move. No drag, no rail, no month grid.

   An appointment carries its own status. Deliberately NOT part of apRev, so
   doing the visit does not make Outlook think the invite changed and ask to be
   re-downloaded. Only the invite fields do that.

   Closing out with no report is a finished state, not a half-done one. Nothing
   here counts uncompiled calls or nags about them. It still writes a call
   record, so the visit appears in the account history and resets the cadence
   clock - you were there, whether or not there was anything to write down. */

const AP_STATUS = {
  planned:   {label:'planned',    cls:'open'},
  'in progress':{label:'in progress', cls:'open'},
  done:      {label:'done',       cls:'done'},
  missed:    {label:'missed',     cls:'overdue'},
  cancelled: {label:'cancelled',  cls:'done'}
};
const apStatus = ap => ap.status || 'planned';
const apSettled = ap => ['done','missed','cancelled'].includes(apStatus(ap));
/* 900px is the same breakpoint the plan screen's CSS uses, so the routing and
   the layout can never disagree. If matchMedia is missing, fall back to the
   width rather than assuming a phone - guessing phone would send a desktop to
   the wrong screen, which is the worse of the two mistakes. */
const PHONE_MAX = 900;
const isPhone = () => window.matchMedia
  ? window.matchMedia('(max-width: '+PHONE_MAX+'px)').matches
  : (window.innerWidth || 1024) <= PHONE_MAX;

let todayView = 'today';

function apptsBetween(fromISO, toISO){
  return APPTS.filter(a => a.date >= fromISO && a.date <= toISO)
    .sort((x,y) => x.date.localeCompare(y.date) || x.start.localeCompare(y.start));
}
function visitCard(ap, opts){
  opts = opts || {};
  const a = ACC_BY_NAME.get(ap.acct);
  const st = apStatus(ap);
  const cls = ['vis', a ? FOC_CLS[a.foc] : 'none'];
  if(apSettled(ap)) cls.push('settled');
  if(opts.late) cls.push('late');
  const cts = a ? (ap.contacts||[]).map(i => a.c[i]).filter(Boolean) : [];
  const who = cts.map(c => c.p
      ? '<a href="tel:'+esc(c.p.replace(/\s/g,''))+'">'+esc(c.n)+' &middot; '+esc(c.p)+'</a>'
      : '<span class="nn">'+esc(c.n)+' <span class="rl">no number on file</span></span>'
    ).join('');
  const when = (opts.showDate ? dayLabel(ap.date)+' ' : '') + ap.start;
  const where = [a ? a.sub : '', a ? zoneName(a.z) : '', ap.type, ap.dur+' min']
    .filter(Boolean).map(esc).join(' &middot; ');

  // A settled visit keeps its card but drops the actions - nothing left to do.
  const acts = apSettled(ap)
    ? '<div class="acts"><button class="quiet" data-reopen="'+esc(ap.id)+'">Reopen</button></div>'
    : '<div class="acts">'+
        '<button class="go" data-start="'+esc(ap.id)+'">Start</button>'+
        '<button data-closeout="'+esc(ap.id)+'">Close out</button>'+
        '<button data-move="'+esc(ap.id)+'">Move</button>'+
        (opts.late ? '<button class="quiet" data-missed="'+esc(ap.id)+'">Missed</button>' : '')+
        '<button class="quiet" data-cancel="'+esc(ap.id)+'">Cancel</button>'+
      '</div>';

  return '<div class="'+cls.join(' ')+'">'+
    '<div class="when">'+esc(when)+'<span class="st '+AP_STATUS[st].cls+'">'+AP_STATUS[st].label+'</span></div>'+
    '<div class="who">'+esc(ap.acct)+'</div>'+
    '<div class="where">'+where+'</div>'+
    (ap.agenda && ap.agenda.trim() ? '<div class="ag">'+esc(ap.agenda.trim())+'</div>' : '')+
    (who ? '<div class="cl">'+who+'</div>' : '')+
    acts + '</div>';
}
/* DAYNM is Monday to Friday, because the planner only ever grids weekdays. A
   label has to cope with a weekend: today is a Saturday often enough, and an
   appointment can be dragged onto one before the weekday check moves it. */
const DAYNM7 = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function dayLabel(dISO){
  const d = parseIso(dISO);
  return DAYNM7[d.getDay()].slice(0,3)+' '+d.getDate()+' '+MONNM[d.getMonth()].slice(0,3);
}

function renderToday(){
  const el = $('tvBody');
  $('tvPlanner').hidden = isPhone();
  if(todayView === 'today') renderTodayList(el); else renderWeekList(el);
  wireVisitCards(el);
}
function renderTodayList(el){
  const t = todayISOdate();
  const mine = APPTS.filter(a => a.date === t).sort((x,y)=>x.start.localeCompare(y.start));
  const mon = iso(startOfWeek(new Date()));
  // earlier in the week, planned and never resolved
  const late = APPTS.filter(a => a.date >= mon && a.date < t && !apSettled(a))
    .sort((x,y)=>x.date.localeCompare(y.date) || x.start.localeCompare(y.start));

  $('tvHint').textContent = mine.length
    ? mine.length+' visit'+(mine.length===1?'':'s')+' today'
    : 'Nothing planned today.';

  let html = mine.map(ap => visitCard(ap)).join('');
  if(late.length){
    html += '<div class="late"><h2>Earlier this week</h2>'+
      late.map(ap => visitCard(ap, {late:true, showDate:true})).join('')+'</div>';
  }
  el.innerHTML = html;
}
/* On a Saturday or Sunday, "this week" means the week ahead. startOfWeek rolls
   backwards to the Monday just gone, which on a Sunday evening is a list of
   days you have already worked. */
function weekViewStart(){
  const now = new Date(), g = now.getDay();
  return (g === 0 || g === 6) ? startOfWeek(addDays(now, 2)) : startOfWeek(now);
}
function renderWeekList(el){
  const mon = weekViewStart(), t = todayISOdate();
  const days = [0,1,2,3,4].map(i => addDays(mon,i));
  const n = apptsBetween(iso(days[0]), iso(days[4])).length;
  $('tvHint').textContent = n ? n+' visit'+(n===1?'':'s')+' this week' : 'Nothing planned this week.';
  el.innerHTML = days.map((d,i)=>{
    const k = iso(d);
    const list = APPTS.filter(a => a.date === k).sort((x,y)=>x.start.localeCompare(y.start));
    return '<div class="dayblk'+(k===t?' isToday':'')+'">'+
      '<h3>'+DAYNM[i]+'<span class="dt">'+d.getDate()+' '+MONNM[d.getMonth()].slice(0,3)+'</span></h3>'+
      (list.length ? list.map(ap => visitCard(ap)).join('') : '<div class="none">Nothing planned.</div>')+
      '</div>';
  }).join('');
}

function wireVisitCards(el){
  const on = (attr, fn) => el.querySelectorAll('['+attr+']').forEach(b =>
    b.addEventListener('click', ()=>fn(b.getAttribute(attr))));
  on('data-start',    id => startVisit(id).catch(reportErr));
  on('data-closeout', id => closeOutVisit(id).catch(reportErr));
  on('data-move',     id => openMoveDialog(id));
  on('data-missed',   id => setVisitStatus(id, 'missed').catch(reportErr));
  on('data-cancel',   id => setVisitStatus(id, 'cancelled').catch(reportErr));
  on('data-reopen',   id => setVisitStatus(id, 'planned', true).catch(reportErr));
}
function reportErr(e){ console.error(e); toast('That did not work: '+e.message); }

/* Build the call straight from the appointment: account, date, contacts and site
   are already decided, so the contact picker would only ask again. */
function callFromAppt(ap, extra){
  const a = ACC_BY_NAME.get(ap.acct);
  const chosen = a ? (ap.contacts||[]).map(i => a.c[i]).filter(Boolean).map(c => ({
    name:c.n, role:c.t||c.r, email:(c.e&&c.e[0])||'', mobile:c.p, crm:true, cid:c.id
  })) : [];
  return Object.assign({
    id: 'c'+Date.now(),
    date: ddmmyyyy(ap.date),
    type: ap.type === 'Planned phone call' ? 'Phone call' : 'Site call',
    mgr: $('cMgr').value,
    customer: ap.acct,
    manualAccount: !a,
    zone: a ? a.z : '',
    suburb: a ? a.sub : '',
    focus: a ? a.foc : '',
    site: '',
    contacts: chosen,
    entries: [],
    loose: [],
    apptId: ap.id,
    status: 'in progress',
    when: Date.parse(ap.date) || Date.now(),
    closed: false,
    updated: Date.now()
  }, extra || {});
}
async function startVisit(id){
  const ap = APPTS.find(x => x.id === id);
  if(!ap) return;
  if(ap.callId){
    const all = await callsAll();
    const existing = all.find(c => c.id === ap.callId);
    if(existing){ call = existing; call.loose = call.loose || []; go('dash'); return; }
  }
  const draft = callFromAppt(ap);
  const reuse = await offerExistingCall(ap.acct, ap.date, draft.contacts, '');
  call = reuse || draft;
  if(reuse) toast('Continuing the call from ' + reuse.date);
  await saveCall();
  ap.status = 'in progress';
  ap.callId = call.id;
  await saveAppt(ap);
  go('dash');
}
async function closeOutVisit(id){
  const ap = APPTS.find(x => x.id === id);
  if(!ap) return;
  if(!confirm('Close out '+ap.acct+' with no report?\n\nThe visit is filed against the account and counts '+
              'towards its cadence. Nothing is written up.')) return;
  let filed = null;
  if(ap.callId){
    const all = await callsAll();
    const c = all.find(x => x.id === ap.callId);
    if(c){
      c.closed = true; c.status = 'done'; c.noReport = !c.entries.length; c.updated = Date.now();
      await callsPut(c);
      filed = c;
    }
  }
  if(!filed){
    filed = callFromAppt(ap, {status:'done', closed:true, noReport:true});
    await callsPut(filed);
    ap.callId = filed.id;
  }
  ap.status = 'done';
  /* Still write a summary. "Nothing to report" is an outcome, and the invite
     saying so is the difference between a visit that happened quietly and one
     that looks like it never happened. */
  ap.callSummary = callSummary(filed);
  await saveAppt(ap);
  indexCalls(await callsAll());
  renderToday(); renderHomeCounts();
  toast('Closed out - no report');
}
async function setVisitStatus(id, status, quiet){
  const ap = APPTS.find(x => x.id === id);
  if(!ap) return;
  if(!quiet && !confirm('Mark '+ap.acct+' as '+status+'?')) return;
  ap.status = status;
  await saveAppt(ap);
  renderToday(); renderHomeCounts();
  if(!quiet) toast('Marked '+status);
}

/* ================= one call per account per week =================
   Two visits to the same plant in the same week are usually one job: you were
   there Tuesday, went back Thursday for the thing you could not get to. Starting
   a second record splits the notes across two files and two rows of history.

   So before a new call is created, the week is checked. If there is already a
   call at that account, it is offered - and taking it carries everything across,
   because it IS the same record. Contacts picked this time are merged in rather
   than replacing what was there. */
function weekBounds(dISO){
  const d = dISO ? parseIso(dISO) : new Date();
  const mon = startOfWeek(d);
  return {from: mon.getTime(), to: addDays(mon, 6).getTime() + 86399999};
}
function callsSameWeek(customer, dISO, excludeId){
  const {from, to} = weekBounds(dISO);
  return callsFor(customer)
    .filter(c => c.id !== excludeId && c.status !== 'cancelled' && c.status !== 'missed')
    .filter(c => { const t = callWhen(c); return t >= from && t <= to; })
    .sort((a,b) => callWhen(b) - callWhen(a));
}
function describeCall(c){
  const n = (c.entries||[]).length;
  const belts = (c.entries||[]).filter(e => e.type === 'belt').length;
  const bits = [n ? n + ' entr' + (n===1?'y':'ies') : 'nothing logged yet'];
  if(belts) bits.push(belts + ' belt' + (belts===1?'':'s'));
  if(c.site) bits.push(c.site);
  bits.push(c.closed ? 'closed' : 'still open');
  return c.date + ' - ' + bits.join(', ');
}
/* Returns the existing call if the user chooses it, or null to start a new one. */
async function offerExistingCall(customer, dISO, chosenContacts, site){
  const found = callsSameWeek(customer, dISO);
  if(!found.length) return null;
  const c = found[0];
  const more = found.length > 1 ? '\n\n(' + (found.length - 1) + ' other call' +
    (found.length === 2 ? '' : 's') + ' this week as well - the most recent is offered.)' : '';
  if(!confirm('There is already a call at ' + customer + ' this week:\n\n' +
      describeCall(c) + more +
      '\n\nContinue that one? Everything already on it is kept.\n\n' +
      'Cancel to start a separate call instead.')) return null;

  const all = await callsAll();
  const live = all.find(x => x.id === c.id) || c;
  live.loose = live.loose || [];
  // anyone picked this time who was not on it before
  const have = new Set((live.contacts||[]).map(x => (x.name||'').toLowerCase()));
  (chosenContacts||[]).forEach(x => {
    if(!have.has((x.name||'').toLowerCase())){ live.contacts.push(x); have.add((x.name||'').toLowerCase()); }
  });
  if(site && !live.site) live.site = site;
  if(live.closed){ live.closed = false; live.status = 'in progress'; }
  return live;
}

/* ---------- an unplanned call books itself ----------
   A call started without a plan behind it still happened, and the desktop should
   see it on the calendar rather than only in the account history. So the call
   creates its own appointment, on the day it is being done, and that appointment
   travels back with the calls.

   Only for accounts that are in the account book. An appointment against a
   manually typed account would have nothing to look up - the invite builder
   reads the zone, and the next CRM import drops appointments whose account is
   not in the export. The call itself still syncs either way; it just does not
   get a calendar entry. */
async function bookUnplanned(c, acc){
  if(!c || !acc || c.apptId) return null;
  const now = new Date();
  const ap = {
    id: 'ap' + Date.now().toString(36) + (plan.seq++),
    acct: acc.a,
    type: c.type === 'Phone call' ? 'Planned phone call' : 'Intralox site visit',
    date: isoFromDdmmyyyy(c.date) || todayISOdate(),
    start: String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0'),
    dur: 60,
    agenda: '',
    contacts: (c.contacts||[]).map(x => acc.c.findIndex(y => y.n === x.name)).filter(i => i >= 0),
    /* origin marks it as made on this device and not yet seen by the other one.
       The plan-file deletion rule is authoritative for its date range, and would
       otherwise wipe this the moment a plan arrived that predates it. */
    origin: isPhone() ? 'phone' : 'desktop',
    acked: false,
    status: 'in progress',
    callId: c.id,
    unplanned: true
  };
  APPTS.push(ap);
  await saveAppt(ap);
  c.apptId = ap.id;
  await saveCall();
  renderPlanCount();
  return ap;
}
// call dates are stored DD/MM/YYYY; appointments are keyed on ISO
function isoFromDdmmyyyy(d){
  const p = String(d||'').split('/');
  if(p.length !== 3) return null;
  return p[2] + '-' + p[1].padStart(2,'0') + '-' + p[0].padStart(2,'0');
}

/* ---------- move ---------- */
let movingAppt = null;
function openMoveDialog(id){
  const ap = APPTS.find(x => x.id === id);
  if(!ap) return;
  movingAppt = ap;
  $('mvTitle').textContent = 'Move ' + ap.acct;
  $('mvSub').textContent = 'Currently ' + dayLabel(ap.date) + ' at ' + ap.start;
  const mon = startOfWeek(new Date());
  const days = [];
  for(let i=0;i<14;i++){
    const d = addDays(mon,i);
    if(isWeekday(d)) days.push(d);
  }
  $('mvDays').innerHTML = days.map(d=>{
    const k = iso(d);
    return '<button data-day="'+k+'"'+(k===ap.date?' disabled':'')+'>'+esc(dayLabel(k))+
      (k===todayISOdate() ? ' <span class="tag">today</span>' : '')+
      (k===ap.date ? ' <span class="tag">where it is now</span>' : '')+'</button>';
  }).join('');
  $('mvDays').querySelectorAll('[data-day]').forEach(b =>
    b.addEventListener('click', ()=>moveTo(b.dataset.day).catch(reportErr)));
  const dlg = $('mvdlg');
  if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
  pushDialog('mvdlg');
}
function closeMove(){
  const dlg = $('mvdlg');
  if(!dlg.hasAttribute('open')){ movingAppt = null; return; }
  if(history.state && history.state.dialog === 'mvdlg'){ history.back(); return; }
  if(dlg.close) dlg.close(); else dlg.removeAttribute('open');
  movingAppt = null;
}
async function moveTo(k){
  const ap = movingAppt;
  if(!ap) return;
  ap.date = k;
  /* Moving a visit here edits a record the desktop owns. The exchange resolves
     that newest-wins, so the edit is stamped rather than silently applied. */
  ap.movedAt = Date.now();
  ap.movedOn = 'phone';
  await saveAppt(ap);
  closeMove();
  renderToday();
  toast('Moved to ' + dayLabel(k));
}
$('mvCancel').addEventListener('click', closeMove);

$('tvView').querySelectorAll('button').forEach(b => b.addEventListener('click', ()=>{
  todayView = b.dataset.v;
  $('tvView').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  $('title').textContent = todayView === 'today' ? 'Today' : 'This week';
  renderToday();
}));
/* Booking ahead from the phone. The unplanned path already creates an
   appointment as a side effect of starting a call; this is the same thing
   without doing the visit - "I said I'd come back Thursday". Same origin and
   acknowledgement flags, so it survives the next plan file the same way. */
let bookAcct = null;
function startBooking(){
  if(!ACCOUNTS.length){ toast('Import the CRM export first'); return; }
  bookAcct = null;
  cameFromAcct = false;
  bookingMode = true;
  $('cDate').value = todayISO();
  go('account'); renderAccSearch();
  $('accHint').textContent = 'Pick the account to book a visit at';
}
let bookingMode = false;
async function bookVisitFor(name){
  const acc = ACC_BY_NAME.get(name);
  bookingMode = false;
  if(!acc){
    toast('Only accounts from the CRM export can be booked');
    go('today');
    return;
  }
  bookAcct = acc;
  const ap = {
    id: 'ap' + Date.now().toString(36) + (plan.seq++),
    acct: acc.a, type: 'Intralox site visit',
    date: todayISOdate(), start: '09:00', dur: 60, agenda: '',
    contacts: acc.c.map((_, i) => i).slice(0, 6),
    origin: isPhone() ? 'phone' : 'desktop', acked: false,
    status: 'planned'
  };
  APPTS.push(ap);
  await saveAppt(ap);
  renderPlanCount();
  go('today');
  // straight into the day picker, because the date is the point of booking
  openMoveDialog(ap.id);
  $('mvTitle').textContent = 'Book ' + acc.a;
  $('mvSub').textContent = 'Pick the day. It travels to the PC with your calls.';
}
$('tvBook').addEventListener('click', startBooking);
$('tvUnplanned').addEventListener('click', ()=>{
  cameFromAcct = false; bookingMode = false;
  $('cDate').value = todayISO();
  go('account'); renderAccSearch();
});
$('tvPlanner').addEventListener('click', ()=>go('plan'));
$('pToday2').addEventListener('click', ()=>go('today'));

/* ================= device exchange =================
   Not whole-database sync. Plan Monday on the PC, log calls Tuesday to Friday on
   the phone, open the PC on Friday and save, and last-write-wins eats the week.
   Instead each side sends only what it owns and the other side merges by record
   id, never overwriting the database:

     plan file   PC -> phone    appointments, sync state, optionally accounts
     call file   phone -> PC    calls, entries, and the visit outcomes

   Deletion is the awkward case. Rather than keeping tombstones, a plan file
   declares the date range it covers and is authoritative for it: an appointment
   inside that range that is not in the file has been deleted on the desktop, so
   it goes - unless the phone has touched it since, in which case it is kept and
   reported. Nothing outside the range is ever touched. The phone cannot create
   appointments, so there is no case where this discards something the phone
   made and the desktop never had.

   The one real conflict is an appointment edited on both sides. Newest wins by
   touchedAt, and the count is reported rather than resolved silently. */

const EXCHANGE_VER = 1;
const PLAN_KIND = 'field-crm-plan', CALL_KIND = 'field-crm-calls';

/* The range must NOT be derived from what is still in the file. Deriving the end
   from the latest surviving appointment means deleting the last one shrinks the
   range past it, so the deletion never propagates - the record it was meant to
   remove sits just outside the window and is treated as none of the file's
   business. The window is open-ended forward instead: a plan is authoritative
   for this week onwards, and never touches anything before it. */
function apptRange(){
  return {from: iso(startOfWeek(new Date())), to: '9999-12-31'};
}
async function buildPlanFile(withAccounts){
  const range = apptRange();
  return {
    kind: PLAN_KIND,
    version: EXCHANGE_VER,
    made: Date.now(),
    device: isPhone() ? 'phone' : 'desktop',
    range: range,
    /* Deep copy, not the live objects. A file is a snapshot: handing out
       references means anything that touches APPTS between building and
       serialising silently changes what was already described as sent. */
    appts: JSON.parse(JSON.stringify(APPTS.filter(a => a.date >= range.from))),
    weeks: JSON.parse(JSON.stringify(WEEKS)),
    mgrOf: JSON.parse(JSON.stringify(MGR_OF)),
    accounts: withAccounts ? ACCOUNTS : null,
    meta: withAccounts ? META : null,
    overrides: withAccounts ? OVERRIDES : null
  };
}
/* The phone owns calls, and it owns what happened to a visit. Those two things
   travel together: the desktop needs to know a visit was done, missed or moved,
   and that is not the whole appointment - just the outcome. */
async function buildCallFile(withPhotos){
  const calls = await callsAll();
  return {
    kind: CALL_KIND,
    version: EXCHANGE_VER,
    made: Date.now(),
    device: isPhone() ? 'phone' : 'desktop',
    withPhotos: !!withPhotos,
    calls: withPhotos ? await Promise.all(calls.map(inlinePhotos)) : calls.map(stripPhotos),
    /* Appointments made on this device that the other side has never seen. Sent
       whole, because there is nothing there to update - it does not exist yet. */
    newAppts: JSON.parse(JSON.stringify(
      APPTS.filter(a => a.origin && !a.acked))),
    apptUpdates: APPTS
      .filter(a => a.status || a.callId || a.movedOn)
      .map(a => ({id:a.id, status:a.status||null, date:a.date, callId:a.callId||null,
                  movedOn:a.movedOn||null, touchedAt:a.touchedAt||0,
                  callSummary:a.callSummary||null}))
  };
}

async function mergePlanFile(data){
  const incoming = Array.isArray(data.appts) ? data.appts : [];
  const byId = new Map(APPTS.map(a => [a.id, a]));
  let added = 0, updated = 0, kept = 0, removed = 0, keptOutside = 0;

  for(const ap of incoming){
    if(!ap || !ap.id) continue;
    const mine = byId.get(ap.id);
    if(!mine){ await apptsPut(Object.assign({}, ap, {acked:true})); added++; continue; }
    /* The file contains it, so the other side has seen it and it is no longer
       this device's private record. Persisted here rather than in a sweep at the
       end - a later sweep would write back records the deletion pass removed. */
    const wasPrivate = mine.origin && !mine.acked;
    if(wasPrivate) mine.acked = true;
    // newest wins, and a tie goes to what is already here rather than churning
    if((mine.touchedAt||0) > (ap.touchedAt||0)){
      if(wasPrivate) await apptsPut(mine);
      kept++; continue;
    }
    /* The phone's outcome is not in the desktop's copy, so carry it over rather
       than losing that the visit was done. */
    const merged = Object.assign({}, ap);
    if(mine.status && !ap.status) merged.status = mine.status;
    if(mine.callId && !ap.callId) merged.callId = mine.callId;
    if(mine.callSummary && !ap.callSummary) merged.callSummary = mine.callSummary;
    if(mine.origin && !merged.origin) merged.origin = mine.origin;
    merged.acked = true;
    await apptsPut(merged);
    updated++;
  }

  const inFile = new Set(incoming.map(a => a.id));
  const r = data.range || {from:'0000-00-00', to:'9999-99-99'};
  for(const mine of APPTS){
    if(inFile.has(mine.id)) continue;
    if(mine.date < r.from || mine.date > r.to){ keptOutside++; continue; }
    /* Made here and not yet sent anywhere. The file cannot be authoritative about
       a record whose existence it has never been told of. */
    if(mine.origin && !mine.acked){ kept++; continue; }
    // touched here since the file was made: keep it and say so
    if((mine.touchedAt||0) > (data.made||0)){ kept++; continue; }
    await apptsDel(mine.id);
    removed++;
  }

  /* Weeks and reassignments are desktop-owned outright - the phone has no way to
     set either - so they are taken wholesale rather than merged record by record. */
  if(data.weeks){ WEEKS = data.weeks; await kvSet('weeks', WEEKS); }
  if(data.mgrOf){ MGR_OF = data.mgrOf; await kvSet('mgrOf', MGR_OF); }
  if(Array.isArray(data.accounts) && data.accounts.length){
    await accReplaceAll(data.accounts);
    if(data.meta) await kvSet('meta', data.meta);
    if(data.overrides) await kvSet('overrides', data.overrides);
  }
  await loadAccounts();
  return {added, updated, kept, removed, keptOutside,
          accounts: (data.accounts||[]).length};
}

async function mergeCallFile(data){
  const calls = Array.isArray(data.calls) ? data.calls : [];
  const existing = await callsAll();
  const have = new Map(existing.map(c => [c.id, c]));
  let added = 0, updated = 0, skipped = 0;
  for(const c of calls){
    if(!c || !c.id) continue;
    const mine = have.get(c.id);
    if(mine && (mine.updated||0) > (c.updated||0)){ skipped++; continue; }
    (c.entries||[]).forEach(e => {
      e.photos = (e.photos||[]).map(p => {
        try { return typeof p === 'string' && p.startsWith('data:') ? dataURLToBlob(p) : p; }
        catch(err){ return null; }
      }).filter(Boolean);
    });
    c.loose = (c.loose||[]).map(p => {
      try { return typeof p === 'string' && p.startsWith('data:') ? dataURLToBlob(p) : p; }
      catch(err){ return null; }
    }).filter(Boolean);
    if(mine) updated++; else added++;
    await callsPut(c);
  }
  // appointments the other device created for calls that were not planned
  let booked = 0;
  for(const ap of (data.newAppts || [])){
    if(!ap || !ap.id) continue;
    if(APPTS.some(x => x.id === ap.id)) continue;
    if(!ACC_BY_NAME.has(ap.acct)) continue;   // nothing to hang it on here
    const copy = Object.assign({}, ap, {acked: true});
    await apptsPut(copy);
    booked++;
  }
  if(booked) APPTS = await apptsAll();

  // visit outcomes ride back with the calls
  let visits = 0, visitsKept = 0;
  /* Newest-wins is the wrong rule for the whole record here. The phone owns the
     outcome - whether the visit happened, which call it became, what was written
     up - and only the phone can produce those. The desktop owns the invite. So
     the outcome always applies, and only the contested field (the date) falls
     back to newest-wins. Without this split, a desktop that merely touched the
     appointment later silently discards a week's notes. */
  for(const u of (data.apptUpdates||[])){
    const ap = APPTS.find(x => x.id === u.id);
    if(!ap) continue;
    let touched = false;
    if(u.status && u.status !== ap.status){ ap.status = u.status; touched = true; }
    if(u.callId && u.callId !== ap.callId){ ap.callId = u.callId; touched = true; }
    if(u.callSummary && sumRev(u.callSummary) !== sumRev(ap.callSummary)){
      ap.callSummary = u.callSummary; touched = true;
    }
    if(u.date && u.date !== ap.date){
      if((ap.touchedAt||0) > (u.touchedAt||0)) visitsKept++;
      else { ap.date = u.date; touched = true; }
    }
    if(!touched) continue;
    ap.touchedAt = Math.max(ap.touchedAt||0, u.touchedAt||0, Date.now());
    await apptsPut(ap);
    visits++;
  }
  APPTS = await apptsAll();
  indexCalls(await callsAll());
  return {added, updated, skipped, visits, visitsKept, booked,
          photos: data.withPhotos ? 'with photos' : 'no photos'};
}

async function receiveExchange(file){
  const data = JSON.parse(await file.text());
  if(!data || !data.kind){
    if(data && data.format === BACKUP_FORMAT)
      throw new Error('that is a backup file - use Restore from backup instead');
    throw new Error('that is not a Field CRM exchange file');
  }
  if(data.kind === PLAN_KIND){
    const r = await mergePlanFile(data);
    renderPlanCount(); renderDbStat(); fillManagers();
    if(screen === 'today') renderToday();
    if(screen === 'plan') renderPlan();
    await renderHome();
    const bits = [r.added+' added', r.updated+' updated'];
    if(r.removed) bits.push(r.removed+' removed');
    if(r.kept) bits.push(r.kept+' kept, edited here since');
    if(r.accounts) bits.push(r.accounts+' accounts');
    return 'Plan merged: ' + bits.join(', ');
  }
  if(data.kind === CALL_KIND){
    const r = await mergeCallFile(data);
    await renderHome();
    const bits = [r.added+' calls added', r.updated+' updated'];
    if(r.skipped) bits.push(r.skipped+' already newer here');
    if(r.booked) bits.push(r.booked+' unplanned visit'+(r.booked===1?'':'s')+' added to the plan');
    if(r.visits) bits.push(r.visits+' visit outcomes');
    return 'Calls merged: ' + bits.join(', ') + ' (' + r.photos + ')';
  }
  throw new Error('unrecognised exchange file: ' + data.kind);
}

/* ---------- transport ----------
   Phone: the share sheet, exactly as the compiled notes already work.
   Desktop: the File System Access API, pointed once at the OneDrive-synced
   folder and the handle kept in IndexedDB. OneDrive's own client does the
   upload. The API is not supported on Android Chrome, which is why the phone
   uses the share sheet instead. */
/* Two folders, not one, and each is named for the device that owns it and the
   direction the data travels. A single shared folder meant "did I already read
   that one?" every time, and a plan the PC had just written could be re-read by
   the PC itself. Separate folders make each one a one-way pipe:

     PC -> Phone    the PC writes plan files here; the phone reads them
     Phone -> PC    the phone writes call files here; the PC reads them

   The phone cannot hold a folder handle at all - Android Chrome has no File
   System Access API - so on the phone these are OneDrive folders reached through
   the share sheet, and the buttons are hidden. */
let DIR_OUT = null, DIR_IN = null;
const DIR_LABEL = {
  out: 'PC \u2192 Phone (the PC writes plans here)',
  in:  'Phone \u2192 PC (the phone writes calls here)'
};
const hasFS = () => typeof window.showDirectoryPicker === 'function';
async function dirOk(handle, mode){
  if(!handle || !handle.queryPermission) return !!handle;
  const opts = {mode: mode || 'readwrite'};
  if(await handle.queryPermission(opts) === 'granted') return true;
  return await handle.requestPermission(opts) === 'granted';
}
async function loadDir(){
  try {
    DIR_OUT = await kvGet('dirOut') || null;
    DIR_IN  = await kvGet('dirIn')  || null;
    // one folder was used for both before this; keep it as the outbound one
    if(!DIR_OUT){
      const old = await kvGet('dirHandle');
      if(old){ DIR_OUT = old; await kvSet('dirOut', old); }
    }
  } catch(e){ DIR_OUT = DIR_IN = null; }
  renderExchange();
}
async function pickDir(which){
  if(!hasFS()){
    toast('This device cannot hold a folder. Use the share sheet, or the Receive button.');
    return;
  }
  const h = await window.showDirectoryPicker({mode:'readwrite'});
  if(which === 'in'){ DIR_IN = h; await kvSet('dirIn', h); }
  else { DIR_OUT = h; await kvSet('dirOut', h); }
  renderExchange();
  logLoad(h.name || 'folder', 'folder', 'Set as ' + DIR_LABEL[which === 'in' ? 'in' : 'out']);
  toast('Folder set: ' + (h.name || 'chosen') + ' \u2014 ' + DIR_LABEL[which === 'in' ? 'in' : 'out']);
}
async function writeToDir(dir, name, text){
  if(!dir) return false;
  if(!await dirOk(dir, 'readwrite')){ toast('Permission to that folder was declined'); return false; }
  const fh = await dir.getFileHandle(name, {create:true});
  const wr = await fh.createWritable();
  await wr.write(text);
  await wr.close();
  return true;
}
async function readFromDir(dir, name){
  if(!dir) return null;
  if(!await dirOk(dir, 'read')) return null;
  try {
    const fh = await dir.getFileHandle(name);
    return await fh.getFile();
  } catch(e){ return null; }
}
async function sendFile(name, text, dir, where){
  if(dir && await writeToDir(dir, name, text)){
    toast('Written to ' + (dir.name || 'the folder') + '/' + name + ' \u2014 ' + where);
    logLoad(name, 'sent', 'Written to ' + (dir.name || 'folder') + ' \u2014 ' + where);
    return;
  }
  const file = new File([text], name, {type:'application/json'});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try {
      await navigator.share({files:[file], title:name});
      toast('Shared ' + name + ' \u2014 save it to the ' + where + ' folder');
      logLoad(name, 'sent', 'Shared \u2014 ' + where);
      return;
    }
    catch(e){ if(e.name === 'AbortError') return; console.error(e); }
  }
  downloadFile(name, text, 'application/json');
  toast('Saved ' + name + ' to Downloads \u2014 move it to the ' + where + ' folder');
  logLoad(name, 'sent', 'Downloaded \u2014 ' + where);
}
function exchangeName(kind){
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return kind + '-' + d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()) + '.json';
}
async function sendPlan(){
  if(!APPTS.length){ toast('Nothing planned to send'); return; }
  const withAccounts = confirm('Include the account database in this plan file?\n\n' +
    'Say yes the first time, or after re-importing from Dynamics. Say no for a ' +
    'routine weekly plan - it keeps the file small.');
  const data = await buildPlanFile(withAccounts);
  await sendFile(exchangeName(PLAN_KIND), JSON.stringify(data), DIR_OUT, DIR_LABEL.out);
  localStorage.setItem(LS('lastPlanSent'), String(Date.now()));
  renderExchange();
}
async function sendCalls(){
  const calls = await callsAll();
  if(!calls.length){ toast('No calls to send'); return; }
  const withPhotos = confirm('Include the photos?\n\nThey are already in the notes you shared, ' +
    'so no is usually right and keeps the file small.');
  const data = await buildCallFile(withPhotos);
  await sendFile(exchangeName(CALL_KIND), JSON.stringify(data), DIR_IN, DIR_LABEL['in']);
  localStorage.setItem(LS('lastCallsSent'), String(Date.now()));
  renderExchange();
}
/* Each folder is read for the one kind that belongs in it. Reading a plan out of
   the outbound folder would mean the PC re-importing what it just wrote. */
async function receiveFromFolder(){
  const jobs = [[DIR_IN, CALL_KIND, DIR_LABEL['in']], [DIR_OUT, PLAN_KIND, DIR_LABEL.out]];
  if(!jobs.some(j => j[0])){ toast('No folders set yet'); return; }
  let found = 0;
  for(const [dir, kind, where] of jobs){
    if(!dir) continue;
    for(const name of await dirCandidates(dir, kind)){
      const f = await readFromDir(dir, name);
      if(!f) continue;
      try {
        const msg = await receiveExchange(f);
        logLoad(name, kind === PLAN_KIND ? 'plan' : 'calls', msg);
        toast(name + ': ' + msg);
        found++;
      }
      catch(e){ console.error(e); toast(name + ': ' + e.message); }
      break;
    }
  }
  if(!found) toast('No new files found in the folders that are set');
  renderExchange();
}
async function dirCandidates(dir, kind){
  // newest first, so a folder with several weeks of files takes the current one
  const names = [];
  if(dir && dir.entries){
    for await (const [n, h] of dir.entries()){
      if(typeof n === 'string' && n.startsWith(kind) && n.endsWith('.json')) names.push(n);
    }
  }
  names.sort().reverse();
  names.push(kind + '.json');
  return names;
}
function renderExchange(){
  const phone = isPhone();
  const dirLine = (dir, which) => {
    if(dir) return 'Folder set: <b>' + esc(dir.name || 'chosen folder') + '</b>';
    if(!hasFS()) return which === 'out'
      ? 'This device cannot hold a folder. On the phone, open the plan in OneDrive and tap Share &rarr; Field CRM.'
      : 'This device cannot hold a folder. Send the calls with the share sheet and save them into the Phone &rarr; PC folder in OneDrive.';
    return '<span class="flagline">No folder set.</span> Set it on the PC and point it at a OneDrive folder that syncs.';
  };
  const out = $('exOutStat'), inn = $('exInStat');
  if(out) out.innerHTML = dirLine(DIR_OUT, 'out') +
    '<br><span class="cov">' + (phone ? 'You read from this folder.' : 'You write to this folder.') + '</span>';
  if(inn) inn.innerHTML = dirLine(DIR_IN, 'in') +
    '<br><span class="cov">' + (phone ? 'You write to this folder.' : 'You read from this folder.') + '</span>';
  $('exPickOut').hidden = !hasFS();
  $('exPickIn').hidden = !hasFS();
  $('exPull').hidden = !(DIR_OUT || DIR_IN);

  const el = $('exStat');
  if(el){
    const bits = [];
    bits.push('This device is acting as the <b>' + (phone ? 'phone' : 'PC') + '</b>.');
    bits.push(APPTS.length + ' appointment' + (APPTS.length===1?'':'s') + ' held');
    const unsent = APPTS.filter(a => a.origin && !a.acked).length;
    if(unsent) bits.push('<span class="flagline">' + unsent + ' made here and not yet sent</span>');
    const withNotes = APPTS.filter(a => a.callSummary).length;
    if(withNotes) bits.push(withNotes + ' visit' + (withNotes===1?'':'s') + ' written up');
    const wk = weeksList().length;
    if(wk) bits.push(wk + ' territory week' + (wk===1?'':'s') + ' set');
    const moved = ACCOUNTS.filter(isMoved).length;
    if(moved) bits.push(moved + ' account' + (moved===1?'':'s') + ' reassigned');
    el.innerHTML = bits.join('<br>');
    $('exReassignCsv').hidden = !moved;
  }
  renderLoadLog();
}
$('exPickOut').addEventListener('click', ()=>pickDir('out').catch(e=>{
  if(e && e.name === 'AbortError') return; reportErr(e);
}));
$('exPickIn').addEventListener('click', ()=>pickDir('in').catch(e=>{
  if(e && e.name === 'AbortError') return; reportErr(e);
}));
$('exReassignCsv').addEventListener('click', exportReassignments);
$('exSendPlan').addEventListener('click', ()=>sendPlan().catch(reportErr));
$('exSendCalls').addEventListener('click', ()=>sendCalls().catch(reportErr));
$('exPull').addEventListener('click', ()=>receiveFromFolder().catch(reportErr));
$('exBtn').addEventListener('click', async ()=>{
  const f = $('exFile').files[0];
  if(!f){ toast('Choose a file first'); return; }
  try {
    const msg = await routeIncomingFile(f);
    renderExchange(); renderDbStat(); fillManagers(); renderBackupStat();
    await renderHome();
    toast(msg);
  }
  catch(e){ console.error(e); toast('Could not read that file: ' + e.message); }
});

/* ================= one door for every incoming file =================

   The share target, the Receive button and the Restore button all end up here.
   Android hands over whatever the user tapped Share on, with no way to say what
   kind of file it is, so the app has to work it out - and once it can, there is
   no reason the on-screen buttons should be fussier than the share sheet.

   Sniffing is on content, not the filename. A plan file renamed by OneDrive to
   "field-crm-plan-2026-09-07 (1).json" still has its kind inside it. */
async function routeIncomingFile(file, opts){
  try { return await routeIncomingFileInner(file, opts); }
  catch(e){
    // a refusal is worth logging too - during testing the question is always
    // "did that file load?", and "no, and here is why" is a real answer
    await logLoad(file.name || '(no name)', 'unknown', e.message, true);
    throw e;
  }
}
async function routeIncomingFileInner(file, opts){
  opts = opts || {};
  const name = (file.name || '').toLowerCase();

  if(name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')){
    await importCrm(file);
    return 'Imported ' + (META ? META.counts.accounts + ' accounts' : 'the CRM export');
  }

  let data;
  try { data = JSON.parse(await file.text()); }
  catch(e){
    throw new Error('that is not a file Field CRM knows what to do with. Expected a plan, ' +
      'a call file, a backup, the zone overrides, or a CRM export.');
  }

  if(data && (data.kind === PLAN_KIND || data.kind === CALL_KIND)){
    const msg = await receiveExchange(file);
    await logLoad(file.name || 'exchange file',
      data.kind === PLAN_KIND ? 'plan' : 'calls', msg);
    return msg;
  }
  if(data && data.format === BACKUP_FORMAT){
    /* A backup arriving through the share sheet is almost always deliberate, but
       it is the one route that can pull a whole database in, so it asks. */
    if(!opts.silent && !confirm('That is a backup file, not a plan.\n\nRestore from it?\n\n' +
       'Records are added and updated by id. Nothing already on this device is deleted.')) {
      return 'Restore cancelled';
    }
    await doRestore(file);
    await logLoad(file.name || 'backup', 'backup',
      (data.calls||[]).length + ' calls, ' + (data.accounts||[]).length + ' accounts' +
      (data.withPhotos ? ', with photos' : ', no photos'));
    return 'Backup restored';
  }
  if(data && (data.acctZone || data.spelling)){
    await importOverrides(file);
    return Object.keys(OVERRIDES.acctZone).length + ' zone overrides loaded';
  }
  throw new Error('that JSON file is not a Field CRM plan, call file, backup or zone overrides');
}

/* ---------- share target hand-off ----------
   The service worker parks the shared file in a cache and redirects here, because
   a File cannot survive the redirect itself. Collected once, then deleted - a
   file left in the cache would re-import itself on every launch. */
const SHARE_CACHE = 'fieldcrm-share', SHARE_KEY = './shared-file';
async function takeSharedFile(){
  if(typeof caches === 'undefined') return null;
  try {
    const c = await caches.open(SHARE_CACHE);
    const res = await c.match(SHARE_KEY);
    if(!res) return null;
    await c.delete(SHARE_KEY);
    const name = decodeURIComponent(res.headers.get('x-filename') || 'shared-file');
    const blob = await res.blob();
    return new File([blob], name, {type: res.headers.get('content-type') || blob.type || ''});
  } catch(e){ console.warn('share hand-off', e); return null; }
}
async function consumeSharedFile(){
  const file = await takeSharedFile();
  // strip ?shared=1 either way, so it cannot linger in the history entries
  try {
    if(location.search) history.replaceState(history.state || {screen:'home'}, '',
      location.pathname + location.hash);
  } catch(e){}
  if(!file) return;
  toast('Reading ' + file.name + '...');
  try {
    const msg = await routeIncomingFile(file);
    renderExchange(); renderDbStat(); fillManagers(); renderBackupStat();
    await renderHome();
    toast(msg);
  } catch(e){
    console.error(e);
    toast(file.name + ': ' + e.message);
  }
}

/* ================= what has been loaded =================
   Every file that comes in or goes out is written to a short log with its
   filename, when, and what it did. During testing the constant question is "did that
   actually load?" and a toast that has already faded is no answer. */
let LOAD_LOG = [];
const LOAD_LOG_MAX = 12;
const LOAD_KIND = {
  crm:'CRM export', overrides:'Zone overrides', beltref:'Belt reference data', plan:'Plan from PC',
  calls:'Calls from phone', backup:'Backup restore', sent:'Sent', folder:'Folder'
};
async function logLoad(filename, kind, detail, failed){
  LOAD_LOG.unshift({at: Date.now(), file: filename || '(no name)', kind: kind,
                    detail: detail || '', failed: !!failed});
  LOAD_LOG = LOAD_LOG.slice(0, LOAD_LOG_MAX);
  try { await kvSet('loadLog', LOAD_LOG); } catch(e){}
  renderLoadLog();
}
function renderLoadLog(){
  const el = $('loadLog');
  if(!el) return;
  if(!LOAD_LOG.length){
    el.innerHTML = '<p class="empty">No files loaded on this device yet.</p>';
    return;
  }
  el.innerHTML = LOAD_LOG.map(r => {
    const d = new Date(r.at);
    return '<div class="ldrow'+(r.failed ? ' bad' : '')+'">'+
      '<div class="ldtop"><span class="ldok">'+(r.failed ? '\u2717 Failed' : '\u2713 Loaded successfully')+
      '</span><span class="ldkind">'+esc(LOAD_KIND[r.kind] || r.kind)+'</span></div>'+
      '<div class="ldfile">'+esc(r.file)+'</div>'+
      '<div class="lddet">'+esc(r.detail)+'</div>'+
      '<div class="ldwhen">'+d.toLocaleDateString()+' '+
        d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})+'</div></div>';
  }).join('');
}

/* ---------- home ---------- */
async function renderHome(){
  const all = await callsAll();
  indexCalls(all);
  const open = all.filter(c=>!c.closed).sort((a,b)=>b.updated-a.updated);
  $('resumeInfo').textContent = open.length ? open[0].customer : 'None open';
  renderHomeCounts();
  const done = all.sort((a,b)=>b.updated-a.updated).slice(0,8);
  const el = $('pastList');
  if(!done.length){ el.innerHTML = '<p class="empty">No saved calls.</p>'; return; }
  el.innerHTML = done.map(c=>
    '<div class="card"><div class="hd"><span class="t">'+esc(c.date)+'</span>'+
    '<span class="acts"><button class="x" data-open="'+c.id+'">Open</button>'+
    '<button class="x bin" data-delcall="'+c.id+'">&#128465; Delete</button></span></div>'+
    '<p>'+esc(c.customer)+'<span class="st '+callStatus(c).cls+'">'+callStatus(c).label+'</span></p>'+
    '<p class="meta">'+(c.entries.length ? c.entries.length+' entries' : 'no report')+'</p></div>'
  ).join('');
  el.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click', async ()=>{
    const all2 = await callsAll();
    call = all2.find(x=>x.id===b.dataset.open);
    if(call) call.loose = call.loose || [];
    go('dash');
  }));
  el.querySelectorAll('[data-delcall]').forEach(b=>b.addEventListener('click', async ()=>{
    const id = b.dataset.delcall;
    const c = done.find(x=>x.id===id);
    const what = c ? (c.customer + ' on ' + c.date) : 'this call';
    const ph = c ? c.entries.reduce((a,e)=>a+(e.photos?e.photos.length:0),0) + (c.loose?c.loose.length:0) : 0;
    if(c) (c.entries||[]).forEach(e => (e.photos||[]).forEach(releasePhoto));
    if(!confirm('Delete ' + what + '?\n\n' + (c?c.entries.length:0) + ' entries and ' + ph +
                ' photos will be erased. This cannot be undone.')) return;
    await callsDel(id);
    if(call && call.id === id) call = null;
    toast('Call deleted');
    renderHome();
  }));
}
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click', async ()=>{
  const t = b.dataset.go;
  if(t==='newcall'){
    // a manual account is still possible with no database, so this warns rather than blocks
    if(!ACCOUNTS.length) toast('No contact database - manual account entry only');
    cameFromAcct = false; bookingMode = false;
    $('cDate').value = todayISO(); go('account'); renderAccSearch();
  } else if(t==='accounts'){
    browseScope = 'mine';
    $('abScope').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === 'mine'));
    $('abQ').value = '';
    go('accounts');
  } else if(t==='plan'){
    if(!ACCOUNTS.length){ toast('Import the CRM export first'); return; }
    if(!plan.mgr && $('cMgr').value) plan.mgr = $('cMgr').value;
    // the phone gets the read-and-act list, the desktop gets the planning surface
    go(isPhone() ? 'today' : 'plan');
  } else if(t==='due'){
    browseScope = 'due';
    $('abScope').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === 'due'));
    $('abQ').value = '';
    go('accounts');
  } else if(t==='resume'){
    const all = await callsAll();
    const open = all.filter(c=>!c.closed).sort((a,b)=>b.updated-a.updated);
    if(!open.length){ toast('No open call'); return; }
    call = open[0]; call.loose = call.loose || []; go('dash');
  } else if(t==='belt'){ resetBelt(); go('belt'); }
  else if(t==='project'){ resetProject(); go('project'); }
  else if(t==='note'){ $('nText').value=''; go('note'); }
  else if(t==='health'){ resetHealth(); go('health'); }
}));

/* ---------- import wiring ---------- */
$('importBtn').addEventListener('click', async ()=>{
  const f = $('xlsxFile').files[0];
  if(!f){ toast('Choose an .xlsx or .csv file first'); return; }
  try { await importCrm(f); }
  catch(e){ console.error(e); toast('Import failed: '+e.message); }
});
$('refBtn').addEventListener('click', async ()=>{
  const f = $('refFile').files[0];
  if(!f){ toast('Choose the plant audit workbook first'); return; }
  try { await importRef(f); }
  catch(e){ console.error(e); toast('Belt reference import failed: '+e.message); }
});
$('ovBtn').addEventListener('click', async ()=>{
  const f = $('ovFile').files[0];
  if(!f){ toast('Choose the zone overrides file first'); return; }
  try { await importOverrides(f); }
  catch(e){ console.error(e); toast('Overrides failed: '+e.message); }
});

/* ---------- account search ---------- */
/* Search reaches the whole account book, always. Equipment builders, bearing
   suppliers and head offices routinely sit in another manager's zone and you still
   have to call on them. The chosen manager's own accounts sort to the top; the rest
   carry a tag naming whose they are. Do not scope this to the manager. */
function renderAccSearch(){
  $('accQ').value=''; $('accRes').innerHTML='';
  $('accHint').textContent = META ? META.counts.accounts+' accounts loaded' : 'Import contact data first';
}
$('cMgr').addEventListener('change', ()=>{ localStorage.setItem(LS('mgr'), $('cMgr').value); updateMgrHint(); });
$('accQ').addEventListener('input', ()=>{
  const q = $('accQ').value.trim().toLowerCase();
  const res = $('accRes'); res.innerHTML='';
  if(!ACCOUNTS.length || !q){
    $('accHint').textContent = META ? META.counts.accounts+' accounts loaded' : '';
    return;
  }
  const mgr = $('cMgr').value;
  const hits = ACCOUNTS.filter(a => a.a.toLowerCase().includes(q) ||
    (a.sub && a.sub.toLowerCase().includes(q)));
  hits.sort((a,b)=>{
    const am = a.mgr===mgr, bm = b.mgr===mgr;
    if(am!==bm) return am?-1:1;
    return (FOCUS_RANK[a.foc] ?? 3) - (FOCUS_RANK[b.foc] ?? 3) || a.a.length - b.a.length;
  });
  $('accHint').textContent = hits.length+' match'+(hits.length===1?'':'es')+
    (hits.length>12 ? ' - showing 12' : '');
  hits.slice(0,12).forEach(a=>{
    const b = document.createElement('button');
    const meta = [a.sub, zoneName(a.z), a.foc, a.c.length+' contact'+(a.c.length===1?'':'s')]
      .filter(Boolean).map(esc).join(' &middot; ');
    b.innerHTML = '<span class="fd '+FOC_CLS[a.foc]+'"></span>' + esc(a.a) +
      (a.mgr===mgr ? '' : '<span class="tag">'+esc(a.mgr||'no manager')+'</span>') +
      '<div class="mt">'+meta+'</div>';
    b.addEventListener('click', ()=>chooseAccount(a.a));
    res.appendChild(b);
  });
});
const FOC_CLS = {'High':'high','Medium':'med','Low':'low','No Focus':'none'};
$('accManualGo').addEventListener('click', ()=>{
  const m = $('accManual').value.trim();
  if(!m){ toast('Enter an account name'); return; }
  if(bookingMode){
    bookingMode = false;
    toast('Only accounts from the CRM export can be booked - log it as a call instead');
    return;
  }
  chooseAccount(m, true);
});

let pendingAcct = null;
function chooseAccount(name, manual){
  if(bookingMode){ bookVisitFor(name).catch(reportErr); return; }
  const acc = manual ? null : (ACC_BY_NAME.get(name) || null);
  pendingAcct = {name, manual: !!manual, acc};
  $('ctAcc').textContent = name;
  $('ctQ').value=''; $('ncName').value=''; $('ncRole').value=''; $('ncEmail').value=''; $('ncMob').value='';
  $('cSite').value=''; $('ctErr').classList.remove('show');
  const sub = $('ctSub');
  if(sub) sub.textContent = acc
    ? [acc.sub, zoneName(acc.z), acc.foc, acc.cad].filter(Boolean).join(' \u00b7 ')
    : 'Not in the CRM export - will be flagged as needing adding to Dynamics';
  const list = $('ctList');
  const cs = acc ? acc.c : [];
  if(!cs.length){
    list.innerHTML = '<p class="empty">No contacts on file. Add one below.</p>';
  } else {
    list.innerHTML = cs.map((c,i)=>{
      const email = c.e && c.e.length ? c.e[0] : '';
      const meta = [c.t || c.r || 'Role not recorded', email, c.p].filter(Boolean).map(esc).join(' &middot; ');
      const bits = [];
      if(!email) bits.push('no email');
      if(c.pk === 'none') bits.push('no mobile');
      if(c.pk === 'check') bits.push('check number');
      const tag = bits.length ? '<span class="tag">'+bits.join(', ')+'</span>' : '';
      return '<label class="pick"><input type="checkbox" data-i="'+i+'">'+
        '<span><div class="nm">'+esc(c.n)+tag+'</div><div class="mt">'+meta+'</div></span></label>';
    }).join('');
  }
  go('contacts');
}
$('ctQ').addEventListener('input', ()=>{
  const q = $('ctQ').value.trim().toLowerCase();
  $('ctList').querySelectorAll('.pick').forEach(r=>{
    const box = r.querySelector('input');
    const txt = r.textContent.toLowerCase();
    r.style.display = (!q || txt.includes(q) || box.checked) ? 'flex' : 'none';
  });
});
$('openCall').addEventListener('click', async ()=>{
  const cs = pendingAcct.acc ? pendingAcct.acc.c : [];
  const chosen = [];
  $('ctList').querySelectorAll('input:checked').forEach(b=>{
    const c = cs[+b.dataset.i];
    if(c) chosen.push({name:c.n, role:c.t||c.r, email:(c.e&&c.e[0])||'', mobile:c.p, crm:true, cid:c.id});
  });
  const nn = $('ncName').value.trim();
  if(nn) chosen.push({name:nn, role:$('ncRole').value.trim(), email:$('ncEmail').value.trim(), mobile:$('ncMob').value.trim(), crm:false});
  if(!chosen.length){ $('ctErr').classList.add('show'); return; }

  const acc = pendingAcct.acc;
  const site = $('cSite').value.trim();
  const reuse = await offerExistingCall(pendingAcct.name, $('cDate').value, chosen, site);
  if(reuse){
    call = reuse;
    await saveCall();
    go('dash');
    toast('Continuing the call from ' + reuse.date);
    return;
  }
  call = {
    id: 'c'+Date.now(),
    date: ddmmyyyy($('cDate').value),
    type: $('cType').value,
    mgr: $('cMgr').value,
    customer: pendingAcct.name,
    manualAccount: pendingAcct.manual,
    zone: acc ? acc.z : '',
    suburb: acc ? acc.sub : '',
    focus: acc ? acc.foc : '',
    site: $('cSite').value.trim(),
    contacts: chosen,
    entries: [],
    loose: [],
    status: 'in progress',
    when: Date.parse($('cDate').value) || Date.now(),
    closed: false,
    updated: Date.now()
  };
  await saveCall();
  await bookUnplanned(call, acc);
  const noMob = chosen.filter(c=>!c.mobile).map(c=>c.name);
  const noEm = chosen.filter(c=>!c.email).map(c=>c.name);
  go('dash');
  if(noMob.length || noEm.length){
    let m = [];
    if(noEm.length) m.push('no email: '+noEm.join(', '));
    if(noMob.length) m.push('no mobile: '+noMob.join(', '));
    toast(m.join(' | '));
  }
});

/* ---------- dashboard ---------- */
function renderDash(){
  if(!call) return go('home');
  const c = call;
  $('dashStat').innerHTML =
    '<b>'+esc(c.customer)+'</b><br>'+esc(c.date)+' &middot; '+esc(c.type)+' &middot; '+esc(c.mgr)+
    (c.site?'<br>'+esc(c.site):'')+
    '<br>'+c.contacts.map(x=>esc(x.name)+(x.crm?'':' <span class="tag">not in CRM</span>')).join(', ');
  const n = t => c.entries.filter(e=>e.type===t).length;
  $('cntBelt').textContent = n('belt')+' logged';
  $('cntProj').textContent = n('project')+' logged';
  $('cntNote').textContent = n('note')+' logged';
  $('cntHealth').textContent = n('health')+' logged';

  renderLoose();

  const el = $('logList');
  if(!c.entries.length){ el.innerHTML = '<p class="empty">Nothing logged yet.</p>'; return; }
  el.innerHTML = c.entries.map((e,i)=>{
    let head='', body='';
    if(e.type==='belt'){ head='Belt - '+e.asset; body=[e.beltdesc,e.width?e.width+' mm':'',e.beltmat,e.rodmat,e.retrofit?'retrofit '+e.retrofit:'',e.sprocket].filter(Boolean).join(' &middot; '); }
    if(e.type==='project'){ head='Project - '+e.project; body=[e.status,e.next,e.target].filter(Boolean).join(' &middot; '); }
    if(e.type==='note'){ head='Note - '+e.topic; body=esc(e.text); }
    if(e.type==='health'){ head='Health - '+(e.asset||'unspecified'); body=[e.fault,e.severity].filter(Boolean).join(' &middot; '); }
    const ph = e.photos||[];
    const th = ph.map((p,j)=>'<img src="'+photoSrc(p)+'" data-rm="'+i+':'+j+'">').join('');
    const gone = e.detached
      ? '<p class="meta"><span class="tag">'+e.detached.n+' photo'+(e.detached.n===1?'':'s')+
        ' sent '+new Date(e.detached.at).toLocaleDateString()+', dropped from this phone</span></p>' : '';
    return '<div class="card"><div class="hd"><span class="t">'+esc(head)+'</span>'+
      '<button class="x" data-del="'+i+'">Remove</button></div>'+
      '<p class="meta">'+body+'</p>'+ gone +
      (th?'<div class="thumbs">'+th+'</div>':'')+
      '<div class="cardbar"><button data-cam="'+i+'">Camera</button>'+
      '<button data-gal="'+i+'">Photos</button>'+
      '<span class="phc">'+(ph.length? ph.length+' photo'+(ph.length===1?'':'s') : 'no photos')+'</span></div></div>';
  }).join('');
  el.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Remove this entry and its photos?')) return;
    (call.entries[+b.dataset.del].photos||[]).forEach(releasePhoto);
    call.entries.splice(+b.dataset.del,1); await saveCall(); renderDash();
  }));
  el.querySelectorAll('[data-cam]').forEach(b=>b.addEventListener('click', ()=>{
    photoTarget = +b.dataset.cam; $('camInput').value=''; $('camInput').click();
  }));
  el.querySelectorAll('[data-gal]').forEach(b=>b.addEventListener('click', ()=>{
    photoTarget = +b.dataset.gal; $('galInput').value=''; $('galInput').click();
  }));
  el.querySelectorAll('[data-rm]').forEach(img=>img.addEventListener('click', async ()=>{
    const p = img.dataset.rm.split(':').map(Number);
    if(!confirm('Remove this photo?')) return;
    releasePhoto(call.entries[p[0]].photos[p[1]]);
    call.entries[p[0]].photos.splice(p[1],1); await saveCall(); renderDash();
  }));
}
function renderLoose(){
  const el = $('looseWrap');
  if(!el || !call) return;
  const ph = call.loose || [];
  const th = ph.map((p,j)=>'<img src="'+photoSrc(p)+'" data-lrm="'+j+'">').join('');
  const gone = call.looseDetached
    ? '<p class="meta"><span class="tag">'+call.looseDetached.n+' photo'+(call.looseDetached.n===1?'':'s')+
      ' sent '+new Date(call.looseDetached.at).toLocaleDateString()+', dropped from this phone</span></p>' : '';
  el.innerHTML = '<div class="card"><div class="hd"><span class="t">Not tied to an entry</span></div>'+
    '<p class="meta">These come out at the end of the notes, after the health check.</p>'+ gone +
    (th?'<div class="thumbs">'+th+'</div>':'')+
    '<div class="cardbar"><button id="looseCam">Camera</button>'+
    '<button id="looseGal">Photos</button>'+
    '<span class="phc">'+(ph.length? ph.length+' photo'+(ph.length===1?'':'s') : 'no photos')+'</span></div></div>';
  $('looseCam').addEventListener('click', ()=>{ photoTarget='loose'; $('camInput').value=''; $('camInput').click(); });
  $('looseGal').addEventListener('click', ()=>{ photoTarget='loose'; $('galInput').value=''; $('galInput').click(); });
  el.querySelectorAll('[data-lrm]').forEach(img=>img.addEventListener('click', async ()=>{
    if(!confirm('Remove this photo?')) return;
    releasePhoto(call.loose[+img.dataset.lrm]);
    call.loose.splice(+img.dataset.lrm,1); await saveCall(); renderLoose();
  }));
}
$('closeCall').addEventListener('click', async ()=>{
  if(!confirm('Close this call? It stays saved but will not show under Resume.')) return;
  call.closed = true;
  if(call.status === 'in progress') call.status = 'done';
  if(!call.entries.length) call.noReport = true;
  await saveCall();
  await syncApptFromCall(call);
  releaseAllPhotos(); call = null; go('home');
});
$('toCompile').addEventListener('click', ()=>go('compile'));
$('barMenu').addEventListener('click', ()=>go('dash'));

/* ================= entry: belt =================
   Ported from Belt Call Log v13. The fork was taken from a v8 snapshot in the
   project library, which predates the whole belt reference database and the
   form that reads it - five versions of work that never came across.

   renderChips is the planner's focus-chip renderer in this app, so the belt
   version is renderBeltChips here. Nothing else needed renaming. */

/* ---------- what you reach for most ----------
   The workbook lists everything alphabetically and carries no notion of what is common,
   so the ordering has to come from here. Every saved belt bumps a counter for each value
   picked, held against the context it was picked in: style counts sit under the series,
   material counts under series|style, and so on. Ranking then reads the specific context
   first and falls back to how often the value has been used anywhere, so a material you
   reach for constantly still floats in a series you have not logged before.
   Counts live on this phone only, alongside everything else. */
let USE = null;
const CTX_ALL = '*';

async function loadUse(){
  USE = (await kvGet('usage')) || {};
  return USE;
}
function bump(field, ctx, value){
  if(!value) return;
  USE = USE || {};
  const f = USE[field] = USE[field] || {};
  [ctx || '', CTX_ALL].forEach(k => {
    const c = f[k] = f[k] || {};
    c[value] = (c[value] || 0) + 1;
  });
}
function counts(field, ctx){
  return (USE && USE[field] && USE[field][ctx || '']) || {};
}
/* Most used first, then everything else in the workbook's alphabetical order. */
function rank(values, field, ctx){
  const here = counts(field, ctx), any = counts(field, CTX_ALL);
  const base = uniqSort(values);
  const scored = base.map((v, i) => ({v, i, n:here[v] || 0, g:any[v] || 0}));
  scored.sort((a, b) => (b.n - a.n) || (b.g - a.g) || (a.i - b.i));
  const top = scored.filter(x => x.n > 0 || x.g > 0).map(x => x.v);
  const rest = scored.filter(x => !(x.n > 0 || x.g > 0)).map(x => x.v);
  return {all: top.concat(rest), top, rest};
}
async function saveUse(){ try { await kvSet('usage', USE); } catch(e){ console.warn('usage', e); } }

/* ---------- chip groups ----------
   Same control as the rod material chips, but rebuilt whenever the cascade above them
   changes, since the valid materials and colours depend on the series and style. */
const chipSel = {};
function renderBeltChips(id, values, o){
  const el = $(id);
  if(!el) return;
  o = o || {};
  const cur = chipSel[id] || '';
  if(!values.length){
    el.innerHTML = '<span class="none">'+esc(o.empty || 'Nothing to choose yet')+'</span>';
    if(o.other) $(o.other).classList.add('hide');
    return;
  }
  const r = rank(values, o.field, o.ctx);
  el.innerHTML = r.all.map(v =>
      '<button type="button" data-v="'+esc(v)+'"'+(r.top.includes(v) ? ' class="top"' : '')+'>'+esc(v)+'</button>').join('') +
    (o.other ? '<button type="button" data-v="OTHER">Other...</button>' : '');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const was = b.classList.contains('on');
    el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    chipSel[id] = '';
    if(!was){ b.classList.add('on'); chipSel[id] = b.dataset.v; }
    if(o.other) $(o.other).classList.toggle('hide', chipSel[id] !== 'OTHER');
    if(o.onPick) o.onPick();
  }));
  /* keep the current pick if it survived the rebuild, so changing style does not
     silently drop a material that is still valid */
  if(cur && (r.all.includes(cur) || cur === 'OTHER')) setChip(id, cur, o.other);
  else { chipSel[id] = ''; if(o.other) $(o.other).classList.add('hide'); }
}
function chipValue(id, otherId){
  const v = chipSel[id] || '';
  return (v === 'OTHER' && otherId) ? $(otherId).value.trim() : v;
}
function setChip(id, v, otherId){
  const el = $(id);
  el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
  chipSel[id] = '';
  if(!v) { if(otherId) $(otherId).classList.add('hide'); return true; }
  const hit = [...el.querySelectorAll('button')].find(x => x.dataset.v === v);
  if(hit){ hit.classList.add('on'); chipSel[id] = v; if(otherId) $(otherId).classList.add('hide'); return true; }
  const other = [...el.querySelectorAll('button')].find(x => x.dataset.v === 'OTHER');
  if(other && otherId){
    other.classList.add('on'); chipSel[id] = 'OTHER';
    $(otherId).classList.remove('hide'); $(otherId).value = v;
    return true;
  }
  return false;
}
function clearChip(id, otherId){ setChip(id, '', otherId); if(otherId) $(otherId).value = ''; }

/* ---------- entry: belt ----------
   Mirrors the plant audit line entry form: the same Series > Style > Material > Colour
   cascade, the same width and frame checks off the link geometry, the same sprocket
   cascade and quantity rule, and the same flight spacing conversion. Everything is driven
   by the imported workbook, so with no reference data loaded the pickers sit empty and the
   free-text fields still carry the call. Health check stays its own entry type. */

const DEFAULT_BORE = '40 mm square';
const FALLBACK_ROD = ['ACETAL','POLYPROPYLENE','POLYETHYLENE','PK','NYLON'];

function populateSel(el, values, placeholder, withOther, field, ctx){
  if(!el) return;
  const opt = v => '<option value="'+esc(v)+'">'+esc(v)+'</option>';
  const tail = withOther ? '<option value="OTHER">Other...</option>' : '';
  const head = '<option value="">'+esc(placeholder)+'</option>';
  const list = field ? rank(values, field, ctx).all : uniqSort(values);
  el.innerHTML = head + list.map(opt).join('') + tail;
}
function keepValue(el, prev){
  if(prev && [...el.options].some(o => o.value === prev)) el.value = prev;
}
function showMsg(el, cls, html){
  el.className = html ? 'msg '+cls+' show' : 'msg';
  el.innerHTML = html || '';
}
function otherPair(sel, other){
  const sync = () => other.classList.toggle('hide', sel.value !== 'OTHER');
  sel.addEventListener('change', sync);
  return () => sel.value === 'OTHER' ? other.value.trim() : sel.value;
}

/* ---------- populate everything the workbook drives ---------- */
function buildBeltRef(){
  const warn = $('refWarn');
  if(!REF){
    showMsg(warn, 'info', 'No belt reference data loaded, so the pickers below are empty. ' +
      'The description and measurement fields still work. ' +
      '<span class="lnk" data-go="data">Import the workbook</span>');
  } else {
    showMsg(warn, '', '');
  }
  const R = REF || {combos:[], geom:[], sprockets:[], pitch:{}, indentGroups:[],
                    materials:[], colours:[], rods:[], flightTypes:[], sideguardTypes:[]};

  populateSel($('bSeries'), R.combos.map(c=>c[0]),
    R.combos.length ? 'Select series...' : 'Import reference data', false, 'series', '');

  const mats = R.materials.length ? R.materials : uniqSort(R.combos.map(c=>c[2]));
  populateSel($('bFlMat'), mats, 'Select flight material...', false, 'flmat', '');
  populateSel($('bSgMat'), mats, 'Select sideguard material...', false, 'sgmat', '');
  populateSel($('bFlType'), R.flightTypes, 'Select flight type...', true, 'fltype', '');
  populateSel($('bSgType'), R.sideguardTypes, 'Select sideguard type...', true, 'sgtype', '');

  renderBeltChips('bRodChips', R.rods.length ? R.rods : FALLBACK_ROD,
    {field:'rod', ctx:'', other:'bRodOther', empty:'Import reference data'});

  renderMatChips();
  populateSprBores();
  populateIndent();
  updatePitch();
}
const rodValue = () => chipValue('bRodChips', 'bRodOther');
const beltMat = () => chipValue('bMatChips', 'bMatOther');
const beltColour = () => chipValue('bColourChips', 'bColourOther');

/* Material depends on series and style, colour on all three, so both are rebuilt
   every time something above them moves. */
function renderMatChips(){
  const s = serSel().value, st = stySel().value;
  const vals = (s && st) ? combos().filter(c=>c[0]===s && c[1]===st).map(c=>c[2]) : [];
  renderBeltChips('bMatChips', vals, {
    field:'material', ctx:s+'|'+st, other:'bMatOther',
    empty: st ? 'No materials on file' : 'Pick a series and style first',
    onPick: onMaterial
  });
  renderColourChips();
}
function renderColourChips(){
  const s = serSel().value, st = stySel().value, m = beltMat();
  const vals = (s && st && m) ? combos().filter(c=>c[0]===s && c[1]===st && c[2]===m).map(c=>c[3]) : [];
  renderBeltChips('bColourChips', vals, {
    field:'colour', ctx:s+'|'+st+'|'+m, other:'bColourOther',
    empty: m ? 'No colours on file' : 'Pick a material first',
    onPick: runWidthCheck
  });
}

/* ---------- Series > Style > Material > Colour ---------- */
const serSel = () => $('bSeries'), stySel = () => $('bStyle');
const combos = () => (REF ? REF.combos : []);

function onSeries(){
  const s = serSel().value;
  populateSel(stySel(), combos().filter(c=>c[0]===s).map(c=>c[1]),
    s ? 'Select style...' : 'Select series first', false, 'style', s);
  stySel().disabled = !s;
  renderMatChips();
  runWidthCheck();
  populateSprBores();
  const p = pitchMm(), rows = parseFloat($('bFlRows').value);
  if(p && rows > 0) $('bFlMm').value = round1(rows * p);
  updatePitch();
}
function onStyle(){
  renderMatChips();
  runWidthCheck();
  populateIndent();
}
function onMaterial(){
  renderColourChips();
  runWidthCheck();
  syncFlightMaterial();
}
function setCascade(s, st, m, c){
  serSel().value = s || ''; onSeries();
  stySel().value = st || ''; onStyle();
  setChip('bMatChips', m || '', 'bMatOther'); renderColourChips();
  setChip('bColourChips', c || '', 'bColourOther');
  syncFlightMaterial();
  runWidthCheck();
}

/* ---------- belt width against buildable increments ----------
   The same arithmetic the workbook does in its EU..FC columns: from the link width,
   protrusion, increment and minimum link count for this spec, work out the widths that
   can actually be built and flag anything landing between them. */
function runWidthCheck(){
  const el = $('bWidthMsg');
  const s = serSel().value, st = stySel().value, m = beltMat();
  const w = parseFloat($('bWidth').value);
  showMsg(el, '', '');
  if(!REF || !s || !st || !m || isNaN(w) || w <= 0) return;
  const g = REF.geom.find(x => x[0]===s && x[1]===st && x[2]===m);
  if(!g) return;
  const linkW = g[3], inc = g[4] || 1, minL = g[5] || 0, prot = g[6] || 0;
  if(!linkW) return;
  const working = w - 2*prot;
  const above = (working - minL*linkW) / linkW;
  const lower = (minL + Math.floor(above/inc)*inc) * linkW + 2*prot;
  const upper = (minL + Math.ceil(above/inc)*inc) * linkW + 2*prot;
  if(Math.abs(w-lower) < 0.5 || Math.abs(w-upper) < 0.5){
    showMsg(el, 'ok', w+' mm is a standard built width for this spec.');
  } else if(Math.abs(lower-upper) < 0.5){
    showMsg(el, 'warn', w+' mm is not a standard increment. Nearest built width is <b>'+Math.round(lower)+' mm</b>.');
  } else {
    showMsg(el, 'warn', w+' mm is not a standard increment. Nearest built widths are <b>'+
      Math.round(lower)+' mm</b> or <b>'+Math.round(upper)+' mm</b>.');
  }
}
/* The belt has to sit inside the frame, so equal or narrower means a figure is wrong. */
function runFrameCheck(){
  const el = $('bFrameMsg'), fe = $('bFrame'), be = $('bWidth');
  const f = parseFloat(fe.value), b = parseFloat(be.value);
  showMsg(el, '', '');
  fe.classList.remove('alert'); be.classList.remove('alert');
  if(isNaN(f) || isNaN(b) || f <= 0 || b <= 0) return;
  if(f < b){
    showMsg(el, 'warn', 'Inside frame ('+f+' mm) is narrower than the belt ('+b+' mm). Check both measurements.');
    fe.classList.add('alert'); be.classList.add('alert');
  } else if(f === b){
    showMsg(el, 'warn', 'Frame and belt are both '+b+' mm, so there is no clearance. Check both measurements.');
    fe.classList.add('alert'); be.classList.add('alert');
  }
}

/* ---------- sprockets: Bore > PD/teeth > Material > variant ---------- */
const sprPool = () => {
  if(!REF) return [];
  const s = serSel().value;
  return s ? REF.sprockets.filter(x => x[0] === s) : REF.sprockets;
};
function populateSprBores(){
  const el = $('bSprBore'), prev = el.value;
  const bores = uniqSort(sprPool().map(x => x[1]));
  populateSel(el, bores, bores.length ? 'Select bore...' : 'No sprockets for this series',
    false, 'sprbore', serSel().value);
  if(bores.includes(prev)) el.value = prev;
  else if(bores.includes(DEFAULT_BORE)) el.value = DEFAULT_BORE;
  onSprBore(false);
}
function onSprBore(reset){
  const b = $('bSprBore').value;
  const pds = uniqSort(sprPool().filter(x => x[1]===b).map(x => x[2]));
  populateSel($('bSprPd'), pds, pds.length ? 'Select pitch diameter...' : 'No data for this bore',
    false, 'sprpd', serSel().value+'|'+b);
  $('bSprPd').disabled = !b;
  if(reset !== false){ populateSel($('bSprMat'), [], 'Select pitch diameter first'); $('bSprMat').disabled = true; }
  matchSprocket();
}
function onSprPd(){
  const b = $('bSprBore').value, p = $('bSprPd').value;
  const ms = uniqSort(sprPool().filter(x => x[1]===b && x[2]===p).map(x => x[3]));
  populateSel($('bSprMat'), ms, ms.length ? 'Select material...' : 'No data for this pitch',
    false, 'sprmat', serSel().value+'|'+b+'|'+p);
  $('bSprMat').disabled = !p;
  onSprMat();
}
/* The variant picker only appears where a spec genuinely has more than one build on
   file - EZ Clean, Split Metal, Double Wide Rim and so on. */
function onSprMat(){
  const b = $('bSprBore').value, p = $('bSprPd').value, m = $('bSprMat').value;
  const vs = uniqSort(sprPool().filter(x => x[1]===b && x[2]===p && x[3]===m).map(x => x[4]));
  const wrap = $('bSprVarWrap'), sel = $('bSprVar');
  if(vs.length > 1){
    populateSel(sel, vs, 'Select build type...');
    wrap.classList.remove('hide');
  } else {
    wrap.classList.add('hide');
    sel.innerHTML = vs.length ? '<option value="'+esc(vs[0])+'" selected>'+esc(vs[0])+'</option>' : '';
  }
  matchSprocket();
}
function sprVariant(){
  const sel = $('bSprVar');
  if(!$('bSprVarWrap').classList.contains('hide')) return sel.value;
  return sel.options.length ? sel.options[0].value : '';
}
let sprDescTouched = false, sprPnTouched = false, sprDriveTouched = false, sprIdleTouched = false;
function matchSprocket(){
  const b = $('bSprBore').value, p = $('bSprPd').value, m = $('bSprMat').value;
  if(!b || !p || !m) return;
  const pool = sprPool().filter(x => x[1]===b && x[2]===p && x[3]===m);
  const v = sprVariant();
  const hit = (v ? pool.find(x => x[4]===v) : null) || pool[0];
  if(!hit) return;
  if(!sprDescTouched) $('bSprDesc').value = hit[4] || '';
  if(!sprPnTouched && hit[5]) $('bSprPn').value = hit[5];
}
/* Drive and idle quantity follow the workbook's own =ODD(width/152) rule,
   152 mm being the maximum sprocket centre spacing. */
function oddUp(n){ let v = Math.ceil(n); if(v % 2 === 0) v += 1; return Math.max(v, 1); }
function updateSprQty(){
  const w = parseFloat($('bWidth').value);
  if(isNaN(w) || w <= 0) return;
  const q = oddUp(w / 152);
  if(!sprDriveTouched) $('bSprDrive').value = q;
  if(!sprIdleTouched) $('bSprIdle').value = q;
}

/* ---------- flights, spacing and indent ---------- */
let flMatTouched = false;
function syncFlightMaterial(){
  if(flMatTouched) return;
  const m = beltMat();
  if(!m) return;
  const sel = $('bFlMat');
  if(![...sel.options].some(o => o.value === m)){
    const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o);
  }
  sel.value = m;
}
const round1 = n => Math.round(n*10)/10;
const pitchMm = () => {
  const s = serSel().value;
  return (REF && s && REF.pitch[s]) ? REF.pitch[s] : null;
};
function fmtIn(mm){
  const i = mm/25.4;
  return (Math.abs(i - Math.round(i)) < 0.01 ? Math.round(i) : i.toFixed(2)) + '"';
}
function updatePitch(){
  const el = $('bPitchMsg'), p = pitchMm(), s = serSel().value;
  if(!p){
    $('bFlRows').disabled = !!s;
    showMsg(el, 'info', s ? 'No pitch on file for Series '+esc(s)+'. Enter spacing in millimetres.' : '');
    return;
  }
  $('bFlRows').disabled = false;
  let m = 'Series '+esc(s)+' runs a <b>'+p+' mm ('+fmtIn(p)+') pitch</b>.';
  const rows = parseFloat($('bFlRows').value), mm = parseFloat($('bFlMm').value);
  if(rows > 0){
    m += ' '+rows+' row'+(rows===1?'':'s')+' = <b>'+round1(rows*p)+' mm</b> ('+fmtIn(rows*p)+').';
  } else if(mm > 0){
    const r = mm/p;
    m += Math.abs(r - Math.round(r)) < 0.02
      ? ' '+round1(mm)+' mm = <b>'+Math.round(r)+' rows</b>.'
      : ' '+round1(mm)+' mm = <b>'+r.toFixed(2)+' rows</b>, which is not a whole number of rows.';
  }
  showMsg(el, 'info', m);
}
/* Indent values are grouped by surface in the workbook, so the belt style decides which
   group applies. Flights carry their own values, added once a flight type is set. */
let indentAll = false;
function surfaceGroups(style){
  const s = (style || '').toUpperCase(), g = [];
  if(!s) return g;
  if(/FRICT(ION)?\s*TOP|OHFT|^FT[\s\/]|NON-SKID|MINI-RIB|RAISED RIB/.test(s)) g.push('Friction Top');
  if(/ROLLER/.test(s)) g.push('Roller Top');
  if(/NUB|CONE|DIAMOND|MESH|BALL/.test(s)) g.push('Nub / Cone etc');
  return g;
}
function populateIndent(){
  const sel = $('bIndent'), note = $('bIndentMsg'), prev = sel.value;
  const groups = (REF && REF.indentGroups.length) ? REF.indentGroups : [];
  if(!groups.length){
    populateSel(sel, [], 'Import reference data', true);
    showMsg(note, '', '');
    return;
  }
  const active = indentAll ? groups.map(g=>g[0]) : surfaceGroups(stySel().value);
  if(!indentAll && flightType()) active.push('Flights');
  const shown = groups.filter(([l]) => active.includes(l));

  if(!indentAll && !shown.length){
    /* Flat and open surfaces carry no indent of their own until flights are fitted,
       so offer Zero rather than every value from every unrelated group. */
    sel.innerHTML = '<option value="">Select indent...</option><option value="Zero">Zero</option>' +
      '<option value="OTHER">Other...</option>';
    keepValue(sel, prev);
    $('bIndentOther').classList.toggle('hide', sel.value !== 'OTHER');
    showMsg(note, 'info', (stySel().value
      ? '<b>'+esc(stySel().value)+'</b> has no surface indent, so normally <b>Zero</b> unless flights are fitted.'
      : 'Pick a style to narrow these down.') + ' <span class="lnk" id="indentAllLnk">show all values</span>');
    wireIndentToggle();
    return;
  }
  const use = shown.length ? shown : groups;
  const opt = v => '<option value="'+esc(v)+'">'+esc(v)+'</option>';
  const ctx = serSel().value+'|'+stySel().value;
  sel.innerHTML = '<option value="">Select indent...</option>' +
    use.map(([l, vals]) => '<optgroup label="'+esc(l)+'">' +
      rank(vals, 'indent', ctx).all.map(opt).join('') + '</optgroup>').join('') +
    '<option value="OTHER">Other...</option>';
  keepValue(sel, prev);
  $('bIndentOther').classList.toggle('hide', sel.value !== 'OTHER');
  const n = use.reduce((a,g)=>a+g[1].length, 0);
  showMsg(note, 'info', indentAll
    ? 'Showing all <b>'+n+'</b> indent values. <span class="lnk" id="indentAllLnk">filter to this belt</span>'
    : 'Filtered to <b>'+esc(use.map(g=>g[0]).join(' + '))+'</b> ('+n+' values) from the belt style. ' +
      '<span class="lnk" id="indentAllLnk">show all</span>');
  wireIndentToggle();
}
function wireIndentToggle(){
  const l = $('indentAllLnk');
  if(l) l.addEventListener('click', () => { indentAll = !indentAll; populateIndent(); });
}

/* ---------- value readers ---------- */
let flightType, sgType, indentValue;

/* ---------- wiring ---------- */
serSel().addEventListener('change', onSeries);
stySel().addEventListener('change', onStyle);
$('bWidth').addEventListener('input', () => { runWidthCheck(); runFrameCheck(); updateSprQty(); });
$('bFrame').addEventListener('input', runFrameCheck);
$('bSprBore').addEventListener('change', () => onSprBore());
$('bSprPd').addEventListener('change', onSprPd);
$('bSprMat').addEventListener('change', onSprMat);
$('bSprVar').addEventListener('change', matchSprocket);
$('bSprDesc').addEventListener('input', () => { sprDescTouched = true; $('bSprDescAuto').classList.add('off'); });
$('bSprPn').addEventListener('input', () => { sprPnTouched = true; $('bSprPnAuto').classList.add('off'); });
$('bSprDrive').addEventListener('input', () => { sprDriveTouched = true; $('bSprDrvAuto').classList.add('off'); });
$('bSprIdle').addEventListener('input', () => { sprIdleTouched = true; $('bSprIdlAuto').classList.add('off'); });
$('bFlMat').addEventListener('change', () => { flMatTouched = true; $('bFlMatAuto').classList.add('off'); });

flightType = otherPair($('bFlType'), $('bFlTypeOther'));
sgType     = otherPair($('bSgType'), $('bSgTypeOther'));
indentValue = otherPair($('bIndent'), $('bIndentOther'));
$('bFlType').addEventListener('change', populateIndent);

let lenTouched = false;
$('bLen').addEventListener('input', () => { lenTouched = true; $('bLenAuto').classList.add('off'); });
$('bCvLen').addEventListener('input', () => {
  if(lenTouched) return;
  const v = parseFloat($('bCvLen').value);
  if(!isNaN(v)) $('bLen').value = (v*2.05 + 0.5).toFixed(2);
});

let spacingSync = false;
$('bFlRows').addEventListener('input', () => {
  if(spacingSync) return;
  const p = pitchMm(), rows = parseFloat($('bFlRows').value);
  spacingSync = true;
  if(p && rows > 0) $('bFlMm').value = round1(rows*p);
  else if($('bFlRows').value === '') $('bFlMm').value = '';
  spacingSync = false;
  updatePitch();
});
$('bFlMm').addEventListener('input', () => {
  if(spacingSync) return;
  const p = pitchMm(), mm = parseFloat($('bFlMm').value);
  spacingSync = true;
  if(p && mm > 0){
    const r = mm/p;
    $('bFlRows').value = Math.abs(r - Math.round(r)) < 0.02 ? Math.round(r) : '';
  } else if($('bFlMm').value === '') $('bFlRows').value = '';
  spacingSync = false;
  updatePitch();
});

function toggleSkip(box, bodyId){
  $(bodyId).classList.toggle('hide', box.checked);
}
const HD_RETAINER_QTY = 8;
const SPACER_NOTE = 'Yes - see TSG for specification';
function updateSprExtras(){
  const bits = [];
  if($('bSprSpacers').checked) bits.push('Spacers will be recorded as "'+SPACER_NOTE+'".');
  if($('bSprHdRet').checked) bits.push('Heavy duty retainers will be recorded with a quantity of '+HD_RETAINER_QTY+'.');
  $('bSprExtraNote').innerHTML = bits.join(' ');
}
$('bSprSpacers').addEventListener('change', updateSprExtras);
$('bSprHdRet').addEventListener('change', updateSprExtras);
$('bSkipSpr').addEventListener('change', e => toggleSkip(e.target, 'bSprBody'));
$('bSkipAcc').addEventListener('change', e => toggleSkip(e.target, 'bAccBody'));

let bRetroVal = '';
document.querySelectorAll('#bRetro button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#bRetro button').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); bRetroVal = b.dataset.v;
}));

/* ---------- copy the spec off a belt already on this call ---------- */
function refreshBeltCopy(){
  const sel = $('bCopy');
  const belts = call ? call.entries.filter(e => e.type === 'belt') : [];
  $('bCopyWrap').classList.toggle('hide', !belts.length);
  sel.innerHTML = '<option value="">Start from blank</option>' +
    belts.map((b, i) => '<option value="'+i+'">'+esc(b.asset || ('Belt '+(i+1)))+
      (b.beltdesc ? ' - '+esc(b.beltdesc) : '')+'</option>').join('');
}
$('bCopy').addEventListener('change', () => {
  const belts = call.entries.filter(e => e.type === 'belt');
  const b = belts[+$('bCopy').value];
  if(!b) return;
  $('bDesc').value = b.beltdesc || '';
  setCascade(b.series, b.style, b.beltmat, b.colour);
  setChip('bRodChips', b.rodmat || '', 'bRodOther');
  $('bFrame').value = b.frame || '';
  $('bWidth').value = b.width || '';
  if(b.sprbore){
    $('bSprBore').value = b.sprbore; onSprBore(false);
    $('bSprPd').value = b.sprpd || ''; onSprPd();
    $('bSprMat').value = b.sprmat || ''; onSprMat();
  }
  runWidthCheck(); runFrameCheck(); updateSprQty();
  toast('Copied the spec from '+(b.asset || 'that belt'));
});

/* ---------- reset and save ---------- */
function resetBelt(){
  ['bAsset','bDesc','bCvLen','bFrame','bWidth','bLen','bSprDesc','bSprPn','bSprDrive','bSprIdle',
   'bFlHeight','bFlRows','bFlMm','bNotch','bSgHeight','bQc','bRodOther','bFlTypeOther',
   'bSgTypeOther','bIndentOther'].forEach(i => { if($(i)) $(i).value = ''; });
  ['bRodOther','bMatOther','bColourOther','bFlTypeOther','bSgTypeOther','bIndentOther']
    .forEach(i => { $(i).value = ''; $(i).classList.add('hide'); });
  clearChip('bRodChips', 'bRodOther');
  clearChip('bMatChips', 'bMatOther');
  clearChip('bColourChips', 'bColourOther');
  bRetroVal = ''; document.querySelectorAll('#bRetro button').forEach(x => x.classList.remove('on'));
  sprDescTouched = sprPnTouched = sprDriveTouched = sprIdleTouched = false;
  flMatTouched = lenTouched = false; indentAll = false;
  ['bSprDescAuto','bSprPnAuto','bSprDrvAuto','bSprIdlAuto','bFlMatAuto','bLenAuto']
    .forEach(i => $(i).classList.remove('off'));
  $('bSkipSpr').checked = false; $('bSprBody').classList.remove('hide');
  $('bSprSpacers').checked = false; $('bSprHdRet').checked = false; updateSprExtras();
  $('bSkipAcc').checked = true;  $('bAccBody').classList.add('hide');
  $('bFlType').value = ''; $('bFlMat').value = ''; $('bSgType').value = ''; $('bSgMat').value = '';
  $('bErr').classList.remove('show');
  $('bFrame').classList.remove('alert'); $('bWidth').classList.remove('alert');
  showMsg($('bWidthMsg'), '', ''); showMsg($('bFrameMsg'), '', '');
  setCascade('', '', '', '');
  populateSprBores(); populateIndent(); updatePitch();
  refreshBeltCopy();
}

$('bSave').addEventListener('click', async () => {
  const a = $('bAsset').value.trim();
  if(!a){ $('bErr').classList.add('show'); $('bAsset').focus(); return; }
  const skipSpr = $('bSkipSpr').checked, skipAcc = $('bSkipAcc').checked;
  const v = id => $(id).value.trim();

  const e = {
    type:'belt', asset:a, beltdesc:v('bDesc'),
    series:serSel().value, style:stySel().value, beltmat:beltMat(), colour:beltColour(),
    rodmat:rodValue(),
    clength:v('bCvLen'), frame:v('bFrame'), width:v('bWidth'), beltlen:v('bLen'),
    retrofit:bRetroVal,
    sprocket: skipSpr ? '' : v('bSprDesc'),
    sprbore: skipSpr ? '' : $('bSprBore').value,
    sprpd:   skipSpr ? '' : $('bSprPd').value,
    sprmat:  skipSpr ? '' : $('bSprMat').value,
    sprvar:  skipSpr ? '' : sprVariant(),
    sprpn:   skipSpr ? '' : v('bSprPn'),
    sprdrive:skipSpr ? '' : v('bSprDrive'),
    spridle: skipSpr ? '' : v('bSprIdle'),
    sprspacers: !skipSpr && $('bSprSpacers').checked,
    sprhdret:   !skipSpr && $('bSprHdRet').checked,
    sprhdretqty:(!skipSpr && $('bSprHdRet').checked) ? String(HD_RETAINER_QTY) : '',
    flights: !skipAcc,
    fstyle:  skipAcc ? '' : flightType(),
    flmat:   skipAcc ? '' : $('bFlMat').value,
    fheight: skipAcc ? '' : v('bFlHeight'),
    frows:   skipAcc ? '' : v('bFlRows'),
    fspacing:skipAcc ? '' : v('bFlMm'),
    findent: skipAcc ? '' : indentValue(),
    cnotch:  skipAcc ? '' : v('bNotch'),
    sgtype:  skipAcc ? '' : sgType(),
    sgmat:   skipAcc ? '' : $('bSgMat').value,
    sgheight:skipAcc ? '' : v('bSgHeight'),
    qcontact:v('bQc'), photos:[]
  };
  call.entries.push(e);
  const ctxS = e.series, ctxT = e.series+'|'+e.style, ctxM = ctxT+'|'+e.beltmat;
  bump('series', '', e.series);
  bump('style', ctxS, e.style);
  bump('material', ctxT, e.beltmat);
  bump('colour', ctxM, e.colour);
  bump('rod', '', e.rodmat);
  if(!skipSpr){
    bump('sprbore', ctxS, e.sprbore);
    bump('sprpd', ctxS+'|'+e.sprbore, e.sprpd);
    bump('sprmat', ctxS+'|'+e.sprbore+'|'+e.sprpd, e.sprmat);
  }
  if(!skipAcc){
    bump('fltype', '', e.fstyle);   bump('flmat', '', e.flmat);
    bump('sgtype', '', e.sgtype);   bump('sgmat', '', e.sgmat);
    bump('indent', ctxT, e.findent);
  }
  await Promise.all([saveCall(), saveUse()]);
  toast('Belt '+a+' logged - add a photo if you want one');
  go('dash');
});

/* ---------- entry: project ---------- */
function resetProject(){ ['pName','pNext','pTarg','pOwner','pNotes'].forEach(i=>$(i).value=''); $('pStat').value='Being considered'; $('pErr').classList.remove('show'); }
$('pSave').addEventListener('click', async ()=>{
  const p = $('pName').value.trim();
  if(!p){ $('pErr').classList.add('show'); $('pName').focus(); return; }
  call.entries.push({type:'project', project:p, status:$('pStat').value, next:$('pNext').value.trim(),
    target:$('pTarg').value.trim(), owner:$('pOwner').value.trim(), notes:$('pNotes').value.trim(), photos:[]});
  await saveCall(); toast('Project logged'); go('dash');
});

/* ---------- entry: note ---------- */
$('nSave').addEventListener('click', async ()=>{
  const t = $('nText').value.trim();
  if(!t){ $('nErr').classList.add('show'); $('nText').focus(); return; }
  call.entries.push({type:'note', topic:$('nTopic').value, text:t, photos:[]});
  await saveCall(); toast('Note logged'); go('dash');
});

/* ---------- entry: health ---------- */
let hSevVal='';
function resetHealth(){ ['hAsset','hFault','hAction'].forEach(i=>$(i).value=''); hSevVal='';
  document.querySelectorAll('#hSev button').forEach(x=>x.classList.remove('on')); $('hErr').classList.remove('show'); }
document.querySelectorAll('#hSev button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#hSev button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); hSevVal=b.dataset.v;
}));
$('hSave').addEventListener('click', async ()=>{
  const f = $('hFault').value.trim();
  if(!f){ $('hErr').classList.add('show'); $('hFault').focus(); return; }
  call.entries.push({type:'health', asset:$('hAsset').value.trim(), fault:f, htype:$('hType').value,
    severity:hSevVal, action:$('hAction').value.trim(), photos:[]});
  await saveCall(); toast('Fault logged - add a photo if you want one'); go('dash');
});

/* ---------- photos ---------- */
/* Photos are stored as Blobs, not data URIs. Base64 inflates a JPEG by about a
   third and forces it to be held as a string; IndexedDB stores a Blob natively.
   Conversion to base64 happens once, inside the compile step, so the output file
   is unchanged. Roughly 25% of the largest thing in the database, saved.

   Calls written before this change hold data-URI strings. Both shapes are read
   everywhere, so an existing call keeps working and quietly converts nothing. */
const isBlobPhoto = p => (typeof Blob !== 'undefined') && (p instanceof Blob);
function photoBytes(p){
  if(isBlobPhoto(p)) return p.size;
  const s = String(p||''); const i = s.indexOf(',');
  return i < 0 ? s.length : Math.round((s.length - i - 1) * 0.75);
}
function callBytes(c){
  let n = 0;
  (c.entries||[]).forEach(e => (e.photos||[]).forEach(p => n += photoBytes(p)));
  (c.loose||[]).forEach(p => n += photoBytes(p));
  return n;
}
function humanSize(b){
  if(b < 1024) return b+' B';
  if(b < 1024*1024) return Math.round(b/1024)+' KB';
  return (b/1048576).toFixed(1)+' MB';
}
function blobToDataURL(b){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.onload = ()=>res(r.result);
    r.onerror = ()=>rej(r.error || new Error('could not read image'));
    r.readAsDataURL(b);
  });
}
function dataURLToBlob(u){
  const s = String(u), i = s.indexOf(',');
  if(i < 0) throw new Error('not a data URI');
  const mime = (s.slice(0,i).match(/data:([^;]+)/) || [,'image/jpeg'])[1];
  const bin = atob(s.slice(i+1));
  const arr = new Uint8Array(bin.length);
  for(let k=0;k<bin.length;k++) arr[k] = bin.charCodeAt(k);
  return new Blob([arr], {type:mime});
}
async function photoDataURL(p){ return isBlobPhoto(p) ? await blobToDataURL(p) : String(p); }

/* Object URLs for the thumbnails. Held in a map keyed on the Blob so a re-render
   reuses the same URL rather than leaking a new one every time the dashboard
   redraws, and released when the call is put down. */
const OBJ_URLS = new Map();
function photoSrc(p){
  if(!isBlobPhoto(p)) return String(p);
  let u = OBJ_URLS.get(p);
  if(!u){ u = URL.createObjectURL(p); OBJ_URLS.set(p, u); }
  return u;
}
function releasePhoto(p){
  const u = OBJ_URLS.get(p);
  if(u){ URL.revokeObjectURL(u); OBJ_URLS.delete(p); }
}
function releaseAllPhotos(){
  OBJ_URLS.forEach(u => URL.revokeObjectURL(u));
  OBJ_URLS.clear();
}

function barPhotoTap(input){
  if(!call){ toast('Open a call first'); return; }
  photoTarget = call.entries.length ? null : 'loose';
  input.value=''; input.click();
}
$('barCamera').addEventListener('click', ()=>barPhotoTap($('camInput')));
$('barGallery').addEventListener('click', ()=>barPhotoTap($('galInput')));

async function addPhotos(files){
  const target = photoTarget;
  photoTarget = null;
  if(!files.length) return;
  if(!call){ toast('Open a call first'); return; }

  let bucket, label;
  if(target === 'loose' || (target == null && !call.entries.length)){
    call.loose = call.loose || [];
    bucket = call.loose; label = 'loose photos';
  } else {
    const idx = (typeof target === 'number' && call.entries[target]) ? target : call.entries.length-1;
    const entry = call.entries[idx];
    entry.photos = entry.photos || [];
    bucket = entry.photos;
    label = entry.asset || entry.project || entry.topic || 'entry';
  }

  let ok = 0;
  for(const f of files){
    try { bucket.push(await shrink(f)); ok++; }
    catch(err){ console.error('skipped', f.name, err); }
  }
  await saveCall();
  const n = bucket.length;
  toast(ok===1 ? ('Photo '+n+' held against '+label)
               : (ok+' photos held against '+label+' ('+n+' total)'));
  if(screen==='dash') renderDash();
}
$('camInput').addEventListener('change', e => addPhotos([...e.target.files]));
$('galInput').addEventListener('change', e => addPhotos([...e.target.files]));
function shrink(file, max=1400, q=0.72){
  return new Promise((res,rej)=>{
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = ()=>{
      let {width:w, height:h} = img;
      if(w>max || h>max){ const s = Math.min(max/w, max/h); w = Math.round(w*s); h = Math.round(h*s); }
      const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      // toBlob rather than toDataURL: the result goes straight into IndexedDB
      if(cv.toBlob){
        cv.toBlob(b => b ? res(b) : rej(new Error('could not encode image')), 'image/jpeg', q);
      } else {
        try { res(dataURLToBlob(cv.toDataURL('image/jpeg', q))); }
        catch(e){ rej(e); }
      }
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); rej(new Error('bad image')); };
    img.src = url;
  });
}

/* ---------- compile ---------- */
const DASH_CH = '\u2014';
const V = v => { v = (v==null?'':String(v)).trim(); return (v===''||v==='N/A') ? DASH_CH : esc(v); };
// Blobs become base64 here and nowhere else, so the output file is byte-for-byte
// what it was when photos were stored as data URIs.
async function photoImgs(list){
  const out = [];
  for(const p of list) out.push('<img src="'+(await photoDataURL(p))+'">');
  return out.join('');
}

function renderCompileStat(){
  const n = t => call.entries.filter(e=>e.type===t).length;
  const ph = call.entries.reduce((a,e)=>a+(e.photos?e.photos.length:0),0) + (call.loose?call.loose.length:0);
  const bytes = callBytes(call);
  const sent = call.entries.reduce((a,e)=>a+(e.detached?e.detached.n:0),0) +
               (call.looseDetached ? call.looseDetached.n : 0);
  $('compStat').innerHTML = '<b>'+esc(call.customer)+'</b><br>'+
    n('belt')+' belts, '+n('project')+' projects, '+n('note')+' notes, '+n('health')+' health items<br>'+
    ph+' photo'+(ph===1?'':'s')+' to embed'+(ph?' ('+humanSize(bytes)+' held on this phone)':'')+
    (sent ? '<br><span class="tag">'+sent+' photo'+(sent===1?'':'s')+' already sent and dropped</span>' : '');
  renderDetach();
}
/* The offer to drop image data. Never automatic, never before a confirmed share -
   the photos exist in OneDrive at that point and the phone is holding a second
   copy of the largest thing in the database. A call goes from ~25 MB to ~20 KB. */
function renderDetach(){
  const el = $('detachWrap');
  if(!el) return;
  const bytes = callBytes(call);
  if(!call.shared || !bytes){ el.innerHTML = ''; return; }
  el.innerHTML = '<div class="card"><div class="hd"><span class="t">Photos still on this phone</span></div>'+
    '<p class="meta">These notes were shared '+new Date(call.shared).toLocaleString()+'. '+
    'The photos went with the file, and this phone is holding a second copy of '+humanSize(bytes)+'.</p>'+
    '<div class="cardbar"><button id="detachBtn">Drop the photos, keep the record</button></div></div>';
  $('detachBtn').addEventListener('click', detachPhotos);
}
async function detachPhotos(){
  const bytes = callBytes(call), when = Date.now();
  if(!confirm('Drop the image data from this call?\n\n'+humanSize(bytes)+' will be freed. The notes '+
     'file already sent keeps the photos. This cannot be undone, and the photos cannot be recovered '+
     'from this phone afterwards.')) return;
  call.entries.forEach(e => {
    const n = (e.photos||[]).length;
    if(!n) return;
    e.photos.forEach(releasePhoto);
    e.detached = {n: (e.detached ? e.detached.n : 0) + n, at: when, file: call.sharedAs || ''};
    e.photos = [];
  });
  const ln = (call.loose||[]).length;
  if(ln){
    call.loose.forEach(releasePhoto);
    call.looseDetached = {n: (call.looseDetached ? call.looseDetached.n : 0) + ln, at: when, file: call.sharedAs || ''};
    call.loose = [];
  }
  await saveCall();
  renderCompileStat();
  toast(humanSize(bytes)+' freed - the record and the photo count are kept');
}
async function buildNotesHTML(){
  const c = call;
  const css = 'body{font-family:Roboto,Arial,"Helvetica Neue",Helvetica,sans-serif;font-size:11pt;color:#222222;margin:0;padding:0 0 0 0}'+
    '.pg{padding:0 18px 18px}'+
    '.mast{background:#ED1C24;padding:13px 18px;margin:0 0 18px}'+
    '.mast img{height:26px;width:auto;display:block}'+
    'h1{font-size:17pt;margin:0 0 2px;color:#222222;letter-spacing:-.01em}'+
    'h2{font-size:13pt;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #E3F0F5;color:#4D4D4F}'+
    'h3{font-size:11.5pt;margin:16px 0 6px;color:#222222}.sub{color:#77787A;font-size:10pt;margin:0 0 14px}'+
    'table{border-collapse:collapse;width:100%;margin:0 0 10px;font-size:10pt}'+
    'th{background:#E3F0F5;text-align:left;padding:6px 8px;border:1px solid #ACD3E1;font-weight:bold;color:#222222}'+
    'td{padding:6px 8px;border:1px solid #CCCCCC;vertical-align:top}'+
    'td.l{background:#F7F8F8;width:38%;font-weight:bold}.flag{color:#B2232F;font-weight:bold}'+
    '.sent{font-size:9.5pt;color:#77787A;font-style:italic;margin:2px 0 12px}'+
    '.blk{page-break-inside:avoid}.ph{margin:6px 0 14px}.ph img{max-width:420px;border:1px solid #CCCCCC;margin:0 8px 8px 0}'+
    '.ft{background:#363738;color:#FFFFFF;font-size:8.5pt;letter-spacing:.02em;padding:7px 18px;margin:26px 0 0}';
  const LOGO = 'data:image/png;base64,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';
  const p = [];
  p.push('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Call notes '+esc(c.customer)+'</title><style>'+css+'</style></head><body>');
  p.push('<div class="mast"><img src="'+LOGO+'" alt="Intralox"></div><div class="pg">');
  p.push('<h1>Call notes '+DASH_CH+' '+esc(c.customer)+'</h1>');
  p.push('<p class="sub">'+[c.site,c.type,c.date].filter(Boolean).map(esc).join(' &middot; ')+'</p>');

  p.push('<h2>Call details</h2><table>');
  [['Date',c.date],['Call type',c.type],['Account manager',c.mgr],['Customer',c.customer],['Site or area',c.site]]
    .forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
  if(c.manualAccount) p.push('<tr><td class="l">Account status</td><td><span class="flag">Not in CRM &mdash; needs adding to Dynamics</span></td></tr>');
  p.push('</table>');

  p.push('<h2>Contacts</h2><table><tr><th>Name</th><th>Role</th><th>Email</th><th>Mobile</th><th>CRM</th></tr>');
  c.contacts.forEach(x=>p.push('<tr><td>'+V(x.name)+'</td><td>'+V(x.role)+'</td><td>'+V(x.email)+'</td><td>'+V(x.mobile)+
    '</td><td>'+(x.crm?'On file':'<span class="flag">Needs adding to Dynamics</span>')+'</td></tr>'));
  p.push('</table>');

  const notes = c.entries.filter(e=>e.type==='note');
  if(notes.length){
    p.push('<h2>General notes</h2><table><tr><th>Topic</th><th>Note</th></tr>');
    notes.forEach(n=>p.push('<tr><td>'+V(n.topic)+'</td><td>'+V(n.text)+'</td></tr>'));
    p.push('</table>');
  }

  const projects = c.entries.filter(e=>e.type==='project');
  if(projects.length){
    p.push('<h2>Project discovery</h2><table><tr><th>Project or site</th><th>Status</th><th>Next action</th><th>Target</th><th>Owner</th><th>Notes</th></tr>');
    projects.forEach(x=>p.push('<tr><td>'+V(x.project)+'</td><td>'+V(x.status)+'</td><td>'+V(x.next)+
      '</td><td>'+V(x.target)+'</td><td>'+V(x.owner)+'</td><td>'+V(x.notes)+'</td></tr>'));
    p.push('</table>');
  }

  const belts = c.entries.filter(e=>e.type==='belt');
  if(belts.length){
    p.push('<h2>Belts to quote</h2>');
    for(let i=0;i<belts.length;i++){
      const b = belts[i];
      p.push('<div class="blk"><h3>Belt '+(i+1)+' '+DASH_CH+' '+V(b.asset)+'</h3><table>');
      [['Belt description',b.beltdesc],['Belt width (mm)',b.width],['Belt material',b.beltmat],
       ['Rod material',b.rodmat],['Retrofit',b.retrofit],['Centre line length (m)',b.clength],
       ['Sprocket details',b.sprocket],['Flight spacing',b.fspacing],['Flight indent',b.findent],
       ['Centre notch',b.cnotch],['Flight height',b.fheight],['Flight style',b.fstyle]]
        .forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
      if(b.qcontact) p.push('<tr><td class="l">Quote contact</td><td>'+V(b.qcontact)+'</td></tr>');
      p.push('</table>');
      if(b.photos && b.photos.length) p.push('<div class="ph">'+(await photoImgs(b.photos))+'</div>');
      else if(b.detached) p.push('<p class="sent">'+b.detached.n+' photo'+(b.detached.n===1?'':'s')+
        ' were sent with the notes issued '+new Date(b.detached.at).toLocaleDateString()+
        ' and are no longer held on the device.</p>');
      p.push('</div>');
    }
  }

  const health = c.entries.filter(e=>e.type==='health');
  if(health.length){
    p.push('<h2>Health check</h2>');
    for(let i=0;i<health.length;i++){
      const h = health[i];
      p.push('<div class="blk"><h3>Item '+(i+1)+' '+DASH_CH+' '+V(h.asset)+'</h3><table>');
      [['Fault or observation',h.fault],['Type',h.htype],['Severity',h.severity],['Recommended action',h.action]]
        .forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
      p.push('</table>');
      if(h.photos && h.photos.length) p.push('<div class="ph">'+(await photoImgs(h.photos))+'</div>');
      else if(h.detached) p.push('<p class="sent">'+h.detached.n+' photo'+(h.detached.n===1?'':'s')+
        ' were sent with the notes issued '+new Date(h.detached.at).toLocaleDateString()+
        ' and are no longer held on the device.</p>');
      p.push('</div>');
    }
  }

  if(c.loose && c.loose.length){
    p.push('<h2>Additional photos</h2>');
    p.push('<div class="ph">'+(await photoImgs(c.loose))+'</div>');
  } else if(c.looseDetached){
    p.push('<h2>Additional photos</h2>');
    p.push('<p class="sent">'+c.looseDetached.n+' photo'+(c.looseDetached.n===1?'':'s')+
      ' were sent with the notes issued '+new Date(c.looseDetached.at).toLocaleDateString()+
      ' and are no longer held on the device.</p>');
  }

  p.push(historyBlock(c));

  p.push('</div><p class="ft">Compiled from site call notes. Final belt selection subject to Intralox review.</p></body></html>');
  return p.join('');
}

/* ---------- account history ----------
   What was found here last time, in the same file as what was found today. The
   whole point of storing visits rather than emailing them and forgetting.

   Two limits, both deliberate. Only the most recent HISTORY_MAX visits appear,
   with a line saying how many older ones exist - otherwise a monthly account
   turns every set of notes into a two-year archive nobody scrolls through. And
   each visit is one row, not a reproduction: asset numbers and headlines, no
   field tables and no photos. It is a pointer to the earlier notes file, not a
   substitute for it. */
const HISTORY_MAX = 6;
function histLine(c){
  const bits = [];
  const E = t => (c.entries||[]).filter(e => e.type === t);
  const belts = E('belt');
  if(belts.length) bits.push(belts.length+' belt'+(belts.length===1?'':'s')+': '+
    trimList(belts.map(e => e.asset || 'unnumbered')));
  const health = E('health');
  if(health.length) bits.push(health.length+' health item'+(health.length===1?'':'s')+': '+
    trimList(health.map(e => [e.asset, e.severity].filter(Boolean).join(' ') || e.htype || 'noted')));
  const proj = E('project');
  if(proj.length) bits.push(proj.length+' project'+(proj.length===1?'':'s')+': '+
    trimList(proj.map(e => e.project || 'unnamed')));
  const notes = E('note');
  if(notes.length) bits.push(notes.length+' note'+(notes.length===1?'':'s')+
    ' ('+trimList([...new Set(notes.map(e => e.topic || 'Other'))])+')');
  if(!bits.length) return c.noReport ? 'Visited, nothing to report' : 'No entries logged';
  return bits.join('; ');
}
function trimList(arr, max){
  max = max || 3;
  const shown = arr.slice(0, max).join(', ');
  return arr.length > max ? shown + ' +' + (arr.length - max) + ' more' : shown;
}
function histPhotos(c){
  const n = (c.entries||[]).reduce((t,e) => t + (e.photos||[]).length + (e.detached?e.detached.n:0), 0) +
    (c.loose||[]).length + (c.looseDetached ? c.looseDetached.n : 0);
  return n;
}
function historyBlock(c){
  const prior = callsFor(c.customer)
    .filter(x => x.id !== c.id && (x.closed || x.status === 'done' || x.status === 'compiled'))
    .sort((a,b) => callWhen(b) - callWhen(a));
  if(!prior.length) return '';
  const a = ACC_BY_NAME.get(c.customer);
  const shown = prior.slice(0, HISTORY_MAX);
  const p = [];
  p.push('<h2>Previous calls at this account</h2>');
  if(a){
    const d = dueState(a);
    p.push('<p class="sub">'+esc(a.cad)+' cadence \u00b7 '+esc(dueLabel(d))+'</p>');
  }
  p.push('<table><tr><th>Date</th><th>Outcome</th><th>Logged</th><th>Photos</th><th>Notes file</th></tr>');
  shown.forEach(x=>{
    const st = callStatus(x);
    const n = histPhotos(x);
    p.push('<tr><td>'+V(x.date)+'</td><td>'+V(st.label)+'</td><td>'+esc(histLine(x))+'</td>'+
      '<td>'+(n ? n : DASH_CH)+'</td><td>'+V(x.sharedAs)+'</td></tr>');
  });
  p.push('</table>');
  if(prior.length > shown.length){
    p.push('<p class="sub">'+(prior.length - shown.length)+' older call'+
      (prior.length - shown.length === 1 ? '' : 's')+' not shown. '+
      'Full notes for each were shared at the time.</p>');
  }
  return p.join('');
}
function fileName(){
  const cust = call.customer.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,40);
  const site = call.site ? '_'+call.site.replace(/[^A-Za-z0-9]+/g,'_') : '';
  return cust+site+'_call_notes_'+call.date.replace(/\//g,'-')+'.html';
}
$('doShare').addEventListener('click', async ()=>{
  toast('Building notes...');
  let html;
  try { html = await buildNotesHTML(); }
  catch(e){ console.error(e); toast('Could not build the notes: '+e.message); return; }
  const name = fileName();
  const file = new File([html], name, {type:'text/html'});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{
      await navigator.share({files:[file], title:'Call notes '+call.customer});
      // Only a share that came back without throwing counts as confirmed. An
      // AbortError means it was dismissed, and nothing left the phone.
      await markShared(name);
      toast('Shared');
    }catch(e){ if(e.name!=='AbortError') { console.error(e); toast('Share failed - try Download'); } }
  } else {
    toast('Sharing not supported here - downloading instead');
    download(html);
    await markShared(name);
  }
});
$('doDownload').addEventListener('click', async ()=>{
  toast('Building notes...');
  try {
    const html = await buildNotesHTML();
    download(html);
    await markShared(fileName());
  } catch(e){ console.error(e); toast('Could not build the notes: '+e.message); }
});
async function markShared(name){
  call.shared = Date.now();
  call.sharedAs = name;
  call.status = 'compiled';
  call.noReport = false;
  await saveCall();
  await syncApptFromCall(call);
  renderCompileStat();
}
/* The appointment follows the call it became. Status is not part of apRev, so
   doing the visit never makes Outlook think the invite changed. */
async function syncApptFromCall(c){
  if(!c || !c.apptId) return;
  const ap = APPTS.find(x => x.id === c.apptId);
  if(!ap) return;
  const next = (c.status === 'compiled' || c.status === 'done') ? 'done' : 'in progress';
  const sum = (next === 'done') ? callSummary(c) : null;
  const changed = ap.status !== next || sumRev(ap.callSummary) !== sumRev(sum);
  if(!changed) return;
  ap.status = next;
  if(sum) ap.callSummary = sum;
  await saveAppt(ap);
}
function download(html){
  const url = URL.createObjectURL(new Blob([html], {type:'text/html'}));
  const a = document.createElement('a'); a.href = url; a.download = fileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
  toast('Saved to Downloads');
}

/* ---------- backup and restore ---------- */
/* Structured backup is the whole database as JSON with the image data left out:
   accounts, calls, entries, overrides, import meta. A few hundred KB a month and
   fully restorable into a fresh install. Full backup adds the photos and is large
   and slow, for use before a deliberate reinstall.

   The device is the risk, not GitHub. Site settings -> Clear & reset, Clear
   browsing data with site data ticked, and uninstalling the app are three routes
   to losing everything, storage is scoped to the origin so clearing the domain
   takes both apps at once, and there is no pre-uninstall hook. The answer is
   routine backup, not careful uninstalling.

   Restore merges by record id and never wipes what is already there. A backup that
   has never been restored is not a backup - restore into a fresh install and check
   the counts before trusting it. */
const BACKUP_FORMAT = 'fieldcrm-backup', BACKUP_VER = 1;

function stripPhotos(c){
  // Blobs do not survive JSON, so a structured backup drops the image data and
  // keeps the count. Cloning by hand rather than through JSON.stringify, which
  // would turn a Blob into {} and hide the fact that anything was there.
  const out = {};
  for(const k of Object.keys(c)){
    if(k === 'entries' || k === 'loose') continue;
    out[k] = c[k];
  }
  let n = 0;
  out.entries = (c.entries||[]).map(e => {
    const o = {};
    for(const k of Object.keys(e)) if(k !== 'photos') o[k] = e[k];
    const ln = (e.photos||[]).length;
    if(ln){ n += ln; o.photoCount = ln; }
    o.photos = [];
    return o;
  });
  const ll = (c.loose||[]).length;
  if(ll){ n += ll; out.looseCount = ll; }
  out.loose = [];
  out.photosOmitted = n;
  return out;
}
async function inlinePhotos(c){
  const out = {};
  for(const k of Object.keys(c)){
    if(k === 'entries' || k === 'loose') continue;
    out[k] = c[k];
  }
  out.entries = [];
  for(const e of (c.entries||[])){
    const o = {};
    for(const k of Object.keys(e)) if(k !== 'photos') o[k] = e[k];
    o.photos = [];
    for(const p of (e.photos||[])) o.photos.push(await photoDataURL(p));
    out.entries.push(o);
  }
  out.loose = [];
  for(const p of (c.loose||[])) out.loose.push(await photoDataURL(p));
  return out;
}
async function buildBackup(withPhotos){
  const calls = await callsAll();
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VER,
    withPhotos: !!withPhotos,
    taken: Date.now(),
    app: 'Field CRM',
    meta: META,
    overrides: OVERRIDES,
    prefs: {mgr: localStorage.getItem(LS('mgr')) || ''},
    accounts: ACCOUNTS,
    appts: APPTS,
    weeks: WEEKS,
    mgrOf: MGR_OF,
    calls: withPhotos ? await Promise.all(calls.map(inlinePhotos)) : calls.map(stripPhotos)
  };
}
function backupName(withPhotos){
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return 'field_crm_backup'+(withPhotos?'_with_photos':'')+'_'+
    d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'.json';
}
async function doBackup(withPhotos){
  toast(withPhotos ? 'Building full backup...' : 'Building backup...');
  const data = await buildBackup(withPhotos);
  const text = JSON.stringify(data);
  const name = backupName(withPhotos);
  const file = new File([text], name, {type:'application/json'});
  let done = false;
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try { await navigator.share({files:[file], title:name}); done = true; }
    catch(e){ if(e.name === 'AbortError') return; console.error(e); }
  }
  if(!done){
    const url = URL.createObjectURL(new Blob([text], {type:'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
  }
  localStorage.setItem(LS('lastBackup'), String(Date.now()));
  renderBackupStat();
  toast('Backup '+Math.round(text.length/1024)+' KB - keep it off this device');
}
async function doRestore(file){
  const data = JSON.parse(await file.text());
  if(!data || data.format !== BACKUP_FORMAT) throw new Error('that is not a Field CRM backup file');
  const calls = Array.isArray(data.calls) ? data.calls : [];
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const existing = await callsAll();
  const have = new Set(existing.map(c => c.id));
  let added = 0, updated = 0;
  for(const c of calls){
    if(!c || !c.id) continue;
    if(have.has(c.id)) updated++; else added++;
    // a full backup carries photos as base64; they go back to Blobs on the way in
    (c.entries||[]).forEach(e => {
      e.photos = (e.photos||[]).map(p => {
        try { return typeof p === 'string' && p.startsWith('data:') ? dataURLToBlob(p) : p; }
        catch(err){ console.warn('photo skipped on restore', err); return null; }
      }).filter(Boolean);
    });
    c.loose = (c.loose||[]).map(p => {
      try { return typeof p === 'string' && p.startsWith('data:') ? dataURLToBlob(p) : p; }
      catch(err){ console.warn('loose photo skipped on restore', err); return null; }
    }).filter(Boolean);
    await callsPut(c);
  }
  if(accounts.length) await accMerge(accounts);
  // appointments merge by id like everything else, so a restore never drops a
  // visit that was planned on this device and is not in the file
  const appts = Array.isArray(data.appts) ? data.appts : [];
  let apptsAdded = 0;
  const haveAp = new Set(APPTS.map(a => a.id));
  for(const ap of appts){
    if(!ap || !ap.id) continue;
    if(!haveAp.has(ap.id)) apptsAdded++;
    await apptsPut(ap);
  }
  if(appts.length) APPTS = await apptsAll();
  if(data.weeks){ WEEKS = data.weeks; await kvSet('weeks', WEEKS); }
  if(data.mgrOf){ MGR_OF = data.mgrOf; await kvSet('mgrOf', MGR_OF); }
  if(data.overrides){
    OVERRIDES = Object.assign({acctZone:{}, spelling:{}}, data.overrides);
    await kvSet('overrides', OVERRIDES);
  }
  if(data.meta){ META = data.meta; await kvSet('meta', META); }
  if(data.prefs && data.prefs.mgr) localStorage.setItem(LS('mgr'), data.prefs.mgr);
  await loadAccounts();
  renderDbStat(); fillManagers(); renderBackupStat();
  await renderHome();
  const noPh = data.withPhotos ? '' : ' Photos were not in this backup.';
  renderPlanCount();
  toast(added+' calls added, '+updated+' updated, '+accounts.length+' accounts merged, '+
        apptsAdded+' appointments added.'+noPh);
}
function renderBackupStat(){
  const el = $('bkStat');
  if(!el) return;
  const raw = localStorage.getItem(LS('lastBackup'));
  if(!raw){ el.innerHTML = '<span class="flagline">No backup has been taken on this device.</span>'; return; }
  const t = Number(raw), days = Math.floor((Date.now()-t)/86400000);
  const d = new Date(t);
  const when = 'Last backup '+d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  el.innerHTML = days >= 7
    ? '<span class="flagline">'+when+' &mdash; '+days+' days ago.</span>'
    : when + (days ? ', '+days+' day'+(days===1?'':'s')+' ago.' : ', today.');
}
$('bkBtn').addEventListener('click', ()=>doBackup(false).catch(e=>{ console.error(e); toast('Backup failed: '+e.message); }));
$('bkPhBtn').addEventListener('click', ()=>doBackup(true).catch(e=>{ console.error(e); toast('Backup failed: '+e.message); }));
$('rsBtn').addEventListener('click', async ()=>{
  const f = $('rsFile').files[0];
  if(!f){ toast('Choose a backup file first'); return; }
  if(!confirm('Restore from '+f.name+'?\n\nThis adds and updates records by id. Nothing already on this device is deleted.')) return;
  try { await doRestore(f); }
  catch(e){ console.error(e); toast('Restore failed: '+e.message); }
});

/* ---------- boot ---------- */
(async function(){
  let dbErr = null;
  if(navigator.storage && navigator.storage.persist){
    try { await navigator.storage.persist(); } catch(e){ console.warn('persist', e); }
  }
  try {
    await openDB();
    await loadAccounts();
  } catch(e){ dbErr = e; console.error('storage', e); }
  renderDbStat(); renderRefStat(); renderHomeSetup(); fillManagers(); renderBackupStat();
  await loadDir();
  $('cMgr').addEventListener('change', renderHomeCounts);
  $('cDate').value = todayISO();
  try { resetBelt(); } catch(e){ console.error('belt form', e); }
  try { history.replaceState({screen:'home'}, '', location.href); } catch(e){}
  try { await renderHome(); } catch(e){ console.error('home', e); }
  try { await consumeSharedFile(); } catch(e){ console.error('shared file', e); }
  if(dbErr){
    $('dbStat').textContent = 'Storage error - ' + dbErr.message;
    toast('Storage error - ' + dbErr.message);
  }
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();
