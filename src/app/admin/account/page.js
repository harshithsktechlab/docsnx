'use client';

/**
 * The super admin's own account: name, email, mobile, photo and password.
 *
 * The form is the same one every other role gets on /settings; it talks to
 * /api/account/*, which always edits the signed-in user's own row.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, UserCircle } from 'lucide-react';
import PageContainer from '@/app/components/PageContainer';
import AccountSettings from '@/app/components/AccountSettings';
import { clientGetMe } from '@/lib/clientAuth';

export default function AdminAccountPage() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await clientGetMe();
    if (res.success) {
      setMe(res.user);
      // The header's name and photo refetch on this event.
      window.dispatchEvent(new Event('docsnx:me-changed'));
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Loader2 className="animate-spin" size={24} />
        <p className="text-sm">Loading your account...</p>
      </div>
    );
  }

  return (
    <PageContainer width="narrow" className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
          <UserCircle className="text-primary" size={32} />
          My Account
        </h1>
        <p className="text-muted-foreground mt-1">
          Update your details, profile photo and password.
        </p>
      </div>

      {me ? (
        // Keyed on the saved values so a refetch resets the form's baseline.
        <AccountSettings
          key={`${me.id}:${me.name}:${me.email}:${me.phoneNumber}`}
          user={me}
          workspaceName="Platform admin"
          onChanged={load}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Could not load your account. Please refresh.</p>
      )}
    </PageContainer>
  );
}
