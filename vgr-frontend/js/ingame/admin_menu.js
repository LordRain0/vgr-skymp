const adminmenu = document.getElementById("adminMenu");

// adminpanel.js
const COMMANDS = {
    GIVE_ITEM: "vgr_give_item",
    REMOVE_ITEM: "vgr_remove_item",
    TELEPORT_TO_ME: "vgr_teleport_player_to_me",
    TELEPORT_TO_LOCATION: "vgr_teleport_player_to_location",
    SPAWN_NPC: "vgr_spawn_npc",
    SET_SKILL: "vgr_set_skill",
    INCREMENT_SKILL: "vgr_increment_skill",
    ADD_PERK: "vgr_add_perk",
    REMOVE_PERK: "vgr_remove_perk",
    DELETE_ALL_PERKS: "vgr_delete_all_perks",
    GET_PLAYER_PERKS: "vgr_get_player_perks",
    SET_WEATHER: "vgr_set_weather",
    RESET_WEATHER: "vgr_reset_weather"
};

// Predefined locations
const LOCATIONS = {
    whiterun: { name: "Whiterun", category: "major" },
    windhelm: { name: "Windhelm", category: "major" },
    riften: { name: "Riften", category: "major" },
    markarth: { name: "Markarth", category: "major" },
    solitude: { name: "Solitude", category: "major" },
    falkreath: { name: "Falkreath", category: "major" },
    winterhold: { name: "Winterhold", category: "major" },
    dawnstar: { name: "Dawnstar", category: "major" },
    morthal: { name: "Morthal", category: "major" },
    riverwood: { name: "Riverwood", category: "minor" },
    rorikstead: { name: "Rorikstead", category: "minor" },
    dragonsbridge: { name: "Dragon's Bridge", category: "minor" },
	ivarstead: { name: "Ivarstead", category: "minor" },
	high_hrothgar: { name: "High Hrothgar", category: "minor" },
    ravenrock: { name: "Raven Rock", category: "minor" },
    apocrypha: { name: "Apocrypha", category: "minor" },
    forgotten_vale: { name: "Forgotten Vale", category: "minor" },
    soulcairn: { name: "Soul Cairn", category: "minor" },
	helgen: { name: "Helgen", category: "minor" },
    sovngarde: { name: "Sovngarde", category: "minor" },
    blackreach: { name: "Blackreach", category: "minor" },
    vgr_hub: { name: "VGR-Hub", category: "minor" },
    whiterun_temple: { name: "Whiterun Temple", category: "temple" },
    windhelm_temple: { name: "Windhelm Temple", category: "temple" },
    riften_temple: { name: "Riften Temple", category: "temple" },
    markarth_temple: { name: "Markarth Temple", category: "temple" },
    solitude_temple: { name: "Solitude Temple", category: "temple" }
};

// NPC Presets
const NPC_PRESETS = [
    { name: "Guard", formId: "0x00023C31" },
    { name: "Dragon", formId: "0x00039FB7" },
    { name: "Giant", formId: "0x00023AA9" },
    { name: "Mammoth", formId: "0x00023AB4" },
    { name: "Troll", formId: "0x00023A8A" },
    { name: "Wolf", formId: "0x00023AA6" },
    { name: "Sabre Cat", formId: "0x00023AB1" },
    { name: "Bear", formId: "0x00023A89" },
    { name: "Draugr", formId: "0x00023B6C" },
    { name: "Bandit", formId: "0x00039CFB" },
    { name: "Mage", formId: "0x0003CDFD" },
    { name: "Vendor", formId: "0x00014148" }
];

// Skills list
const SKILLS = [
    "One-Handed", "Two-Handed", "Archery", "Block", "Smithing",
    "Heavy Armor", "Light Armor", "Pickpocket", "Lockpicking", "Sneak",
    "Alchemy", "Speech", "Alteration", "Conjuration", "Destruction",
    "Illusion", "Restoration", "Enchanting"
];

const WEATHER_PRESETS = [
    { name: "Clear Skies", formId: "0x0000081A" },
    { name: "Cloudy", formId: "0x00012F89" },
    { name: "Fog", formId: "0x000C821E" },
    { name: "Cloudy Rain", formId: "0x0002E7AB" },
    { name: "Storm Rain", formId: "0x000C8220" },
    { name: "Storm Snow", formId: "0x000C8221" },
    { name: "Overcast Rain", formId: "0x000C821F" },
    { name: "Overcast Snow", formId: "0x0004D7FB" },
    { name: "Overcast War", formId: "0x000D299E" },
    { name: "Riften Overcast Fog", formId: "0x0010FE7E" },
    { name: "Soul Cairn", formId: "0x02001407" },
	{ name: "Soul Cairn Red", formId: "0x02006AEC" },
	{ name: "Soul Cairn Aurora", formId: "0x0200959F" },
    { name: "Blackreach Weather", formId: "0x00048C14" },
    { name: "Sovngarde Clear", formId: "0x0010D9EC" },
    { name: "Sovngarde Fog", formId: "0x000923FD" },
    { name: "Sovngarde Dark", formId: "0x0010FEF8" },
    { name: "Volcanic Ash", formId: "0x04018471" },
    { name: "Volcanic Ash Tundra", formId: "0x0401D760" },
    { name: "Volcanic Ash Storm", formId: "0x04032336" },
    { name: "Apocrypha Weather", formId: "0x04034CFB" }
];

// Store skill values (default 15 for all)
let skillValues = {};
SKILLS.forEach(skill => { skillValues[skill] = 15; });

// Store granted perks for UI display
let grantedPerks = [];

function sendToBackend(action, payload) {
    const packet = { source: "vgr:admin_menu:update", action, payload, timestamp: Date.now() };
    if (window.skyrimPlatform?.sendMessage) {
        window.skyrimPlatform?.sendMessage?.(packet.source, packet.action, packet.payload);
    } else {
        console.log("[MOCK]", packet);
        mockHandler(action, payload);
    }
}

function mockHandler(action, payload) {
    const notificationMap = {
        [COMMANDS.GIVE_ITEM]: [`Give ${payload.amount}x ${payload.itemId} to ${payload.targetPlayerId}`, "success"],
        [COMMANDS.REMOVE_ITEM]: [`Removing ${payload.amount}x ${payload.itemId} to ${payload.targetPlayerId}`, "success"],
        [COMMANDS.TELEPORT_TO_ME]: [`Teleported ${payload.targetPlayerId} to your location`, "success"],
        [COMMANDS.TELEPORT_TO_LOCATION]: [`Teleported ${payload.targetPlayerId} to ${payload.locationName}`, "success"],
        [COMMANDS.SPAWN_NPC]: [`Spawned ${payload.count}x ${payload.npcId} at your location`, "success"],
        [COMMANDS.SET_SKILL]: [`Set ${payload.skillName} to ${payload.value} for ${payload.targetPlayerId}`, "success"],
        [COMMANDS.INCREMENT_SKILL]: [`Increased ${payload.skillName} by ${payload.increment} for ${payload.targetPlayerId}`, "success"],
        [COMMANDS.ADD_PERK]: [`Added perk ${payload.perkFormId} to ${payload.targetPlayerId}`, "success"],
        [COMMANDS.REMOVE_PERK]: [`Removed perk ${payload.perkFormId} from ${payload.targetPlayerId}`, "success"],
        [COMMANDS.DELETE_ALL_PERKS]: [`Deleted all perks from ${payload.targetPlayerId}`, "success"],
        [COMMANDS.GET_PLAYER_PERKS]: [`Retrieved perks for ${payload.targetPlayerId}`, "success"],
        [COMMANDS.SET_WEATHER]: [`Weather: ${payload.weatherFormId}`, "success"],
        [COMMANDS.RESET_WEATHER]: ["Weather reset to default", "success"]
    };
    const [msg, type] = notificationMap[action] || ["Action sent", "success"];
    if (action === COMMANDS.SET_WEATHER) {
        document.getElementById("currentWeatherStatus").innerHTML = `🌎 ${payload.weatherFormId}`;
    }
    if (action === COMMANDS.RESET_WEATHER) {
        document.getElementById("currentWeatherStatus").innerHTML = "— Reset to default —";
    }
    if (action === COMMANDS.SET_SKILL) {
        skillValues[payload.skillName] = payload.value;
        renderSkills();
    }
    if (action === COMMANDS.INCREMENT_SKILL) {
        skillValues[payload.skillName] = (skillValues[payload.skillName] || 15) + payload.increment;
        if (skillValues[payload.skillName] > 100) skillValues[payload.skillName] = 100;
        if (skillValues[payload.skillName] < 0) skillValues[payload.skillName] = 0;
        renderSkills();
    }
    if (action === COMMANDS.GET_PLAYER_PERKS && payload.perks) {
        grantedPerks = payload.perks;
        renderGrantedPerksList();
    }
    if (action === COMMANDS.DELETE_ALL_PERKS) {
        grantedPerks = [];
        renderGrantedPerksList();
    }
    notify(msg, type);
}

function notify(msg, type = "") {
    const variant = type === "error" || type === "success" || type === "warning" ? type : "info";
    window.vgr_send_notification?.(2, String(msg || ""), { variant });
}

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
}

function normalizeFormId(raw) {
    let hex = String(raw).trim().replace(/^0x/i, "").replace(/^0+/, "");
    return hex && /^[0-9A-Fa-f]+$/.test(hex) ? "0x" + hex.padStart(8, '0').toUpperCase() : null;
}

// Item Gifter
function giveItem() {
    const targetRaw = document.getElementById("targetFormId").value;
    const itemRaw = document.getElementById("itemFormId").value;
    const amount = parseInt(document.getElementById("itemAmount").value, 10);
    
    if (!targetRaw) return notify("Missing target FormID", "error");
    if (!itemRaw) return notify("Missing item FormID", "error");
    if (isNaN(amount) || amount < 1) return notify("Invalid amount", "error");
    
    const target = normalizeFormId(targetRaw);
    const item = normalizeFormId(itemRaw);
    if (!target) return notify("Invalid target FormID", "error");
    if (!item) return notify("Invalid item FormID", "error");
    
    sendToBackend(COMMANDS.GIVE_ITEM, { targetPlayerId: target, itemId: item, amount });
    notify(`Sending ${amount}x ${item} to ${target}`, "success");
}


// Item Remover
function removeItem() {
    const targetRaw = document.getElementById("targetFormId").value;
    const itemRaw = document.getElementById("itemFormId").value;
    const amount = parseInt(document.getElementById("itemAmount").value, 10);
    
    if (!targetRaw) return notify("Missing target FormID", "error");
    if (!itemRaw) return notify("Missing item FormID", "error");
    if (isNaN(amount) || amount < 1) return notify("Invalid amount", "error");
    
    const target = normalizeFormId(targetRaw);
    const item = normalizeFormId(itemRaw);
    if (!target) return notify("Invalid target FormID", "error");
    if (!item) return notify("Invalid item FormID", "error");
    
    sendToBackend(COMMANDS.REMOVE_ITEM, { targetPlayerId: target, itemId: item, amount });
    notify(`Removing ${amount}x ${item} from ${target}`, "success");
}


function clearFields() {
    document.getElementById("targetFormId").value = "";
    document.getElementById("itemFormId").value = "";
    document.getElementById("itemAmount").value = "1";
    notify("Fields cleared", "success");
}

// Teleport
function teleportToMe() {
    const raw = document.getElementById("teleportTargetId").value;
    if (!raw) return notify("Enter player FormID", "error");
    const target = normalizeFormId(raw);
    if (!target) return notify("Invalid FormID", "error");
    sendToBackend(COMMANDS.TELEPORT_TO_ME, { targetPlayerId: target });
    notify(`Teleporting ${target} to your location`, "success");
}

function teleportToLocation(locationKey) {
    const raw = document.getElementById("teleportTargetId").value;
    if (!raw) return notify("Enter player FormID first", "error");
    const target = normalizeFormId(raw);
    if (!target) return notify("Invalid FormID", "error");
    const loc = LOCATIONS[locationKey];
    if (!loc) return notify("Unknown location", "error");
    sendToBackend(COMMANDS.TELEPORT_TO_LOCATION, { targetPlayerId: target, locationName: loc.name });
    notify(`Teleporting ${target} to ${loc.name}`, "success");
}

function renderLocations() {
    const majorGrid = document.getElementById("majorHoldsGrid");
    const minorGrid = document.getElementById("minorPlacesGrid");
    const templesGrid = document.getElementById("templesGrid");
    if (!majorGrid || !minorGrid || !minorGrid) return;
    majorGrid.innerHTML = "";
    minorGrid.innerHTML = "";
    templesGrid.innerHTML = "";
    Object.entries(LOCATIONS).forEach(([key, loc]) => {
        const btn = document.createElement("button");
        btn.className = "location-btn";
        btn.textContent = loc.name;
        btn.addEventListener("click", () => teleportToLocation(key));
        if (loc.category === "major") majorGrid.appendChild(btn);
        if (loc.category === "minor") minorGrid.appendChild(btn);
        if (loc.category === "temple") templesGrid.appendChild(btn);
    });
}

// NPC Spawner
function spawnNPC() {
    const npcRaw = document.getElementById("npcFormId").value;
    const count = parseInt(document.getElementById("npcCount").value, 10);
    if (!npcRaw) return notify("Enter NPC FormID", "error");
    if (isNaN(count) || count < 1) return notify("Invalid count", "error");
    const npc = normalizeFormId(npcRaw);
    if (!npc) return notify("Invalid NPC FormID", "error");
    sendToBackend(COMMANDS.SPAWN_NPC, { npcId: npc, count: count });
    notify(`Spawning ${count}x ${npc} at your location`, "success");
}

function spawnNPCPreset(formId, name) {
    const count = parseInt(document.getElementById("npcCount").value, 10);
    sendToBackend(COMMANDS.SPAWN_NPC, { npcId: formId, count: count });
    notify(`Spawning ${count}x ${name} at your location`, "success");
}

function renderNPCPresets() {
    const container = document.getElementById("npcPresets");
    if (!container) return;
    container.innerHTML = NPC_PRESETS.map(preset => `
        <button class="npc-preset-btn" data-id="${preset.formId}" data-name="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</button>
    `).join("");
    container.querySelectorAll(".npc-preset-btn").forEach(btn => {
        btn.addEventListener("click", () => spawnNPCPreset(btn.dataset.id, btn.dataset.name));
    });
}

// Perks & Skills
function getPerkTargetPlayer() {
    const raw = document.getElementById("perkTargetPlayerId").value;
    if (!raw) {
        notify("Enter target player FormID", "error");
        return null;
    }
    const target = normalizeFormId(raw);
    if (!target) {
        notify("Invalid target FormID", "error");
        return null;
    }
    return target;
}

function incrementSkill(skillName, increment) {
    const target = getPerkTargetPlayer();
    if (!target) return;
    sendToBackend(COMMANDS.INCREMENT_SKILL, { targetPlayerId: target, skillName: skillName, increment: increment });
}

function renderSkills() {
    const container = document.getElementById("skillsGrid");
    if (!container) return;
    const incrementAmount = parseInt(document.getElementById("skillIncrementAmount").value, 10);
    
    container.innerHTML = SKILLS.map(skill => `
        <div class="skill-card">
            <span class="skill-name">${escapeHtml(skill)}</span>
            <div class="skill-controls">
                <span class="skill-value">${skillValues[skill] || 15}</span>
                <button class="skill-increment-btn" data-skill="${escapeHtml(skill)}" data-increment="${incrementAmount}">+</button>
            </div>
        </div>
    `).join("");
    
    container.querySelectorAll(".skill-increment-btn").forEach(btn => {
        const skillName = btn.dataset.skill;
        const increment = parseInt(btn.dataset.increment, 10);
        btn.addEventListener("click", () => incrementSkill(skillName, increment));
    });
}

function updateSkillIncrementButtons() {
    const incrementAmount = parseInt(document.getElementById("skillIncrementAmount").value, 10);
    const incrementBtns = document.querySelectorAll(".skill-increment-btn");
    incrementBtns.forEach(btn => {
        const skillName = btn.dataset.skill;
        btn.dataset.increment = incrementAmount;
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener("click", () => incrementSkill(skillName, incrementAmount));
    });
}

function addPerk() {
    const target = getPerkTargetPlayer();
    if (!target) return;
    const perkRaw = document.getElementById("perkFormId").value;
    if (!perkRaw) return notify("Enter perk FormID", "error");
    const perkFormId = normalizeFormId(perkRaw);
    if (!perkFormId) return notify("Invalid perk FormID", "error");
    
    sendToBackend(COMMANDS.ADD_PERK, { targetPlayerId: target, perkFormId: perkFormId });
    document.getElementById("perkFormId").value = "";
    notify(`Added perk ${perkFormId} to ${target}`, "success");
}

function removePerk() {
    const target = getPerkTargetPlayer();
    if (!target) return;
    const perkRaw = document.getElementById("perkFormId").value;
    if (!perkRaw) return notify("Enter perk FormID", "error");
    const perkFormId = normalizeFormId(perkRaw);
    if (!perkFormId) return notify("Invalid perk FormID", "error");
    
    sendToBackend(COMMANDS.REMOVE_PERK, { targetPlayerId: target, perkFormId: perkFormId });
    document.getElementById("perkFormId").value = "";
    notify(`Removed perk ${perkFormId} from ${target}`, "success");
}

function updatePerksList() {
    const target = getPerkTargetPlayer();
    if (!target) return;
    sendToBackend(COMMANDS.GET_PLAYER_PERKS, { targetPlayerId: target });
    notify(`Retrieving perks for ${target}...`, "success");
}

function deleteAllPerks() {
    const target = getPerkTargetPlayer();
    if (!target) return;
    sendToBackend(COMMANDS.DELETE_ALL_PERKS, { targetPlayerId: target });
    notify(`Deleting all perks from ${target}`, "success");
}

function removeGrantedPerkFromList(index) {
    grantedPerks.splice(index, 1);
    renderGrantedPerksList();
}

function renderGrantedPerksList() {
    const container = document.getElementById("grantedPerksList");
    if (!container) return;
    
    if (grantedPerks.length === 0) {
        container.innerHTML = '<p class="muted" style="text-align: center;">No perks loaded for this player</p>';
        return;
    }
    
    container.innerHTML = grantedPerks.map((perk, index) => `
        <div class="granted-perk-item">
            <div>
                <span class="granted-perk-name">${escapeHtml(perk.name || perk.formId)}</span>
                <span class="granted-perk-id">${escapeHtml(perk.formId)}</span>
            </div>
            <button class="remove-granted-perk-btn" data-index="${index}">Remove</button>
        </div>
    `).join("");
    
    container.querySelectorAll(".remove-granted-perk-btn").forEach(btn => {
        const index = parseInt(btn.dataset.index, 10);
        btn.addEventListener("click", () => removeGrantedPerkFromList(index));
    });
}

// Weather
function setCustomWeather() {
    const formIdRaw = document.getElementById("customWeatherFormId").value;
    if (!formIdRaw) return notify("Enter weather FormID", "error");
    const weatherFormId = normalizeFormId(formIdRaw);
    if (!weatherFormId) return notify("Invalid weather FormID", "error");
    
    sendToBackend(COMMANDS.SET_WEATHER, { weatherFormId: weatherFormId });
    notify(`Setting custom weather ${weatherFormId}`, "success");
    document.getElementById("customWeatherFormId").value = "";
}

function renderWeather() {
    const container = document.getElementById("weatherList");
    if (!container) return;
    container.innerHTML = WEATHER_PRESETS.map(w => `
        <button class="weather-card" data-id="${w.formId}" data-name="${escapeHtml(w.name)}">
            <span class="weather-name">${escapeHtml(w.name)}</span>
            <span class="weather-formid">${w.formId}</span>
        </button>
    `).join("");
    container.querySelectorAll(".weather-card").forEach(btn => {
        btn.addEventListener("click", () => setWeather(btn.dataset.name, btn.dataset.id));
    });
}

function setWeather(name, formId) {
    sendToBackend(COMMANDS.SET_WEATHER, { weatherName: name, weatherFormId: formId });
    notify(`Changing weather to ${name}`, "success");
    document.getElementById("currentWeatherStatus").innerHTML = `🌎 ${name}`;
}

function resetWeather() {
    sendToBackend(COMMANDS.RESET_WEATHER, {});
    notify("Weather reset to default", "success");
    document.getElementById("currentWeatherStatus").innerHTML = "— Reset to default —";
}

// UI
function setActiveTab(tabId) {
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.getElementById(`tab-${tabId}`)?.classList.add("active");
    document.querySelector(`.tab[data-tab="${tabId}"]`)?.classList.add("active");
}

function closeMenu() {
    window.skyrimPlatform.sendMessage("vgr:ui:close", "admin_menu");
}

function openMenu() {
    window.skyrimPlatform.sendMessage("vgr:ui:open", "admin_menu");
}

function onKeyDown(e) {
    if (e.key === "F4") {
        e.preventDefault();
        const menu = document.getElementById("adminMenu");
        menu.classList.contains("hidden") ? openMenu() : closeMenu();
    } else if (e.key === "Escape") {
        closeMenu();
    }
}

window.VGRAdmin = {
    open: openMenu,
    close: closeMenu,
    receive: (type, data) => {
        if (type === "weather_update" && data?.weatherFormId) {
            document.getElementById("currentWeatherStatus").innerHTML = `🌧️ ${data.weatherFormId}`;
        }
        if (type === "notification" && data?.message) {
            notify(data.message, data.variant || "");
        }
        if (type === "skill_update" && data?.skillName && data?.value !== undefined) {
            skillValues[data.skillName] = data.value;
            renderSkills();
        }
        if (type === "perk_list" && data?.perks) {
            grantedPerks = data.perks;
            renderGrantedPerksList();
        }
        if (type === "perk_added" && data?.perkFormId) {
            if (!grantedPerks.some(p => p.formId === data.perkFormId)) {
                grantedPerks.push({ formId: data.perkFormId, name: data.perkName || data.perkFormId });
                renderGrantedPerksList();
            }
        }
        if (type === "perk_removed" && data?.perkFormId) {
            grantedPerks = grantedPerks.filter(p => p.formId !== data.perkFormId);
            renderGrantedPerksList();
        }
        if (type === "all_perks_deleted") {
            grantedPerks = [];
            renderGrantedPerksList();
        }
    }
};

window.addEventListener("message", (e) => {
    if (e.data?.source === "vgr-admin-backend") {
        window.VGRAdmin.receive(e.data.type, e.data.payload);
    }
});

// Init
document.addEventListener("DOMContentLoaded", () => {
    renderLocations();
    // NPC presets + spawner are owned by npc_spawner.js (full spawner tab)
    renderSkills();
    renderGrantedPerksList();
    renderWeather();
    
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
    });
    document.getElementById("closeMenuBtn").addEventListener("click", closeMenu);
    document.getElementById("giveItemBtn").addEventListener("click", giveItem);
	document.getElementById("removeItemBtn").addEventListener("click", removeItem);
    document.getElementById("clearFormBtn").addEventListener("click", clearFields);
    document.getElementById("teleportToMeBtn").addEventListener("click", teleportToMe);
    // spawnNpcBtn is owned by npc_spawner.js
    document.getElementById("addPerkBtn").addEventListener("click", addPerk);
    document.getElementById("removePerkBtn").addEventListener("click", removePerk);
    document.getElementById("updatePerksListBtn").addEventListener("click", updatePerksList);
    document.getElementById("deleteAllPerksBtn").addEventListener("click", deleteAllPerks);
    document.getElementById("skillIncrementAmount").addEventListener("change", updateSkillIncrementButtons);
    document.getElementById("setCustomWeatherBtn").addEventListener("click", setCustomWeather);
    document.getElementById("resetWeatherBtn").addEventListener("click", resetWeather);
    document.addEventListener("keydown", onKeyDown);
});



window.addEventListener('vgr:ui_manager:open:admin_menu', (event) => {
	if (!adminmenu) return;
    adminmenu.classList.remove("hidden");
    adminmenu.setAttribute("aria-hidden", "false");
});

window.addEventListener('vgr:ui_manager:close:admin_menu', (event) => {
    if (!adminmenu) return;
    adminmenu.classList.add("hidden");
	adminmenu.setAttribute("aria-hidden", "true");
});
