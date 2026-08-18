module.exports = (mp) => {
  const LOG = "[VGR weather]";
  let settings = {};
  try {
    settings = mp.getServerSettings ? mp.getServerSettings() : {};
  } catch (e) {
    console.error(LOG, "failed to read server settings for admin access:", e);
  }

  const adminConfig = settings.vgrWeatherAccess || {};
  const ADMIN_DB_NAME = adminConfig.backendDatabaseName || "skymp-backend";
  const ADMIN_COLLECTION = adminConfig.playersCollection || "players";
  const ADMIN_REFRESH_MS = Math.max(5000, Number(adminConfig.adminRefreshMs) || 15000);
  const ADMIN_LOG_INTERVAL_MS = Math.max(300000, Number(adminConfig.adminLogIntervalMs) || 300000);
  let MongoClient = null;
  try {
    MongoClient = require("mongodb").MongoClient;
  } catch (e) {
    console.error(LOG, "MongoDB driver missing; weather admin access will fail closed.");
  }

  function deriveMongoUri(dbName) {
    if (!settings.databaseUri) return "";
    try {
      const uri = new URL(settings.databaseUri);
      uri.pathname = "/" + dbName;
      return uri.toString();
    } catch (e) {
      console.error(LOG, "invalid databaseUri for admin access:", e);
      return "";
    }
  }

  const ADMIN_DB_URI = adminConfig.databaseUri || deriveMongoUri(ADMIN_DB_NAME);
  let adminClientPromise = null;
  let adminCacheReady = false;
  let adminDiscordIds = new Set();
  let lastAdminCacheLogAt = 0;

  async function refreshWeatherAdmins() {
    try {
      if (!MongoClient || !ADMIN_DB_URI) throw new Error("No MongoDB connection is configured");
      if (!adminClientPromise) adminClientPromise = MongoClient.connect(ADMIN_DB_URI, { maxPoolSize: 2 });
      const db = (await adminClientPromise).db(ADMIN_DB_NAME);
      const players = await db.collection(ADMIN_COLLECTION)
        .find({ admin: true }, { projection: { discordId: 1 } })
        .toArray();
      adminDiscordIds = new Set(players.map((player) => String(player.discordId || "")).filter(Boolean));
      adminCacheReady = true;
      const now = Date.now();
      if (now - lastAdminCacheLogAt >= ADMIN_LOG_INTERVAL_MS) {
        lastAdminCacheLogAt = now;
        console.log(LOG, "weather admin cache refreshed:", adminDiscordIds.size, "admin(s)");
      }
    } catch (e) {
      adminDiscordIds = new Set();
      adminCacheReady = false;
      adminClientPromise = null;
      console.error(LOG, "weather admin cache unavailable; weather controls are locked:", e && e.message ? e.message : e);
    }
  }

  // =====================================================
  // Automatic Weather Pool
  // Only these are chosen randomly by the scheduler
  // =====================================================
  const VGR_WEATHER_POOL = [
    { formId: 0x0000081A, label: "Clear"        },
    { formId: 0x00012F89, label: "Overcast"     },
    { formId: 0x000C821F, label: "Rain"         },
    { formId: 0x000C8220, label: "Thunderstorm" },
    { formId: 0x000C8221, label: "Storm Snow" },
    { formId: 0x0004D7FB, label: "Overcast Snow" },
    { formId: 0x0018FE7E, label: "Riften Overcast Fog" },
  ];

  // =====================================================
// Global Admin Weather
//
// For now, only weather known to be safe for normal
// exterior Skyrim use may be broadcast globally.
//
// Realm-specific weather is kept separately so we can
// support it later with worldspace-aware logic.
// =====================================================
	const VGR_ADMIN_WEATHER_CATALOG = [
	...VGR_WEATHER_POOL,
	];

    const VGR_SPECIAL_WEATHER_CATALOG = [
		{ formId: 0x00048C14, label: "Blackreach Weather" },
		{ formId: 0x0010D9EC, label: "Sovngarde Clear" },
		{ formId: 0x0010FEF8, label: "Sovngarde Dark" },
		{ formId: 0x000923FD, label: "Sovngarde Fog" },
		{ formId: 0x000D299E, label: "Overcast War" },
		{ formId: 0x04034CFB, label: "Apocrypha Weather" },
		{ formId: 0x02001407, label: "Soul Cairn" },
		{ formId: 0x02006AEC, label: "Soul Cairn Red" },
		{ formId: 0x0200959F, label: "Soul Cairn Aurora" },
		{ formId: 0x04018471, label: "Volcanic Ash" },
		{ formId: 0x0401D760, label: "Volcanic Tundra" },
		{ formId: 0x04032336, label: "Volcanic Ash Storm" },
	];


  const VGR_WEATHER_MIN_MS      = 60  * 60 * 1000;
  const VGR_WEATHER_MAX_MS      = 60 * 60 * 1000;
  const VGR_WEATHER_OVERRIDE_MS = 30 * 60 * 1000;

  function getRuntimeDiscordId(pcFormId) {
    const propertyNames = [
      "private.indexed.discordId",
      "private.discordId",
      "discordId",
    ];

    for (const propertyName of propertyNames) {
      try {
        const value = mp.get(pcFormId, propertyName);
        if (value != null && String(value).trim()) return String(value);
      } catch (e) {
        // Try the next known runtime identity field.
      }
    }

    return null;
  }

  const vgrIsAdmin = (pcFormId) => {
    if (!pcFormId || !adminCacheReady) return false;

    const discordId = getRuntimeDiscordId(pcFormId);
    if (!discordId) {
      console.warn(LOG, "weather access denied: no runtime Discord identity for actor", pcFormId);
      return false;
    }

    return adminDiscordIds.has(discordId);
  };


  // =====================================================
  // Runtime Weather State
  // =====================================================
  const vgrWeatherPlayers = new Set();

  let vgrWeatherCurrent       = VGR_WEATHER_POOL[0];
  let vgrWeatherTimer         = null;
  let vgrWeatherOverrideTimer = null;


  // =====================================================
  // Client: Apply global weather
  // =====================================================
  mp.makeProperty("vgrWeather", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,

    updateOwner: `
      if (!ctx.value || !ctx.value.formId) return;

      if (ctx.state.lastWeatherNonce === ctx.value.nonce) {
        return;
      }

      ctx.state.lastWeatherNonce = ctx.value.nonce;

      const form = ctx.sp.Game.getFormEx(ctx.value.formId);

      if (!form) {
        console.warn(
          "[VGR weather] client could not resolve weather FormID:",
          ctx.value.formId
        );
        return;
      }

      const weather = ctx.sp.Weather.from(form);

      if (!weather) {
        console.warn(
          "[VGR weather] resolved form is not a valid Weather:",
          ctx.value.formId
        );
        return;
      }

      // Gradual transition: instant swaps race FSMP's weather thread during sky rebuilds
      weather.setActive(true, false);
	`,

		updateNeighbor: "",
	});



  // =====================================================
  // Client: Tell server weather system is ready
  // =====================================================
  mp.makeEventSource("_vgrWeatherReady", `
    ctx.sp.once("update", () => {
      setTimeout(() => {
        ctx.sendEvent({ kind: "ready" });
	  }, 5000);
	 });
   `);


  mp._vgrWeatherReady = (actorFormId, payload) => {
    if (!payload || payload.kind !== "ready") return;
    if (!actorFormId) return;

    vgrWeatherPlayers.add(actorFormId);

    vgrWeatherPushTo(actorFormId);

    console.log(
      "[VGR weather] registered:",
      actorFormId,
      "| players:",
      vgrWeatherPlayers.size);
	};


  // =====================================================
  // Client: Browser weather commands
  // =====================================================
  mp.makeEventSource("_vgrWeatherCmd", `
    ctx.sp.on("browserMessage", (e) => {
      const msg = e.arguments && e.arguments[0];

      if (!msg || typeof msg !== "string") return;

      if (msg.startsWith("vgr:cmd:/weather")) {
        const arg = msg
          .replace("vgr:cmd:/weather", "")
          .trim()
          .toLowerCase();

        ctx.sendEvent({
          kind: "cmd",
          arg
        });

        return;
      }

      if (msg === "vgr:weather:resume") {
        ctx.sendEvent({
          kind: "resume"
        });

        return;
      }
    });
  `);


  // =====================================================
  // Server: Push current weather to one player
  // =====================================================
  const vgrWeatherPushTo = (actorFormId) => {
    try {
      mp.set(actorFormId, "vgrWeather", {
        nonce: Date.now() + ":" + Math.random(),
        formId: vgrWeatherCurrent.formId,
      });

    } catch (e) {
      console.warn(
        "[VGR weather] failed to push weather to",
        actorFormId,
        e
      );
    }
  };


  // =====================================================
  // Server: Broadcast current weather
  // =====================================================
  const vgrWeatherBroadcast = () => {
    for (const actorFormId of vgrWeatherPlayers) {
      vgrWeatherPushTo(actorFormId);
    }

    console.log(
      "[VGR weather] broadcast:",
      vgrWeatherCurrent.label,
      "->",
      vgrWeatherPlayers.size,
      "player(s)"
    );
  };
  // =====================================================
  // Return immediately to safe normal weather,
  // then restart the automatic scheduler.
  //
  // Important:
  // vgrWeatherSchedule() only schedules a FUTURE change.
  // It does not change the current weather immediately.
  // =====================================================
  const vgrWeatherResumeNormal = (reason = "resume") => {
	if (vgrWeatherTimer) {
		clearTimeout(vgrWeatherTimer);
		vgrWeatherTimer = null;
	}

	if (vgrWeatherOverrideTimer) {
		clearTimeout(vgrWeatherOverrideTimer);
		vgrWeatherOverrideTimer = null;
	}

  // Immediately restore a known-safe normal weather.
	vgrWeatherCurrent = VGR_WEATHER_POOL[0];

	vgrWeatherBroadcast();

	console.log(
		"[VGR weather] returned to normal weather:",
		vgrWeatherCurrent.label,
		"| reason:",
		reason
	);

  // Now schedule the NEXT normal weather.
  vgrWeatherSchedule();
};

  // =====================================================
  // Global Weather API
  //
  // Used by vgr_admin_menu.js
  // =====================================================
  mp.vgrSetGlobalWeather = (actorFormId, targetWeatherFormId) => {
    if (!vgrIsAdmin(actorFormId)) {
      console.warn(LOG, "unauthorized global weather request from", actorFormId);
      return false;
    }
    const weatherFormId =
      typeof targetWeatherFormId === "number"
        ? targetWeatherFormId
        : Number(targetWeatherFormId);


    if (!weatherFormId) {
      console.warn(
        "[VGR weather] invalid global weather FormID:",
        targetWeatherFormId
      );

      return false;
    }


    const match = VGR_ADMIN_WEATHER_CATALOG.find(
      w => w.formId === weatherFormId
    );


	if (!match) {

		const specialWeather = VGR_SPECIAL_WEATHER_CATALOG.find(
		 w => w.formId === weatherFormId
		);

		if (specialWeather) {
			console.warn(
			"[VGR weather] blocked realm-specific global weather:",
			specialWeather.label,
			"| FormID:",
			weatherFormId
		);

		return false;
	}

	console.warn(
		"[VGR weather] weather not found in admin catalog:",
		weatherFormId
	);

		return false;
	}


    // Stop normal scheduler while admin override is active
    if (vgrWeatherTimer) {
      clearTimeout(vgrWeatherTimer);
      vgrWeatherTimer = null;
    }


    // Replace any existing admin override timer
    if (vgrWeatherOverrideTimer) {
      clearTimeout(vgrWeatherOverrideTimer);
      vgrWeatherOverrideTimer = null;
    }


    // This becomes authoritative global weather
    vgrWeatherCurrent = match;


    // Push to everyone
    vgrWeatherBroadcast();


    console.log(
      "[VGR weather] global weather set:",
      match.label
    );


    // After override period, return control to scheduler
    vgrWeatherOverrideTimer = setTimeout(() => {
	 console.log(
		"[VGR weather] global override expired"
	);

	vgrWeatherOverrideTimer = null;

	vgrWeatherResumeNormal("global override expired");
   }, VGR_WEATHER_OVERRIDE_MS);

    return true;
  };


  // =====================================================
  // Server: Automatic Weather Scheduler
  // =====================================================
  const vgrWeatherSchedule = () => {
    if (vgrWeatherTimer) {
      clearTimeout(vgrWeatherTimer);
      vgrWeatherTimer = null;
    }


    // Only NORMAL weather goes through automatic scheduler
    const pool = VGR_WEATHER_POOL.filter(
      w => w.formId !== vgrWeatherCurrent.formId
    );


    const next =
      pool[Math.floor(Math.random() * pool.length)];


    const ms =
      Math.floor(
        Math.random() *
        (VGR_WEATHER_MAX_MS - VGR_WEATHER_MIN_MS + 1)
      ) +
      VGR_WEATHER_MIN_MS;


    console.log(
      "[VGR weather] next:",
      next.label,
      "in",
      Math.round(ms / 60000),
      "min"
    );


    vgrWeatherTimer = setTimeout(() => {
      vgrWeatherTimer = null;

      vgrWeatherCurrent = next;

      vgrWeatherBroadcast();

      vgrWeatherSchedule();

    }, ms);
  };


  // =====================================================
  // Server: Handle browser admin commands
  // =====================================================
  mp._vgrWeatherCmd = (actorFormId, payload) => {
    if (!payload) return;


    if (payload.kind === "cmd") {

      if (!vgrIsAdmin(actorFormId)) {
        console.log(
          "[VGR weather] unauthorized cmd from",
          actorFormId
        );

        return;
      }


      // ---------------------------------------------
      // Resume normal automatic weather
      // ---------------------------------------------
    if (payload.arg === "resume") {

	  console.log(
      "[VGR weather] cycle resumed by admin",
		actorFormId
		);

		vgrWeatherResumeNormal("admin command");

		return;
    }
	
	


      // ---------------------------------------------
      // Legacy text/browser weather commands
      // ---------------------------------------------
      const nameMap = {
        "clear":     "Clear",
        "overcast":  "Overcast",
        "rain":      "Rain",
        "storm":     "Thunderstorm",
      };


      const weatherLabel = nameMap[payload.arg];

      if (!weatherLabel) return;


      const match = VGR_WEATHER_POOL.find(
        w => w.label === weatherLabel
      );

      if (!match) return;


      if (vgrWeatherTimer) {
        clearTimeout(vgrWeatherTimer);
        vgrWeatherTimer = null;
      }


      if (vgrWeatherOverrideTimer) {
        clearTimeout(vgrWeatherOverrideTimer);
        vgrWeatherOverrideTimer = null;
      }


      vgrWeatherCurrent = match;

      vgrWeatherBroadcast();


      console.log(
        "[VGR weather] admin override:",
        match.label,
        "by",
        actorFormId
      );


      vgrWeatherOverrideTimer = setTimeout(() => {

        console.log(
          "[VGR weather] override expired, resuming cycle"
        );

        vgrWeatherOverrideTimer = null;

        vgrWeatherResumeNormal("legacy override expired");

      }, VGR_WEATHER_OVERRIDE_MS);


      return;
    }


    // =================================================
    // Resume command
    // =================================================
    if (payload.kind === "resume") {

		if (!vgrIsAdmin(actorFormId)) return;

		console.log(
			"[VGR weather] cycle resumed by admin",
		actorFormId
		);

		vgrWeatherResumeNormal("admin browser resume");

		return;
	}
	
  };


  // =====================================================
  // Boot
  // =====================================================
  refreshWeatherAdmins();
  setInterval(refreshWeatherAdmins, ADMIN_REFRESH_MS);
  vgrWeatherSchedule();

  console.log(
    "[VGR weather] started, initial weather:",
    vgrWeatherCurrent.label
  );
};
