import { useState } from 'react'
import { catalogImagePath } from '../catalog-image.js'

/** Fixed-size image slot with the original generic tire art as its fallback. */
export default function TireProductImage({ tire }) {
  const imagePath = catalogImagePath(tire.imageUrl)
  const [failedPath, setFailedPath] = useState('')
  const showImage = Boolean(imagePath) && failedPath !== imagePath
  return <span className="tire-media" data-image-state={showImage ? 'image' : 'fallback'}>
    {showImage
      ? <img src={imagePath} alt={`${tire.name} tire`} loading="lazy" decoding="async" onLoad={() => setFailedPath('')} onError={() => setFailedPath(imagePath)} />
      : <span className="tire-art" aria-hidden="true" />}
  </span>
}
