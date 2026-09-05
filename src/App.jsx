import { useEffect, useState } from 'react'
import './App.css'
import './RequestFlow.css'
import OwnerInventory from './owner/OwnerInventory.jsx'
import CustomerRequest from './routes/CustomerRequest.jsx'
import QuoteRequests from './routes/QuoteRequests.jsx'
import Status from './routes/Status.jsx'
import Confirmation from './routes/Confirmation.jsx'

function App() {
  const [route, setRoute] = useState(() => window.location.pathname)
  const [ownerVersion, setOwnerVersion] = useState(0)

  useEffect(() => {
    const handlePopState = () => setRoute(window.location.pathname)
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

  const navigate = (path) => {
    window.history.pushState({}, '', path)
    setRoute(window.location.pathname)
  }

  if (route === '/owner') return <OwnerInventory navigate={navigate} />

  if (route === '/owner/quotes') {
    return <QuoteRequests navigate={navigate} ownerVersion={ownerVersion} setOwnerVersion={setOwnerVersion} />
  }

  if (route === '/confirmation') {
    return <Confirmation navigate={navigate} />
  }

  if (route === '/status') {
    return <Status navigate={navigate} />
  }

  return <CustomerRequest navigate={navigate} />
}

export default App
