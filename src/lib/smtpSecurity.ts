/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PORT AND TLS MODE ARE ONE SETTING, NOT TWO                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * SMTP has two mutually exclusive ways of getting a connection encrypted, and
 * which one a server speaks is decided ENTIRELY by the port you dialled:
 *
 *   465        implicit TLS   — the handshake starts before the first byte of
 *                               SMTP. nodemailer calls this `secure: true`.
 *   587 / 25   STARTTLS       — the session opens in the clear and is upgraded
 *                               by the STARTTLS verb. `secure: false`.
 *
 * Offering them as an independent port box and a "Secure" checkbox invites the
 * one combination that cannot work, and the platform shipped with that
 * combination as its DEFAULT: port 587 with the box ticked. Every send then
 * fires a TLS ClientHello at a server waiting to speak plaintext SMTP, the
 * server answers with an ASCII greeting, OpenSSL reads '220 ' as a record
 * header and gives up:
 *
 *   ESOCKET at CONN — "ssl3_get_record: wrong version number"
 *
 * That is what took email out on 2 Sep and left WhatsApp as the only channel
 * carrying verification codes for a month. Nothing validated the pair, nothing
 * tested it, and the failure was swallowed by the caller — so the platform went
 * on telling people to check an inbox that was never going to receive anything.
 *
 * ── WHY THIS RETURNS A SENTENCE RATHER THAN A BOOLEAN ──────────────────────
 * The API and the admin form both need to say the same thing, and what an
 * operator actually needs is not "invalid" but which box to change and why.
 * Returning the prose keeps one wording in one place; `null` means "no
 * objection", which is also the answer for a port we have no opinion about.
 *
 * ── AND WHY THE SENTENCE HAS NO JARGON IN IT ───────────────────────────────
 * The person reading it is an administrator, not a mail engineer. "Implicit
 * TLS fired at a STARTTLS port" is a true description of the fault and a
 * useless instruction: it names neither the box to change nor the direction to
 * change it in, and it reads as a warning about security, which invites
 * exactly the wrong fix — leaving the box ticked "to stay safe" and never
 * sending mail again. So the wording says what to do, in which box, and
 * answers the question that ticking a security box was meant to answer:
 * the connection is still encrypted either way. The mechanics stay in this
 * comment, where they belong.
 */

/** Implicit TLS from the first byte. Anything else on this port is broken. */
const IMPLICIT_TLS_PORTS = [465];

/**
 * Ports that open in the clear and upgrade via STARTTLS.
 *
 * 2525 is not an IANA assignment; it is the port most hosts offer when 587 is
 * blocked upstream, and it behaves as 587 does.
 */
const STARTTLS_PORTS = [587, 25, 2525];

/**
 * The objection to this port/secure pair, or `null` if there is none.
 *
 * Deliberately silent on unrecognised ports: a self-hosted relay may listen
 * anywhere, and refusing a configuration we cannot reason about would be a
 * guess dressed up as a rule.
 */
export function smtpSecurityIssue(port: number, secure: boolean): string | null {
  if (!Number.isFinite(port)) return null;

  if (IMPLICIT_TLS_PORTS.includes(port) && !secure) {
    return `These settings cannot send email. Port ${port} needs “Enforce TLS/SSL connection security” turned ON — please tick that box and save. If you would rather leave it unticked, change the port to 587 instead.`;
  }

  if (STARTTLS_PORTS.includes(port) && secure) {
    return `These settings cannot send email. Port ${port} needs “Enforce TLS/SSL connection security” turned OFF — please untick that box and save. Your email is still sent over a secure, encrypted connection; that box is only for port 465.`;
  }

  return null;
}

/**
 * The `secure` value a port implies, for the form to pre-select as the port is
 * typed. `null` where we have no opinion — leave whatever the operator chose.
 *
 * This is a convenience, not the enforcement: `smtpSecurityIssue` is what the
 * API refuses on, because the form can be bypassed and the checkbox can be
 * changed after the port.
 */
export function smtpSecureForPort(port: number): boolean | null {
  if (IMPLICIT_TLS_PORTS.includes(port)) return true;
  if (STARTTLS_PORTS.includes(port)) return false;
  return null;
}

/**
 * A plain-language explanation of a failure the mail transport reported, or
 * `null` if we do not recognise it.
 *
 * ── WHY TRANSLATE AT ALL ───────────────────────────────────────────────────
 * `smtpSecurityIssue` guards the form, but the same misconfiguration reaches
 * an administrator by a second route: they press "Send test email" and get the
 * transport's own words back. Those words are
 *
 *   140134...:SSL routines:ssl3_get_record:wrong version number
 *
 * which is precise, correct, and tells the person in front of it nothing they
 * can act on. Every one of these strings has exactly one likely cause and one
 * next step, so name them.
 *
 * The raw text is NOT discarded by the caller — it is appended after this
 * sentence. A mail engineer reading a support ticket still needs it; the
 * administrator just should not have to start there.
 */
export function smtpFailureExplanation(raw: string): string | null {
  const e = (raw || '').toLowerCase();

  // The 2 Sep failure exactly: implicit TLS aimed at a STARTTLS port.
  if (e.includes('wrong version number')) {
    return 'The port and the security setting do not match. If the port is 587 or 25, untick “Enforce TLS/SSL connection security”; if it is 465, tick it.';
  }

  // The mirror image: a plaintext greeting expected from a port that only ever
  // speaks TLS, so nothing ever arrives and the socket times out on the hello.
  if (e.includes('greeting never received') || e.includes('etimedout') || e.includes('timed out')) {
    return 'The mail server did not answer. Check the host address and port are correct — and if the port is 465, make sure “Enforce TLS/SSL connection security” is ticked.';
  }

  if (e.includes('eauth') || e.includes('invalid login') || e.includes('535') || e.includes('authentication failed')) {
    return 'The mail server refused the username or password. Re-enter the SMTP password and save. Gmail and most providers need an app password here, not your normal account password.';
  }

  if (e.includes('enotfound') || e.includes('getaddrinfo') || e.includes('eai_again')) {
    return 'The host address could not be found. Check the SMTP host for a typo — it should look like smtp.gmail.com, with no https:// in front of it.';
  }

  if (e.includes('econnrefused')) {
    return 'The mail server refused the connection on that port. Check the port number with your email provider — 587 is the usual one.';
  }

  if (e.includes('self signed') || e.includes('self-signed') || e.includes('certificate')) {
    return 'The mail server’s security certificate could not be verified. Check the host address is the exact one your provider gave you.';
  }

  return null;
}
