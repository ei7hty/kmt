import { platformLabel, socialProof } from '../social-proof.js'
import './SocialProof.css'

function SocialProfileLinks({ profiles, compact = false }) {
  return <nav className={compact ? 'social-profile-links social-profile-links-compact' : 'social-profile-links'} aria-label="Ken’s Mobile Tire social profiles">
    {profiles.map(profile => <a href={profile.url} target="_blank" rel="noopener noreferrer" key={profile.platform}>{platformLabel(profile.platform)}<span className="sr-only">, opens in a new tab</span></a>)}
  </nav>
}

/** Marketing-only, empty-safe social proof. No metadata means no reserved space. */
export default function SocialProof({ variant = 'section' }) {
  const { profiles, testimonials } = socialProof()
  if (!profiles.length && !testimonials.length) return null
  if (variant === 'compact') {
    if (!profiles.length) return null
    return <section className="social-proof social-proof-compact" aria-labelledby="social-proof-compact-heading">
      <div className="social-proof-heading"><p className="eyebrow">STAY CONNECTED</p><h2 id="social-proof-compact-heading">Follow Ken&apos;s Mobile Tire</h2><p className="social-proof-note">Find Ken&apos;s Mobile Tire on these verified social profiles.</p></div>
      <SocialProfileLinks profiles={profiles} compact />
    </section>
  }
  if (variant === 'footer') {
    if (!profiles.length) return null
    return <div className="social-proof-footer"><p>Follow Ken&apos;s Mobile Tire</p><SocialProfileLinks profiles={profiles} compact /></div>
  }
  const hasTestimonials = testimonials.length > 0
  if (!hasTestimonials) return null
  return <section className="social-proof" aria-labelledby="social-proof-heading">
    <div className="social-proof-heading"><p className="eyebrow">{hasTestimonials ? 'FROM KEN’S MOBILE TIRE' : 'STAY CONNECTED'}</p><h2 id="social-proof-heading">{hasTestimonials ? 'Real words from real customers' : 'Follow Ken’s Mobile Tire'}</h2>{!hasTestimonials && <p className="social-proof-note">Find Ken&apos;s Mobile Tire on these verified social profiles.</p>}</div>
    {testimonials.length > 0 && <div className="social-proof-grid">{testimonials.map(item => <figure className="social-proof-card" key={item.id}><blockquote>“{item.text}”</blockquote><figcaption><strong>{item.attribution}</strong>{item.source && <span>{item.source}</span>}{item.date && <time dateTime={item.date}>{item.date}</time>}{item.kind === 'external-review' && item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">View source<span className="sr-only">, opens in a new tab</span></a>}</figcaption></figure>)}</div>}
    {profiles.length > 0 && <SocialProfileLinks profiles={profiles} />}
  </section>
}
