import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogImagePath } from './catalog-image.js'

const hash = 'a'.repeat(64)

test('catalog images accept only the canonical relative backend route', () => {
  assert.equal(catalogImagePath(`/api/images/${hash}.jpeg`), `/api/images/${hash}.jpeg`)
  assert.equal(catalogImagePath(`/api/images/${hash}.png`), `/api/images/${hash}.png`)
})

test('catalog images reject remote, ambiguous, and unrelated paths', () => {
  for (const value of [
    `https://supplier.example/${hash}.png`,
    `https://kensmobiletire.com/api/images/${hash}.png`,
    `//supplier.example/api/images/${hash}.png`,
    `/api/images/${hash}.png?source=supplier`,
    `/api/images/${hash}.png#supplier`,
    `/api/catalog/${hash}.png`,
    `/api/images/${hash.toUpperCase()}.png`,
    `/api/images/${hash}.webp`,
    ` /api/images/${hash}.png`,
    '', null, undefined,
  ]) assert.equal(catalogImagePath(value), '', String(value))
})
