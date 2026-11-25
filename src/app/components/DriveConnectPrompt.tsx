'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { HardDrive } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { onDriveConnectPrompt } from '@/lib/driveConnectPrompt';
import { connectResult, DRIVE_CHECKBOX_LABEL } from '@/lib/googleConnectResults';

/** Pages that already read `?google=` and report it themselves. */
const SELF_HANDLING = ['/settings', '/onboarding', '/billing'];

/**
 * The prompt shown the first time a save needs Google Drive.
 *
 * Mounted once in the shell. It also reports the `?google=<status>` the OAuth
 * callback appends when it sends the admin back to the screen they were on, so
 * every page works as a return target without each learning the parameter.
 */
export default function DriveConnectPrompt({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => onDriveConnectPrompt(() => setOpen(true)), []);

  // Report the OAuth result once and clean the URL. Read from `location` so the
  // shell does not need a Suspense boundary for useSearchParams().
  useEffect(() => {
    if (!pathname || SELF_HANDLING.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return;
    const params = new URLSearchParams(window.location.search);
    const result = connectResult(params.get('google'));
    if (!result) return;
    if (result.ok) {
      toast.success(`${result.message} Add your file again to save it.`);
    } else {
      toast.error(result.message);
    }
    // Only `google` is removed — `?company=` keeps the active workspace.
    params.delete('google');
    const rest = params.toString();
    window.history.replaceState(null, '', pathname + (rest ? `?${rest}` : ''));
  }, [pathname]);

  const connect = useCallback(() => {
    const returnTo = encodeURIComponent(window.location.pathname);
    window.location.href = `/api/auth/google?returnTo=${returnTo}`;
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md bg-card border-border/50 shadow-glass">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-black">
            <HardDrive className="text-blue-500" />
            Connect Google Drive to save
          </DialogTitle>
          <DialogDescription className="text-muted-foreground pt-2">
            DocsNX keeps your files and records on your own Google Drive and holds only the
            metadata. Connect it once and everything you save is encrypted and stored there.
          </DialogDescription>
        </DialogHeader>

        {isAdmin ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            On Google&rsquo;s consent screen, tick{' '}
            <span className="font-semibold text-foreground">&ldquo;{DRIVE_CHECKBOX_LABEL}&rdquo;</span>
            . You will be returned to this page, and will need to add what you were saving again.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Only your workspace admin can connect Google Drive. Ask them to connect it, then try again.
          </p>
        )}

        <DialogFooter className="flex gap-2 sm:justify-start pt-4 mt-2 border-t border-border/30">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {isAdmin ? 'Not now' : 'Close'}
          </Button>
          {isAdmin && (
            <Button type="button" onClick={connect} className="bg-blue-600 hover:bg-blue-700 text-white font-bold">
              Connect Google Drive
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
