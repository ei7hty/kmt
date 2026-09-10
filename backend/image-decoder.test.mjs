import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createIsolatedImageDecoder } from './image-decoder.mjs'
import { decoderPython, realImageFixtures, incompletePayloads } from './fixtures/image-provider/decoder-fixtures.mjs'

const fixtures = realImageFixtures()
const inspect = createIsolatedImageDecoder({ python: decoderPython })
for (const format of ['png', 'jpeg']) {
  test(`isolated decoder fully loads real ${format}`, async () => {
    const result = await inspect(fixtures[format])
    assert.equal(result.format, format); assert.equal(result.width, 4); assert.equal(result.height, 3)
    assert.equal(result.frames, 1); assert.equal(result.decoder, '12.3.0')
    assert.equal(result.validation, format === 'jpeg' ? 'simplejpeg-1.9.0-strict' : 'png-zlib-complete-v1')
    assert.equal(result.isolation, process.platform === 'win32' ? 'windows-job' : 'posix-rlimit')
  })
  test(`isolated decoder rejects truncated ${format}`, async () => {
    await assert.rejects(inspect(fixtures[format].subarray(0, -5)))
  })
}
for (const format of ['gif', 'webp']) {
  test(`valid ${format} is conservatively refused pending strict payload validation`, async () => {
    await assert.rejects(inspect(fixtures[format]))
  })
}
for (const format of ['jpeg', 'png', 'gif', 'webp']) {
  test(`preserved-container ${format} payload removals never pass real decoding`, async () => {
    for (const variant of incompletePayloads(fixtures).filter(item => item.format === format)) {
      await assert.rejects(inspect(variant.bytes), `${format}: ${variant.missing} payload bytes removed`)
    }
  })
}
test('strict validators preserve progressive JPEG and PNG bit-depth/color modes', async () => {
  for (const [name, bytes] of Object.entries(fixtures).filter(([name]) => name.startsWith('valid-'))) {
    const result = await inspect(bytes)
    assert.equal(result.width, 4, name); assert.equal(result.height, 3, name)
  }
})
test('complete PNG zlib streams with wrong row size or trailing streams are refused', async () => {
  for (const name of ['png-short-rows', 'png-extra-rows', 'png-extra-stream']) await assert.rejects(inspect(fixtures[name]), name)
})
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
  // The 1000ms passed to constrain() is a Windows Job Object PROCESS_TIME
  // limit -- CPU time actually consumed, not wall-clock elapsed -- and its
  // enforcement is not sub-second on Windows regardless of load: measured
  // standalone (no added contention) at 4.5-7s to kill a worker with a 1s
  // CPU budget, and up to 14s with ~20 CPU-bound processes competing for 12
  // cores (the noncooperative worker needs actual scheduled CPU seconds to
  // reach its 1000ms budget, and contention is what withholds them). GATE
  // ENGINEER caught the previous 8000ms ceiling losing this race by 4ms
  // under nothing worse than Node's own parallel test-file execution --
  // this raises the margin, not the CPU budget, so the assertion below
  // keeps testing exactly what it always has: the OS must still win.
  const result = spawnSync(decoderPython, ['-I', '-B', '-c', code, worker], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.equal(result.error, undefined, 'OS must terminate before the test harness timeout')
  assert.notEqual(result.status, 0)
})
