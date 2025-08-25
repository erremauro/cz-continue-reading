/* CZ Continue Reading – Front-end (v1.3.0)
 * - Deep-link resume only via ?czcr_pos=NN
 * - Throttled saves
 * - Fill-forward multi-page
 * - Dwell-per-decrease + top no-save zone (con isteresi sul fondo)
 * - Floating toolbar che appare quando l'header esce dal viewport
 */
(function () {
  'use strict';
  if (!window.CZCR) return;

  const cfg = window.CZCR;

  // === DEBUG TOOLS ===========================================================
  const DEBUG = (() => {
    try {
      const qp = new URLSearchParams(location.search);
      if (qp.get('czcr_debug') === '1') return true;
      return localStorage.getItem('czcr_debug') === '1';
    } catch { return false; }
  })();

  const dlog = DEBUG ? (...a)=>console.debug('[CZCR]', ...a) : ()=>{};
  const dgroup = DEBUG ? (l)=>console.group('[CZCR]', l) : ()=>{};
  const dgroupEnd = DEBUG ? ()=>console.groupEnd() : ()=>{};

  if (DEBUG) {
    window.CZCR_DEBUG = {
      on: true,
      off(){ try{localStorage.removeItem('czcr_debug');}catch{}; console.info('[CZCR] debug OFF (reload)'); },
      onNow(){ try{localStorage.setItem('czcr_debug','1');}catch{}; console.info('[CZCR] debug ON (reload)'); }
    };
    dgroup('BOOT');
    dlog('version', cfg.version, 'logged?', !!(cfg.user&&cfg.user.loggedIn));
    dlog('postCtx', cfg.post || null);
    dlog('urls', cfg.urls);
    dgroupEnd();
  }

  const isLogged   = !!(cfg.user && cfg.user.loggedIn);
  const storageKey = cfg.storageKey || 'czcr_progress_v1';

  const SAVE_STEP          = typeof cfg.saveStep === 'number'        ? cfg.saveStep        : 1;
  const THROTTLE_MS        = typeof cfg.throttleMs === 'number'      ? cfg.throttleMs      : 300;
  const DECREASE_DWELL_MS  = typeof cfg.decreaseDwellMs === 'number' ? cfg.decreaseDwellMs : 1200;
  const TOP_NO_SAVE_RATIO  = typeof cfg.topNoSaveRatio === 'number'  ? cfg.topNoSaveRatio  : 0.15;
  const PEAK_GUARD_RATIO   = typeof cfg.peakGuardRatio  === 'number' ? cfg.peakGuardRatio  : 0.50;

  /* ---------- Storage ---------- */
  const readLocal   = () => { try { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : {}; } catch { return {}; } };
  const writeLocal  = (obj) => { try { localStorage.setItem(storageKey, JSON.stringify(obj || {})); } catch {} };
  const removeLocal = ()   => { try { localStorage.removeItem(storageKey); } catch {} };

  /* ---------- REST ---------- */
  async function apiFetch(path, { method = 'GET', body } = {}) {
    const root = (cfg.rest && cfg.rest.root) ? cfg.rest.root : '';
    const url  = (root.endsWith('/') ? root : root + '/') + String(path || '').replace(/^\/+/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.rest && cfg.rest.nonce) headers['X-WP-Nonce'] = cfg.rest.nonce;

    if (DEBUG) dlog('API →', method, url, body ? {body} : '(no body)');
    const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
    let outText = '';
    try { outText = await res.text(); } catch {}
    if (DEBUG) dlog('API ←', res.status, outText);

    if (!res.ok) throw new Error(`API ${method} ${url} failed: ${res.status}`);
    try { return outText ? JSON.parse(outText) : {}; } catch { return {}; }
  }

  /* ---------- Utils ---------- */
  const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
  const roundToStep = (v,step)=>Math.floor(v/step)*step;

  function throttle(fn, wait) {
    let last=0, t=null, la, lt;
    const call=()=>{ last=Date.now(); t=null; fn.apply(lt,la); la=lt=null; };
    return function(...args){ const now=Date.now(), rem=wait-(now-last); la=args; lt=this;
      if (rem<=0 || rem>wait){ if(t){clearTimeout(t); t=null;} call(); } else if(!t){ t=setTimeout(call, rem); }
    };
  }

  let __lastDocH = -1;
  function docHeights() {
    const doc = document.documentElement;
    const h = Math.max(doc.scrollHeight, document.body.scrollHeight);
    if (DEBUG && h !== __lastDocH) {
      dlog('docHeights changed', { h, innerH: window.innerHeight, scrollY: window.scrollY });
      __lastDocH = h;
    }
    return h;
  }
  if (DEBUG && 'ResizeObserver' in window) {
    const ro = new ResizeObserver(()=>docHeights());
    try { ro.observe(document.documentElement); ro.observe(document.body); } catch {}
  }

  // UI minimale per il prompt
  function renderResumePrompt({ onResume, onStartOver }) {
    const wrap = document.createElement('div');
    wrap.className = 'czcr-resume-modal';
    wrap.innerHTML = `
      <div class="czcr-resume-backdrop" role="presentation"></div>
      <div class="czcr-resume-dialog" role="dialog" aria-labelledby="czcr-resume-title" aria-modal="true">
        <h3 id="czcr-resume-title">Continua a leggere</h3>
        <p>Vuoi continuare da dove avevi interrotto?</p>
        <div class="czcr-resume-actions">
          <button type="button" class="czcr-btn czcr-btn-primary" data-act="resume">Continua</button>
          <button type="button" class="czcr-btn" data-act="start">Annulla</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.querySelector('[data-act="resume"]').addEventListener('click', () => { try { onResume(); } finally { close(); } });
    wrap.querySelector('[data-act="start"]').addEventListener('click', () => { try { onStartOver(); } finally { close(); } });
  }

  async function maybeOfferResume(postCtx) {
    // Recupera record: server per loggati, LS per ospiti
    let rec = null;
    if (isLogged) {
      try {
        const prog = await apiFetch('/progress');
        rec = prog && prog[postCtx.id];
      } catch {}
    } else {
      const store = readLocal();
      rec = store && store[postCtx.id];
    }
    if (!rec) return;

    const lp = Number(rec.last_page || 1);
    const total = Number(rec.total_pages || 1);
    const pages = rec.pages || {};
    const pct   = clamp(Number(pages[lp] || 0), 0, 100);
    const overall = clamp(Number(rec.percent_overall || 0), 0, 100);

    // Solo se “in corso” (0<overall<100) e con posizione significativa
    if (!(overall > 0 && overall < 100)) return;
    if (pct < 5) return; // troppo vicino all’inizio → inutile proporre

    // Se siamo già nella pagina giusta ma molto lontani dalla posizione, proponi
    const currentPage = Number(postCtx.currentPage || 1);
    const needPageJump = (lp !== currentPage);

    // Non proporre se la posizione è praticamente raggiunta
    const contentH = docHeights();
    const centerY = window.scrollY + window.innerHeight/2;
    const currentPct = clamp((centerY / Math.max(1, contentH)) * 100, 0, 100);
    if (!needPageJump && Math.abs(currentPct - pct) < 5) return;

    // Offri la ripresa
    renderResumePrompt({
      onResume: () => {
        try { sessionStorage.setItem(seenKey, '1'); } catch {}
        if (needPageJump) {
          // vai alla pagina corretta senza leak posizione
          const base = (postCtx.permalink || '').replace(/\/?$/, '/');
          const url  = (lp > 1) ? (base + String(lp) + '/') : base;
          window.location.href = url;
        } else {
          // stessa pagina: scroll alla percentuale
          scrollToPercent(pct);
        }
      },
      onStartOver: () => {
        try { sessionStorage.setItem(seenKey, '1'); } catch {}
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }



  /* ---------- Deep-link only ---------- */
  function scrollToPercent(percent) {
    const contentHeight = docHeights();
    const targetCenter  = clamp((percent/100)*contentHeight, 0, contentHeight);
    const y = clamp(targetCenter - (window.innerHeight/2), 0, Math.max(0, contentHeight - window.innerHeight));
    window.scrollTo({ top: y, behavior: ('instant' in window) ? 'instant' : 'auto' });
  }

  /* ---------- Floating toolbar ---------- */
  function initFloatingToolbar() {
    const toolbar  = document.querySelector('.czcr-toolbar');
    if (!toolbar) return;

    const homeBtn  = toolbar.querySelector('[data-czcr-home]');
    const topBtn   = toolbar.querySelector('[data-czcr-top]');
    const headerEl = document.querySelector('header.site-header');

    if ('IntersectionObserver' in window && headerEl) {
      const io = new IntersectionObserver((entries) => {
        const entry = entries[0];
        const headerVisible = !!(entry && entry.isIntersecting && entry.intersectionRatio > 0);
        toolbar.classList.toggle('is-visible', !headerVisible);
        if (DEBUG) dlog('toolbar vis', { headerVisible, toolbarVisible: toolbar.classList.contains('is-visible') });
      }, { root: null, threshold: [0, 0.01, 1] });
      io.observe(headerEl);
    } else {
      const onScroll = () => {
        let headerVisible = false;
        if (headerEl) {
          const r = headerEl.getBoundingClientRect();
          headerVisible = (r.bottom > 0 && r.top < window.innerHeight);
        } else {
          headerVisible = (window.scrollY <= 10);
        }
        if (DEBUG) dlog('toolbar vis (fallback)', { headerVisible, scrollY: window.scrollY });
        toolbar.classList.toggle('is-visible', !headerVisible);
      };
      window.addEventListener('scroll', onScroll, { passive:true });
      window.addEventListener('resize', onScroll, { passive:true });
      onScroll();
    }

    homeBtn && homeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const url = (cfg.urls && cfg.urls.home) || '/';
      window.location.href = url;
    });
    topBtn && topBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ---------- Progress ---------- */
  function computeOverallPercent(pages, totalPages) {
    totalPages = Math.max(1, Number(totalPages) || 1);
    let acc = 0;
    for (let i = 1; i <= totalPages; i++) acc += clamp((pages[i]||0), 0, 100)/100;
    return clamp((acc/totalPages)*100, 0, 100);
  }

  function startTracking(postCtx) {
    if (DEBUG) dlog('startTracking', postCtx);
    if (!postCtx || !postCtx.id) return;

    // SALVATAGGI SOLO DOPO GESTO UTENTE
    let hasUserInteracted = false;
    const markInteracted = () => { hasUserInteracted = true; };
    window.addEventListener('scroll',     markInteracted, { passive:true, once:true });
    window.addEventListener('wheel',      markInteracted, { passive:true, once:true });
    window.addEventListener('touchstart', markInteracted, { passive:true, once:true });
    window.addEventListener('keydown',    markInteracted, {                once:true });

    // Fondo con isteresi (unica dichiarazione!)
    const BOTTOM_ENTER_MARGIN = 0;
    const BOTTOM_EXIT_MARGIN  = 120;
    let bottomLatched = false;

    let lastSavedOverall = -1;
    let locked = false;
    let maxOverallReached = 0;   // picco complessivo raggiunto
    let decStartTs = null;       // dwell per i decrementi
    let lastOverallForDwell = null;

    document.addEventListener('czcr:lock', (e) => {
      if (!e || !e.detail) return;
      if (Number(e.detail.post_id) !== Number(postCtx.id)) return;
      locked = !!e.detail.locked;
    });

    const footEl = document.querySelector(cfg.selectors.footnotes);
    const pagEl  = document.querySelector(cfg.selectors.postPagination);
    const postFooterEl = document.querySelector(cfg.selectors.postFooter);

    function isAtBottomCenter() {
      // mai 100% finché l’utente non interagisce
      if (!hasUserInteracted) { if (DEBUG) dlog('bottom? NO (no user interaction)'); return false; }

      const centerY = window.scrollY + (window.innerHeight/2);
      const docH    = docHeights();
      const isSmallPage = docH <= (window.innerHeight + 200);

      const targets = [footEl, pagEl, postFooterEl].filter(Boolean);
      let triggerTop = Infinity;

      if (postCtx.totalPages === 1) {
        const NEED_CENTER_RATIO = 0.80;
        const centerRatio = (window.scrollY + window.innerHeight/2) / Math.max(1, docH);
        if (centerRatio < NEED_CENTER_RATIO) return false;
      }


      if (targets.length) {
        // Considera come "target validi" solo quelli davvero vicini al fondo
        const MIN_TARGET_DOC_RATIO = 0.60; // 60% del documento
        const minAllowed = docH * MIN_TARGET_DOC_RATIO;

        for (const el of targets) {
          const rect = el.getBoundingClientRect();
          const topY = rect.top + window.scrollY;
          if (topY >= minAllowed && topY < triggerTop) triggerTop = topY;
        }
      }

      const canLatch = (postCtx.totalPages <= 1) ||
                       (Number(postCtx.currentPage) === Number(postCtx.totalPages));
      if (!canLatch) { if (DEBUG) dlog('bottom? NO (not last page)'); bottomLatched = false; return false; }

      // isteresi viewport
      const nearBottomEnter = (window.scrollY + window.innerHeight) >= (docH - 2);
      const nearBottomExit  = (window.scrollY + window.innerHeight) <  (docH - 40);

      // isteresi target (usa le stesse costanti di startTracking — nessun shadowing)
      const hasValidTarget = (triggerTop !== Infinity);
      const enterByTargets = hasValidTarget && (centerY >= (triggerTop + BOTTOM_ENTER_MARGIN));
      const exitByTargets  = hasValidTarget && (centerY <  (triggerTop - BOTTOM_EXIT_MARGIN));

      // su pagine corte, ignora nearBottom puro
      const enterByViewport = isSmallPage ? false : nearBottomEnter;
      const exitByViewport  = isSmallPage ? true  : nearBottomExit;

      const prev = bottomLatched;
      if (!bottomLatched) {
        if (enterByTargets || enterByViewport) bottomLatched = true;
      } else {
        if ((exitByTargets || triggerTop === Infinity) && exitByViewport) bottomLatched = false;
      }

      if (DEBUG && prev !== bottomLatched) {
        dgroup('BOTTOM LATCH CHANGE');
        dlog('latched ->', bottomLatched);
        dlog({ centerY, docH, isSmallPage, enterByTargets, exitByTargets, enterByViewport, exitByViewport, triggerTop });
        dgroupEnd();
      }
      return bottomLatched;
    }

    function currentPagePercent() {
      const centerY = window.scrollY + (window.innerHeight/2);
      let percent = (centerY / Math.max(1, docHeights())) * 100;

      if (isAtBottomCenter()) percent = 100;

      // anti-100 “a freddo” per mono-pagina
      if (postCtx.totalPages === 1 && window.scrollY < 10) {
        percent = Math.min(percent, 99.9);
      }

      if (DEBUG) dlog('currentPagePercent', { percent, scrollY: window.scrollY, innerH: window.innerHeight });
      return clamp(percent, 0, 100);
    }

    // Record iniziale
    let record;
    if (isLogged) {
      record = { post_id: postCtx.id, pages:{}, last_page:1, total_pages:postCtx.totalPages, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
    } else {
      const store = readLocal();
      record = store[postCtx.id] || { post_id: postCtx.id, pages:{}, last_page:1, total_pages:postCtx.totalPages, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
    }
    for (let i=1;i<=postCtx.totalPages;i++) if (typeof record.pages[i] !== 'number') record.pages[i]=0;
    record.total_pages = postCtx.totalPages;
    maxOverallReached  = clamp(record.percent_overall || 0, 0, 100);

    function saveIfNeeded() {
      if (!hasUserInteracted) return;
      // if (locked) return; // riabilita se vuoi bloccare salvataggi quando segnato "letto"

      const page   = Number(postCtx.currentPage) || 1;
      const inPage = currentPagePercent();

      // fill-forward per overall
      const pagesForOverall = Object.assign({}, record.pages, { [page]: inPage });
      for (let i = 1; i < page; i++) {
        if (typeof pagesForOverall[i] !== 'number' || pagesForOverall[i] < 100) pagesForOverall[i] = 100;
      }

      const overall = computeOverallPercent(pagesForOverall, record.total_pages);

      // anti-100 al load su mono-pagina (se ancora in top)
      if (postCtx.totalPages === 1 && inPage >= 100 && window.scrollY < 10) return;

      const centerRatio = (window.scrollY + window.innerHeight/2) / Math.max(1, docHeights());
      const inTopNoSaveZone =
        (centerRatio <= TOP_NO_SAVE_RATIO) &&
        (maxOverallReached >= (PEAK_GUARD_RATIO * 100));

      // Dwell-per-decrease
      let allowSave = true;
      if (overall < record.percent_overall - 0.1) {
        if (inTopNoSaveZone) {
          if (decStartTs === null) { decStartTs = performance.now(); lastOverallForDwell = overall; }
          const elapsed = performance.now() - decStartTs;
          allowSave = elapsed >= DECREASE_DWELL_MS;
        } else {
          if (lastOverallForDwell === null || overall >= lastOverallForDwell) {
            lastOverallForDwell = overall;
            decStartTs = performance.now();
            allowSave = false;
          } else {
            if (decStartTs === null) decStartTs = performance.now();
            const elapsed = performance.now() - decStartTs;
            allowSave = elapsed >= DECREASE_DWELL_MS;
          }
        }
      } else {
        decStartTs = null;
        lastOverallForDwell = null;
      }
      if (!allowSave) return;

      const rounded = roundToStep(overall, SAVE_STEP);
      if (rounded <= lastSavedOverall && inPage < 100) return;

      // commit
      record.pages[page]      = inPage;
      record.last_page        = page;
      record.percent_overall  = overall;
      record.updated_at       = new Date().toISOString();
      lastSavedOverall        = rounded;
      maxOverallReached       = Math.max(maxOverallReached, overall);

      if (DEBUG) dlog('SAVE', { page, inPage, overall, rounded, pages: record.pages });

      if (isLogged) {
        apiFetch('/progress', {
          method:'POST',
          body:{
            post_id: postCtx.id,
            pages: record.pages,
            last_page: record.last_page,
            total_pages: record.total_pages,
            status: 'reading'
          }
        }).catch(()=>{});
      } else {
        const store = readLocal();
        store[postCtx.id] = record;
        writeLocal(store);
      }
    }

    const throttledSave = throttle(saveIfNeeded, THROTTLE_MS);
    const onScroll = () => { if (isAtBottomCenter()) saveIfNeeded(); else throttledSave(); };
    const onResize = () => throttledSave();

    window.addEventListener('scroll', onScroll, { passive:true });
    window.addEventListener('resize', onResize, { passive:true });
    window.addEventListener('beforeunload', () => { try{ saveIfNeeded(); }catch{} }, { capture:true });
  }

  /* ---------- Widget vuoto / empty state ---------- */
  function updateReadingsEmptyState(wrap) {
    if (!wrap || !wrap.matches || !wrap.matches('[data-czcr-readings]')) {
      wrap = document.querySelector('[data-czcr-readings]');
    }
    if (!wrap) return;

    if (isLogged) {
      const listEl  = wrap.querySelector('ul.czcr-list');
      const isEmpty = !listEl || listEl.children.length === 0;
      if (DEBUG) dlog('updateReadingsEmptyState (logged)', { isEmpty });
      if (isEmpty) {
        if (listEl) listEl.remove();
        if (!wrap.querySelector('.czcr-empty')) {
          wrap.insertAdjacentHTML('beforeend', `<p class="czcr-empty">${cfg.i18n.no_items}</p>`);
        }
      }
    } else {
      const listEl  = wrap.querySelector('[data-czcr-guest-list]');
      const isEmpty = !listEl || listEl.children.length === 0;
      if (DEBUG) dlog('updateReadingsEmptyState (guest)', { isEmpty });
      if (isEmpty) {
        tagBodyHasGuestReadings(false);
        if (listEl) listEl.innerHTML = '';
        let msgEl = wrap.querySelector('[data-czcr-guest-msg]');
        if (!msgEl) {
          const loginUrl = (cfg.urls && cfg.urls.login)    || '#';
          const regUrl   = (cfg.urls && cfg.urls.register) || '#';
          msgEl = document.createElement('p');
          msgEl.className = 'czcr-guest-msg';
          msgEl.setAttribute('data-czcr-guest-msg', '');
          msgEl.innerHTML = `${cfg.i18n.login_to_keep_history
            .replace('Accedi', `<a href="${loginUrl}">Accedi</a>`)
            .replace('registrati', `<a href="${regUrl}">registrati</a>`)}`
          wrap.appendChild(msgEl);
        }
      }
    }
  }

  /* ---------- Mark toggles ---------- */
  function bindMarkToggle(postCtx) {
    document.querySelectorAll('[data-czcr-mark]').forEach(wrap => {
      const btn   = wrap.querySelector('.czcr-mark-btn');
      const label = wrap.querySelector('.czcr-mark-label');
      const postId= Number(wrap.getAttribute('data-post-id'));

      const setLockedUI = (isLocked) => {
        if (!btn || !label) return;
        btn.setAttribute('aria-pressed', isLocked ? 'true' : 'false');
        label.textContent = isLocked ? cfg.i18n.mark_as_unread : cfg.i18n.mark_as_read;
        document.dispatchEvent(new CustomEvent('czcr:lock', { detail: { post_id: postId, locked: isLocked } }));
      };

      btn && btn.addEventListener('click', async () => {
        const makeLocked = btn.getAttribute('aria-pressed') !== 'true';
        if (isLogged) {
          try { await apiFetch('/mark', { method:'POST', body:{ post_id: postId, locked: makeLocked } }); } catch {}
        } else {
          const store = readLocal();
          const rec = store[postId] || { post_id: postId, pages:{}, last_page:1, total_pages:(postCtx?postCtx.total_pages:1), percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
          rec.status = makeLocked ? 'locked_done' : 'reading';
          if (makeLocked) rec.percent_overall = 100;
          rec.updated_at = new Date().toISOString();
          store[postId] = rec;
          writeLocal(store);
        }
        setLockedUI(makeLocked);
      });

      if (!isLogged) {
        const store = readLocal();
        const rec = store[postId];
        if (rec && rec.status === 'locked_done') setLockedUI(true);
      }
    });

    document.querySelectorAll('.czcr-readings .czcr-list-mark').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const li = e.currentTarget.closest('.czcr-item');
        if (!li) return;
        const wrap   = li.closest('[data-czcr-readings]');
        const postId = Number(li.getAttribute('data-post-id'));

        if (isLogged) {
          try { await apiFetch('/mark', { method:'POST', body:{ post_id: postId, locked: true } }); } catch {}
        } else {
          const store = readLocal();
          const rec = store[postId] || { post_id: postId, pages:{}, last_page:1, total_pages:1, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
          rec.status = 'locked_done'; rec.percent_overall = 100; rec.updated_at = new Date().toISOString();
          store[postId] = rec; writeLocal(store);
        }

        li.remove();
        updateReadingsEmptyState(wrap);
      });
    });
  }

  /* ---------- Guest widget ---------- */
  function hydrateGuestWidget() {
    const wrap = document.querySelector('[data-czcr-readings]');
    if (!wrap) return;

    if (!isLogged) {
      const listEl = wrap.querySelector('[data-czcr-guest-list]');
      const msgEl  = wrap.querySelector('[data-czcr-guest-msg]');
      if (!listEl) return;

      const store = readLocal();
      const entries = [];
      for (const pid of Object.keys(store || {})) {
        const rec = store[pid];
        if (!rec || rec.status === 'locked_done') continue;
        const overall = Number(rec.percent_overall || 0);
        if (overall <= 0 || overall >= 100) continue;
        entries.push({ pid: Number(pid), rec });
      }

      if (entries.length === 0) {
        listEl.innerHTML = '';
        if (msgEl) msgEl.textContent = cfg.i18n.no_items;
        tagBodyHasGuestReadings(false);
        if (DEBUG) dlog('guest readings body class', { has: false, entries: entries.length });
        return;
      }

      const idsParam = entries.map(e => e.pid).join(',');
      apiFetch(`/lookup?ids=${encodeURIComponent(idsParam)}`, { method:'GET' })
        .then(map => {
          const storeNow = readLocal();
          const frags = [];

          for (const { pid, rec } of entries) {
            const meta = map && map[pid];
            if (!meta || !meta.permalink) continue;

            const total_pages = Number(meta.total_pages || rec.total_pages || 1);
            const pagesNorm = {};
            for (let i = 1; i <= total_pages; i++) {
              const v = rec.pages && typeof rec.pages[i] === 'number' ? rec.pages[i] : 0;
              pagesNorm[i] = clamp(Number(v), 0, 100);
            }
            const lp = Math.max(1, Number(rec.last_page || 1));
            for (let i = 1; i < Math.min(lp, total_pages); i++) {
              if (pagesNorm[i] < 100) pagesNorm[i] = 100;
            }
            const overallHealed = computeOverallPercent(pagesNorm, total_pages);

            rec.pages = pagesNorm;
            rec.total_pages = total_pages;
            rec.percent_overall = overallHealed;
            storeNow[pid] = rec;

            const last_page = lp;
            const page_pct  = pagesNorm[last_page] || 0;
            const base      = meta.permalink.replace(/\/?$/, '/');
            let page_url    = (last_page > 1) ? (base + String(last_page) + '/') : base;

            const overall_pct = Math.max(0, Math.min(100, Math.round(overallHealed)));
            frags.push(
              `<li class="czcr-item" data-post-id="${pid}">
                 <div class="czcr-top"><a class="czcr-link" href="${page_url}">${escapeHtml(meta.title || '—')}</a></div>
                 <div class="czcr-bottom">
                   <span class="czcr-percent">${overall_pct}%</span>
                   <button type="button" class="czcr-list-mark">Segna come letto</button>
                 </div>
               </li>`
            );
          }

          writeLocal(storeNow);
          listEl.innerHTML = frags.join('');

          listEl.querySelectorAll('.czcr-list-mark').forEach(btn => {
            btn.addEventListener('click', (e) => {
              const li  = e.currentTarget.closest('.czcr-item');
              if (!li) return;
              const wrap= li.closest('[data-czcr-readings]');
              const pid = Number(li.getAttribute('data-post-id'));

              const store2 = readLocal();
              const rec2 = store2[pid] || { post_id: pid, pages:{}, last_page:1, total_pages:1, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
              rec2.status = 'locked_done'; rec2.percent_overall = 100; rec2.updated_at = new Date().toISOString();
              store2[pid] = rec2; writeLocal(store2);

              li.remove();
              updateReadingsEmptyState(wrap);
            });
          });

          tagBodyHasGuestReadings(true);
          if (DEBUG) dlog('guest readings body class', { has: true, entries: entries.length });

        })
        .catch(() => {
          // lasciamo la UI com'è in caso di errore
        });

      if (msgEl) {
        const loginUrl = cfg.urls && cfg.urls.login ? cfg.urls.login : null;
        const regUrl   = cfg.urls && cfg.urls.register ? cfg.urls.register : null;
        if (loginUrl && regUrl) {
          msgEl.innerHTML = `${cfg.i18n.login_to_keep_history
            .replace('Accedi', `<a href="${loginUrl}">Accedi</a>`)
            .replace('registrati', `<a href="${regUrl}">registrati</a>`)}`
        }
      }
      return;
    }
    // logged-in: render già dal server
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function tagBodyHasGuestReadings(has) {
    if (isLogged) return;
    document.documentElement.classList.toggle('czcr-has-guest-readings', !!has);
  }

  /* ---------- Sync after login ---------- */
  async function trySyncAfterLogin() {
    if (!isLogged) return;
    const local = readLocal(); const keys = Object.keys(local||{});
    if (keys.length === 0) return;

    let server = {};
    try { server = await apiFetch('/progress'); } catch { server = {}; }

    for (const pid of keys) {
      const lrec = local[pid]; if (!lrec) continue;

      // SALVAGUARDIA: non syncare "reading" già 100 (sporco)
      if ((lrec.status || 'reading') !== 'locked_done' && Number(lrec.percent_overall || 0) >= 100) {
        if (DEBUG) dlog('sync SKIP dirty 100%', { pid, lrec });
        continue;
      }

      const srec = server[pid];
      const ltime = Date.parse(lrec.updated_at||0)||0;
      const stime = Date.parse(srec && srec.updated_at || 0)||0;

      if (ltime > stime) {
        if (DEBUG) dlog('sync → server', { pid, lrec });
        try {
          await apiFetch('/progress', { method:'POST', body:{
            post_id:Number(pid), pages:lrec.pages||{}, last_page:lrec.last_page||1, total_pages:lrec.total_pages||1, status:lrec.status||'reading'
          }});
        } catch (e) { if (DEBUG) dlog('sync error', e); }
      } else {
        if (DEBUG) dlog('sync SKIP (server newer/equal)', { pid, ltime, stime });
      }
    }
    removeLocal();
    if (DEBUG) dlog('sync done, LS cleared');
  }

  /* ---------- Boot ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
  const postCtx = (window.CZCR && window.CZCR.post) || null;

  await trySyncAfterLogin();

  if (postCtx && postCtx.id) {
    // BACKWARD COMPAT: se l’URL ha ancora czcr_pos, lo rispettiamo (ma non lo generiamo più)
    const params = new URLSearchParams(location.search);
    const pos = params.has('czcr_pos') ? parseFloat(params.get('czcr_pos')) : null;
    if (!isNaN(pos) && pos !== null) {
      requestAnimationFrame(() => scrollToPercent(clamp(pos, 0, 100)));
    } else {
      // nuova UX: offri la ripresa senza “leak” nell’URL
      maybeOfferResume(postCtx);
    }

    startTracking(postCtx);
  }

  bindMarkToggle(postCtx);
  hydrateGuestWidget();
  initFloatingToolbar();
});
})();
