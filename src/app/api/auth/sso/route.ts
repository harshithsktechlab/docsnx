import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { db } from '@/lib/db';
import { users, tenants } from '@/db/schema';
import { signToken } from '@/lib/auth';
import { getDefaultPlan, newTenantPlanValues, recordSignupGrant } from '@/lib/planProvisioning';
import { eq } from 'drizzle-orm';
import { isSignInDisabled, signInDisabledResponse } from '@/lib/account/signInDisabled';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const embedded = searchParams.get('embedded') === 'true';
  
  // Fail closed: a token is a full login (and can provision a SUPER_ADMIN), so
  // with no shared secret configured there is nothing safe to verify against.
  const ssoSecret = process.env.UDYAMNX_JWT_SECRET;
  if (!ssoSecret) {
    return NextResponse.json({ error: 'SSO is not configured' }, { status: 404 });
  }

  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  try {
    const decoded = jwt.verify(token, ssoSecret, { algorithms: ['HS256'] }) as any;
    const email = decoded.email;
    const parentTenantId = decoded.tenantId || decoded.id; 
    const role = decoded.role === 'Tenant' ? 'TENANT_ADMIN' : (decoded.role === 'SuperAdmin' ? 'SUPER_ADMIN' : 'STANDARD');

    if (!email) throw new Error('Invalid token payload');

    let userResult = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.email, email),
      with: { tenant: true }
    });
    
    let user = userResult;

    // The partner's signed token is the credential here, so the reason can be
    // given. `getUserFromRequest` would refuse the session anyway; this stops
    // it being minted at all.
    if (isSignInDisabled(user)) return signInDisabledResponse();

    if (!user) {
      let tenant = await db.query.tenants.findFirst({
        where: (tenants, { eq }) => eq(tenants.id, String(parentTenantId))
      });

      if (!tenant) {
        // Provision onto the default plan so an SSO tenant starts with its
        // plan's AI credits instead of zero.
        //
        // The expiry is deliberately left null (never expires), unlike a normal
        // signup: SSO tenants are provisioned by the partner platform and have
        // never had an expiry, so adopting the plan's 60-day term here would
        // lock out partner users who work today.
        // 'personal' explicitly: this route sets no `account_type`, so the
        // column takes its default, and the plan has to match it.
        const defaultPlan = await getDefaultPlan('personal');
        const tenantInsertResult = await db.insert(tenants).values({
          name: decoded.name || 'UdyamNX Managed Tenant',
          ...newTenantPlanValues(defaultPlan),
          subscriptionExpiry: null
        }).returning();
        tenant = tenantInsertResult[0];
      }

      const userInsertResult = await db.insert(users).values({
        email,
        name: decoded.name || email.split('@')[0],
        passwordHash: 'SSO_MANAGED_PASSWORD',
        role: role,
        tenantId: tenant.id
      }).returning();

      // Opens the credit ledger for a tenant provisioned by the partner
      // platform. Runs after the user insert so the grant can be attributed;
      // a no-op when the plan grants no credits, or when `tenant` already
      // existed (its ledger was opened at its own creation).
      if (tenant.aiCreditsBalance > 0) {
        await recordSignupGrant(db, {
          tenantId: tenant.id,
          amount: tenant.aiCreditsBalance,
          userId: userInsertResult[0].id,
        });
      }
      
      user = {
        ...userInsertResult[0],
        tenant
      } as any;
    }

    const sessionToken = await signToken({ userId: user!.id, role: user!.role });

    const forwardedHost = request.headers.get('x-forwarded-host');
    const forwardedProto = request.headers.get('x-forwarded-proto') || 'http';
    
    let baseUrl;
    if (forwardedHost) {
      baseUrl = `${forwardedProto}://${forwardedHost}`;
    } else {
      const reqUrl = new URL(request.url);
      baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
    }
    
    const redirectParam = searchParams.get('redirect');
    let targetPath = redirectParam || '/dashboard';
    
    if (targetPath.startsWith('/family-os')) {
      targetPath = targetPath.substring('/family-os'.length) || '/dashboard';
    }
    
    const redirectUrl = new URL(targetPath, baseUrl);
    if (embedded) {
      redirectUrl.searchParams.set('embedded', 'true');
    }
    const redirectTarget = redirectUrl.toString();
    
    const response = NextResponse.redirect(redirectTarget);
    
    response.cookies.set({
      name: 'auth_token',
      value: sessionToken,
      httpOnly: true,
      path: '/',
      secure: process.env.NODE_ENV === 'production' && (request.url.startsWith('https://') || request.headers.get('x-forwarded-proto') === 'https'),
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7
    });
    
    return response;
  } catch (error) {
    console.error('SSO Error:', error);
    const loginUrl = new URL('/login?error=sso_failed', request.url);
    return NextResponse.redirect(loginUrl);
  }
}
