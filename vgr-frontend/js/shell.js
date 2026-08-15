(function () {
  "use strict";

  var state = {
    mode: "login",
    gameInitialized: false
  };

  function body() {
    return document.body;
  }

  function loginLayer() {
    return document.getElementById("vgr-login-layer");
  }

  function gameLayer() {
    return document.getElementById("vgr-game-layer");
  }

  function setMode(mode) {
    state.mode = mode || "login";
    if (body()) body().setAttribute("data-vgr-mode", state.mode);

    var login = loginLayer();
    var game = gameLayer();
    var gameplay = state.mode === "gameplay";

    if (login) {
      login.hidden = gameplay;
      login.setAttribute("aria-hidden", gameplay ? "true" : "false");
    }

    if (game) {
      game.hidden = !gameplay;
      game.setAttribute("aria-hidden", gameplay ? "false" : "true");
    }

    if (gameplay) initializeGameplayUi();
    window.dispatchEvent(new CustomEvent("vgr:shell:mode", { detail: { mode: state.mode } }));
  }

  function initializeGameplayUi() {
    if (state.gameInitialized) return;
    if (typeof window.vgrInitRegistryUI === "function") {
      window.vgrInitRegistryUI();
      state.gameInitialized = true;
    }
  }

  function showLogin() {
    setMode("login");
  }

  function resetForAuth() {
    showLogin();
  }

  function enterGameplay(reason) {
    completeLogin();
    return {
      mode: state.mode,
      gameInitialized: state.gameInitialized,
      reason: reason || null
    };
  }

  function isGameplayReady() {
    return state.mode === "gameplay" && state.gameInitialized;
  }

  function completeLogin() {
    stopLoginAudio(true);
    setMode("gameplay");
  }

  function stopLoginAudio(removeSource) {
    var tracks = [];
    var login = loginLayer();
    if (login) {
      tracks = tracks.concat(Array.prototype.slice.call(login.querySelectorAll("audio")));
    }
    tracks = tracks.concat(Array.prototype.slice.call(document.querySelectorAll(
      "#background-music, audio[src*='Soulforge'], audio"
    )));

    tracks = tracks.filter(function (audio, index) {
      return audio && tracks.indexOf(audio) === index;
    });

    tracks.forEach(function (audio) {
      try {
        audio.autoplay = false;
        audio.loop = false;
        audio.muted = true;
        audio.pause();
        audio.currentTime = 0;
        if (removeSource) {
          audio.removeAttribute("src");
          Array.prototype.forEach.call(audio.querySelectorAll("source"), function (source) {
            source.removeAttribute("src");
          });
          audio.load();
        }
      } catch (err) {
        console.warn("[VGRUI] failed to stop login audio", err);
      }
    });
  }

  window.VGRUI = {
    get mode() { return state.mode; },
    setMode: setMode,
    showLogin: showLogin,
    hideLogin: function () { setMode("gameplay"); },
    showGameplay: function () { setMode("gameplay"); },
    hideGameplay: function () { setMode("login"); },
    completeLogin: completeLogin,
    stopLoginAudio: stopLoginAudio,
    initializeGameplayUi: initializeGameplayUi
  };

  window.VGRFrontend = {
    get mode() { return state.mode; },
    showLogin: showLogin,
    resetForAuth: resetForAuth,
    enterGameplay: enterGameplay,
    isGameplayReady: isGameplayReady,
    initializeGameplayUi: initializeGameplayUi
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setMode("login");
    });
  } else {
    setMode("login");
  }
}());
