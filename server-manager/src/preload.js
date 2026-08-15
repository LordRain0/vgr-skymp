'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mgr', {
  // Console / services
  servicesStatus:  ()             => ipcRenderer.invoke('services:status'),
  serviceAction:   (key, action)  => ipcRenderer.invoke('service:action', key, action),
  servicesAction:  (action)       => ipcRenderer.invoke('services:action', action),
  consoleCommand:  (text)         => ipcRenderer.invoke('console:command', text),
  onLog:           (cb)           => ipcRenderer.on('log:data', (_e, d) => cb(d)),
  onConsoleRelay:  (cb)           => ipcRenderer.on('console:relay', (_e, d) => cb(d)),
  onBuildLog:      (cb)           => ipcRenderer.on('build:log', (_e, t) => cb(t)),

  // News tab
  newsList:        ()      => ipcRenderer.invoke('news:list'),
  newsSave:        (items) => ipcRenderer.invoke('news:save', items),
  newsImages:      ()      => ipcRenderer.invoke('news:images'),
  newsImportImage: ()      => ipcRenderer.invoke('news:importImage'),

  // Build tab
  buildServer:        ()   => ipcRenderer.invoke('build:server'),
  buildLauncher:      ()   => ipcRenderer.invoke('build:launcher'),
  buildClient:        ()   => ipcRenderer.invoke('build:client'),
  gamemodeStatus:     ()   => ipcRenderer.invoke('gamemode:status'),
  gamemodeSync:       ()   => ipcRenderer.invoke('gamemode:sync'),
  launcherGetVersion: ()   => ipcRenderer.invoke('launcher:getVersion'),
  launcherSetVersion: (v)  => ipcRenderer.invoke('launcher:setVersion', v),
  filesGetVersion:    ()   => ipcRenderer.invoke('files:getVersion'),

  // Players tab
  playersList:    ()              => ipcRenderer.invoke('players:list'),
  playersDetail:  (id)            => ipcRenderer.invoke('players:detail', id),
  playersUpdate:  (profileId, p)  => ipcRenderer.invoke('players:update', profileId, p),
  playersOnline:  ()              => ipcRenderer.invoke('players:online'),
  charsItemNames: (ids)           => ipcRenderer.invoke('chars:itemNames', ids),
  charsSave:      (formDesc, p)   => ipcRenderer.invoke('chars:save', formDesc, p),
  charsDelete:    (formDesc)      => ipcRenderer.invoke('chars:delete', formDesc),

  // Settings tab
  settingsSchema: ()                   => ipcRenderer.invoke('settings:schema'),
  settingsRead:   (key)                => ipcRenderer.invoke('settings:read', key),
  settingsWrite:  (key, values, extra) => ipcRenderer.invoke('settings:write', key, values, extra),

  // Modlist tab
  modlistRead:           () => ipcRenderer.invoke('modlist:read'),
  modlistUpdateManifest: () => ipcRenderer.invoke('modlist:updateManifest'),
})
