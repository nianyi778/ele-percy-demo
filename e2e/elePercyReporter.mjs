/**
 * ele-percy Playwright reporter。零依赖，Node 18+。与 packages/cypress 的插件对标：
 * 把"测试跑通了没、失败在哪一步、失败时页面长什么样"送进 ele-percy 的测试报告。
 *
 * 上报三段式（服务端见 apps/web/src/lib/test-run.ts）：
 *   onBegin   → start：spec 清单占位（回答"停在哪个 spec"）
 *   每个 spec 文件的用例都出最终结果 → spec：计数 + 失败现场（报错、code frame、最近步骤、失败截图）
 *   onEnd     → end
 * 增量上报的意义：进程崩溃/被杀到不了 onEnd，服务端据"有开头没收尾"判为未跑完。
 *
 * 计数映射到 Cypress 语义（Slack 与报告面板用同一套）：
 *   passes = 最终通过（含重试后通过的 flaky）；failures = 最终失败；
 *   pending = test.skip / fixme 主动跳过；skipped = interrupted（被中断没跑完的）
 *
 * 配置（优先级 reporter 选项 > env）：
 *   server      ELE_PERCY_SERVER，否则从 PERCY_CLIENT_API_URL 去掉 /api/percy/v1 推出
 *   token       ELE_PERCY_TOKEN，否则 PERCY_TOKEN
 *   percyServer PERCY_SERVER_ADDRESS，否则 http://localhost:5338（构建 id 从它的 healthcheck 取）
 * 配置缺失或 percy agent 不在时打印一条提示后静默退出，绝不让测试变红。
 *
 * playwright.config.ts：
 *   reporter: [['list'], ['./e2e/support/elePercyReporter.mjs']]
 */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

const TAG = '[ele-percy]'
const MAX_STEPS = 30

export default class ElePercyReporter {
  constructor (options = {}) {
    const env = process.env
    this.server = trimSlash(options.server || env.ELE_PERCY_SERVER || deriveServer(env.PERCY_CLIENT_API_URL))
    this.token = options.token || env.ELE_PERCY_TOKEN || env.PERCY_TOKEN
    this.percyServer = trimSlash(options.percyServer || env.PERCY_SERVER_ADDRESS || 'http://localhost:5338')
    this.buildId = null
    this.disabled = false
    this.rootDir = process.cwd()
    /** spec relative → { pending: Set<testId>, results: Map<testId, {test, result}> } */
    this.files = new Map()
    this.queue = Promise.resolve() // 上报串行化，保证 spec 事件顺序
  }

  printsToStdio () { return false }

  disable (reason) {
    if (!this.disabled) console.warn(`${TAG} 测试结果上报已关闭：${reason}`)
    this.disabled = true
  }

  enqueue (fn) {
    this.queue = this.queue.then(fn).catch((err) => console.warn(`${TAG} ${err.message}`))
    return this.queue
  }

  async post (event) {
    if (this.disabled || !this.buildId) return
    try {
      const res = await fetch(`${this.server}/api/v1/builds/${this.buildId}/test-run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      })
      if (!res.ok) console.warn(`${TAG} 上报 ${event.event} 失败：HTTP ${res.status} ${await res.text().catch(() => '')}`)
    } catch (err) {
      console.warn(`${TAG} 上报 ${event.event} 失败：${err.message}`)
    }
  }

  async uploadScreenshot (path) {
    try {
      const data = await readFile(path)
      const sha = createHash('sha256').update(data).digest('hex')
      const res = await fetch(`${this.server}/api/v1/blobs/${sha}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream', 'X-Ele-Percy-Build': this.buildId },
        body: data
      })
      if (!res.ok) { console.warn(`${TAG} 截图上传失败：HTTP ${res.status}`); return null }
      return sha
    } catch (err) {
      console.warn(`${TAG} 截图上传失败：${err.message}`)
      return null
    }
  }

  onBegin (config, suite) {
    this.rootDir = config.rootDir
    if (!this.server || !this.token) return this.disable('缺少 ele-percy 地址或项目 token（ELE_PERCY_SERVER / ELE_PERCY_TOKEN）')
    for (const test of suite.allTests()) {
      const file = this.specOf(test)
      if (!this.files.has(file)) this.files.set(file, { pending: new Set(), results: new Map() })
      this.files.get(file).pending.add(test.id)
    }
    this.enqueue(async () => {
      this.buildId = await resolveBuildId(this.percyServer)
      if (!this.buildId) return this.disable(`本地 percy agent 不在 ${this.percyServer}，拿不到构建 id`)
      console.log(`${TAG} 测试结果将上报到 ${this.server}/builds/${this.buildId}`)
      const project = config.projects?.[0]
      await this.post({
        event: 'start',
        jobId: process.env.ELE_PERCY_JOB_ID || undefined,
        framework: 'playwright',
        frameworkVersion: config.version,
        browser: project ? `${project.use?.defaultBrowserType || 'chromium'}${project.name ? ` (${project.name})` : ''}` : undefined,
        specs: [...this.files.keys()]
      })
    })
  }

  specOf (test) {
    return relative(this.rootDir, test.location.file).split('\\').join('/')
  }

  onTestEnd (test, result) {
    // 还会重试的失败不是最终结果
    if (result.status !== 'passed' && result.status !== 'skipped' && result.retry < test.retries) return
    const file = this.specOf(test)
    const entry = this.files.get(file)
    if (!entry) return
    entry.pending.delete(test.id)
    entry.results.set(test.id, { test, result })
    if (entry.pending.size === 0) {
      const snapshot = [...entry.results.values()]
      this.files.set(file, { pending: new Set(), results: new Map() })
      this.enqueue(() => this.reportSpec(file, snapshot))
    }
  }

  async reportSpec (file, items) {
    if (this.disabled || !this.buildId) return
    let passes = 0, failures = 0, pending = 0, skipped = 0, durationMs = 0
    const failed = []
    for (const { test, result } of items) {
      durationMs += result.duration
      const outcome = test.outcome()
      if (result.status === 'skipped') { pending++; continue }
      if (result.status === 'interrupted') { skipped++; continue }
      if (outcome === 'expected' || outcome === 'flaky') { passes++; continue }
      failures++
      const err = result.error || result.errors?.[0] || {}
      const shot = (result.attachments || []).filter((a) => a.name === 'screenshot' && a.path).pop()
      failed.push({
        titlePath: titlePathOf(test),
        errorName: (err.message || '').split(':')[0].match(/^[A-Z][A-Za-z]*Error$/) ? err.message.split(':')[0] : null,
        errorMessage: stripAnsi(err.message || `${result.status}`),
        stack: err.stack ? stripAnsi(err.stack) : null,
        codeFrame: err.snippet
          ? { relativeFile: file, line: err.location?.line, column: err.location?.column, frame: stripAnsi(err.snippet), language: 'ts' }
          : null,
        steps: flattenSteps(result.steps).slice(-MAX_STEPS),
        screenshotSha: shot ? await this.uploadScreenshot(shot.path) : null,
        durationMs: result.duration
      })
    }
    await this.post({
      event: 'spec',
      spec: file,
      stats: { tests: items.length, passes, failures, pending, skipped, durationMs },
      error: null,
      failures: failed
    })
  }

  async onEnd (result) {
    // 被中断的文件（还有 pending 的用例）也报一次，服务端据此判"没跑完"停在哪
    for (const [file, entry] of this.files) {
      if (entry.results.size > 0 && entry.pending.size > 0) {
        const snapshot = [...entry.results.values()]
        this.enqueue(() => this.reportSpec(file, snapshot))
      }
    }
    await this.enqueue(async () => {
      if (this.disabled || !this.buildId) return
      const error = result.status === 'interrupted' ? '测试被中断' : result.status === 'timedout' ? '整体超时（globalTimeout）' : null
      await this.post({ event: 'end', error })
    })
  }
}

/** Playwright 的 titlePath 含根、project、文件名，去掉这三层留 describe → it */
function titlePathOf (test) {
  const parts = test.titlePath().filter(Boolean)
  const fileIdx = parts.findIndex((p) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(p))
  return fileIdx >= 0 ? parts.slice(fileIdx + 1) : parts.slice(-2)
}

/** 步骤时间线：只留 test.step 与 pw:api 两类，展平嵌套，失败的标 failed */
function flattenSteps (steps, out = []) {
  for (const s of steps || []) {
    if (s.category === 'test.step' || s.category === 'pw:api') {
      out.push({ name: s.category === 'test.step' ? 'step' : s.title.split('(')[0].trim().slice(0, 100), message: s.title.slice(0, 300), state: s.error ? 'failed' : 'passed' })
    }
    if (s.steps?.length) flattenSteps(s.steps, out)
  }
  return out
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (s) => String(s).replace(ANSI_RE, '')

function deriveServer (percyApiUrl) {
  return percyApiUrl ? percyApiUrl.replace(/\/api\/percy\/v1\/?$/, '') : null
}

function trimSlash (url) {
  return url ? url.replace(/\/$/, '') : url
}

async function resolveBuildId (percyServer) {
  try {
    const res = await fetch(`${percyServer}/percy/healthcheck`)
    if (!res.ok) return null
    const body = await res.json()
    return body?.build?.id || null
  } catch {
    return null
  }
}
