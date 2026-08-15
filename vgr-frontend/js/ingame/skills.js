// ---------- PROFESSIONS PANEL (K) ----------
// Left sidebar lists professions (invested ones bubble to the top); the main
// pane shows the selected profession's tree. Clicking the next eligible perk
// STAGES it (amber); nothing is spent until the Apply button commits the
// staged picks via vgr:skills:allocateBatch. Green = allocated, blue =
// selectable, amber = selected (staged), grey = locked.

(function () {
    let uiReady = false;
    let pendingState = null;
    let toastTimer = null;

    let currentData = null;     // last server state payload
    let selectedTreeId = null;  // sidebar selection
    let staged = [];            // ordered treeIds, one entry per staged point

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"]/g, function (m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return '&quot;';
        });
    }

    function vgrSkillsSend(type, payload) {
        const map = {
            load: "vgr:skills:load",
            allocateBatch: "vgr:skills:allocateBatch"
        };
        const msg = map[type];
        if (!msg) return;
        window.skyrimPlatform?.sendMessage?.(msg, payload);
    }

    function showToast(message, duration) {
        const toast = document.getElementById('vgr-skills-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.hidden = false;
        toast.classList.add('visible');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove('visible');
            setTimeout(function () { toast.hidden = true; }, 300);
        }, duration || 2600);
    }

    function stagedCountFor(treeId) {
        let n = 0;
        for (let i = 0; i < staged.length; i++) if (staged[i] === treeId) n++;
        return n;
    }

    function findTree(treeId) {
        if (!currentData) return null;
        return (currentData.trees || []).find(function (t) { return t.id === treeId; }) || null;
    }

    // Sidebar order: professions you've invested in on top (your picks),
    // everything else below in config order.
    function sidebarOrder() {
        const trees = (currentData && currentData.trees) || [];
        const invested = trees.filter(function (t) { return t.allocated > 0; });
        const rest = trees.filter(function (t) { return t.allocated === 0; });
        return invested.concat(rest);
    }

    // ----- rendering -----

    function renderHeader() {
        const levelEl = document.getElementById('vgr-skills-level');
        const xpbarEl = document.getElementById('vgr-skills-xpbar');
        const xptextEl = document.getElementById('vgr-skills-xptext');
        const stagedEl = document.getElementById('vgr-skills-staged');
        const applyEl = document.getElementById('vgr-skills-apply');
        const data = currentData;

        levelEl.textContent = data.level;

        if (data.nextLevelXp === null) {
            xpbarEl.style.width = '100%';
            xptextEl.textContent = data.generalXp + ' XP — level cap reached';
        } else {
            const span = Math.max(1, data.nextLevelXp - data.prevLevelXp);
            const into = Math.max(0, data.generalXp - data.prevLevelXp);
            xpbarEl.style.width = Math.min(100, Math.round(100 * into / span)) + '%';
            xptextEl.textContent = data.generalXp + ' / ' + data.nextLevelXp + ' XP to level ' + (data.level + 1);
        }

        stagedEl.textContent = staged.length + ' / ' + data.skillPoints;
        applyEl.disabled = staged.length === 0;
    }

    function renderSidebar() {
        const sidebarEl = document.getElementById('vgr-skills-sidebar');
        let html = '';
        sidebarOrder().forEach(function (tree) {
            const s = stagedCountFor(tree.id);
            html += '<button type="button" class="skills-sidebar-item'
                + (tree.id === selectedTreeId ? ' active' : '')
                + (tree.allocated > 0 ? ' invested' : '')
                + '" data-tree="' + escapeHtml(tree.id) + '">'
                + '<span class="skills-sidebar-name">' + escapeHtml(tree.name) + '</span>'
                + '<span class="skills-sidebar-info">'
                +   (tree.allocated > 0 ? tree.allocated + '/' + tree.nodes.length : '')
                +   (s > 0 ? '<em class="skills-sidebar-staged">+' + s + '</em>' : '')
                + '</span>'
                + '</button>';
        });
        sidebarEl.innerHTML = html;

        sidebarEl.querySelectorAll('.skills-sidebar-item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                selectedTreeId = btn.getAttribute('data-tree');
                renderSidebar();
                renderTree();
            });
        });
    }

    function nodeHtml(tree, node, idx) {
        // effective state overlays staging on top of the server state
        const a = tree.allocated;
        const s = stagedCountFor(tree.id);
        let state;
        if (idx < a) state = 'allocated';
        else if (idx < a + s) state = 'staged';
        else if (idx === a + s && staged.length < currentData.skillPoints && tree.xp >= node.xpReq) state = 'stageable';
        else state = 'locked';

        const req = node.sp + ' SP (' + (node.xpReq > 0 ? node.xpReq + ' XP req' : '0 XP req') + ')';
        const title = node.unlocks ? 'Unlocks: ' + node.unlocks.join(', ') : '';
        const clickable = state === 'stageable' || (state === 'staged' && idx === a + s - 1);

        if (clickable) {
            return '<button type="button" class="skills-node ' + state + '" data-idx="' + idx + '" title="' + escapeHtml(title) + '">'
                + '<span class="skills-node-name">' + escapeHtml(node.name) + '</span>'
                + '<span class="skills-node-req">' + req + '</span>'
                + (state === 'staged' ? '<span class="skills-node-hint">selected — click to undo</span>' : '')
                + '</button>';
        }
        return '<div class="skills-node ' + state + '" title="' + escapeHtml(title) + '">'
            + '<span class="skills-node-name">' + escapeHtml(node.name) + '</span>'
            + '<span class="skills-node-req">' + req + '</span>'
            + '</div>';
    }

    function renderTree() {
        const paneEl = document.getElementById('vgr-skills-treepane');
        const tree = findTree(selectedTreeId);
        if (!tree) { paneEl.innerHTML = ''; return; }

        const spec = tree.specialization || {};
        let html = '<header class="skills-treepane-head">'
            + '<h2>' + escapeHtml(tree.name) + '</h2>'
            + '<span class="skills-column-xp">XP: ' + tree.xp + '</span>'
            + (tree.desc ? '<p class="skills-treepane-desc">' + escapeHtml(tree.desc) + '</p>' : '')
            + '</header>'
            + '<div class="skills-nodes">'
            + tree.nodes.map(function (node, idx) { return nodeHtml(tree, node, idx); }).join('')
            + '</div>'
            + '<div class="skills-spec' + (spec.unlocked ? ' unlocked' : '') + '" title="Granted by Gamemasters">'
            +   '<span class="skills-node-name">' + escapeHtml(spec.name || 'Specialisation') + '</span>'
            +   '<span class="skills-node-req">' + (spec.unlocked ? 'Unlocked' : 'GM Only') + '</span>'
            + '</div>';
        paneEl.innerHTML = html;

        paneEl.querySelectorAll('.skills-node.stageable').forEach(function (btn) {
            btn.addEventListener('click', function () {
                staged.push(tree.id);
                renderAll();
            });
        });
        paneEl.querySelectorAll('.skills-node.staged').forEach(function (btn) {
            btn.addEventListener('click', function () {
                // undo the most recent staged point in this tree
                for (let i = staged.length - 1; i >= 0; i--) {
                    if (staged[i] === tree.id) { staged.splice(i, 1); break; }
                }
                renderAll();
            });
        });
    }

    function renderAll() {
        if (!currentData) return;
        // keep selection valid
        if (!findTree(selectedTreeId)) {
            const order = sidebarOrder();
            selectedTreeId = order.length ? order[0].id : null;
        }
        renderHeader();
        renderSidebar();
        renderTree();
    }

    window.vgrSkillsUpdate = function (data) {
        if (!data) return;
        if (data.action === 'notice') {
            showToast(data.notice);
            return;
        }
        if (data.action !== 'state') return;
        if (data.notice) showToast(data.notice);
        if (!uiReady) {
            pendingState = data;
            return;
        }
        currentData = data;
        staged = [];  // server state is truth; any staged picks are stale now
        renderAll();
    };

    function show() {
        const shell = document.getElementById('vgr-skills');
        if (shell) shell.classList.add('visible');
        staged = [];
        vgrSkillsSend('load', null);
    }

    function hide() {
        const shell = document.getElementById('vgr-skills');
        if (shell) shell.classList.remove('visible');
        staged = [];
    }

    window.addEventListener('vgr:ui_manager:open:skills', show);
    window.addEventListener('vgr:ui_manager:close:skills', hide);

    function init() {
        uiReady = true;
        const closeBtn = document.getElementById('vgr-skills-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function () {
                window.skyrimPlatform?.sendMessage?.('vgr:ui:close', 'skills');
            });
        }
        const applyBtn = document.getElementById('vgr-skills-apply');
        if (applyBtn) {
            applyBtn.addEventListener('click', function () {
                if (!staged.length) return;
                applyBtn.disabled = true;
                vgrSkillsSend('allocateBatch', staged.slice());
                // staged clears when the server pushes the refreshed state
            });
        }
        if (pendingState) {
            currentData = pendingState;
            pendingState = null;
            renderAll();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());
