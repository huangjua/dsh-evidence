/**
 * core.test.mjs — dsh-evidence 完整性测试矩阵
 *
 * 测试对象：安装副本（build 部署产物）lib/core.js，与运行时加载的是同一份产物。
 * 测试框架：Node 内置 test runner（零新依赖）。
 * 借鉴来源（MIT）：030611/qiushi-dsh-evidence-audit tests/receipt.spec.ts 的
 *   测试思路（正链/断链/重排/缺省/序列连续性/不泄露正文），按本项目协议适配。
 *
 * 契约（Part A）：
 *   - receipt 缺省：按既有无 receipt 规则判断（文件完整性）；
 *   - receipt 存在：必须 receipt.valid 且 receipt.consistentWithManifest；
 *   - receipt 链合法但绑定旧 manifest：intact=false；
 *   - manifest / 文件哈希不一致：intact=false；
 *   - stale / expired / missing 语义不变（不参与完整性判定）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
const INSTALL = process.env.DSH_EVIDENCE_INSTALL || PROJECT
const core = await import(pathToFileURL(join(INSTALL, 'lib', 'core.js')).href)
const { createBundle, addFiles, verifyBundle, saveManifest, loadManifest, canonicalJson, verifyReceiptText } = core

/** 证据正文哨兵：任何失败原因的文本里都不允许出现它 */
const SENTINEL = 'SENTINEL_EVIDENCE_BODY_7f3a9c'

const roots = []
function newRoot() {
  const r = mkdtempSync(join(tmpdir(), 'ev-core-'))
  roots.push(r)
  return r
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function writeEvidence(root, name, content = SENTINEL) {
  const file = join(root, `${name}.txt`)
  writeFileSync(file, content, 'utf8')
  return file
}

function assertNoContentLeak(result) {
  const json = JSON.stringify(result)
  assert.ok(!json.includes(SENTINEL), '失败原因不得泄漏 evidence 正文')
}

/** 场景：create + 1 次 add，返回 {root, name, file, createManifest, addManifest} */
async function buildSingleAddBundle() {
  const root = newRoot()
  const name = `bundle-${roots.length}`
  const created = createBundle(root, name, '测试包')
  const file = writeEvidence(root, 'a0')
  const added = await addFiles(root, name, [file], 'note-a0', { claim: 'A0 成功' })
  return { root, name, file, created, added }
}

test('1. 当前 manifest + 当前合法 receipt → PASS', async () => {
  const { root, name } = await buildSingleAddBundle()
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'PASS')
  assert.equal(r.matched, 1)
  assert.equal(r.receipt.present, true)
  assert.equal(r.receipt.valid, true)
  assert.equal(r.receipt.consistentWithManifest, true)
})

test('2a. manifest 被直接修改（未重签）→ FAIL + manifestTampered', async () => {
  const { root, name } = await buildSingleAddBundle()
  const file = join(root, name, 'evidence.json')
  const m = JSON.parse(readFileSync(file, 'utf8'))
  m.description = '被篡改的清单'
  writeFileSync(file, JSON.stringify(m, null, 2), 'utf8') // 直接写，不重签
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL')
  assert.equal(r.manifestTampered, true)
  assert.ok(r.errors.join('').includes('篡改'))
  assertNoContentLeak(r)
})

test('2b. manifest 重签为新哈希但 receipt 未跟进 → FAIL + inconsistent', async () => {
  const { root, name } = await buildSingleAddBundle()
  const m = loadManifest(root, name)
  m.description = '重签后的清单'
  saveManifest(root, name, m) // 合法重签，但 receipt 链未追加
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL')
  assert.equal(r.receipt.valid, true)
  assert.equal(r.receipt.consistentWithManifest, false) // 原因可区分：不一致而非链损坏
  assertNoContentLeak(r)
})

test('3. receipt 内容被修改（链损坏）→ FAIL + receipt invalid 且定位到行', async () => {
  const { root, name } = await buildSingleAddBundle()
  const file = join(root, name, 'receipt.jsonl')
  const text = readFileSync(file, 'utf8')
  const tampered = text.replace('"note":"note-a0"', '"note":"note-a0X"')
  assert.notEqual(text, tampered)
  writeFileSync(file, tampered, 'utf8')
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL')
  assert.equal(r.receipt.present, true)
  assert.equal(r.receipt.valid, false) // 原因可区分：链损坏
  assert.ok(r.receipt.error && /line \d+/.test(r.receipt.error), `应定位到行: ${r.receipt.error}`)
  assertNoContentLeak(r)
})

test('4. receipt 链合法但绑定旧 manifest（回滚清单）→ FAIL + inconsistent', async () => {
  const { root, name, created } = await buildSingleAddBundle()
  // 回滚：把清单写回 create 时的状态（哈希 = 第一条收据的 payload.manifestHash），
  // receipt 链本身仍合法（seq0、seq1 完好），但最后一条收据绑定的 hash 不再是当前清单的。
  saveManifest(root, name, created.manifest)
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL') // 核心漏洞：旧实现这里会是 PASS
  assert.equal(r.receipt.valid, true)
  assert.equal(r.receipt.consistentWithManifest, false) // 原因可区分：绑定旧 manifest
  assertNoContentLeak(r)
})

test('5. receipt 缺省（删除）→ 按无 receipt 规则判断', async () => {
  const { root, name } = await buildSingleAddBundle()
  rmSync(join(root, name, 'receipt.jsonl'))
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'PASS') // 契约允许缺省
  assert.equal(r.receipt.present, false)
  assert.equal(r.receipt.valid, false)
})

test('6. 多收据哈希链正常（create + 2 add）→ PASS records=3', async () => {
  const root = newRoot()
  const name = `bundle-${roots.length}`
  createBundle(root, name, '多链')
  const f1 = writeEvidence(root, 'f1')
  const f2 = writeEvidence(root, 'f2', 'second')
  await addFiles(root, name, [f1], 'add1')
  await addFiles(root, name, [f2], 'add2')
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'PASS')
  assert.equal(r.receipt.records, 3)
  assert.equal(r.receipt.consistentWithManifest, true)
})

test('7. 中间 receipt 被删除 / 重排 → FAIL + 链损坏', async () => {
  const root = newRoot()
  const name = `bundle-${roots.length}`
  createBundle(root, name, '链破坏')
  const f1 = writeEvidence(root, 'f1')
  const f2 = writeEvidence(root, 'f2', 'second')
  await addFiles(root, name, [f1], 'add1')
  await addFiles(root, name, [f2], 'add2')
  const file = join(root, name, 'receipt.jsonl')
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  assert.equal(lines.length, 3)
  // 删除中间记录（seq 0,2 不连续）
  writeFileSync(file, lines[0] + '\n' + lines[2] + '\n', 'utf8')
  let r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL')
  assert.equal(r.receipt.valid, false)
  // 重排（seq 2,1,0）
  writeFileSync(file, lines[2] + '\n' + lines[1] + '\n' + lines[0] + '\n', 'utf8')
  r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL')
  assert.equal(r.receipt.valid, false)
  assertNoContentLeak(r)
})

test('8. evidence 文件缺失 → FAIL + missing 列出路径', async () => {
  const { root, name, file } = await buildSingleAddBundle()
  rmSync(file)
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL')
  assert.ok(r.missing.includes(file))
})

test('9. canonical 序列化确定性 + 路径变化检测', async () => {
  // canonicalJson 与键顺序无关
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  assert.equal(canonicalJson({ a: [3, { y: 1, x: 2 }] }), '{"a":[3,{"x":2,"y":1}]}')
  // 快照后重命名文件 → 原路径不再存在 → missing
  const { root, name, file } = await buildSingleAddBundle()
  renameSync(file, file + '.renamed')
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'FAIL')
  assert.ok(r.missing.includes(file))
})

test('10. stale / expired 语义不变（不破坏完整性）', async () => {
  const root = newRoot()
  const name = `bundle-${roots.length}`
  createBundle(root, name, '语义守卫')
  const file = writeEvidence(root, 's1')
  await addFiles(root, name, [file], '', { validUntil: Date.parse('2020-01-01') }) // 已过期
  // 内容不变但 mtime 被 touch
  const future = new Date(Date.now() + 60_000)
  utimesSync(file, future, future)
  const r = await verifyBundle(root, name)
  assert.equal(r.status, 'PASS') // stale/expired 不参与完整性
  assert.ok(r.stale.includes(file))
  assert.ok(r.expired.includes(file))
  assert.equal(r.matched, 1)
})
