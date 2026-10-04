/**
 * How the site's own address is written for people: RallyForAIRights.org. In lower case the name runs together and
 * reads as "rally for air rights". Domains ignore capitals, so this changes only how it is written, never where it
 * goes; the addresses people paste (a connector address) stay as SITE_URL has them. Any other host (a fork, a laptop)
 * is written as it is. Pure, with no imports: the card uses it too.
 */
export const BRAND_HOST = 'RallyForAIRights.org';

/** A host, or an address, written for people: the rally's own domain in its capitals (with or without www), anything else as it is. */
export function displayHost(hostOrUrl: string): string {
  const host = hostOrUrl.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
  return host.replace(/^www\./i, '').toLowerCase() === BRAND_HOST.toLowerCase() ? BRAND_HOST : host;
}

/** An address written for people: the same address, with its host as displayHost writes it. */
export function displayUrl(url: string): string {
  const m = /^([a-z]+:\/\/)([^/?#]+)(.*)$/i.exec(url);
  return m ? `${m[1]}${displayHost(m[2])}${m[3]}` : url;
}
