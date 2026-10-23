/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PROFILE PHOTO BYTES — what we accept, and what we say they are         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The browser shrinks the picture to ~256px before it is sent, so a legitimate
 * upload is a few tens of KB. This is the server-side half: it does not trust
 * the shrink, the `Content-Type`, or the file name. The type is decided by the
 * MAGIC BYTES alone, and only raster formats are allowed — no SVG, which can
 * carry script and would be served from our own origin.
 */

/** Upper bound on the decoded image. Generous against a ~60 KB typical upload. */
export const MAX_AVATAR_BYTES = 200 * 1024;

export type AvatarType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The type the bytes really are, or null when they are not an allowed image. */
export function sniffAvatarType(bytes: Uint8Array): AvatarType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * The URL the app uses for a person's photo. `version` is the row's
 * `updated_at`, so a new upload busts the browser cache that `GET` allows.
 */
export function avatarUrl(userId: string, updatedAt: Date | string | number): string {
  return `/api/account/avatar/${userId}?v=${new Date(updatedAt).getTime()}`;
}
