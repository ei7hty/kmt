// localStorage-backed store for demo state
// This is the shared state mechanism between customer and owner flows

const STORE_KEY = 'kmt_store'

// Initialize store if it doesn't exist
const initStore = () => {
  try {
    const existing = localStorage.getItem(STORE_KEY)
    if (!existing) {
      const initialStore = {
        requests: [],
        quotes: [],
        version: 1
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(initialStore))
    }
  } catch (error) {
    console.error('Failed to initialize store:', error)
  }
}

/**
 * Get the entire store
 */
export function getStore() {
  try {
    initStore()
    const data = localStorage.getItem(STORE_KEY)
    return data ? JSON.parse(data) : { requests: [], quotes: [], version: 1 }
  } catch (error) {
    console.error('Failed to read store:', error)
    return { requests: [], quotes: [], version: 1 }
  }
}

/**
 * Save a customer request
 */
export function saveRequest(requestData) {
  try {
    const store = getStore()
    const request = {
      id: `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...requestData,
      createdAt: new Date().toISOString(),
      status: 'submitted'
    }
    store.requests.push(request)
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
    console.log('Request saved:', request.id)
    return request
  } catch (error) {
    console.error('Failed to save request:', error)
    return null
  }
}

/**
 * Get all requests
 */
export function getAllRequests() {
  try {
    const store = getStore()
    return store.requests || []
  } catch (error) {
    console.error('Failed to get requests:', error)
    return []
  }
}

/**
 * Get a specific request by ID
 */
export function getRequestById(id) {
  try {
    const store = getStore()
    return store.requests.find(req => req.id === id)
  } catch (error) {
    console.error('Failed to get request:', error)
    return null
  }
}

/**
 * Save a draft quote linked to a request
 */
export function saveQuote(requestId, quoteData) {
  try {
    const store = getStore()
    const quote = {
      id: `quote-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      requestId,
      ...quoteData,
      createdAt: new Date().toISOString(),
      status: 'draft'
    }
    store.quotes.push(quote)
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
    console.log('Quote saved:', quote.id)
    return quote
  } catch (error) {
    console.error('Failed to save quote:', error)
    return null
  }
}

/**
 * Get all quotes
 */
export function getAllQuotes() {
  try {
    const store = getStore()
    return store.quotes || []
  } catch (error) {
    console.error('Failed to get quotes:', error)
    return []
  }
}

/**
 * Get quotes for a specific request
 */
export function getQuotesByRequestId(requestId) {
  try {
    const store = getStore()
    return (store.quotes || []).filter(quote => quote.requestId === requestId)
  } catch (error) {
    console.error('Failed to get quotes:', error)
    return []
  }
}

/**
 * Update quote status
 */
export function updateQuoteStatus(quoteId, status) {
  try {
    const store = getStore()
    const quote = store.quotes.find(q => q.id === quoteId)
    if (quote) {
      quote.status = status
      quote.updatedAt = new Date().toISOString()
      localStorage.setItem(STORE_KEY, JSON.stringify(store))
      console.log('Quote updated:', quoteId, 'status:', status)
      return quote
    }
    return null
  } catch (error) {
    console.error('Failed to update quote:', error)
    return null
  }
}

/**
 * Clear all data (for testing)
 */
export function clearStore() {
  try {
    localStorage.removeItem(STORE_KEY)
    console.log('Store cleared')
  } catch (error) {
    console.error('Failed to clear store:', error)
  }
}

// Initialize on module load
initStore()
