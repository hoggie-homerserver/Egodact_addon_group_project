// ============================================================
// EGODACT GROUP PROJECT — CONTENT
// ============================================================

(function () {
    'use strict';

    const client = window.EgodactAddonClient;
    const L = window.EgodactAddonLib;
    if (!client || !L) return;

    const { ui, data, theme, el } = L;
    const T = window.EgodactGroupTransport;
    const C = window.EgodactGroupConfig || {};
    const SUGGESTED_ROLES = (C.suggestedRoles || ['Leider', 'Schrijver', 'Onderzoeker', 'Presentator', 'Vormgever', 'Notulist', 'Tester']);

    const ADDON_ID = 'egodact-group-project';

    client.registerAddon({
        id: ADDON_ID,
        name: 'Egodact Group Project',
        version: '0.1.0',
        description: 'Shared task checklists for group challenges.',
        author: 'MaxiTaxi'
    });

    const ICON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';

    L.hamburger.add({
        addonId: ADDON_ID,
        id: ADDON_ID + ':main',
        title: 'Groepsprojecten',
        icon: ICON_SVG,
        order: 20
    });

    L.shortcuts.add({
        addonId: ADDON_ID,
        id: 'open',
        title: 'Groepsprojecten openen',
        keys: 'f10',
        scope: 'global',
        action: function () { openMain(); }
    });

    // ---------- state ----------
    let challenges = [];
    let selectedId = null;
    let tasksByChallenge = {};
    let listeners = {};
    let meId = null;
    let rolesByChallenge = {}; // challengeId -> { userId: role }
    let currentBackdrop = null;
    let currentTab = 'projects'; // 'projects' | 'mytasks' | 'board'

    // ---------- helpers ----------
    function esc(t) { return client.escapeHtml(t); }

    function decodeJwt(token) {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length < 2) return null;
        let str = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        try {
            const binary = atob(str);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch (e) { return null; }
    }

    function findAuth0Name() {
        const looksLikeJwt = function (v) {
            return typeof v === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v);
        };
        const candidates = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) candidates.push(k);
            }
        } catch (e) {}
        const jwts = [];
        let cacheObj = null;
        for (const k of candidates) {
            let raw = null;
            try { raw = localStorage.getItem(k); } catch (e) { continue; }
            if (!raw) continue;
            if (looksLikeJwt(raw)) {
                const claims = decodeJwt(raw);
                if (claims) jwts.push({ token: raw, claims: claims });
                continue;
            }
            if (raw.charAt(0) !== '{' && raw.charAt(0) !== '[') continue;
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (e) { continue; }
            const tokens = [parsed, parsed && parsed.body, parsed && parsed.user, parsed && parsed.profile, parsed && parsed.token];
            for (const obj of tokens) {
                if (!obj || typeof obj !== 'object') continue;
                if (looksLikeJwt(obj.id_token)) { const c = decodeJwt(obj.id_token); if (c) jwts.push({ token: obj.id_token, claims: c }); }
                if (looksLikeJwt(obj.idToken)) { const c = decodeJwt(obj.idToken); if (c) jwts.push({ token: obj.idToken, claims: c }); }
                if (!cacheObj && (obj.name || obj.email || obj.given_name || obj.nickname)) cacheObj = obj;
            }
        }
        // Pick best JWT: prefer one with name/email/picture.
        let best = null, bestScore = -1;
        for (const j of jwts) {
            const c = j.claims || {};
            let score = 0;
            if (c.name || c.given_name || c.nickname || c.preferred_username) score += 2;
            if (c.email) score += 2;
            if (c.picture) score += 1;
            if (score > bestScore) { bestScore = score; best = j; }
        }
        if (best && best.claims) {
            const c = best.claims;
            if (c.name) return String(c.name);
            if (c.given_name || c.family_name) return [c.given_name, c.family_name].filter(Boolean).join(' ');
            if (c.nickname) return String(c.nickname);
            if (c.preferred_username) return String(c.preferred_username);
            if (c.email) return String(c.email).split('@')[0];
        }
        if (cacheObj) {
            if (cacheObj.name) return String(cacheObj.name);
            if (cacheObj.given_name) return String(cacheObj.given_name);
            if (cacheObj.nickname) return String(cacheObj.nickname);
            if (cacheObj.email) return String(cacheObj.email).split('@')[0];
        }
        return null;
    }

    function allUsers() {
        const map = {};
        challenges.forEach(function (c) {
            (c.users || []).forEach(function (u) {
                if (u && u.id && !map[u.id]) map[u.id] = { id: u.id, name: u.name, firstName: u.firstName, picture: u.picture };
            });
        });
        return Object.values(map);
    }

    function resolveMe() {
        if (meId) return meId;
        const cached = localStorage.getItem('egodact_group_me');
        const users = allUsers();
        if (cached && users.some(function (u) { return u.id === cached; })) { meId = cached; return meId; }
        const name = findAuth0Name();
        if (name) {
            const nl = name.toLowerCase();
            const exact = users.find(function (u) { return (u.name || '').toLowerCase() === nl; });
            if (exact) { meId = exact.id; localStorage.setItem('egodact_group_me', meId); return meId; }
            const first = name.split(' ')[0].toLowerCase();
            const fuzzy = users.find(function (u) { return (u.firstName || '').toLowerCase() === first || (u.name || '').toLowerCase().split(' ')[0] === first; });
            if (fuzzy) { meId = fuzzy.id; localStorage.setItem('egodact_group_me', meId); return meId; }
            // email local-part match
            const emailName = name.indexOf('@') !== -1 ? name.split('@')[0].toLowerCase() : null;
            if (emailName) {
                const em = users.find(function (u) { return (u.name || '').toLowerCase().split(' ')[0] === emailName; });
                if (em) { meId = em.id; localStorage.setItem('egodact_group_me', meId); return meId; }
            }
        }
        // If only one user across all group challenges, auto-select.
        if (users.length === 1) { meId = users[0].id; localStorage.setItem('egodact_group_me', meId); return meId; }
        return null;
    }

    function loadRoles(challengeId) {
        if (rolesByChallenge[challengeId]) return rolesByChallenge[challengeId];
        try {
            const raw = localStorage.getItem('egodact_group_roles_' + challengeId);
            const obj = raw ? JSON.parse(raw) : {};
            rolesByChallenge[challengeId] = obj || {};
        } catch (e) { rolesByChallenge[challengeId] = {}; }
        return rolesByChallenge[challengeId];
    }
    function saveRoles(challengeId) {
        try { localStorage.setItem('egodact_group_roles_' + challengeId, JSON.stringify(rolesByChallenge[challengeId] || {})); } catch (e) {}
    }

    function avatarEl(user, size) {
        size = size || 20;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;overflow:hidden;background:#757575;color:#fff;display:flex;align-items:center;justify-content:center;font-size:' + Math.max(9, Math.round(size * 0.46)) + 'px;flex-shrink:0;border:1px solid rgba(0,0,0,0.25);';
        wrap.title = (user && user.name) || '';
        wrap.textContent = (((user && (user.firstName || user.name)) || '?')[0] || '?').toUpperCase();
        if (user && user.picture) {
            const img = document.createElement('img');
            img.src = user.picture;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            img.addEventListener('load', function () { wrap.textContent = ''; wrap.appendChild(img); });
        }
        return wrap;
    }

    function progressBar(done, total, h) {
        h = h || 6;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'height:' + h + 'px;background:var(--egd-veld);border-radius:3px;overflow:hidden;border:1px solid var(--egd-rand);';
        const fill = document.createElement('div');
        const pct = total ? Math.round((done / total) * 100) : 0;
        fill.style.cssText = 'height:100%;width:' + pct + '%;background:var(--egd-accent);transition:width 200ms;';
        wrap.appendChild(fill);
        return wrap;
    }

    function challengeProgress(tasks) {
        const total = (tasks || []).length;
        const done = (tasks || []).filter(function (t) { return t.status === 'done'; }).length;
        return { done: done, total: total };
    }
    function taskProgress(t) {
        const subs = t.subtasks || [];
        if (subs.length) {
            const done = subs.filter(function (s) { return s.done; }).length;
            return { done: done, total: subs.length };
        }
        return { done: t.status === 'done' ? 1 : 0, total: 1 };
    }

    function isOverdue(t) {
        if (t.status === 'done') return false;
        if (!t.dueDate) return false;
        const today = new Date().toISOString().slice(0, 10);
        return t.dueDate < today;
    }

    function statusColor(s) {
        if (s === 'done') return '#2e7d32';
        if (s === 'doing') return '#1976d2';
        if (s === 'blocked') return '#c62828';
        return '#757575';
    }
    function statusLabel(s) {
        if (s === 'done') return 'Klaar';
        if (s === 'doing') return 'Bezig';
        if (s === 'blocked') return 'Geblokkeerd';
        return 'Te doen';
    }
    function priorityLabel(p) {
        if (p === 'high') return 'Hoog';
        if (p === 'med') return 'Medium';
        return 'Laag';
    }

    function groupChallenges() {
        return challenges.filter(function (c) { return (c.users || []).length >= 2; });
    }

    function getTasks(challengeId) {
        return tasksByChallenge[challengeId] || [];
    }

    // ---------- data loading ----------
    async function ensureLoaded() {
        if (T && T.ready) await T.ready;
        if (!challenges.length) {
            try {
                challenges = await T.loadChallenges();
            } catch (err) {
                challenges = [];
                ui.toast('Challenges laden mislukt: ' + (err && err.message), { type: 'error' });
            }
        }
        if (meId === null) resolveMe();
    }

    function listenChallenge(challengeId) {
        if (listeners[challengeId]) return;
        const ch = challenges.find(function (c) { return c.id === challengeId; });
        if (ch) {
            try { T.ensureChecklist(challengeId, { name: ch.name, members: (ch.users || []).map(function (u) { return u.id; }), memberProfiles: {} }); } catch (e) {}
        }
        const unsub = T.listenTasks(challengeId, function (tasks, err) {
            if (err) { console.warn('listenTasks err', err); return; }
            tasksByChallenge[challengeId] = (tasks || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0); });
            if (currentBackdrop) refreshBody();
        });
        listeners[challengeId] = unsub;
    }

    function stopListen(challengeId) {
        if (listeners[challengeId]) { try { listeners[challengeId](); } catch (e) {} delete listeners[challengeId]; }
    }

    // ---------- modal scaffolding ----------
    function closeMain() {
        if (currentBackdrop && currentBackdrop.parentNode) currentBackdrop.remove();
        currentBackdrop = null;
        // stop all listeners
        Object.keys(listeners).forEach(stopListen);
    }

    function openMain() {
        if (currentBackdrop) { closeMain(); }
        ensureLoaded().then(function () {
            if (!resolveMe() && groupChallenges().length) {
                showMePicker();
                return;
            }
            showMain();
        });
    }

    function showMePicker() {
        const users = allUsers();
        const backdrop = document.createElement('div');
        backdrop.id = 'egodact-custom-modal-backdrop';
        Object.assign(backdrop.style, { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', backgroundColor: 'var(--egd-backdrop)', zIndex: '9999999', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif' });
        const modal = document.createElement('div');
        Object.assign(modal.style, { backgroundColor: 'var(--egd-modal)', color: 'var(--egd-tekst)', width: 'min(420px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', boxSizing: 'border-box', overflow: 'hidden', borderRadius: '6px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: 'var(--egd-schaduw)' });
        modal.innerHTML = '<h2 style="margin:0;font-size:20px;">Wie ben jij?</h2><div style="font-size:13px;color:var(--egd-tekst-zacht);">Zodat we je eigen taken kunnen tonen.</div>';
        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;';
        users.forEach(function (u) {
            const btn = document.createElement('button');
            btn.type = 'button';
            Object.assign(btn.style, { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', background: 'var(--egd-veld)', border: '1px solid var(--egd-rand)', borderRadius: '6px', cursor: 'pointer', color: 'var(--egd-tekst)', fontFamily: 'inherit', textAlign: 'left' });
            btn.appendChild(avatarEl(u, 28));
            const nm = document.createElement('span');
            nm.textContent = u.name;
            nm.style.fontWeight = 'bold';
            btn.appendChild(nm);
            btn.addEventListener('click', function () {
                meId = u.id;
                localStorage.setItem('egodact_group_me', meId);
                backdrop.remove();
                openMain();
            });
            list.appendChild(btn);
        });
        modal.appendChild(list);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    function showMain() {
        if (currentBackdrop) closeMain();
        const backdrop = document.createElement('div');
        backdrop.id = 'egodact-custom-modal-backdrop';
        Object.assign(backdrop.style, { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', backgroundColor: 'var(--egd-backdrop)', zIndex: '9999999', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif' });
        const modal = document.createElement('div');
        Object.assign(modal.style, { backgroundColor: 'var(--egd-modal)', color: 'var(--egd-tekst)', width: 'min(900px, 96vw)', maxHeight: '92vh', boxSizing: 'border-box', overflow: 'hidden', borderRadius: '6px', padding: '0', display: 'flex', flexDirection: 'column', boxShadow: 'var(--egd-schaduw)' });
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        currentBackdrop = backdrop;

        // header
        const header = document.createElement('div');
        Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 18px', borderBottom: '1px solid var(--egd-rand)', flexShrink: '0' });
        const title = document.createElement('h2');
        title.textContent = 'Groepsprojecten';
        title.style.cssText = 'margin:0;font-size:20px;font-weight:500;flex:1;';
        const modeBadge = document.createElement('span');
        modeBadge.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:999px;background:var(--egd-veld);border:1px solid var(--egd-rand);';
        modeBadge.textContent = (T.mode === 'firebase') ? 'Live' : 'Lokaal';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = 'Sluiten';
        Object.assign(closeBtn.style, { backgroundColor: 'var(--egd-accent)', border: 'none', color: 'var(--egd-accent-tekst)', cursor: 'pointer', padding: '8px 14px', fontWeight: 'bold', fontSize: '13px', borderRadius: '4px' });
        closeBtn.addEventListener('click', closeMain);
        header.append(title, modeBadge, closeBtn);
        modal.appendChild(header);

        // tabs
        const tabs = document.createElement('div');
        Object.assign(tabs.style, { display: 'flex', gap: '4px', padding: '8px 18px 0', borderBottom: '1px solid var(--egd-rand)', flexShrink: '0' });
        function makeTab(key, label) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.dataset.tab = key;
            Object.assign(b.style, { padding: '8px 14px', border: 'none', background: 'transparent', color: 'var(--egd-tekst)', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', borderBottom: '2px solid transparent', marginBottom: '-1px' });
            b.addEventListener('click', function () { currentTab = key; if (key === 'projects') selectedId = null; refreshBody(); updateTabs(); });
            return b;
        }
        const tabProjects = makeTab('projects', 'Projecten');
        const tabMine = makeTab('mytasks', 'Mijn taken');
        tabs.append(tabProjects, tabMine);
        modal.appendChild(tabs);

        // body container
        const body = document.createElement('div');
        body.id = 'gp-body';
        Object.assign(body.style, { flex: '1', minHeight: '0', overflow: 'auto', padding: '14px 18px' });
        modal.appendChild(body);

        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeMain(); });
        updateTabs();
        refreshBody();
    }

    function updateTabs() {
        if (!currentBackdrop) return;
        const tabs = currentBackdrop.querySelectorAll('[data-tab]');
        tabs.forEach(function (b) {
            const active = b.dataset.tab === currentTab || (currentTab === 'board' && b.dataset.tab === 'projects');
            b.style.borderBottomColor = active ? 'var(--egd-accent)' : 'transparent';
            b.style.color = active ? 'var(--egd-accent)' : 'var(--egd-tekst)';
        });
    }

    function refreshBody() {
        if (!currentBackdrop) return;
        const body = currentBackdrop.querySelector('#gp-body');
        if (!body) return;
        body.innerHTML = '';
        if (currentTab === 'projects' && !selectedId) renderProjects(body);
        else if (currentTab === 'board' || selectedId) { currentTab = 'board'; renderBoard(body); }
        else if (currentTab === 'mytasks') renderMyTasks(body);
        else renderProjects(body);
        updateTabs();
    }

    // ---------- projects view ----------
    function renderProjects(body) {
        const gcs = groupChallenges();
        if (!gcs.length) {
            const empty = document.createElement('div');
            empty.textContent = 'Geen groepschallenges gevonden (challenges met minstens 2 leden).';
            empty.style.cssText = 'padding:20px;text-align:center;color:var(--egd-tekst-zacht);';
            body.appendChild(empty);
            return;
        }
        const grid = document.createElement('div');
        Object.assign(grid.style, { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' });
        gcs.forEach(function (c) {
            const tasks = getTasks(c.id);
            const prog = challengeProgress(tasks);
            const card = document.createElement('div');
            Object.assign(card.style, { background: 'var(--egd-veld)', border: '1px solid var(--egd-rand)', borderRadius: '8px', padding: '12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '8px' });
            card.addEventListener('mouseenter', function () { card.style.borderColor = 'var(--egd-accent)'; });
            card.addEventListener('mouseleave', function () { card.style.borderColor = 'var(--egd-rand)'; });
            const name = document.createElement('div');
            name.textContent = c.name;
            name.style.cssText = 'font-weight:bold;font-size:14px;';
            card.appendChild(name);
            // members
            const memRow = document.createElement('div');
            Object.assign(memRow.style, { display: 'flex', gap: '4px', flexWrap: 'wrap' });
            (c.users || []).forEach(function (u) {
                const r = loadRoles(c.id)[u.id] || '';
                const wrap = document.createElement('div');
                Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '2px' });
                wrap.appendChild(avatarEl(u, 22));
                if (r) {
                    const lbl = document.createElement('span');
                    lbl.textContent = r;
                    lbl.style.cssText = 'font-size:9px;color:var(--egd-tekst-zacht);';
                    wrap.appendChild(lbl);
                }
                memRow.appendChild(wrap);
            });
            card.appendChild(memRow);
            // progress
            const progText = document.createElement('div');
            progText.style.cssText = 'font-size:11px;color:var(--egd-tekst-zacht);display:flex;justify-content:space-between;';
            progText.innerHTML = '<span>' + prog.done + '/' + prog.total + ' taken</span><span>' + (prog.total ? Math.round(prog.done / prog.total * 100) : 0) + '%</span>';
            card.appendChild(progText);
            card.appendChild(progressBar(prog.done, prog.total, 6));
            // open
            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.textContent = 'Openen';
            Object.assign(openBtn.style, { alignSelf: 'flex-start', padding: '6px 12px', border: 'none', borderRadius: '4px', background: 'var(--egd-accent)', color: 'var(--egd-accent-tekst)', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' });
            openBtn.addEventListener('click', function (e) { e.stopPropagation(); openBoard(c.id); });
            card.appendChild(openBtn);
            card.addEventListener('click', function () { openBoard(c.id); });
            grid.appendChild(card);
            // ensure listening
            listenChallenge(c.id);
        });
        body.appendChild(grid);
    }

    function openBoard(challengeId) {
        selectedId = challengeId;
        currentTab = 'board';
        listenChallenge(challengeId);
        refreshBody();
    }

    // ---------- board view ----------
    function renderBoard(body) {
        const c = challenges.find(function (x) { return x.id === selectedId; });
        if (!c) { renderProjects(body); return; }
        // back + title
        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' });
        const back = document.createElement('button');
        back.type = 'button';
        back.textContent = '← Terug';
        Object.assign(back.style, { padding: '6px 10px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'transparent', color: 'var(--egd-tekst)', cursor: 'pointer', fontSize: '12px' });
        back.addEventListener('click', function () { selectedId = null; currentTab = 'projects'; refreshBody(); });
        const t = document.createElement('h3');
        t.textContent = c.name;
        t.style.cssText = 'margin:0;font-size:16px;flex:1;';
        top.append(back, t);
        body.appendChild(top);

        // goal (optional) - stored locally
        const goalKey = 'egodact_group_goal_' + c.id;
        const goalWrap = document.createElement('div');
        Object.assign(goalWrap.style, { marginBottom: '10px' });
        const goalInput = document.createElement('input');
        goalInput.type = 'text';
        goalInput.placeholder = 'Doel van dit project (optioneel)';
        goalInput.value = localStorage.getItem(goalKey) || '';
        Object.assign(goalInput.style, { width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)', fontSize: '12px' });
        goalInput.addEventListener('change', function () { try { localStorage.setItem(goalKey, goalInput.value); } catch (e) {} });
        goalWrap.appendChild(goalInput);
        body.appendChild(goalWrap);

        // members + roles
        const memSection = document.createElement('div');
        Object.assign(memSection.style, { marginBottom: '12px', padding: '8px', background: 'var(--egd-paneel)', borderRadius: '6px', border: '1px solid var(--egd-rand)' });
        const memTitle = document.createElement('div');
        memTitle.textContent = 'Leden & rollen';
        memTitle.style.cssText = 'font-size:11px;font-weight:bold;color:var(--egd-tekst-zacht);margin-bottom:6px;text-transform:uppercase;';
        memSection.appendChild(memTitle);
        const roles = loadRoles(c.id);
        const memRow = document.createElement('div');
        Object.assign(memRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
        (c.users || []).forEach(function (u) {
            const cell = document.createElement('div');
            Object.assign(cell.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', background: 'var(--egd-veld)', borderRadius: '6px', border: '1px solid var(--egd-rand)' });
            cell.appendChild(avatarEl(u, 24));
            const nm = document.createElement('span');
            nm.textContent = u.firstName || u.name;
            nm.style.cssText = 'font-size:12px;';
            cell.appendChild(nm);
            const roleSel = document.createElement('select');
            Object.assign(roleSel.style, { fontSize: '11px', padding: '2px 4px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-modal)', color: 'var(--egd-tekst)' });
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '— rol —';
            roleSel.appendChild(noneOpt);
            SUGGESTED_ROLES.forEach(function (r) {
                const o = document.createElement('option');
                o.value = r; o.textContent = r;
                roleSel.appendChild(o);
            });
            // custom
            const cur = roles[u.id] || '';
            if (cur && SUGGESTED_ROLES.indexOf(cur) === -1) {
                const o = document.createElement('option');
                o.value = cur; o.textContent = cur;
                roleSel.appendChild(o);
            }
            roleSel.value = cur;
            roleSel.addEventListener('change', function () {
                if (roleSel.value === '__custom__') return;
                roles[u.id] = roleSel.value;
                rolesByChallenge[c.id] = roles;
                saveRoles(c.id);
            });
            // allow custom via prompt
            const customBtn = document.createElement('button');
            customBtn.type = 'button';
            customBtn.textContent = '+';
            Object.assign(customBtn.style, { padding: '2px 6px', fontSize: '11px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'transparent', color: 'var(--egd-tekst)', cursor: 'pointer' });
            customBtn.title = 'Eigen rol';
            customBtn.addEventListener('click', function () {
                const val = prompt('Rol voor ' + u.name + ':', roles[u.id] || '');
                if (val === null) return;
                roles[u.id] = val.trim();
                rolesByChallenge[c.id] = roles;
                saveRoles(c.id);
                refreshBody();
            });
            cell.append(roleSel, customBtn);
            memRow.appendChild(cell);
        });
        memSection.appendChild(memRow);
        body.appendChild(memSection);

        // add task button
        const addRow = document.createElement('div');
        Object.assign(addRow.style, { display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' });
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+ Nieuwe taak';
        Object.assign(addBtn.style, { padding: '8px 14px', border: 'none', borderRadius: '4px', background: 'var(--egd-accent)', color: 'var(--egd-accent-tekst)', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold' });
        addBtn.addEventListener('click', function () { showTaskEditor(c.id, null); });
        addRow.appendChild(addBtn);

        // filter
        const filterSel = document.createElement('select');
        Object.assign(filterSel.style, { padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)', fontSize: '12px' });
        ['all', 'mine', 'unassigned', 'done', 'todo'].forEach(function (k) {
            const o = document.createElement('option');
            o.value = k;
            o.textContent = k === 'all' ? 'Alle' : k === 'mine' ? 'Mijn taken' : k === 'unassigned' ? 'Niet toegewezen' : k === 'done' ? 'Klaar' : 'Te doen';
            filterSel.appendChild(o);
        });
        addRow.appendChild(filterSel);
        body.appendChild(addRow);

        const tasks = getTasks(c.id);
        let filtered = tasks.slice();
        function applyFilter() {
            const f = filterSel.value;
            filtered = tasks.filter(function (t) {
                if (f === 'all') return true;
                if (f === 'done') return t.status === 'done';
                if (f === 'todo') return t.status !== 'done';
                if (f === 'mine') return (t.assignees || []).indexOf(meId) !== -1;
                if (f === 'unassigned') return !(t.assignees && t.assignees.length);
                return true;
            });
            renderTaskList(listContainer, filtered, c);
        }
        filterSel.addEventListener('change', applyFilter);

        const listContainer = document.createElement('div');
        Object.assign(listContainer.style, { display: 'flex', flexDirection: 'column', gap: '8px' });
        body.appendChild(listContainer);
        applyFilter();
    }

    function renderTaskList(container, tasks, c) {
        container.innerHTML = '';
        if (!tasks.length) {
            const empty = document.createElement('div');
            empty.textContent = 'Geen taken in deze filter.';
            empty.style.cssText = 'padding:12px;text-align:center;color:var(--egd-tekst-zacht);font-size:12px;';
            container.appendChild(empty);
            return;
        }
        tasks.forEach(function (t) {
            const card = document.createElement('div');
            Object.assign(card.style, { background: 'var(--egd-veld)', border: '1px solid var(--egd-rand)', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' });
            // top row
            const top = document.createElement('div');
            Object.assign(top.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
            // status cycle button
            const statusBtn = document.createElement('button');
            statusBtn.type = 'button';
            statusBtn.textContent = statusLabel(t.status);
            Object.assign(statusBtn.style, { padding: '4px 8px', border: 'none', borderRadius: '4px', background: statusColor(t.status), color: '#fff', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' });
            statusBtn.addEventListener('click', function () {
                const next = t.status === 'todo' ? 'doing' : (t.status === 'doing' ? 'done' : 'todo');
                T.updateTask(c.id, t.id, { status: next });
            });
            top.appendChild(statusBtn);
            const title = document.createElement('span');
            title.textContent = t.title;
            title.style.cssText = 'font-weight:bold;font-size:13px;flex:1;min-width:0;word-break:break-word;' + (t.status === 'done' ? 'text-decoration:line-through;opacity:0.6;' : '');
            top.appendChild(title);
            if (t.priority && t.priority !== 'low') {
                const pchip = document.createElement('span');
                pchip.textContent = priorityLabel(t.priority);
                pchip.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:4px;background:var(--egd-paneel);border:1px solid var(--egd-rand);';
                top.appendChild(pchip);
            }
            if (isOverdue(t)) {
                const od = document.createElement('span');
                od.textContent = 'Verlopen';
                od.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:4px;background:#c62828;color:#fff;';
                top.appendChild(od);
            }
            card.appendChild(top);

            // meta row: assignees + due date
            const meta = document.createElement('div');
            Object.assign(meta.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
            const assignWrap = document.createElement('div');
            Object.assign(assignWrap.style, { display: 'flex', gap: '3px' });
            const usersById = {};
            (c.users || []).forEach(function (u) { usersById[u.id] = u; });
            (t.assignees || []).forEach(function (aid) {
                const u = usersById[aid] || { id: aid, name: aid, firstName: aid };
                assignWrap.appendChild(avatarEl(u, 18));
            });
            if (!(t.assignees && t.assignees.length)) {
                const none = document.createElement('span');
                none.textContent = 'Niet toegewezen';
                none.style.cssText = 'font-size:10px;color:var(--egd-tekst-zacht);font-style:italic;';
                assignWrap.appendChild(none);
            }
            meta.appendChild(assignWrap);
            if (t.dueDate) {
                const dd = document.createElement('span');
                dd.textContent = 'Deadline: ' + t.dueDate;
                dd.style.cssText = 'font-size:11px;color:var(--egd-tekst-zacht);';
                meta.appendChild(dd);
            }
            card.appendChild(meta);

            // description
            if (t.description) {
                const desc = document.createElement('div');
                desc.textContent = t.description;
                desc.style.cssText = 'font-size:12px;color:var(--egd-tekst-zacht);white-space:pre-wrap;';
                card.appendChild(desc);
            }

            // subtasks
            const subs = t.subtasks || [];
            const subWrap = document.createElement('div');
            Object.assign(subWrap.style, { display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px' });
            const sp = taskProgress(t);
            const subHeader = document.createElement('div');
            Object.assign(subHeader.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--egd-tekst-zacht)' });
            const subLabel = document.createElement('span');
            subLabel.textContent = 'Subtaken: ' + sp.done + '/' + sp.total;
            subHeader.appendChild(subLabel);
            subHeader.appendChild(progressBar(sp.done, sp.total, 4));
            subWrap.appendChild(subHeader);
            subs.forEach(function (s, idx) {
                const row = document.createElement('div');
                Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!s.done;
                cb.style.cssText = 'cursor:pointer;';
                cb.addEventListener('change', function () {
                    const newSubs = (t.subtasks || []).slice();
                    newSubs[idx] = Object.assign({}, newSubs[idx], { done: cb.checked, completedBy: cb.checked ? meId : null, completedAt: cb.checked ? Date.now() : null });
                    T.updateTask(c.id, t.id, { subtasks: newSubs });
                });
                row.appendChild(cb);
                const stitle = document.createElement('span');
                stitle.textContent = s.title;
                stitle.style.cssText = 'font-size:12px;flex:1;' + (s.done ? 'text-decoration:line-through;opacity:0.6;' : '');
                row.appendChild(stitle);
                if (s.assignee) {
                    const u = usersById[s.assignee] || { id: s.assignee, name: s.assignee, firstName: s.assignee };
                    row.appendChild(avatarEl(u, 14));
                }
                subWrap.appendChild(row);
            });
            // add subtask input
            const addSubRow = document.createElement('div');
            Object.assign(addSubRow.style, { display: 'flex', gap: '4px', marginTop: '2px' });
            const subInput = document.createElement('input');
            subInput.type = 'text';
            subInput.placeholder = '+ subtaak';
            Object.assign(subInput.style, { flex: '1', padding: '4px 6px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-modal)', color: 'var(--egd-tekst)', fontSize: '11px' });
            const subAssignSel = document.createElement('select');
            Object.assign(subAssignSel.style, { fontSize: '11px', padding: '4px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-modal)', color: 'var(--egd-tekst)' });
            const noOpt = document.createElement('option');
            noOpt.value = ''; noOpt.textContent = '—';
            subAssignSel.appendChild(noOpt);
            (c.users || []).forEach(function (u) {
                const o = document.createElement('option');
                o.value = u.id; o.textContent = u.firstName || u.name;
                subAssignSel.appendChild(o);
            });
            const addSubBtn = document.createElement('button');
            addSubBtn.type = 'button';
            addSubBtn.textContent = 'Toevoegen';
            Object.assign(addSubBtn.style, { padding: '4px 8px', fontSize: '11px', border: 'none', borderRadius: '4px', background: 'var(--egd-accent)', color: 'var(--egd-accent-tekst)', cursor: 'pointer' });
            addSubBtn.addEventListener('click', function () {
                const val = subInput.value.trim();
                if (!val) return;
                const newSubs = (t.subtasks || []).slice();
                newSubs.push({ id: 's-' + Date.now(), title: val, done: false, assignee: subAssignSel.value || null, order: newSubs.length, createdAt: Date.now() });
                T.updateTask(c.id, t.id, { subtasks: newSubs });
                subInput.value = '';
            });
            subInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') addSubBtn.click(); });
            addSubRow.append(subInput, subAssignSel, addSubBtn);
            subWrap.appendChild(addSubRow);
            card.appendChild(subWrap);

            // actions row
            const actions = document.createElement('div');
            Object.assign(actions.style, { display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '4px' });
            const assignBtn = document.createElement('button');
            assignBtn.type = 'button';
            assignBtn.textContent = 'Toewijzen';
            Object.assign(assignBtn.style, { padding: '4px 8px', fontSize: '11px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'transparent', color: 'var(--egd-tekst)', cursor: 'pointer' });
            assignBtn.addEventListener('click', function () { showAssignPicker(c, t); });
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.textContent = 'Bewerken';
            Object.assign(editBtn.style, { padding: '4px 8px', fontSize: '11px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'transparent', color: 'var(--egd-tekst)', cursor: 'pointer' });
            editBtn.addEventListener('click', function () { showTaskEditor(c.id, t); });
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.textContent = 'Verwijderen';
            Object.assign(delBtn.style, { padding: '4px 8px', fontSize: '11px', border: '1px solid var(--egd-gevaar)', borderRadius: '4px', background: 'transparent', color: 'var(--egd-gevaar)', cursor: 'pointer' });
            delBtn.addEventListener('click', function () {
                if (!confirm('Taak "' + t.title + '" verwijderen?')) return;
                T.deleteTask(c.id, t.id);
            });
            actions.append(assignBtn, editBtn, delBtn);
            card.appendChild(actions);

            // attribution
            const attr = document.createElement('div');
            attr.style.cssText = 'font-size:10px;color:var(--egd-tekst-zacht);';
            attr.textContent = (t.createdByName ? 'Door ' + t.createdByName : '') + (t.updatedByName && t.updatedByName !== t.createdByName ? ' · bewerkt door ' + t.updatedByName : '');
            card.appendChild(attr);

            container.appendChild(card);
        });
    }

    function showAssignPicker(c, t) {
        const backdrop = document.createElement('div');
        backdrop.id = 'egodact-custom-modal-backdrop';
        Object.assign(backdrop.style, { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', backgroundColor: 'var(--egd-backdrop)', zIndex: '10000000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif' });
        const modal = document.createElement('div');
        Object.assign(modal.style, { backgroundColor: 'var(--egd-modal)', color: 'var(--egd-tekst)', width: 'min(360px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', boxSizing: 'border-box', overflow: 'hidden', borderRadius: '6px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px', boxShadow: 'var(--egd-schaduw)' });
        const h = document.createElement('h3');
        h.textContent = 'Toewijzen: ' + t.title;
        h.style.cssText = 'margin:0;font-size:16px;';
        modal.appendChild(h);
        const sel = new Set(t.assignees || []);
        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;';
        (c.users || []).forEach(function (u) {
            const row = document.createElement('label');
            Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', background: 'var(--egd-veld)', borderRadius: '6px', cursor: 'pointer' });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = sel.has(u.id);
            cb.addEventListener('change', function () { if (cb.checked) sel.add(u.id); else sel.delete(u.id); });
            row.appendChild(cb);
            row.appendChild(avatarEl(u, 22));
            const nm = document.createElement('span');
            nm.textContent = u.name;
            row.appendChild(nm);
            list.appendChild(row);
        });
        modal.appendChild(list);
        const btns = document.createElement('div');
        Object.assign(btns.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.textContent = 'Annuleren';
        Object.assign(cancel.style, { padding: '8px 12px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'transparent', color: 'var(--egd-tekst)', cursor: 'pointer' });
        cancel.addEventListener('click', function () { backdrop.remove(); });
        const save = document.createElement('button');
        save.type = 'button'; save.textContent = 'Opslaan';
        Object.assign(save.style, { padding: '8px 12px', border: 'none', borderRadius: '4px', background: 'var(--egd-accent)', color: 'var(--egd-accent-tekst)', cursor: 'pointer', fontWeight: 'bold' });
        save.addEventListener('click', function () {
            T.updateTask(c.id, t.id, { assignees: Array.from(sel) });
            backdrop.remove();
        });
        btns.append(cancel, save);
        modal.appendChild(btns);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });
    }

    function showTaskEditor(challengeId, existing) {
        const c = challenges.find(function (x) { return x.id === challengeId; });
        const backdrop = document.createElement('div');
        backdrop.id = 'egodact-custom-modal-backdrop';
        Object.assign(backdrop.style, { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', backgroundColor: 'var(--egd-backdrop)', zIndex: '10000000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif' });
        const modal = document.createElement('div');
        Object.assign(modal.style, { backgroundColor: 'var(--egd-modal)', color: 'var(--egd-tekst)', width: 'min(460px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', boxSizing: 'border-box', overflow: 'hidden', borderRadius: '6px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px', boxShadow: 'var(--egd-schaduw)' });
        const h = document.createElement('h3');
        h.textContent = existing ? 'Taak bewerken' : 'Nieuwe taak';
        h.style.cssText = 'margin:0;font-size:16px;';
        modal.appendChild(h);

        function field(label, node) {
            const w = document.createElement('div');
            const l = document.createElement('label');
            l.textContent = label;
            l.style.cssText = 'display:block;font-size:12px;color:var(--egd-tekst-zacht);margin-bottom:4px;';
            w.appendChild(l);
            w.appendChild(node);
            return w;
        }
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.value = existing ? existing.title : '';
        titleInput.placeholder = 'Titel';
        Object.assign(titleInput.style, { width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)' });
        modal.appendChild(field('Titel', titleInput));

        const descInput = document.createElement('textarea');
        descInput.rows = 3;
        descInput.value = existing ? (existing.description || '') : '';
        descInput.placeholder = 'Beschrijving (optioneel)';
        Object.assign(descInput.style, { width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)', resize: 'vertical', fontFamily: 'inherit' });
        modal.appendChild(field('Beschrijving', descInput));

        // status
        const statusSel = document.createElement('select');
        Object.assign(statusSel.style, { width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)' });
        ['todo', 'doing', 'done', 'blocked'].forEach(function (s) {
            const o = document.createElement('option');
            o.value = s; o.textContent = statusLabel(s);
            statusSel.appendChild(o);
        });
        statusSel.value = existing ? existing.status : 'todo';
        modal.appendChild(field('Status', statusSel));

        // priority
        const prioSel = document.createElement('select');
        Object.assign(prioSel.style, { width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)' });
        ['low', 'med', 'high'].forEach(function (p) {
            const o = document.createElement('option');
            o.value = p; o.textContent = priorityLabel(p);
            prioSel.appendChild(o);
        });
        prioSel.value = existing ? (existing.priority || 'low') : 'low';
        modal.appendChild(field('Prioriteit', prioSel));

        // due date
        const dueInput = document.createElement('input');
        dueInput.type = 'date';
        dueInput.value = existing ? (existing.dueDate || '') : '';
        Object.assign(dueInput.style, { width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)' });
        modal.appendChild(field('Deadline', dueInput));

        // assignees
        const assignWrap = document.createElement('div');
        Object.assign(assignWrap.style, { display: 'flex', flexWrap: 'wrap', gap: '6px' });
        const selectedAssignees = new Set(existing ? (existing.assignees || []) : (meId ? [meId] : []));
        (c.users || []).forEach(function (u) {
            const lbl = document.createElement('label');
            Object.assign(lbl.style, { display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px', background: 'var(--egd-veld)', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedAssignees.has(u.id);
            cb.addEventListener('change', function () { if (cb.checked) selectedAssignees.add(u.id); else selectedAssignees.delete(u.id); });
            lbl.appendChild(cb);
            lbl.appendChild(avatarEl(u, 16));
            const nm = document.createElement('span');
            nm.textContent = u.firstName || u.name;
            lbl.appendChild(nm);
            assignWrap.appendChild(lbl);
        });
        modal.appendChild(field('Toewijzen aan', assignWrap));

        // subtasks (initial, only on create, simple textarea)
        let subtasksInput = null;
        if (!existing) {
            subtasksInput = document.createElement('textarea');
            subtasksInput.rows = 3;
            subtasksInput.placeholder = 'Subtaken (één per regel, optioneel)';
            Object.assign(subtasksInput.style, { width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)', resize: 'vertical', fontFamily: 'inherit' });
            modal.appendChild(field('Subtaken', subtasksInput));
        }

        // blocked reason
        const blockedInput = document.createElement('input');
        blockedInput.type = 'text';
        blockedInput.value = existing ? (existing.blockedReason || '') : '';
        blockedInput.placeholder = 'Reden (bij geblokkeerd)';
        Object.assign(blockedInput.style, { width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'var(--egd-veld)', color: 'var(--egd-tekst)' });
        modal.appendChild(field('Geblokkeerd-reden', blockedInput));

        const btns = document.createElement('div');
        Object.assign(btns.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '6px' });
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.textContent = 'Annuleren';
        Object.assign(cancel.style, { padding: '8px 12px', border: '1px solid var(--egd-rand)', borderRadius: '4px', background: 'transparent', color: 'var(--egd-tekst)', cursor: 'pointer' });
        cancel.addEventListener('click', function () { backdrop.remove(); });
        const save = document.createElement('button');
        save.type = 'button'; save.textContent = existing ? 'Opslaan' : 'Toevoegen';
        Object.assign(save.style, { padding: '8px 12px', border: 'none', borderRadius: '4px', background: 'var(--egd-accent)', color: 'var(--egd-accent-tekst)', cursor: 'pointer', fontWeight: 'bold' });
        save.addEventListener('click', function () {
            const titleVal = titleInput.value.trim();
            if (!titleVal) { ui.toast('Titel is verplicht.', { type: 'error' }); return; }
            const patch = {
                title: titleVal,
                description: descInput.value.trim(),
                status: statusSel.value,
                priority: prioSel.value,
                dueDate: dueInput.value || null,
                assignees: Array.from(selectedAssignees),
                blockedReason: blockedInput.value.trim() || null
            };
            if (existing) {
                T.updateTask(challengeId, existing.id, patch);
            } else {
                const subs = (subtasksInput && subtasksInput.value.trim()) ? subtasksInput.value.trim().split('\n').filter(function (l) { return l.trim(); }).map(function (l, i) { return { id: 's-' + Date.now() + '-' + i, title: l.trim(), done: false, assignee: null, order: i, createdAt: Date.now() }; }) : [];
                const user = (allUsers().find(function (u) { return u.id === meId; })) || {};
                const task = Object.assign({}, patch, {
                    subtasks: subs,
                    order: getTasks(challengeId).length,
                    createdBy: meId,
                    createdByName: user.name || user.firstName || 'Onbekend',
                    updatedBy: meId,
                    updatedByName: user.name || user.firstName || 'Onbekend'
                });
                T.createTask(challengeId, task);
            }
            backdrop.remove();
        });
        btns.append(cancel, save);
        modal.appendChild(btns);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });
        setTimeout(function () { titleInput.focus(); }, 50);
    }

    // ---------- my tasks view ----------
    function renderMyTasks(body) {
        const gcs = groupChallenges();
        const all = [];
        gcs.forEach(function (c) {
            getTasks(c.id).forEach(function (t) {
                if ((t.assignees || []).indexOf(meId) !== -1) all.push({ challenge: c, task: t });
            });
        });
        all.sort(function (a, b) {
            const da = a.task.dueDate || '9999-12-31';
            const db = b.task.dueDate || '9999-12-31';
            if (da !== db) return da < db ? -1 : 1;
            return 0;
        });
        if (!all.length) {
            const empty = document.createElement('div');
            empty.textContent = 'Geen taken aan jou toegewezen.';
            empty.style.cssText = 'padding:20px;text-align:center;color:var(--egd-tekst-zacht);';
            body.appendChild(empty);
            return;
        }
        const list = document.createElement('div');
        Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '8px' });
        all.forEach(function (item) {
            const c = item.challenge, t = item.task;
            const card = document.createElement('div');
            Object.assign(card.style, { background: 'var(--egd-veld)', border: '1px solid var(--egd-rand)', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px', cursor: 'pointer' });
            const top = document.createElement('div');
            Object.assign(top.style, { display: 'flex', alignItems: 'center', gap: '8px' });
            const st = document.createElement('span');
            st.textContent = statusLabel(t.status);
            st.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:4px;background:' + statusColor(t.status) + ';color:#fff;';
            top.appendChild(st);
            const title = document.createElement('span');
            title.textContent = t.title;
            title.style.cssText = 'font-weight:bold;font-size:13px;flex:1;' + (t.status === 'done' ? 'text-decoration:line-through;opacity:0.6;' : '');
            top.appendChild(title);
            if (isOverdue(t)) {
                const od = document.createElement('span');
                od.textContent = 'Verlopen';
                od.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:4px;background:#c62828;color:#fff;';
                top.appendChild(od);
            }
            card.appendChild(top);
            const sub = document.createElement('div');
            sub.style.cssText = 'font-size:11px;color:var(--egd-tekst-zacht);';
            sub.textContent = c.name + (t.dueDate ? ' · deadline ' + t.dueDate : '');
            card.appendChild(sub);
            const sp = taskProgress(t);
            if ((t.subtasks || []).length) {
                card.appendChild(progressBar(sp.done, sp.total, 4));
            }
            card.addEventListener('click', function () { openBoard(c.id); });
            list.appendChild(card);
        });
        body.appendChild(list);
    }

    // ---------- open handlers ----------
    L.hamburger.onOpen(ADDON_ID + ':main', function () { openMain(); });

    // kick off loading challenges in background
    ensureLoaded().catch(function () {});

    // expose for debugging
    window.EgodactGroupProject = { open: openMain };
})();
