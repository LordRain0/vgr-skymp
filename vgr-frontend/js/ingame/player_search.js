(function initVgrPlayerSearch() {
  'use strict';
// Player Search UI
// Store master player list and current filter
let masterPlayerList = [];
let currentFilter = "";

// DOM Elements
const overlay = document.getElementById("playerSearchOverlay");
const searchInput = document.getElementById("playerSearchInput");
const resultsList = document.getElementById("resultsList");
const resultCount = document.getElementById("resultCount");
const closeFooterBtn = document.getElementById("closeFooterBtn");

// Sample player data - used when no real data is available
const SAMPLE_PLAYERS = [
    { name: "Daniel", formId: "0x00014AD4" },
    { name: "Aldren Blackwood", formId: "0x00023B5C" },
    { name: "Mira Snow-Born", formId: "0x00038C21" },
    { name: "Thorne Irongrip", formId: "0x000451E8" },
    { name: "Seren Ashvale", formId: "0x00056A33" },
    { name: "Lord Valion", formId: "0x00067D4F" },
    { name: "Kharjo", formId: "0x0001B1D2" },
    { name: "J'zargo", formId: "0x0001C1A4" },
    { name: "Lydia", formId: "0x000A2C8E" },
    { name: "Serana", formId: "0x02002B74" },
    { name: "Brynjolf", formId: "0x0001B1C4" },
    { name: "Delphine", formId: "0x000134AA" },
    { name: "Farkas", formId: "0x0001A693" },
    { name: "Vilkas", formId: "0x0001A694" },
    { name: "Aela", formId: "0x0001A697" },
    { name: "Cicero", formId: "0x0001BDB6" }
];

// Send selection to backend (only when player is selected)
function sendPlayerSelectionToBackend(playerName, formId) {
    const packet = { 
        source: "vgr:player_search:select", 
        playerName: playerName, 
        formId: formId, 
        timestamp: Date.now() 
    };
    
    if (window.skyrimPlatform?.sendMessage) {
        window.skyrimPlatform.sendMessage(packet);
    } else {
        console.log("[MOCK] Player selected:", playerName, formId);
    }
}

// Render search results based on current filter
function renderResults() {
    if (!resultsList || !resultCount) return;
    let filtered = masterPlayerList;
    
    if (currentFilter.trim().length > 0) {
        const filterLower = currentFilter.toLowerCase();
        filtered = masterPlayerList.filter(player => 
            player.name.toLowerCase().includes(filterLower)
        );
    }
    
    resultCount.textContent = filtered.length;
    
    if (filtered.length === 0) {
        resultsList.innerHTML = `
            <div class="empty-state">
                <span>ðŸ”</span>
                <p>No players found</p>
            </div>
        `;
        return;
    }
    
    resultsList.innerHTML = filtered.map(player => `
        <div class="result-item" data-formid="${player.formId}" data-name="${escapeHtml(player.name)}">
            <span class="result-name">${escapeHtml(player.name)}</span>
            <span class="result-formid">${player.formId}</span>
        </div>
    `).join("");
    
    // Add click handlers for player selection
    resultsList.querySelectorAll(".result-item").forEach(item => {
        item.addEventListener("click", () => {
            const formId = item.dataset.formid;
            const playerName = item.dataset.name;
            selectPlayer(formId, playerName);
        });
    });
}

// Select player - sends payload to backend ONCE when clicked
function selectPlayer(formId, playerName) {
    // Send to backend
    sendPlayerSelectionToBackend(playerName, formId);
    
    // Copy to clipboard
    copyToClipboard(formId);
}

// Copy to clipboard
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
}

// Filter players as user types (client-side only, no backend calls)
function onSearchInput(e) {
    currentFilter = e.target.value;
    renderResults();
}

// Clear search filter (now just resets the input and filter)
function clearSearch() {
    if (searchInput) searchInput.value = "";
    currentFilter = "";
    renderResults();
}

// Initialize/Refresh player data (called every time popup opens)
function refreshPlayerData() {
    masterPlayerList = [...SAMPLE_PLAYERS];
    currentFilter = "";
    if (searchInput) searchInput.value = "";
    renderResults();
}

// Open popup - refreshes data every time
function openPopup() {
    if (!overlay) return;
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    try {
        refreshPlayerData();
    } catch (err) {
        console.error("[VGR Player Search] failed to render player data", err);
    }
    searchInput?.focus();
}

// Close popup
function closePopup() {
    if (!overlay) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    clearSearch();
}

// Global API
window.VGRPlayerSearch = {
    open: openPopup,
    close: closePopup,
    refreshData: refreshPlayerData,
    setPlayerList: function(players) {
        masterPlayerList = players;
        renderResults();
    },
    getPlayerList: function() {
        return masterPlayerList;
    }
};

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
}

// Event listeners
document.addEventListener("DOMContentLoaded", () => {
    resultsList.innerHTML = `
        <div class="empty-state">
            <span>ðŸ‘¤</span>
            <p>Open the search to load players</p>
        </div>
    `;
    
    if (closeFooterBtn) closeFooterBtn.addEventListener("click", closePopup);
    if (searchInput) searchInput.addEventListener("input", onSearchInput);
});

// Listen for messages from backend to update player list
window.addEventListener("message", (e) => {
    if (e.data?.source === "vgr-player-search-backend" && e.data?.type === "player_list") {
        masterPlayerList = e.data.payload.players || [];
        renderResults();
    }
});

// Listen for custom events to open/close
window.addEventListener("vgr:ui_manager:open:player_search", () => openPopup());
window.addEventListener("vgr:ui_manager:close:player_search", () => closePopup());
})();
