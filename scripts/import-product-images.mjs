#!/usr/bin/env node
/**
 * Acquire the product images for a pilot packet, from the owner's own machine.
 *
 *   node scripts/import-product-images.mjs ABS_PACKET_DIR ABS_STAGING_DIR --confirm-hosts a.example,b.example
 *
 * WHY THIS IS A COMMAND AND NEVER A ROUTE. The owner's ruling, verbatim:
 * *"its okAY if fetch happens from my local network i just dont want to do it
 * on the server."* So this runs where he runs it, and nothing a web request can
 * reach may call it.
 *
 * BEING PRECISE ABOUT WHAT ENFORCES THAT, because a comfortable summary here
 * would be the thing that eventually breaks it. This file EXPORTS SIX NAMES,
 * and one of them -- `importProductImages` -- does reach the network. So the
 * guarantee is NOT "nothing here is importable":
 *
 *   - Importing this module executes nothing: the entry point at the bottom is
 *     guarded on `process.argv[1]` matching this file.
 *   - `importProductImages` needs an ABSOLUTE private directory that
 *     `privateDirectory` will accept -- no symlink in any ancestor, and no
 *     `public`, `dist`, `data`, `deploy` or `production` segment -- plus a
 *     packet on disk and its hosts confirmed on the command line. The server
 *     process has none of that.
 *   - AND NOTHING UNDER `backend/` IMPORTS THIS FILE. That last one is the
 *     load-bearing one and it is a fact about the rest of the tree rather than
 *     about this file, so it is asserted in `backend/image-import-cli.test.mjs`
 *     rather than trusted. If you add an export here, that test is what tells
 *     you whether it stayed out of the server.
 *
 * WHAT WAS MISSING, AND WHY THIS FILE IS SHORT. Everything else exists.
 * `runApprovedImageStaging` fetches over the real transport, `mirrorRemoteImages`
 * paces and validates, `createSafeImageFetcher` enforces hosts, ports, redirect
 * budgets and resolved addresses, the decoder runs isolated, provenance is hash
 * chained, and the owner approves in his own screen. Nothing called it. A
 * pipeline complete except for its first caller stores nothing, so the Product
 * photos screen has been empty since it shipped -- honestly empty, which is the
 * one thing about it that was right.
 *
 * THE ONE PIECE OF REAL WORK: the packet's snapshot is version 2 and staging
 * takes version 1. See `deriveStagingSnapshot`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Bytes } from '../backend/image-assets.mjs'
import { compileImageProviderProfile } from '../backend/image-provider-profile.mjs'
import { runApprovedImageStaging } from '../backend/image-staging-coordinator.mjs'
import { readPrivateImageInput } from './import-images.mjs'

/** Nothing about a refusal says which check refused. The packet is private and so is the reason. */
const refused = () => new Error('Local image acquisition refused')

const MAX_PACKET_FILE_BYTES = 65536

/**
 * The five fields a staging candidate is, in the order they are written.
 *
 * `collectImagePilot` already emits exactly these and no others, and
 * `planFrom` requires exactly these and no others, so the conversion below is
 * not a lossy squeeze -- it is the same five values in a different envelope.
 */
const V1_CANDIDATE_FIELDS = Object.freeze(['supplierId', 'supplierSku', 'productUrl', 'originalUrl', 'revision'])

const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

/**
 * The packet's snapshot is v2; staging takes v1. This is the conversion.
 *
 * `planFrom` matches its key set EXACTLY and requires `version === 1`, so a v2
 * snapshot -- which carries `provenance` and `enrichedRows` besides -- is
 * refused on its extra keys before the version is even read. That strictness is
 * not incidental: the digest check downstream compares against the exact bytes
 * handed over, and it is the property the whole approval gate rests on. So the
 * validator stays narrow and the caller converts.
 *
 * CONSTRUCTED, NOT COPIED, and that is the difference between deterministic and
 * canonical. Passing the parsed candidate objects through would inherit the
 * INPUT's key order -- `JSON.parse` preserves textual order and `stringify`
 * emits insertion order -- so two semantically identical packets written with
 * their keys in a different sequence would derive different v1 bytes and
 * therefore different digests. Building each candidate field by field in a
 * fixed order makes the output a function of the packet's MEANING rather than
 * its layout, and it means an unexpected sixth key cannot ride along silently.
 *
 * Both digests come back so the caller can record the link: the v2 the owner's
 * packet carries, and the v1 that was actually staged. Nothing here infers one
 * from the other, and neither should a person reading the provenance later.
 */
export function deriveStagingSnapshot(snapshotBytes) {
  if (!(snapshotBytes instanceof Uint8Array) || !snapshotBytes.length) throw refused()
  const source = decode(snapshotBytes)
  if (!source || source.version !== 2 || !Array.isArray(source.candidates) || !source.candidates.length) throw refused()
  const candidates = source.candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object') throw refused()
    const built = {}
    for (const field of V1_CANDIDATE_FIELDS) {
      const value = candidate[field]
      if (typeof value !== 'string' || !value.length) throw refused()
      built[field] = value
    }
    return built
  })
  const bytes = Buffer.from(JSON.stringify({ version: 1, candidates }))
  return Object.freeze({
    bytes,
    digest: sha256Bytes(bytes),
    sourceDigest: sha256Bytes(Buffer.from(snapshotBytes)),
    count: candidates.length,
  })
}

/**
 * Every host the run may contact has to be typed out by the person running it.
 *
 * `docs/approved-product-images.md`: *"Review exact product/image hosts; no
 * wildcard or guessed CDN is used."* The profile already carries the reviewed
 * list, and `createSafeImageFetcher` already enforces it -- so this adds no
 * security the transport lacks. What it adds is that the review HAPPENED: a
 * profile can be regenerated by a script, and a host list nobody read is a
 * wildcard with extra steps. Typing them is the review.
 */
export function assertReviewedHosts(allowedHosts, confirmed) {
  const declared = [...allowedHosts].map(host => host.toLowerCase()).sort()
  const given = [...new Set((confirmed ?? []).map(host => String(host).trim().toLowerCase()).filter(Boolean))].sort()
  const same = declared.length === given.length && declared.every((host, index) => host === given[index])
  if (!same) {
    const error = new Error('The hosts you confirmed are not the hosts this packet would contact.')
    error.declared = declared
    error.given = given
    throw error
  }
  return declared
}

/**
 * Read the two private files a packet directory has to carry.
 *
 * `readPrivateImageInput` is reused rather than reimplemented: it refuses
 * symlinks anywhere in the path, refuses anything that is not a regular file,
 * and re-stats the open descriptor to catch a swap between the check and the
 * read.
 */
export function readPacketInputs(packetDirectory) {
  if (typeof packetDirectory !== 'string' || !path.isAbsolute(packetDirectory)) throw refused()
  const snapshotBytes = readPrivateImageInput(path.join(packetDirectory, 'snapshot.json'), MAX_PACKET_FILE_BYTES)
  const profileBytes = readPrivateImageInput(path.join(packetDirectory, 'profile.json'), MAX_PACKET_FILE_BYTES)
  return { snapshotBytes, profileBytes, rawProfile: decode(profileBytes) }
}

/**
 * Run one acquisition.
 *
 * `run` is injectable for one reason: the tests drive this whole path through
 * `runOfflineImageStagingFixtures`, whose mode refuses any host that is not
 * `.test` and takes bytes from a Map. No test in this repository may contact a
 * real host, and the owner is the only one who ever points this at one.
 */
export async function importProductImages({
  packetDirectory, stagingDirectory, confirmHosts, python, signal,
}, { run = runApprovedImageStaging, fixtures } = {}) {
  if (typeof stagingDirectory !== 'string' || !path.isAbsolute(stagingDirectory)) throw refused()
  const { snapshotBytes, rawProfile } = readPacketInputs(packetDirectory)
  const profile = compileImageProviderProfile(rawProfile)
  const hosts = assertReviewedHosts(profile.allowedHosts, confirmHosts)
  const derived = deriveStagingSnapshot(snapshotBytes)

  const result = await run({
    profile: rawProfile,
    snapshotBytes: derived.bytes,
    expectedSnapshotDigest: derived.digest,
    sourceSnapshotDigest: derived.sourceDigest,
    directory: stagingDirectory,
    python,
    signal,
    ...(fixtures ? { fixtures } : {}),
  })

  return Object.freeze({
    ...result,
    hosts,
    // The link an auditor would otherwise have to infer: what the packet
    // carries, what was staged, and that a conversion sits between them.
    approvedSnapshotDigest: derived.sourceDigest,
    stagedSnapshotDigest: derived.digest,
    snapshotConverted: true,
    candidates: derived.count,
  })
}

/** `--confirm-hosts a,b` or `--confirm-hosts=a,b`, plus the two positionals. */
export function parseArguments(argv) {
  const positional = [], hosts = []
  let python
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--confirm-hosts') hosts.push(...String(argv[++index] ?? '').split(','))
    else if (argument.startsWith('--confirm-hosts=')) hosts.push(...argument.slice('--confirm-hosts='.length).split(','))
    else if (argument === '--python') python = argv[++index]
    else if (argument.startsWith('--python=')) python = argument.slice('--python='.length)
    else positional.push(argument)
  }
  const [packetDirectory, stagingDirectory, ...extra] = positional
  if (!packetDirectory || !stagingDirectory || extra.length) throw new Error('Unexpected arguments')
  return { packetDirectory, stagingDirectory, confirmHosts: hosts.filter(Boolean), python }
}

/**
 * What the owner is told, and the one case that must never read as a retry.
 *
 * `REFUSAL_MARKERS` in `scripts/image-provider.mjs` already detects a challenge
 * or CAPTCHA page and stops the run. When that happens the answer is to tell
 * him and stop -- never a browser transport, never a spoofed user agent, never
 * a stealth plugin. The existing scraper deliberately has no stealth: *"if the
 * site decides to turn this away, it should be able to."* A run that was turned
 * away is a finding about the host, not a problem to route around.
 */
export function describeRun(result) {
  const lines = [
    `run ${result.runId}`,
    `  packet snapshot   ${result.approvedSnapshotDigest}`,
    `  staged snapshot   ${result.stagedSnapshotDigest} (converted from the packet's v2)`,
    `  profile           ${result.profileDigest}`,
    `  hosts             ${result.hosts.join(', ')}`,
    `  candidates        ${result.selected} selected, ${result.attempted} attempted`,
    `  stored            ${result.stored} (${result.deduped} already held, ${result.failed} failed)`,
    `  provenance        ${result.integrity.events} events, complete: ${result.integrity.complete}`,
  ]
  if (result.stoppedOnRefusal) {
    lines.push(
      '',
      'THE HOST TURNED THIS RUN AWAY. It answered with a challenge or a refusal page rather than',
      'an image, and the run stopped at that point rather than trying again. That is the correct',
      'outcome and it is not a bug to route around: do not retry in a loop, and nobody should',
      'reach for a browser transport or a different user agent to get past it. Tell whoever owns',
      'this pipeline what you saw. Anything already stored above is real and stays.',
    )
  }
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  try {
    const options = parseArguments(process.argv.slice(2))
    const result = await importProductImages({
      ...options,
      python: options.python ?? process.env.KMT_IMAGE_DECODER_PYTHON,
      signal: controller.signal,
    })
    console.log(describeRun(result))
    if (result.stoppedOnRefusal) process.exitCode = 1
  } catch (error) {
    if (error.declared) {
      // The one refusal that says what it wanted, because the person running
      // this is the person who reviews the hosts and cannot act on a silence.
      console.error('Local image acquisition refused: confirm the hosts this packet will contact.')
      console.error(`  the packet's reviewed hosts: ${error.declared.join(', ')}`)
      console.error(`  you confirmed:               ${error.given.join(', ') || '(none)'}`)
      console.error('  re-run with --confirm-hosts ' + error.declared.join(','))
    } else {
      console.error('Local image acquisition refused. Use: node scripts/import-product-images.mjs ABS_PACKET_DIR ABS_STAGING_DIR --confirm-hosts host,host')
      console.error('Inspect the private staging directory named by any run id above; no network fallback is available.')
    }
    process.exitCode = 1
  }
}
