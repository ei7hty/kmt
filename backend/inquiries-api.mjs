import { InputError } from './inventory.mjs'
import { cleanCustomerPhone } from './quotes.mjs'
import { PUBLIC_BODY_LIMIT, clientIp, refuse } from './limits.mjs'
import { readJsonBody } from './api.mjs'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const cleanText = (value, field, max, required = true) => {
  if ((value == null || value === '') && !required) return null
  if (typeof value !== 'string') throw new InputError(`${field} must be text.`)
  const result = value.trim()
  if (required && !result) throw new InputError(field === 'message' ? 'Say what you need.' : `${field === 'name' ? 'A name' : 'Contact'} is required.`)
  if (!result) return null
  if (result.length > max) throw new InputError(`${field} must be ${max} characters or fewer.`)
  return result
}
export function cleanInquiry(input) {
  const rawContact = cleanText(input?.contact, 'contact', 254)
  let contact
  if (EMAIL.test(rawContact)) contact = rawContact.toLowerCase()
  else { try { contact = cleanCustomerPhone(rawContact) } catch { throw new InputError('Enter a valid email address or US phone number.') } }
  return { name: cleanText(input?.name, 'name', 200), contact, vehicleInfo: cleanText(input?.vehicleInfo, 'vehicleInfo', 200, false), message: cleanText(input?.message, 'message', 1000) }
}
export function createInquiriesApi(inquiries, { limiter = null } = {}) {
  const over = (response, rule, id, message) => {
    if (!limiter) return false
    const taken = limiter.take(rule, id)
    if (taken.allowed) return false
    refuse(response, taken.retryAfterSeconds, message); return true
  }
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== '/api/inquiries') return false
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)) }
    try {
      if (request.method !== 'POST') throw new InputError('Inquiry endpoint not found.', 404)
      if (over(response, 'publicPerIp', clientIp(request), 'Too many requests from this connection. Wait a few minutes and try again.')) return true
      const inquiry = cleanInquiry(await readJsonBody(request, PUBLIC_BODY_LIMIT))
      if (over(response, 'inquiriesPerContact', inquiry.contact, 'That contact has sent too many inquiries today. Text me instead.')) return true
      send(201, { id: inquiries.create(inquiry).id }); return true
    } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Could not send your message. Nothing was changed.' }); return true }
  }
}
