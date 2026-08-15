(function () {
  "use strict";

  const root = document.getElementById("vgr-access-control");
  if (!root) return;

  const state = {
    sessionId: null,
    object: null,
    owner: null,
    users: [],
    role: "visitor",
    canManage: false,
    canManageOwner: false,
    canAddUser: false,
    canRemoveUsers: false,
    canToggleLock: false,
    searchMode: "user",
    pendingConfirm: null,
    debounce: null,
  };

  const els = {
    context: document.getElementById("accessContextPanel"),
    contextTitle: document.getElementById("accessContextTitle"),
    contextType: document.getElementById("accessContextType"),
    contextActions: document.getElementById("accessContextActions"),
    contextClose: document.getElementById("accessContextClose"),
    manage: document.getElementById("accessManagePanel"),
    manageTitle: document.getElementById("accessManageTitle"),
    manageType: document.getElementById("accessManageType"),
    manageClose: document.getElementById("accessManageClose"),
    lockedToggle: document.getElementById("accessLockedToggle"),
    lockedLabel: document.getElementById("accessLockedLabel"),
    roleBadge: document.getElementById("accessRoleBadge"),
    ownerList: document.getElementById("accessOwnerList"),
    usersList: document.getElementById("accessUsersList"),
    assignOwner: document.getElementById("accessAssignOwner"),
    addUser: document.getElementById("accessAddUser"),
    infoGrid: document.getElementById("accessInfoGrid"),
    searchModal: document.getElementById("accessSearchModal"),
    searchMode: document.getElementById("accessSearchMode"),
    searchTitle: document.getElementById("accessSearchTitle"),
    searchInput: document.getElementById("accessSearchInput"),
    searchResults: document.getElementById("accessSearchResults"),
    searchClose: document.getElementById("accessSearchClose"),
    confirm: document.getElementById("accessConfirm"),
    confirmTitle: document.getElementById("accessConfirmTitle"),
    confirmMessage: document.getElementById("accessConfirmMessage"),
    confirmCancel: document.getElementById("accessConfirmCancel"),
    confirmOk: document.getElementById("accessConfirmOk"),
    toast: document.getElementById("accessToast"),
    hint: document.getElementById("accessHint"),
    hintStatus: document.getElementById("accessHintStatus"),
    hintOwner: document.getElementById("accessHintOwner"),
  };

  function send(name, payload) {
    window.skyrimPlatform?.sendMessage?.(name, payload || {});
  }

  function titleCase(value) {
    const text = String(value || "object");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function setVisible(visible) {
    root.hidden = !visible;
    root.setAttribute("aria-hidden", visible ? "false" : "true");
    root.classList.toggle("visible", visible);
    if (visible) root.classList.remove("access-passive");
  }

  function hasActivePanel() {
    return els.context?.classList.contains("active") ||
      els.manage?.classList.contains("active") ||
      (els.searchModal && !els.searchModal.hidden) ||
      (els.confirm && !els.confirm.hidden);
  }

  function syncPassiveShell() {
    if (hasActivePanel()) {
      setVisible(true);
      return;
    }

    const passiveVisible = els.toast?.classList.contains("visible") || els.hint?.classList.contains("visible");
    root.hidden = !passiveVisible;
    root.setAttribute("aria-hidden", passiveVisible ? "false" : "true");
    root.classList.toggle("visible", passiveVisible);
    root.classList.toggle("access-passive", passiveVisible);
  }

  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = String(message || "");
    els.toast.classList.add("visible");
    syncPassiveShell();
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      els.toast.classList.remove("visible");
      syncPassiveShell();
    }, 2800);
  }

  function hideHint() {
    if (!els.hint) return;
    els.hint.classList.remove("visible", "locked", "unlocked");
    els.hint.setAttribute("aria-hidden", "true");
    syncPassiveShell();
  }

  function renderHint(data) {
    if (!els.hint) return;
    if (hasActivePanel()) {
      hideHint();
      return;
    }
    const objectType = titleCase(data.objectType || "door");
    const locked = data.locked === true;
    const owner = data.ownerName || "Unassigned";
    els.hintStatus.textContent = `${objectType} ${locked ? "Locked" : "Unlocked"}`;
    els.hintOwner.textContent = `Owner: ${owner}`;
    els.hint.classList.toggle("locked", locked);
    els.hint.classList.toggle("unlocked", !locked);
    els.hint.classList.add("visible");
    els.hint.setAttribute("aria-hidden", "false");
    syncPassiveShell();
    window.clearTimeout(renderHint.timer);
    renderHint.timer = window.setTimeout(hideHint, 1400);
  }

  function hidePanels() {
    els.context?.classList.remove("active");
    els.manage?.classList.remove("active");
    els.searchModal.hidden = true;
    els.confirm.hidden = true;
  }

  function closeUi() {
    hidePanels();
    setVisible(false);
    send("vgr:access:close", {});
  }

  function makeButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "access-button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function actionPayload(extra) {
    return Object.assign({ sessionId: state.sessionId }, extra || {});
  }

  function renderContext(data) {
    state.sessionId = data.sessionId || null;
    state.object = data.object || null;
    state.role = data.role || "visitor";

    hideHint();
    hidePanels();
    setVisible(true);

    const object = state.object || {};
    els.contextTitle.textContent = object.displayName || "Access Control";
    els.contextType.textContent = titleCase(object.type);
    els.contextActions.textContent = "";

    const options = data.options || {};
    if (options.open) {
      els.contextActions.appendChild(makeButton("Open", "access-button primary", () => {
        send("vgr:access:choice", actionPayload({ choice: "open" }));
      }));
    }
    if (options.manage) {
      els.contextActions.appendChild(makeButton("Manage", "access-button primary", () => {
        send("vgr:access:choice", actionPayload({ choice: "manage" }));
      }));
    }
    if (options.register) {
      els.contextActions.appendChild(makeButton("Register", "access-button primary", () => {
        confirmAction("Register Object", "Register this object for access control management?", () => {
          send("vgr:access:choice", actionPayload({ choice: "register" }));
        });
      }));
    }
    els.contextActions.appendChild(makeButton("Close", "access-button secondary", closeUi));
    els.context.classList.add("active");
  }

  function personLabel(person) {
    if (!person) return "None";
    return `${person.displayName || "Profile"} #${person.profileId}`;
  }

  function renderPerson(container, person, badge, onRemove) {
    const row = document.createElement("div");
    row.className = "access-person-row";

    const main = document.createElement("div");
    main.className = "access-person-main";
    const name = document.createElement("span");
    name.className = "access-person-name";
    name.textContent = personLabel(person);
    const role = document.createElement("span");
    role.className = "access-person-badge";
    role.textContent = badge;
    main.append(name, role);
    row.appendChild(main);

    if (onRemove) {
      row.appendChild(makeButton("Remove", "access-row-button danger", onRemove));
    }
    container.appendChild(row);
  }

  function renderPeople() {
    els.ownerList.textContent = "";
    els.usersList.textContent = "";

    if (state.owner) {
      renderPerson(els.ownerList, state.owner, "Owner", null);
    } else {
      const empty = document.createElement("div");
      empty.className = "access-empty-row";
      empty.textContent = "No owner assigned";
      els.ownerList.appendChild(empty);
    }

    if (state.users.length) {
      state.users.forEach((user) => {
        renderPerson(els.usersList, user, "User", state.canRemoveUsers ? () => {
          confirmAction("Remove User", `Remove ${personLabel(user)} from this object?`, () => {
            send("vgr:access:removeUser", actionPayload({ profileId: user.profileId }));
          });
        } : null);
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "access-empty-row";
      empty.textContent = "No users assigned";
      els.usersList.appendChild(empty);
    }
  }

  function renderInfo() {
    const object = state.object || {};
    const rows = [
      ["Object ID", object.id || "-"],
      ["Type", titleCase(object.type)],
      ["Revision", object.revision == null ? "-" : String(object.revision)],
      ["Door Pair", object.teleport ? (object.linksBack ? "Two-way teleport" : "Teleport, one-way link") : "Single reference"],
      ["Warning", object.pairWarning || "-"],
    ];
    if (Array.isArray(object.refs)) {
      object.refs.forEach((ref, index) => rows.push([`Reference ${index + 1}`, ref.formDesc || ref.formIdHex || "-"]));
    }

    els.infoGrid.textContent = "";
    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "access-info-row";
      const key = document.createElement("span");
      key.textContent = label;
      const val = document.createElement("span");
      val.textContent = value;
      row.append(key, val);
      els.infoGrid.appendChild(row);
    });
  }

  function renderManage(data) {
    state.sessionId = data.sessionId || null;
    state.object = data.object || null;
    state.owner = data.owner || null;
    state.users = Array.isArray(data.users) ? data.users : [];
    state.role = data.role || "visitor";
    state.canManage = data.canManage === true;
    state.canManageOwner = data.canManageOwner === true;
    state.canAddUser = data.canAddUser === true;
    state.canRemoveUsers = data.canRemoveUsers === true;
    state.canToggleLock = data.canToggleLock === true;

    hideHint();
    hidePanels();
    setVisible(true);

    const object = state.object || {};
    els.manageTitle.textContent = object.displayName || "Access Control";
    els.manageType.textContent = titleCase(object.type);
    els.roleBadge.textContent = titleCase(state.role);
    els.lockedToggle.disabled = !state.canToggleLock;
    els.lockedToggle.setAttribute("aria-pressed", object.locked ? "true" : "false");
    els.lockedToggle.classList.toggle("unlocked", object.locked !== true);
    els.lockedLabel.textContent = object.locked ? "Locked" : "Unlocked";
    els.assignOwner.disabled = !state.canManageOwner;
    els.assignOwner.hidden = !state.canManageOwner;
    els.assignOwner.textContent = state.owner ? "Replace" : "Assign";
    els.addUser.disabled = !state.canAddUser;
    els.addUser.hidden = !state.canAddUser;

    renderPeople();
    renderInfo();
    els.manage.classList.add("active");
    if (data.toastMessage) showToast(data.toastMessage);
  }

  function openSearch(mode) {
    if (!state.sessionId) return;
    state.searchMode = mode;
    const replacingOwner = mode === "owner" && !!state.owner;
    els.searchMode.textContent = mode === "owner" ? "Owner" : "User";
    els.searchTitle.textContent = mode === "owner" ? (replacingOwner ? "Replace Owner" : "Assign Owner") : "Add User";
    els.searchInput.value = "";
    els.searchResults.textContent = "";
    els.searchModal.hidden = false;
    window.setTimeout(() => els.searchInput.focus(), 0);
  }

  function renderSearchResults(data) {
    if (!els.searchModal.hidden && data.error) showToast(data.error);
    els.searchResults.textContent = "";
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "access-empty-row";
      empty.textContent = data.query ? "No matches" : "Type at least two characters";
      els.searchResults.appendChild(empty);
      return;
    }
    results.forEach((character) => {
      const button = makeButton(personLabel(character), "access-result-button", () => {
        els.searchModal.hidden = true;
        if (state.searchMode === "owner") {
          const replacingOwner = !!state.owner;
          confirmAction(replacingOwner ? "Replace Owner" : "Assign Owner", `${replacingOwner ? "Replace the current owner with" : "Assign"} ${personLabel(character)}?`, () => {
            send("vgr:access:assignOwner", actionPayload({ profileId: character.profileId }));
          });
        } else {
          send("vgr:access:addUser", actionPayload({ profileId: character.profileId }));
        }
      });
      els.searchResults.appendChild(button);
    });
  }

  function confirmAction(title, message, onConfirm) {
    state.pendingConfirm = onConfirm;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirm.hidden = false;
    if (els.confirmOk && typeof els.confirmOk.focus === "function") {
      window.setTimeout(() => els.confirmOk.focus(), 0);
    }
  }

  function consumeUiEvent(event) {
    if (!event) return;
    event.preventDefault();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    else event.stopPropagation();
  }

  function bindPress(element, handler) {
    if (!element) return;
    let lastPressAt = 0;
    const run = (event) => {
      consumeUiEvent(event);
      const now = Date.now();
      if (now - lastPressAt < 120) return;
      lastPressAt = now;
      handler();
    };
    element.addEventListener("pointerdown", run);
    element.addEventListener("mousedown", run);
    element.addEventListener("click", run);
  }

  window.vgrAccessUpdate = function (data) {
    if (!data || data.version !== 1) return;
    if (data.action === "toast") {
      showToast(data.message || "");
      if (data.toastOnly) return;
    }
    if (data.action === "hint") {
      renderHint(data);
      return;
    }
    if (data.action === "hintClear") {
      hideHint();
      return;
    }
    if (data.action === "close") {
      hidePanels();
      setVisible(false);
      return;
    }
    if (data.action === "context") renderContext(data);
    if (data.action === "manage") renderManage(data);
    if (data.action === "searchResults") renderSearchResults(data);
  };

  window.addEventListener("vgr:ui_manager:open:access_control", () => {
    hideHint();
    setVisible(true);
  });
  window.addEventListener("vgr:ui_manager:close:access_control", () => {
    hidePanels();
    setVisible(false);
  });

  els.contextClose?.addEventListener("click", closeUi);
  els.manageClose?.addEventListener("click", closeUi);
  els.searchClose?.addEventListener("click", () => { els.searchModal.hidden = true; });
  els.assignOwner?.addEventListener("click", () => openSearch("owner"));
  els.addUser?.addEventListener("click", () => openSearch("user"));
  els.lockedToggle?.addEventListener("click", () => {
    if (!state.canToggleLock || !state.object) return;
    const nextLocked = state.object.locked !== true;
    confirmAction(nextLocked ? "Lock Object" : "Unlock Object", nextLocked ? "Lock this object?" : "Unlock this object for normal use?", () => {
      send("vgr:access:setLocked", actionPayload({ locked: nextLocked }));
    });
  });

  els.searchInput?.addEventListener("input", () => {
    window.clearTimeout(state.debounce);
    const query = els.searchInput.value || "";
    state.debounce = window.setTimeout(() => {
      send("vgr:access:search", { query });
    }, 300);
  });

  function cancelConfirm() {
    state.pendingConfirm = null;
    els.confirm.hidden = true;
  }

  function acceptConfirm() {
    const fn = state.pendingConfirm;
    state.pendingConfirm = null;
    els.confirm.hidden = true;
    if (typeof fn === "function") fn();
  }

  bindPress(els.confirmCancel, cancelConfirm);
  bindPress(els.confirmOk, acceptConfirm);

  els.confirm?.addEventListener("pointerdown", (event) => {
    if (event.target === els.confirm) consumeUiEvent(event);
  });

  els.confirm?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      consumeUiEvent(event);
      cancelConfirm();
    } else if (event.key === "Enter") {
      consumeUiEvent(event);
      acceptConfirm();
    }
  });

  root.querySelectorAll(".access-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.accessTab;
      root.querySelectorAll(".access-tab").forEach((item) => item.classList.toggle("active", item === tab));
      root.querySelectorAll(".access-tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.accessPanel === name);
      });
    });
  });
})();
