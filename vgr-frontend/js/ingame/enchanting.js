// ---------- VGR ENCHANTING STATION UI ----------
// Opens when the server pushes "enchanting_open" (player activated an arcane
// enchanter with the Enchanting profession). Lists pre-enchanted recipes the
// player's rank allows; crafting consumes the base item + a filled soul gem
// server-side. Also renders the "alchemy_traits" ingredient panel on request.
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) =>
        m === "&" ? "&amp;" : m === "<" ? "&lt;" : m === ">" ? "&gt;" : "&quot;");

    const state = { data: null, filter: "", craftsOnly: false };

    function send(kind, data) {
        if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
            window.skyrimPlatform.sendMessage("vgr:enchanting", kind, data || {});
        } else console.log("[ENCH MOCK]", kind, data);
    }

    function open() {
        if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
            window.skyrimPlatform.sendMessage("vgr:ui:open", "enchanting");
        }
        show();
    }
    function close() {
        if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
            window.skyrimPlatform.sendMessage("vgr:ui:close", "enchanting");
        }
        hide();
    }
    function show() {
        const el = $("enchantingMenu");
        if (!el) return;
        el.classList.remove("hidden");
        el.setAttribute("aria-hidden", "false");
        render();
    }
    function hide() {
        const el = $("enchantingMenu");
        if (!el) return;
        el.classList.add("hidden");
        el.setAttribute("aria-hidden", "true");
    }

    const RANK_NAMES = ["Untrained", "Soul Binding", "Apprentice", "Adept", "Expert", "Master"];

    function render() {
        if (!state.data) return;
        const d = state.data;
        $("enchRank").textContent = RANK_NAMES[Math.min(d.allocated, 5)] +
            (d.allocated >= 5 ? " — all recipes known" : " — tier " + d.allocated + " and below");
        $("enchGems").innerHTML = (d.gems && d.gems.length)
            ? d.gems.map((g) => '<span class="ench-gem">' + esc(g.e.replace("SoulGem", "").replace("Filled", "")) + " ×" + g.count + "</span>").join(" ")
            : '<span class="muted">No filled soul gems — enchanting needs one.</span>';

        const q = state.filter.trim().toLowerCase();
        const list = $("enchRecipeList");
        const rows = [];
        const LIMIT = 150;
        for (const r of d.recipes) {
            if (state.craftsOnly && !r.haveBase) continue;
            if (q && !r.resultName.toLowerCase().includes(q) && !r.enchName.toLowerCase().includes(q) && !r.baseName.toLowerCase().includes(q)) continue;
            rows.push(r);
            if (rows.length >= LIMIT) break;
        }
        $("enchCount").textContent = rows.length + (rows.length >= LIMIT ? "+" : "");
        if (!rows.length) {
            list.innerHTML = '<div class="empty-state"><span>✨</span><p>' +
                (state.craftsOnly ? "No craftable recipes — you need the base item in your inventory." : "No matching recipes.") + "</p></div>";
            return;
        }
        list.innerHTML = rows.map((r) =>
            '<div class="ench-row' + (r.haveBase ? "" : " ench-row-missing") + '">'
            + '<div class="ench-row-info"><span class="ench-row-name">' + esc(r.resultName) + '</span>'
            + '<span class="ench-row-meta">' + esc(r.baseName) + ' + ' + esc(r.enchName) + ' · tier ' + r.tier + (r.haveBase ? "" : " · <em>missing base item</em>") + '</span></div>'
            + '<button class="small-button ench-craft" data-result="' + r.result + '"' + (r.haveBase ? "" : " disabled") + '>Enchant</button>'
            + '</div>').join("");
        list.querySelectorAll(".ench-craft").forEach((b) =>
            b.addEventListener("click", () => { b.disabled = true; b.textContent = "…"; send("craft", { result: b.dataset.result }); }));
    }

    // ----- alchemy traits panel (Professions menu requests it) -----
    function renderTraits(payload) {
        const overlay = $("traitsOverlay");
        if (!overlay || !payload) return;
        $("traitsRank").textContent = "Rank " + payload.allocated + " — you can identify " +
            payload.visible + " of 4 effects per ingredient" + (payload.visible >= 4 ? " (master)" : "");
        const q = ($("traitsSearch").value || "").trim().toLowerCase();
        const rows = payload.ingredients
            .filter((i) => !q || i.n.toLowerCase().includes(q))
            .slice(0, 200);
        $("traitsList").innerHTML = rows.map((i) =>
            '<div class="ench-row"><div class="ench-row-info"><span class="ench-row-name">' + esc(i.n) + '</span>'
            + '<span class="ench-row-meta">' + i.effects.map(esc).join(" · ")
            + (i.hidden ? ' <em>+' + i.hidden + ' unknown</em>' : "") + '</span></div></div>').join("")
            || '<div class="empty-state"><span>🌿</span><p>No matches.</p></div>';
        overlay.classList.remove("hidden");
        overlay.setAttribute("aria-hidden", "false");
        overlay.dataset.payload = JSON.stringify(payload);
    }

    // ----- events -----
    window.addEventListener("vgr:serverdata", (e) => {
        const msg = e.detail;
        if (!msg) return;
        if (msg.type === "enchanting_open") {
            state.data = msg.payload || { allocated: 0, recipes: [], gems: [] };
            if (msg.payload && msg.payload.refresh) render();
            else open();
        } else if (msg.type === "alchemy_traits") {
            renderTraits(msg.payload);
        }
    });
    window.addEventListener("vgr:ui_manager:open:enchanting", show);
    window.addEventListener("vgr:ui_manager:close:enchanting", hide);

    function init() {
        if (!$("enchantingMenu")) return;
        $("enchCloseBtn").addEventListener("click", close);
        $("enchSearch").addEventListener("input", (e) => { state.filter = e.target.value; render(); });
        $("enchCraftableOnly").addEventListener("change", (e) => { state.craftsOnly = !!e.target.checked; render(); });
        $("traitsCloseBtn").addEventListener("click", () => {
            const o = $("traitsOverlay");
            o.classList.add("hidden");
            o.setAttribute("aria-hidden", "true");
        });
        $("traitsSearch").addEventListener("input", () => {
            const o = $("traitsOverlay");
            if (o.dataset.payload) renderTraits(JSON.parse(o.dataset.payload));
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                if (!$("traitsOverlay").classList.contains("hidden")) $("traitsCloseBtn").click();
                else if (!$("enchantingMenu").classList.contains("hidden")) close();
            }
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

    // Professions menu hook: request traits (used by skills.js button)
    window.vgrRequestAlchemyTraits = function () {
        if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
            window.skyrimPlatform.sendMessage("vgr:alchemy", "traits", {});
        }
    };
}());
