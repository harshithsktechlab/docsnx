'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ACCOUNT SETTINGS — your own name, photo, sign-in details, password     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Shown on /settings to EVERY signed-in person, member or admin. Everything on
 * it edits the viewer's own row and nothing else:
 *
 *   PATCH  /api/account/profile   name, email, mobile
 *   PUT    /api/account/avatar    the photo (DELETE removes it)
 *   POST   /api/account/password  current + new password
 *
 * The server takes the target from the session, so there is nothing here for a
 * crafted request to redirect. Email and mobile are login identities, so the
 * server wants the CURRENT password with them; this form reveals that field only
 * once one of the two has actually been changed.
 *
 * `onChanged` re-fetches /api/auth/me in the parent so the header's name and
 * photo catch up without a reload.
 */
import { useRef, useState } from 'react';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiCall } from '@/lib/net/apiRequest';
import { isBlankPhone, toDialString } from '@/lib/phone';
import { getInitials } from '@/lib/accountMenu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { PasswordInput } from '@/components/ui/password-input';

const PHOTO_SIZE = 256;
const PHOTO_MAX_BYTES = 150 * 1024;
// Mirrors MIN_PASSWORD_LENGTH in src/lib/memberActivation.ts, which pulls in
// server-only imports and cannot be loaded here. The server is the real check.
const MIN_PASSWORD = 8;

/** Centre-crop to a square and re-encode small enough for the upload cap. */
async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  canvas.getContext('2d').drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, PHOTO_SIZE, PHOTO_SIZE,
  );
  bitmap.close?.();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= PHOTO_MAX_BYTES) return blob;
  }
  return null;
}

export default function AccountSettings({ user, workspaceName, onChanged }) {
  const fileRef = useRef(null);

  const startName = user?.name || '';
  const startEmail = user?.email || '';
  const startPhone = user?.phoneNumber || '';

  const [name, setName] = useState(startName);
  const [email, setEmail] = useState(startEmail);
  const [phone, setPhone] = useState(startPhone);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');

  const [photoBusy, setPhotoBusy] = useState(false);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [repeatPw, setRepeatPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState('');

  const emailChanged = email.trim().toLowerCase() !== startEmail.toLowerCase();
  // An untouched PhoneInput holds only its country code — that is "blank", and
  // blank-to-blank is not a change.
  const phoneChanged = (isBlankPhone(phone) ? null : toDialString(phone))
    !== (isBlankPhone(startPhone) ? null : toDialString(startPhone));
  const needsPassword = emailChanged || phoneChanged;
  const nameChanged = name.trim() !== startName;
  const dirty = nameChanged || needsPassword;

  const saveProfile = async (event) => {
    event.preventDefault();
    setProfileError('');
    if (!name.trim()) {
      setProfileError('Name is required.');
      return;
    }
    if (needsPassword && !confirmPassword) {
      setProfileError('Enter your current password to change your email or mobile number.');
      return;
    }
    setSavingProfile(true);
    try {
      const body = {};
      if (nameChanged) body.name = name.trim();
      if (emailChanged) body.email = email.trim();
      if (phoneChanged) body.phoneNumber = isBlankPhone(phone) ? '' : phone;
      if (needsPassword) body.currentPassword = confirmPassword;
      const { res, json } = await apiCall('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !json.success) {
        setProfileError(json.error || 'Could not save your details.');
        return;
      }
      setConfirmPassword('');
      toast.success('Your details were updated.');
      await onChanged?.();
    } finally {
      setSavingProfile(false);
    }
  };

  const pickPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast.error('Use a JPEG, PNG or WebP photo.');
      return;
    }
    setPhotoBusy(true);
    try {
      const blob = await shrinkPhoto(file);
      if (!blob) {
        toast.error('That photo could not be made small enough. Try a different one.');
        return;
      }
      const { res, json } = await apiCall('/api/account/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Could not save your photo.');
        return;
      }
      toast.success('Profile photo updated.');
      await onChanged?.();
    } catch (err) {
      console.error('[account] photo resize failed', err);
      toast.error('That file could not be read as a photo.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      const { res, json } = await apiCall('/api/account/avatar', { method: 'DELETE' });
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Could not remove your photo.');
        return;
      }
      toast.success('Profile photo removed.');
      await onChanged?.();
    } finally {
      setPhotoBusy(false);
    }
  };

  const savePassword = async (event) => {
    event.preventDefault();
    setPwError('');
    if (!currentPw) return setPwError('Enter your current password.');
    if (newPw.length < MIN_PASSWORD) return setPwError(`Use at least ${MIN_PASSWORD} characters.`);
    if (newPw !== repeatPw) return setPwError('The new passwords do not match.');
    setSavingPw(true);
    try {
      const { res, json } = await apiCall('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      if (!res.ok || !json.success) {
        setPwError(json.error || 'Could not change your password.');
        return;
      }
      setCurrentPw('');
      setNewPw('');
      setRepeatPw('');
      toast.success('Password changed.');
    } finally {
      setSavingPw(false);
    }
  };

  const sectionClass = 'rounded-2xl border border-border/50 bg-card backdrop-blur shadow-glass p-6 flex flex-col gap-4 animate-fade-in';

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClass}>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold text-primary">Account</h2>
          <p className="text-xs text-muted-foreground">
            How you are identified{workspaceName ? ` in ${workspaceName}` : ''}.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-tr from-primary to-orange-500 text-xl font-black text-white">
            {user?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt="Your profile photo" className="h-full w-full object-cover" />
            ) : getInitials(user?.name)}
          </span>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={photoBusy} onClick={() => fileRef.current?.click()}>
                {photoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                {user?.avatarUrl ? 'Change photo' : 'Upload photo'}
              </Button>
              {user?.avatarUrl && (
                <Button type="button" variant="ghost" size="sm" disabled={photoBusy} onClick={removePhoto}>
                  <Trash2 className="h-4 w-4" /> Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">JPEG, PNG or WebP. It is cropped to a square.</p>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={pickPhoto} />
          </div>
        </div>

        <form onSubmit={saveProfile} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acctName">Name</Label>
            <Input id="acctName" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} disabled={savingProfile} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acctEmail">Email</Label>
              <Input id="acctEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={savingProfile} />
            </div>
            <div className="flex flex-col gap-1.5">
              <PhoneInput id="acctPhone" label="Mobile Number" value={phone} onChange={setPhone} disabled={savingProfile} />
            </div>
          </div>

          {needsPassword && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acctConfirmPw">Current password</Label>
              <PasswordInput
                id="acctConfirmPw"
                autoComplete="current-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={savingProfile}
              />
              <p className="text-xs text-muted-foreground">
                Your email and mobile number are how you sign in, so we ask for your password to change them.
              </p>
            </div>
          )}

          {profileError && <p className="text-xs font-semibold text-destructive" role="alert">{profileError}</p>}

          <div className="flex items-center justify-between gap-4">
            <dl className="text-xs text-muted-foreground">
              <dt className="inline font-semibold">Role: </dt>
              <dd className="inline capitalize">{String(user?.role || '').replace(/_/g, ' ').toLowerCase() || '—'}</dd>
            </dl>
            <Button type="submit" disabled={!dirty || savingProfile}>
              {savingProfile && <Loader2 className="h-4 w-4 animate-spin" />} Save changes
            </Button>
          </div>
        </form>
      </section>

      <section className={sectionClass}>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold text-primary">Change password</h2>
          <p className="text-xs text-muted-foreground">Use at least {MIN_PASSWORD} characters.</p>
        </div>
        <form onSubmit={savePassword} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acctCurrentPw">Current password</Label>
            <PasswordInput id="acctCurrentPw" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} disabled={savingPw} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acctNewPw">New password</Label>
              <PasswordInput id="acctNewPw" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} disabled={savingPw} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acctRepeatPw">Repeat new password</Label>
              <PasswordInput id="acctRepeatPw" autoComplete="new-password" value={repeatPw} onChange={(e) => setRepeatPw(e.target.value)} disabled={savingPw} />
            </div>
          </div>
          {pwError && <p className="text-xs font-semibold text-destructive" role="alert">{pwError}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={!currentPw || !newPw || savingPw}>
              {savingPw && <Loader2 className="h-4 w-4 animate-spin" />} Change password
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
