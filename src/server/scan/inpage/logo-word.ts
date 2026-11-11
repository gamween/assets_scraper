/**
 * The words that call a picture a logo (spec 8.5), read in lowercase names: class names, ids, labels, and the name of
 * the file. One copy for the collector, which reads the page's names, and post-processing, which reads file names.
 *
 * "brand" only counts at the end of a token (navbar-brand, .brand, header__brand), never as a qualifier inside a
 * compound name, because a page wraps ordinary photos in names like
 * payments-graphic__checkout-item-card-brand-content and every one of them would be filed as a logo.
 *
 * "logout" and "logon" are left out, as in the brand link words: the icon of a log out button is in the header of
 * nearly every web app, and the header, the top of the page and the word were enough to make it the site logo.
 */
export const LOGO_WORD = /logo(?!ut|n(?![a-z]))|wordmark|logotype|brand(?:s|mark)?(?![a-z]|[-_][a-z])/;
