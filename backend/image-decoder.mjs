import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DECODER_VERSION = '12.3.0'
const worker = fileURLToPath(new URL('../scripts/image-decoder.py', import.meta.url))
const failure = state => Object.assign(new Error(`Isolated image decoder refused: ${state}`), { state })
function limit(value, cap) {
  if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw failure('invalid-budget')
  return value
}

/** No shell, inherited secrets, user Python modules, or in-process native codec. */
export function createIsolatedImageDecoder({ python, memoryBytes = 256 * 1024 * 1024 } = {}) {
  if (typeof python !== 'string' || !isAbsolute(python)) throw failure('runtime-required')
  limit(memoryBytes, 512 * 1024 * 1024)
  return async (input, { maxPixels = 16_000_000, maxFrames = 1, maxDecodeMs = 5000, signal } = {}) => {
    limit(maxPixels, 100_000_000); limit(maxFrames, 1); limit(maxDecodeMs, 30_000)
    if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > 5 * 1024 * 1024) throw failure('input-size')
    signal?.throwIfAborted()
    const bytes = Buffer.from(input)
    const env = {}
    for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name]
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-I', '-B', '-u', worker, String(memoryBytes), String(maxPixels), String(maxFrames), String(maxDecodeMs)], {
        windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = '', stderrBytes = 0, reason
      const stop = state => { reason ??= state; child.kill('SIGKILL') }
      const abort = () => stop('aborted')
      const timer = setTimeout(() => stop('deadline'), maxDecodeMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout.on('data', chunk => {
        if (output.length + chunk.length > 4096) stop('output-limit')
        else output += chunk.toString('utf8')
      })
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 4096) stop('output-limit') })
      child.stdin.on('error', () => {})
      child.on('error', () => { reason = 'runtime-unavailable' })
      // Wait for close even after timeout: a killed decoder must not outlive completion.
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        if (reason || code !== 0) return reject(failure(reason ?? 'decode-or-resource-limit'))
        try {
          const result = JSON.parse(output)
          if (result.decoder !== DECODER_VERSION || !['windows-job', 'posix-rlimit'].includes(result.isolation) ||
              !['png', 'jpeg'].includes(result.format) || result.frames !== 1 ||
              result.validation !== (result.format === 'jpeg' ? 'simplejpeg-1.9.0-strict' : 'png-zlib-complete-v1') ||
              !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) ||
              result.width < 1 || result.height < 1 || result.width * result.height > maxPixels) throw failure('invalid-result')
          resolve(Object.freeze(result))
        } catch { reject(failure('invalid-result')) }
      })
      child.stdin.end(bytes)
    })
  }
}
