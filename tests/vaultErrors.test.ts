import { describe, it, expect, vi } from 'vitest';

/**
 * The vault's error contract and the Drive helpers that feed it.
 *
 * The vault hard-fails by design — no server-side cache, no write queue — so
 * when Drive is unreachable a precise error IS the entire recovery story. Two
 * classifications matter most and are easy to get wrong, because Drive answers
 * both with HTTP 403: "your Drive is full" (the user must free space) versus
 * "you revoked us" (the user must reconnect).
 *
 * `DRIVE_NOT_CONNECTED` must stay HTTP 400: existing clients already branch on
 * that shape via driveReauthResponse and notConnected().
 */

vi.mock('@/lib/db', () => ({
  db: { query: {} },
  withTenant: async (_tenantId: string, cb: any) => cb({}),
}));

const { VaultError, toVaultError, vaultErrorBody } = await import('@/lib/vault/vaultErrors');
type VaultErrorCode = Parameters<typeof vaultErrorBody>[0]['code'];
const { escapeDriveQueryValue, isRateLimitError, withDriveRetry, isQuotaError } = await import(
  '@/lib/googleDrive'
);
const { TenantKeyError } = await import('@/lib/tenantCrypto');

/** Shapes a GaxiosError the way googleapis actually reports one. */
function driveError(status: number, reasons: string[] = [], message = 'drive failure') {
  return {
    message,
    response: { status, data: { error: { errors: reasons.map((reason) => ({ reason })) } } },
  };
}

/** The token endpoint reports failures as a bare string, not an errors array. */
function oauthError(error: string) {
  return { message: error, response: { status: 400, data: { error } } };
}

describe('status and retryability', () => {
  it('keeps DRIVE_NOT_CONNECTED at 400 for back-compat', () => {
    const error = new VaultError('DRIVE_NOT_CONNECTED');
    expect(error.httpStatus).toBe(400);
    expect(error.retryable).toBe(false);
  });

  it('marks only genuinely transient failures retryable', () => {
    expect(new VaultError('DRIVE_UNAVAILABLE').retryable).toBe(true);
    expect(new VaultError('VAULT_LOCKED').retryable).toBe(true);

    expect(new VaultError('DRIVE_QUOTA_EXCEEDED').retryable).toBe(false);
    expect(new VaultError('VAULT_FILE_MISSING').retryable).toBe(false);
    expect(new VaultError('VAULT_STALE_FILE').retryable).toBe(false);
    expect(new VaultError('VAULT_KEY_UNAVAILABLE').retryable).toBe(false);
  });

  it('maps each code to the status its meaning implies', () => {
    expect(new VaultError('DRIVE_UNAVAILABLE').httpStatus).toBe(503);
    expect(new VaultError('DRIVE_QUOTA_EXCEEDED').httpStatus).toBe(507);
    expect(new VaultError('VAULT_LOCKED').httpStatus).toBe(409);
    expect(new VaultError('VAULT_KEY_UNAVAILABLE').httpStatus).toBe(500);
    // 428 Precondition Required: the client must unlock before retrying.
    expect(new VaultError('VAULT_LOCKED_CLIENT').httpStatus).toBe(428);
  });
});

describe('classification', () => {
  it('distinguishes a full Drive from a revoked grant — both arrive as 403', () => {
    expect(toVaultError(driveError(403, ['storageQuotaExceeded'])).code).toBe(
      'DRIVE_QUOTA_EXCEEDED'
    );
    expect(toVaultError(oauthError('invalid_grant')).code).toBe('DRIVE_NOT_CONNECTED');
    expect(toVaultError(driveError(403, ['insufficientPermissions'])).code).toBe(
      'DRIVE_NOT_CONNECTED'
    );
  });

  it('treats a missing file as missing, not as a transient failure', () => {
    expect(toVaultError(driveError(404)).code).toBe('VAULT_FILE_MISSING');
    expect(toVaultError(driveError(410)).code).toBe('VAULT_FILE_MISSING');
  });

  it('treats rate limits and 5xx as retryable', () => {
    expect(toVaultError(driveError(429, ['userRateLimitExceeded'])).code).toBe('DRIVE_UNAVAILABLE');
    expect(toVaultError(driveError(500)).code).toBe('DRIVE_UNAVAILABLE');
    expect(toVaultError(driveError(503)).code).toBe('DRIVE_UNAVAILABLE');
  });

  it('treats socket failures as retryable', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(toVaultError({ code }).code).toBe('DRIVE_UNAVAILABLE');
    }
  });

  it('carries a key failure through with its own code', () => {
    const keyError = new TenantKeyError('VAULT_KEY_UNAVAILABLE', 'bad secret');
    expect(toVaultError(keyError).code).toBe('VAULT_KEY_UNAVAILABLE');

    const decryptError = new TenantKeyError('VAULT_DECRYPT_FAILED', 'bad tag');
    expect(toVaultError(decryptError).code).toBe('VAULT_DECRYPT_FAILED');
  });

  it('passes an existing VaultError through unchanged', () => {
    const original = new VaultError('VAULT_LOCKED', 'held elsewhere');
    expect(toVaultError(original)).toBe(original);
  });
});

describe('response body', () => {
  it('tells the client what to do next when the grant is gone', () => {
    const body = vaultErrorBody(new VaultError('DRIVE_NOT_CONNECTED'));
    expect(body).toMatchObject({
      success: false,
      status: 'DRIVE_NOT_CONNECTED',
      retryable: false,
      reconnectUrl: '/settings?connect=google',
    });
  });

  it('never leaks operator detail to the client', () => {
    // `detail` can name tenants, categories and Drive file ids.
    const error = new VaultError('VAULT_FILE_MISSING', 'tenant 1234 category identity.pan_card');
    const body = vaultErrorBody(error);
    expect(JSON.stringify(body)).not.toContain('1234');
    expect(JSON.stringify(body)).not.toContain('identity.pan_card');
  });

  it('offers no reconnect link for failures reconnecting cannot fix', () => {
    expect(vaultErrorBody(new VaultError('DRIVE_QUOTA_EXCEEDED')).reconnectUrl).toBeUndefined();
  });

  it('sends the sentence under `error` as well as `message`, for every code', () => {
    // Every form in this app reads `json.error` and falls back to a generic
    // line. Sending only `message` is why a tenant whose Drive grant carried no
    // file permission saw "Could not save this record" and nothing else — the
    // precise sentence existed and was discarded at the last step.
    const codes: VaultErrorCode[] = [
      'DRIVE_NOT_CONNECTED', 'DRIVE_UNAVAILABLE', 'DRIVE_QUOTA_EXCEEDED',
      'VAULT_FILE_MISSING', 'VAULT_STALE_FILE', 'VAULT_LOCKED',
      'VAULT_KEY_UNAVAILABLE', 'VAULT_DECRYPT_FAILED', 'VAULT_LOCKED_CLIENT',
    ];

    for (const code of codes) {
      const body = vaultErrorBody(new VaultError(code));
      expect(body.message, code).toBeTruthy();
      expect(body.error, code).toBe(body.message);
    }
  });
});

describe('Drive query escaping', () => {
  it('neutralises the quote that would end the literal early', () => {
    // Drive has no parameter binding — an apostrophe in a name would otherwise
    // change what the query means.
    expect(escapeDriveQueryValue("Rahul's Documents")).toBe("Rahul\\'s Documents");
    expect(escapeDriveQueryValue('back\\slash')).toBe('back\\\\slash');
    expect(escapeDriveQueryValue('identity.pan_card')).toBe('identity.pan_card');
  });
});

describe('rate-limit classification', () => {
  it('does not confuse a full Drive with a rate limit', () => {
    const full = driveError(403, ['storageQuotaExceeded']);
    expect(isQuotaError(full)).toBe(true);
    expect(isRateLimitError(full)).toBe(false);
  });

  it('recognises both of Drive’s rate-limit reasons', () => {
    expect(isRateLimitError(driveError(403, ['rateLimitExceeded']))).toBe(true);
    expect(isRateLimitError(driveError(403, ['userRateLimitExceeded']))).toBe(true);
    expect(isRateLimitError(driveError(429))).toBe(true);
  });
});

describe('withDriveRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withDriveRetry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit and succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw driveError(429, ['userRateLimitExceeded']);
      return 'ok';
    });

    expect(await withDriveRetry(fn, { baseDelayMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a revoked grant — it would fail identically and delay the fix', async () => {
    const fn = vi.fn(async () => {
      throw oauthError('invalid_grant');
    });
    await expect(withDriveRetry(fn, { baseDelayMs: 1 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a full Drive', async () => {
    const fn = vi.fn(async () => {
      throw driveError(403, ['storageQuotaExceeded']);
    });
    await expect(withDriveRetry(fn, { baseDelayMs: 1 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a missing file', async () => {
    const fn = vi.fn(async () => {
      throw driveError(404);
    });
    await expect(withDriveRetry(fn, { baseDelayMs: 1 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw driveError(503);
    });
    await expect(withDriveRetry(fn, { tries: 3, baseDelayMs: 1 })).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
