import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SERVER, HOSTED_SERVER, TOUCHES,
  assertLocalServer, buildPlan, parseArgs, photoStage, runPlan, runnableViolations,
  scrapeCommand, sizeWork, summariseSnapshot,
} from './inventory-suite.mjs'

/** A state the plan builder will accept, with everything unblocked by default. */
const stateWith = (over = {}) => ({
  snapshot: summariseSnapshot({
    source: 'giga-tires.com',
    scrapedAt: '2026-09-06T02:28:00.127Z',
    sizes: ['205/65R15', '215/60R16'],
    coverage: {
      '205/65R15': { complete: true, scrapedAt: '2026-09-06T02:28:00.127Z' },
      '215/60R16': { complete: true, scrapedAt: '2026-09-06T02:28:00.127Z' },
    },
    tires: [{ id: 'a' }, { id: 'b' }],
  }),
  server: { reachable: true, supplierCount: 2, offeredCount: 0, importedSizeCount: 0, coverage: [], markupRate: 1.35, markupIsPlaceholder: true, photoCount: 0 },
  photos: photoStage({ work: '/w', mapping: true, packet: false, staging: false }),
  options: { server: DEFAULT_SERVER, snapshot: '/repo/src/data/scraped-tires.json', work: '/w', modelsFile: '/w/models.txt', run: false, help: false },
  ...over,
})

test('a server that is not loopback is refused before any request is built', () => {
  for (const bad of [HOSTED_SERVER, 'https://kmt.fly.dev', 'https://www.giga-tires.com', 'http://192.168.1.9:4180', 'http://127.0.0.2:4180']) {
    assert.throws(() => assertLocalServer(bad), /loopback/, `${bad} must be refused`)
  }
  // hostname is giga-tires.com; the part that LOOKS like loopback is a userinfo
  // field. Refused for carrying credentials at all, before the host is judged.
  assert.throws(() => assertLocalServer('http://127.0.0.1@giga-tires.com/'), /credentials/)
  assert.throws(() => assertLocalServer('file:///etc/passwd'), /http or https/)
  assert.throws(() => assertLocalServer('not a url'), /must be a URL/)
})

test('the loopback forms a person actually types are accepted', () => {
  assert.equal(assertLocalServer('http://127.0.0.1:4180'), 'http://127.0.0.1:4180')
  assert.equal(assertLocalServer('http://localhost:4191/'), 'http://localhost:4191')
  assert.equal(assertLocalServer('http://[::1]:4180'), 'http://[::1]:4180')
  assert.equal(assertLocalServer(DEFAULT_SERVER), DEFAULT_SERVER)
})

test('parseArgs refuses relative paths and unknown options, and answers --help anyway', () => {
  assert.throws(() => parseArgs(['--work', 'relative/dir']), /--work must be an absolute path/)
  assert.throws(() => parseArgs(['--models-file', 'models.txt']), /--models-file must be an absolute path/)
  assert.throws(() => parseArgs(['--nope']), /Unknown option: --nope/)
  assert.throws(() => parseArgs(['--server']), /--server needs a value/)
  // --help is typed BECAUSE the rest of the line is wrong, so it must answer
  // past a refusal the same command line would otherwise earn.
  assert.equal(parseArgs(['--help', '--server', HOSTED_SERVER, '--work', 'relative']).help, true)
})

test('a size is complete only when the scraper recorded reading every page of it', () => {
  const summary = summariseSnapshot({
    scrapedAt: '2026-09-06T00:00:00.000Z',
    sizes: ['a', 'b', 'c'],
    coverage: { a: { complete: true }, b: { complete: false } },
    tires: [{}, {}, {}],
  })
  assert.deepEqual(summary.complete, ['a'])
  // `c` has NO coverage row at all. A snapshot from before that record existed
  // counts as partial, which is what import-tires --complete will decide too.
  assert.deepEqual(summary.partial, ['b', 'c'])
  assert.equal(summary.tireCount, 3)
})

test('a snapshot that is missing or unreadable summarises to nothing rather than throwing', () => {
  const empty = summariseSnapshot(null)
  assert.deepEqual(empty.sizes, [])
  assert.equal(empty.tireCount, 0)
  assert.equal(empty.scrapedAt, null)
})

test('a size imported at the SAME instant as the scrape is not stale', () => {
  // The trap this pins: a database seeded from the snapshot records each size's
  // last_success as the snapshot's own scrapedAt, byte for byte. A `>=` here
  // reports every size of a freshly seeded database as stale and sends the
  // owner to re-run a supplier scrape that would change nothing. Equal is
  // up to date, and only strictly newer is work.
  const same = '2026-09-06T02:28:00.127Z'
  const snapshot = summariseSnapshot({ scrapedAt: same, sizes: ['205/65R15'], coverage: { '205/65R15': { scrapedAt: same } }, tires: [] })
  const work = sizeWork(snapshot, { reachable: true, coverage: [{ size: '205/65R15', last_success: same }] })
  assert.deepEqual(work.stale, [], 'an identical timestamp must not read as behind')
  assert.deepEqual(work.pending, [])
})

test('a size scraped later than it was imported is stale, and one never imported is pending', () => {
  const snapshot = summariseSnapshot({
    scrapedAt: '2026-09-11T00:00:00.000Z',
    sizes: ['fresh', 'same', 'new'],
    coverage: {
      fresh: { scrapedAt: '2026-09-11T00:00:00.000Z' },
      same: { scrapedAt: '2026-09-06T00:00:00.000Z' },
      new: { scrapedAt: '2026-09-11T00:00:00.000Z' },
    },
    tires: [],
  })
  const work = sizeWork(snapshot, {
    reachable: true,
    coverage: [{ size: 'fresh', last_success: '2026-09-06T00:00:00.000Z' }, { size: 'same', last_success: '2026-09-06T00:00:00.000Z' }],
  })
  assert.deepEqual(work.stale, ['fresh'])
  assert.deepEqual(work.pending, ['new'])
  assert.equal(work.known, true)
})

test('an unreadable timestamp reports no work rather than inventing some', () => {
  const snapshot = summariseSnapshot({ scrapedAt: 'whenever', sizes: ['x'], coverage: { x: { scrapedAt: 'whenever' } }, tires: [] })
  assert.deepEqual(sizeWork(snapshot, { reachable: true, coverage: [{ size: 'x', last_success: null }] }).stale, [])
})

test('nothing is claimed about sizes while the server is down', () => {
  const snapshot = summariseSnapshot({ scrapedAt: '2026-09-11T00:00:00.000Z', sizes: ['x'], coverage: {}, tires: [] })
  const work = sizeWork(snapshot, { reachable: false })
  assert.equal(work.known, false)
  assert.deepEqual(work.pending, [])
  assert.deepEqual(work.stale, [])
})

test('a photo work directory reports the stage it has actually reached', () => {
  assert.equal(photoStage({ work: null }).stage, 'unconfigured')
  assert.equal(photoStage({ work: '/w', mapping: false }).stage, 'empty')
  assert.equal(photoStage({ work: '/w', mapping: true, packet: false }).stage, 'mapped')
  assert.equal(photoStage({ work: '/w', mapping: true, packet: true, staging: false }).stage, 'fetched')
  assert.equal(photoStage({ work: '/w', mapping: true, packet: true, staging: true }).stage, 'staged')
})

test('the scrape command never puts an ellipsis where a size belongs', () => {
  const many = Array.from({ length: 14 }, (_, i) => `20${i}/65R15`)
  const lines = scrapeCommand(many)
  const command = lines.find(line => line.includes('scrape-tires.mjs'))
  assert.ok(command, 'there is a command line')
  assert.ok(!/[…]/.test(command), 'an ellipsis inside a pasted command fails as if the scraper rejected a size')
  assert.ok(!command.includes('more'), 'the overflow count belongs in prose, not in the command')
  assert.equal(command.split('scrape-tires.mjs ')[1].split(' --limit')[0].split(' ').length, 6)
  assert.ok(lines.some(line => line.includes('8 further size(s)')), 'the sizes that did not fit are still reported')
  assert.ok(lines.some(line => line.includes('docs/supplier-refresh.md')))
  // A snapshot with no sizes still prints a command that is a valid example.
  assert.match(scrapeCommand([])[0], /scrape-tires\.mjs 215\/60R16 --limit 0 --pages 10/)
})

test('--complete is offered only when every size in the file was read in full', () => {
  const whole = buildPlan(stateWith())
  const importStep = whole.find(step => step.title.startsWith('Import the snapshot'))
  assert.ok(importStep.run.args.includes('--complete'))

  const partial = stateWith({
    snapshot: summariseSnapshot({
      scrapedAt: '2026-09-06T00:00:00.000Z',
      sizes: ['a', 'b'],
      coverage: { a: { complete: true } },
      tires: [],
    }),
  })
  const guarded = buildPlan(partial).find(step => step.title.startsWith('Import the snapshot'))
  assert.ok(!guarded.run.args.includes('--complete'), 'import-tires would refuse it by name; do not offer it')
  assert.match(guarded.why, /refused by name/)
})

test('a step that cannot run yet says why, instead of being attempted or hidden', () => {
  const down = buildPlan(stateWith({ server: { reachable: false, coverage: [] } }))
  for (const step of down.filter(s => s.run && s.run.script === 'import-tires.mjs')) {
    assert.match(step.blocked, /not answering/)
  }
  const caughtUp = buildPlan(stateWith({
    server: {
      reachable: true, supplierCount: 2, offeredCount: 0, importedSizeCount: 2, photoCount: 0,
      coverage: [
        { size: '205/65R15', last_success: '2026-09-06T02:28:00.127Z' },
        { size: '215/60R16', last_success: '2026-09-06T02:28:00.127Z' },
      ],
    },
  }))
  assert.match(caughtUp.find(step => step.title.startsWith('Import the snapshot')).blocked, /Nothing to import/)
  // And the dry run is NOT blocked by being caught up: asking what would change
  // is the thing you do to find out whether you are caught up.
  assert.equal(caughtUp.find(step => step.title.startsWith('Ask the local database')).blocked, null)
})

test('no runnable step in any plan this builds names a supplier, flyctl or a hosted URL', () => {
  const states = [
    stateWith(),
    stateWith({ server: { reachable: false, coverage: [] } }),
    stateWith({ options: { ...stateWith().options, work: null, modelsFile: null } }),
    stateWith({ snapshot: summariseSnapshot(null) }),
  ]
  for (const state of states) {
    const steps = buildPlan(state)
    assert.deepEqual(runnableViolations(steps), [], 'the shipped plan must be clean in every state')
    // Every plan carries the supplier and production steps -- they are PRINTED,
    // not omitted. A plan that dropped them would also pass the line above.
    assert.ok(steps.some(step => step.touches === TOUCHES.SUPPLIER && !step.run))
    assert.ok(steps.some(step => step.touches === TOUCHES.PRODUCTION && !step.run))
    // Asserted on the SCRIPT and the environment variable rather than on a
    // hostname appearing somewhere in a joined string. CodeQL flagged the
    // earlier form as incomplete URL substring sanitization, and it was right
    // that the shape is wrong even though this is a test and sanitizes nothing:
    // `includes('giga-tires.com')` is true of `giga-tires.com.example` and
    // false of `gigatires.com`, so it was never the assertion I meant. What I
    // meant is "the command is still printed", and the command is named by the
    // script it invokes.
    assert.ok(steps.find(step => step.touches === TOUCHES.SUPPLIER).lines.some(line => line.includes('scrape-tires.mjs')),
      'the supplier command is still shown')
    assert.ok(steps.find(step => step.touches === TOUCHES.PRODUCTION).lines.some(line => line.includes('KMT_OWNER_PASSWORD')),
      'the production command is still shown')
  }
})

test('the violation detector fires on the misclassification it exists to catch', () => {
  // The control for the test above: an empty result only means something once
  // the instrument is shown to be able to say otherwise. These are the two
  // shapes a future step could take -- a supplier step made runnable, and a
  // local step that quietly grew a hosted argument.
  const supplierRunnable = [{ n: 1, touches: TOUCHES.SUPPLIER, title: 'scrape', run: { script: 'scrape-tires.mjs', args: ['215/60R16'] } }]
  assert.match(runnableViolations(supplierRunnable)[0], /runnable but touches supplier/)

  const hostedArgument = [{ n: 2, touches: TOUCHES.LOCAL, title: 'import', run: { script: 'import-tires.mjs', args: ['--to', HOSTED_SERVER] } }]
  assert.match(runnableViolations(hostedArgument)[0], /names/)

  const flyctl = [{ n: 3, touches: TOUCHES.LOCAL, title: 'ship', run: { script: 'x.mjs', args: ['flyctl', 'ssh'] } }]
  assert.equal(runnableViolations(flyctl).length, 1)
})

test('the runner refuses a non-local step even when that step CARRIES a command', () => {
  // Mutation testing found this hole and it is the sharpest one in the file.
  // Every non-local step the plan builds today has `run: null`, so a runner
  // that ignored `touches` entirely and keyed only on "is there a command?"
  // passed the whole suite. The guarantee this tool sells is the
  // classification, not the absence of a command, so the poisoned case has to
  // be in the fixture: a supplier step that DOES carry one. If someone later
  // gives a supplier step a `run` -- the exact shape of the mistake worth
  // catching -- this is the test that goes red.
  const executed = []
  const poisoned = [
    { n: 1, touches: TOUCHES.SUPPLIER, title: 'scrape', run: { script: 'scrape-tires.mjs', args: ['215/60R16'] }, blocked: null, lines: [] },
    { n: 2, touches: TOUCHES.PRODUCTION, title: 'ship', run: { script: 'import-tires.mjs', args: ['--to', HOSTED_SERVER] }, blocked: null, lines: [] },
    { n: 3, touches: TOUCHES.OWNER, title: 'price', run: { script: 'anything.mjs', args: [] }, blocked: null, lines: [] },
    { n: 4, touches: TOUCHES.LOCAL, title: 'dry run', run: { script: 'import-tires.mjs', args: ['--dry-run'] }, blocked: null, lines: [] },
  ]
  const outcome = runPlan(poisoned, { execute: step => executed.push(step.script), log: () => {} })
  assert.deepEqual(executed, ['import-tires.mjs'], 'only the LOCAL step ran')
  assert.deepEqual(outcome.ran, [4])
  assert.deepEqual(outcome.yours, [1, 2, 3])
  // And the plan builder is never allowed to produce such a step in the first
  // place: two independent guards, so neither alone is the whole answer.
  assert.equal(runnableViolations(poisoned).length, 3)
})

test('--run executes the local unblocked steps only, in order, and nothing else', () => {
  const executed = []
  const steps = [
    { n: 1, touches: TOUCHES.SUPPLIER, title: 'scrape', run: null, blocked: null, lines: [] },
    { n: 2, touches: TOUCHES.LOCAL, title: 'dry run', run: { script: 'import-tires.mjs', args: ['--dry-run'] }, blocked: null, lines: [] },
    { n: 3, touches: TOUCHES.LOCAL, title: 'import', run: { script: 'import-tires.mjs', args: [] }, blocked: 'nothing to import', lines: [] },
    { n: 4, touches: TOUCHES.OWNER, title: 'price it', run: null, blocked: null, lines: [] },
    { n: 5, touches: TOUCHES.LOCAL, title: 'photos', run: { script: 'photo-batch.mjs', args: [] }, blocked: null, lines: [] },
    { n: 6, touches: TOUCHES.PRODUCTION, title: 'ship', run: null, blocked: null, lines: [] },
  ]
  const outcome = runPlan(steps, { execute: step => executed.push(step.script), log: () => {} })
  assert.deepEqual(executed, ['import-tires.mjs', 'photo-batch.mjs'])
  assert.deepEqual(outcome.ran, [2, 5])
  assert.deepEqual(outcome.yours, [1, 4, 6])
})

test('--run passes OVER a step that is not its own rather than stopping at it', () => {
  // This is the bug running it found: the first draft stopped at the first
  // non-local step, copied from photo-batch.mjs, whose owner-only steps are all
  // at the END of its pipeline. Here step 1 is the supplier scrape -- normally
  // already done -- so stopping there meant the tool ran nothing at all on
  // every ordinary invocation. What is NOT relaxed is which steps execute.
  const executed = []
  const steps = [
    { n: 1, touches: TOUCHES.SUPPLIER, title: 'scrape', run: null, blocked: null, lines: [] },
    { n: 2, touches: TOUCHES.LOCAL, title: 'dry run', run: { script: 'import-tires.mjs', args: [] }, blocked: null, lines: [] },
  ]
  const outcome = runPlan(steps, { execute: step => executed.push(step.script), log: () => {} })
  assert.deepEqual(executed, ['import-tires.mjs'], 'a supplier step first must not silence the whole run')
  assert.deepEqual(outcome.ran, [2])
})

test('the plan is ordered the way the work is actually done', () => {
  const steps = buildPlan(stateWith())
  assert.deepEqual(steps.map(step => step.n), [1, 2, 3, 4, 5, 6])
  assert.equal(steps[0].touches, TOUCHES.SUPPLIER, 'the scrape is the snapshot\'s precondition and comes first')
  assert.equal(steps.at(-1).touches, TOUCHES.PRODUCTION, 'production is last and is never this tool\'s')
  assert.ok(steps.findIndex(s => s.title.startsWith('Ask the local database')) < steps.findIndex(s => s.title.startsWith('Import the snapshot')),
    'the dry run comes before the write')
})
