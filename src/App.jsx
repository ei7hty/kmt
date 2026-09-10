import { useEffect, useState } from 'react'
import './App.css'
import './RequestFlow.css'
import { useAnalytics } from './analytics.js'
import OwnerInventory from './owner/OwnerInventory.jsx'
import CustomerRequest from './routes/CustomerRequest.jsx'
import QuoteRequests from './routes/QuoteRequests.jsx'
import Outbox from './routes/Outbox.jsx'
import SiteCopyScreen from './owner/SiteCopy.jsx'
import Status from './routes/Status.jsx'
import Confirmation from './routes/Confirmation.jsx'
import NotFound from './routes/NotFound.jsx'
import Privacy from './routes/Privacy.jsx'
import Inquiry from './routes/Inquiry.jsx'
import OwnerInquiries from './owner/Inquiries.jsx'
import SocialProofScreen from './owner/SocialProof.jsx'
import ImagesScreen from './owner/Images.jsx'

/** The apex domain, and the two routes the sitemap lists under it (t46). */
const CANONICAL_HOST = 'https://kensmobiletire.com'
const CANONICAL_PATHS = new Set(['/', '/privacy'])

/**
 * The pathname as the route switch sees it: trailing slashes dropped, so
 * `/owner/` is `/owner` rather than an unknown path that used to fall through
 * to the customer home (#76). Repeated slashes count as trailing. The root
 * stays `/`.
 */
function normalizePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** Read the current route, and put the normalised form in the address bar if it differs. */
function currentRoute() {
  const route = normalizePath(window.location.pathname)
  if (route !== window.location.pathname) {
    window.history.replaceState(window.history.state, '', route + window.location.search + window.location.hash)
  }
  return route
}

function App() {
  const [route, setRoute] = useState(currentRoute)
  const [ownerVersion, setOwnerVersion] = useState(0)

  useEffect(() => {
    const handlePopState = () => setRoute(currentRoute())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleStorageChange = (event) => {
      if (!event.key || event.key === 'kmt_store') setOwnerVersion(version => version + 1)
    }
    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  // index.html is one static shell served for every route, so it cannot
  // carry two pages' worth of `<link rel="canonical">`. Set it here instead,
  // where the route already lives: the two pages the sitemap lists get their
  // own absolute URL, everything else gets none, since every other route is
  // already excluded from indexing by robots.txt. Google documents this
  // pattern for a page that cannot set the tag in its HTML -- inject it with
  // JavaScript and leave the HTML without one, rather than shipping one tag
  // that would tell a crawler /privacy is really /.
  useEffect(() => {
    let link = document.head.querySelector('link[rel="canonical"]')
    if (!CANONICAL_PATHS.has(route)) {
      if (link) link.remove()
      return
    }
    if (!link) {
      link = document.createElement('link')
      link.rel = 'canonical'
      document.head.appendChild(link)
    }
    link.href = `${CANONICAL_HOST}${route}`
  }, [route])

  useAnalytics(route)

  const navigate = (path) => {
    window.history.pushState({}, '', path)
    setRoute(currentRoute())
  }

  if (route === '/owner') return <OwnerInventory navigate={navigate} />

  if (route === '/owner/quotes') {
    return <QuoteRequests navigate={navigate} ownerVersion={ownerVersion} setOwnerVersion={setOwnerVersion} />
  }

  if (route === '/owner/outbox') return <Outbox navigate={navigate} />

  if (route === '/owner/inquiries') return <OwnerInquiries navigate={navigate} />

  if (route === '/owner/images') return <ImagesScreen navigate={navigate} />

  if (route === '/owner/site-copy') return <SiteCopyScreen navigate={navigate} />

  if (route === '/owner/social-proof') return <SocialProofScreen navigate={navigate} />

  if (route === '/confirmation') {
    return <Confirmation navigate={navigate} />
  }

  if (route === '/status') {
    return <Status navigate={navigate} />
  }

  if (route === '/privacy') return <Privacy navigate={navigate} />
  if (route === '/inquiry') return <Inquiry navigate={navigate} />

  if (route === '/') return <CustomerRequest navigate={navigate} />

  // Anything else is a path the app does not have. It used to render the
  // customer home with no sign that anything was wrong.
  return <NotFound navigate={navigate} path={route} />
}

export default App
