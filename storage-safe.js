/*!
 * storage-safe.js — resilient wrappers around localStorage / sessionStorage.
 *
 * Handles: blocked storage (Safari private mode / cookies disabled → SecurityError), QuotaExceededError,
 * corrupt JSON, and missing APIs. Never throws. When a write is rejected the value is kept in an
 * in-memory fallback for the rest of the page session so same-tab flows (survey -> results) still work,
 * and a single dismissible notice points practitioners to "Export / Copy Clinical Dossier".
 *
 * Exposes window.ThriveStorage = { get, set, remove, getJSON, setJSON, available, isDegraded, memory }.
 * Frozen storage keys (thrive_coaching_dossier_v1, thrive_flow_survey_state_v1, thrive_hope_survey_state_v1,
 * thrive_onboarding_checklist_v1, solThrive, solThriveLead, solThriveVotes) are written with unchanged schemas.
 */
(function (root) {
    'use strict';
    if (root.ThriveStorage) return;

    var memory = { local: Object.create(null), session: Object.create(null) };
    var degraded = false;
    var warned = false;

    function area(type) {
        try {
            var s = type === 'session' ? root.sessionStorage : root.localStorage;
            return s || null;
        } catch (_) {
            return null;
        }
    }

    function notify(reason) {
        degraded = true;
        if (warned) return;
        warned = true;
        try {
            if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
                root.dispatchEvent(new root.CustomEvent('thrive-storage-warning', { detail: { reason: reason } }));
            }
        } catch (_) {}
        try {
            var doc = root.document;
            if (!doc || !doc.body && doc.readyState === 'loading') {
                if (doc) doc.addEventListener('DOMContentLoaded', function () { showNotice(reason); }, { once: true });
                return;
            }
            showNotice(reason);
        } catch (_) {}
    }

    function showNotice(reason) {
        var doc = root.document;
        if (!doc || !doc.body || doc.getElementById('thrive-storage-notice')) return;
        var box = doc.createElement('div');
        box.id = 'thrive-storage-notice';
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.className = 'no-print';
        box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:560px;margin:0 auto;' +
            'background:#FEF3C7;color:#78350F;border:2px solid #D97706;border-radius:12px;padding:12px 14px;' +
            'font:600 14px/1.45 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.2);display:flex;gap:12px;align-items:flex-start;';
        var msg = doc.createElement('span');
        msg.style.flex = '1 1 auto';
        msg.textContent = reason === 'quota'
            ? 'Your browser storage is full, so progress may not be saved after you leave this page. Use "Export / Copy Clinical Dossier" to keep your work.'
            : 'Your browser is blocking saved progress (private browsing or cookies disabled). Your work stays on this page only, so use "Export / Copy Clinical Dossier" before you leave.';
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Dismiss';
        btn.setAttribute('aria-label', 'Dismiss storage notice');
        btn.style.cssText = 'flex:0 0 auto;min-height:44px;min-width:44px;border:2px solid #78350F;background:#fff;color:#78350F;border-radius:10px;font:700 14px Inter,system-ui,sans-serif;padding:0 12px;cursor:pointer;';
        btn.addEventListener('click', function () { if (box.parentNode) box.parentNode.removeChild(box); });
        box.appendChild(msg);
        box.appendChild(btn);
        doc.body.appendChild(box);
    }

    function isQuota(err) {
        return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
    }

    function get(type, key) {
        key = String(key);
        var st = area(type);
        if (st) {
            try {
                var v = st.getItem(key);
                if (v !== null && v !== undefined) return v;
            } catch (_) {
                degraded = true;
            }
        }
        return Object.prototype.hasOwnProperty.call(memory[type === 'session' ? 'session' : 'local'], key)
            ? memory[type === 'session' ? 'session' : 'local'][key]
            : null;
    }

    function set(type, key, value) {
        key = String(key);
        value = String(value);
        var bucket = memory[type === 'session' ? 'session' : 'local'];
        var st = area(type);
        if (!st) { bucket[key] = value; notify('blocked'); return false; }
        try {
            st.setItem(key, value);
            delete bucket[key];
            return true;
        } catch (err) {
            bucket[key] = value;
            notify(isQuota(err) ? 'quota' : 'blocked');
            return false;
        }
    }

    function remove(type, key) {
        key = String(key);
        delete memory[type === 'session' ? 'session' : 'local'][key];
        var st = area(type);
        if (!st) return false;
        try { st.removeItem(key); return true; } catch (_) { degraded = true; return false; }
    }

    function getJSON(type, key, fallback) {
        var raw = get(type, key);
        if (raw === null || raw === undefined || raw === '') return fallback === undefined ? null : fallback;
        try {
            var parsed = JSON.parse(raw);
            return parsed === undefined ? (fallback === undefined ? null : fallback) : parsed;
        } catch (_) {
            return fallback === undefined ? null : fallback;
        }
    }

    function setJSON(type, key, value) {
        var text;
        try { text = JSON.stringify(value); } catch (_) { return false; }
        if (text === undefined) return false;
        return set(type, key, text);
    }

    function available(type) {
        var st = area(type);
        if (!st) return false;
        try {
            var probe = '__thrive_probe__';
            st.setItem(probe, '1');
            st.removeItem(probe);
            return true;
        } catch (_) {
            return false;
        }
    }

    function facade(type) {
        return {
            getItem: function (k) { return get(type, k); },
            setItem: function (k, v) { set(type, k, v); },
            removeItem: function (k) { remove(type, k); }
        };
    }

    root.ThriveStorage = {
        local: facade('local'),
        session: facade('session'),
        get: get,
        set: set,
        remove: remove,
        getJSON: getJSON,
        setJSON: setJSON,
        available: available,
        isDegraded: function () { return degraded; },
        memory: memory
    };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
