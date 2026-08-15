(function () {
  const root = document.getElementById("vgr-locks");
  if (!root) return;

  const contextOverlay = document.getElementById("locksContextOverlay");
  const contextTitle = document.getElementById("locksContextTitle");
  const contextButtons = document.getElementById("locksContextButtons");
  const managePanel = document.getElementById("locksManagePanel");
  const manageTitle = document.getElementById("locksManageTitle");
  const ownersList = document.getElementById("locksOwnersList");
  const usersList = document.getElementById("locksUsersList");
  const ownersSection = document.getElementById("locksOwnersSection");
  const usersSection = document.getElementById("locksUsersSection");
  const addBtn = document.getElementById("locksAddBtn");
  const footerNote = document.getElementById("locksFooterNote");
  const submodalOverlay = document.getElementById("locksSubmodalOverlay");
  const submodalTitle = document.getElementById("locksSubmodalTitle");
  const submodalDesc = document.getElementById("locksSubmodalDesc");
  const submodalInput = document.getElementById("locksSubmodalInput");
  const submodalConfirm = document.getElementById("locksSubmodalConfirm");
  const submodalCancel = document.getElementById("locksSubmodalCancel");
  const keyInfoGrid = document.getElementById("locksKeyInfoGrid");

  let state = {
    role: "owner",
    submodalMode: null,
  };

  let lastPayload = null;

  function vgrLocksSend(type, payload) {
    const map = {
      contextChoice: "vgr:locks:contextChoice",
      close: "vgr:locks:close",
      addUser: "vgr:locks:addUser",
      removeUser: "vgr:locks:removeUser",
      assignOwner: "vgr:locks:assignOwner",
      removeOwner: "vgr:locks:removeOwner",
    };
    const msg = map[type];
    if (!msg) return;
    window.skyrimPlatform?.sendMessage?.(msg, payload || {});
  }

  function notifyLocks(message, variant) {
    window.vgr_send_notification?.(2, String(message || ""), { variant: variant || "access" });
  }

  function setRootOpen(isOpen) {
    if (!root) return;
    if (isOpen) {
      root.style.display = "flex";
      root.classList.add("visible");
      root.setAttribute("aria-hidden", "false");
    } else {
      root.style.display = "none";
      root.classList.remove("visible");
      root.setAttribute("aria-hidden", "true");
      hideAllPanels();
    }
  }

  function hideContextMenu() {
    contextOverlay?.classList.remove("active");
  }

  function hideManageModal() {
    managePanel?.classList.remove("active");
  }

  function hideAddUserModal() {
    submodalOverlay?.classList.remove("active");
    state.submodalMode = null;
    if (submodalInput) submodalInput.value = "";
  }

  function hideAllPanels() {
    hideContextMenu();
    hideManageModal();
    hideAddUserModal();
    root?.classList.remove("locks-backdrop");
  }

  function setActiveTab(tabName) {
    root.querySelectorAll(".locks-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
    });
    root.querySelectorAll(".locks-tab-content").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tabPanel === tabName);
    });
  }

  const CONTEXT_LABELS = {
    open: "Open",
    manage: "Manage",
    register: "Register Object",
    assignOwner: "Assign Owner",
    removeOwner: "Remove Owner",
  };

  function showContextButtons(data) {
    hideManageModal();
    hideAddUserModal();
    setRootOpen(true);
    if (!contextOverlay || !contextButtons) return;

    const typeLabel = data.objectType === "door" ? "Door" : "Container";
    if (contextTitle) {
      contextTitle.textContent = typeLabel + ": " + (data.displayName || "Object");
    }

    contextButtons.innerHTML = "";
    const options = Array.isArray(data.options) ? data.options : [];

    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "locks-btn " + (opt === "removeOwner" ? "locks-btn-danger" : "locks-btn-primary");
      btn.textContent = CONTEXT_LABELS[opt] || opt;
      btn.addEventListener("click", () => {
        vgrLocksSend("contextChoice", { choice: opt });
      });
      contextButtons.appendChild(btn);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "locks-btn locks-btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => vgrLocksSend("close"));
    contextButtons.appendChild(cancelBtn);

    contextOverlay.classList.add("active");
    root?.classList.add("locks-backdrop");
  }

  function renderUserRow(name, badge, badgeClass, formDesc, showRemove) {
    const li = document.createElement("li");
    li.className = "locks-user-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "locks-user-name";
    nameSpan.textContent = name;

    const badgeSpan = document.createElement("span");
    badgeSpan.className = "locks-badge " + badgeClass;
    badgeSpan.textContent = badge;

    li.appendChild(nameSpan);
    li.appendChild(badgeSpan);

    if (showRemove && formDesc) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "locks-remove-btn";
      removeBtn.setAttribute("aria-label", "Remove");
      removeBtn.textContent = "\u{1F5D1}";
      removeBtn.addEventListener("click", () => {
        if (state.role === "keyHandler") {
          vgrLocksSend("removeOwner");
        } else {
          vgrLocksSend("removeUser", { formDesc });
        }
      });
      li.appendChild(removeBtn);
    }

    return li;
  }

  function renderManagePanel(data) {
    hideContextMenu();
    hideAddUserModal();
    setRootOpen(true);
    if (!managePanel) return;

    state.role = data.role || "owner";
    const typeLabel = data.objectType === "door" ? "Door" : "Container";
    if (manageTitle) {
      manageTitle.textContent = typeLabel + ": " + (data.displayName || "Object");
    }

    if (ownersList) {
      ownersList.innerHTML = "";
      if (data.owner) {
        const showOwnerRemove = state.role === "keyHandler";
        ownersList.appendChild(
          renderUserRow(data.owner.name, "Owner", "locks-badge-owner", data.owner.formDesc, showOwnerRemove)
        );
      } else if (state.role === "keyHandler") {
        const empty = document.createElement("li");
        empty.className = "locks-user-row";
        empty.innerHTML = '<span class="locks-user-name locks-muted">No owner assigned</span>';
        ownersList.appendChild(empty);
      }
    }

    if (usersList) {
      usersList.innerHTML = "";
      const users = Array.isArray(data.users) ? data.users : [];
      users.forEach((user) => {
        usersList.appendChild(
          renderUserRow(user.name, "User", "locks-badge-user", user.formDesc, data.canManageUsers)
        );
      });
    }

    if (ownersSection) {
      ownersSection.style.display = "block";
    }

    if (usersSection) {
      usersSection.style.display = state.role === "keyHandler" ? "none" : "block";
    }

    if (addBtn) {
      if (state.role === "keyHandler") {
        addBtn.textContent = "+ Add Owner";
        addBtn.style.display = "block";
        addBtn.onclick = () => openSubmodal("assignOwner");
      } else if (data.canManageUsers) {
        addBtn.textContent = "+ Add User";
        addBtn.style.display = "block";
        addBtn.onclick = () => openSubmodal("addUser");
      } else {
        addBtn.style.display = "none";
      }
    }

    if (footerNote) {
      footerNote.style.display = state.role === "keyHandler" ? "none" : "flex";
    }

    if (keyInfoGrid && data.keyInfo) {
      keyInfoGrid.innerHTML = "";
      const fields = [
        ["Form Desc", data.keyInfo.formDesc],
        ["Form ID", data.keyInfo.formIdHex],
        ["Cell / World", data.keyInfo.worldOrCellDesc],
        ["Position", Array.isArray(data.keyInfo.position) ? data.keyInfo.position.map((n) => Number(n).toFixed(1)).join(", ") : "-"],
      ];
      if (data.keyInfo.passageId) {
        fields.push(["Passage ID", data.keyInfo.passageId]);
      }
      if (Array.isArray(data.keyInfo.doorRefs) && data.keyInfo.doorRefs.length) {
        fields.push([
          "Door Pair",
          data.keyInfo.doorRefs.map((ref) => ref.formDesc).join("  <->  "),
        ]);
      }
      fields.forEach(([label, value]) => {
        const row = document.createElement("div");
        row.className = "locks-key-info-row";
        row.innerHTML =
          '<span class="locks-key-info-label">' + label + '</span>' +
          '<span class="locks-key-info-value">' + (value || "-") + "</span>";
        keyInfoGrid.appendChild(row);
      });
    }

    setActiveTab("people");
    managePanel.classList.add("active");
    root?.classList.add("locks-backdrop");
  }

  function openSubmodal(mode) {
    state.submodalMode = mode;
    if (!submodalOverlay) return;

    if (mode === "assignOwner") {
      if (submodalTitle) submodalTitle.textContent = "Add Owner";
      if (submodalDesc) {
        submodalDesc.textContent =
          "Enter the full player name of the person you want to assign as owner of this object.";
      }
      if (submodalConfirm) submodalConfirm.textContent = "Assign Owner";
    } else {
      if (submodalTitle) submodalTitle.textContent = "Add User";
      if (submodalDesc) {
        submodalDesc.textContent =
          "Enter the full player name of the person you want to add as a user to this container.";
      }
      if (submodalConfirm) submodalConfirm.textContent = "Add User";
    }

    if (submodalInput) {
      submodalInput.value = "";
      submodalInput.placeholder = "e.g. John Doe";
    }

    submodalOverlay.classList.add("active");
    submodalInput?.focus();
  }

  function applyLocksPayload(data) {
    if (!data) return;

    if (data.action === "notification") {
      notifyLocks(data.message, data.variant || data.level);
      return;
    }

    if (data.action === "close") {
      hideAllPanels();
      return;
    }

    if (data.action === "contextMenu") {
      showContextButtons(data);
      return;
    }

    if (data.action === "manage") {
      renderManagePanel(data);
      if (data.notificationMessage) {
        notifyLocks(data.notificationMessage, data.variant || data.level);
      }
    }
  }

  window.vgrLocksApply = function (data) {
    if (!data) return;
    lastPayload = data;
    if (data.focus === "grab") {
      setRootOpen(true);
    }
    applyLocksPayload(data);
  };

  window.vgrLocksUpdate = window.vgrLocksApply;

  root.querySelectorAll(".locks-tab").forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });

  document.getElementById("locksManageClose")?.addEventListener("click", () => {
    vgrLocksSend("close");
  });

  document.getElementById("locksContextClose")?.addEventListener("click", () => {
    vgrLocksSend("close");
  });

  submodalCancel?.addEventListener("click", hideAddUserModal);

  submodalConfirm?.addEventListener("click", () => {
    const name = submodalInput?.value?.trim();
    if (!name) return;
    if (state.submodalMode === "assignOwner") {
      vgrLocksSend("assignOwner", { name });
    } else {
      vgrLocksSend("addUser", { name });
    }
    hideAddUserModal();
  });

  submodalInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submodalConfirm?.click();
  });

  window.addEventListener("vgr:ui_manager:open:locks", (event) => {
    const payload = event.detail || lastPayload;
    if (payload && payload.action === "notification") {
      applyLocksPayload(payload);
      return;
    }
    setRootOpen(true);
    if (payload && (payload.action === "contextMenu" || payload.action === "manage")) {
      applyLocksPayload(payload);
      return;
    }
    notifyLocks("Lock UI opened without lock context.", "warning");
  });

  window.addEventListener("vgr:ui_manager:close:locks", () => {
    setRootOpen(false);
    lastPayload = null;
  });

  setRootOpen(false);
})();



