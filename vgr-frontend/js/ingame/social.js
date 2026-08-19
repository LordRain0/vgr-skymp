// ---------- MMO STYLE FRIENDSHIP + PRIVATE POPUP CHAT ----------
const MAX_FRIENDS = 12;

// Server-driven limits; the friends payload overrides these defaults
let maxFriendsLimit = MAX_FRIENDS;
let maxMessageLength = 250;

let friends = [];
let incomingRequests = [];
let outgoingRequests = [];
let currentFilter = "all";
let currentSort = "default";
let chatHistories = new Map();
let openPopups = new Map();
let pendingChatLoads = new Set();

function vgrSocialSend(type, payload) {
    const map = {
        load: "vgr:social:load",
        addFriend: "vgr:social:addFriend",
        removeFriend: "vgr:social:removeFriend",
        loadChat: "vgr:social:loadChat",
        sendMessage: "vgr:social:sendMessage",
        acceptFriend: "vgr:social:acceptFriend",
        declineFriend: "vgr:social:declineFriend"
    };
    const msg = map[type];
    if (!msg) return;
    window.skyrimPlatform?.sendMessage?.(msg, payload || {});
}

function notifySocial(message, durationMs = 2200, variant = "info") {
    window.vgr_send_notification?.(2, String(message || ""), { variant, durationMs });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        if (m === "'") return '&#39;';
        return m;
    });
}

function friendId(friend) {
    return friend.formDesc || friend.id;
}

function findFriend(friendIdValue) {
    return friends.find(f => friendId(f) === friendIdValue);
}

function initChatHistory(friendIdValue) {
    if (!chatHistories.has(friendIdValue)) {
        chatHistories.set(friendIdValue, []);
    }
}

function setChatHistory(friendIdValue, messages) {
    chatHistories.set(friendIdValue, Array.isArray(messages) ? messages : []);
    if (openPopups.has(friendIdValue)) {
        renderPopupMessages(openPopups.get(friendIdValue).windowElement, friendIdValue);
    }
}

function addChatMessage(friendIdValue, messageText, sentByMe, timestamp) {
    initChatHistory(friendIdValue);
    const history = chatHistories.get(friendIdValue);
    history.push({
        text: messageText,
        sentByMe: !!sentByMe,
        timestamp: timestamp || Date.now()
    });
    if (history.length > 100) history.shift();

    if (openPopups.has(friendIdValue)) {
        renderPopupMessages(openPopups.get(friendIdValue).windowElement, friendIdValue);
    }
}

function sendPrivateMessage(friendIdValue, messageText) {
    const trimmed = messageText.trim();
    if (trimmed === "") return false;
    if (trimmed.length > maxMessageLength) {
        notifySocial(`Message too long! (max ${maxMessageLength} chars)`, 3000, "warning");
        return false;
    }

    const friend = findFriend(friendIdValue);
    if (!friend) return false;

    vgrSocialSend("sendMessage", {
        toFormDesc: friendIdValue,
        text: trimmed,
        clientNonce: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    });
    return true;
}

function renderPopupMessages(popupElement, friendIdValue) {
    const messagesContainer = popupElement.querySelector('.popup-messages');
    if (!messagesContainer) return;

    const history = chatHistories.get(friendIdValue) || [];
    messagesContainer.innerHTML = '';

    if (history.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.style.textAlign = 'center';
        emptyDiv.style.color = '#8a8a6e';
        emptyDiv.style.padding = '2rem';
        emptyDiv.style.fontSize = '0.8rem';
        emptyDiv.innerText = 'No messages yet. Start the conversation!';
        messagesContainer.appendChild(emptyDiv);
    } else {
        history.forEach(msg => {
            const msgDiv = document.createElement('div');
            msgDiv.className = `popup-message ${msg.sentByMe ? 'message-sent' : 'message-received'}`;
            const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            msgDiv.innerHTML = `<div class="message-bubble">${escapeHtml(msg.text)}</div><div class="message-time">${time}</div>`;
            messagesContainer.appendChild(msgDiv);
        });
    }
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function openChatPopup(friendIdValue) {
    const friend = findFriend(friendIdValue);
    if (!friend) return;

    if (openPopups.has(friendIdValue)) {
        const existing = openPopups.get(friendIdValue);
        existing.windowElement.style.display = 'flex';
        const input = existing.windowElement.querySelector('.popup-message-input');
        if (input) input.focus();
        return;
    }

    const popupContainer = document.getElementById('popupContainer');
    const popupDiv = document.createElement('div');
    popupDiv.className = 'popup-chat-window';
    popupDiv.dataset.friendId = friendIdValue;

    const statusText = friend.status === 'online' ? 'Online' : 'Offline';
    const avatarLetter = friend.name.charAt(0).toUpperCase();

    popupDiv.innerHTML = `
        <div class="popup-header" data-drag-handle>
            <div class="popup-header-info">
                <div class="popup-avatar">${escapeHtml(avatarLetter)}</div>
                <span class="popup-name">${escapeHtml(friend.name)}</span>
                <span class="popup-status-badge">${statusText}</span>
            </div>
            <button class="popup-close" title="Close chat">X</button>
        </div>
        <div class="popup-messages"></div>
        <div class="popup-input-area">
            <input type="text" class="popup-message-input" placeholder="Write a pigeon message..." maxlength="${maxMessageLength}">
            <button class="popup-send-btn">SEND</button>
        </div>
    `;

    popupContainer.appendChild(popupDiv);
    openPopups.set(friendIdValue, { windowElement: popupDiv, friendId: friendIdValue });
    renderPopupMessages(popupDiv, friendIdValue);

    const closeBtn = popupDiv.querySelector('.popup-close');
    const sendBtn = popupDiv.querySelector('.popup-send-btn');
    const messageInput = popupDiv.querySelector('.popup-message-input');

    closeBtn.addEventListener('click', () => {
        openPopups.delete(friendIdValue);
        popupDiv.remove();
    });

    const sendMessage = () => {
        const msg = messageInput.value;
        if (msg.trim()) {
            sendPrivateMessage(friendIdValue, msg);
            messageInput.value = '';
            messageInput.focus();
        }
    };

    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

    let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
    const header = popupDiv.querySelector('.popup-header');
    header.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('popup-close')) return;
        isDragging = true;
        const rect = popupDiv.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        popupDiv.style.position = 'fixed';
        popupDiv.style.cursor = 'grabbing';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let newLeft = e.clientX - dragOffsetX;
        let newTop = e.clientY - dragOffsetY;
        newLeft = Math.max(0, Math.min(window.innerWidth - popupDiv.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - popupDiv.offsetHeight, newTop));
        popupDiv.style.left = newLeft + 'px';
        popupDiv.style.top = newTop + 'px';
        popupDiv.style.right = 'auto';
        popupDiv.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { isDragging = false; if (popupDiv) popupDiv.style.cursor = ''; });

    messageInput.focus();
    pendingChatLoads.add(friendIdValue);
    vgrSocialSend("loadChat", { withFormDesc: friendIdValue });
}

function updatePopupStatusBadges() {
    openPopups.forEach((popup, friendIdValue) => {
        const friend = findFriend(friendIdValue);
        if (!friend) return;
        const badge = popup.windowElement.querySelector('.popup-status-badge');
        if (badge) {
            badge.innerText = friend.status === 'online' ? 'Online' : 'Offline';
        }
    });
}

// ========== FRIEND LIST RENDERING ==========
function updateCounterUI() {
    const counterSpan = document.getElementById('friendCounter');
    if (counterSpan) {
        counterSpan.innerText = `${friends.length} / ${maxFriendsLimit}`;
        if (friends.length >= maxFriendsLimit) {
            counterSpan.style.color = "#ffbc7a";
            counterSpan.style.border = "1px solid #ff9050";
        } else {
            counterSpan.style.color = "#e3ffcf";
            counterSpan.style.border = "1px solid #9ccf7c";
        }
    }
}

function getFilteredFriends() {
    if (currentFilter === "online") return friends.filter(f => f.status === "online");
    return [...friends];
}

function applySort(friendsArray) {
    let sorted = [...friendsArray];
    if (currentSort === "name") {
        sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else {
        sorted.sort((a, b) => friendId(a).localeCompare(friendId(b)));
    }
    return sorted;
}

function renderRequestCard(entry, type) {
    const fid = friendId(entry);
    const card = document.createElement('div');
    card.className = 'friend-card request-card request-card-' + type;
    const avatarLetter = entry.name.charAt(0).toUpperCase();
    const statusText = entry.status === 'online' ? 'Online' : 'Offline';
    const statusClass = entry.status === 'online' ? 'status-online' : 'status-offline';
    const dotColor = entry.status === 'online' ? '#51ff51' : '#6b6960';

    let actionsHtml = '';
    if (type === 'incoming') {
        actionsHtml = `
            <div class="request-actions">
                <button class="request-btn request-btn-accept" data-id="${escapeHtml(fid)}" title="Accept request">ACCEPT</button>
                <button class="request-btn request-btn-decline" data-id="${escapeHtml(fid)}" title="Decline request">DENY</button>
            </div>`;
    } else {
        actionsHtml = `
            <div class="request-actions">
                <span class="request-pending-label">REQUEST SENT</span>
                <button class="request-btn request-btn-cancel" data-id="${escapeHtml(fid)}" title="Cancel request">CANCEL</button>
            </div>`;
    }

    card.innerHTML = `
        <div class="friend-info">
            <div class="avatar">${escapeHtml(avatarLetter)}</div>
            <div class="friend-details">
                <div class="friend-name">${escapeHtml(entry.name)}</div>
                <div class="friend-status ${statusClass}">
                    <span style="width:8px;height:8px;border-radius:50%;display:inline-block;background:${dotColor};"></span>
                    <span>${type === 'incoming' ? 'Incoming request' : statusText}</span>
                </div>
            </div>
        </div>
        ${actionsHtml}
    `;
    return card;
}

function renderFriendRequests() {
    const panel = document.getElementById('friendRequestsPanel');
    const container = document.getElementById('friendRequestsContainer');
    const counter = document.getElementById('friendRequestsCounter');
    if (!panel || !container) return;

    const totalRequests = incomingRequests.length + outgoingRequests.length;
    if (counter) counter.innerText = String(totalRequests);

    if (totalRequests === 0) {
        panel.hidden = true;
        container.innerHTML = '';
        return;
    }

    panel.hidden = false;
    container.innerHTML = '';

    incomingRequests.forEach(entry => {
        container.appendChild(renderRequestCard(entry, 'incoming'));
    });
    outgoingRequests.forEach(entry => {
        container.appendChild(renderRequestCard(entry, 'outgoing'));
    });

    container.querySelectorAll('.request-btn-accept').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vgrSocialSend('acceptFriend', { formDesc: btn.dataset.id });
        });
    });

    container.querySelectorAll('.request-btn-decline, .request-btn-cancel').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vgrSocialSend('declineFriend', { formDesc: btn.dataset.id });
        });
    });
}

function renderFriendList() {
    const container = document.getElementById('friendListContainer');
    if (!container) return;

    let filtered = getFilteredFriends();
    let processed = applySort(filtered);

    if (processed.length === 0) {
        container.innerHTML = `<div class="empty-message">No friends yet ...<br>invite allies</div>`;
        updateCounterUI();
        return;
    }

    container.innerHTML = '';
    processed.forEach(friend => {
        const fid = friendId(friend);
        const card = document.createElement('div');
        card.className = 'friend-card';
        const avatarLetter = friend.name.charAt(0).toUpperCase();
        let statusText = "Online", statusClass = "status-online", dotColor = "#51ff51";
        if (friend.status === "offline") {
            statusText = "Offline";
            statusClass = "status-offline";
            dotColor = "#6b6960";
        } else if (friend.status === "away") {
            statusText = "Away";
            statusClass = "status-away";
            dotColor = "#ffb347";
        }

        card.innerHTML = `
            <div class="friend-info">
                <div class="avatar">${escapeHtml(avatarLetter)}</div>
                <div class="friend-details">
                    <div class="friend-name">${escapeHtml(friend.name)}</div>
                    <div class="friend-status ${statusClass}">
                        <span style="width:8px;height:8px;border-radius:50%;display:inline-block;background:${dotColor}; box-shadow:0 0 2px currentColor;"></span>
                        <span>${statusText}</span>
                    </div>
                </div>
            </div>
            <div class="friend-actions">
                <button class="icon-btn chat-popup-btn" data-id="${escapeHtml(fid)}" data-name="${escapeHtml(friend.name)}" title="Send pigeon">MSG</button>
                <button class="icon-btn remove-btn" data-id="${escapeHtml(fid)}" title="Remove friend">X</button>
            </div>
        `;
        container.appendChild(card);
    });

    document.querySelectorAll('.chat-popup-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openChatPopup(btn.dataset.id);
        });
    });

    document.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fid = btn.dataset.id;
            const friend = findFriend(fid);
            if (!friend) return;
            vgrSocialSend("removeFriend", { formDesc: fid });
        });
    });

    updateCounterUI();
    updatePopupStatusBadges();
}

function addFriend(rawName) {
    let name = rawName.trim();
    if (name === "") { notifySocial("Enter a valid hero name!", 2400, "warning"); return false; }
    if (name.length > 22) name = name.slice(0, 22);
    vgrSocialSend("addFriend", { name: name });
    return true;
}

function setFilterOnline() { currentFilter = "online"; renderFriendList(); notifySocial("Showing online"); }
function setFilterAll() { currentFilter = "all"; renderFriendList(); notifySocial("All allies"); }
function setSortByName() { currentSort = "name"; renderFriendList(); notifySocial("Sorted by name"); }
function applyFriendsPayload(payload) {
    if (Number(payload.maxFriends) > 0) maxFriendsLimit = Number(payload.maxFriends);
    if (Number(payload.maxMessageLength) > 0) maxMessageLength = Number(payload.maxMessageLength);
    const accepted = payload.accepted || payload.friends || [];
    friends = accepted.map(f => ({
        id: f.formDesc || f.id,
        formDesc: f.formDesc || f.id,
        name: f.name || "Unknown",
        status: f.status || "offline"
    }));

    incomingRequests = (payload.incoming || []).map(f => ({
        id: f.formDesc || f.id,
        formDesc: f.formDesc || f.id,
        name: f.name || "Unknown",
        status: f.status || "offline"
    }));

    outgoingRequests = (payload.outgoing || []).map(f => ({
        id: f.formDesc || f.id,
        formDesc: f.formDesc || f.id,
        name: f.name || "Unknown",
        status: f.status || "offline"
    }));

    renderFriendRequests();
    renderFriendList();
}

window.vgrSocialUpdate = function(data) {
    if (!data || !data.action) return;

    if (data.action === "friends") {
        applyFriendsPayload(data);
        return;
    }

    if (data.action === "chatHistory") {
        const withFormDesc = data.withFormDesc;
        if (!withFormDesc) return;
        pendingChatLoads.delete(withFormDesc);
        setChatHistory(withFormDesc, data.messages || []);
        return;
    }

    if (data.action === "incomingMessage") {
        const peerFormDesc = data.sentByMe ? data.toFormDesc : data.fromFormDesc;
        if (!peerFormDesc) return;

        addChatMessage(peerFormDesc, data.text, !!data.sentByMe, data.timestamp);

        if (!data.sentByMe && !openPopups.has(peerFormDesc)) {
            const senderName = data.fromName || "A friend";
            notifySocial(`New message from ${senderName}`, 2500, "info");
        }
        return;
    }

    if (data.action === "notification") {
        notifySocial(data.message || "", data.level === "error" ? 3000 : 2200, data.level || "info");
    }
};

function bindUiEvents() {
    document.getElementById('addFriendBtn').addEventListener('click', () => {
        const input = document.getElementById('friendNameInput');
        addFriend(input.value);
        input.value = '';
        input.focus();
    });
    document.getElementById('friendNameInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') document.getElementById('addFriendBtn').click();
    });
    document.getElementById('showOnlineBtn').addEventListener('click', setFilterOnline);
    document.getElementById('showAllBtn').addEventListener('click', setFilterAll);
    document.getElementById('sortByNameBtn').addEventListener('click', setSortByName);
}

// ========== UI VISIBILITY ==========
socialChamberToggle(false);
document.getElementById('popupContainer').style.display = 'none';

function socialChamberToggle(unhideUI) {
    document.getElementById('friendsContainer').style.display = unhideUI ? 'block' : 'none';
}

window.addEventListener('vgr:ui_manager:open:social', () => {
    socialChamberToggle(true);
    document.getElementById('popupContainer').style.display = '';
    vgrSocialSend("load");
});

window.addEventListener('vgr:ui_manager:close:social', () => {
    socialChamberToggle(false);
    document.getElementById('popupContainer').style.display = 'none';
});

function init() {
    bindUiEvents();
    renderFriendRequests();
    renderFriendList();
}

init();
