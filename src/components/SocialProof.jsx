import { platformLabel, socialProof } from '../social-proof.js'
import './SocialProof.css'

/** Marketing-only, empty-safe social proof. No metadata means no reserved space. */
export default function SocialProof() {
  const { profiles, testimonials } = socialProof()
  if (!profiles.length && !testimonials.length) return null
  return <section className="social-proof" aria-labelledby="social-proof-heading">
    <div className="social-proof-heading"><p className="eyebrow">FROM KEN&apos;S MOBILE TIRE</p><h2 id="social-proof-heading">Real words from real customers</h2></div>
    {testimonials.length > 0 && <div className="social-proof-grid">{testimonials.map(item => <figure className="social-proof-card" key={item.id}><blockquote>“{item.text}”</blockquote><figcaption><strong>{item.attribution}</strong>{item.source && <span>{item.source}</span>}{item.date && <time dateTime={item.date}>{item.date}</time>}{item.kind === 'external-review' && item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">View source<span className="sr-only">, opens in a new tab</span></a>}</figcaption></figure>)}</div>}
    {profiles.length > 0 && <nav className="social-profile-links" aria-label="Ken’s Mobile Tire social profiles">{profiles.map(profile => <a href={profile.url} target="_blank" rel="noopener noreferrer" key={profile.platform}>{platformLabel(profile.platform)}<span className="sr-only">, opens in a new tab</span></a>)}</nav>}
  </section>
}
