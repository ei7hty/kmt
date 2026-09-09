import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { imageDirectoryForDatabase } from './image-publication.mjs'
import path from 'node:path'

test('custom database image stores are globally excluded from Docker context and Git', () => {
  // Guard the actual ignore-file contracts, including the order: a later
  // negation must not make private bytes eligible for COPY . . again.
  const rules = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  assert.equal(rules('.dockerignore').at(-1), '**/catalog-images-private')
  assert.equal(rules('.gitignore').at(-1), '**/catalog-images-private/')
  for (const filename of ['owner.sqlite', 'scratch/owner.sqlite', 'nested/custom/owner.sqlite']) {
    assert.equal(path.basename(imageDirectoryForDatabase(path.resolve(filename))), 'catalog-images-private')
  }
})
