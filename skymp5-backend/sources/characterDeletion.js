'use strict'

const config = require('../config')
const backendDb = require('./backendDb')
const characters = require('./characters')

const WORKER_INTERVAL_MS = 10 * 1000

let timer = null
let running = false

function changeFormProfileQueries(profileId) {
  const id = Number(profileId)
  const text = String(id)
  return [
    { profileId: id },
    { profileID: id },
    { profileId: text },
    { profileID: text },
  ]
}

async function deleteChangeFormsForProfileId(profileId) {
  const database = await backendDb.namedDb(config.gameDatabaseName)
  return database.collection('changeForms').deleteMany({
    $or: changeFormProfileQueries(profileId),
  })
}

async function finalizeCharacterDeletion(character) {
  const profileId = Number(character?.profileId)
  if (!characters.isValidProfileId(profileId)) return

  const claimed = await characters.markDeletionStarted(profileId)
  if (!claimed) return

  const changeForms = await deleteChangeFormsForProfileId(profileId)
  await characters.finalizeDeletion(profileId)
  console.log(
    `[characterDeletion] finalized profileId ${profileId}; deleted ${changeForms.deletedCount || 0} changeForms from ${config.gameDatabaseName}`,
  )
}

async function runOnce() {
  if (running) return
  running = true

  try {
    const due = await characters.listDueForDeletion()
    for (const character of due) {
      await finalizeCharacterDeletion(character)
    }
  } catch (err) {
    console.error('[characterDeletion] cleanup failed:', err.message || err)
  } finally {
    running = false
  }
}

function start() {
  if (timer) return

  timer = setInterval(runOnce, WORKER_INTERVAL_MS)
  if (timer.unref) timer.unref()
  runOnce().catch(err => {
    console.error('[characterDeletion] initial cleanup failed:', err.message || err)
  })
}

module.exports = {
  deleteChangeFormsForProfileId,
  runOnce,
  start,
}
