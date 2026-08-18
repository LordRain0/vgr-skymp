
const vgr_voice_mode_root = document.getElementById("vgr-voice-mode");
const vgr_voice_mode_icon = document.getElementById("vgr-voice-mode-icon");
const vgr_voice_mode_label = document.getElementById("vgr-voice-mode-label");

const VGR_VOICE_MODE_LABELS = { whisper: "Whisper", talk: "Talk", yell: "Yell" };
const VGR_VOICE_MODE_ICONS = {
	whisper: "assets/voice/voip_whisper.png",
	talk: "assets/voice/voip_normal.png",
	yell: "assets/voice/voip_yell.png"
};
const VGR_VOICE_MODE_HIDE_MS = 1500;
const VGR_VOICE_PTT_FADE_MS = 350;

let vgr_voice_mode_hideTimer = null;
let vgr_voice_mode_held = false;

vgr_voice_mode_icon.addEventListener("error", () => {
	vgr_voice_mode_root.classList.remove("has-icon");
});

window.vgrVoiceModeUpdate = (data) => {
	if (!data || !data.mode) return;
	const mode = String(data.mode);

	vgr_voice_mode_root.classList.remove("mode-whisper", "mode-talk", "mode-yell");
	vgr_voice_mode_root.classList.add("mode-" + mode);
	vgr_voice_mode_label.textContent = VGR_VOICE_MODE_LABELS[mode] || mode;

	const iconSrc = VGR_VOICE_MODE_ICONS[mode];
	if (iconSrc) {
		vgr_voice_mode_icon.src = iconSrc;
		vgr_voice_mode_root.classList.add("has-icon");
	} else {
		vgr_voice_mode_icon.removeAttribute("src");
		vgr_voice_mode_root.classList.remove("has-icon");
	}

	vgr_voice_mode_root.classList.add("visible");
	if (vgr_voice_mode_hideTimer) clearTimeout(vgr_voice_mode_hideTimer);
	if (!vgr_voice_mode_held) {
		vgr_voice_mode_hideTimer = setTimeout(() => {
			vgr_voice_mode_root.classList.remove("visible");
			vgr_voice_mode_hideTimer = null;
		}, VGR_VOICE_MODE_HIDE_MS);
	}
};

// Push-to-talk: banner stays solid while transmitting, fades on release
window.vgrVoiceModeShow = (held) => {
	vgr_voice_mode_held = held === true;
	if (vgr_voice_mode_hideTimer) { clearTimeout(vgr_voice_mode_hideTimer); vgr_voice_mode_hideTimer = null; }
	if (vgr_voice_mode_held) {
		vgr_voice_mode_root.classList.add("visible");
	} else {
		vgr_voice_mode_hideTimer = setTimeout(() => {
			vgr_voice_mode_root.classList.remove("visible");
			vgr_voice_mode_hideTimer = null;
		}, VGR_VOICE_PTT_FADE_MS);
	}
};
