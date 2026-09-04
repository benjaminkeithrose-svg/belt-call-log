/* Belt Call Log - offline PWA
   State lives in IndexedDB. Nothing leaves the phone unless shared. */

const DB_NAME = 'beltcall', DB_VER = 1;
let db, dbReady = null, DATA = null, REF = null, call = null, screen = 'home', photoTarget = null;

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
function saveCall(){ if(call){ call.updated = Date.now(); return callsPut(call); } }

/* ---------- xlsx import ---------- */
const COL = {
  acct:'Account Name', full:' Full Name', first:'First Name', last:'Last Name',
  role:'Job Role', title:'Job Title', email:'Email 1', mob:'Mobile',
  mgr:'Account Manager (Account Name) (Account)'
};
function pick(row, name){
  if(row[name] != null) return String(row[name]).trim();
  const k = Object.keys(row).find(x => x.trim().toLowerCase() === name.trim().toLowerCase());
  return k ? String(row[k]).trim() : '';
}
async function importXlsx(file){
  toast('Reading file...');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array'});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {defval:''});
  if(!rows.length) throw new Error('No rows found in that file');

  const accounts = {}, mgrs = {};
  for(const r of rows){
    const acct = pick(r, COL.acct);
    if(!acct) continue;
    let nm = pick(r, COL.full);
    if(!nm || nm === '. .' || nm === '.'){
      nm = (pick(r,COL.first)+' '+pick(r,COL.last)).trim();
    }
    if(!nm || nm === '.') continue;
    const mgr = pick(r, COL.mgr);
    if(mgr) mgrs[mgr] = (mgrs[mgr]||0)+1;
    if(!accounts[acct]) accounts[acct] = {mgr:mgr, contacts:[]};
    if(!accounts[acct].mgr && mgr) accounts[acct].mgr = mgr;
    accounts[acct].contacts.push({
      name: nm,
      role: pick(r,COL.title) || pick(r,COL.role),
      email: pick(r,COL.email),
      mobile: pick(r,COL.mob)
    });
  }
  // collapse duplicates: keep the most complete row per name
  for(const a in accounts){
    const seen = {};
    for(const c of accounts[a].contacts){
      const k = c.name.toLowerCase();
      const score = (c.email?2:0)+(c.mobile?2:0)+(c.role?1:0);
      if(!seen[k] || score > seen[k]._s){ c._s = score; seen[k] = c; }
    }
    accounts[a].contacts = Object.values(seen)
      .map(c => { delete c._s; return c; })
      .sort((x,y)=>x.name.localeCompare(y.name));
  }
  const payload = {
    accounts,
    managers: Object.keys(mgrs).sort((a,b)=>mgrs[b]-mgrs[a]),
    imported: Date.now(),
    counts: {accounts:Object.keys(accounts).length, contacts:Object.values(accounts).reduce((n,a)=>n+a.contacts.length,0)}
  };
  await kvSet('data', payload);
  DATA = payload;
  renderDbStat();
  fillManagers();
  toast('Imported '+payload.counts.contacts+' contacts');
}
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
function renderHomeSetup(){
  const el = $('homeSetup');
  if(!el) return;
  const missing = [];
  if(!DATA) missing.push('contact database');
  if(!REF) missing.push('belt reference data');
  if(!missing.length){ el.className = 'msg'; el.innerHTML = ''; return; }
  el.className = 'msg info show';
  el.innerHTML = 'No '+missing.join(' or ')+' loaded yet. <span class="lnk" data-go="data">Open Data &amp; setup</span>';
}

function renderDbStat(){
  if(!DATA){ $('dbStat').textContent = 'No data loaded.'; return; }
  const d = new Date(DATA.imported);
  $('dbStat').innerHTML = '<b>'+DATA.counts.accounts+'</b> accounts, <b>'+DATA.counts.contacts+
    '</b> contacts<br>Imported '+d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
function fillManagers(){
  const sel = $('cMgr'); sel.innerHTML = '';
  const list = (DATA && DATA.managers.length) ? DATA.managers : ['Ben Rose'];
  list.forEach(m => { const o = document.createElement('option'); o.textContent = m; sel.appendChild(o); });
  const saved = localStorage.getItem('mgr');
  if(saved && list.includes(saved)) sel.value = saved;
  updateMgrHint();
}
function updateMgrHint(){
  if(!DATA) return;
  const m = $('cMgr').value;
  const n = Object.values(DATA.accounts).filter(a=>a.mgr===m).length;
  $('mgrHint').textContent = n + ' accounts for ' + m + ' - search covers all accounts';
}

/* ---------- navigation ---------- */
const TITLES = {
  home:['Belt Call Log',''], account:['New call','Account'], contacts:['New call','Contacts'],
  dash:['Call','Menu'], belt:['Add belt',''], project:['Add project',''],
  note:['General note',''], health:['Health check',''], compile:['Compile',''],
  data:['Data & setup','One-off import']
};
function go(name){
  screen = name;
  document.querySelectorAll('.scr').forEach(s=>s.classList.remove('on'));
  $('s-'+name).classList.add('on');
  $('back').style.display = (name==='home') ? 'none' : 'block';
  $('title').textContent = TITLES[name] ? TITLES[name][0] : 'Belt Call Log';
  $('subtitle').textContent = call ? (call.customer + (call.site?' - '+call.site:'')) : 'No call open';
  const inCall = call && ['dash','belt','project','note','health','compile'].includes(name);
  $('bar').style.display = inCall ? 'flex' : 'none';
  window.scrollTo(0,0);
  if(name==='dash') renderDash();
  if(name==='compile') renderCompileStat();
  if(name==='home') renderHome();
  if(name==='data'){ renderDbStat(); renderRefStat(); }
}
$('back').addEventListener('click', ()=>{
  if(['belt','project','note','health','compile'].includes(screen)) return go('dash');
  if(screen==='contacts') return go('account');
  if(screen==='account') return go('home');
  if(screen==='dash') return go('home');
  go('home');
});

/* ---------- home ---------- */
async function renderHome(){
  const all = await callsAll();
  const open = all.filter(c=>!c.closed).sort((a,b)=>b.updated-a.updated);
  $('resumeInfo').textContent = open.length ? open[0].customer : 'None open';
  const done = all.sort((a,b)=>b.updated-a.updated).slice(0,8);
  const el = $('pastList');
  if(!done.length){ el.innerHTML = '<p class="empty">No saved calls.</p>'; return; }
  el.innerHTML = done.map(c=>
    '<div class="card"><div class="hd"><span class="t">'+esc(c.date)+'</span>'+
    '<span class="acts"><button class="x" data-open="'+c.id+'">Open</button>'+
    '<button class="x bin" data-delcall="'+c.id+'">&#128465; Delete</button></span></div>'+
    '<p>'+esc(c.customer)+'</p><p class="meta">'+c.entries.length+' entries'+(c.closed?' - closed':' - open')+'</p></div>'
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
    if(!confirm('Delete ' + what + '?\n\n' + (c?c.entries.length:0) + ' entries and ' + ph +
                ' photos will be erased. This cannot be undone.')) return;
    await callsDel(id);
    if(call && call.id === id) call = null;
    toast('Call deleted');
    renderHome();
  }));
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-go]');
  if(!b) return;
  const t = b.dataset.go;
  if(t==='data'){ go('data'); return; }
  if(t==='newcall'){
    if(!DATA){ toast('Import the contact database first'); return; }
    $('cDate').value = todayISO(); go('account'); renderAccSearch();
  } else if(t==='resume'){
    const all = await callsAll();
    const open = all.filter(c=>!c.closed).sort((a,b)=>b.updated-a.updated);
    if(!open.length){ toast('No open call'); return; }
    call = open[0]; call.loose = call.loose || []; go('dash');
  } else if(t==='belt'){ resetBelt(); go('belt'); }
  else if(t==='project'){ resetProject(); go('project'); }
  else if(t==='note'){ $('nText').value=''; go('note'); }
  else if(t==='health'){ resetHealth(); go('health'); }
});

/* ---------- import wiring ---------- */
$('importBtn').addEventListener('click', async ()=>{
  const f = $('xlsxFile').files[0];
  if(!f){ toast('Choose an .xlsx file first'); return; }
  try { await importXlsx(f); renderHomeSetup(); }
  catch(e){ console.error(e); toast('Import failed: '+e.message); }
});
$('refBtn').addEventListener('click', async ()=>{
  const f = $('refFile').files[0];
  if(!f){ toast('Choose the .xlsm workbook first'); return; }
  try { await importRef(f); }
  catch(e){ console.error(e); toast('Import failed: '+e.message); }
});

/* ---------- account search ---------- */
function renderAccSearch(){
  $('accQ').value=''; $('accRes').innerHTML=''; $('accHint').textContent =
    DATA ? DATA.counts.accounts+' accounts loaded' : 'Import contact data first';
}
$('cMgr').addEventListener('change', ()=>{ localStorage.setItem('mgr', $('cMgr').value); updateMgrHint(); });
$('accQ').addEventListener('input', ()=>{
  const q = $('accQ').value.trim().toLowerCase();
  const res = $('accRes'); res.innerHTML='';
  if(!DATA || !q){ $('accHint').textContent = DATA? DATA.counts.accounts+' accounts loaded':''; return; }
  const mgr = $('cMgr').value;
  let hits = Object.keys(DATA.accounts).filter(a=>a.toLowerCase().includes(q));
  hits.sort((a,b)=>{
    const am = DATA.accounts[a].mgr===mgr, bm = DATA.accounts[b].mgr===mgr;
    if(am!==bm) return am?-1:1;
    return a.length-b.length;
  });
  $('accHint').textContent = hits.length+' match'+(hits.length===1?'':'es');
  hits.slice(0,10).forEach(a=>{
    const b = document.createElement('button');
    const own = DATA.accounts[a].mgr===mgr;
    b.innerHTML = esc(a) + (own?'':'<span class="tag">'+esc(DATA.accounts[a].mgr||'no manager')+'</span>');
    b.addEventListener('click', ()=>chooseAccount(a));
    res.appendChild(b);
  });
});
$('accManualGo').addEventListener('click', ()=>{
  const m = $('accManual').value.trim();
  if(!m){ toast('Enter an account name'); return; }
  chooseAccount(m, true);
});

let pendingAcct = null;
function chooseAccount(name, manual){
  pendingAcct = {name, manual: !!manual};
  $('ctAcc').textContent = name;
  $('ctQ').value=''; $('ncName').value=''; $('ncRole').value=''; $('ncEmail').value=''; $('ncMob').value='';
  $('cSite').value=''; $('ctErr').classList.remove('show');
  const list = $('ctList');
  const cs = (!manual && DATA.accounts[name]) ? DATA.accounts[name].contacts : [];
  if(!cs.length){
    list.innerHTML = '<p class="empty">No contacts on file. Add one below.</p>';
  } else {
    list.innerHTML = cs.map((c,i)=>{
      const meta = [c.role||'Role not recorded', c.email, c.mobile].filter(Boolean).join(' &middot; ');
      const missing = (!c.email||!c.mobile) ? '<span class="tag">'+(!c.email&&!c.mobile?'no email or mobile':(!c.email?'no email':'no mobile'))+'</span>' : '';
      return '<label class="pick"><input type="checkbox" data-i="'+i+'">'+
        '<span><div class="nm">'+esc(c.name)+missing+'</div><div class="mt">'+meta+'</div></span></label>';
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
  const cs = (!pendingAcct.manual && DATA.accounts[pendingAcct.name]) ? DATA.accounts[pendingAcct.name].contacts : [];
  const chosen = [];
  $('ctList').querySelectorAll('input:checked').forEach(b=>{
    const c = cs[+b.dataset.i];
    if(c) chosen.push({name:c.name, role:c.role, email:c.email, mobile:c.mobile, crm:true});
  });
  const nn = $('ncName').value.trim();
  if(nn) chosen.push({name:nn, role:$('ncRole').value.trim(), email:$('ncEmail').value.trim(), mobile:$('ncMob').value.trim(), crm:false});
  if(!chosen.length){ $('ctErr').classList.add('show'); return; }

  call = {
    id: 'c'+Date.now(),
    date: ddmmyyyy($('cDate').value),
    type: $('cType').value,
    mgr: $('cMgr').value,
    customer: pendingAcct.name,
    manualAccount: pendingAcct.manual,
    site: $('cSite').value.trim(),
    contacts: chosen,
    entries: [],
    loose: [],
    closed: false,
    updated: Date.now()
  };
  await saveCall();
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
    if(e.type==='belt'){
      head='Belt - '+e.asset;
      const spec = [e.series?'S'+e.series:'', e.style, e.beltmat, e.colour].filter(Boolean).join(' ');
      body=[e.beltdesc, spec, e.width?e.width+' mm wide':'', e.rodmat?e.rodmat+' rod':'',
            e.retrofit?'retrofit '+e.retrofit:'', e.sprpd||e.sprocket,
            e.flights?'flights':''].filter(Boolean).join(' &middot; ');
    }
    if(e.type==='project'){ head='Project - '+e.project; body=[e.status,e.next,e.target].filter(Boolean).join(' &middot; '); }
    if(e.type==='note'){ head='Note - '+e.topic; body=esc(e.text); }
    if(e.type==='health'){ head='Health - '+(e.asset||'unspecified'); body=[e.fault,e.severity].filter(Boolean).join(' &middot; '); }
    const ph = e.photos||[];
    const th = ph.map((p,j)=>'<img src="'+p+'" data-rm="'+i+':'+j+'">').join('');
    return '<div class="card"><div class="hd"><span class="t">'+esc(head)+'</span>'+
      '<button class="x" data-del="'+i+'">Remove</button></div>'+
      '<p class="meta">'+body+'</p>'+
      (th?'<div class="thumbs">'+th+'</div>':'')+
      '<div class="cardbar"><button data-cam="'+i+'">Camera</button>'+
      '<button data-gal="'+i+'">Photos</button>'+
      '<span class="phc">'+(ph.length? ph.length+' photo'+(ph.length===1?'':'s') : 'no photos')+'</span></div></div>';
  }).join('');
  el.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Remove this entry and its photos?')) return;
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
    call.entries[p[0]].photos.splice(p[1],1); await saveCall(); renderDash();
  }));
}
function renderLoose(){
  const el = $('looseWrap');
  if(!el || !call) return;
  const ph = call.loose || [];
  const th = ph.map((p,j)=>'<img src="'+p+'" data-lrm="'+j+'">').join('');
  el.innerHTML = '<div class="card"><div class="hd"><span class="t">Not tied to an entry</span></div>'+
    '<p class="meta">These come out at the end of the notes, after the health check.</p>'+
    (th?'<div class="thumbs">'+th+'</div>':'')+
    '<div class="cardbar"><button id="looseCam">Camera</button>'+
    '<button id="looseGal">Photos</button>'+
    '<span class="phc">'+(ph.length? ph.length+' photo'+(ph.length===1?'':'s') : 'no photos')+'</span></div></div>';
  $('looseCam').addEventListener('click', ()=>{ photoTarget='loose'; $('camInput').value=''; $('camInput').click(); });
  $('looseGal').addEventListener('click', ()=>{ photoTarget='loose'; $('galInput').value=''; $('galInput').click(); });
  el.querySelectorAll('[data-lrm]').forEach(img=>img.addEventListener('click', async ()=>{
    if(!confirm('Remove this photo?')) return;
    call.loose.splice(+img.dataset.lrm,1); await saveCall(); renderLoose();
  }));
}
$('closeCall').addEventListener('click', async ()=>{
  if(!confirm('Close this call? It stays saved but will not show under Resume.')) return;
  call.closed = true; await saveCall(); call = null; go('home');
});
$('toCompile').addEventListener('click', ()=>go('compile'));
$('barMenu').addEventListener('click', ()=>go('dash'));

/* ---------- entry: belt ----------
   Mirrors the plant audit line entry form: the same Series > Style > Material > Colour
   cascade, the same width and frame checks off the link geometry, the same sprocket
   cascade and quantity rule, and the same flight spacing conversion. Everything is driven
   by the imported workbook, so with no reference data loaded the pickers sit empty and the
   free-text fields still carry the call. Health check stays its own entry type. */

const DEFAULT_BORE = '40 mm square';
const FALLBACK_ROD = ['ACETAL','POLYPROPYLENE','POLYETHYLENE','PK','NYLON'];

function populateSel(el, values, placeholder, withOther){
  if(!el) return;
  el.innerHTML = '<option value="">'+esc(placeholder)+'</option>' +
    values.map(v => '<option value="'+esc(v)+'">'+esc(v)+'</option>').join('') +
    (withOther ? '<option value="OTHER">Other...</option>' : '');
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

  populateSel($('bSeries'), uniqSort(R.combos.map(c=>c[0])),
    R.combos.length ? 'Select series...' : 'Import reference data');

  const mats = R.materials.length ? R.materials : uniqSort(R.combos.map(c=>c[2]));
  populateSel($('bFlMat'), mats, 'Select flight material...');
  populateSel($('bSgMat'), mats, 'Select sideguard material...');
  populateSel($('bFlType'), R.flightTypes, 'Select flight type...', true);
  populateSel($('bSgType'), R.sideguardTypes, 'Select sideguard type...', true);

  const rods = R.rods.length ? R.rods : FALLBACK_ROD;
  const chips = $('bRodChips');
  chips.innerHTML = rods.map(v => '<button type="button" data-rod="'+esc(v)+'">'+esc(v)+'</button>').join('') +
    '<button type="button" data-rod="OTHER">Other...</button>';
  chips.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const was = b.classList.contains('on');
    chips.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    if(!was) b.classList.add('on');
    $('bRodOther').classList.toggle('hide', !(b.dataset.rod === 'OTHER' && !was));
  }));

  populateSprBores();
  populateIndent();
  updatePitch();
}
function rodValue(){
  const on = $('bRodChips').querySelector('button.on');
  if(!on) return '';
  return on.dataset.rod === 'OTHER' ? $('bRodOther').value.trim() : on.dataset.rod;
}

/* ---------- Series > Style > Material > Colour ---------- */
const serSel = () => $('bSeries'), stySel = () => $('bStyle'),
      matSel = () => $('bMat'), colSel = () => $('bColour');
const combos = () => (REF ? REF.combos : []);

function onSeries(reset){
  const s = serSel().value;
  const styles = uniqSort(combos().filter(c=>c[0]===s).map(c=>c[1]));
  populateSel(stySel(), styles, styles.length ? 'Select style...' : 'No styles on file');
  stySel().disabled = !s;
  if(reset !== false){
    populateSel(matSel(), [], 'Select style first'); matSel().disabled = true;
    populateSel(colSel(), [], 'Select material first'); colSel().disabled = true;
  }
  runWidthCheck();
  populateSprBores();
  const p = pitchMm(), rows = parseFloat($('bFlRows').value);
  if(p && rows > 0) $('bFlMm').value = round1(rows * p);
  updatePitch();
}
function onStyle(reset){
  const s = serSel().value, st = stySel().value;
  const ms = uniqSort(combos().filter(c=>c[0]===s && c[1]===st).map(c=>c[2]));
  populateSel(matSel(), ms, ms.length ? 'Select material...' : 'No materials on file');
  matSel().disabled = !st;
  if(reset !== false){ populateSel(colSel(), [], 'Select material first'); colSel().disabled = true; }
  runWidthCheck();
  populateIndent();
}
function onMaterial(){
  const s = serSel().value, st = stySel().value, m = matSel().value;
  const cs = uniqSort(combos().filter(c=>c[0]===s && c[1]===st && c[2]===m).map(c=>c[3]));
  populateSel(colSel(), cs, cs.length ? 'Select colour...' : 'No colours on file');
  colSel().disabled = !m;
  runWidthCheck();
  syncFlightMaterial();
}
function setCascade(s, st, m, c){
  serSel().value = s || ''; onSeries(false);
  stySel().value = st || ''; onStyle(false);
  matSel().value = m || ''; onMaterial();
  colSel().value = c || '';
  runWidthCheck();
}

/* ---------- belt width against buildable increments ----------
   The same arithmetic the workbook does in its EU..FC columns: from the link width,
   protrusion, increment and minimum link count for this spec, work out the widths that
   can actually be built and flag anything landing between them. */
function runWidthCheck(){
  const el = $('bWidthMsg');
  const s = serSel().value, st = stySel().value, m = matSel().value;
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
  populateSel(el, bores, bores.length ? 'Select bore...' : 'No sprockets for this series');
  if(bores.includes(prev)) el.value = prev;
  else if(bores.includes(DEFAULT_BORE)) el.value = DEFAULT_BORE;
  onSprBore(false);
}
function onSprBore(reset){
  const b = $('bSprBore').value;
  const pds = uniqSort(sprPool().filter(x => x[1]===b).map(x => x[2]));
  populateSel($('bSprPd'), pds, pds.length ? 'Select pitch diameter...' : 'No data for this bore');
  $('bSprPd').disabled = !b;
  if(reset !== false){ populateSel($('bSprMat'), [], 'Select pitch diameter first'); $('bSprMat').disabled = true; }
  matchSprocket();
}
function onSprPd(){
  const b = $('bSprBore').value, p = $('bSprPd').value;
  const ms = uniqSort(sprPool().filter(x => x[1]===b && x[2]===p).map(x => x[3]));
  populateSel($('bSprMat'), ms, ms.length ? 'Select material...' : 'No data for this pitch');
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
  const m = matSel().value;
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
  sel.innerHTML = '<option value="">Select indent...</option>' +
    use.map(([l, vals]) => '<optgroup label="'+esc(l)+'">' +
      vals.map(v => '<option value="'+esc(v)+'">'+esc(v)+'</option>').join('') + '</optgroup>').join('') +
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
serSel().addEventListener('change', () => onSeries());
stySel().addEventListener('change', () => onStyle());
matSel().addEventListener('change', onMaterial);
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
  const chips = $('bRodChips');
  chips.querySelectorAll('button').forEach(x => x.classList.remove('on'));
  const chip = [...chips.querySelectorAll('button')].find(x => x.dataset.rod === b.rodmat);
  if(chip) chip.classList.add('on');
  else if(b.rodmat){
    const o = [...chips.querySelectorAll('button')].find(x => x.dataset.rod === 'OTHER');
    if(o){ o.classList.add('on'); $('bRodOther').classList.remove('hide'); $('bRodOther').value = b.rodmat; }
  }
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
  ['bRodOther','bFlTypeOther','bSgTypeOther','bIndentOther'].forEach(i => $(i).classList.add('hide'));
  $('bRodChips').querySelectorAll('button').forEach(x => x.classList.remove('on'));
  bRetroVal = ''; document.querySelectorAll('#bRetro button').forEach(x => x.classList.remove('on'));
  sprDescTouched = sprPnTouched = sprDriveTouched = sprIdleTouched = false;
  flMatTouched = lenTouched = false; indentAll = false;
  ['bSprDescAuto','bSprPnAuto','bSprDrvAuto','bSprIdlAuto','bFlMatAuto','bLenAuto']
    .forEach(i => $(i).classList.remove('off'));
  $('bSkipSpr').checked = false; $('bSprBody').classList.remove('hide');
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
    series:serSel().value, style:stySel().value, beltmat:matSel().value, colour:colSel().value,
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
  await saveCall();
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
      res(cv.toDataURL('image/jpeg', q));
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); rej(new Error('bad image')); };
    img.src = url;
  });
}

/* ---------- compile ---------- */
const DASH_CH = '\u2014';
const V = v => { v = (v==null?'':String(v)).trim(); return (v===''||v==='N/A') ? DASH_CH : esc(v); };

function renderCompileStat(){
  const n = t => call.entries.filter(e=>e.type===t).length;
  const ph = call.entries.reduce((a,e)=>a+(e.photos?e.photos.length:0),0) + (call.loose?call.loose.length:0);
  $('compStat').innerHTML = '<b>'+esc(call.customer)+'</b><br>'+
    n('belt')+' belts, '+n('project')+' projects, '+n('note')+' notes, '+n('health')+' health items<br>'+
    ph+' photo'+(ph===1?'':'s')+' embedded';
}
function buildNotesHTML(){
  const c = call;
  const css = 'body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:11pt;color:#222222;margin:0;padding:16px}'+
    '.mast{border-bottom:3px solid #ED1C24;padding-bottom:8px;margin-bottom:16px}'+
    '.mast img{height:34px;width:auto;display:block}'+
    'h1{font-size:17pt;margin:12px 0 2px;color:#222222}'+
    'h2{font-size:13pt;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #E3F0F5;color:#4D4D4F}'+
    'h3{font-size:11.5pt;margin:16px 0 6px;color:#222222}.sub{color:#4D4D4F;font-size:10pt;margin:0 0 14px}'+
    'table{border-collapse:collapse;width:100%;margin:0 0 10px;font-size:10pt}'+
    'th{background:#E3F0F5;text-align:left;padding:6px 8px;border:1px solid #ACD3E1;font-weight:bold;color:#222222}'+
    'td{padding:6px 8px;border:1px solid #CCCCCC;vertical-align:top}'+
    'td.l{background:#F7F8F8;width:38%;font-weight:bold}.flag{color:#B2232F;font-weight:bold}'+
    '.blk{page-break-inside:avoid}.ph{margin:6px 0 14px}.ph img{max-width:420px;border:1px solid #CCCCCC;margin:0 8px 8px 0}'+
    '.ft{margin-top:24px;padding-top:8px;border-top:3px solid #ED1C24;color:#4D4D4F;font-size:9pt}';
  const LOGO = 'data:image/jpeg;base64,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';
  const p = [];
  p.push('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Call notes '+esc(c.customer)+'</title><style>'+css+'</style></head><body>');
  p.push('<div class="mast"><img src="'+LOGO+'" alt="Intralox"></div>');
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
    belts.forEach((b,i)=>{
      p.push('<div class="blk"><h3>Belt '+(i+1)+' '+DASH_CH+' '+V(b.asset)+'</h3><table>');
      const rows = [
        ['Belt description',b.beltdesc],['Series',b.series],['Style',b.style],
        ['Material',b.beltmat],['Colour',b.colour],['Rod material',b.rodmat],
        ['Conveyor length (m)',b.clength],['Inside frame width (mm)',b.frame],
        ['Belt width (mm)',b.width],['Belt length (m)',b.beltlen],['Retrofit',b.retrofit]
      ];
      const spr = [['Sprocket bore',b.sprbore],['Pitch diameter / teeth',b.sprpd],
        ['Sprocket material',b.sprmat],['Build type',b.sprvar],['Sprocket description',b.sprocket],
        ['Part number',b.sprpn],['Drive qty',b.sprdrive],['Idle qty',b.spridle]];
      const acc = [['Flight type',b.fstyle],['Flight material',b.flmat],['Flight height (mm)',b.fheight],
        ['Flight spacing (rows)',b.frows],['Flight spacing (mm)',b.fspacing],['Indent (mm)',b.findent],
        ['Centre notch (mm)',b.cnotch],['Sideguard type',b.sgtype],['Sideguard material',b.sgmat],
        ['Sideguard height (mm)',b.sgheight]];
      const live = a => a.filter(([,v]) => v != null && String(v).trim() !== '' && v !== 'N/A');
      rows.forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
      if(live(spr).length) live(spr).forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
      else p.push('<tr><td class="l">Sprockets</td><td>Not assessed</td></tr>');
      if(live(acc).length) live(acc).forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
      else p.push('<tr><td class="l">Flights and sideguards</td><td>None on this belt</td></tr>');
      if(b.qcontact) p.push('<tr><td class="l">Quote contact</td><td>'+V(b.qcontact)+'</td></tr>');
      p.push('</table>');
      if(b.photos && b.photos.length) p.push('<div class="ph">'+b.photos.map(x=>'<img src="'+x+'">').join('')+'</div>');
      p.push('</div>');
    });
  }

  const health = c.entries.filter(e=>e.type==='health');
  if(health.length){
    p.push('<h2>Health check</h2>');
    health.forEach((h,i)=>{
      p.push('<div class="blk"><h3>Item '+(i+1)+' '+DASH_CH+' '+V(h.asset)+'</h3><table>');
      [['Fault or observation',h.fault],['Type',h.htype],['Severity',h.severity],['Recommended action',h.action]]
        .forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
      p.push('</table>');
      if(h.photos && h.photos.length) p.push('<div class="ph">'+h.photos.map(x=>'<img src="'+x+'">').join('')+'</div>');
      p.push('</div>');
    });
  }

  if(c.loose && c.loose.length){
    p.push('<h2>Additional photos</h2>');
    p.push('<div class="ph">'+c.loose.map(x=>'<img src="'+x+'">').join('')+'</div>');
  }

  p.push('<p class="ft">Compiled from site call notes. Final belt selection subject to Intralox review.</p></body></html>');
  return p.join('');
}
function fileName(){
  const cust = call.customer.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,40);
  const site = call.site ? '_'+call.site.replace(/[^A-Za-z0-9]+/g,'_') : '';
  return cust+site+'_call_notes_'+call.date.replace(/\//g,'-')+'.html';
}
$('doShare').addEventListener('click', async ()=>{
  const html = buildNotesHTML();
  const file = new File([html], fileName(), {type:'text/html'});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{
      await navigator.share({files:[file], title:'Call notes '+call.customer});
      toast('Shared');
    }catch(e){ if(e.name!=='AbortError') { console.error(e); toast('Share failed - try Download'); } }
  } else {
    toast('Sharing not supported here - downloading instead');
    download(html);
  }
});
$('doDownload').addEventListener('click', ()=>download(buildNotesHTML()));
function download(html){
  const url = URL.createObjectURL(new Blob([html], {type:'text/html'}));
  const a = document.createElement('a'); a.href = url; a.download = fileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
  toast('Saved to Downloads');
}

/* ---------- boot ---------- */
(async function(){
  let dbErr = null;
  if(navigator.storage && navigator.storage.persist){
    try { await navigator.storage.persist(); } catch(e){ console.warn('persist', e); }
  }
  try {
    await openDB();
    DATA = await kvGet('data');
    REF = await kvGet('beltref');
  } catch(e){ dbErr = e; console.error('storage', e); }
  renderDbStat(); renderRefStat(); renderHomeSetup(); fillManagers();
  $('cDate').value = todayISO();
  buildBeltRef();
  try { await renderHome(); } catch(e){ console.error('home', e); }
  if(dbErr){
    $('dbStat').textContent = 'Storage error - ' + dbErr.message;
    toast('Storage error - ' + dbErr.message);
  }
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();
