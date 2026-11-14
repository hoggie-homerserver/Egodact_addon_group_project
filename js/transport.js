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
            // Verify that Firestore actually accepts our reads. If the rules
            // have not been deployed, writes would fail silently and tasks
            // would seem to disappear — so fall back to local storage instead.
            await db.collection(COL).limit(1).get();
            mode = 'firebase';
        } catch (err) {
            mode = 'local';
            initError = (err && err.message) ? err.message : String(err);
            console.warn('[GroupProject] Firebase init failed, local mode:', initError);
        }
        readyResolve();
    }

    // Surface write problems to the UI instead of failing silently.
    function reportError(err) {
        try {
            window.dispatchEvent(new CustomEvent('egodact:group:error', {
                detail: { message: (err && err.message) ? err.message : String(err) }
            }));
        } catch (e) {}
    }

    // ---------- Firestore helpers ----------
    function checklistRef(challengeId) {
        const id = (challengeId == null) ? '' : String(challengeId);
        if (!id) throw new Error('Deze challenge heeft geen geldig id.');
        return db.collection(COL).doc(id);
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
        let stopped = false;
        let remote = [];
        let unsub = null;

        function emit() {
            if (stopped) return;
            const byId = {};
            remote.forEach(function (t) { if (t && t.id && !byId[t.id]) byId[t.id] = t; });
            // Local-only tasks (saved because a write failed) stay visible.
            localRead(challengeId).forEach(function (t) { if (t && t.id && !byId[t.id]) byId[t.id] = t; });
            cb(Object.keys(byId).map(function (k) { return byId[k]; }), null);
        }

        try {
            unsub = tasksRef(challengeId).orderBy('order').onSnapshot(function (snap) {
                remote = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
                emit();
            }, function (err) {
                if (!stopped) cb(null, err);
            });
        } catch (err) {
            cb(null, err);
        }

        const localHandler = function (e) {
            if (e && e.detail && e.detail.challengeId === challengeId) emit();
        };
        window.addEventListener('egodact:group:changed', localHandler);

        return function () {
            stopped = true;
            window.removeEventListener('egodact:group:changed', localHandler);
            if (typeof unsub === 'function') try { unsub(); } catch (e) {}
        };
    }

    async function createTask(challengeId, task) {
        if (mode !== 'firebase') return localCreate(challengeId, task);
        const ref = tasksRef(challengeId).doc();
        const data = Object.assign({}, task, {
            id: ref.id,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        try {
            await ref.set(data);
            return ref.id;
        } catch (err) {
            console.warn('[GroupProject] createTask failed, keeping a local copy:', err);
            reportError(err);
            return localCreate(challengeId, task);
        }
    }

    async function updateTask(challengeId, taskId, patch) {
        if (mode !== 'firebase') return localUpdate(challengeId, taskId, patch);
        try {
            await tasksRef(challengeId).doc(taskId).set(Object.assign({}, patch, {
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }), { merge: true });
            localDelete(challengeId, taskId);
        } catch (err) {
            console.warn('[GroupProject] updateTask failed, keeping a local copy:', err);
            reportError(err);
            localUpsert(challengeId, taskId, patch);
        }
    }

    async function deleteTask(challengeId, taskId) {
        if (mode !== 'firebase') return localDelete(challengeId, taskId);
        try {
            await tasksRef(challengeId).doc(taskId).delete();
            localDelete(challengeId, taskId);
        } catch (err) {
            console.warn('[GroupProject] deleteTask failed:', err);
            reportError(err);
        }
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
    function localUpsert(challengeId, taskId, patch) {
        const tasks = localRead(challengeId);
        const idx = tasks.findIndex(function (t) { return t.id === taskId; });
        if (idx === -1) tasks.push(Object.assign({ id: taskId }, patch, { updatedAt: Date.now() }));
        else tasks[idx] = Object.assign({}, tasks[idx], patch, { updatedAt: Date.now() });
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
                const key = String(id);
                if (!rowVan.has(key)) rowVan.set(key, { naam: rij.name || '', index: index });
            });
        });
        return Object.keys(challenges).map(function (key) {
            const c = challenges[key] || {};
            // Firestore document ids must be strings. The Egodact API can
            // return numeric ids, which made every write/list call fail with
            // "n.indexOf is not a function". Some payloads omit `id` entirely,
            // so fall back to the map key.
            const id = (c.id != null) ? String(c.id)
                : ((c.challengeId != null) ? String(c.challengeId) : String(key));
            return {
                id: id,
                name: c.name || c.title || c.challengeName || c.displayName || 'Naamloze challenge',
                color: c.color || null,
                phase: c.phase || 'TODO',
                row: (rowVan.get(id) || {}).naam || '',
                rowIndex: rowVan.has(id) ? rowVan.get(id).index : 999,
                users: (c.users || []).map(function (u) {
                    return Object.assign({}, u, { id: (u && u.id != null) ? String(u.id) : '' });
                }),
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
