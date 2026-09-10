import { sha256Bytes } from './image-assets.mjs'

const TYPES = new Set(['run-start', 'candidate-start', 'redirect', 'connect', 'response', 'decoded', 'commit-intent', 'commit-result', 'candidate-failure', 'run-end', 'run-interrupted'])
const failure = () => new Error('Private image provenance integrity failure')

/** Dedicated staging DB only. Events are durable before dependent side effects.
 * Triggers prohibit app updates/deletes; hash chaining detects edits/reordering.
 * This is not WORM storage against a privileged operator who can replace the DB.
 */
export function createImageRunProvenance(db, { runId, profileDigest, snapshotDigest }) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || ![profileDigest, snapshotDigest].every(x => /^[a-f0-9]{64}$/.test(x))) throw failure()
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_run_events (
      seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, type TEXT NOT NULL,
      payload TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
    );
    CREATE TRIGGER IF NOT EXISTS image_events_no_update BEFORE UPDATE ON image_run_events
      BEGIN SELECT RAISE(ABORT, 'append-only provenance'); END;
    CREATE TRIGGER IF NOT EXISTS image_events_no_delete BEFORE DELETE ON image_run_events
      BEGIN SELECT RAISE(ABORT, 'append-only provenance'); END;
  `)
  const append = (type, fields = {}) => {
    if (!TYPES.has(type)) throw failure()
    // No raw Error objects, storage locators or local filesystem paths accepted.
    // `sourceSnapshotDigest` records that the staged snapshot was DERIVED from
    // another one, and from which. Every payload already carries
    // `snapshotDigest` -- the bytes that were actually verified and fetched
    // under -- but a packet's own snapshot is version 2 and staging takes
    // version 1, so those are different digests for the same acquisition. With
    // only the staged digest recorded, an auditor holding the packet has to
    // infer the middle step, and inference is what this log exists to remove.
    const allowed = new Set(['candidateId', 'supplierId', 'supplierSku', 'revision', 'sourceUrl', 'originalUrl', 'finalUrl', 'redirectUrl', 'address', 'status', 'sha256', 'format', 'width', 'height', 'bytes', 'outcome', 'policy', 'selected', 'decoder', 'isolation', 'validation', 'sourceSnapshotDigest'])
    if (!fields || Object.keys(fields).some(key => !allowed.has(key))) throw failure()
    const payload = JSON.stringify({ at: new Date().toISOString(), profileDigest, snapshotDigest, ...fields })
    if (Buffer.byteLength(payload) > 32768) throw failure()
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = db.prepare('SELECT seq, hash FROM image_run_events ORDER BY seq DESC LIMIT 1').get()
      const seq = (previous?.seq ?? 0) + 1, previousHash = previous?.hash ?? '0'.repeat(64)
      const hash = sha256Bytes(JSON.stringify([seq, runId, type, payload, previousHash]))
      db.prepare('INSERT INTO image_run_events VALUES (?, ?, ?, ?, ?, ?)').run(seq, runId, type, payload, previousHash, hash)
      db.exec('COMMIT')
      return hash
    } catch { try { db.exec('ROLLBACK') } catch { /* already rolled back */ } throw failure() }
  }
  return Object.freeze({ append })
}

export function verifyImageRunProvenance(db) {
  let previous = '0'.repeat(64), seq = 0
  const events = db.prepare('SELECT * FROM image_run_events ORDER BY seq').all()
  for (const event of events) {
    if (event.seq !== ++seq || event.previous_hash !== previous ||
        sha256Bytes(JSON.stringify([event.seq, event.run_id, event.type, event.payload, previous])) !== event.hash) throw failure()
    previous = event.hash
  }
  return Object.freeze({ events: seq, terminalHash: previous, complete: events.at(-1)?.type === 'run-end' })
}
