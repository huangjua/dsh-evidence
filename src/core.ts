/**
 * core.ts — evidence/audit bundle engine (v2)
 *
 * 借鉴来源（attribution）：
 *  - Codex `audit-evidence` 模式（openai/codex，118k★）：证据包目录 + 清单 + 可复核快照。
 *    本文件保留其目录式证据包结构。
 *  - qiushi-dsh-evidence-audit（030611/qiushi-dsh-evidence-audit，MIT）：
 *    `canonicalJson` 确定性 JSON（递归键排序 + 严格校验）、追加式哈希链收据
 *    `EvidenceReceiptWriter`（打开时全链校验、拒绝续写被篡改的链、0700/0600 权限）——
 *    这两段按 MIT 许可移植并适配（明文 hex 哈希、receipt.jsonl 收据）。
 *  - QoderAI/better-harness（1.9k★）：evidence-bounded claims —— 每条快照可声明其支撑的结论；
 *    "missing evidence stays explicit" —— verify 把缺失/损坏/过期全部显式列出。
 *  - m0n0x41d/haft（1.4k★）：证据有效期（validUntil）与过期分类。
 *
 * 能力边界（诚实声明，参照 qiushi 的 can/cannot）：
 *  - 能证明：快照时文件内容是什么；快照之后是否被改动（损坏/被碰过）；清单与收据链是否被篡改。
 *  - 不能证明：文件内容本身是真实的、命令真的成功执行过、谁创建了文件、完整后缀是否被删除。
 */
import { createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  createReadStream,
  copyFileSync,
  openSync,
  closeSync,
  writeSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { join, isAbsolute, resolve, basename, dirname } from 'node:path'
import { types as utilTypes } from 'node:util'

/* ───────────────────────── 类型 ───────────────────────── */

export interface EvidenceFileEntry {
  sha256: string
  size: number
  mtimeMs: number
  /** 这条快照支撑的结论（evidence-bounded claim） */
  claim?: string
  /** 证据有效期（epoch ms）；过期证据不破坏完整性，但会显式标出 */
  validUntil?: number
  /** 自包含复制模式下原始文件路径 */
  source?: string
}

export interface EvidenceManifest {
  version: number
  id: string
  createdAt: number
  updatedAt: number
  description: string
  metadata: Record<string, unknown>
  files: Record<string, EvidenceFileEntry>
  /** v2：清单自完整性哈希（canonical JSON 的 SHA256，不含本字段） */
  manifestHash?: string
}

export interface BundleInfo {
  name: string
  path: string
  createdAt: number
  updatedAt: number
  description: string
  files: number
  expired: number
}

export interface AddResult {
  bundle: string
  manifestFile: string
  added: string[]
  updated: string[]
  copied: string[]
  totalFiles: number
}

export interface ReceiptCheck {
  present: boolean
  valid: boolean
  records: number
  lastRecordHash: string | null
  consistentWithManifest: boolean
  error?: string
}

export interface VerifyResult {
  status: 'PASS' | 'FAIL'
  bundle: string
  total: number
  matched: number
  missing: string[]
  corrupt: string[]
  /** 内容哈希一致但 mtime 变了 —— 快照后被碰过（不破坏完整性，但值得知道） */
  stale: string[]
  /** 已过有效期 */
  expired: string[]
  errors: string[]
  manifestTampered: boolean
  receipt: ReceiptCheck
}

/* ─────────────────── canonical JSON（移植自 qiushi，MIT） ─────────────────── */

const HASH_PATTERN = /^[0-9A-F]{64}$/

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 无损 JSON 渲染：对象键递归排序，严格拒绝非 JSON 值/环/代理。 */
export function canonicalJson(value: unknown): string {
  return renderCanonical(value, '$', new Set<object>())
}

function renderCanonical(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is not a finite JSON number`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${path} is not a plain JSON array`)
    }
    if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`)
    ancestors.add(value)
    try {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (descriptor === undefined) throw new TypeError(`${path}[${index}] contains a non-JSON array hole`)
        if (!('value' in descriptor)) throw new TypeError(`${path}[${index}] contains a non-JSON accessor`)
        items.push(renderCanonical(descriptor.value, `${path}[${index}]`, ancestors))
      }
      return `[${items.join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (utilTypes.isProxy(object)) throw new TypeError(`${path} is not a plain JSON object`)
    const prototype = Object.getPrototypeOf(object) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} is not a plain JSON object`)
    }
    if (ancestors.has(object)) throw new TypeError(`${path} contains a circular reference`)
    ancestors.add(object)
    try {
      const keys = Reflect.ownKeys(object)
      if (keys.some((key) => typeof key === 'symbol')) throw new TypeError(`${path} contains a non-JSON symbol key`)
      const entries = (keys as string[]).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (descriptor === undefined) throw new TypeError(`${path}.${key} disappeared during canonicalization`)
        if (!descriptor.enumerable) throw new TypeError(`${path}.${key} is a non-JSON non-enumerable property`)
        if (!('value' in descriptor)) throw new TypeError(`${path}.${key} contains a non-JSON accessor`)
        return `${JSON.stringify(key)}:${renderCanonical(descriptor.value, `${path}.${key}`, ancestors)}`
      })
      return `{${entries.join(',')}}`
    } finally {
      ancestors.delete(object)
    }
  }
  throw new TypeError(`${path} contains non-JSON ${typeof value}`)
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
}

/** 清单自完整性哈希：canonical JSON（去掉 manifestHash 自身）的 SHA256。 */
export function hashManifest(manifest: EvidenceManifest): string {
  const { manifestHash: _dropped, ...unsigned } = manifest
  return hashText(canonicalJson(unsigned))
}

/* ───────────────────────── 文件哈希（流式） ───────────────────────── */

/** 流式计算 SHA256，超大文件不再一次性读入内存。 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex').toUpperCase()))
  })
}

/* ───────────────────────── 路径/遍历 ───────────────────────── */

export function splitPaths(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function walkFiles(paths: string[]): string[] {
  const out: string[] = []
  for (const raw of paths) {
    const p = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw)
    let st
    try {
      st = statSync(p)
    } catch {
      throw new Error(`路径不存在: ${p}`)
    }
    if (st.isFile()) {
      out.push(p)
      continue
    }
    if (st.isDirectory()) {
      const walk = (dir: string) => {
        let names: string[]
        try {
          names = readdirSync(dir)
        } catch {
          return
        }
        for (const name of names) {
          const full = join(dir, name)
          let s
          try {
            s = statSync(full)
          } catch {
            continue
          }
          if (s.isDirectory()) walk(full)
          else if (s.isFile()) out.push(full)
        }
      }
      walk(p)
    }
  }
  return Array.from(new Set(out)).sort()
}

export function bundleDir(root: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`非法 evidence 名称: ${name}`)
  }
  return join(root, name)
}

export function manifestPath(root: string, name: string): string {
  return join(bundleDir(root, name), 'evidence.json')
}

export function receiptPath(root: string, name: string): string {
  return join(bundleDir(root, name), 'receipt.jsonl')
}

/* ─────────────────────── 并发锁（进程内/跨进程尽力而为） ─────────────────────── */

const LOCK_STALE_MS = 10_000

/**
 * 独占创建锁（openSync 'wx'）：并发 add/verify 与清单重写之间互斥。
 * 残留锁超过 LOCK_STALE_MS 视为孤儿并接管；持有者崩溃不会永久卡死。
 */
export async function withLock<T>(lockFile: string, fn: () => T | Promise<T>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let fd: number | null = null
    try {
      fd = openSync(lockFile, 'wx')
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      if (Date.now() > deadline) throw new Error(`evidence 锁超时: ${lockFile}（可能存在僵死的并发写入）`)
      try {
        const st = statSync(lockFile)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { rmSync(lockFile) } catch { /* 仍被持有，继续等 */ }
          continue
        }
      } catch {
        continue // 锁刚被释放
      }
      const until = Date.now() + 25
      while (Date.now() < until) { /* busy-wait 25ms */ }
      continue
    }
    try {
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
    } catch (e) {
      try { closeSync(fd) } catch { /* ignore */ }
      throw e
    }
    try {
      // 锁必须覆盖整个异步工作完成之后才释放
      return await fn()
    } finally {
      try { rmSync(lockFile) } catch { /* ignore */ }
    }
  }
}

/* ───────────────────────── 清单读写 ───────────────────────── */

export function loadManifest(root: string, name: string): EvidenceManifest {
  const file = manifestPath(root, name)
  if (!existsSync(file)) throw new Error(`证据包不存在: ${name} (${file})`)
  let obj: EvidenceManifest
  try {
    obj = JSON.parse(readFileSync(file, 'utf8')) as EvidenceManifest
  } catch (e) {
    throw new Error(`读取 evidence.json 失败: ${String(e).slice(0, 160)}`)
  }
  if (!obj || (obj.version !== 1 && obj.version !== 2) || typeof obj.id !== 'string') {
    throw new Error('evidence.json 格式不正确')
  }
  // v2 校验自完整性：清单被手工/程序篡改即刻可发现
  if (obj.version === 2) {
    const expected = hashManifest(obj)
    if (obj.manifestHash !== expected) {
      throw new Error(`证据包清单已被篡改（manifestHash 不匹配）: ${name}`)
    }
  }
  return obj
}

/** 签名并落盘清单：v2 + 自完整性哈希。返回签名后的清单（含 manifestHash）。 */
export function saveManifest(root: string, name: string, manifest: EvidenceManifest): EvidenceManifest {
  const dir = bundleDir(root, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // v2 起：升级版本号 + 写入自完整性哈希
  const signed: EvidenceManifest = { ...manifest, version: 2 }
  delete (signed as any).manifestHash
  signed.manifestHash = hashManifest(signed)
  const file = join(dir, 'evidence.json')
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(signed, null, 2), { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上尽力而为 */ }
  renameSync(tmp, file)
  return signed
}

/* ─────────────────── 追加式哈希链收据（移植自 qiushi，MIT） ─────────────────── */

export interface ReceiptRecord {
  schemaVersion: 1
  sequence: number
  at: number
  op: 'create' | 'add'
  previousRecordHash: string | null
  recordHash: string
  payload: {
    bundle: string
    manifestHash: string
    added?: string[]
    updated?: string[]
    copied?: string[]
    note?: string
  }
}

function parseReceiptLine(line: string, index: number): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error: unknown) {
    throw new Error(`line ${index + 1} is not JSON`, { cause: error })
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`line ${index + 1} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

function withoutRecordHash(record: Record<string, unknown>): Record<string, unknown> {
  const { recordHash: _recordHash, ...unsigned } = record
  return unsigned
}

export function verifyReceiptText(text: string): { records: number; lastRecordHash: string | null } {
  if (text.length === 0) return { records: 0, lastRecordHash: null }
  if (!text.endsWith('\n')) throw new Error('file does not end at a complete JSONL record')
  const lines = text.slice(0, -1).split('\n')
  let previous: string | null = null
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) throw new Error(`line ${index + 1} is empty`)
    const record = parseReceiptLine(line, index)
    if (record.schemaVersion !== 1) throw new Error(`line ${index + 1} has an unsupported schemaVersion`)
    if (record.sequence !== index) throw new Error(`line ${index + 1} has a non-contiguous sequence`)
    if (record.previousRecordHash !== previous) throw new Error(`line ${index + 1} has the wrong previousRecordHash`)
    if (typeof record.recordHash !== 'string' || !HASH_PATTERN.test(record.recordHash)) {
      throw new Error(`line ${index + 1} has an invalid recordHash`)
    }
    const expected = hashText(canonicalJson(withoutRecordHash(record)))
    if (record.recordHash !== expected) throw new Error(`line ${index + 1} recordHash does not match its fields`)
    previous = record.recordHash
  }
  return { records: lines.length, lastRecordHash: previous }
}

/** 打开即校验整条链；链损坏则拒绝续写。 */
class ReceiptWriter {
  private closed = false

  private constructor(
    private readonly descriptor: number,
    private nextSequence: number,
    private previousRecordHash: string | null,
  ) {}

  static open(path: string): ReceiptWriter {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const verification = existsSync(path) ? verifyReceiptText(readFileSync(path, 'utf8')) : { records: 0, lastRecordHash: null }
    const descriptor = openSync(path, 'a', 0o600)
    try {
      chmodSync(path, 0o600)
    } catch (e) {
      closeSync(descriptor)
      throw e
    }
    return new ReceiptWriter(descriptor, verification.records, verification.lastRecordHash)
  }

  append(op: ReceiptRecord['op'], payload: ReceiptRecord['payload']): ReceiptRecord {
    if (this.closed) throw new Error('evidence receipt writer is closed')
    const unsigned = {
      schemaVersion: 1 as const,
      sequence: this.nextSequence,
      at: Date.now(),
      op,
      previousRecordHash: this.previousRecordHash,
      payload,
    }
    const record: ReceiptRecord = {
      ...unsigned,
      recordHash: hashText(canonicalJson(unsigned)),
    }
    writeSync(this.descriptor, `${canonicalJson(record)}\n`, undefined, 'utf8')
    this.nextSequence += 1
    this.previousRecordHash = record.recordHash
    return record
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.descriptor)
  }
}

/** 向包内 receipt.jsonl 追加一条哈希链记录（原子追加，先验链后写入）。 */
function appendReceipt(root: string, name: string, op: ReceiptRecord['op'], payload: ReceiptRecord['payload']): ReceiptRecord {
  const writer = ReceiptWriter.open(receiptPath(root, name))
  try {
    return writer.append(op, payload)
  } finally {
    writer.close()
  }
}

export function checkReceipt(root: string, name: string, manifestHashNow: string | null): ReceiptCheck {
  const path = receiptPath(root, name)
  if (!existsSync(path)) {
    return { present: false, valid: false, records: 0, lastRecordHash: null, consistentWithManifest: false }
  }
  try {
    const text = readFileSync(path, 'utf8')
    const v = verifyReceiptText(text)
    // 最后一条收据记录的 payload.manifestHash 应当等于当前清单哈希；
    // 收据内部链合法 ≠ 当前 bundle 完整 —— 链合法但绑定旧 manifest 时 consistent=false
    let consistent = true
    if (manifestHashNow && v.lastRecordHash) {
      const lines = text.slice(0, -1).split('\n')
      const last = JSON.parse(lines[lines.length - 1]) as ReceiptRecord
      const lastPayloadHash = last?.payload?.manifestHash ?? null
      if (lastPayloadHash !== manifestHashNow) consistent = false
    }
    return { present: true, valid: true, records: v.records, lastRecordHash: v.lastRecordHash, consistentWithManifest: consistent }
  } catch (e) {
    return {
      present: true,
      valid: false,
      records: 0,
      lastRecordHash: null,
      consistentWithManifest: false,
      error: String(e instanceof Error ? e.message : e).slice(0, 200),
    }
  }
}

/* ───────────────────────── 证据包操作 ───────────────────────── */

export function createBundle(
  root: string,
  name: string,
  description = '',
  metadataJson = '',
): { dir: string; manifest: EvidenceManifest; manifestFile: string; receipt: ReceiptRecord } {
  const dir = bundleDir(root, name)
  if (existsSync(dir)) throw new Error(`证据包已存在: ${name}`)
  let metadata: Record<string, unknown> = {}
  if (metadataJson.trim()) {
    try {
      const parsed = JSON.parse(metadataJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>
      else throw new Error('metadataJson 必须是 JSON 对象')
    } catch (e) {
      throw new Error(`metadataJson 解析失败: ${String(e).slice(0, 160)}`)
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const now = Date.now()
  const manifest: EvidenceManifest = {
    version: 2,
    id: name,
    createdAt: now,
    updatedAt: now,
    description,
    metadata,
    files: {},
  }
  const signed = saveManifest(root, name, manifest)
  const receipt = appendReceipt(root, name, 'create', {
    bundle: name,
    manifestHash: signed.manifestHash as string,
  })
  return { dir, manifest: signed, manifestFile: manifestPath(root, name), receipt }
}

export interface AddOptions {
  claim?: string
  validUntil?: number
  copy?: boolean
}

/** 把外部文件复制进证据包 files/（自包含），返回 源路径→包内路径 映射。 */
function copyIntoBundle(root: string, name: string, files: string[]): Map<string, string> {
  const filesDir = join(bundleDir(root, name), 'files')
  mkdirSync(filesDir, { recursive: true, mode: 0o700 })
  const map = new Map<string, string>()
  const taken = new Set<string>()
  for (const src of files) {
    let dest = join(filesDir, basename(src))
    let i = 2
    while (taken.has(dest.toLowerCase()) || existsSync(dest)) {
      dest = join(filesDir, `${basename(src)}-${i}`)
      i += 1
    }
    taken.add(dest.toLowerCase())
    copyFileSync(src, dest)
    map.set(src, dest)
  }
  return map
}

export async function addFiles(
  root: string,
  name: string,
  paths: string[],
  note = '',
  opts: AddOptions = {},
): Promise<AddResult> {
  return withLock(join(bundleDir(root, name), '.lock'), async () => {
    const manifest = loadManifest(root, name)
    const files = walkFiles(paths)
    const copiedMap = opts.copy ? copyIntoBundle(root, name, files) : new Map<string, string>()
    const added: string[] = []
    const updated: string[] = []
    const copied: string[] = []
    for (const file of files) {
      const target = copiedMap.get(file) ?? file
      const st = statSync(target)
      const entry: EvidenceFileEntry = {
        sha256: await sha256File(target),
        size: st.size,
        mtimeMs: st.mtimeMs,
        ...(opts.claim ? { claim: opts.claim } : {}),
        ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
        ...(copiedMap.has(file) ? { source: file } : {}),
      }
      if (manifest.files[target]) updated.push(target)
      else added.push(target)
      manifest.files[target] = entry
      if (copiedMap.has(file)) copied.push(target)
    }
    if (note) {
      const notes = Array.isArray(manifest.metadata.notes) ? manifest.metadata.notes : []
      notes.push({ at: new Date().toISOString(), note })
      manifest.metadata.notes = notes
    }
    manifest.updatedAt = Date.now()
    const signed = saveManifest(root, name, manifest)
    appendReceipt(root, name, 'add', {
      bundle: name,
      manifestHash: signed.manifestHash as string,
      ...(added.length ? { added } : {}),
      ...(updated.length ? { updated } : {}),
      ...(copied.length ? { copied } : {}),
      ...(note ? { note } : {}),
    })
    return { bundle: bundleDir(root, name), manifestFile: manifestPath(root, name), added, updated, copied, totalFiles: Object.keys(manifest.files).length }
  })
}

export async function verifyBundle(root: string, name: string): Promise<VerifyResult> {
  let manifest: EvidenceManifest
  try {
    manifest = loadManifest(root, name)
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    if (msg.includes('篡改')) {
      return {
        status: 'FAIL',
        bundle: bundleDir(root, name),
        total: 0,
        matched: 0,
        missing: [],
        corrupt: [],
        stale: [],
        expired: [],
        errors: [msg],
        manifestTampered: true,
        receipt: { present: false, valid: false, records: 0, lastRecordHash: null, consistentWithManifest: false },
      }
    }
    throw e
  }
  const missing: string[] = []
  const corrupt: string[] = []
  const stale: string[] = []
  const expired: string[] = []
  const errors: string[] = []
  let matched = 0
  const now = Date.now()
  for (const [file, entry] of Object.entries(manifest.files)) {
    try {
      if (!existsSync(file)) {
        missing.push(file)
        continue
      }
      const actual = await sha256File(file)
      if (actual !== entry.sha256) {
        corrupt.push(file)
        continue
      }
      matched++
      // 内容一致但 mtime 漂移 = 快照后被碰过（touch/权限变更等），显式标出
      const st = statSync(file)
      if (st.mtimeMs !== entry.mtimeMs) stale.push(file)
      if (entry.validUntil && entry.validUntil < now) expired.push(file)
    } catch (e) {
      errors.push(`${file}: ${String(e).slice(0, 120)}`)
    }
  }
  const total = Object.keys(manifest.files).length
  const receipt = checkReceipt(root, name, manifest.manifestHash ?? null)
  // 完整性 = 无缺失/损坏/错误 + 清单未被篡改 + 收据绑定当前清单（若收据存在）。
  // 注意：receipt 内部哈希链合法 ≠ 当前 evidence bundle 完整 ——
  // receipt 合法但绑定旧 manifest（consistentWithManifest=false）时 intact 必须为 false。
  // stale/expired 不破坏完整性，只在报告中显式标出（诚实区分"变了"与"过期"）。
  const receiptOk = !receipt.present || (receipt.valid && receipt.consistentWithManifest)
  const intact = missing.length === 0 && corrupt.length === 0 && errors.length === 0 && receiptOk
  const status: VerifyResult['status'] = intact ? 'PASS' : 'FAIL'
  return { status, bundle: bundleDir(root, name), total, matched, missing, corrupt, stale, expired, errors, manifestTampered: false, receipt }
}

export function listBundles(root: string): BundleInfo[] {
  if (!existsSync(root)) return []
  const out: BundleInfo[] = []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const now = Date.now()
  for (const name of names) {
    const file = join(root, name, 'evidence.json')
    if (!existsSync(file)) continue
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as EvidenceManifest
      let expired = 0
      for (const entry of Object.values(manifest.files || {})) {
        if (entry.validUntil && entry.validUntil < now) expired++
      }
      out.push({
        name,
        path: join(root, name),
        createdAt: manifest.createdAt || 0,
        updatedAt: manifest.updatedAt || 0,
        description: manifest.description || '',
        files: Object.keys(manifest.files || {}).length,
        expired,
      })
    } catch {
      /* 损坏的包跳过，list 不抛 */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function resolveRoot(input: string): string {
  if (input) return isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
  return join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'evidence')
}
