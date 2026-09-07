import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { injectCopy } from './static.mjs'

function shell(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmt-social-shell-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'index.html')
  writeFileSync(file, '<!doctype html><head><script type="application/ld+json">{"@type":"AutoRepair","name":"KMT"}</script></head><body></body>')
  return file
}

test('empty social proof injects an empty-safe data block without sameAs', t => {
  const { body } = injectCopy(shell(t), {}, { profiles: [], testimonials: [] })
  assert.match(body, /id="social-proof">\{"profiles":\[\],"testimonials":\[\]\}/)
  assert.doesNotMatch(body, /sameAs/)
})

test('social links and structured data use the same normalized URL list', t => {
  const profiles = [{ platform: 'instagram', url: 'https://instagram.com/kmt/', enabled: true }]
  const { body } = injectCopy(shell(t), {}, { profiles, testimonials: [] })
  assert.match(body, /id="social-proof">.*instagram\.com\/kmt\//)
  const json = JSON.parse(body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])
  assert.deepEqual(json.sameAs, ['https://instagram.com/kmt/'])
})
