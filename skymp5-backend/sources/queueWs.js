'use strict'

const { WebSocketServer, WebSocket } = require('ws')
const bans = require('./bans')
const hwids = require('./hwids')
const loginQueue = require('./loginQueue')
const playSessions = require('./playSessions')
const { getCapacity } = require('../routes/servers')

const QUEUE_WS_PATH = '/api/users/me/queue/ws'
const AUTH_TIMEOUT_MS = 5000
const PING_INTERVAL_MS = 5000
const UPDATE_INTERVAL_MS = 2000

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    let pathname
    try {
      pathname = new URL(req.url, 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }

    if (pathname !== QUEUE_WS_PATH) {
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', ws => {
    let authenticated = false
    let token = null
    let updateTimer = null
    ws.isAlive = true

    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(4000, 'auth required')
    }, AUTH_TIMEOUT_MS)

    ws.on('pong', () => {
      ws.isAlive = true
    })

    ws.on('message', async raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (authenticated) return
      if (msg.type !== 'auth' || typeof msg.token !== 'string') {
        ws.close(4000, 'auth required')
        return
      }

      try {
        const session = await playSessions.lookup(msg.token)
        const hwidHash = typeof msg.hwidHash === 'string'
          ? msg.hwidHash
          : (typeof msg.hwid === 'string' ? msg.hwid : null)

        if (session && hwidHash) {
          await hwids.record({
            hwidHash,
            discordId: session.discordId,
          })
        }

        const ban = session
          ? await bans.findActiveForSession({ discordId: session.discordId, hwidHash })
          : null
        if (ban) {
          await loginQueue.leave(session.token)
          send(ws, { type: 'banned', ban })
          ws.close(4003, 'banned')
          return
        }

        const queue = session ? await loginQueue.statusForToken(session.token, { capacity: getCapacity() }) : null
        if (!session || !queue) {
          ws.close(4004, 'queue entry not found')
          return
        }

        authenticated = true
        token = session.token
        clearTimeout(authTimer)
        send(ws, { type: 'queue', queue })

        updateTimer = setInterval(() => {
          loginQueue.statusForToken(token, { capacity: getCapacity() })
            .then(current => {
              if (!current) {
                ws.close(4004, 'queue entry not found')
                return
              }
              send(ws, { type: 'queue', queue: current })
            })
            .catch(err => {
              console.error('[queue-ws] status update failed:', err.message)
              ws.close(1011, 'queue status failed')
            })
        }, UPDATE_INTERVAL_MS)
      } catch (err) {
        console.error('[queue-ws] auth failed:', err.message)
        ws.close(1011, 'queue auth failed')
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (updateTimer) clearInterval(updateTimer)
      if (authenticated && token) {
        loginQueue.leaveIfNotAdmitting(token).catch(err => {
          console.error('[queue-ws] leave failed:', err.message)
        })
      }
    })

    ws.on('error', err => {
      console.error('[queue-ws] socket error:', err.message)
    })
  })

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }

      ws.isAlive = false
      try { ws.ping() } catch {}
    }
  }, PING_INTERVAL_MS)

  wss.on('close', () => clearInterval(pingTimer))
  console.log(`[queue-ws] attached at ${QUEUE_WS_PATH}`)
  return wss
}

module.exports = {
  attach,
  QUEUE_WS_PATH,
}
