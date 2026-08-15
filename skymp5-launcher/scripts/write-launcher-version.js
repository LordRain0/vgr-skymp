const fs = require('fs')
const path = require('path')

module.exports = async function writeLauncherVersion(buildResult) {
  const pkg = require('../package.json')
  const outDir = buildResult?.outDir || path.resolve(__dirname, '..', '..', 'build', 'launcher')
  const versionFile = path.join(outDir, 'launcher-version.txt')

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(versionFile, `${pkg.version}\n`)
  console.log(`[version] wrote ${versionFile}`)
}
