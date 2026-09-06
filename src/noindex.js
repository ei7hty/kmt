import { useEffect } from 'react'

/**
 * Ask search engines not to list the screen that calls this.
 *
 * public/robots.txt tells a crawler not to look at /owner, /status and
 * /confirmation; this is the other half, for a page a crawler already found
 * through a link: a `<meta name="robots" content="noindex">` in the head for
 * as long as the screen is mounted, removed when the customer navigates
 * back to a public one. The app is a single page, so the tag cannot live in
 * index.html without hiding the home page too.
 *
 * Client-side, so it reaches crawlers that render JavaScript, which is the
 * kind that would index a rendered React screen in the first place.
 */
export function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex'
    document.head.appendChild(meta)
    return () => { meta.remove() }
  }, [])
}
