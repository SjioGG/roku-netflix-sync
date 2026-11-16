'use strict'
// Offline startup regressions. Never open audio devices or scan the LAN.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { DesktopController } = require('../desktop/controller.cjs')
const { configureRuntime } = require('../desktop/runtime.cjs')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-startup-'))
try {
  const controller = new DesktopController({
    configPath: path.join(dir, 'config.json'),
    spawn: () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      return child
    },
  })
  controller.startAnc()
  const child = controller._children.anc
  child.emit('exit', 1, null)
  child.stderr.write('Live capture needs sounddevice: pip install sounddevice\n')
  child.emit('close', 1, null)
  assert.match(controller.anc.error, /Live capture needs sounddevice/,
    'ANC must display the actual stderr failure rather than only exit code 1')
  const env = { PATH: '/usr/bin:/bin' }
  configureRuntime({ packaged: true, userData: dir, env })
  assert.ok(env.PATH.split(path.delimiter).includes('/usr/sbin'),
    'Finder must find arp for LAN discovery even with a minimal PATH')
  console.log('Offline ANC startup errors and Finder discovery tools pass')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
