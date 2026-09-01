#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const required = [
  'lib/index.js', 'lib/core.js',
  'lib/types/index.d.ts', 'lib/types/core.d.ts',
  'package.json', 'README.md',
]
const forbidden = [
  /^src\//, /^tests?\//, /^scripts\//, /^release\//, /^\.git\//,
  /^node_modules\//, /\.tgz$/, /\.tmp$/, /\.compat-home$/, /\.test-build\//,
]
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmRun = (args) => execFileSync(npm, args, { cwd: root, encoding: 'utf8', shell: true })

const dry = JSON.parse(npmRun(['pack', '--dry-run', '--json', '--ignore-scripts']))[0]
const paths = (dry?.files ?? []).map((file) => file.path)
assert.equal(dry?.name, '@dsh-external/dsh-evidence')
for (const file of required) assert.ok(paths.includes(file), `pack missing ${file}`)
for (const file of paths) for (const pattern of forbidden) assert.equal(pattern.test(file), false, `pack leaked ${file}`)

const temp = mkdtempSync(join(tmpdir(), 'dsh-evidence-pack-'))
try {
  const output = npmRun(['pack', '--pack-destination', temp]).trim()
  const tgz = join(temp, output.split(/\r?\n/).filter(Boolean).at(-1))
  assert.ok(existsSync(tgz), 'npm pack did not produce an archive')
  const unpacked = join(temp, 'package')
  mkdirSync(unpacked)
  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
  execFileSync(tar, ['-xzf', tgz, '--strip-components=1', '-C', unpacked], { stdio: 'pipe' })
  for (const file of required) assert.ok(existsSync(join(unpacked, file)), `unpacked pack missing ${file}`)

  // The tarball intentionally contains no dependencies. Mount the already
  // verified alpha.3 runtime tree into the clean unpack directory so this
  // checks the shipped entrypoint, not the development copy.
  const nodeModules = join(unpacked, 'node_modules')
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  `, nodeModules, join(root, 'node_modules')], { stdio: 'pipe' })

  const module = await import(pathToFileURL(join(unpacked, 'lib/index.js')).href)
  assert.equal(module.name, '@dsh-external/dsh-evidence')
  assert.equal(typeof module.apply, 'function')

  const registered = []
  const cleanups = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {
          const index = registered.indexOf(tool)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(temp, 'home')
  try {
    module.apply(ctx, { evidenceRoot: join(temp, 'evidence') })
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
  assert.deepEqual(registered.map((tool) => tool.name), [
    'evidence_create', 'evidence_add', 'evidence_verify', 'evidence_list', 'evidence_show',
  ])
  for (const cleanup of cleanups.reverse()) cleanup()
  assert.equal(registered.length, 0)
  console.log(`PACK-CHECK PASS (${paths.length} files; 5 tools; dispose clean)`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
