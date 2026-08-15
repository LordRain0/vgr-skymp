
const vgr_mining_root = document.getElementById("vgr-mining");
const vgr_mining_countEl = document.getElementById("vgr-mining-count");
const vgr_mining_button = document.getElementById("vgr-mining-button");
const VGR_MINING_TARGET = 5;				// ore per session
const VGR_SECONDS_PER_MINING = 2;          // 5 * 3 = 15s to fill
window.VGR_MINING_TARGET = VGR_MINING_TARGET;
window.VGR_SECONDS_PER_MINING = VGR_SECONDS_PER_MINING;


window.vgrMiningSet = (count, ready) => {
  const clamped = Math.max(0, Math.min(window.VGR_MINING_TARGET, count | 0));
	
  vgr_mining_root.classList.toggle("ready", !!ready);
  vgr_mining_root.style.setProperty("--progress", `${(clamped / window.VGR_MINING_TARGET) * 100}%`);
	
  vgr_mining_countEl.textContent = `${clamped}/${window.VGR_MINING_TARGET} collected`;
  vgr_mining_button.textContent = ready ? "Click to collect" : "Mining...";
};

vgr_mining_button.addEventListener("click", () => {
  if (!vgr_mining_root.classList.contains("ready")) return;
  window.skyrimPlatform?.sendMessage?.("vgr:mining:collect");
});

// Optional: Toggle between pickaxe and ore vein icon
// vgr_mining_root.classList.add("ore-icon"); // Uncomment to use ore vein instead of pickaxe

window.vgrMiningSet(0, false);



function startMining() {
	const s = { count: 0, timer: null };
	s.timer = setInterval(() => {
		try {
			s.count++;
			if (s.count >= window.VGR_MINING_TARGET) {
			  s.count = window.VGR_MINING_TARGET;
			  clearInterval(s.timer);
			  s.timer = null;                  // self-bounding: timer ends here
			  window.vgrMiningSet(window.VGR_MINING_TARGET, true);
			} else {
			  window.vgrMiningSet(s.count, false);
			}
		} catch (e) {
			console.error("[VGR mining] timer error, stopping:", e);
		}
	}, window.VGR_SECONDS_PER_MINING * 1000);
	
}

window.startMining = startMining;


window.addEventListener('vgr:ui_manager:open:mining', (event) => {
	vgr_mining_root.style.display = "flex";
});

window.addEventListener('vgr:ui_manager:close:mining', (event) => {
	vgr_mining_root.style.display = "none";
});
