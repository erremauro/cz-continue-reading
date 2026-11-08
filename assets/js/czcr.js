/* CZ Continue Reading – Front-end (v1.3.1)
 * - Deep-link resume only via ?czcr_pos=NN (compat)
 * - Prompt “Continua a leggere?” senza leak nell’URL
 * - Throttled saves
 * - Fill-forward multi-page
 * - Dwell-per-decrease + top no-save zone (con isteresi sul fondo)
 */
(function () {
  'use strict';
  if (!window.CZCR) return;

  const cfg = window.CZCR;

  // Allow opt-out via query param: ?cr=disabled
  const isDisabledByQuery = (() => {
    try {
      const qp = new URLSearchParams(location.search);
      return qp.get('cr') === 'disabled';
    } catch { return false; }
  })();
  const isDisabledByConfig = !!(cfg && cfg.disabled);
  const isRuntimeDisabled = isDisabledByQuery || isDisabledByConfig;

  // === DEBUG ================================================================
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
  const READ_THRESHOLD     = typeof cfg.readThreshold === 'number'   ? cfg.readThreshold   : 98;

  /* ---------- Storage ---------- */
  const readLocal   = () => { try { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : {}; } catch { return {}; } };
  const writeLocal  = (obj) => { try { localStorage.setItem(storageKey, JSON.stringify(obj || {})); } catch {} };
  const removeLocal = ()   => { try { localStorage.removeItem(storageKey); } catch {} };

  /* ---------- REST ---------- */
  async function apiFetch(path, { method = 'GET', body, keepalive = false } = {}) {
    const root = (cfg.rest && cfg.rest.root) ? cfg.rest.root : '';
    const url  = (root.endsWith('/') ? root : root + '/') + String(path || '').replace(/^\/+/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.rest && cfg.rest.nonce) headers['X-WP-Nonce'] = cfg.rest.nonce;

    if (DEBUG) dlog('API →', method, url, body ? {body} : '(no body)');
    const res = await fetch(url, { method, headers, credentials: 'same-origin', keepalive, body: body ? JSON.stringify(body) : undefined });
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

  /* ---------- Text anchor (layout-independent reading point) ----------
   * La percentuale sull'altezza del documento cambia tra mobile e desktop
   * (testo e immagini scalano in modo diverso, header/footer pesano diversamente).
   * L'ancora invece identifica il blocco di testo sulla linea di lettura
   * (centro del viewport) + la frazione già superata, ed è stabile tra layout.
   */
  const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,pre,figure,table,hr,img,iframe,video';
  let __blocksCache = null;

  function contentRoot() {
    const sel = (cfg.selectors && cfg.selectors.content) || 'div.post-content';
    return document.querySelector(sel);
  }

  function textBlocks() {
    if (__blocksCache && __blocksCache.every(el => el.isConnected)) return __blocksCache;
    const root = contentRoot();
    if (!root) { __blocksCache = []; return __blocksCache; }
    const skip = [cfg.selectors && cfg.selectors.postPagination, 'nav', '.czcr-mark', '[data-czcr-mark]']
      .filter(Boolean).join(',');
    __blocksCache = Array.from(root.querySelectorAll(BLOCK_SEL)).filter(el =>
      !el.querySelector(BLOCK_SEL) && !(skip && el.closest(skip))
    );
    if (DEBUG) dlog('textBlocks', __blocksCache.length);
    return __blocksCache;
  }
  if ('MutationObserver' in window) {
    document.addEventListener('DOMContentLoaded', () => {
      const root = contentRoot();
      if (root) new MutationObserver(() => { __blocksCache = null; }).observe(root, { childList: true, subtree: true });
    });
  }

  function blockFingerprint(el) {
    const raw = el.textContent || el.getAttribute('alt') || el.getAttribute('src') || el.tagName;
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  function readingLineY() { return window.innerHeight / 2; }

  // Ancora del blocco sulla linea di lettura (o null se siamo sopra il contenuto)
  function currentAnchor() {
    const blocks = textBlocks();
    if (!blocks.length) return null;
    const line = readingLineY();
    let hit = -1, hitRect = null;
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (r.height <= 0 && r.width <= 0) continue; // nascosto
      if (r.top > line) break;
      hit = i; hitRect = r;
    }
    if (hit < 0) return null;
    const o = hitRect.height > 0 ? clamp((line - hitRect.top) / hitRect.height, 0, 1) : 1;
    return { i: hit, o: Math.round(o * 10000) / 10000, t: blockFingerprint(blocks[hit]) };
  }

  function resolveAnchorEl(anchor) {
    const blocks = textBlocks();
    if (!blocks.length || !anchor || typeof anchor.i !== 'number') return null;
    let idx = anchor.i;
    // Se il contenuto è cambiato, cerca il blocco con la stessa impronta più vicino
    if (anchor.t && (!blocks[idx] || blockFingerprint(blocks[idx]) !== anchor.t)) {
      let best = -1;
      for (let i = 0; i < blocks.length; i++) {
        if (blockFingerprint(blocks[i]) === anchor.t && (best < 0 || Math.abs(i - anchor.i) < Math.abs(best - anchor.i))) best = i;
      }
      if (best >= 0) idx = best;
    }
    idx = clamp(idx, 0, blocks.length - 1);
    // Salta blocchi nascosti in questo layout
    for (let i = idx; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (r.height > 0 || r.width > 0) return { el: blocks[i], o: i === idx ? (anchor.o || 0) : 0 };
    }
    return null;
  }

  function anchorScrollY(anchor) {
    const hit = resolveAnchorEl(anchor);
    if (!hit) return null;
    const r = hit.el.getBoundingClientRect();
    const docH = docHeights();
    const y = window.scrollY + r.top + clamp(hit.o, 0, 1) * r.height - readingLineY();
    return clamp(y, 0, Math.max(0, docH - window.innerHeight));
  }

  function instantScroll(y) {
    try { window.scrollTo({ top: y, behavior: 'instant' }); } catch { window.scrollTo(0, y); }
  }

  // Scrolla all'ancora e si riallinea per qualche secondo mentre immagini/font
  // sopra il punto cambiano altezza; si ferma appena l'utente interagisce.
  function scrollToAnchor(anchor, { settleMs = 3000 } = {}) {
    const y = anchorScrollY(anchor);
    if (y === null) return false;
    instantScroll(y);
    if (DEBUG) dlog('scrollToAnchor', { anchor, y });

    const root = contentRoot();
    if (!root || !('ResizeObserver' in window) || settleMs <= 0) return true;

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      ro.disconnect();
      ['wheel','touchstart','keydown','pointerdown'].forEach(ev => window.removeEventListener(ev, stop, true));
    };
    const ro = new ResizeObserver(() => {
      if (stopped) return;
      const y2 = anchorScrollY(anchor);
      if (y2 !== null && Math.abs(y2 - window.scrollY) > 2) instantScroll(y2);
    });
    ro.observe(root);
    ['wheel','touchstart','keydown','pointerdown'].forEach(ev => window.addEventListener(ev, stop, { capture: true, passive: true }));
    setTimeout(stop, settleMs);
    return true;
  }

  // Ripristina un record: ancora se valida per questa pagina, altrimenti percentuale legacy
  function restoreRecordPosition(rec, page) {
    const a = rec && rec.anchor;
    if (a && Number(a.page || 1) === Number(page) && scrollToAnchor(a)) return;
    const pct = clamp(Number((rec && rec.pages && rec.pages[page]) || 0), 0, 100);
    scrollToPercent(pct);
  }

  // Salto di pagina (multipage): il ripristino avviene dopo la navigazione
  function kJump(pid){ return `czcr_resume_jump_${pid}`; }

  /* ---------- Resume prompt (UI minimale) ---------- */
  function renderResumePrompt({ onResume, onStartOver }) {
    const wrap = document.createElement('div');
    wrap.className = 'czcr-resume-modal';
    wrap.innerHTML = `
      <div class="czcr-resume-backdrop" role="presentation"></div>
      <div class="czcr-resume-dialog" role="dialog" aria-labelledby="czcr-resume-title" aria-modal="true">
        <h3 id="czcr-resume-title">${cfg.i18n && cfg.i18n.continue_title ? cfg.i18n.continue_title : 'Continua a leggere'}</h3>
        <p>${cfg.i18n && cfg.i18n.continue_msg ? cfg.i18n.continue_msg : 'Vuoi continuare da dove avevi interrotto?'}</p>
        <div class="czcr-resume-actions">
          <button type="button" class="czcr-btn czcr-btn-primary" data-act="resume">${cfg.i18n && cfg.i18n.continue_yes ? cfg.i18n.continue_yes : 'Continua'}</button>
          <button type="button" class="czcr-btn" data-act="start">${cfg.i18n && cfg.i18n.continue_no ? cfg.i18n.continue_no : 'Annulla'}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.querySelector('[data-act="resume"]').addEventListener('click', () => { try { onResume(); } finally { close(); } });
    wrap.querySelector('[data-act="start"]').addEventListener('click', () => { try { onStartOver(); } finally { close(); } });
  }

  // ==== Resume: gestione visita per-post ======================================
  function kVisit(pid){ return `czcr_resume_visit_${pid}`; }
  function kAsked(pid){ return `czcr_resume_asked_${pid}`; }

  function setVisit(pid, on){ try { sessionStorage.setItem(kVisit(pid), on ? '1':''); } catch {} }
  function clearVisit(pid){ try { sessionStorage.removeItem(kVisit(pid)); } catch {} }
  function hasVisit(pid){ try { return sessionStorage.getItem(kVisit(pid)) === '1'; } catch { return false; } }

  function markAsked(pid){ try { sessionStorage.setItem(kAsked(pid),'1'); } catch {} }
  function wasAsked(pid){ try { return sessionStorage.getItem(kAsked(pid)) === '1'; } catch { return false; } }
  function clearAsked(pid){ try { sessionStorage.removeItem(kAsked(pid)); } catch {} }

  // Normalizza il "root" del post multipagina (es: /slug/, /slug/2/, /slug/3/ → /slug/)
  function normalizePostRoot(u) {
    try {
      const url = new URL(u, location.origin);
      url.pathname = url.pathname.replace(/\/\d+\/?$/, '/'); // rimuove /<n> finale (WP multipage)
      return url.origin + url.pathname;
    } catch { return u || ''; }
  }

  function isSamePostReferrer(postPermalink) {
    const base = normalizePostRoot(postPermalink);
    try {
      const ref = document.referrer ? new URL(document.referrer) : null;
      if (!ref) return false;
      const refNorm = normalizePostRoot(ref.href);
      return refNorm === base;
    } catch { return false; }
  }

  // Ritorna true se il prompt è stato mostrato (il tracker resta in pausa fino alla scelta)
  function maybeOfferResume(postCtx, rec, tracker) {
    const release = () => { tracker && tracker.release(); };

    if (isSamePostReferrer(postCtx.permalink)) return false;
    if (wasAsked(postCtx.id)) return false;
    if (!rec || rec.status === 'locked_done') return false;

    const lp = Number(rec.last_page || 1);
    const pages = rec.pages || {};
    const pct   = clamp(Number(pages[lp] || 0), 0, 100);
    const overall = clamp(Number(rec.percent_overall || 0), 0, 100);

    if (!(overall > 0 && overall < READ_THRESHOLD)) return false;
    if (pct < 5) return false;

    const currentPage = Number(postCtx.currentPage || 1);
    const needPageJump = (lp !== currentPage);

    if (!needPageJump) {
      const a = rec.anchor;
      const targetY = (a && Number(a.page || 1) === currentPage) ? anchorScrollY(a) : null;
      if (targetY !== null) {
        if (Math.abs(targetY - window.scrollY) < window.innerHeight / 2) return false;
      } else {
        const centerY = window.scrollY + window.innerHeight/2;
        const currentPct = clamp((centerY / Math.max(1, docHeights())) * 100, 0, 100);
        if (Math.abs(currentPct - pct) < 5) return false;
      }
    }

    if (DEBUG) dlog('resume: offer', { lp, currentPage, needPageJump, targetPct: pct, anchor: rec.anchor });

    renderResumePrompt({
      onResume: () => {
        try { markAsked(postCtx.id); } catch {}
        if (needPageJump) {
          try { sessionStorage.setItem(kJump(postCtx.id), JSON.stringify(rec)); } catch {}
          const base = (postCtx.permalink || '').replace(/\/?$/, '/');
          const url  = (lp > 1) ? (base + String(lp) + '/') : base;
          window.location.href = url;
        } else {
          restoreRecordPosition(rec, currentPage);
          release();
        }
      },
      onStartOver: () => {
        try { markAsked(postCtx.id); } catch {}
        tracker && tracker.resetBaseline();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        release();
      }
    });
    return true;
  }

  // Dopo un salto di pagina dal prompt: ripristina il punto sulla nuova pagina
  function consumePendingJump(postCtx) {
    let rec = null;
    try {
      const raw = sessionStorage.getItem(kJump(postCtx.id));
      if (raw) { sessionStorage.removeItem(kJump(postCtx.id)); rec = JSON.parse(raw); }
    } catch {}
    if (!rec || Number(rec.last_page || 1) !== Number(postCtx.currentPage || 1)) return false;
    restoreRecordPosition(rec, Number(postCtx.currentPage || 1));
    return true;
  }

  /* ---------- Deep-link only (compat) ---------- */
  function scrollToPercent(percent) {
    const contentHeight = docHeights();
    const targetCenter  = clamp((percent/100)*contentHeight, 0, contentHeight);
    const y = clamp(targetCenter - (window.innerHeight/2), 0, Math.max(0, contentHeight - window.innerHeight));
    window.scrollTo({ top: y, behavior: ('instant' in window) ? 'instant' : 'auto' });
  }

  /* ---------- Progress ---------- */
  function computeOverallPercent(pages, totalPages) {
    totalPages = Math.max(1, Number(totalPages) || 1);
    let acc = 0;
    for (let i = 1; i <= totalPages; i++) acc += clamp((pages[i]||0), 0, 100)/100;
    return clamp((acc/totalPages)*100, 0, 100);
  }

  function startTracking(postCtx, initialRec) {
    if (DEBUG) dlog('startTracking', postCtx);
    if (!postCtx || !postCtx.id) return null;

    // In pausa finché l'utente non risponde al prompt di ripresa: altrimenti
    // uno scroll dietro al modale sovrascriverebbe il punto salvato altrove.
    let held = true;

    (function bindPaginationVisitGuard() {
      const root = document.querySelector(cfg.selectors.postPagination);
      if (!root) return;
      root.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', () => { setVisit(postCtx.id, true); }, { capture:true, passive:true });
      });
    })();

    let hasUserInteracted = false;
    const markInteracted = () => { hasUserInteracted = true; };
    window.addEventListener('scroll',     markInteracted, { passive:true, once:true });
    window.addEventListener('wheel',      markInteracted, { passive:true, once:true });
    window.addEventListener('touchstart', markInteracted, { passive:true, once:true });
    window.addEventListener('keydown',    markInteracted, {                once:true });

    const BOTTOM_ENTER_MARGIN = 0;
    const BOTTOM_EXIT_MARGIN  = 120;
    let bottomLatched = false;

    let lastSavedOverall = -1;
    let locked = false;
    let maxOverallReached = 0;
    let decStartTs = null;
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
        const MIN_TARGET_DOC_RATIO = 0.60;
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

      const nearBottomEnter = (window.scrollY + window.innerHeight) >= (docH - 2);
      const nearBottomExit  = (window.scrollY + window.innerHeight) <  (docH - 40);

      const hasValidTarget = (triggerTop !== Infinity);
      const enterByTargets = hasValidTarget && (centerY >= (triggerTop + BOTTOM_ENTER_MARGIN));
      const exitByTargets  = hasValidTarget && (centerY <  (triggerTop - BOTTOM_EXIT_MARGIN));

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

      if (postCtx.totalPages === 1 && window.scrollY < 10) {
        percent = Math.min(percent, 99.9);
      }

      if (DEBUG) dlog('currentPagePercent', { percent, scrollY: window.scrollY, innerH: window.innerHeight });
      return clamp(percent, 0, 100);
    }

    // Parte dal record esistente (server per i loggati, localStorage per i guest):
    // prima i loggati partivano da 0 e il primo scroll sovrascriveva il progresso.
    const blank = () => ({ post_id: postCtx.id, pages:{}, last_page:1, total_pages:postCtx.totalPages, percent_overall:0, status:'reading', updated_at:new Date().toISOString() });
    let record = initialRec ? JSON.parse(JSON.stringify(initialRec)) : blank();
    if (!record.pages || typeof record.pages !== 'object') record.pages = {};
    for (let i=1;i<=postCtx.totalPages;i++) if (typeof record.pages[i] !== 'number') record.pages[i]=Number(record.pages[i])||0;
    record.total_pages = postCtx.totalPages;
    record.percent_overall = Number(record.percent_overall) || 0;

    // La percentuale salvata è stata misurata su un altro layout (es. mobile):
    // la ri-traduciamo nel layout corrente partendo dall'ancora, così la
    // protezione anti-regressione confronta grandezze omogenee.
    (function rebaseFromAnchor() {
      const page = Number(postCtx.currentPage) || 1;
      const a = record.anchor;
      if (!a || Number(a.page || 1) !== page || record.status === 'locked_done') return;
      if (Number(record.pages[page]) >= 100) return;
      const y = anchorScrollY(a);
      if (y === null) return;
      const pct = clamp(((y + window.innerHeight/2) / Math.max(1, docHeights())) * 100, 0, 99.9);
      record.pages[page] = pct;
      record.percent_overall = computeOverallPercent(record.pages, record.total_pages);
      if (DEBUG) dlog('rebaseFromAnchor', { page, pct, overall: record.percent_overall });
    })();

    maxOverallReached  = clamp(record.percent_overall || 0, 0, 100);
    let lastSavedAnchorKey = null;

    function saveIfNeeded(opts) {
      if (held) return;
      if (!hasUserInteracted) return;

      const page   = Number(postCtx.currentPage) || 1;
      const inPage = currentPagePercent();
      const anchor = currentAnchor();
      const anchorKey = anchor ? `${page}:${anchor.i}` : null;

      const pagesForOverall = Object.assign({}, record.pages, { [page]: inPage });
      for (let i = 1; i < page; i++) {
        if (typeof pagesForOverall[i] !== 'number' || pagesForOverall[i] < 100) pagesForOverall[i] = 100;
      }

      const overall = computeOverallPercent(pagesForOverall, record.total_pages);

      if (postCtx.totalPages === 1 && inPage >= 100 && window.scrollY < 10) return;

      const centerRatio = (window.scrollY + window.innerHeight/2) / Math.max(1, docHeights());
      const inTopNoSaveZone =
        (centerRatio <= TOP_NO_SAVE_RATIO) &&
        (maxOverallReached >= (PEAK_GUARD_RATIO * 100));

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

      // Salva se cambia il gradino percentuale O il blocco di testo sulla linea di lettura
      // (le diminuzioni arrivano qui solo dopo il dwell gestito sopra).
      const rounded = roundToStep(overall, SAVE_STEP);
      const anchorChanged = anchorKey !== lastSavedAnchorKey;
      if (rounded === lastSavedOverall && !anchorChanged && inPage < 100) return;

      record.pages[page]      = inPage;
      record.last_page        = page;
      record.percent_overall  = overall;
      record.anchor           = anchor ? Object.assign({ page }, anchor) : null;
      record.updated_at       = new Date().toISOString();
      lastSavedOverall        = rounded;
      lastSavedAnchorKey      = anchorKey;
      maxOverallReached       = Math.max(maxOverallReached, overall);

      if (DEBUG) dlog('SAVE', { page, inPage, overall, rounded, anchor: record.anchor, pages: record.pages });

      if (isLogged) {
        apiFetch('/progress', {
          method:'POST',
          keepalive: !!(opts && opts.unloading),
          body:{
            post_id: postCtx.id,
            pages: record.pages,
            last_page: record.last_page,
            total_pages: record.total_pages,
            anchor: record.anchor,
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
    // Su mobile beforeunload spesso non scatta: usa anche pagehide / visibilitychange
    const flush = () => { try{ saveIfNeeded({ unloading: true }); }catch{} };
    window.addEventListener('beforeunload', flush, { capture:true });
    window.addEventListener('pagehide', flush, { capture:true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

    return {
      release() { held = false; if (DEBUG) dlog('tracker released'); },
      // "Annulla" sul prompt: si riparte da zero, senza la protezione anti-regressione
      resetBaseline() {
        for (let i=1;i<=postCtx.totalPages;i++) record.pages[i]=0;
        record.percent_overall = 0;
        record.anchor = null;
        maxOverallReached = 0;
        lastSavedOverall = -1;
        lastSavedAnchorKey = null;
        decStartTs = null;
        lastOverallForDwell = null;
      }
    };
  }

  function markHasReadings(has) {
    document.body.classList.toggle('czcr-readings-has', !!has);
    document.body.classList.toggle('czcr-readings-empty', !has);
    if (DEBUG) dlog('markHasReadings', { has: !!has  });
  }

  /* ---------- Widget vuoto / empty state ---------- */
  function updateReadingsEmptyState(wrap) {
    if (!wrap || !wrap.matches || !wrap.matches('[data-czcr-readings]')) {
      wrap = document.querySelector('[data-czcr-readings]');
    }
    if (!wrap) return;

    const listEl = wrap.querySelector('ul.czcr-list, [data-czcr-guest-list]');
    const count  = listEl ? listEl.children.length : 0;

    // Nascondi il blocco interno come prima…
    wrap.hidden = count === 0;

    // …e in più marca la SECTION per permettere di gestire visibilità/titolo via CSS
    markHasReadings(count > 0);

    // Mostra/nascondi il pulsante "Segna tutti come letti" solo se ci sono più di 1 articoli
    const markAllBtn = wrap.querySelector('[data-czcr-mark-all]');
    if (markAllBtn) markAllBtn.hidden = count <= 1;

    // Body class per guest
    if (!isLogged) {
      tagBodyHasGuestReadings(count > 0);
      if (listEl && count === 0) listEl.innerHTML = '';
    }

    if (DEBUG) dlog('updateReadingsEmptyState →', { count, hidden: wrap.hidden, isLogged });
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
        if (overall <= 0 || overall >= READ_THRESHOLD) continue;
        entries.push({ pid: Number(pid), rec });
      }

      if (entries.length === 0) {
        wrap.hidden = true;
        tagBodyHasGuestReadings(false);
        markHasReadings(false);
        if (listEl) listEl.innerHTML = '';
        if (msgEl) msgEl.textContent = '';
        if (DEBUG) dlog('guest readings empty → hide');
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
            const overall_pct = Math.max(0, Math.min(100, Math.round(overallHealed)));
            const base      = meta.permalink.replace(/\/?$/, '/');
            let page_url    = (last_page > 1) ? (base + String(last_page) + '/') : base;

            frags.push(
              `<li class="czcr-item" data-post-id="${pid}">
                 <div class="czcr-top"><a class="czcr-link" href="${page_url}">${meta.title || '—'}</a></div>
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
              const wrap2= li.closest('[data-czcr-readings]');
              const pid = Number(li.getAttribute('data-post-id'));

              const store2 = readLocal();
              const rec2 = store2[pid] || { post_id: pid, pages:{}, last_page:1, total_pages:1, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
              rec2.status = 'locked_done'; rec2.percent_overall = 100; rec2.updated_at = new Date().toISOString();
              store2[pid] = rec2; writeLocal(store2);

              li.remove();
              updateReadingsEmptyState(wrap2);
            });
          });

          // Pulsante "Segna tutti come letti" per guest (mostrato solo se > 1 articoli)
          const existingMarkAll = wrap.querySelector('[data-czcr-mark-all]');
          if (existingMarkAll) existingMarkAll.remove();
          if (frags.length > 1) {
            const markAllBtn = document.createElement('button');
            markAllBtn.type = 'button';
            markAllBtn.className = 'czcr-mark-all-btn';
            markAllBtn.setAttribute('data-czcr-mark-all', '');
            const label = cfg.i18n && cfg.i18n.mark_all_as_read ? cfg.i18n.mark_all_as_read : 'Segna tutti come letti';
            const svgIcon = '<svg class="czcr-mark-all-icon" width="20" height="14" viewBox="0 0 22 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M1 7 L5 11.5 L13 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 7 L11 11.5 L19 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            markAllBtn.innerHTML = `${svgIcon} ${label}`;
            wrap.insertBefore(markAllBtn, listEl);

            markAllBtn.addEventListener('click', () => {
              markAllBtn.disabled = true;
              const storeAll = readLocal();
              const nowAll = new Date().toISOString();
              for (const pid of Object.keys(storeAll || {})) {
                const recAll = storeAll[pid];
                if (!recAll || recAll.status === 'locked_done') continue;
                const overallAll = Number(recAll.percent_overall || 0);
                if (overallAll <= 0 || overallAll >= 100) continue;
                recAll.status = 'locked_done';
                recAll.percent_overall = 100;
                recAll.updated_at = nowAll;
                storeAll[pid] = recAll;
              }
              writeLocal(storeAll);
              listEl.innerHTML = '';
              updateReadingsEmptyState(wrap);
            });
          }

          wrap.hidden = listEl.children.length === 0;
          tagBodyHasGuestReadings(!wrap.hidden);
          markHasReadings(!wrap.hidden);
          if (msgEl) msgEl.textContent = '';

          if (DEBUG) dlog('guest readings render →', { count: listEl.children.length, hidden: wrap.hidden });
        })
        .catch(() => {
          wrap.hidden = true;
          tagBodyHasGuestReadings(false);
          markHasReadings(false);
        });

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

  /* ---------- Mark-all button (logged-in, server-rendered) ---------- */
  function bindMarkAllButton() {
    document.querySelectorAll('[data-czcr-mark-all]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const wrap = btn.closest('[data-czcr-readings]');
        if (isLogged) {
          try { await apiFetch('/mark-all', { method: 'POST' }); } catch {}
        }
        if (wrap) {
          const listEl = wrap.querySelector('ul.czcr-list, [data-czcr-guest-list]');
          if (listEl) listEl.innerHTML = '';
          updateReadingsEmptyState(wrap);
        }
      });
    });
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

      if ((lrec.status || 'reading') !== 'locked_done' && Number(lrec.percent_overall || 0) >= READ_THRESHOLD) {
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
            post_id:Number(pid), pages:lrec.pages||{}, last_page:lrec.last_page||1, total_pages:lrec.total_pages||1, anchor:lrec.anchor||null, status:lrec.status||'reading'
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

    if (isRuntimeDisabled) {
      return;
    }

    await trySyncAfterLogin();

    if (postCtx && postCtx.id) {
      const samePost = isSamePostReferrer(postCtx.permalink);
      if (!samePost) {
        clearVisit(postCtx.id);
        clearAsked(postCtx.id);
      }
      setVisit(postCtx.id, true);

      // Un solo record di partenza, condiviso da prompt e tracker
      let rec = null;
      if (isLogged) {
        try { const prog = await apiFetch('/progress'); rec = (prog && prog[postCtx.id]) || null; } catch {}
      } else {
        const store = readLocal();
        rec = (store && store[postCtx.id]) || null;
      }

      const tracker = startTracking(postCtx, rec);

      const params = new URLSearchParams(location.search);
      const pos = params.has('czcr_pos') ? parseFloat(params.get('czcr_pos')) : null;
      if (!isNaN(pos) && pos !== null) {
        requestAnimationFrame(() => scrollToPercent(clamp(pos, 0, 100)));
        tracker && tracker.release();
      } else if (consumePendingJump(postCtx)) {
        tracker && tracker.release();
      } else if (!maybeOfferResume(postCtx, rec, tracker)) {
        tracker && tracker.release();
      }
    }

    bindMarkToggle(postCtx);
    hydrateGuestWidget();
    bindMarkAllButton();

    // Applica sempre la marcatura sezione in base al contenuto iniziale
    document.querySelectorAll('[data-czcr-readings]').forEach(wrap => updateReadingsEmptyState(wrap));
  });
})();
