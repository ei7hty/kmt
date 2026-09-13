#!/usr/bin/env node
/**
 * The whole inventory update in one place: what the state actually is, and the
 * exact next commands with the paths already filled in.
 *
 *   node scripts/inventory-suite.mjs [--server URL] [--snapshot ABS] [--work ABS] [--run]
 *
 * WHY THIS EXISTS. Updating KMT's inventory today means knowing six scripts,
 * the order they go in, which of them contact a supplier, which of them write
 * production, and which three directories carry state between them. None of
 * that is written down in one place, so every run starts by reconstructing it
 * from `README.md`, `docs/supplier-refresh.md` and the scripts themselves.
 * Worse, nothing says where the owner currently IS: whether the snapshot on
 * disk is newer than the database, whether a size was ever imported, whether
 * a photo batch is half-built. Those are facts, they are cheap to read, and
 * reading them wrong is what sends someone re-running a supplier scrape they
 * did not need.
 *
 * WHAT IT RUNS, AND WHAT IT REFUSES TO. This is `scripts/photo-batch.mjs`'s
 * separation applied to the whole inventory surface, and it is the point of
 * the file rather than a caveat at the end of it. Every step carries a
 * `touches` classification, and ONLY `local` steps are ever executed:
 *
 *   local       runs here, against the loopback server and this checkout
 *   supplier    contacts giga-tires.com -- PRINTED, never issued
 *   production  writes the live volume or the live database -- PRINTED
 *   owner       a person's judgment (pricing, approving a photo) -- PRINTED
 *
 * That is not a convention held by whoever edits this next. `buildPlan()` is
 * pure and its steps are data, so `scripts/inventory-suite.test.mjs` asserts
 * over the WHOLE plan that no runnable step names a supplier host, `flyctl`,
 * or a non-loopback URL -- a future step misclassified as `local` fails that
 * test rather than quietly acquiring the ability to contact a supplier.
 *
 * `--server` is checked the same way, by `assertLocalServer()`: anything but
 * loopback is refused outright, before any request is built, so this tool
 * cannot be pointed at production even by someone who wants to. The hosted
 * command is printed for the owner instead. Ken's ruling, which both of those
 * implement: *"its okay if fetch happens from my local network i just dont
 * want to do it on the server."*
 *
 * WHAT IT DOES NOT DO. It does not re-implement anything. The photo pipeline
 * is `photo-batch.mjs`'s and is delegated to it whole; the import is
 * `import-tires.mjs`'s; the scrape is `scrape-tires.mjs`'s and is the owner's
 * to run. This file reads state, decides the order, and fills in the paths.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_SNAPSHOT = path.join(ROOT, 'src', 'data', 'scraped-tires.json')
/** `import-tires.mjs`'s own default, so the two tools cannot disagree about which server is "local". */
export const DEFAULT_SERVER = 'http://127.0.0.1:4180'
export const HOSTED_SERVER = 'https://kensmobiletire.com'

/**
 * What a step reaches. `local` is the ONLY value this tool will execute; the
 * other three exist so a step can be printed with an honest reason attached
 * rather than silently omitted from the plan.
 */
export const TOUCHES = Object.freeze({
  LOCAL: 'local',
  SUPPLIER: 'supplier',
  PRODUCTION: 'production',
  OWNER: 'owner',
})

/**
 * Hostnames that mean "this machine". Compared against `URL.hostname`, which
 * is why `http://127.0.0.1@giga-tires.com/` is refused: its hostname is
 * `giga-tires.com`, not the part that looks like loopback to a reader.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Refuse any server that is not loopback, before a single request is built.
 *
 * The failure this prevents is a `--server https://kensmobiletire.com` typed
 * once, which would turn the import step below from "update my own database"
 * into "write production" with no other change to the command. Production
 * writes are Ken's, run by Ken, with the password in his environment and not
 * in a tool's. So this is a refusal rather than a confirmation prompt: there
 * is no answer to the prompt that should let this proceed.
 */
export function assertLocalServer(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`--server must be a URL, and this is not one: ${raw}`)
  }
  if (parsed.username || parsed.password) throw new Error('--server must not carry credentials')
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`--server must be http or https, not ${parsed.protocol}`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `--server must be a loopback address; ${parsed.hostname} is not one.\n` +
      'This tool only ever writes the local database. To push a snapshot to the hosted\n' +
      `server, run import-tires yourself:\n  KMT_OWNER_PASSWORD='...' node scripts/import-tires.mjs --to ${HOSTED_SERVER}`,
    )
  }
  return parsed.origin
}

export function parseArgs(argv) {
  const options = { server: DEFAULT_SERVER, snapshot: DEFAULT_SNAPSHOT, work: null, modelsFile: null, run: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[++i]
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--run') options.run = true
    else if (arg === '--server') options.server = value()
    else if (arg === '--snapshot') options.snapshot = value()
    else if (arg === '--work') options.work = value()
    else if (arg === '--models-file') options.modelsFile = value()
    else throw new Error(`Unknown option: ${arg}. See --help.`)
  }
  // Before the path and server checks: `--help` has to answer even when the
  // rest of the command line is wrong, since being wrong is why someone types it.
  if (options.help) return options
  for (const [label, given] of [['--work', options.work], ['--models-file', options.modelsFile]]) {
    // Same rule photo-batch.mjs enforces, for the same reason: these paths get
    // handed to another process whose cwd is this repository root, so a
    // relative one silently means somewhere the person typing it did not mean.
    if (given !== null && !path.isAbsolute(given)) throw new Error(`${label} must be an absolute path`)
  }
  options.server = assertLocalServer(options.server)
  return options
}

/**
 * What the snapshot on disk actually holds. Pure over the parsed file so the
 * tests can hand it shapes the tracked snapshot does not happen to contain.
 */
export function summariseSnapshot(snapshot) {
  const coverage = snapshot?.coverage && typeof snapshot.coverage === 'object' ? snapshot.coverage : {}
  const sizes = Array.isArray(snapshot?.sizes) ? [...snapshot.sizes] : []
  const scrapedAtBySize = {}
  for (const size of sizes) scrapedAtBySize[size] = coverage[size]?.scrapedAt ?? snapshot?.scrapedAt ?? null
  return {
    source: snapshot?.source ?? null,
    scrapedAt: snapshot?.scrapedAt ?? null,
    tireCount: Array.isArray(snapshot?.tires) ? snapshot.tires.length : 0,
    sizes,
    // A size is only "complete" when the scraper recorded reading every page of
    // it. `import-tires --complete` refuses any other size by name, so this is
    // the same question that command will ask, asked early enough to be useful.
    complete: sizes.filter(size => coverage[size]?.complete === true),
    partial: sizes.filter(size => coverage[size]?.complete !== true),
    scrapedAtBySize,
  }
}

/**
 * Which of the snapshot's sizes the local database has not caught up with.
 *
 * `pending` is never imported at all. `stale` was imported from an OLDER
 * scrape than the file now holds.
 *
 * The comparison is STRICTLY newer, and that is the whole correctness of this
 * function rather than a detail. A database seeded from the snapshot records
 * each size's `last_success` as the snapshot's own `scrapedAt` -- byte for
 * byte the same instant -- so a `>=` here would report every size of a
 * freshly seeded database as stale and send the owner to re-run a supplier
 * scrape that would change nothing. Equal means up to date.
 */
export function sizeWork(snapshotSummary, server) {
  if (!server?.reachable) return { known: false, pending: [], stale: [] }
  const lastSuccessBySize = new Map()
  for (const row of server.coverage ?? []) lastSuccessBySize.set(row?.size, row?.last_success ?? null)
  const pending = [], stale = []
  for (const size of snapshotSummary.sizes) {
    if (!lastSuccessBySize.has(size)) { pending.push(size); continue }
    const imported = Date.parse(lastSuccessBySize.get(size) ?? '')
    const scraped = Date.parse(snapshotSummary.scrapedAtBySize[size] ?? '')
    // An unparseable date on either side leaves both comparisons false, so an
    // unreadable timestamp reports "not stale" rather than inventing work.
    if (scraped > imported) stale.push(size)
  }
  return { known: true, pending, stale }
}

/** Which stage a photo work directory has reached, using photo-batch.mjs's own layout. */
export function photoStage({ work, mapping, packet, staging }) {
  if (!work) return { stage: 'unconfigured', detail: 'no --work directory given' }
  if (!mapping) return { stage: 'empty', detail: 'no mapping.json yet' }
  if (!packet) return { stage: 'mapped', detail: 'mapping.json built; the product pages are not fetched' }
  if (!staging) return { stage: 'fetched', detail: 'packet built; the images are not downloaded' }
  return { stage: 'staged', detail: 'images downloaded; photo-batch can unwrap and seal them' }
}

/** For prose. Never for a command line -- see `scrapeCommand` below. */
const sizeList = sizes => (sizes.length > 6 ? `${sizes.slice(0, 6).join(', ')} and ${sizes.length - 6} more` : sizes.join(', '))

/**
 * The scrape command, and the reason it is built rather than interpolated.
 *
 * An earlier draft printed `sizeList()` straight into this command. With the
 * 4 sizes the tracked snapshot happens to hold that reads fine; with the 14
 * a real batch carries it emits `205/65R15,…` -- an ellipsis inside a command
 * somebody is about to paste, which fails in a way that looks like the
 * scraper rejecting a size rather than like a printing bug. So the command
 * always names whole sizes, and the count that did not fit goes in a sentence
 * next to it where it cannot be pasted by accident.
 */
export function scrapeCommand(sizes) {
  const named = (sizes.length ? sizes : ['215/60R16']).slice(0, 6)
  const lines = [`  node scripts/scrape-tires.mjs ${named.join(' ')} --limit 0 --pages 10`]
  if (sizes.length > named.length) {
    lines.push(`  ${sizes.length - named.length} further size(s) are in the snapshot. docs/supplier-refresh.md has the batch order;`)
    lines.push('  do not paste all of them into one run.')
  }
  return lines
}

/**
 * The ordered plan. PURE -- a function of observed state and nothing else, so
 * the test can build any state it likes and assert over every step.
 *
 * `run` is present only on `local` steps and is what the runner executes;
 * `lines` is what gets printed. A step can be `local` and still carry a
 * `blocked` reason (the server is down, there is nothing to import), in which
 * case it is shown and skipped rather than attempted.
 */
export function buildPlan(state) {
  const { snapshot, server, photos, options } = state
  const work = sizeWork(snapshot, server)
  const behind = [...work.pending, ...work.stale]
  const snapshotArg = options.snapshot
  const steps = []

  steps.push({
    touches: TOUCHES.SUPPLIER,
    title: 'Scrape the supplier into the snapshot',
    why: snapshot.partial.length
      ? `${snapshot.partial.length} of the snapshot's ${snapshot.sizes.length} size(s) were not read in full, so nothing can be retired for them.`
      : `The snapshot's ${snapshot.sizes.length} size(s) were all read in full${snapshot.scrapedAt ? `, on ${snapshot.scrapedAt.slice(0, 10)}` : ''}.`,
    lines: [
      'Yours to run: it opens a browser against giga-tires.com. One window, one page',
      'at a time, from a home connection -- never from a server and never from here.',
      ...scrapeCommand(snapshot.sizes),
    ],
    run: null,
    blocked: null,
  })

  steps.push({
    touches: TOUCHES.LOCAL,
    title: 'Ask the local database what would change',
    why: 'Writes nothing. The server answers with new, changed and unchanged tires per size.',
    lines: [`  node scripts/import-tires.mjs ${snapshotArg} --to ${options.server} --dry-run`],
    run: { script: 'import-tires.mjs', args: [snapshotArg, '--to', options.server, '--dry-run'] },
    blocked: server.reachable ? null : `${options.server} is not answering. Start it with \`node backend/dev.mjs\`.`,
  })

  // `--complete` retires tires the file does not mention, and is only honest
  // when every size being imported was read in full. Offered when the snapshot
  // says so and withheld when it does not, rather than left to be remembered.
  const completeIsHonest = snapshot.sizes.length > 0 && snapshot.partial.length === 0
  steps.push({
    touches: TOUCHES.LOCAL,
    title: 'Import the snapshot into the local database',
    why: completeIsHonest
      ? 'Every size in the file was read in full, so --complete is honest here: tires the file no longer mentions are marked no longer listed, with their offers kept.'
      : 'Without --complete a size is a partial view and nothing is retired. The snapshot does not record every size as read in full, so --complete would be refused by name.',
    lines: [`  node scripts/import-tires.mjs ${snapshotArg} --to ${options.server}${completeIsHonest ? ' --complete' : ''}`],
    run: { script: 'import-tires.mjs', args: [snapshotArg, '--to', options.server, ...(completeIsHonest ? ['--complete'] : [])] },
    blocked: !server.reachable
      ? `${options.server} is not answering. Start it with \`node backend/dev.mjs\`.`
      : work.known && behind.length === 0
        ? 'Nothing to import: every size in the snapshot is already in the database at this scrape or newer.'
        : null,
  })

  steps.push({
    touches: TOUCHES.OWNER,
    title: 'Choose what KMT offers, and price it',
    why: 'Nothing imported above reaches a customer until an offer is enabled. Owner prices are never inferred from supplier prices.',
    lines: [
      `  ${options.server}/owner`,
      server.reachable
        ? `  ${server.offeredCount} of ${server.supplierCount} supplier row(s) are offered today; the markup rule is ${server.markupRate ?? 'unset'}${server.markupIsPlaceholder ? ' (still the placeholder, not your number)' : ''}.`
        : '  (counts unknown while the server is down)',
    ],
    run: null,
    blocked: null,
  })

  steps.push({
    touches: TOUCHES.LOCAL,
    title: 'Build the next photo batch',
    why: `photo-batch.mjs runs the local, reversible half and prints the supplier and production half. This batch: ${photos.detail}.`,
    lines: [
      options.work && options.modelsFile
        ? `  node scripts/photo-batch.mjs --models-file ${options.modelsFile} --work ${options.work}`
        : '  node scripts/photo-batch.mjs --models-file ABS_LIST --work ABS_WORK_DIR',
    ],
    run: options.work && options.modelsFile
      ? { script: 'photo-batch.mjs', args: ['--models-file', options.modelsFile, '--work', options.work] }
      : null,
    blocked: options.work && options.modelsFile ? null : 'Pass --work and --models-file to include the photo batch.',
  })

  steps.push({
    touches: TOUCHES.PRODUCTION,
    title: 'Push the snapshot to the hosted server',
    why: 'The live database. Yours alone -- this tool refuses any server that is not loopback, so it cannot be the thing that does this.',
    lines: [
      `  KMT_OWNER_PASSWORD='...' node scripts/import-tires.mjs ${snapshotArg} --to ${HOSTED_SERVER}${completeIsHonest ? ' --complete' : ''}`,
      '  Then check the live catalog before you call it good:',
      `  curl -s ${HOSTED_SERVER}/api/health`,
    ],
    run: null,
    blocked: null,
  })

  return steps.map((step, i) => ({ n: i + 1, ...step }))
}

/**
 * The scripts a `local` step may invoke. An ALLOW-LIST, and deliberately short.
 *
 * This replaced a deny-list of supplier and production strings, and the
 * replacement is not cosmetic. A deny-list only refuses what somebody thought
 * to name: it would have passed a runnable step invoking
 * `import-product-images.mjs` (contacts the supplier) or `scrape-tires.mjs`
 * with no URL in its arguments at all, because neither names a forbidden
 * string. This refuses everything not listed here, so a script added to
 * `scripts/` next month is refused by default rather than allowed by omission.
 *
 * Adding a name here is the deliberate act of saying "this one runs against
 * loopback and this checkout, and reaches nobody else."
 */
const LOCAL_SCRIPTS = new Set(['import-tires.mjs', 'photo-batch.mjs'])

/**
 * The invariant the plan above is required to hold, stated as code so a step
 * added later cannot quietly break it. Exported because the test asserts it
 * over a plan built from several different states, and because a reader
 * checking "can this thing contact a supplier" should find one function to
 * read rather than six steps to audit.
 *
 * FOUR CHECKS, and the host one uses the SAME IDIOM as `assertLocalServer()`
 * above -- `new URL(...).hostname` against an exact set, never a substring.
 * A test or a lint that checks hosts more loosely than the code it guards is a
 * small lie about what is verified, and the earlier version of this function
 * was exactly that: a substring deny-list that said yes to
 * `giga-tires.com.example` and no to `gigatires.com`. One idiom in the file
 * now, so there is nothing to keep in agreement.
 */
export function runnableViolations(steps) {
  const violations = []
  for (const step of steps) {
    if (!step.run) continue
    if (step.touches !== TOUCHES.LOCAL) {
      violations.push(`step ${step.n} (${step.title}) is runnable but touches ${step.touches}`)
      continue
    }
    if (!LOCAL_SCRIPTS.has(step.run.script)) {
      violations.push(`step ${step.n} (${step.title}) is runnable and invokes ${step.run.script}, which is not on the local allow-list`)
    }
    for (const arg of [step.run.script, ...step.run.args]) {
      if (!/^https?:\/\//i.test(arg)) {
        if (/\bflyctl\b/i.test(arg)) violations.push(`step ${step.n} (${step.title}) is runnable and invokes flyctl`)
        continue
      }
      let hostname
      try {
        hostname = new URL(arg).hostname.replace(/^\[|\]$/g, '')
      } catch {
        violations.push(`step ${step.n} (${step.title}) is runnable and carries an unparseable URL: ${arg}`)
        continue
      }
      if (!LOOPBACK_HOSTS.has(hostname)) {
        violations.push(`step ${step.n} (${step.title}) is runnable and targets ${hostname}, which is not loopback`)
      }
    }
  }
  return violations
}

export function renderStatus(state) {
  const { snapshot, server, photos, options } = state
  const work = sizeWork(snapshot, server)
  const lines = ['', 'KMT INVENTORY SUITE', '─'.repeat(72)]
  lines.push(`SNAPSHOT  ${options.snapshot}`)
  lines.push(snapshot.present === false
    ? '          not on disk -- nothing to import'
    : `          ${snapshot.tireCount} tire(s), ${snapshot.sizes.length} size(s), scraped ${snapshot.scrapedAt ?? 'at an unrecorded time'}`)
  if (snapshot.sizes.length) lines.push(`          read in full: ${snapshot.complete.length}; partial: ${snapshot.partial.length}`)
  lines.push(`SERVER    ${options.server}`)
  lines.push(server.reachable
    ? `          ${server.supplierCount} supplier row(s), ${server.offeredCount} offered, ${server.photoCount ?? '?'} with a photo, ${server.importedSizeCount} size(s) imported`
    : `          not answering (${server.why}). \`node backend/dev.mjs\` starts it.`)
  if (work.known) {
    lines.push(`BEHIND    ${work.pending.length} size(s) never imported${work.pending.length ? `: ${sizeList(work.pending)}` : ''}`)
    lines.push(`          ${work.stale.length} size(s) imported from an older scrape${work.stale.length ? `: ${sizeList(work.stale)}` : ''}`)
  }
  lines.push(`PHOTOS    ${options.work ?? '(no --work directory)'}`)
  lines.push(`          ${photos.stage}: ${photos.detail}`)
  return lines.join('\n')
}

const LABEL = Object.freeze({
  [TOUCHES.LOCAL]: 'LOCAL     ',
  [TOUCHES.SUPPLIER]: 'SUPPLIER  ',
  [TOUCHES.PRODUCTION]: 'PRODUCTION',
  [TOUCHES.OWNER]: 'YOU       ',
})

export function renderPlan(steps) {
  const lines = ['', 'PLAN', '─'.repeat(72)]
  for (const step of steps) {
    lines.push(`${step.n}. [${LABEL[step.touches]}] ${step.title}`)
    lines.push(`   ${step.why}`)
    for (const line of step.lines) lines.push(`   ${line}`)
    if (step.blocked) lines.push(`   SKIPPED: ${step.blocked}`)
    lines.push('')
  }
  lines.push('Only the LOCAL steps are ever run by --run. SUPPLIER, PRODUCTION and YOU steps')
  lines.push('are printed for you to run, which is the whole safety property of this tool.')
  return lines.join('\n')
}

/**
 * Execute the local, unblocked steps in order, passing over every other step
 * with the reason printed.
 *
 * It PASSES OVER rather than STOPS AT, and that is a correction rather than a
 * preference: the first draft stopped at the first non-local step, copying
 * photo-batch.mjs, and running it proved the copy wrong. photo-batch's
 * owner-only steps are all at the END of its pipeline, so stopping there
 * loses nothing. This plan's first step is the supplier scrape, which is the
 * snapshot's precondition and is normally already done -- so "stop at the
 * first step that is not mine" meant this tool ran nothing at all, on every
 * ordinary invocation. Found by running it; no amount of reading the two
 * files side by side would have said so, because the rule is identical and
 * only the step order differs.
 *
 * What is NOT relaxed is which steps execute. A skipped step is printed and
 * passed over; it is never executed, and a genuine dependency (the server is
 * down, there is nothing to import) arrives as `blocked` rather than as order.
 *
 * `execute` is injected so the test can prove WHICH steps would run without
 * spawning anything. That is the assertion that matters here; a test that
 * reasoned about the classification instead would pass against a runner that
 * ignored it.
 */
export function runPlan(steps, { execute, log = console.log }) {
  const ran = [], yours = []
  for (const step of steps) {
    if (step.touches !== TOUCHES.LOCAL) {
      log(`\nStep ${step.n} (${step.title}) is yours: it touches ${step.touches}.`)
      yours.push(step.n)
      continue
    }
    if (step.blocked) {
      log(`\nStep ${step.n} (${step.title}) skipped: ${step.blocked}`)
      continue
    }
    log(`\n[${step.n}] ${step.title}`)
    execute(step.run)
    ran.push(step.n)
  }
  return { ran, yours }
}

/** Read the snapshot without letting a missing or unreadable file end the run. */
export function readSnapshot(file) {
  if (!existsSync(file)) return { present: false, ...summariseSnapshot(null) }
  try {
    return { present: true, ...summariseSnapshot(JSON.parse(readFileSync(file, 'utf8'))), mtime: statSync(file).mtime.toISOString() }
  } catch (error) {
    return { present: false, why: error.message, ...summariseSnapshot(null) }
  }
}

/**
 * Ask the loopback server what it holds. Never throws: a server that is down
 * is the ordinary case here and is a fact to report, not a failure.
 *
 * The one count that needs a second request is the photo count, because the
 * summary does not carry one; `pageSize=1` keeps both responses small.
 */
export async function readServer(base) {
  const get = async query => {
    const response = await fetch(`${base}/api/owner/inventory?${query}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }
  try {
    const payload = await get('pageSize=1')
    const summary = payload.summary ?? {}
    let photoCount = null
    try { photoCount = (await get('filter=photo&pageSize=1')).total } catch { photoCount = null }
    return {
      reachable: true,
      supplierCount: summary.supplierCount ?? payload.total ?? 0,
      offeredCount: summary.offeredCount ?? 0,
      importedSizeCount: summary.importedSizeCount ?? 0,
      coverage: summary.coverage ?? [],
      markupRate: summary.markup?.rate ?? null,
      markupIsPlaceholder: summary.markup?.isPlaceholder ?? false,
      photoCount,
    }
  } catch (error) {
    return { reachable: false, why: error.cause?.code || error.message, coverage: [] }
  }
}

const HELP = `
Read the state of every inventory input and print the ordered plan to move it
forward, with the paths already filled in.

Usage:
  node scripts/inventory-suite.mjs [options]

Options:
  --server URL        The LOCAL owner server (default ${DEFAULT_SERVER}).
                      Anything that is not a loopback address is refused.
  --snapshot PATH     The scrape snapshot (default src/data/scraped-tires.json).
  --work ABS_PATH     A photo batch's working directory.
  --models-file ABS   The model list for that batch.
  --run               Execute the LOCAL steps in order, stopping at the first
                      step that contacts a supplier, writes production, or
                      needs your judgment.
  --help              This message.

Nothing here contacts giga-tires.com, runs flyctl, or writes the hosted
server. Those steps are printed for you to run.
`.trimStart()

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) { console.log(HELP); process.exit(0) }
    const snapshot = readSnapshot(options.snapshot)
    const server = await readServer(options.server)
    const photos = photoStage({
      work: options.work,
      mapping: Boolean(options.work) && existsSync(path.join(options.work, 'mapping.json')),
      packet: Boolean(options.work) && existsSync(path.join(options.work, 'packet', 'snapshot.json')),
      staging: Boolean(options.work) && existsSync(path.join(options.work, 'staging', 'images')),
    })
    const state = { snapshot, server, photos, options }
    const steps = buildPlan(state)

    // Checked at runtime as well as in the test. The test proves the shipped
    // plan is clean; this proves the plan THIS run built is, including for
    // states the test did not think to construct.
    const violations = runnableViolations(steps)
    if (violations.length) {
      console.error('Refusing to continue: the plan built a runnable step it should not have.')
      for (const violation of violations) console.error(`  ${violation}`)
      process.exit(1)
    }

    console.log(renderStatus(state))
    console.log(renderPlan(steps))

    if (options.run) {
      const outcome = runPlan(steps, {
        execute: step => execFileSync(process.execPath, [path.join(ROOT, 'scripts', step.script), ...step.args],
          { cwd: ROOT, stdio: 'inherit' }),
      })
      console.log(`\nRan ${outcome.ran.length} local step(s). ${outcome.yours.length} step(s) are above, and are yours.`)
    }
  } catch (error) {
    console.error('Inventory suite refused.')
    console.error(`  reason: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
