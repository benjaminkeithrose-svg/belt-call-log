/* Belt Call Log - offline PWA
   State lives in IndexedDB. Nothing leaves the phone unless shared. */

const DB_NAME = 'beltcall', DB_VER = 1;
let db, dbReady = null, DATA = null, call = null, screen = 'home', photoTarget = null;

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
  note:['General note',''], health:['Health check',''], compile:['Compile','']
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
    '<button class="x" data-open="'+c.id+'">Open</button></div>'+
    '<p>'+esc(c.customer)+'</p><p class="meta">'+c.entries.length+' entries'+(c.closed?' - closed':' - open')+'</p></div>'
  ).join('');
  el.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click', async ()=>{
    const all2 = await callsAll();
    call = all2.find(x=>x.id===b.dataset.open);
    go('dash');
  }));
}
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click', async ()=>{
  const t = b.dataset.go;
  if(t==='newcall'){
    if(!DATA){ toast('Import the contact database first'); return; }
    $('cDate').value = todayISO(); go('account'); renderAccSearch();
  } else if(t==='resume'){
    const all = await callsAll();
    const open = all.filter(c=>!c.closed).sort((a,b)=>b.updated-a.updated);
    if(!open.length){ toast('No open call'); return; }
    call = open[0]; go('dash');
  } else if(t==='belt'){ resetBelt(); go('belt'); }
  else if(t==='project'){ resetProject(); go('project'); }
  else if(t==='note'){ $('nText').value=''; go('note'); }
  else if(t==='health'){ resetHealth(); go('health'); }
}));

/* ---------- import wiring ---------- */
$('importBtn').addEventListener('click', async ()=>{
  const f = $('xlsxFile').files[0];
  if(!f){ toast('Choose an .xlsx file first'); return; }
  try { await importXlsx(f); }
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

  const el = $('logList');
  if(!c.entries.length){ el.innerHTML = '<p class="empty">Nothing logged yet.</p>'; return; }
  el.innerHTML = c.entries.map((e,i)=>{
    let head='', body='';
    if(e.type==='belt'){ head='Belt - '+e.asset; body=[e.beltdesc,e.width?e.width+' mm':'',e.beltmat,e.rodmat,e.retrofit?'retrofit '+e.retrofit:'',e.sprocket].filter(Boolean).join(' &middot; '); }
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
$('closeCall').addEventListener('click', async ()=>{
  if(!confirm('Close this call? It stays saved but will not show under Resume.')) return;
  call.closed = true; await saveCall(); call = null; go('home');
});
$('toCompile').addEventListener('click', ()=>go('compile'));
$('barMenu').addEventListener('click', ()=>go('dash'));

/* ---------- entry: belt ---------- */
const FLIGHTS = [['fspacing','Flight spacing'],['findent','Flight indent'],['cnotch','Centre notch'],['fheight','Flight height'],['fstyle','Flight style']];
function buildFlights(){
  $('flightWrap').innerHTML = FLIGHTS.map(([id,label])=>
    '<div class="fld"><label>'+label+'</label>'+
    '<input type="text" id="f_'+id+'" disabled>'+
    '<label class="na"><input type="checkbox" id="na_'+id+'" checked> N/A</label></div>'
  ).join('');
  FLIGHTS.forEach(([id])=>{
    $('na_'+id).addEventListener('change', e=>{
      const inp = $('f_'+id); inp.disabled = e.target.checked;
      if(e.target.checked) inp.value=''; else inp.focus();
    });
  });
}
let bRetroVal = '';
function resetBelt(){
  ['bAsset','bDesc','bWidth','bClen','bSprk','bQc'].forEach(i=>$(i).value='');
  $('bMat').value='Unknown'; $('bRod').value='Unknown';
  bRetroVal=''; document.querySelectorAll('#bRetro button').forEach(x=>x.classList.remove('on'));
  $('bErr').classList.remove('show'); buildFlights();
}
document.querySelectorAll('#bRetro button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#bRetro button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); bRetroVal = b.dataset.v;
}));
$('bSave').addEventListener('click', async ()=>{
  const a = $('bAsset').value.trim();
  if(!a){ $('bErr').classList.add('show'); $('bAsset').focus(); return; }
  const e = {type:'belt', asset:a, beltdesc:$('bDesc').value.trim(), width:$('bWidth').value.trim(),
    beltmat:$('bMat').value, rodmat:$('bRod').value, retrofit:bRetroVal,
    clength:$('bClen').value.trim(), sprocket:$('bSprk').value.trim(),
    qcontact:$('bQc').value.trim(), photos:[]};
  FLIGHTS.forEach(([id])=>{ e[id] = $('na_'+id).checked ? 'N/A' : ($('f_'+id).value.trim()||'N/A'); });
  call.entries.push(e); await saveCall();
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
$('barCamera').addEventListener('click', ()=>{ photoTarget=null; $('camInput').value=''; $('camInput').click(); });
$('barGallery').addEventListener('click', ()=>{ photoTarget=null; $('galInput').value=''; $('galInput').click(); });

async function addPhotos(files){
  if(!files.length || !call || !call.entries.length){ photoTarget=null; return; }
  const idx = (photoTarget!=null && call.entries[photoTarget]) ? photoTarget : call.entries.length-1;
  photoTarget = null;
  const entry = call.entries[idx];
  entry.photos = entry.photos || [];
  let ok = 0;
  for(const f of files){
    try { entry.photos.push(await shrink(f)); ok++; }
    catch(err){ console.error('skipped', f.name, err); }
  }
  await saveCall();
  const label = entry.asset || entry.project || entry.topic || 'entry';
  const n = entry.photos.length;
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
  const ph = call.entries.reduce((a,e)=>a+(e.photos?e.photos.length:0),0);
  $('compStat').innerHTML = '<b>'+esc(call.customer)+'</b><br>'+
    n('belt')+' belts, '+n('project')+' projects, '+n('note')+' notes, '+n('health')+' health items<br>'+
    ph+' photo'+(ph===1?'':'s')+' embedded';
}
function buildNotesHTML(){
  const c = call;
  const css = 'body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1a1a1a;margin:0;padding:16px}'+
    'h1{font-size:17pt;margin:0 0 2px}h2{font-size:13pt;margin:22px 0 8px;padding-bottom:4px;border-bottom:1.5px solid #dbeaf5}'+
    'h3{font-size:11.5pt;margin:16px 0 6px}.sub{color:#555;font-size:10pt;margin:0 0 14px}'+
    'table{border-collapse:collapse;width:100%;margin:0 0 10px;font-size:10pt}'+
    'th{background:#dbeaf5;text-align:left;padding:6px 8px;border:1px solid #b9cfe0;font-weight:bold}'+
    'td{padding:6px 8px;border:1px solid #c9d6e2;vertical-align:top}'+
    'td.l{background:#f4f8fb;width:38%;font-weight:bold}.flag{color:#8a4b00;font-weight:bold}'+
    '.blk{page-break-inside:avoid}.ph{margin:6px 0 14px}.ph img{max-width:420px;border:1px solid #c9d6e2;margin:0 8px 8px 0}'+
    '.ft{margin-top:24px;padding-top:8px;border-top:1px solid #dbeaf5;color:#777;font-size:9pt}';
  const p = [];
  p.push('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Call notes '+esc(c.customer)+'</title><style>'+css+'</style></head><body>');
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
      [['Belt description',b.beltdesc],['Belt width (mm)',b.width],['Belt material',b.beltmat],
       ['Rod material',b.rodmat],['Retrofit',b.retrofit],['Centre line length (m)',b.clength],
       ['Sprocket details',b.sprocket],['Flight spacing',b.fspacing],['Flight indent',b.findent],
       ['Centre notch',b.cnotch],['Flight height',b.fheight],['Flight style',b.fstyle]]
        .forEach(([l,v])=>p.push('<tr><td class="l">'+l+'</td><td>'+V(v)+'</td></tr>'));
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
  try {
    await openDB();
    DATA = await kvGet('data');
  } catch(e){ dbErr = e; console.error('storage', e); }
  renderDbStat(); fillManagers();
  $('cDate').value = todayISO();
  buildFlights();
  try { await renderHome(); } catch(e){ console.error('home', e); }
  if(dbErr){
    $('dbStat').textContent = 'Storage error - ' + dbErr.message;
    toast('Storage error - ' + dbErr.message);
  }
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();
