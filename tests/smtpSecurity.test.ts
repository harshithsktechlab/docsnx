/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PORT AND THE TLS MODE ARE ONE SETTING                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * On 2 Sep the SMTP settings were re-entered after a database rebuild, taking
 * the form's defaults: port 587 with "Enforce TLS/SSL" ticked. That is implicit
 * TLS fired at a STARTTLS port — the server answers the ClientHello with an
 * ASCII '220' greeting, OpenSSL reads it as a record header, and every send
 * since died with:
 *
 *   ESOCKET at CONN — "ssl3_get_record: wrong version number"
 *
 * Nothing validated the pair, nothing tested it, and the caller discarded the
 * mailer's failure — so verification codes, password resets and plan notices
 * stopped for a month while the platform went on telling people to check their
 * email. These assertions are the validation that was missing.
 */
import { describe, it, expect } from 'vitest';
import { smtpSecurityIssue, smtpSecureForPort, smtpFailureExplanation } from '@/lib/smtpSecurity';

describe('the combination that cannot connect is refused', () => {
  it('rejects 587 with implicit TLS — the configuration that took email out', async () => {
    const issue = smtpSecurityIssue(587, true);

    expect(issue).toBeTruthy();
    // The operator has to be told WHICH box to change, and in which direction.
    // "Invalid" would leave them changing the port, the host, or the password
    // at random.
    expect(issue).toContain('Enforce TLS/SSL connection security');
    expect(issue).toMatch(/untick/i);
    // And that unticking it is not a downgrade — otherwise the safe-sounding
    // choice is to leave it ticked and go on sending nothing.
    expect(issue).toMatch(/encrypted/i);
  });

  it('rejects 25 and 2525 the same way', () => {
    expect(smtpSecurityIssue(25, true)).toBeTruthy();
    expect(smtpSecurityIssue(2525, true)).toBeTruthy();
  });

  it('rejects 465 WITHOUT TLS — the mirror-image mistake', () => {
    const issue = smtpSecurityIssue(465, false);

    expect(issue).toBeTruthy();
    expect(issue).toContain('465');
    expect(issue).toMatch(/tick/i);
  });

  it('says all of it without jargon', () => {
    // The reader is an administrator, not a mail engineer. A message naming the
    // protocol tells them what is wrong and not what to do about it — and the
    // whole point of these strings is that they are the instruction.
    const jargon = /STARTTLS|implicit TLS|handshake|ClientHello|ssl3_get_record|ESOCKET/i;

    for (const [port, secure] of [[587, true], [25, true], [2525, true], [465, false]] as const) {
      expect(smtpSecurityIssue(port, secure)).not.toMatch(jargon);
    }
  });
});

describe('the working combinations pass', () => {
  it('accepts 587 with STARTTLS', () => {
    expect(smtpSecurityIssue(587, false)).toBeNull();
  });

  it('accepts 465 with implicit TLS', () => {
    expect(smtpSecurityIssue(465, true)).toBeNull();
  });

  it('has no opinion about an unrecognised port', () => {
    // A self-hosted relay may listen anywhere. Refusing a configuration we
    // cannot reason about would be a guess dressed up as a rule.
    expect(smtpSecurityIssue(2065, true)).toBeNull();
    expect(smtpSecurityIssue(2065, false)).toBeNull();
  });

  it('has no opinion about a port that is not a number', () => {
    // An empty port box parses to NaN. The zod schema refuses that separately;
    // this must not produce a second, confusing message on the way there.
    expect(smtpSecurityIssue(Number.NaN, true)).toBeNull();
  });
});

describe('the form can pre-select the mode from the port', () => {
  it('pairs each well-known port with its own mode', () => {
    expect(smtpSecureForPort(465)).toBe(true);
    expect(smtpSecureForPort(587)).toBe(false);
    expect(smtpSecureForPort(25)).toBe(false);
  });

  it('leaves an unknown port alone', () => {
    // null means "keep whatever the operator chose", not "untick it".
    expect(smtpSecureForPort(2065)).toBeNull();
  });

  it('never suggests a pairing its own validator would reject', () => {
    for (const port of [465, 587, 25, 2525]) {
      const implied = smtpSecureForPort(port);
      expect(implied).not.toBeNull();
      expect(smtpSecurityIssue(port, implied as boolean)).toBeNull();
    }
  });
});

describe('a failure the transport reports is translated before it is shown', () => {
  it('names the port/TLS mismatch behind "wrong version number"', () => {
    // The exact string the Test button returned for a month. On its own it sent
    // an operator looking at the host, the password and the firewall — every
    // field except the one checkbox that was wrong.
    const hint = smtpFailureExplanation(
      '140134...:error:SSL routines:ssl3_get_record:wrong version number',
    );

    expect(hint).toBeTruthy();
    expect(hint).toMatch(/untick/i);
    expect(hint).toContain('587');
    expect(hint).toContain('465');
  });

  it('names the likely cause of the other common failures', () => {
    expect(smtpFailureExplanation('Invalid login: 535 Authentication failed')).toMatch(/password/i);
    expect(smtpFailureExplanation('getaddrinfo ENOTFOUND smtp.example.com')).toMatch(/host/i);
    expect(smtpFailureExplanation('connect ECONNREFUSED 1.2.3.4:587')).toMatch(/port/i);
    expect(smtpFailureExplanation('Greeting never received')).toMatch(/465/);
  });

  it('stays quiet about an error it does not recognise', () => {
    // null means the caller quotes the transport verbatim, as it did before.
    // Guessing at an unknown fault would send someone to change a correct
    // setting, which is worse than showing them a string to paste into a ticket.
    expect(smtpFailureExplanation('something nobody has seen before')).toBeNull();
    expect(smtpFailureExplanation('')).toBeNull();
  });
});
