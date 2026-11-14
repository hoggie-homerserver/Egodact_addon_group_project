// ============================================================
// EGODACT GROUP PROJECT — TRANSPORT
// ============================================================
// Firebase (anonymous auth + Firestore) with a local demo fallback,
// mirroring the Egodact Chat addon's transport, but trimmed to the
// group-checklist data model.

(function () {
    'use strict';

    const C = window.EgodactGroupConfig || {};
    const FB = (C.firebase || {});

    let mode = 'local';
    let initError = null;
    let app = null, auth = null, db = null, fbUser = null;
    let readyResolve;
    const ready = new Promise(function (res) { readyResolve = res; });

    const COL = C.checklistsCollection || 'groupchecklists';

    function hasFirebaseConfig() {
        return !!(FB.apiKey && FB.projectId && FB.appId);
    }

    async function init() {
        if (!hasFirebaseConfig()) {
            mode = 'local';
            initError = 'Firebase niet geconfigureerd.';
            readyResolve();
            return;
        }
        try {
            if (typeof firebase === 'undefined') throw new Error('Firebase SDK niet geladen.');
            app = firebase.initializeApp(FB, 'egodact-group-project');
            auth = firebase.auth(app);
            db = firebase.firestore(app);
            try { db.settings({ experimentalAutoDetectLongPolling: true }); } catch (e) {}
            const cred = await auth.signInAnonymously();
            fbUser = cred && cred.user ? cred.user : null;
            mode = 'firebase';
        } catch (err) {
            mode = 'local';
            initError = (err && err.message) ? err.message : String(err);
            console.warn('[GroupProject] Firebase init failed, local mode:', initError);
        }
        readyResolve();
    }

    // ---------- Firestore helpers ----------
    function checklistRef(challengeId) {
        return db.collection(COL).doc(challengeId);
    }
    function tasksRef(challengeId) {
        return checklistRef(challengeId).collection('tasks');
    }

    async function ensureChecklist(challengeId, meta) {
        meta = meta || {};
        if (mode !== 'firebase') return localEnsure(challengeId, meta);
        const ref = checklistRef(challengeId);
        const snap = await ref.get();
        const profiles = meta.memberProfiles || {};
        const members = meta.members || [];
        if (!snap.exists) {
            await ref.set({
                challengeId: challengeId,
                challengeName: meta.name || '',
                members: members,
                memberProfiles: profiles,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } else {
            await ref.set({
                challengeName: meta.name || snap.get('challengeName') || '',
                members: members,
                memberProfiles: profiles,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
    }

    function listenTasks(challengeId, cb) {
        if (mode !== 'firebase') return localListen(challengeId, cb);
        let unsub = null;
        try {
            unsub = tasksRef(challengeId).orderBy('order').onSnapshot(function (snap) {
                const tasks = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
                cb(tasks, null);
            }, function (err) { cb(null, err); });
        } catch (err) {
            cb(null, err);
        }
        return function () { if (typeof unsub === 'function') try { unsub(); } catch (e) {} };
    }

    async function createTask(challengeId, task) {
        if (mode !== 'firebase') return localCreate(challengeId, task);
        const ref = tasksRef(challengeId).doc();
        const data = Object.assign({}, task, {
            id: ref.id,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await ref.set(data);
        return ref.id;
    }

    async function updateTask(challengeId, taskId, patch) {
        if (mode !== 'firebase') return localUpdate(challengeId, taskId, patch);
        await tasksRef(challengeId).doc(taskId).set(Object.assign({}, patch, {
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }), { merge: true });
    }

    async function deleteTask(challengeId, taskId) {
        if (mode !== 'firebase') return localDelete(challengeId, taskId);
        await tasksRef(challengeId).doc(taskId).delete();
    }

    // ---------- Local demo mode ----------
    const BC = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('egodact_group_project') : null;
    function localKey(challengeId) { return 'egodact_group_tasks_' + challengeId; }
    function localRead(challengeId) {
        try {
            const raw = localStorage.getItem(localKey(challengeId));
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function localWrite(challengeId, tasks) {
        try { localStorage.setItem(localKey(challengeId), JSON.stringify(tasks)); } catch (e) {}
        try { if (BC) BC.postMessage({ type: 'changed', challengeId: challengeId }); } catch (e) {}
        try { window.dispatchEvent(new CustomEvent('egodact:group:changed', { detail: { challengeId: challengeId } })); } catch (e) {}
    }
    function localEnsure(challengeId, meta) { /* no-op for local */ }
    function localListen(challengeId, cb) {
        let stopped = false;
        function emit() { if (stopped) return; cb(localRead(challengeId), null); }
        emit();
        const handler = function (e) { if (e && e.detail && e.detail.challengeId === challengeId) emit(); };
        window.addEventListener('egodact:group:changed', handler);
        let bcHandler = null;
        if (BC) { bcHandler = function (m) { if (m && m.data && m.data.type === 'changed' && m.data.challengeId === challengeId) emit(); }; BC.addEventListener('message', bcHandler); }
        return function () {
            stopped = true;
            window.removeEventListener('egodact:group:changed', handler);
            if (BC && bcHandler) BC.removeEventListener('message', bcHandler);
        };
    }
    function localCreate(challengeId, task) {
        const tasks = localRead(challengeId);
        const id = 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        const data = Object.assign({}, task, { id: id, createdAt: Date.now(), updatedAt: Date.now() });
        tasks.push(data);
        localWrite(challengeId, tasks);
        return id;
    }
    function localUpdate(challengeId, taskId, patch) {
        const tasks = localRead(challengeId);
        const idx = tasks.findIndex(function (t) { return t.id === taskId; });
        if (idx === -1) return;
        tasks[idx] = Object.assign({}, tasks[idx], patch, { updatedAt: Date.now() });
        localWrite(challengeId, tasks);
    }
    function localDelete(challengeId, taskId) {
        const tasks = localRead(challengeId).filter(function (t) { return t.id !== taskId; });
        localWrite(challengeId, tasks);
    }

    // ---------- Challenges (Egodact API) ----------
    async function loadChallenges() {
        const cfg = window.EgodactGroupConfig || {};
        const token = localStorage.getItem(cfg.accessTokenKey);
        const school = localStorage.getItem(cfg.schoolKey);
        // background proxy first
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                const res = await chrome.runtime.sendMessage({ type: 'egc:api', path: cfg.challengePath, token: token, school: school });
                if (res && res.ok && res.data) return parseChallenges(res.data);
            }
        } catch (e) {}
        // direct fallback
        const headers = { 'Authorization': 'Bearer ' + (token || ''), 'Accept': 'application/json' };
        if (school) headers['School'] = school;
        const base = (cfg.apiBase == null) ? 'https://api.egodact.com' : cfg.apiBase;
        const r = await fetch(base + (cfg.challengePath || '/challenge-portfolio'), { method: 'GET', headers: headers, credentials: 'omit' });
        if (!r.ok) throw new Error('API ' + r.status);
        return parseChallenges(await r.json());
    }

    function parseChallenges(data) {
        const challenges = data.challenges || {};
        const rows = Object.values(data.rows || {}).sort(function (a, b) { return (b.position || 0) - (a.position || 0); });
        const rowVan = new Map();
        rows.forEach(function (rij, index) {
            (rij.challenges || []).forEach(function (id) {
                if (!rowVan.has(id)) rowVan.set(id, { naam: rij.name || '', index: index });
            });
        });
        return Object.values(challenges).map(function (c) {
            return {
                id: c.id,
                name: c.name || c.title || c.challengeName || c.displayName || 'Naamloze challenge',
                color: c.color || null,
                phase: c.phase || 'TODO',
                row: (rowVan.get(c.id) || {}).naam || '',
                rowIndex: rowVan.has(c.id) ? rowVan.get(c.id).index : 999,
                users: c.users || [],
                worlds: c.worlds || [],
                endDate: c.plannedEndDate || null,
                raw: c
            };
        }).sort(function (a, b) {
            return (a.rowIndex - b.rowIndex) || (a.name || '').localeCompare(b.name || '');
        });
    }

    window.EgodactGroupTransport = {
        ready: ready,
        get mode() { return mode; },
        get error() { return initError; },
        get firebaseUser() { return fbUser; },
        init: init,
        ensureChecklist: ensureChecklist,
        listenTasks: listenTasks,
        createTask: createTask,
        updateTask: updateTask,
        deleteTask: deleteTask,
        loadChallenges: loadChallenges
    };

    // auto-init
    init();
})();
