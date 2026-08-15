'use strict'

const { MongoClient } = require('mongodb')
const config = require('../config')

let clientPromise = null
let indexPromise = null

function requireDatabaseUri() {
  if (!config.backendDatabaseUri) {
    throw new Error('MongoDB is not configured. Set BACKEND_DATABASE_URI, DATABASE_URI, or SERVER_SETTINGS_PATH pointing to a server-settings.json with databaseUri.')
  }
}

async function client() {
  requireDatabaseUri()

  if (!clientPromise) {
    clientPromise = MongoClient.connect(config.backendDatabaseUri, {
      ignoreUndefined: true,
    })
  }

  return clientPromise
}

async function db() {
  const mongo = await client()
  const database = mongo.db(config.backendDatabaseName)
  await ensureIndexes(database)
  return database
}

async function namedDb(name) {
  const mongo = await client()
  return mongo.db(name || config.backendDatabaseName)
}

async function collection(name) {
  return (await db()).collection(name)
}

async function ensureIndexes(database) {
  if (!indexPromise) {
    indexPromise = (async () => {
      const characters = database.collection('characters')
      await dropIndexIfExists(characters, 'discordId_1_slot_1')
      await characters.updateMany(
        { slot: { $exists: true } },
        { $unset: { slot: '' } },
      )
      await database.collection('hwids').updateMany(
        {
          $or: [
            { profileIds: { $exists: true } },
            { lastProfileId: { $exists: true } },
          ],
        },
        { $unset: { profileIds: '', lastProfileId: '' } },
      )

      await Promise.all([
        database.collection('players').createIndex({ discordId: 1 }, { unique: true }),
        characters.createIndex({ profileId: 1 }, { unique: true }),
        characters.createIndex({ discordId: 1, deletedAt: 1 }),
        characters.createIndex({ deleteAt: 1, deletedAt: 1 }),
        database.collection('characterLocks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        database.collection('playSessions').createIndex({ token: 1 }, { unique: true }),
        database.collection('playSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        database.collection('loginQueue').createIndex({ token: 1 }, { unique: true }),
        database.collection('loginQueue').createIndex({ priority: -1, joinedAt: 1, token: 1 }),
        database.collection('loginQueue').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        database.collection('oauthStates').createIndex({ state: 1 }, { unique: true }),
        database.collection('oauthStates').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        database.collection('dashboardSessions').createIndex({ token: 1 }, { unique: true }),
        database.collection('dashboardSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        database.collection('bans').createIndex({ discordId: 1, revokedAt: 1 }),
        database.collection('bans').createIndex({ hwidHash: 1, revokedAt: 1 }),
        database.collection('bans').createIndex({ expiresAt: 1 }),
        database.collection('hwids').createIndex({ hwidHash: 1 }, { unique: true }),
        database.collection('hwids').createIndex({ discordIds: 1 }),
      ])
    })()
  }

  await indexPromise
}

async function dropIndexIfExists(collection, indexName) {
  try {
    await collection.dropIndex(indexName)
  } catch (err) {
    if (err.codeName !== 'IndexNotFound' && err.code !== 27) throw err
  }
}

async function nextSequence(name) {
  const counters = await collection('counters')
  const result = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  )
  const doc = result && result.value ? result.value : result
  let value = Number(doc?.value)
  if (!Number.isInteger(value)) {
    value = Number((await counters.findOne({ _id: name }))?.value)
  }

  if (!Number.isInteger(value) || value < 0) {
    const err = new Error(`invalid sequence value for ${name}`)
    err.code = 'invalidSequence'
    err.sequence = name
    throw err
  }
  return value
}

async function getSequence(name) {
  return (await collection('counters')).findOne({ _id: name })
}

async function setSequenceAtLeast(name, value) {
  const nextValue = Number(value)
  if (!Number.isInteger(nextValue) || nextValue < -1) {
    const err = new Error(`invalid sequence seed for ${name}`)
    err.code = 'invalidSequenceSeed'
    err.sequence = name
    throw err
  }

  const counters = await collection('counters')
  await counters.updateOne(
    { _id: name },
    [
      {
        $set: {
          value: {
            $cond: [
              {
                $and: [
                  { $in: [{ $type: '$value' }, ['int', 'long', 'double', 'decimal']] },
                  { $eq: ['$value', '$value'] },
                  { $gte: ['$value', nextValue] },
                ],
              },
              '$value',
              nextValue,
            ],
          },
        },
      },
    ],
    { upsert: true },
  )
}

module.exports = {
  collection,
  db,
  namedDb,
  getSequence,
  nextSequence,
  setSequenceAtLeast,
}
