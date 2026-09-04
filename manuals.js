/* Belt Call Log - offline engineering manual library.
   Self-contained: own IndexedDB database, own state. The manuals screen and the
   page viewer are declared in index.html so they use the app's own classes.

   Storage is a SEPARATE database (beltmanuals) on purpose:
   - page images are large and must not sit alongside the calls
   - it needs no coordination with app.js's DB_VER, so adding this cannot
     trigger an upgrade of the beltcall database and cannot lose calls

   The unit throughout is a SERIES SECTION - the whole page range the manual
   gives to one series, taken from the table of contents. Individual datasheet
   pages are deliberately not broken out. An earlier build tried to, by reading
   the running header at the top of each page, and it failed on the phone: that
   header is one visual line with the category on the left and SERIES nnn on the
   right, so pdf.js returns it joined ("STRAIGHT-RUNNING BELTS SERIES 1400") and
   an anchored ^SERIES match never fired. Every section came back with no pages
   and search lost its ranking signal. Sections now come from the contents pages
   alone, which is one unambiguous source. Do not reintroduce header parsing
   without testing it against text pdf.js produced, not a text dump of the PDF.
*/
(function () {
  'use strict';

  var MDB = 'beltmanuals', MDB_VER = 1;
  var PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  var RENDER_W = 1240;     // long-edge px for stored page images
  var RENDER_Q = 0.72;     // jpeg quality
  var SHARE_W = 1240;      // images are reused as-is in shared HTML
  var DASH = '\u2014';

  // ---------------------------------------------------------------- storage
  var mdb = null, mdbReady = null;

  function openMDB() {
    if (mdbReady) return mdbReady;
    mdbReady = new Promise(function (res, rej) {
      var r = indexedDB.open(MDB, MDB_VER);
      r.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('text')) d.createObjectStore('text', { keyPath: 'key' });
      };
      r.onsuccess = function (e) { mdb = e.target.result; res(mdb); };
      r.onerror = function () { rej(r.error || new Error('the manual database would not open')); };
      r.onblocked = function () { rej(new Error('another copy of this app is open - close it and reopen')); };
    });
    mdbReady.catch(function () { mdbReady = null; });
    return mdbReady;
  }
  function mready() { return mdb ? Promise.resolve(mdb) : openMDB(); }

  function tx(store, mode, fn) {
    return mready().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), rq = fn(t.objectStore(store));
        t.oncomplete = function () { res(rq && rq.result); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  var get = function (s, k) { return tx(s, 'readonly', function (o) { return o.get(k); }); };
  var all = function (s) { return tx(s, 'readonly', function (o) { return o.getAll(); }); };
  var put = function (s, v) { return tx(s, 'readwrite', function (o) { return o.put(v); }); };
  function putMany(store, items) {
    return mready().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, 'readwrite'), o = t.objectStore(store);
        items.forEach(function (v) { o.put(v); });
        t.oncomplete = res; t.onerror = function () { rej(t.error); };
      });
    });
  }
  function delManual(id) {
    return mready().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(['meta', 'pages', 'text'], 'readwrite');
        t.objectStore('meta').delete(id);
        ['pages', 'text'].forEach(function (s) {
          var c = t.objectStore(s).openCursor();
          c.onsuccess = function (e) {
            var cur = e.target.result;
            if (!cur) return;
            if (String(cur.key).indexOf(id + ':') === 0) cur.delete();
            cur.continue();
          };
        });
        t.oncomplete = res; t.onerror = function () { rej(t.error); };
      });
    });
  }

  // ---------------------------------------------------------------- parsing
  // Generic. No manual name, page number or series list is hard-coded, so a
  // later edition imports without a code change.

  var LEAD = /^(\d{1,4})\s+(\S.{4,68}\S)$/;
  var TRAIL = /^(\S.{4,68}\S)\s+(\d{1,4})$/;
  var SER = /^SERIES\s+([0-9]+|[A-Z][A-Z0-9\-]{2,})$/;
  var TOC_LINE = /^(.*?)\.{4,}\s*(\d{1,4})\s*$/;

  /* pdf.js gives text per physical page, so page boundaries are already known.
     The footer scan exists only to learn the offset between the page number
     PRINTED on a page and its physical index in the file, and to check that the
     offset holds right through the document rather than only on average. */
  function detectOffset(pageLines) {
    var byStem = Object.create(null), i, j, s, m;
    for (i = 0; i < pageLines.length; i++) {
      for (j = 0; j < pageLines[i].length; j++) {
        s = String(pageLines[i][j]).trim();
        if (s.length < 7 || s.length > 79) continue;
        m = LEAD.exec(s);
        if (m) (byStem[m[2]] = byStem[m[2]] || []).push([i + 1, +m[1]]);
        m = TRAIL.exec(s);
        if (m) (byStem[m[1]] = byStem[m[1]] || []).push([i + 1, +m[2]]);
      }
    }
    var best = null, bestScore = 0, bestStem = null;
    Object.keys(byStem).forEach(function (stem) {
      var hits = byStem[stem];
      if (hits.length < 20) return;
      var nums = hits.map(function (h) { return h[1]; }), inc = 0, k, seen = {};
      for (k = 1; k < nums.length; k++) if (nums[k] === nums[k - 1] + 1) inc++;
      nums.forEach(function (n) { seen[n] = 1; });
      var span = Math.max.apply(null, nums) - Math.min.apply(null, nums) + 1;
      var score = (inc / Math.max(1, nums.length - 1)) * (Object.keys(seen).length / span);
      if (score > bestScore) { bestScore = score; best = hits; bestStem = stem; }
    });
    if (!best) return { offset: 0, confidence: 0, footers: 0, stem: null, agree: 0, disagree: 0 };
    var counts = {}, top = 0, off = 0;
    best.forEach(function (h) {
      var d = h[0] - h[1];
      counts[d] = (counts[d] || 0) + 1;
      if (counts[d] > top) { top = counts[d]; off = +d; }
    });
    return {
      offset: off, confidence: top / best.length, footers: best.length,
      stem: bestStem, agree: top, disagree: best.length - top
    };
  }

  function parseTOC(pageLines, limitPages) {
    var out = [], i, j, m;
    for (i = 0; i < Math.min(limitPages, pageLines.length); i++) {
      for (j = 0; j < pageLines[i].length; j++) {
        m = TOC_LINE.exec(String(pageLines[i][j]).trim());
        if (m && m[1]) out.push({ title: m[1].trim(), page: +m[2] });
      }
    }
    return out;
  }

  /* A section runs from its own contents entry to the page before the next
     entry, whatever that next entry is - the following series, or a heading
     such as BELT SUPPORT TOOLS that closes the group. */
  function buildSections(toc) {
    var out = [], i, m;
    for (i = 0; i < toc.length; i++) {
      m = SER.exec(toc[i].title);
      if (!m) continue;
      var next = toc[i + 1] ? toc[i + 1].page : null;
      var end = (next && next > toc[i].page) ? next - 1 : toc[i].page;
      out.push({ series: m[1], start: toc[i].page, end: end });
    }
    return out;
  }

  function identify(lines) {
    if (typeof lines === 'string') lines = lines.split('\n');
    var cands = [], year = '', i, m, s;
    for (i = 0; i < lines.length; i++) {
      s = String(lines[i]).replace(/\s+/g, ' ').trim();
      if (!year) { m = /((?:19|20)\d{2})\s+ENGINEERING MANUAL/i.exec(s); if (m) year = m[1]; }
      m = /ENGINEERING MANUAL\s*[-\u2013\u2014]\s*(\S.{2,44}?)(?:\s+\d{1,4})?$/i.exec(s);
      if (m) { cands.push(m[1].trim()); continue; }
      if (/^(?:(?:19|20)\d{2}\s+)?ENGINEERING MANUAL$/i.test(s)) {
        var nxt = String(lines[i + 1] || '').replace(/\s+/g, ' ').trim();
        if (nxt && nxt.length <= 45 && /[A-Za-z]/.test(nxt)) cands.push(nxt);
      }
    }
    // the running footer carries the brand's own capitalisation (ThermoDrive),
    // the cover is set in all caps - prefer a mixed-case candidate where there is one
    var name = '';
    for (i = 0; i < cands.length; i++) {
      if (cands[i] !== cands[i].toUpperCase()) { name = cands[i]; break; }
    }
    if (!name) name = cands[0] || 'Engineering Manual';
    name = name.replace(/[.,;:]+$/, '').trim();
    if (name === name.toUpperCase()) {
      name = name.toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    }
    var id = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'MANUAL';
    return { id: id, name: name, year: year };
  }

  // ---------------------------------------------------------------- import
  var pdfjsLib = null;
  function loadPdfJs() {
    if (pdfjsLib) return Promise.resolve(pdfjsLib);
    if (window.pdfjsLib) {
      pdfjsLib = window.pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return Promise.resolve(pdfjsLib);
    }
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = PDFJS_URL;
      s.onload = function () {
        pdfjsLib = window.pdfjsLib;
        if (!pdfjsLib) return rej(new Error('the PDF library loaded but did not register'));
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        res(pdfjsLib);
      };
      s.onerror = function () {
        rej(new Error('the PDF library could not be downloaded - connect once, then import'));
      };
      document.head.appendChild(s);
    });
  }

  /* Group text items into visual lines by y, top of page first. Items sharing a
     y are joined in x order, so a two-part running header arrives as ONE line.
     That is why nothing here matches on a bare ^SERIES anchor. */
  function pageLinesFrom(textContent) {
    var rows = {};
    textContent.items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var k = Math.round(Math.round(it.transform[5]) / 4) * 4;
      (rows[k] = rows[k] || []).push({ x: it.transform[4], s: it.str });
    });
    return Object.keys(rows)
      .map(Number)
      .sort(function (a, b) { return b - a; })
      .map(function (k) {
        return rows[k].sort(function (a, b) { return a.x - b.x; })
          .map(function (i) { return i.s; }).join(' ').replace(/\s+/g, ' ').trim();
      })
      .filter(function (l) { return l; });
  }

  function renderPage(pg) {
    var vp1 = pg.getViewport({ scale: 1 });
    var scale = RENDER_W / Math.max(vp1.width, vp1.height);
    var vp = pg.getViewport({ scale: scale });
    var c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
    return pg.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
      return new Promise(function (res) {
        c.toBlob(function (b) { res({ blob: b, w: c.width, h: c.height }); }, 'image/jpeg', RENDER_Q);
      });
    });
  }

  function pagesToRender(meta, mode) {
    var set = Object.create(null), i, p;
    if (mode === 'full') {
      for (i = 1; i <= meta.physicalPages; i++) set[i - meta.offset] = 1;
    } else {
      meta.sections.forEach(function (s) {
        for (p = s.start; p <= s.end; p++) set[p] = 1;
      });
    }
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  /* mode: 'series' (every page of every series section) | 'full'
     onProgress(stage, done, total) */
  function importManual(file, mode, onProgress) {
    var report = function (s, d, t) { if (onProgress) onProgress(s, d, t); };
    var doc, pageLines = [], meta = null;
    if (mode !== 'full') mode = 'series';

    return loadPdfJs()
      .then(function () { return file.arrayBuffer(); })
      .then(function (buf) { return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise; })
      .then(function (d) {
        doc = d;
        var chain = Promise.resolve(), i;
        for (i = 1; i <= doc.numPages; i++) {
          (function (n) {
            chain = chain.then(function () {
              return doc.getPage(n).then(function (pg) { return pg.getTextContent(); })
                .then(function (tc) {
                  pageLines[n - 1] = pageLinesFrom(tc);
                  if (n % 10 === 0 || n === doc.numPages) report('Reading text', n, doc.numPages);
                });
            });
          })(i);
        }
        return chain;
      })
      .then(function () {
        var ident = identify([].concat.apply([], pageLines.slice(0, 4)));
        var off = detectOffset(pageLines);
        var toc = parseTOC(pageLines, 8);
        var sections = buildSections(toc);
        if (!sections.length) {
          throw new Error('no belt series were found in the contents pages - ' +
                          'is this an Intralox engineering manual?');
        }
        meta = {
          id: ident.id, name: ident.name, year: ident.year,
          file: file.name, physicalPages: doc.numPages,
          offset: off.offset, offsetConfidence: off.confidence,
          offsetAgree: off.agree, offsetDisagree: off.disagree, footers: off.footers,
          sections: sections, mode: mode, imported: Date.now(), renderedPages: 0
        };
        return putMany('text', pageLines.map(function (ls, i) {
          return {
            key: meta.id + ':' + ((i + 1) - meta.offset), manual: meta.id,
            page: (i + 1) - meta.offset, t: ls.join('\n')
          };
        }));
      })
      .then(function () {
        var wanted = pagesToRender(meta, mode);
        var chain = Promise.resolve(), done = 0;
        wanted.forEach(function (printed) {
          chain = chain.then(function () {
            var phys = printed + meta.offset;
            if (phys < 1 || phys > doc.numPages) return;
            return doc.getPage(phys).then(renderPage).then(function (r) {
              return put('pages', {
                key: meta.id + ':' + printed, manual: meta.id,
                page: printed, w: r.w, h: r.h, img: r.blob
              });
            }).then(function () {
              done++;
              if (done % 5 === 0 || done === wanted.length) report('Rendering pages', done, wanted.length);
            });
          });
        });
        return chain.then(function () { meta.renderedPages = done; });
      })
      .then(function () { return put('meta', meta); })
      .then(function () { INDEX = null; return meta; });
  }

  // ---------------------------------------------------------------- index
  var INDEX = null;

  function loadIndex() {
    if (INDEX) return Promise.resolve(INDEX);
    return Promise.all([all('meta'), all('text')]).then(function (r) {
      var metas = r[0] || [], texts = r[1] || [];
      var sections = [], pageSection = Object.create(null);
      metas.forEach(function (m) {
        m.sections.forEach(function (s) {
          var rec = {
            id: m.id + '/' + s.series, manual: m.id, manualName: m.name,
            series: s.series, start: s.start, end: s.end,
            pages: s.end - s.start + 1
          };
          sections.push(rec);
          for (var p = s.start; p <= s.end; p++) pageSection[m.id + ':' + p] = rec;
        });
      });
      sections.sort(function (a, b) {
        var na = parseFloat(a.series), nb = parseFloat(b.series);
        if (isNaN(na) && isNaN(nb)) return a.series < b.series ? -1 : 1;
        if (isNaN(na)) return 1;
        if (isNaN(nb)) return -1;
        return na - nb;
      });
      INDEX = {
        manuals: metas,
        sections: sections,
        byId: sections.reduce(function (a, s) { a[s.id] = s; return a; }, Object.create(null)),
        pageSection: pageSection,
        text: texts.map(function (t) {
          return { key: t.key, manual: t.manual, page: t.page, t: t.t, low: t.t.toLowerCase() };
        })
      };
      return INDEX;
    });
  }

  function sectionKeys(sec) {
    var out = [], p;
    for (p = sec.start; p <= sec.end; p++) out.push(sec.manual + ':' + p);
    return out;
  }

  /* Search returns SERIES SECTIONS, not pages. Page text is what gets matched,
     but hits collapse onto the section the page falls in, so a term appearing
     on nine pages of Series 1400 gives one result rather than nine. Pages
     outside every series section are ignored, which keeps a passing mention in
     the design guidelines from outranking the series itself. */
  function search(q, limit) {
    return loadIndex().then(function (ix) {
      q = String(q || '').trim().toLowerCase();
      if (q.length < 2) return [];
      var terms = q.split(/\s+/).filter(Boolean);
      var qNum = (q.match(/\b(\d{2,5})\b/) || [])[1] || null;
      var acc = Object.create(null);

      ix.text.forEach(function (d) {
        var sec = ix.pageSection[d.key];
        if (!sec) return;
        var score = 0, i, first = -1;
        for (i = 0; i < terms.length; i++) {
          var at = d.low.indexOf(terms[i]);
          if (at < 0) return;                  // every term must appear on the page
          score += 1;
          if (first < 0 || at < first) first = at;
        }
        if (d.low.indexOf(q) >= 0) score += 2;
        var a = acc[sec.id] || (acc[sec.id] = { sec: sec, score: 0, hits: 0, best: -1, bestPage: 0, snippet: '' });
        a.score += score; a.hits += 1;
        if (score > a.best) { a.best = score; a.bestPage = d.page; a.snippet = snip(d.t, first); }
      });

      // a series typed as a number, or as "series 1400", is what was meant
      ix.sections.forEach(function (sec) {
        var ser = sec.series.toLowerCase();
        var exact = qNum && ser === qNum;
        var named = ('series ' + ser).indexOf(q) === 0;
        var loose = !qNum && ser.indexOf(q) === 0;
        if (!exact && !named && !loose) return;
        var a = acc[sec.id] || (acc[sec.id] = { sec: sec, score: 0, hits: 0, best: -1, bestPage: sec.start, snippet: '' });
        a.score += 1000;                       // the named series sits above body-text matches
        a.exact = true;
        if (!a.bestPage) a.bestPage = sec.start;
      });

      var out = Object.keys(acc).map(function (k) {
        var a = acc[k];
        return {
          id: a.sec.id, manual: a.sec.manual, manualName: a.sec.manualName,
          series: a.sec.series, start: a.sec.start, end: a.sec.end, pages: a.sec.pages,
          hits: a.hits, score: a.score, exact: !!a.exact,
          bestPage: a.bestPage || a.sec.start, snippet: a.snippet
        };
      });
      out.sort(function (a, b) { return b.score - a.score || a.start - b.start; });
      return out.slice(0, limit || 40);
    });
  }

  function snip(text, at) {
    if (at < 0) at = 0;
    var s = Math.max(0, at - 60), e = Math.min(text.length, at + 140);
    return (s > 0 ? '\u2026' : '') + text.slice(s, e).replace(/\s+/g, ' ').trim() +
           (e < text.length ? '\u2026' : '');
  }

  /* series -> the pages of its section. Whole sections only. */
  function pagesForSeries(series) {
    return loadIndex().then(function (ix) {
      series = String(series == null ? '' : series).trim();
      if (!series) return [];
      var hits = [];
      ix.sections.forEach(function (s) {
        if (s.series !== series) return;
        for (var p = s.start; p <= s.end; p++) {
          hits.push({ manual: s.manual, page: p, series: s.series, sectionId: s.id });
        }
      });
      return hits;
    });
  }

  function sectionsForSeries(series) {
    return loadIndex().then(function (ix) {
      series = String(series == null ? '' : series).trim();
      return ix.sections.filter(function (s) { return s.series === series; });
    });
  }

  // ---------------------------------------------------------------- images
  function pageImage(key) {
    return get('pages', key).then(function (r) { return r || null; });
  }
  function blobToDataURI(b) {
    if (typeof b === 'string') return Promise.resolve(b);   // already a data URI
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(b);
    }).catch(function (e) {
      // a blob that came back from storage can belong to a different realm and
      // be rejected by FileReader - fall back to reading the bytes directly
      if (!b || typeof b.arrayBuffer !== 'function') throw e;
      return b.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf), bin = '', i;
        for (i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return 'data:' + (b.type || 'image/jpeg') + ';base64,' + btoa(bin);
      });
    });
  }

  // ---------------------------------------------------------------- share
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* Pages are grouped under one heading per series section, so a shared
     document reads as "Series 1400" followed by its pages rather than as a run
     of separately captioned images. */
  function buildPagesHTML(keys, opts) {
    opts = opts || {};
    return loadIndex().then(function (ix) {
      return Promise.all(keys.map(function (k) {
        return pageImage(k).then(function (p) {
          if (!p) return null;
          return blobToDataURI(p.img).then(function (uri) {
            return { key: k, uri: uri, page: p.page, manual: p.manual, sec: ix.pageSection[k] || null };
          });
        }).catch(function (e) { console.warn('manual page', k, e); return null; });
      })).then(function (items) {
        items = items.filter(Boolean);
        var mname = {};
        ix.manuals.forEach(function (m) {
          mname[m.id] = (m.year ? m.year + ' ' : '') + 'Engineering Manual - ' + m.name;
        });
        var groups = [], cur = null;
        items.forEach(function (it) {
          var gid = it.sec ? it.sec.id : it.manual;
          if (!cur || cur.gid !== gid) {
            cur = { gid: gid, sec: it.sec, manual: it.manual, items: [] };
            groups.push(cur);
          }
          cur.items.push(it);
        });
        var body = groups.map(function (g) {
          var head = g.sec ? ('Series ' + g.sec.series) : (mname[g.manual] || g.manual);
          var range = g.sec
            ? ((mname[g.manual] || g.manual) + ', pages ' + g.sec.start + ' to ' + g.sec.end)
            : (mname[g.manual] || g.manual);
          return '<div class="grp"><div class="cap">' + esc(head) + '</div>' +
            '<div class="src">' + esc(range) + '</div>' +
            g.items.map(function (it) {
              return '<div class="pg"><img src="' + it.uri + '" alt="' +
                esc(head + ' page ' + it.page) + '">' +
                '<div class="src">Page ' + it.page + '</div></div>';
            }).join('\n') + '</div>';
        }).join('\n');
        return {
          html: wrapHTML(opts.title || 'Intralox technical data', body, items, mname),
          count: items.length,
          sections: groups.length
        };
      });
    });
  }

  function wrapHTML(title, body, items, mname) {
    var srcs = {};
    items.forEach(function (i) { srcs[i.manual] = 1; });
    var srcList = Object.keys(srcs).map(function (k) { return mname[k] || k; });
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(title) + '</title><style>' +
      'body{font-family:"Helvetica Neue",Roboto,Arial,sans-serif;color:#222222;margin:0;padding:18px;background:#FFFFFF}' +
      'h1{font-size:16pt;color:#4D4D4F;margin:0 0 4px}' +
      '.rule{height:3px;background:#ED1C24;margin:8px 0 16px}' +
      '.grp{margin:0 0 24px}' +
      '.cap{font-size:12pt;color:#4D4D4F;border-bottom:2px solid #E3F0F5;padding-bottom:4px;margin-bottom:4px}' +
      '.pg{page-break-inside:avoid;margin:10px 0 16px}' +
      '.pg img{max-width:' + SHARE_W + 'px;width:100%;height:auto;border:1px solid #CCCCCC;display:block}' +
      '.src{font-size:8.5pt;color:#4D4D4F;margin-top:4px}' +
      '.note{font-size:8.5pt;color:#4D4D4F;border-top:1px solid #E3E3E3;margin-top:18px;padding-top:10px}' +
      '</style></head><body>' +
      '<h1>' + esc(title) + '</h1><div class="rule"></div>' +
      body +
      '<div class="note">Extracted from ' + esc(srcList.join('; ')) +
      '. \u00A9 Intralox, L.L.C. Reproduced for the recipient\u2019s use with Intralox products. ' +
      'Contact Intralox for precise belt measurements and stock status before designing equipment or ordering a belt.' +
      '</div></body></html>';
  }

  function shareHTML(html, filename) {
    var blob = new Blob([html], { type: 'text/html' });
    var file = null;
    try { file = new File([blob], filename, { type: 'text/html' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      return navigator.share({ files: [file], title: filename });
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return Promise.resolve();
  }

  function safeName(s) {
    return String(s || 'Intralox').replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_|_$/g, '').slice(0, 40) || 'Intralox';
  }

  // ---------------------------------------------------------------- UI
  var $ = function (id) { return document.getElementById(id); };
  var state = { mode: 'search', sel: {}, viewer: [], vi: 0, sec: null, wired: false };

  function statusHTML() {
    return loadIndex().then(function (ix) {
      if (!ix.manuals.length) return 'No manuals loaded.';
      return ix.manuals.map(function (m) {
        var d = new Date(m.imported);
        var warn = '';
        if (m.offsetDisagree) {
          warn = '<br><span class="flag">' + m.offsetDisagree + ' of ' + m.footers +
            ' pages disagreed with the page numbering. Open a section and check ' +
            'a page number before sending anything to a customer.</span>';
        }
        return '<b>' + esc(m.name) + '</b> ' + DASH + ' ' + m.physicalPages + ' pages, <b>' +
          m.sections.length + '</b> series, <b>' + m.renderedPages + '</b> page images' + warn +
          '<br>Imported ' + d.toLocaleDateString() + ' ' +
          d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
          ' <span class="lnk" data-delman="' + esc(m.id) + '">Remove</span>';
      }).join('<br><br>');
    });
  }

  function wire() {
    if (state.wired || !$('mQ')) return;
    state.wired = true;
    var t = null;
    $('mQ').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { if (state.mode === 'search') paint(); }, 140);
    });
    document.querySelectorAll('#mSeg [data-seg]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.dataset.seg;
        document.querySelectorAll('#mSeg [data-seg]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        paint();
      });
    });
    $('mClear').addEventListener('click', function () { state.sel = {}; paint(); });
    $('mShare').addEventListener('click', function () { shareSections(Object.keys(state.sel)); });
    $('mvClose').addEventListener('click', closeViewer);
    $('mvPrev').addEventListener('click', function () { step(-1); });
    $('mvNext').addEventListener('click', function () { step(1); });
    $('mvShare').addEventListener('click', function () {
      if (state.sec) shareSections([state.sec.id]);
    });
  }

  function render() { wire(); return paint(); }

  function paint() {
    return loadIndex().then(function (ix) {
      var body = $('mBody'), msg = $('mMsg');
      msg.className = 'msg';
      if (!ix.manuals.length) {
        $('mHint').textContent = '';
        msg.className = 'msg info show';
        msg.innerHTML = 'No manuals loaded yet. <span class="lnk" data-go="data">Open Data &amp; setup</span>';
        body.innerHTML = '';
        renderSel();
        return;
      }
      $('mHint').textContent = ix.manuals.map(function (m) {
        return m.name + ', ' + m.sections.length + ' series';
      }).join('   ');
      var done = (state.mode === 'browse') ? paintBrowse(ix, body) : paintSearch(ix, body);
      return Promise.resolve(done).then(renderSel);
    });
  }

  function paintBrowse(ix, body) {
    body.innerHTML = ix.sections.map(function (s) { return sectionCard(s); }).join('') ||
      '<p class="empty">No series in the loaded manuals.</p>';
    wireRows(body);
  }

  function paintSearch(ix, body) {
    var q = ($('mQ').value || '').trim();
    if (q.length < 2) {
      body.innerHTML = '<p class="empty">Type a series number, or any term, ' +
        'or use Browse to see every series.</p>';
      return;
    }
    return search(q, 40).then(function (res) {
      if (!res.length) { body.innerHTML = '<p class="empty">Nothing found for that.</p>'; return; }
      body.innerHTML = res.map(function (r) { return sectionCard(r, r.snippet, r.hits); }).join('');
      wireRows(body);
    });
  }

  function sectionCard(sec, snippet, hits) {
    var sub = sec.manualName + ', pages ' + sec.start + ' to ' + sec.end +
      ' (' + sec.pages + ' page' + (sec.pages === 1 ? '' : 's') + ')';
    return '<div class="card"><div class="pick" style="border-top:none;padding-top:0">' +
      '<input type="checkbox" data-k="' + esc(sec.id) + '"' + (state.sel[sec.id] ? ' checked' : '') + '>' +
      '<div style="flex:1;min-width:0">' +
      '<div class="nm">Series ' + esc(sec.series) + '</div>' +
      '<div class="mt">' + esc(sub) + '</div>' +
      (snippet ? '<div class="mt">' + esc(snippet) + '</div>' : '') +
      '<div class="cardbar"><button type="button" data-open="' + esc(sec.id) + '">Open section</button>' +
      (hits ? '<span class="phc">' + hits + ' page' + (hits === 1 ? '' : 's') + ' mention this</span>' : '') +
      '</div></div></div></div>';
  }

  function wireRows(body) {
    body.querySelectorAll('[data-k]').forEach(function (c) {
      c.addEventListener('change', function () {
        if (c.checked) state.sel[c.dataset.k] = 1; else delete state.sel[c.dataset.k];
        renderSel();
      });
    });
    body.querySelectorAll('[data-open]').forEach(function (d) {
      d.addEventListener('click', function () { openSection(d.dataset.open); });
    });
  }

  function renderSel() {
    var n = Object.keys(state.sel).length;
    $('mSelBar').style.display = n ? 'block' : 'none';
    $('mSelN').textContent = n + ' series selected';
  }

  // ------------------------------------------------------------ viewer
  function openSection(id, startPage) {
    return loadIndex().then(function (ix) {
      var sec = ix.byId[id];
      if (!sec) return;
      state.sec = sec;
      state.viewer = sectionKeys(sec);
      state.vi = startPage
        ? Math.max(0, Math.min(state.viewer.length - 1, startPage - sec.start))
        : 0;
      $('mview').classList.add('on');
      document.body.style.overflow = 'hidden';
      showViewer();
    });
  }
  function closeViewer() {
    if (!$('mview')) return;
    $('mview').classList.remove('on');
    document.body.style.overflow = '';
    var img = $('mvImg');
    if (img && img._url) { URL.revokeObjectURL(img._url); img._url = null; }
  }
  function step(d) {
    state.vi = Math.max(0, Math.min(state.viewer.length - 1, state.vi + d));
    showViewer();
  }
  function showViewer() {
    var key = state.viewer[state.vi], img = $('mvImg'), sec = state.sec;
    $('mvTtl').textContent = 'Series ' + sec.series;
    $('mvSub').textContent = 'Page ' + (sec.start + state.vi) +
      ' of ' + sec.start + ' to ' + sec.end;
    $('mvPrev').disabled = state.vi === 0;
    $('mvNext').disabled = state.vi >= state.viewer.length - 1;
    if (img._url) { URL.revokeObjectURL(img._url); img._url = null; }
    img.removeAttribute('src');
    pageImage(key).then(function (p) {
      if (!p) {
        $('mvSub').textContent += '  ' + DASH + '  no image stored for this page';
        return;
      }
      if (typeof p.img === 'string') { img.src = p.img; return; }
      img._url = URL.createObjectURL(p.img);
      img.src = img._url;
    }).catch(function (e) { console.error('manual page', e); });
  }

  function shareSections(ids) {
    if (!ids.length) return Promise.resolve();
    return loadIndex().then(function (ix) {
      var keys = [], names = [];
      ids.forEach(function (id) {
        var s = ix.byId[id];
        if (!s) return;
        names.push(s.series);
        keys = keys.concat(sectionKeys(s));
      });
      if (!keys.length) return;
      return buildPagesHTML(keys, { title: 'Intralox technical data' }).then(function (r) {
        if (!r.count) {
          if (window.toast) window.toast('Those pages have no stored image - re-import the manual');
          return;
        }
        return shareHTML(r.html, 'Intralox_Series_' + safeName(names.join('_')) + '.html');
      });
    }).catch(function (e) {
      console.error('share', e);
      if (window.toast) window.toast('Share failed: ' + e.message);
    });
  }

  // ---------------------------------------------------------------- API
  window.Manuals = {
    render: render,
    statusHTML: statusHTML,
    refresh: function () { INDEX = null; },
    closeViewer: closeViewer,
    importManual: importManual,
    listManuals: function () { return all('meta'); },
    deleteManual: function (id) { return delManual(id).then(function () { INDEX = null; }); },
    search: search,
    pagesForSeries: pagesForSeries,
    sectionsForSeries: sectionsForSeries,
    openSection: openSection,
    buildPagesHTML: buildPagesHTML,
    shareHTML: shareHTML,
    safeName: safeName,
    estimateSize: function (meta, mode) { return pagesToRender(meta, mode).length; },
    _parse: {
      detectOffset: detectOffset, parseTOC: parseTOC, buildSections: buildSections,
      identify: identify, pagesToRender: pagesToRender, snip: snip,
      wrapHTML: wrapHTML, safeName: safeName, pageLinesFrom: pageLinesFrom
    }
  };
})();
