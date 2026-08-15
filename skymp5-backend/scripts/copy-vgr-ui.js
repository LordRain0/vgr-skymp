'use strict'

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..', '..')
const VGR_UI_SOURCE = path.join(REPO_ROOT, 'vgr-frontend')
const SKIP_NAMES = new Set(['.git', '.gitignore', '.gitattributes'])

function copyTree(srcDir, destDir) {
  let count = 0
  fs.mkdirSync(destDir, { recursive: true })

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue

    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      count += copyTree(src, dest)
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      count++
    }
  }

  return count
}

function copyVgrUi(targetDirs) {
  if (!fs.existsSync(VGR_UI_SOURCE)) {
    throw new Error(`VGR UI source not found: ${VGR_UI_SOURCE}`)
  }

  const uniqueTargets = [...new Set(targetDirs.map(target => path.resolve(target)))]
  let copied = 0

  for (const target of uniqueTargets) {
    fs.rmSync(target, { recursive: true, force: true })
    const files = copyTree(VGR_UI_SOURCE, target)
    copied += files
    console.log(`[ui] Copied ${files} VGR UI file(s) to ${target}`)
  }

  return copied
}

module.exports = { copyVgrUi, VGR_UI_SOURCE }
