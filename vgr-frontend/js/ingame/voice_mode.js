
const vgr_voice_mode_root = document.getElementById("vgr-voice-mode");
const vgr_voice_mode_icon = document.getElementById("vgr-voice-mode-icon");
const vgr_voice_mode_label = document.getElementById("vgr-voice-mode-label");

const VGR_VOICE_MODE_LABELS = { whisper: "Whisper", talk: "Talk", yell: "Yell" };
// Image icons can replace the text badges later, e.g. { whisper: "img/voice_whisper.png", ... }
const VGR_VOICE_MODE_ICONS = { whisper: "", talk: "", yell: "" };
const VGR_VOICE_MODE_HIDE_MS = 1500;

let vgr_voice_mode_hideTimer = null;

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
	vgr_voice_mode_hideTimer = setTimeout(() => {
		vgr_voice_mode_root.classList.remove("visible");
		vgr_voice_mode_hideTimer = null;
	}, VGR_VOICE_MODE_HIDE_MS);
};
