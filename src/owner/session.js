/**
 * Ending the owner's session on this device.
 *
 * `POST /api/owner/logout` has existed on the hosted server since the sign-in
 * gate did, with nothing calling it: a twelve-hour session on a borrowed or
 * shared phone ran its full term with no way for the owner to end it (#96).
 * Sessions are stateless signed timestamps, so clearing the cookie is what
 * logout does; a copied cookie stays valid regardless, which is #66 and not
 * this module's to solve.
 *
 * The local server has no sessions and no logout route, and answers 404. That
 * is not a failure here: it means there is nothing to sign out of.
 */
export async function signOut() {
  const response = await fetch('/api/owner/logout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).catch(() => null)
  return { hosted: response !== null && response.status !== 404 }
}
