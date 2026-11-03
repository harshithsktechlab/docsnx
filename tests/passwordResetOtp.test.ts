/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FORGOT PASSWORD — the code itself: channels, cooldown, attempt cap     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `issueResetOtp` and `verifyResetOtp` carry every rule that protects a
 * six-digit code, so they are exercised against a small in-memory stand-in for
 * `password_reset_otps` that really evaluates the where-clauses the code writes
 * (expiry, attempt ceiling, subject). A stub that ignored them would pass a
 * lockout that does not lock.
 *
 * What is pinned:
 *   • WhatsApp first; email when WhatsApp is off, there is no number, or the
 *     send is refused; nothing at all (and no row left behind) when neither lands.
 *   • A second request inside the cooldown sends nothing and keeps the old code.
 *   • A code is single use, expires, and survives exactly five wrong guesses.
 *   • A malformed guess does not spend an attempt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = {
  id: string; subjectId: string; otpHash: string; channel: string;
  expiresAt: Date; attempts: number; lastSentAt: Date; updatedAt?: Date;
};
let rows: Row[] = [];
let seq = 0;

// Column object → the property name on `Row`.
const COLUMN_TO_FIELD: Record<string, keyof Row> = {
  id: 'id', subject_id: 'subjectId', expires_at: 'expiresAt', attempts: 'attempts',
};
const fieldOf = (col: any) => COLUMN_TO_FIELD[col.name] as keyof Row;

// Predicates are plain functions, so the fake can run what the code wrote.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<any>('drizzle-orm');
  return {
    ...actual,
    eq: (col: any, val: any) => (r: Row) => r[fieldOf(col)] === val,
    gt: (col: any, val: any) => (r: Row) => (r[fieldOf(col)] as any) > val,
    lt: (col: any, val: any) => (r: Row) => (r[fieldOf(col)] as any) < val,
    and: (...ps: Array<(r: Row) => boolean>) => (r: Row) => ps.every((p) => p(r)),
    // `${attempts} + 1` is the only sql`` the module writes.
    sql: () => ({ __increment: 1 }),
  };
});

vi.mock('@/lib/db', () => {
  const apply = (set: Record<string, any>, r: Row) => {
    for (const [k, v] of Object.entries(set)) {
      (r as any)[k] = v && v.__increment ? (r as any)[k] + v.__increment : v;
    }
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (p: (r: Row) => boolean) => ({ limit: async () => rows.filter(p).map((r) => ({ ...r })) }),
        }),
      }),
      insert: () => ({
        values: (v: any) => ({
          onConflictDoUpdate: async ({ set }: any) => {
            const existing = rows.find((r) => r.subjectId === v.subjectId);
            if (existing) apply(set, existing);
            else rows.push({ id: `row-${++seq}`, ...v });
          },
        }),
      }),
      update: () => ({
        set: (set: Record<string, any>) => ({
          where: (p: (r: Row) => boolean) => {
            const hit = rows.filter(p);
            hit.forEach((r) => apply(set, r));
            const done: any = Promise.resolve(undefined);
            done.returning = async () => hit.map((r) => ({ ...r }));
            return done;
          },
        }),
      }),
      delete: () => ({
        where: async (p: (r: Row) => boolean) => { rows = rows.filter((r) => !p(r)); },
      }),
    },
  };
});

// An opaque digest, like the real keyed HMAC — a stand-in that embedded the
// plaintext would make "never stores the code" untestable.
vi.mock('@/lib/fieldCrypto', async () => {
  const { createHash } = await import('crypto');
  return { hashToken: (t: string) => createHash('sha256').update(`test-key:${t}`).digest('hex') };
});

let whatsappOn = true;
const sendWhatsAppOtp = vi.fn(async (_phone: any, _otp: string) => ({ success: true }));
vi.mock('@/lib/whatsapp', () => ({
  isWhatsAppEnabled: async () => whatsappOn,
  sendWhatsAppOtp: (p: any, o: string) => sendWhatsAppOtp(p, o),
}));

const sendPasswordResetOtpEmail = vi.fn(async (_e: string, _n: string, _o: string) => ({ success: true }));
vi.mock('@/lib/mailer', () => ({
  sendPasswordResetOtpEmail: (e: string, n: string, o: string) => sendPasswordResetOtpEmail(e, n, o),
}));

let sendAllowed = true;
vi.mock('@/lib/rateLimit', () => ({
  passwordResetSendRateLimiter: { check: () => ({ success: sendAllowed }) },
}));

const { issueResetOtp, verifyResetOtp, RESET_OTP_TTL_MS, RESET_OTP_MAX_ATTEMPTS } =
  await import('@/lib/passwordResetOtp');

const USER = {
  id: 'user-1',
  identityId: 'identity-1',
  email: 'asha@example.test',
  name: 'Asha Menon',
  phoneNumber: '+919876543210',
};

/** The code that went out, read off whichever sender took it. */
const sentCode = (): string =>
  (sendWhatsAppOtp.mock.calls.at(-1)?.[1] ?? sendPasswordResetOtpEmail.mock.calls.at(-1)?.[2]) as string;

beforeEach(() => {
  rows = [];
  seq = 0;
  whatsappOn = true;
  sendAllowed = true;
  sendWhatsAppOtp.mockReset();
  sendWhatsAppOtp.mockResolvedValue({ success: true });
  sendPasswordResetOtpEmail.mockReset();
  sendPasswordResetOtpEmail.mockResolvedValue({ success: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useRealTimers();
});

describe('which channel carries the code', () => {
  it('uses WhatsApp when it is on and the account has a number', async () => {
    const r = await issueResetOtp(USER);
    expect(r).toEqual({ issued: true, channel: 'phone' });
    expect(sendWhatsAppOtp).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppOtp.mock.calls[0][0]).toBe('+919876543210');
    expect(sendPasswordResetOtpEmail).not.toHaveBeenCalled();
    expect(sentCode()).toMatch(/^\d{6}$/);
  });

  it('falls back to email when WhatsApp is switched off', async () => {
    whatsappOn = false;
    const r = await issueResetOtp(USER);
    expect(r).toEqual({ issued: true, channel: 'email' });
    expect(sendWhatsAppOtp).not.toHaveBeenCalled();
    expect(sendPasswordResetOtpEmail).toHaveBeenCalledTimes(1);
  });

  it('falls back to email when the account has no usable number', async () => {
    const r = await issueResetOtp({ ...USER, phoneNumber: null });
    expect(r).toEqual({ issued: true, channel: 'email' });
    expect(sendWhatsAppOtp).not.toHaveBeenCalled();
  });

  it('falls back to email when WhatsApp refuses the send, and records the channel that landed', async () => {
    sendWhatsAppOtp.mockResolvedValue({ success: false });
    const r = await issueResetOtp(USER);
    expect(r).toEqual({ issued: true, channel: 'email' });
    expect(rows[0].channel).toBe('email');
  });

  it('falls back to email when the WhatsApp sender throws', async () => {
    sendWhatsAppOtp.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await issueResetOtp(USER);
    expect(r).toEqual({ issued: true, channel: 'email' });
  });

  it('uses WhatsApp alone for a member with a number and no email', async () => {
    const r = await issueResetOtp({ ...USER, email: null });
    expect(r).toEqual({ issued: true, channel: 'phone' });
  });

  it('sends nothing and leaves no row when the account has no channel at all', async () => {
    const r = await issueResetOtp({ ...USER, email: null, phoneNumber: null });
    expect(r).toEqual({ issued: false });
    expect(rows).toHaveLength(0);
  });

  it('leaves no redeemable row when every channel refuses', async () => {
    sendWhatsAppOtp.mockResolvedValue({ success: false });
    sendPasswordResetOtpEmail.mockResolvedValue({ success: false });
    const r = await issueResetOtp(USER);
    expect(r).toEqual({ issued: false });
    expect(rows).toHaveLength(0);
  });
});

describe('resending', () => {
  it('sends nothing inside the cooldown and keeps the code already issued', async () => {
    await issueResetOtp(USER);
    const first = sentCode();
    sendWhatsAppOtp.mockClear();

    const again = await issueResetOtp(USER);
    expect(again).toEqual({ issued: false });
    expect(sendWhatsAppOtp).not.toHaveBeenCalled();
    expect(await verifyResetOtp(USER, first)).toBe(true);
  });

  it('mints a fresh code after the cooldown, and the old one stops working', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    await issueResetOtp(USER);
    const first = sentCode();

    vi.setSystemTime(new Date('2026-11-03T10:01:30Z'));
    // Force a different draw so "old code stops working" is observable.
    const draw = vi.spyOn(await import('crypto').then((m) => m.default), 'randomInt')
      .mockReturnValue(first === '111111' ? 222222 : 111111);
    const r = await issueResetOtp(USER);
    draw.mockRestore();

    expect(r.issued).toBe(true);
    expect(rows).toHaveLength(1);
    expect(await verifyResetOtp(USER, first)).toBe(false);
    expect(await verifyResetOtp(USER, sentCode())).toBe(true);
  });

  it('stays silent when the per-person hourly cap is spent', async () => {
    sendAllowed = false;
    expect(await issueResetOtp(USER)).toEqual({ issued: false });
    expect(sendWhatsAppOtp).not.toHaveBeenCalled();
  });

  it('keys the row by identity so a person with several seats has one code', async () => {
    await issueResetOtp(USER);
    await issueResetOtp({ ...USER, id: 'user-2' });
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectId).toBe('identity-1');
  });

  it('falls back to the user id for a row with no identity', async () => {
    await issueResetOtp({ ...USER, identityId: null });
    expect(rows[0].subjectId).toBe('user-1');
  });
});

describe('redeeming a code', () => {
  it('accepts the right code once, then never again', async () => {
    await issueResetOtp(USER);
    const code = sentCode();

    expect(await verifyResetOtp(USER, code)).toBe(true);
    expect(rows).toHaveLength(0);
    expect(await verifyResetOtp(USER, code)).toBe(false);
  });

  it('never stores the code itself', async () => {
    await issueResetOtp(USER);
    expect(JSON.stringify(rows)).not.toContain(sentCode());
  });

  it('rejects a wrong code', async () => {
    await issueResetOtp(USER);
    const wrong = sentCode() === '000000' ? '000001' : '000000';
    expect(await verifyResetOtp(USER, wrong)).toBe(false);
  });

  it('locks after five wrong guesses — the right code no longer works', async () => {
    await issueResetOtp(USER);
    const code = sentCode();
    const wrong = code === '000000' ? '000001' : '000000';

    for (let i = 0; i < RESET_OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyResetOtp(USER, wrong)).toBe(false);
    }
    expect(await verifyResetOtp(USER, code)).toBe(false);
  });

  it('still accepts the right code on the fifth try', async () => {
    await issueResetOtp(USER);
    const code = sentCode();
    const wrong = code === '000000' ? '000001' : '000000';

    for (let i = 0; i < RESET_OTP_MAX_ATTEMPTS - 1; i++) await verifyResetOtp(USER, wrong);
    expect(await verifyResetOtp(USER, code)).toBe(true);
  });

  it('a new request zeroes the attempts of the old one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    await issueResetOtp(USER);
    const wrong = sentCode() === '000000' ? '000001' : '000000';
    for (let i = 0; i < RESET_OTP_MAX_ATTEMPTS; i++) await verifyResetOtp(USER, wrong);

    vi.setSystemTime(new Date('2026-11-03T10:02:00Z'));
    await issueResetOtp(USER);
    expect(await verifyResetOtp(USER, sentCode())).toBe(true);
  });

  it('expires after five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    await issueResetOtp(USER);
    const code = sentCode();

    vi.setSystemTime(new Date(Date.now() + RESET_OTP_TTL_MS + 1000));
    expect(await verifyResetOtp(USER, code)).toBe(false);
  });

  it('is five minutes, as the WhatsApp template says', () => {
    expect(RESET_OTP_TTL_MS).toBe(5 * 60 * 1000);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 456', null, undefined, 123456])(
    'rejects the malformed guess %j without spending an attempt',
    async (guess) => {
      await issueResetOtp(USER);
      expect(await verifyResetOtp(USER, guess as any)).toBe(false);
      expect(rows[0].attempts).toBe(0);
    },
  );

  it('rejects when no code was ever issued', async () => {
    expect(await verifyResetOtp(USER, '123456')).toBe(false);
  });
});
