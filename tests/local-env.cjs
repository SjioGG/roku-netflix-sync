'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadLocalEnv } = require('../desktop/local-env.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-env-test-'))
try {
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, '# comment\nROKU_ENV_TEST_OVERRIDE=file\nexport ROKU_ENV_TEST_LITERAL="literal $value # text"\nROKU_ENV_TEST_EMPTY=\n')
  process.env.ROKU_ENV_TEST_OVERRIDE = 'process'
  loadLocalEnv(file)
  assert.equal(process.env.ROKU_ENV_TEST_OVERRIDE, 'process')
  assert.equal(process.env.ROKU_ENV_TEST_LITERAL, 'literal $value # text')
  assert.equal(process.env.ROKU_ENV_TEST_EMPTY, '')
  loadLocalEnv(path.join(dir, 'missing'))
  fs.writeFileSync(file, 'not an assignment')
  assert.throws(() => loadLocalEnv(file), /Invalid .env entry/)
  console.log('Desktop .env loading preserves process settings and treats values as literal data')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
