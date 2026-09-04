/* Belt Call Log - offline engineering manual library.
   Self-contained: own IndexedDB database, own screens, own styles.
   Depends on nothing in app.js. app.js may call the window.Manuals API (see bottom).

   Storage is a SEPARATE database (beltmanuals) on purpose:
   - page images are large and must not sit alongside the calls
   - it needs no coordination with app.js's DB_VER, so adding this cannot
     trigger an upgrade of the beltcall database and cannot lose calls
*/
(function () {
  'use strict';

  var MDB = 'beltmanuals', MDB_VER = 1;
  var PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  var RENDER_W = 1240;     // long-edge px for stored page images
  var RENDER_Q = 0.72;     // jpeg quality
  var SHARE_W = 1240;      // images are reused as-is in shared HTML

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
  // Everything below is generic. No manual name, page number or series list is
  // hard-coded, so a 2027 edition imports without a code change.

  var LEAD = /^(\d{1,4})\s+(\S.{4,68}\S)$/;
  var TRAIL = /^(\S.{4,68}\S)\s+(\d{1,4})$/;
  var SER = /^SERIES\s+([0-9]+|[A-Z][A-Z0-9\-]{2,})$/;
  var TOC_LINE = /^(.*?)\.{4,}\s*(\d{1,4})\s*$/;

  // Page text arrives from pdf.js already split per physical page, so page
  // boundaries are known. The footer scan exists only to learn the offset
  // between the printed page number and the physical page index.
  function detectOffset(pageLines) {
    var byStem = Object.create(null), i, j, s, m;
    for (i = 0; i < pageLines.length; i++) {
      for (j = 0; j < pageLines[i].length; j++) {
        s = pageLines[i][j].trim();
        if (s.length < 7 || s.length > 79) continue;
        m = LEAD.exec(s);
        if (m) (byStem[m[2]] = byStem[m[2]] || []).push([i + 1, +m[1]]);
        m = TRAIL.exec(s);
        if (m) (byStem[m[1]] = byStem[m[1]] || []).push([i + 1, +m[2]]);
      }
    }
    var best = null, bestScore = 0;
    Object.keys(byStem).forEach(function (stem) {
      var hits = byStem[stem];
      if (hits.length < 20) return;
      var nums = hits.map(function (h) { return h[1]; }), inc = 0, k;
      for (k = 1; k < nums.length; k++) if (nums[k] === nums[k - 1] + 1) inc++;
      var span = Math.max.apply(null, nums) - Math.min.apply(null, nums) + 1;
      var uniq = Object.keys(nums.reduce(function (a, n) { a[n] = 1; return a; }, {})).length;
      var score = (inc / Math.max(1, nums.length - 1)) * (uniq / span);
      if (score > bestScore) { bestScore = score; best = hits; }
    });
    if (!best) return { offset: 0, confidence: 0, stem: null };
    // offset = physical - printed, taken as the modal value
    var counts = {}, top = 0, off = 0;
    best.forEach(function (h) {
      var d = h[0] - h[1];
      counts[d] = (counts[d] || 0) + 1;
      if (counts[d] > top) { top = counts[d]; off = d; }
    });
    return { offset: off, confidence: top / best.length, footers: best.length };
  }

  function parseTOC(pageLines, limitPages) {
    var out = [], i, j, m;
    for (i = 0; i < Math.min(limitPages, pageLines.length); i++) {
      for (j = 0; j < pageLines[i].length; j++) {
        m = TOC_LINE.exec(pageLines[i][j].trim());
        if (m && m[1]) out.push({ title: m[1].trim(), page: +m[2] });
      }
    }
    return out;
  }

  function headerRuns(pageLines, offset) {
    // physical index i -> printed page (i+1) - offset
    var runs = Object.create(null), i, j, m, ls, ser, style;
    for (i = 0; i < pageLines.length; i++) {
      ls = pageLines[i].filter(function (x) { return x.trim(); }).map(function (x) { return x.trim(); });
      ser = null; style = '';
      for (j = 0; j < Math.min(4, ls.length); j++) {
        m = SER.exec(ls[j]);
        if (m) { ser = m[1]; style = ls[j + 1] || ''; break; }
      }
      if (!ser) continue;
      var printed = (i + 1) - offset;
      (runs[ser] = runs[ser] || []).push({ page: printed, style: style });
    }
    return runs;
  }

  function cleanStyle(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 70) return '';
    if (/^(in mm|[0-9.]|A strength)/.test(s)) return '';
    if (/^[A-Z][A-Z \-]{4,}$/.test(s)) return '';   // another running header, not a style
    return s;
  }

  // Builds sections from the TOC, corrects the header/TOC shift, attaches styles.
  function buildSections(toc, runs) {
    var serToc = [], i, m;
    for (i = 0; i < toc.length; i++) {
      m = SER.exec(toc[i].title);
      if (m) serToc.push({ series: m[1], page: toc[i].page, next: (toc[i + 1] ? toc[i + 1].page : null) });
    }
    // modal shift between header runs and the TOC
    var counts = {}, top = 0, shift = 0;
    serToc.forEach(function (s) {
      var r = runs[s.series];
      if (!r) return;
      var d = Math.min.apply(null, r.map(function (x) { return x.page; })) - s.page;
      counts[d] = (counts[d] || 0) + 1;
      if (counts[d] > top) { top = counts[d]; shift = +d; }
    });
    var agreed = top, ofTotal = serToc.length;

    var sections = serToc.map(function (s) {
      var r = (runs[s.series] || []).map(function (x) {
        return { page: x.page - shift, style: cleanStyle(x.style) };
      });
      var styles = {};
      r.forEach(function (x) {
        if (!x.style) return;
        (styles[x.style] = styles[x.style] || []).push(x.page);
      });
      return {
        series: s.series,
        start: s.page,
        end: s.next ? s.next - 1 : s.page,
        styles: styles
      };
    });
    return { sections: sections, shift: shift, agreed: agreed, ofTotal: ofTotal };
  }

  // ---------------------------------------------------------------- import
  var pdfjsLib = null;
  function loadPdfJs() {
    if (pdfjsLib) return Promise.resolve(pdfjsLib);
    if (window.pdfjsLib) { pdfjsLib = window.pdfjsLib; pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return Promise.resolve(pdfjsLib); }
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

  // lines: flat array of text lines from the first few pages. Matching is done
  // per line so the title cannot run on into the body text that follows it.
  function identify(lines) {
    if (typeof lines === 'string') lines = lines.split('\n');
    var cands = [], year = '', i, m, s;
    for (i = 0; i < lines.length; i++) {
      s = String(lines[i]).replace(/\s+/g, ' ').trim();
      if (!year) { m = /((?:19|20)\d{2})\s+ENGINEERING MANUAL/i.exec(s); if (m) year = m[1]; }
      // running footer: "2026 Engineering Manual-ThermoDrive Technology 27"
      m = /ENGINEERING MANUAL\s*[-\u2013\u2014]\s*(\S.{2,44}?)(?:\s+\d{1,4})?$/i.exec(s);
      if (m) { cands.push(m[1].trim()); continue; }
      // cover page: the title sits on the line after "ENGINEERING MANUAL"
      if (/^(?:(?:19|20)\d{2}\s+)?ENGINEERING MANUAL$/i.test(s)) {
        var nxt = String(lines[i + 1] || '').replace(/\s+/g, ' ').trim();
        if (nxt && nxt.length <= 45 && /[A-Za-z]/.test(nxt)) cands.push(nxt);
      }
    }
    // the footer carries the brand's own capitalisation (ThermoDrive), the
    // cover is set in all caps - prefer a mixed-case candidate where there is one
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

  function pageLinesFrom(textContent) {
    // group text items into visual lines by y, top of page first
    var rows = {};
    textContent.items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var y = Math.round(it.transform[5]);
      var k = Math.round(y / 4) * 4;
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

  /* mode: 'datasheets' | 'series' | 'full'
     onProgress(stage, done, total) */
  function importManual(file, mode, onProgress) {
    var report = function (s, d, t) { if (onProgress) onProgress(s, d, t); };
    var doc, pageLines = [], meta = null;

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
        var head = pageLines.slice(0, 4).map(function (l) { return l.join(' '); }).join(' ');
        var ident = identify(head);
        var off = detectOffset(pageLines);
        var toc = parseTOC(pageLines, 8);
        var runs = headerRuns(pageLines, off.offset);
        var built = buildSections(toc, runs);
        if (!built.sections.length) {
          throw new Error('no belt series sections were found in this file - is it an Intralox engineering manual?');
        }
        meta = {
          id: ident.id, name: ident.name, year: ident.year,
          file: file.name, physicalPages: doc.numPages,
          offset: off.offset, offsetConfidence: off.confidence,
          shift: built.shift, sectionsAgreed: built.agreed, sectionsTotal: built.ofTotal,
          sections: built.sections, mode: mode, imported: Date.now(), renderedPages: 0
        };
        // text index for every page, regardless of render mode
        return putMany('text', pageLines.map(function (ls, i) {
          return { key: meta.id + ':' + ((i + 1) - meta.offset), manual: meta.id,
                   page: (i + 1) - meta.offset, t: ls.join('\n') };
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
              return put('pages', { key: meta.id + ':' + printed, manual: meta.id,
                                    page: printed, w: r.w, h: r.h, img: r.blob });
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

  function pagesToRender(meta, mode) {
    var set = Object.create(null);
    if (mode === 'full') {
      for (var i = 1; i <= meta.physicalPages; i++) set[i - meta.offset] = 1;
    } else {
      meta.sections.forEach(function (s) {
        if (mode === 'series') {
          for (var p = s.start; p <= s.end; p++) set[p] = 1;
        } else {
          Object.keys(s.styles).forEach(function (k) {
            s.styles[k].forEach(function (p) { set[p] = 1; });
          });
        }
      });
    }
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  // ---------------------------------------------------------------- index + search
  var INDEX = null;   // { manuals:[meta], text:[{key,manual,page,low}], bySeries:{} }

  function loadIndex() {
    if (INDEX) return Promise.resolve(INDEX);
    return Promise.all([all('meta'), all('text')]).then(function (r) {
      var metas = r[0] || [], texts = r[1] || [];
      var bySeries = Object.create(null);
      metas.forEach(function (m) {
        m.sections.forEach(function (s) {
          (bySeries[s.series] = bySeries[s.series] || []).push({ manual: m.id, section: s });
        });
      });
      // style code (S4009 etc) -> pages, for series that are styles of another series
      var byStyleCode = Object.create(null);
      metas.forEach(function (m) {
        m.sections.forEach(function (s) {
          Object.keys(s.styles).forEach(function (name) {
            var mm = /^S(\d+)\b/.exec(name);
            if (!mm) return;
            s.styles[name].forEach(function (p) {
              (byStyleCode[mm[1]] = byStyleCode[mm[1]] || []).push(
                { manual: m.id, parentSeries: s.series, page: p, style: name });
            });
          });
        });
      });
      // page -> label, for search results and share captions
      var label = Object.create(null);
      metas.forEach(function (m) {
        m.sections.forEach(function (s) {
          for (var p = s.start; p <= s.end; p++) label[m.id + ':' + p] = { series: s.series, style: '' };
          Object.keys(s.styles).forEach(function (name) {
            s.styles[name].forEach(function (p) { label[m.id + ':' + p] = { series: s.series, style: name }; });
          });
        });
      });
      INDEX = {
        manuals: metas,
        text: texts.map(function (t) { return { key: t.key, manual: t.manual, page: t.page, t: t.t, low: t.t.toLowerCase() }; })
                   .sort(function (a, b) { return a.manual < b.manual ? -1 : a.manual > b.manual ? 1 : a.page - b.page; }),
        bySeries: bySeries, byStyleCode: byStyleCode, label: label
      };
      return INDEX;
    });
  }

  function search(q, limit) {
    return loadIndex().then(function (ix) {
      q = String(q || '').trim().toLowerCase();
      if (q.length < 2) return [];
      var terms = q.split(/\s+/).filter(Boolean);
      var out = [];
      ix.text.forEach(function (d) {
        var score = 0, i, first = -1;
        for (i = 0; i < terms.length; i++) {
          var at = d.low.indexOf(terms[i]);
          if (at < 0) return;                     // all terms must appear
          score += 1;
          if (at < 400) score += 1;               // near the top of the page
          if (first < 0 || at < first) first = at;
        }
        if (d.low.indexOf(q) >= 0) score += 3;    // whole phrase
        var lab = ix.label[d.key];
        if (lab && lab.style && lab.style.toLowerCase().indexOf(q) >= 0) score += 6;
        if (lab && ('series ' + lab.series).indexOf(q) >= 0) score += 4;
        out.push({ key: d.key, manual: d.manual, page: d.page, score: score,
                   label: lab || null, snippet: snip(d.t, first) });
      });
      out.sort(function (a, b) { return b.score - a.score || a.page - b.page; });
      return out.slice(0, limit || 60);
    });
  }

  function snip(text, at) {
    if (at < 0) at = 0;
    var s = Math.max(0, at - 60), e = Math.min(text.length, at + 140);
    return (s > 0 ? '\u2026' : '') + text.slice(s, e).replace(/\s+/g, ' ').trim() + (e < text.length ? '\u2026' : '');
  }

  // series (or style code) -> pages, for the belt specification hook
  function pagesForSeries(series, style) {
    return loadIndex().then(function (ix) {
      series = String(series == null ? '' : series).trim();
      if (!series) return [];
      var hits = [];
      (ix.bySeries[series] || []).forEach(function (h) {
        var chosen = null;
        if (style) {
          Object.keys(h.section.styles).forEach(function (name) {
            if (!chosen && norm(name) === norm(style)) chosen = h.section.styles[name];
          });
          if (!chosen) Object.keys(h.section.styles).forEach(function (name) {
            if (!chosen && norm(name).indexOf(norm(style)) >= 0) chosen = h.section.styles[name];
          });
        }
        if (chosen) {
          chosen.forEach(function (p) { hits.push({ manual: h.manual, page: p, why: 'style' }); });
        } else {
          for (var p = h.section.start; p <= h.section.end; p++) hits.push({ manual: h.manual, page: p, why: 'section' });
        }
      });
      if (!hits.length && ix.byStyleCode[series]) {
        ix.byStyleCode[series].forEach(function (h) {
          hits.push({ manual: h.manual, page: h.page, why: 'styleCode', style: h.style, parentSeries: h.parentSeries });
        });
      }
      return hits;
    });
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

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

  function buildPagesHTML(keys, opts) {
    opts = opts || {};
    return loadIndex().then(function (ix) {
      return Promise.all(keys.map(function (k) {
        return pageImage(k).then(function (p) {
          if (!p) return null;
          return blobToDataURI(p.img).then(function (uri) {
            var lab = ix.label[k] || {};
            return { key: k, uri: uri, page: p.page, manual: p.manual,
                     series: lab.series || '', style: lab.style || '' };
          });
        });
      })).then(function (items) {
        items = items.filter(Boolean);
        var mname = {};
        ix.manuals.forEach(function (m) { mname[m.id] = (m.year ? m.year + ' ' : '') + 'Engineering Manual - ' + m.name; });
        var body = items.map(function (it) {
          var cap = [it.series ? 'Series ' + it.series : '', it.style].filter(Boolean).join(' \u2014 ');
          return '<div class="pg">' +
            (cap ? '<div class="cap">' + esc(cap) + '</div>' : '') +
            '<img src="' + it.uri + '" alt="' + esc(cap || ('page ' + it.page)) + '">' +
            '<div class="src">' + esc(mname[it.manual] || it.manual) + ', page ' + it.page + '</div>' +
            '</div>';
        }).join('\n');
        return { html: wrapHTML(opts.title || 'Intralox technical data', body, items, mname), count: items.length };
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
      '.pg{page-break-inside:avoid;margin:0 0 26px}' +
      '.cap{font-size:11pt;color:#4D4D4F;border-bottom:2px solid #E3F0F5;padding-bottom:4px;margin-bottom:8px}' +
      '.pg img{max-width:' + SHARE_W + 'px;width:100%;height:auto;border:1px solid #CCCCCC}' +
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
    return String(s || 'Intralox').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'Intralox';
  }

  // ---------------------------------------------------------------- UI
  /* The manuals screen and viewer are declared in index.html so they use the
     app's own classes. Nothing is injected here. */

  var $ = function (id) { return document.getElementById(id); };
  var state = { mode: 'search', series: null, sel: {}, viewer: [], vi: 0, wired: false };

  function manualLabel(m) {
    return (m.year ? m.year + ' ' : '') + 'Engineering Manual - ' + m.name;
  }

  function statusHTML() {
    return loadIndex().then(function (ix) {
      if (!ix.manuals.length) return 'No manuals loaded.';
      return ix.manuals.map(function (m) {
        var d = new Date(m.imported);
        var styles = m.sections.reduce(function (a, s) { return a + Object.keys(s.styles).length; }, 0);
        return '<b>' + esc(m.name) + '</b> ' + DASH + ' ' + m.physicalPages + ' pages, <b>' +
          m.sections.length + '</b> series, ' + styles + ' datasheets, <b>' + m.renderedPages +
          '</b> page images<br>Imported ' + d.toLocaleDateString() + ' ' +
          d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
          ' <span class="lnk" data-delman="' + esc(m.id) + '">Remove</span>';
      }).join('<br><br>');
    });
  }
  var DASH = '\u2014';

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
        state.mode = b.dataset.seg; state.series = null;
        document.querySelectorAll('#mSeg [data-seg]').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        paint();
      });
    });
    $('mClear').addEventListener('click', function () { state.sel = {}; paint(); });
    $('mShare').addEventListener('click', function () { doShare(Object.keys(state.sel)); });
    $('mvClose').addEventListener('click', closeViewer);
    $('mvPrev').addEventListener('click', function () { step(-1); });
    $('mvNext').addEventListener('click', function () { step(1); });
    $('mvShare').addEventListener('click', function () {
      if (state.viewer[state.vi]) doShare([state.viewer[state.vi]]);
    });
  }

  function render() {
    wire();
    return paint();
  }

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
      if (state.mode === 'browse') paintBrowse(ix, body);
      else paintSearch(ix, body);
      renderSel();
    });
  }

  function paintSearch(ix, body) {
    var q = ($('mQ').value || '').trim();
    if (q.length < 2) {
      body.innerHTML = '<p class="empty">Type at least two characters, or browse by series.</p>';
      return;
    }
    return search(q, 60).then(function (res) {
      if (!res.length) { body.innerHTML = '<p class="empty">Nothing found for that.</p>'; return; }
      body.innerHTML = res.map(function (r) { return hitCard(r.key, r.label, r.manual, r.page, r.snippet); }).join('');
      wireRows(body);
    });
  }

  function paintBrowse(ix, body) {
    if (!state.series) {
      var keys = Object.keys(ix.bySeries).sort(function (a, b) {
        var na = parseFloat(a), nb = parseFloat(b);
        if (isNaN(na) && isNaN(nb)) return a < b ? -1 : 1;
        if (isNaN(na)) return 1;
        if (isNaN(nb)) return -1;
        return na - nb;
      });
      body.innerHTML = '<div class="chips" id="mSerChips">' + keys.map(function (k) {
        return '<button type="button" data-ser="' + esc(k) + '">' + esc(k) + '</button>';
      }).join('') + '</div>';
      body.querySelectorAll('[data-ser]').forEach(function (b) {
        b.addEventListener('click', function () { state.series = b.dataset.ser; paint(); });
      });
      return;
    }
    var out = ['<button class="linkbtn" id="mBack">All series</button>'];
    (ix.bySeries[state.series] || []).forEach(function (h) {
      var s = h.section;
      out.push('<p class="hint">' + esc(h.manual) + ', pages ' + s.start + ' to ' + s.end + '</p>');
      var names = Object.keys(s.styles).sort();
      if (!names.length) {
        out.push('<p class="empty">No separate datasheet pages in this section &mdash; ' +
                 'open the section pages from a search instead.</p>');
      }
      names.forEach(function (n) {
        s.styles[n].forEach(function (p) {
          out.push(hitCard(h.manual + ':' + p, { series: state.series, style: n }, h.manual, p, ''));
        });
      });
    });
    body.innerHTML = out.join('');
    $('mBack').addEventListener('click', function () { state.series = null; paint(); });
    wireRows(body);
  }

  function hitCard(key, lab, manual, page, snippet) {
    lab = lab || {};
    var head = [lab.series ? 'Series ' + lab.series : '', lab.style].filter(Boolean).join(' ' + DASH + ' ') ||
               (manual + ' page ' + page);
    return '<div class="card"><div class="pick" style="border-top:none;padding-top:0">' +
      '<input type="checkbox" data-k="' + esc(key) + '"' + (state.sel[key] ? ' checked' : '') + '>' +
      '<div style="flex:1;min-width:0">' +
      '<div class="nm">' + esc(head) + '</div>' +
      (snippet ? '<div class="mt">' + esc(snippet) + '</div>' : '') +
      '<div class="cardbar"><button type="button" data-open="' + esc(key) + '">Open page ' + page + '</button>' +
      '<span class="phc">' + esc(manual) + '</span></div>' +
      '</div></div></div>';
  }

  function wireRows(body) {
    body.querySelectorAll('[data-k]').forEach(function (c) {
      c.addEventListener('change', function () {
        if (c.checked) state.sel[c.dataset.k] = 1; else delete state.sel[c.dataset.k];
        renderSel();
      });
    });
    var keys = [].map.call(body.querySelectorAll('[data-open]'), function (x) { return x.dataset.open; });
    body.querySelectorAll('[data-open]').forEach(function (d) {
      d.addEventListener('click', function () { openViewer(keys, keys.indexOf(d.dataset.open)); });
    });
  }

  function renderSel() {
    var n = Object.keys(state.sel).length;
    $('mSelBar').style.display = n ? 'block' : 'none';
    $('mSelN').textContent = n + (n === 1 ? ' page selected' : ' pages selected');
  }

  function openViewer(keys, i) {
    state.viewer = keys; state.vi = i < 0 ? 0 : i;
    $('mview').classList.add('on');
    document.body.style.overflow = 'hidden';
    showViewer();
  }
  function closeViewer() {
    $('mview').classList.remove('on');
    document.body.style.overflow = '';
    var img = $('mvImg');
    if (img._url) { URL.revokeObjectURL(img._url); img._url = null; }
  }
  function step(d) {
    state.vi = Math.max(0, Math.min(state.viewer.length - 1, state.vi + d));
    showViewer();
  }
  function showViewer() {
    var key = state.viewer[state.vi], img = $('mvImg');
    $('mvSub').textContent = (state.vi + 1) + ' of ' + state.viewer.length;
    $('mvPrev').disabled = state.vi === 0;
    $('mvNext').disabled = state.vi >= state.viewer.length - 1;
    loadIndex().then(function (ix) {
      var lab = ix.label[key] || {};
      $('mvTtl').textContent =
        [lab.series ? 'Series ' + lab.series : '', lab.style].filter(Boolean).join(' ' + DASH + ' ') || key;
      return pageImage(key);
    }).then(function (p) {
      if (img._url) { URL.revokeObjectURL(img._url); img._url = null; }
      if (!p) {
        img.removeAttribute('src');
        $('mvSub').textContent += '  ' + DASH + '  no image stored for this page';
        return;
      }
      if (typeof p.img === 'string') { img.src = p.img; return; }
      img._url = URL.createObjectURL(p.img);
      img.src = img._url;
    }).catch(function (e) { console.error('manual page', e); });
  }

  function doShare(keys) {
    if (!keys.length) return Promise.resolve();
    return buildPagesHTML(keys, { title: 'Intralox technical data' }).then(function (r) {
      if (!r.count) {
        if (window.toast) window.toast('Those pages have no stored image - re-import with a wider page range');
        return;
      }
      return shareHTML(r.html, 'Intralox_technical_data_' + r.count + 'pp.html');
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
    buildPagesHTML: buildPagesHTML,
    shareHTML: shareHTML,
    safeName: safeName,
    estimateSize: function (meta, mode) { return pagesToRender(meta, mode).length; },
    _parse: { detectOffset: detectOffset, parseTOC: parseTOC, headerRuns: headerRuns,
              buildSections: buildSections, cleanStyle: cleanStyle, identify: identify,
              pagesToRender: pagesToRender, snip: snip, wrapHTML: wrapHTML, safeName: safeName }
  };
})();
