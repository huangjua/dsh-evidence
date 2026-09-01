/**
 * @dsh-external/dsh-evidence — 证据包 / 审计证据（toolkit）v2
 *
 * 借鉴 Codex audit-evidence 模式（openai/codex）+ qiushi-dsh-evidence-audit 哈希链收据
 * + better-harness evidence-bounded claims + haft 有效期。详见 core.ts 头部 attribution。
 *  - 每个证据包目录含 evidence.json 清单（v2：自完整性哈希）
 *  - 文件快照记录 SHA256/size/mtime + 可选 claim/validUntil/source
 *  - receipt.jsonl 追加式哈希链：每次 create/add 的不可抵赖轨迹
 *  - verify 重新计算哈希，区分 missing / corrupt / stale / expired，并校验清单与收据链
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  createBundle,
  addFiles,
  verifyBundle,
  listBundles,
  loadManifest,
  splitPaths,
  resolveRoot,
  type EvidenceManifest,
  type ReceiptCheck,
} from './core.js'

export const name = '@dsh-external/dsh-evidence'
export const inject = ['tools']

export interface Config {
  evidenceRoot: string
}

export const Config = z.object({
  evidenceRoot: z.string().default(''),
})

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }]

export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const root = resolveRoot(config.evidenceRoot)

  /* ── 工具 1：创建证据包 ── */
  const toolCreate = defineTool({
    name: 'evidence_create',
    description: '创建证据包目录和 evidence.json 清单（v2：自完整性哈希 + receipt.jsonl 哈希链收据）。之后用 evidence_add 添加文件快照。',
    parameters: {
      name: { type: 'string', description: '证据包名称/ID，例如 jhora-audit-20260816', required: true },
      description: { type: 'string', description: '一句话描述' },
      metadataJson: { type: 'string', description: '可选 JSON 对象字符串，存入 metadata' },
      root: { type: 'string', description: '证据根目录，缺省 ~/.dsh/evidence' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          name: { type: 'string' },
          dir: { type: 'string' },
          manifestFile: { type: 'string' },
          createdAt: { type: 'integer' },
          manifestHash: { type: 'string' },
          receiptRecords: { type: 'integer' },
        },
      },
      render: (_args, v) => text([
        `[evidence-create] ${v.name}`,
        `dir=${v.dir}`,
        `manifest=${v.manifestFile}`,
        `createdAt=${new Date(v.createdAt ?? 0).toISOString()}`,
        `manifestHash=${v.manifestHash ?? ''} receiptRecords=${v.receiptRecords ?? 0}`,
      ].join('\n')),
    },
    execute: async (args) => {
      const r = resolveRoot(args.root || root)
      const res = createBundle(r, args.name, args.description || '', args.metadataJson || '')
      return {
        root: r,
        name: args.name,
        dir: res.dir,
        manifestFile: res.manifestFile,
        createdAt: res.manifest.createdAt,
        manifestHash: res.manifest.manifestHash,
        receiptRecords: res.receipt.sequence + 1,
      } as any
    },
  })

  /* ── 工具 2：添加文件快照 ── */
  const toolAdd = defineTool({
    name: 'evidence_add',
    description: '向已有证据包添加文件/目录快照：记录每个文件的 SHA256、size、mtime；可选 claim（证据支撑的结论）、validUntil（有效期 ISO 日期）、copy（把文件复制进证据包实现自包含）。多个路径用 | 分隔。',
    parameters: {
      name: { type: 'string', description: '证据包名称', required: true },
      paths: { type: 'string', description: '要快照的文件/目录，多个用 | 分隔', required: true },
      note: { type: 'string', description: '可选备注，追加到 metadata.notes' },
      claim: { type: 'string', description: '可选：这条快照支撑什么结论（evidence-bounded claim）' },
      validUntil: { type: 'string', description: '可选：证据有效期（ISO 日期，如 2026-12-31）' },
      copy: { type: 'boolean', description: '可选：把文件复制进证据包 files/ 目录（自包含，缺省 false）' },
      root: { type: 'string', description: '证据根目录，缺省 ~/.dsh/evidence' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          name: { type: 'string' },
          bundle: { type: 'string' },
          manifestFile: { type: 'string' },
          added: { type: 'integer' },
          updated: { type: 'integer' },
          copied: { type: 'integer' },
          totalFiles: { type: 'integer' },
        },
      },
      render: (_args, v) => text([
        `[evidence-add] ${v.name}`,
        `bundle=${v.bundle}`,
        `added=${v.added} updated=${v.updated} copied=${v.copied ?? 0} totalFiles=${v.totalFiles}`,
        `manifest=${v.manifestFile}`,
      ].join('\n')),
    },
    execute: async (args) => {
      const r = resolveRoot(args.root || root)
      let validUntil: number | undefined
      if (args.validUntil) {
        const parsed = Date.parse(args.validUntil)
        if (Number.isNaN(parsed)) throw new Error(`validUntil 无法解析为日期: ${args.validUntil}`)
        validUntil = parsed
      }
      const res = await addFiles(r, args.name, splitPaths(args.paths), args.note || '', {
        claim: args.claim || undefined,
        validUntil,
        copy: Boolean(args.copy),
      })
      return {
        root: r,
        name: args.name,
        bundle: res.bundle,
        manifestFile: res.manifestFile,
        added: res.added.length,
        updated: res.updated.length,
        copied: res.copied.length,
        totalFiles: res.totalFiles,
      } as any
    },
  })

  /* ── 工具 3：校验证据包 ── */
  const toolVerify = defineTool({
    name: 'evidence_verify',
    description: '校验证据包：重新计算每个文件的 SHA256，报告 missing / corrupt / stale / expired，并校验清单自完整性（manifestHash）与追加式哈希链收据（receipt.jsonl）。',
    parameters: {
      name: { type: 'string', description: '证据包名称', required: true },
      root: { type: 'string', description: '证据根目录，缺省 ~/.dsh/evidence' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          name: { type: 'string' },
          bundle: { type: 'string' },
          status: { type: 'string' },
          total: { type: 'integer' },
          matched: { type: 'integer' },
          missing: { type: 'array', items: { type: 'string' } },
          corrupt: { type: 'array', items: { type: 'string' } },
          stale: { type: 'array', items: { type: 'string' } },
          expired: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          manifestTampered: { type: 'boolean' },
          receipt: {
            type: 'object',
            additionalProperties: true,
            properties: {
              present: { type: 'boolean' },
              valid: { type: 'boolean' },
              records: { type: 'integer' },
              consistentWithManifest: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines = [
          `[evidence-verify] ${v.name} → ${v.status}`,
          `total=${v.total} matched=${v.matched}`,
        ]
        if (v.missing?.length) lines.push(`missing=${v.missing.length}`)
        if (v.corrupt?.length) lines.push(`corrupt=${v.corrupt.length}`)
        if (v.stale?.length) lines.push(`stale=${v.stale.length}（内容未变但 mtime 漂移，快照后被碰过）`)
        if (v.expired?.length) lines.push(`expired=${v.expired.length}（已过有效期）`)
        if (v.errors?.length) lines.push(`errors=${v.errors.length}`)
        if (v.manifestTampered) lines.push('manifestTampered=true（清单自完整性哈希不匹配）')
        const rc = v.receipt as ReceiptCheck | undefined
        if (rc) {
          if (!rc.present) lines.push('receipt=无（旧格式证据包）')
          else if (!rc.valid) lines.push(`receipt=损坏（${rc.error || '链校验失败'}）`)
          else lines.push(`receipt=valid records=${rc.records}${rc.consistentWithManifest ? '' : '（与当前清单不一致）'}`)
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const r = resolveRoot(args.root || root)
      const res = await verifyBundle(r, args.name)
      return { root: r, name: args.name, ...res } as any
    },
  })

  /* ── 工具 4：列出证据包 ── */
  const toolList = defineTool({
    name: 'evidence_list',
    description: '列出证据根目录下的所有证据包（名称、路径、创建/更新时间、文件数、过期数）。',
    parameters: {
      root: { type: 'string', description: '证据根目录，缺省 ~/.dsh/evidence' },
      query: { type: 'string', description: '按名称/描述子串过滤' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          total: { type: 'integer' },
          bundles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                createdAt: { type: 'integer' },
                updatedAt: { type: 'integer' },
                description: { type: 'string' },
                files: { type: 'integer' },
                expired: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines: string[] = [`[evidence-list] total=${v.total}`]
        for (const b of v.bundles ?? []) {
          lines.push(` ${b.name} | files=${b.files}${b.expired ? ` expired=${b.expired}` : ''} | updated=${new Date(b.updatedAt ?? 0).toISOString()} | ${b.description || ''}`)
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const r = resolveRoot(args.root || root)
      const q = (args.query || '').toLowerCase()
      const all = listBundles(r).filter((b) => !q || b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q))
      return { root: r, total: all.length, bundles: all } as any
    },
  })

  /* ── 工具 5：查看证据包详情 ── */
  const toolShow = defineTool({
    name: 'evidence_show',
    description: '查看证据包 evidence.json 清单：文件路径、SHA256、size、mtime、claim、validUntil、source。',
    parameters: {
      name: { type: 'string', description: '证据包名称', required: true },
      root: { type: 'string', description: '证据根目录，缺省 ~/.dsh/evidence' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          name: { type: 'string' },
          manifest: {
            type: 'object',
            additionalProperties: true,
            properties: {
              version: { type: 'integer' },
              id: { type: 'string' },
              createdAt: { type: 'integer' },
              updatedAt: { type: 'integer' },
              description: { type: 'string' },
              metadata: { type: 'object', additionalProperties: true },
              files: { type: 'object', additionalProperties: true },
            },
          },
          files: { type: 'integer' },
        },
      },
      render: (_args, v) => {
        const m = v.manifest as unknown as EvidenceManifest
        const lines = [
          `[evidence-show] ${v.name}`,
          `dir=${v.root}\\${v.name}`,
          `created=${new Date(m.createdAt ?? 0).toISOString()} updated=${new Date(m.updatedAt ?? 0).toISOString()}`,
          `description=${m.description || ''}`,
          `manifestHash=${m.manifestHash || '无（旧格式）'}`,
          `files=${v.files ?? 0}`,
        ]
        for (const [file, entry] of Object.entries(m.files ?? {})) {
          const extras: string[] = []
          if (entry.claim) extras.push(`claim=${entry.claim}`)
          if (entry.validUntil) extras.push(`validUntil=${new Date(entry.validUntil).toISOString()}`)
          if (entry.source) extras.push(`source=${entry.source}`)
          lines.push(` ${file} | ${entry.sha256} | ${entry.size}B | ${new Date(entry.mtimeMs ?? 0).toISOString()}${extras.length ? ' | ' + extras.join(' | ') : ''}`)
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const r = resolveRoot(args.root || root)
      const m = loadManifest(r, args.name)
      return { root: r, name: args.name, manifest: m, files: Object.keys(m.files).length } as any
    },
  })

  const tools = [toolCreate, toolAdd, toolVerify, toolList, toolShow]

  for (const t of tools) {
    ctx.effect(() => ctx.tools.register(t), `@dsh-external/dsh-evidence: ${t.name}`)
  }
}
