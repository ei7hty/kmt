import { platformLabel, socialProof } from '../social-proof.js'
import './SocialProof.css'

const PLATFORM_BADGES = { facebook: 'f', instagram: 'IG', tiktok: 'TT', youtube: 'YT', x: 'X', linkedin: 'in' }

function SocialProfileLinks({ profiles }) {
  return <nav className="social-profile-links" aria-label="Ken’s Mobile Tire social profiles">
    {profiles.map(profile => {
      const label = platformLabel(profile.platform)
      return <a className={`social-profile-link social-profile-${profile.platform}`} href={profile.url} target="_blank" rel="noopener noreferrer" key={profile.platform}>
        <span className="social-profile-badge" aria-hidden="true">{PLATFORM_BADGES[profile.platform] ?? label.slice(0, 2)}</span>
        <span className="social-profile-label"><strong>{label}</strong><small>Follow Ken on {label}</small></span>
        <span className="social-profile-external" aria-hidden="true">↗</span>
        <span className="sr-only">, opens in a new tab</span>
      </a>
    })}
  </nav>
}

/** Marketing-only, empty-safe social proof. No metadata means no reserved space. */
export default function SocialProof() {
  const { profiles, testimonials } = socialProof()
  if (!profiles.length && !testimonials.length) return null
  const hasTestimonials = testimonials.length > 0
  return <section className="social-proof" aria-labelledby="social-proof-heading" data-testid="social-proof-section">
    <div className="social-proof-heading"><p className="eyebrow">{hasTestimonials ? 'FROM KEN’S MOBILE TIRE' : 'STAY CONNECTED'}</p><h2 id="social-proof-heading">{hasTestimonials ? 'Real words from real customers' : 'Follow Ken’s Mobile Tire'}</h2><p className="social-proof-note">{hasTestimonials ? 'Customer experiences and Ken’s verified social profiles.' : 'Find Ken’s Mobile Tire on these verified social profiles.'}</p></div>
    {testimonials.length > 0 && <div className="social-proof-grid">{testimonials.map(item => <figure className="social-proof-card" key={item.id}><blockquote>“{item.text}”</blockquote><figcaption><strong>{item.attribution}</strong>{item.source && <span>{item.source}</span>}{item.date && <time dateTime={item.date}>{item.date}</time>}{item.kind === 'external-review' && item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">View source<span className="sr-only">, opens in a new tab</span></a>}</figcaption></figure>)}</div>}
    {profiles.length > 0 && <SocialProfileLinks profiles={profiles} />}
  </section>
}
