
const vgr_woodcutting_root = document.getElementById("vgr-woodcutting");
const vgr_woodcutting_countEl = document.getElementById("vgr-woodcutting-count");
const vgr_woodcutting_button = document.getElementById("vgr-woodcutting-button");
const VGR_WOOD_TARGET = 5;				// firewood per session
const VGR_SECONDS_PER_WOOD = 2;          // 5 * 3 = 15s to fill
window.VGR_WOOD_TARGET = VGR_WOOD_TARGET;
window.VGR_SECONDS_PER_WOOD = VGR_SECONDS_PER_WOOD;

window.vgrWoodcuttingSet = (count, ready) => {
	const clamped = Math.max(0, Math.min(window.VGR_WOOD_TARGET, count | 0));

	vgr_woodcutting_root.classList.toggle("ready", !!ready);
	vgr_woodcutting_root.style.setProperty("--progress", `${(clamped / window.VGR_WOOD_TARGET) * 100}%`);

	vgr_woodcutting_countEl.textContent = `${clamped}/${window.VGR_WOOD_TARGET} collected`;
	vgr_woodcutting_button.textContent = ready ? "Click to collect" : "Working...";
};

vgr_woodcutting_button.addEventListener("click", () => {
	if (!vgr_woodcutting_root.classList.contains("ready")) return;
	window.skyrimPlatform?.sendMessage?.("vgr:woodcutting:collect");
});

window.vgrWoodcuttingSet(0, false);


function startWoodcutting() {
	const s = { count: 0, timer: null };
	s.timer = setInterval(() => {
		try {
			s.count++;
			if (s.count >= window.VGR_WOOD_TARGET) {
			  s.count = window.VGR_WOOD_TARGET;
			  clearInterval(s.timer);
			  s.timer = null;                  // self-bounding: timer ends here
			  window.vgrWoodcuttingSet(window.VGR_WOOD_TARGET, true);
			} else {
			  window.vgrWoodcuttingSet(s.count, false);
			}
		} catch (e) {
			console.error("[VGR woodcutting] timer error, stopping:", e);
		}
	}, window.VGR_SECONDS_PER_WOOD * 1000);
	
}

window.startWoodcutting = startWoodcutting;



window.addEventListener('vgr:ui_manager:open:woodcutting', (event) => {
	vgr_woodcutting_root.style.display = "flex";
});

window.addEventListener('vgr:ui_manager:close:woodcutting', (event) => {
	vgr_woodcutting_root.style.display = "none";
});
