import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createBrowserFetcher } from '../scripts/browser-fetch.mjs'
import { parseListingPage } from '../scripts/giga-tires.mjs'
import { InputError } from './inventory.mjs'

export class Refresher {
  constructor(inventory, { createFetcher = createBrowserFetcher, pause = () => delay(1500) } = {}) {
    this.inventory = inventory
    this.createFetcher = createFetcher
    this.pause = pause
    this.active = null
    const previous = inventory.getMeta('job')
    if (previous?.status === 'running') {
      inventory.setMeta('job', { ...previous, status: 'interrupted', finishedAt: new Date().toISOString(),
        message: 'Server stopped during refresh. Completed sizes are saved; refresh again to continue.' })
    }
  }

  start(sizes) {
    if (this.active) throw new InputError('A supplier refresh is already running.', 409)
    if (!Array.isArray(sizes) || !sizes.length || sizes.length > this.inventory.sizes.length ||
        sizes.some(size => !this.inventory.sizes.includes(size))) throw new InputError('Choose supported KMT sizes')
    const job = { id: randomUUID(), status: 'running', sizes: [...new Set(sizes)],
      completed: 0, failed: [], tiresRead: 0, pagesRead: 0, currentSize: null,
      startedAt: new Date().toISOString(), message: 'Opening supplier browser…' }
    this.inventory.setMeta('job', job)
    this.active = { job, cancelled: false }
    this.done = this.run(this.active).finally(() => { this.active = null })
    return job
  }

  cancel() {
    if (!this.active) throw new InputError('No refresh is running', 409)
    this.active.cancelled = true
    return { message: 'Stopping after the current page. Incomplete sizes will be kept unchanged.' }
  }

  async run(run) {
    const { job } = run
    let browser
    try {
      browser = await this.createFetcher()
      for (const size of job.sizes) {
        if (run.cancelled) break
        job.currentSize = size
        job.message = `Reading ${size}`
        this.inventory.setMeta('job', job)
        try {
          const rows = new Map()
          let totalPages = 1
          for (let page = 1; page <= totalPages; page++) {
            if (job.pagesRead) await this.pause()
            if (run.cancelled) break
            const { html } = await browser.fetchSizePage(size, page)
            job.pagesRead++
            const parsed = parseListingPage(html, size)
            if (page === 1) totalPages = parsed.totalPages
            if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 1000) throw new Error('Unexpected pagination; previous inventory kept')
            if (!parsed.rows.length || parsed.skipped.length) throw new Error('Incomplete or unpriced supplier results; previous inventory kept')
            let added = 0
            for (const row of parsed.rows) { if (!rows.has(row.id)) added++; rows.set(row.id, row) }
            if (!added) throw new Error('Supplier repeated a page; previous inventory kept')
            job.message = `${size} · page ${page} of ${totalPages}`
            this.inventory.setMeta('job', job)
          }
          if (run.cancelled) break
          this.inventory.refreshSize(size, [...rows.values()])
          job.completed++
          job.tiresRead += rows.size
        } catch (error) {
          this.inventory.recordFailure(size, error.message)
          job.failed.push({ size, message: error.message })
          // Do not repeatedly challenge the supplier after a block or timeout.
          job.message = `Stopped at ${size}: ${error.message}`
          break
        }
        this.inventory.setMeta('job', job)
      }
      job.status = run.cancelled ? 'cancelled' : job.failed.length ? 'failed' : 'completed'
      if (!job.failed.length) job.message = run.cancelled ? 'Refresh stopped. Completed sizes are saved.' : 'Supplier refresh complete.'
    } catch (error) {
      job.status = 'failed'
      job.message = error.message
    } finally {
      try { if (browser) await browser.close() } catch { /* Preserve the original job result. */ }
      job.finishedAt = new Date().toISOString()
      this.inventory.setMeta('job', job)
    }
  }
}
