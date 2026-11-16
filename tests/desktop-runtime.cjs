'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { configureRuntime } = require('../desktop/runtime.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-runtime-'))
try {
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ pythonPath: process.execPath }))
  const env = { PATH: '/usr/bin:/bin' }
  configureRuntime({ packaged: true, userData: dir, env })
  assert.equal(env.ROKU_SYNC_PYTHON, process.execPath, 'Finder uses the installed absolute interpreter path')
  assert.equal(env.ROKU_SYNC_ENV_FILE, path.join(dir, 'settings.env'))
  assert.ok(env.PATH.split(path.delimiter).includes('/opt/homebrew/bin'), 'audio tools remain discoverable without a shell')
  assert.ok(env.PATH.split(path.delimiter).includes('/usr/bin'))
  const overridden = { ROKU_SYNC_ENV_FILE: '', ROKU_SYNC_PYTHON: '/explicit/python' }
  configureRuntime({ packaged: true, userData: dir, env: overridden })
  assert.equal(overridden.ROKU_SYNC_ENV_FILE, '', 'explicit settings isolation is preserved')
  assert.equal(overridden.ROKU_SYNC_PYTHON, '/explicit/python')
  const resources = path.join(dir, 'Resources')
  const bundled = path.join(resources, 'python', 'bin', 'python3')
  fs.mkdirSync(path.dirname(bundled), { recursive: true })
  fs.writeFileSync(bundled, 'synthetic interpreter fixture')
  const bundleEnv = { ROKU_SYNC_PYTHON: '/stale/external/python' }
  configureRuntime({ packaged: true, resourcesPath: resources, userData: dir, env: bundleEnv })
  assert.equal(bundleEnv.ROKU_SYNC_PYTHON, bundled, 'installed app must use its own bundled runtime')
  fs.writeFileSync(path.join(dir, 'settings.env'), 'SYNC_TOKEN=local-fixture-only\n')
  const childEnv = { ...process.env }
  delete childEnv.SYNC_TOKEN
  delete childEnv.ROKU_SYNC_ENV_FILE
  delete childEnv.ROKU_SYNC_PYTHON
  const script = `require('./desktop/runtime.cjs').configureRuntime({packaged:true,userData:process.argv[1]}); console.log(process.env.SYNC_TOKEN === 'local-fixture-only')`
  const child = spawnSync(process.execPath, ['-e', script, dir], { cwd: path.join(__dirname, '..'), env: childEnv, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), 'true', 'packaged startup loads private settings from outside the app')
  const { DesktopController } = require('../desktop/controller.cjs')
  fs.writeFileSync(path.join(dir, 'helper.py'), 'VALUE = 1\n')
  fs.writeFileSync(path.join(dir, 'probe.py'), 'import helper\n')
  const controller = new DesktopController({ rootDir: dir, configPath: path.join(dir, 'config.json') })
  const spec = controller._spawnArgv('probe.py', [])
  const probe = spawnSync(spec.command, spec.args, { cwd: dir, env: spec.env, encoding: 'utf8' })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(fs.existsSync(path.join(dir, '__pycache__')), false, 'Python imports must not add unsigned files to the sealed app bundle')
  console.log('Packaged runtime resolves private settings, Python and tools without shell setup')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
