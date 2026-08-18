
const vgr_death_root = document.getElementById("vgr-death-screen");
const vgr_death_countdownEl = document.getElementById("vgrDeathCountdown");
const vgr_death_hintEl = document.getElementById("vgrDeathHint");
const vgr_death_buttons = Array.from(document.querySelectorAll("#vgr-death-screen .death-choice"));

const VGR_DEATH_CONFIRM_MS = 4000;

const vgrDeathState = { seconds: 0, timer: null, chosen: false };

function vgrDeathResetButtons() {
	for (const btn of vgr_death_buttons) {
		btn.disabled = false;
		btn.classList.remove("armed");
		btn.textContent = btn.dataset.label;
		if (btn._disarmTimer) { clearTimeout(btn._disarmTimer); btn._disarmTimer = null; }
	}
}

function vgrDeathStopTimer() {
	if (vgrDeathState.timer) { clearInterval(vgrDeathState.timer); vgrDeathState.timer = null; }
}

function vgrDeathPaint() {
	if (vgrDeathState.seconds > 0) {
		vgr_death_countdownEl.textContent = String(vgrDeathState.seconds);
		vgr_death_hintEl.textContent = "You are bleeding out. You will wake at the nearest temple.";
	} else {
		vgr_death_countdownEl.textContent = "";
		vgr_death_hintEl.textContent = "You feel yourself being carried to safety...";
	}
}

window.vgrDeathScreenUpdate = (data) => {
	if (!data) return;
	vgrDeathStopTimer();
	if (data.show === true) {
		vgrDeathState.seconds = Math.max(0, Number(data.seconds) || 0);
		vgrDeathState.chosen = false;
		vgrDeathResetButtons();
		vgrDeathPaint();
		vgrDeathState.timer = setInterval(() => {
			vgrDeathState.seconds = Math.max(0, vgrDeathState.seconds - 1);
			vgrDeathPaint();
			if (vgrDeathState.seconds <= 0) vgrDeathStopTimer();
		}, 1000);
	} else {
		vgrDeathState.chosen = false;
		vgrDeathResetButtons();
	}
};

for (const btn of vgr_death_buttons) {
	btn.dataset.label = btn.textContent;
	btn.addEventListener("click", () => {
		if (vgrDeathState.chosen) return;
		if (!btn.classList.contains("armed")) {
			// First click arms the button; a second click within the window confirms.
			vgrDeathResetButtons();
			btn.classList.add("armed");
			btn.textContent = btn.dataset.confirm;
			btn._disarmTimer = setTimeout(() => {
				btn.classList.remove("armed");
				btn.textContent = btn.dataset.label;
			}, VGR_DEATH_CONFIRM_MS);
			return;
		}
		vgrDeathState.chosen = true;
		for (const b of vgr_death_buttons) b.disabled = true;
		window.skyrimPlatform?.sendMessage?.("vgr:respawn:choice", btn.dataset.choice);
	});
}

window.addEventListener("vgr:ui_manager:open:death_screen", () => {
	vgr_death_root.style.display = "flex";
});

window.addEventListener("vgr:ui_manager:close:death_screen", () => {
	vgr_death_root.style.display = "none";
	vgrDeathStopTimer();
	vgrDeathResetButtons();
});
