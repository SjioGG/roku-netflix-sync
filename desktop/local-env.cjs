'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Values are literal, so tokens containing $ or backticks are never executed.
function loadLocalEnv(file) {
  const override = process.env.ROKU_SYNC_ENV_FILE
  if (file === undefined && override === '') return
  const target = file === undefined ? override || path.join(__dirname, '..', '.env') : file
  if (!fs.existsSync(target)) return
  for (let line of fs.readFileSync(target, 'utf8').split(/\r?\n/)) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7)
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error('Invalid .env entry; expected KEY=value')
    const key = match[1]
    let value = match[2].trim()
    if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

module.exports = { loadLocalEnv }
