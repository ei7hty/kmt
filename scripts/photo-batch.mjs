#!/usr/bin/env node
/**
 * One batch of product photos, end to end, without retyping a digest.
 *
 *   node scripts/photo-batch.mjs --models-file ABS_LIST --work ABS_WORK_DIR [--count 100] [--seed N]
 *
 * WHAT IT DOES, and deliberately what it does NOT.
 *
 * It runs the three local, reversible steps in order and threads their outputs
 * into each other:
 *
 *   1. build-image-mapping   catalogue list      -> mapping.json
 *   2. scrape-tires          mapping             -> packet (product metadata)
 *   3. unwrap-staged-images  staging containers  -> raw images + bindings
 *   4. seal-image-packet     packet + bindings   -> manifest.json + a digest
 *
 * Step 2's fetch and the image download in between are the owner's to run --
 * they contact a supplier's servers, and the whole design is that a person
 * decides when that happens. So this prints those commands and stops, rather
 * than issuing them.
 *
 * It also does NOT upload to the production machine or import. Those are the
 * two irreversible steps: one puts files on the live volume, the other writes
 * the live database. They are printed, with the digest already filled in,
 * because the digest is the thing that gets mistyped.
 *
 * WHY THIS EXISTS. Done by hand, one batch is about fifteen commands carrying
 * three directories and a sha256 between them. Measured 2026-09-12: the first
 * real batch took four live runs against the supplier and one production round
 * trip, and two of those were a mistyped path and a digest from the wrong
 * packet. At ~14 batches to cover the catalogue, that is 200 chances to paste
 * the wrong value.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv) {
  const options = { modelsFile: null, work: null, count: 100, seed: null, snapshot: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => argv[++i]
    if (arg === '--models-file') options.modelsFile = value()
    else if (arg === '--work') options.work = value()
    else if (arg === '--count') options.count = Number(value())
    else if (arg === '--seed') options.seed = Number(value())
    else if (arg === '--snapshot') options.snapshot = value()
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.modelsFile || !options.work) throw new Error('--models-file and --work are required')
  for (const [label, value] of [['--models-file', options.modelsFile], ['--work', options.work]]) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  }
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--count must be a positive integer')
  // A seed is required for reproducible selection; default to the date so a
  // batch run twice on one day selects the same pages, and two different days
  // do not silently collide.
  if (options.seed === null) options.seed = Number(new Date().toISOString().slice(0, 10).replaceAll('-', ''))
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer')
  return options
}

const run = (script, args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

export function describeNextSteps({ packet, staging, digest, work }) {
  return [
    '',
    '─'.repeat(72),
    'LOCAL STEPS DONE. The three that touch somebody else or something live are yours:',
    '',
    '1. FETCH PRODUCT PAGES  (contacts the supplier, ~2-5s per page, a browser opens)',
    `   node scripts/scrape-tires.mjs --validate-products --validation-count <n> \\`,
    `     --validation-seed <seed> --validation-input ${path.join(work, 'mapping.json')} \\`,
    `     --validation-output ${packet} --allow-partial`,
    '',
    '2. DOWNLOAD THE IMAGES  (contacts the supplier again; confirm the hosts it prints)',
    `   node scripts/import-product-images.mjs ${packet} ${staging} \\`,
    `     --confirm-hosts <hosts from ${path.join(packet, 'profile.json')}> \\`,
    `     --python <absolute path to decoder.local/Scripts/python.exe>`,
    '',
    '3. PUT IT ON THE SERVER  (writes the live volume, then the live database)',
    '   flyctl ssh console --app kmt --command "mkdir -p /tmp/kmt-batch"',
    `   cd ${packet}; Get-ChildItem | ForEach-Object { flyctl ssh sftp put $_.FullName "/tmp/kmt-batch/$($_.Name)" --app kmt }`,
    '   flyctl ssh console --app kmt --command "node /app/scripts/import-images.mjs /data/owner.sqlite /tmp/kmt-batch \\',
    `     ${digest ?? '<manifest digest>'}"`,
    '   flyctl ssh console --app kmt --command "chown -R node:node /data/catalog-images-private"',
    '',
    '   The chown is not optional. `flyctl ssh console` logs in as root, so the',
    '   import creates root-owned storage at mode 0700 and the app, which runs as',
    '   `node`, then reports every image as "missing or corrupt". That cost an hour',
    '   on 2026-09-12 and the error names the images rather than the permissions.',
    '',
    '4. APPROVE in the owner screen. Nothing reaches a customer until you do.',
    '─'.repeat(72),
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    mkdirSync(options.work, { recursive: true })
    const mapping = path.join(options.work, 'mapping.json')
    const packet = path.join(options.work, 'packet')
    const staging = path.join(options.work, 'staging')
    const unwrapped = path.join(options.work, 'images')

    if (!existsSync(mapping)) {
      console.log(`[1/4] mapping  -> ${mapping}`)
      run('build-image-mapping.mjs', ['--models-file', options.modelsFile, '--out', mapping,
        ...(options.snapshot ? ['--snapshot', options.snapshot] : [])])
    } else {
      console.log(`[1/4] mapping  -> ${mapping} (already present, left alone)`)
    }

    if (!existsSync(path.join(packet, 'snapshot.json'))) {
      console.log(`[2/4] packet   -> not built yet; step 1 below fetches it`)
      console.log(describeNextSteps({ packet, staging, digest: null, work: options.work }))
      process.exit(0)
    }

    if (!existsSync(path.join(staging, 'images'))) {
      console.log('[3/4] images   -> not downloaded yet; step 2 below fetches them')
      console.log(describeNextSteps({ packet, staging, digest: null, work: options.work }))
      process.exit(0)
    }

    console.log(`[3/4] unwrap   -> ${unwrapped}`)
    run('unwrap-staged-images.mjs', [staging, packet, unwrapped])

    console.log('[4/4] seal     -> manifest.json')
    const sealed = JSON.parse(run('seal-image-packet.mjs', [packet, path.join(unwrapped, 'bindings.json')]))
    console.log(`      digest: ${sealed.manifestDigest}  (${sealed.count} images)`)
    console.log(describeNextSteps({ packet, staging, digest: sealed.manifestDigest, work: options.work }))
  } catch (error) {
    console.error('Batch refused.')
    console.error(`  reason: ${error?.message ?? error}`)
    if (error?.stdout) console.error(`  output: ${String(error.stdout).trim().split('\n').slice(-3).join('\n          ')}`)
    process.exitCode = 1
  }
}
