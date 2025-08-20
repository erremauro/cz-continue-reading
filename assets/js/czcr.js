/* CZ Continue Reading – Front-end (v1.2.0)
 * - No auto-redirect/auto-scroll on open
 * - Deep-link resume only via ?czcr_pos=NN
 * - Throttled saves
 * - Fill-forward multi-page
 * - NEW: dwell-per-decrease + no-save zone
 * - Optional floating toolbar via shortcode [czcr_toolbar]
 */
(function () {
	'use strict';
	if (!window.CZCR) return;

	const cfg = window.CZCR;
	const isLogged = !!(cfg.user && cfg.user.loggedIn);
	const storageKey = cfg.storageKey || 'czcr_progress_v1';
	const SAVE_STEP = typeof cfg.saveStep === 'number' ? cfg.saveStep : 1;
	const THROTTLE_MS = typeof cfg.throttleMs === 'number' ? cfg.throttleMs : 300;
	const DECREASE_DWELL_MS = typeof cfg.decreaseDwellMs === 'number' ? cfg.decreaseDwellMs : 1200;
	const TOP_NO_SAVE_RATIO = typeof cfg.topNoSaveRatio === 'number' ? cfg.topNoSaveRatio : 0.15;
	const PEAK_GUARD_RATIO  = typeof cfg.peakGuardRatio  === 'number' ? cfg.peakGuardRatio  : 0.50;

	/* ---------- Storage ---------- */
	function readLocal() { try { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
	function writeLocal(obj) { try { localStorage.setItem(storageKey, JSON.stringify(obj || {})); } catch {} }
	function removeLocal() { try { localStorage.removeItem(storageKey); } catch {} }

	/* ---------- REST ---------- */
	async function apiFetch(path, { method = 'GET', body } = {}) {
		const root = (cfg.rest && cfg.rest.root) ? cfg.rest.root : '';
		const url  = (root.endsWith('/') ? root : root + '/') + String(path || '').replace(/^\/+/, '');
		const headers = { 'Content-Type': 'application/json' };
		if (cfg.rest && cfg.rest.nonce) headers['X-WP-Nonce'] = cfg.rest.nonce;
		const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
		if (!res.ok) { throw new Error(`API ${method} ${url} failed: ${res.status}`); }
		return await res.json();
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
	function docHeights() {
		const doc = document.documentElement;
		return Math.max(doc.scrollHeight, document.body.scrollHeight);
	}

	/* ---------- Deep-link only ---------- */
	function scrollToPercent(percent) {
		const contentHeight = docHeights();
		const targetCenter = clamp((percent/100)*contentHeight, 0, contentHeight);
		const y = clamp(targetCenter - (window.innerHeight/2), 0, contentHeight - window.innerHeight);
		window.scrollTo({ top: y, behavior: ('instant' in window) ? 'instant' : 'auto' });
	}

	/* ---------- Floating toolbar render (when shortcode is present) ---------- */
	function initFloatingToolbar() {
		const toolbar = document.querySelector('.czcr-toolbar');
		if (!toolbar) return;
		const homeBtn = toolbar.querySelector('[data-czcr-home]');
		const topBtn  = toolbar.querySelector('[data-czcr-top]');

		function onScroll() {
			const contentHeight = docHeights();
			const centerRatio = (window.scrollY + window.innerHeight/2) / Math.max(1, contentHeight);
			if (centerRatio > 0.35) toolbar.classList.add('is-visible');
			else toolbar.classList.remove('is-visible');
		}
		window.addEventListener('scroll', onScroll, { passive:true });
		window.addEventListener('resize', onScroll, { passive:true });
		onScroll();

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

	/* ---------- Tracking ---------- */
	function computeOverallPercent(pages, totalPages) {
		totalPages = Math.max(1, Number(totalPages) || 1);
		let acc = 0;
		for (let i = 1; i <= totalPages; i++) acc += clamp((pages[i]||0), 0, 100)/100;
		return clamp((acc/totalPages)*100, 0, 100);
	}

	function startTracking(postCtx) {
		if (!postCtx || !postCtx.id) return;

		let lastSavedOverall = -1;
		let locked = false;
		let maxOverallReached = 0;     // peak (non-decreasing) complessivo raggiunto
		let decStartTs = null;         // quando ha iniziato la potenziale diminuzione (per dwell)
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
			const centerY = window.scrollY + (window.innerHeight/2);
			let threshold = false;
			if (postCtx.totalPages <= 1 || Number(postCtx.currentPage) === Number(postCtx.totalPages)) {
				for (const el of [footEl, pagEl, postFooterEl].filter(Boolean)) {
					const rect = el.getBoundingClientRect();
					const topY = rect.top + window.scrollY;
					if (centerY >= topY) { threshold = true; break; }
				}
				const nearBottom = (window.scrollY + window.innerHeight) >= (docHeights() - 2);
				if (nearBottom) threshold = true;
			}
			return threshold;
		}
		function currentPagePercent() {
			const centerY = window.scrollY + (window.innerHeight/2);
			let percent = (centerY / Math.max(1, docHeights())) * 100;
			if (isAtBottomCenter()) percent = 100;
			return clamp(percent, 0, 100);
		}

		let record;
		if (isLogged) record = { post_id: postCtx.id, pages:{}, last_page:1, total_pages:postCtx.totalPages, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
		else {
			const store = readLocal();
			record = store[postCtx.id] || { post_id: postCtx.id, pages:{}, last_page:1, total_pages:postCtx.totalPages, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
		}
		for (let i=1;i<=postCtx.totalPages;i++){ if(typeof record.pages[i] !== 'number') record.pages[i]=0; }
		record.total_pages = postCtx.totalPages;
		maxOverallReached = clamp(record.percent_overall || 0, 0, 100);

		function saveIfNeeded() {
			if (locked) return;

			const page = Number(postCtx.currentPage) || 1;
			const inPage = currentPagePercent();

			// Fill-forward pages < current as 100%
			const pagesForOverall = Object.assign({}, record.pages, { [page]: inPage });
			for (let i = 1; i < page; i++) {
				if (typeof pagesForOverall[i] !== 'number' || pagesForOverall[i] < 100) pagesForOverall[i] = 100;
			}

			const overall = computeOverallPercent(pagesForOverall, record.total_pages);
			const centerRatio = (window.scrollY + window.innerHeight/2) / Math.max(1, docHeights());
			const inTopNoSaveZone = (centerRatio <= TOP_NO_SAVE_RATIO) && (maxOverallReached >= (PEAK_GUARD_RATIO*100));

			// Dwell-per-decrease logic
			let allowSave = true;
			if (overall < record.percent_overall - 0.1) { // possibile decremento
				// 1) no-save zone top: ignora
				if (inTopNoSaveZone) {
					allowSave = false;
					decStartTs = null;
				} else {
					// 2) dwell: salva il decremento solo se l'utente "staziona" qui per X ms
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
				// reset dwell tracker sui non-decrementi
				decStartTs = null;
				lastOverallForDwell = null;
			}

			// Se non dobbiamo salvare, usciamo
			if (!allowSave) return;

			const rounded = roundToStep(overall, SAVE_STEP);
			if (rounded <= lastSavedOverall && inPage < 100) return;

			record.pages[page] = inPage;
			record.last_page = page;
			record.percent_overall = overall;
			record.updated_at = new Date().toISOString();
			lastSavedOverall = rounded;
			maxOverallReached = Math.max(maxOverallReached, overall);

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
		requestAnimationFrame(saveIfNeeded);
		window.addEventListener('beforeunload', () => { try{ saveIfNeeded(); }catch{} }, { capture:true });
	}

	/* ---------- Mark toggles ---------- */
	function bindMarkToggle(postCtx) {
		document.querySelectorAll('[data-czcr-mark]').forEach(wrap => {
			const btn = wrap.querySelector('.czcr-mark-btn');
			const label = wrap.querySelector('.czcr-mark-label');
			const postId = Number(wrap.getAttribute('data-post-id'));

			function setLockedUI(isLocked) {
				if (!btn || !label) return;
				btn.setAttribute('aria-pressed', isLocked ? 'true' : 'false');
				label.textContent = isLocked ? cfg.i18n.mark_as_unread : cfg.i18n.mark_as_read;
				document.dispatchEvent(new CustomEvent('czcr:lock', { detail: { post_id: postId, locked: isLocked } }));
			}

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
				const li = e.currentTarget.closest('.czcr-item'); if (!li) return;
				const postId = Number(li.getAttribute('data-post-id'));
				if (isLogged) { try { await apiFetch('/mark', { method:'POST', body:{ post_id: postId, locked: true } }); } catch {} }
				else {
					const store = readLocal();
					const rec = store[postId] || { post_id: postId, pages:{}, last_page:1, total_pages:1, percent_overall:0, status:'reading', updated_at:new Date().toISOString() };
					rec.status = 'locked_done'; rec.percent_overall = 100; rec.updated_at = new Date().toISOString();
					store[postId] = rec; writeLocal(store);
				}
				li.parentElement.removeChild(li);
			});
		});
	}

	/* ---------- Guest widget ---------- */
	function hydrateGuestWidget() {
		if (isLogged) return;
		const wrap = document.querySelector('[data-czcr-readings]'); if (!wrap) return;
		const store = readLocal();
		const ids = Object.keys(store||{}).filter(pid => {
			const rec = store[pid];
			return rec && rec.status !== 'locked_done' && (rec.percent_overall||0)>0 && (rec.percent_overall||0)<100;
		});
		if (ids.length > 0) {
			const loginUrl = (cfg.urls && cfg.urls.login) || '/login';
			const regUrl = (cfg.urls && cfg.urls.register) || '/register';
			wrap.innerHTML = `<p class="czcr-guest-msg">${cfg.i18n.login_to_keep_history.replace('Accedi', `<a href="${loginUrl}">Accedi</a>`).replace('registrati', `<a href="${regUrl}">registrazione</a>`)}</p>`;
		} else {
			wrap.innerHTML = `<p class="czcr-empty">${cfg.i18n.no_items}</p>`;
		}

		function tagBodyHasGuestReadings() {
		  if (isLogged) return;
		  try {
		    const store = readLocal();
		    const has = Object.keys(store || {}).some(pid => {
		      const rec = store[pid];
		      const pct = rec && rec.percent_overall || 0;
		      return rec && rec.status !== 'locked_done' && pct > 0 && pct < 100;
		    });
		    document.documentElement.classList.toggle('czcr-has-guest-readings', has);
		  } catch (e) {}
		}

		// Call it after DOMContentLoaded work:
		tagBodyHasGuestReadings();
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
			const srec = server[pid];
			const ltime = Date.parse(lrec.updated_at||0)||0;
			const stime = Date.parse(srec && srec.updated_at || 0)||0;
			if (ltime > stime) {
				try { await apiFetch('/progress', { method:'POST', body:{
					post_id:Number(pid), pages:lrec.pages||{}, last_page:lrec.last_page||1, total_pages:lrec.total_pages||1, status:lrec.status||'reading'
				}});} catch {}
			}
		}
		removeLocal();
	}

	/* ---------- Boot ---------- */
	document.addEventListener('DOMContentLoaded', async () => {
		// Non tracciare home, archivio, login, registrazione, ecc.
		if (!document.body.classList.contains('single-post') &&
		  !document.body.classList.contains('page')) {
		return; // skip tracking
		}

		// E opzionalmente: non tracciare la pagina di login o registrazione
		if (document.body.classList.contains('page-id-XX')) { // sostituisci XX con ID pagina login
		return;
		}

		const postCtx = cfg.post || null;
		await trySyncAfterLogin();

		// Deep-link scroll solo con ?czcr_pos=
		if (postCtx && postCtx.id) {
			const params = new URLSearchParams(location.search);
			const pos = params.has('czcr_pos') ? parseFloat(params.get('czcr_pos')) : null;
			if (!isNaN(pos) && pos !== null) { requestAnimationFrame(()=>scrollToPercent(clamp(pos,0,100))); }
			startTracking(postCtx);
		}

		bindMarkToggle(postCtx);
		hydrateGuestWidget();
		initFloatingToolbar();
	});
})();
