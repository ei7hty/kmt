/**
 * How a customer reaches Ken: by text, never through a call control (t63,
 * the user's amendment verbatim: "dont create smaller call option promote
 * texting"). The number stays readable wherever it appears; texting is
 * the only tappable action. One place for the number, the link and the
 * label, so every screen offers the same thing and the opener changes once.
 */
export const SHOP_NUMBER = '(617) 410-8319'

/** The E.164 form the sms: scheme wants. */
const SHOP_SMS_NUMBER = '+16174108319'

/** What the messages app opens with. */
export const TEXT_OPENER = "Hi Ken, I'm looking for tires:"

/**
 * `?body=` is the separator Android and current iOS read. Older iOS builds
 * used `&body=` or `;body=`; on those the link still opens the messages
 * app addressed to the number, with an empty draft. Not testable from a
 * desktop build: the PR says so.
 */
export const TEXT_HREF = `sms:${SHOP_SMS_NUMBER}?body=${encodeURIComponent(TEXT_OPENER)}`

/**
 * The same number with no draft at all, for the places where the customer is
 * not shopping for tires: roadside, a repair, anything urgent. `TEXT_OPENER`
 * says "I'm looking for tires:", which is wrong in front of someone stood on
 * a hard shoulder, and an empty draft is better than a wrong one -- they type
 * what is actually wrong. An urgent opener in Ken's voice would be better
 * than both; that is wording, and wording belongs to growth and marketing,
 * so this stays empty until they write one rather than being guessed here.
 */
export const URGENT_TEXT_HREF = `sms:${SHOP_SMS_NUMBER}`

export const TEXT_LABEL = `Text ${SHOP_NUMBER}`
