import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createIsolatedImageDecoder } from './image-decoder.mjs'
import { decoderPython, realImageFixtures } from './fixtures/image-provider/decoder-fixtures.mjs'

const fixtures = realImageFixtures()
const inspect = createIsolatedImageDecoder({ python: decoderPython })
for (const format of ['png', 'jpeg', 'gif', 'webp']) {
  test(`isolated decoder fully loads real ${format}`, async () => {
    const result = await inspect(fixtures[format])
    assert.equal(result.format, format); assert.equal(result.width, 4); assert.equal(result.height, 3)
    assert.equal(result.frames, 1); assert.equal(result.decoder, '12.3.0')
    assert.equal(result.isolation, process.platform === 'win32' ? 'windows-job' : 'posix-rlimit')
  })
  test(`isolated decoder rejects truncated ${format}`, async () => {
    await assert.rejects(inspect(fixtures[format].subarray(0, -5)))
  })
}
test('isolated decoder rejects malformed, unsupported and animated content', async () => {
  for (const bytes of [Buffer.from('not an image'), fixtures.bmp, fixtures.animated]) await assert.rejects(inspect(bytes))
})
test('isolated decoder enforces pixel, input, frame and wall-clock limits', async () => {
  await assert.rejects(inspect(fixtures.png, { maxPixels: 11 }))
  await assert.rejects(inspect(Buffer.alloc(5 * 1024 * 1024 + 1)))
  await assert.rejects(inspect(fixtures.png, { maxFrames: 2 }))
  await assert.rejects(inspect(fixtures.png, { maxDecodeMs: 1 }), /deadline/)
})
test('isolated decoder abort and unavailable runtime fail closed without paths', async () => {
  const controller = new AbortController()
  const pending = inspect(fixtures.png, { signal: controller.signal }); controller.abort()
  await assert.rejects(pending, /aborted/)
  await assert.rejects(createIsolatedImageDecoder({ python: fileURLToPath(new URL('./absent-python', import.meta.url)) })(fixtures.png), /runtime-unavailable/)
})
test('OS isolation refuses native allocation above its memory budget', () => {
  const worker = fileURLToPath(new URL('../scripts/image-decoder.py', import.meta.url))
  const code = `import importlib.util,sys
s=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.constrain(128*1024*1024,5000)
try:
 b=bytearray(256*1024*1024)
except MemoryError:
 print('memory-enforced');sys.exit(0)
sys.exit(3)`
  const result = spawnSync(decoderPython, ['-I', '-B', '-c', code, worker], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'memory-enforced')
})
test('real compressed image cannot exceed native decode memory', async () => {
  const bounded = createIsolatedImageDecoder({ python: decoderPython, memoryBytes: 32 * 1024 * 1024 })
  await assert.rejects(bounded(fixtures.large, { maxPixels: 20_000_000 }), /decode-or-resource-limit/)
})
test('OS CPU limit terminates an isolated noncooperative worker', () => {
  const worker = fileURLToPath(new URL('../scripts/image-decoder.py', import.meta.url))
  const code = `import importlib.util,sys
s=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.constrain(128*1024*1024,1000)
while True: pass`
  const result = spawnSync(decoderPython, ['-I', '-B', '-c', code, worker], { encoding: 'utf8', timeout: 8000, windowsHide: true })
  assert.equal(result.error, undefined, 'OS must terminate before the test harness timeout')
  assert.notEqual(result.status, 0)
})
