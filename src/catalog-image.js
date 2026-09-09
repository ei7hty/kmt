const CATALOG_IMAGE_PATH = /^\/api\/images\/[a-f0-9]{64}\.(?:jpeg|png)$/

/** Keep catalog rows on the single backend-owned public image route. */
export function catalogImagePath(value) {
  return typeof value === 'string' && CATALOG_IMAGE_PATH.test(value) ? value : ''
}

/** A tire's image slot changes identity even when its approved image is removed. */
export function catalogImageIdentity(tire) {
  return `${tire?.id ?? ''}:${catalogImagePath(tire?.imageUrl)}`
}
