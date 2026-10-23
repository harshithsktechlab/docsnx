/**
 * Browser calls for a person who belongs to more than one tenant (0082):
 * switching between them, answering an invitation, and opening an account of
 * their own. Each returns the route's body with `success` always present, so a
 * caller branches on the answer rather than catching a thrown parse error.
 */

async function post(url: string, body: unknown): Promise<any> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ...data, success: false, error: data.error || 'Something went wrong. Please try again.' };
    return data;
  } catch {
    return { success: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
}

/** Move this session to another of the person's tenants. */
export function clientSwitchTenant(userId: string): Promise<any> {
  return post('/api/auth/switch-tenant', { userId });
}

/** Accept or decline an invitation to join another tenant. */
export function clientRespondToInvite(userId: string, action: 'accept' | 'decline'): Promise<any> {
  return post('/api/auth/memberships/respond', { userId, action });
}

export interface OwnAccountInput {
  accountType: 'personal' | 'business' | 'both';
  companyName?: string;
  /** Only needed when the person has no email on file. */
  email?: string;
  consentDataProcessing: boolean;
}

/** A member opens an account of their own, under the same sign-in. */
export function clientCreateOwnAccount(input: OwnAccountInput): Promise<any> {
  return post('/api/account/create-personal', input);
}
