'use strict'

const config = require('./required-cc-files.json')

const files = Array.isArray(config) ? config : config.files || []
const pluginOrder = Array.isArray(config) ? [] : config.pluginOrder || []
const modlistOrder = Array.isArray(config) ? [] : config.modlistOrder || []

module.exports = {
  files,
  fileSet: new Set(files.map(name => String(name).toLowerCase())),
  pluginOrder,
  modlistOrder,
}
