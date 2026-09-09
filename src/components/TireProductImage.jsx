import { useState } from 'react'
import { catalogImageIdentity, catalogImagePath } from '../catalog-image.js'

function TireProductImageSlot({ imagePath, tireName }) {
  const [failedPath, setFailedPath] = useState('')
  const showImage = Boolean(imagePath) && failedPath !== imagePath
  return <span className="tire-media" data-image-state={showImage ? 'image' : 'fallback'}>
    {showImage
      ? <img src={imagePath} alt={`${tireName} tire`} loading="lazy" decoding="async" onError={() => setFailedPath(imagePath)} />
      : <span className="tire-art" aria-hidden="true" />}
  </span>
}

/** Fixed-size image slot with the original generic tire art as its fallback. */
export default function TireProductImage({ tire }) {
  const imagePath = catalogImagePath(tire.imageUrl)
  return <TireProductImageSlot key={catalogImageIdentity(tire)} imagePath={imagePath} tireName={tire.name} />
}
