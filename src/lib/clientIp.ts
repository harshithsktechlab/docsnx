/** Max length of a textual IP address (IPv6 with an embedded IPv4). */
const MAX_IP_LENGTH = 45;

/**
 * Resolve the originating client IP.
 *
 * Behind Cloudflare -> nginx, `x-forwarded-for` arrives as a chain
 * ("<client>, <cf-edge>"), so the raw header is neither a valid IP nor
 * guaranteed to fit the varchar(45) columns we store it in.
 */
export function getClientIp(req: Request): string {
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp.slice(0, MAX_IP_LENGTH);

  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first.slice(0, MAX_IP_LENGTH);

  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp.slice(0, MAX_IP_LENGTH);

  return 'unknown';
}
