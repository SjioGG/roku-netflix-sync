'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { loadLocalEnv } = require('./local-env.cjs')

// Finder does not inherit the shell's PATH. Keep machine-specific paths and
// private settings outside the app, so rebuilding never embeds credentials.
function configureRuntime({ packaged = false, userData, env = process.env } = {}) {
  if (packaged) {
    const settingsFile = path.join(userData, 'settings.env')
    if (env.ROKU_SYNC_ENV_FILE === undefined) env.ROKU_SYNC_ENV_FILE = settingsFile
    const runtimeFile = path.join(userData, 'runtime.json')
    if (!env.ROKU_SYNC_PYTHON && fs.existsSync(runtimeFile)) {
      const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'))
      if (typeof runtime.pythonPath === 'string' && path.isAbsolute(runtime.pythonPath) && fs.existsSync(runtime.pythonPath)) {
        env.ROKU_SYNC_PYTHON = runtime.pythonPath
      }
    }
  }
  if (packaged) {
    const bins = ['/opt/homebrew/bin', '/usr/local/bin']
    if (env.ROKU_SYNC_PYTHON) bins.unshift(path.dirname(env.ROKU_SYNC_PYTHON))
    env.PATH = [...new Set([...bins, ...(env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(path.delimiter)])].join(path.delimiter)
  }
  if (env === process.env) loadLocalEnv()
  return { pythonPath: env.ROKU_SYNC_PYTHON || 'python3' }
}
module.exports = { configureRuntime }
