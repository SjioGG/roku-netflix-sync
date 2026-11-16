'use strict'

// Exercise the real Roku renderer across an initial and completed scan without
// needing Electron, a DOM package, or any network/device access.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../desktop/renderer.js'), 'utf8')
const start = source.indexOf("let renderedDeviceSignature = ''")
const end = source.indexOf('function renderPing(state)', start)
assert.ok(start >= 0 && end > start, 'Roku renderer section was not found')

function renderer() {
  const el = {
    rokuUrl: { value: 'http://192.168.1.100:8060' },
    rokuDeviceList: { innerHTML: '' },
    rokuScanSummary: { textContent: '' },
    openLocalNetwork: { classList: { add() { this.hidden = true }, remove() { this.hidden = false }, hidden: true } },
  }
  const context = vm.createContext({ el })
  vm.runInContext(source.slice(start, end), context)
  const state = {
    config: { rokuUrl: el.rokuUrl.value },
    rokuDevices: [],
    lastRokuScan: null,
    rokuScanError: null,
    rokuLocalNetworkBlocked: false,
  }
  context.renderRokuDevices(state)
  assert.match(el.rokuScanSummary.textContent, /Rescan devices|Scan the LAN/)
  return { el, context, state }
}

let failures = 0
for (const [name, fn] of [
  ['completed empty scan replaces initial guidance', () => {
    const { el, context, state } = renderer()
    context.renderRokuDevices({ ...state, lastRokuScan: 1 })
    assert.match(el.rokuScanSummary.textContent, /No Roku answered/,
      'a completed scan must visibly report that no Roku answered')
  }],
  ['failed scan replaces initial guidance', () => {
    const { el, context, state } = renderer()
    context.renderRokuDevices({ ...state, rokuScanError: 'Local network access denied' })
    assert.match(el.rokuScanSummary.textContent, /Scan failed: Local network access denied/,
      'a scan failure must remain visible even when the device list is unchanged')
  }],
  ['same-device-list rescans replace a previous failure and show new failures', () => {
    const { el, context, state } = renderer()
    context.renderRokuDevices({ ...state, lastRokuScan: 1 })
    assert.match(el.rokuScanSummary.textContent, /No Roku answered/)
    context.renderRokuDevices({ ...state, lastRokuScan: 1, rokuScanError: 'First failure' })
    assert.match(el.rokuScanSummary.textContent, /Scan failed: First failure/)
    context.renderRokuDevices({ ...state, lastRokuScan: 1, rokuScanError: 'Second failure' })
    assert.match(el.rokuScanSummary.textContent, /Scan failed: Second failure/)
    context.renderRokuDevices({ ...state, lastRokuScan: 2 })
    assert.match(el.rokuScanSummary.textContent, /No Roku answered/)
    assert.doesNotMatch(el.rokuScanSummary.textContent, /failure/i)
  }],
  ['macos local network block surfaces settings guidance and action button', () => {
    const { el, context, state } = renderer()
    context.renderRokuDevices({ ...state, lastRokuScan: 3, rokuLocalNetworkBlocked: true })
    assert.match(el.rokuScanSummary.textContent, /Local Network/i)
    assert.equal(el.openLocalNetwork.classList.hidden, false)
    context.renderRokuDevices({ ...state, lastRokuScan: 4, rokuLocalNetworkBlocked: false })
    assert.equal(el.openLocalNetwork.classList.hidden, true)
  }],
  ['index.html exposes a single unified scan button', () => {
    const html = fs.readFileSync(path.join(__dirname, '../desktop/index.html'), 'utf8')
    assert.match(html, /id="refresh-devices"/)
    assert.doesNotMatch(html, /id="scan-roku"/, 'second scan button must be removed')
  }],
]) {
  try {
    fn()
    console.log(`ok ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}
process.exitCode = failures ? 1 : 0
