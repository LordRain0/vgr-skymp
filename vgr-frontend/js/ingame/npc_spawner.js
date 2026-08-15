// ---------- ADMIN NPC SPAWNER (admin menu "NPC Spawner" tab) ----------
// Full spawner form + existing-NPC list, backed by the offline-generated
// catalogs (window.VGR_ITEM_CATALOG / VGR_ABILITY_CATALOG / VGR_NPC_CATALOG,
// lazy-loaded on first use). Sends commands through the admin-menu channel and
// receives the NPC list via window.vgrAdminData (server -> browser).
(function () {
    "use strict";

    // curated quick-pick bases (the catalog browse covers everything else).
    // formIds VERIFIED against the generated npc_catalog (server load order) -
    // do not hand-edit; look ids up in the catalog when changing.
    const BASE_PRESETS = [
        { name: "Whiterun Guard", id: "0x00099CE5" },   // GuardWhiterunCityGeneric
        { name: "Bandit", id: "0x00039CF6" },           // EncBandit01Melee1HImperialM
        { name: "Imperial Soldier", id: "0x00017140" }, // EncSoldierImperialImperialM01
        { name: "Stormcloak", id: "0x00017167" },       // EncSoldierSonsNordF01
        { name: "Mudcrab", id: "0x000E4010" },          // EncMudcrabMedium
        { name: "Wolf", id: "0x00023ABE" },             // EncWolf
        { name: "Sabre Cat", id: "0x00023AB5" },        // EncSabreCat
        { name: "Bear", id: "0x00023A8A" },             // EncBear
        { name: "Troll", id: "0x00023ABA" },            // EncTroll
        { name: "Giant", id: "0x00023AAE" },            // EncGiant01
        { name: "Draugr", id: "0x0003B547" },           // EncDraugr01Template
        { name: "Frostbite Spider", id: "0x00023AAA" }, // EncFrostbiteSpider
        { name: "Blood Dragon", id: "0x000F80FD" }      // EncDragon02Fire
    ];

    const state = {
        base: null,              // { id, name }
        inventory: [],           // [{ id, name, count }]
        abilities: [],           // [{ id, name }]
        pickerMode: null,        // "base" | "item" | "ability"
        catalogsRequested: false
    };

    const $ = (id) => document.getElementById(id);
    function escapeHtml(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, (m) =>
            m === "&" ? "&amp;" : m === "<" ? "&lt;" : m === ">" ? "&gt;" : "&quot;");
    }
    function sendCmd(action, data) {
        if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
            window.skyrimPlatform.sendMessage("vgr:admin_menu:update", action, data);
        } else {
            console.log("[NPC MOCK]", action, data);
        }
    }
    function toast(msg, variant) {
        if (window.vgr_send_notification) window.vgr_send_notification(2, String(msg), { variant: variant || "info" });
    }

    // ----- lazy catalog loading -----
    function ensureCatalogs(cb) {
        if (window.VGR_ITEM_CATALOG && window.VGR_ABILITY_CATALOG && window.VGR_NPC_CATALOG) return cb();
        if (!state.catalogsRequested) {
            state.catalogsRequested = true;
            ["item", "ability", "npc"].forEach((k) => {
                const s = document.createElement("script");
                s.src = "js/data/" + k + "_catalog.js";
                s.async = false;
                document.body.appendChild(s);
            });
        }
        let tries = 0;
        const iv = setInterval(() => {
            if (window.VGR_ITEM_CATALOG && window.VGR_ABILITY_CATALOG && window.VGR_NPC_CATALOG) {
                clearInterval(iv); cb();
            } else if (++tries > 100) { clearInterval(iv); toast("Catalog failed to load.", "error"); }
        }, 100);
    }

    // ----- picker modal -----
    function openPicker(mode) {
        state.pickerMode = mode;
        const overlay = $("npcPickerOverlay");
        const title = $("npcPickerTitle");
        const label = $("npcPickerLabel");
        const input = $("npcPickerInput");
        const results = $("npcPickerResults");
        title.textContent = mode === "base" ? "🧬 Pick NPC Base" : mode === "item" ? "🎒 Pick Item" : "✨ Pick Ability";
        label.textContent = mode === "base" ? "NPC Bases" : mode === "item" ? "Items" : "Abilities";
        input.value = "";
        results.innerHTML = '<div class="empty-state"><span>⏳</span><p>Loading catalog…</p></div>';
        overlay.classList.remove("hidden");
        overlay.setAttribute("aria-hidden", "false");
        ensureCatalogs(() => { renderPicker(""); input.focus(); });
    }
    function closePicker() {
        const overlay = $("npcPickerOverlay");
        overlay.classList.add("hidden");
        overlay.setAttribute("aria-hidden", "true");
        state.pickerMode = null;
    }
    function activeCatalog() {
        if (state.pickerMode === "base") return window.VGR_NPC_CATALOG;
        if (state.pickerMode === "item") return window.VGR_ITEM_CATALOG;
        if (state.pickerMode === "ability") return window.VGR_ABILITY_CATALOG;
        return null;
    }
    function renderPicker(query) {
        const cat = activeCatalog();
        const results = $("npcPickerResults");
        if (!cat) { results.innerHTML = ""; return; }
        const q = query.trim().toLowerCase();
        const LIMIT = 200;
        // Junk NPC_ records that are never spawnable via PlaceAtMe: audio
        // templates, chargen/racemenu presets, cutscene doppelgangers.
        const NPC_JUNK = /audiotemplate|^MQ101|preset|chargen/i;
        const out = [];
        for (let i = 0; i < cat.entries.length && out.length < LIMIT; i++) {
            const e = cat.entries[i];
            if (state.pickerMode === "base" && NPC_JUNK.test(e.e || "")) continue;
            if (!q || e.n.toLowerCase().includes(q) || (e.e && e.e.toLowerCase().includes(q)) || e.id.toLowerCase().includes(q)) {
                out.push(e);
            }
        }
        $("npcPickerCount").textContent = out.length + (out.length >= LIMIT ? "+" : "");
        if (!out.length) { results.innerHTML = '<div class="empty-state"><span>🔍</span><p>No matches.</p></div>'; return; }
        results.innerHTML = out.map((e) =>
            '<div class="npc-picker-row" data-id="' + e.id + '" data-name="' + escapeHtml(e.n) + '">'
            + '<span class="npc-picker-name">' + escapeHtml(e.n) + '</span>'
            + '<span class="npc-picker-meta">' + escapeHtml(e.t) + ' · ' + e.id + '</span>'
            + '</div>').join("");
        results.querySelectorAll(".npc-picker-row").forEach((row) => {
            row.addEventListener("click", () => choosePickerEntry(row.dataset.id, row.dataset.name));
        });
    }
    function choosePickerEntry(id, name) {
        if (state.pickerMode === "base") {
            state.base = { id, name };
            $("npcBaseLabel").value = name + "  (" + id + ")";
            closePicker();
        } else if (state.pickerMode === "item") {
            if (!state.inventory.some((it) => it.id === id)) state.inventory.push({ id, name, count: 1 });
            renderInventory(); closePicker();
        } else if (state.pickerMode === "ability") {
            if (!state.abilities.some((a) => a.id === id)) state.abilities.push({ id, name });
            renderAbilities(); closePicker();
        }
    }

    // ----- chip lists -----
    function renderInventory() {
        const el = $("npcInventoryList");
        if (!state.inventory.length) { el.innerHTML = '<span class="muted">No items.</span>'; return; }
        el.innerHTML = state.inventory.map((it, i) =>
            '<div class="npc-chip"><span class="npc-chip-name">' + escapeHtml(it.name) + '</span>'
            + '<input type="number" class="npc-chip-count" data-i="' + i + '" value="' + it.count + '" min="1" />'
            + '<button class="npc-chip-x" data-i="' + i + '">×</button></div>').join("");
        el.querySelectorAll(".npc-chip-count").forEach((inp) =>
            inp.addEventListener("change", () => { state.inventory[+inp.dataset.i].count = Math.max(1, parseInt(inp.value, 10) || 1); }));
        el.querySelectorAll(".npc-chip-x").forEach((b) =>
            b.addEventListener("click", () => { state.inventory.splice(+b.dataset.i, 1); renderInventory(); }));
    }
    function renderAbilities() {
        const el = $("npcAbilityList");
        if (!state.abilities.length) { el.innerHTML = '<span class="muted">No abilities.</span>'; return; }
        el.innerHTML = state.abilities.map((a, i) =>
            '<div class="npc-chip"><span class="npc-chip-name">' + escapeHtml(a.name) + '</span>'
            + '<button class="npc-chip-x" data-i="' + i + '">×</button></div>').join("");
        el.querySelectorAll(".npc-chip-x").forEach((b) =>
            b.addEventListener("click", () => { state.abilities.splice(+b.dataset.i, 1); renderAbilities(); }));
    }

    // ----- presets -----
    function renderPresets() {
        const el = $("npcPresets");
        if (!el) return;
        el.innerHTML = BASE_PRESETS.map((p) =>
            '<button class="npc-preset-btn" data-id="' + p.id + '" data-name="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</button>').join("");
        el.querySelectorAll(".npc-preset-btn").forEach((b) =>
            b.addEventListener("click", () => { state.base = { id: b.dataset.id, name: b.dataset.name }; $("npcBaseLabel").value = b.dataset.name + "  (" + b.dataset.id + ")"; }));
    }

    // ----- spawn -----
    function doSpawn() {
        if (!state.base) return toast("Choose an NPC base first.", "error");
        const norm = (v) => { v = String(v || "").trim(); if (!v) return ""; return v.startsWith("0x") ? v : "0x" + v; };
        const faction = norm($("npcFaction").value);
        sendCmd("vgr_npc_spawn", {
            baseId: state.base.id,
            baseName: state.base.name,
            name: $("npcName").value.trim(),
            count: Math.max(1, Math.min(10, parseInt($("npcCount").value, 10) || 1)),
            scale: Math.max(0.1, Math.min(10, parseFloat($("npcScale").value) || 1)),
            respawnMode: $("npcRespawnMode").value,
            respawnDelaySec: Math.max(0, parseInt($("npcRespawnDelay").value, 10) || 60),
            triggerDistance: Math.max(0, parseInt($("npcTriggerDistance").value, 10) || 4096),
            despawnSec: Math.max(0, parseInt($("npcDespawnSec").value, 10) || 0),
            inventory: state.inventory.map((it) => ({ baseId: it.id, count: it.count })),
            spells: state.abilities.map((a) => a.id),
            factions: faction ? [faction] : []
        });
        toast("Spawning " + (state.base.name) + "…", "success");
    }
    function clearForm() {
        state.base = null; state.inventory = []; state.abilities = [];
        $("npcName").value = ""; $("npcBaseLabel").value = ""; $("npcScale").value = "1.0";
        $("npcFaction").value = ""; $("npcCount").value = "1";
        renderInventory(); renderAbilities();
    }

    // ----- existing list -----
    function renderExisting(list) {
        const el = $("npcExistingList");
        if (!el) return;
        if (!list || !list.length) { el.innerHTML = '<span class="muted">No spawned NPCs.</span>'; return; }
        el.innerHTML = list.map((n) =>
            '<div class="npc-existing-row">'
            + '<div class="npc-existing-info"><span class="npc-existing-name">' + escapeHtml(n.name) + '</span>'
            + '<span class="npc-existing-meta">' + escapeHtml(n.baseName || n.baseId) + ' · ' + escapeHtml(n.respawnMode) + (n.dead ? ' · <em>dead</em>' : '') + '</span></div>'
            + '<button class="npc-existing-del small-button danger" data-id="' + n.id + '">Delete</button>'
            + '</div>').join("");
        el.querySelectorAll(".npc-existing-del").forEach((b) =>
            b.addEventListener("click", () => { sendCmd("vgr_npc_delete", { id: b.dataset.id }); b.disabled = true; b.textContent = "…"; }));
    }
    function requestList() {
        $("npcExistingList").innerHTML = '<span class="muted">Loading…</span>';
        sendCmd("vgr_npc_list", {});
    }

    // server -> browser data channel (shared: npc list, enchanting UI,
    // alchemy traits...). This file owns the entry point; other UIs subscribe
    // to the CustomEvent.
    window.vgrAdminData = function (msg) {
        if (!msg) return;
        if (msg.type === "npc_list") renderExisting(msg.payload || []);
        try { window.dispatchEvent(new CustomEvent("vgr:serverdata", { detail: msg })); } catch (e) { }
    };

    // ----- subtabs -----
    function setSubtab(name) {
        document.querySelectorAll(".npc-subtab").forEach((t) => t.classList.toggle("active", t.dataset.npcsub === name));
        document.querySelectorAll(".npc-subpanel").forEach((p) => p.classList.toggle("active", p.dataset.npcsubPanel === name));
        if (name === "existing") requestList();
    }

    // ----- init -----
    function init() {
        if (!$("spawnNpcBtn")) return; // admin menu markup not present
        renderPresets();
        renderInventory();
        renderAbilities();
        $("npcBasePickBtn").addEventListener("click", () => openPicker("base"));
        $("npcAddItemBtn").addEventListener("click", () => openPicker("item"));
        $("npcAddAbilityBtn").addEventListener("click", () => openPicker("ability"));
        $("npcPickerClose").addEventListener("click", closePicker);
        $("npcPickerInput").addEventListener("input", (e) => renderPicker(e.target.value));
        $("spawnNpcBtn").addEventListener("click", doSpawn);
        $("npcClearBtn").addEventListener("click", clearForm);
        $("npcRefreshBtn").addEventListener("click", requestList);
        document.querySelectorAll(".npc-subtab").forEach((t) =>
            t.addEventListener("click", () => setSubtab(t.dataset.npcsub)));
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
}());
