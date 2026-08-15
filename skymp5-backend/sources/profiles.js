'use strict'

// Compatibility facade for old one-profile-per-Discord call sites. The real
// runtime model is now characters: each character owns one physical profileId.

const characters = require('./characters')

async function getOrCreateProfileId(discordId) {
  return (await characters.getOrCreateDefault(discordId)).profileId
}

async function getDiscordIdByProfileId(profileId) {
  const character = await characters.getByProfileId(profileId)
  return character ? character.discordId : null
}

async function list() {
  return (await characters.listActive()).map(character => ({
    discordId: character.discordId,
    profileId: character.profileId,
  }))
}

async function load() {
  const map = {}
  for (const character of await characters.listActive()) {
    if (!map[character.discordId]) map[character.discordId] = character.profileId
  }
  return { nextId: null, map }
}

module.exports = {
  load,
  list,
  getOrCreateProfileId,
  getDiscordIdByProfileId,
}
