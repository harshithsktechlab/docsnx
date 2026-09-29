'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { setFlash } from '@/lib/flashToast';
import {
  ChevronRight, Check, Cloud, Users, CheckCircle2, Plus, ArrowRight, Loader2, Play, ShieldCheck, Lock, Building2, LogOut, AlertTriangle, CreditCard
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/ui/PhoneInput';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import { clientLogout } from '@/lib/clientAuth';
import { connectResult, DRIVE_CHECKBOX_LABEL } from '@/lib/googleConnectResults';
import { companySlots, companyStepBlurb } from '@/lib/companySlots';
import { workspaceNameCopy } from '@/lib/workspaceName';
import {
  memberDestinations, defaultDestinationId, findDestination,
  membersStepBlurb, destinationPayload,
} from '@/lib/memberDestinations';
import { defaultPermissionsFor } from '@/lib/moduleRegistry';
import PermissionMatrix from '@/app/users/PermissionMatrix';
import { invalidatePermittedCategories } from '@/lib/usePermittedCategories';


/**
 * The wizard's steps, by NAME.
 *
 * They were positions — `step === 3` meant Members — which made inserting the
 * Companies step a renumbering of every branch and every Back button. Naming
 * them means the business step can appear in the middle for some accounts and
 * not at all for others, with nothing downstream needing to know.
 */
const STEP_WELCOME = 'welcome';
const STEP_STORAGE = 'storage';
const STEP_COMPANIES = 'companies';
const STEP_MEMBERS = 'members';
const STEP_FINISH = 'finish';

/**
 * A personal account never sees the Companies step; a business one cannot
 * finish without it, because /api/onboarding/complete refuses an account with
 * no company — every business module is company-scoped, so the workspace would
 * render fourteen modules and refuse every write into them.
 *
 * Module-level so the OAuth resume below can name the step it wants rather than
 * hardcoding an index that differs between the two.
 */
const PERSONAL_STEPS = [STEP_WELCOME, STEP_STORAGE, STEP_MEMBERS, STEP_FINISH];
const BUSINESS_STEPS = [STEP_WELCOME, STEP_STORAGE, STEP_COMPANIES, STEP_MEMBERS, STEP_FINISH];

/**
 * The step list for an account type. Both places that jump to a step by name
 * need it, and one of them runs before `accountType` has reached state — the
 * OAuth resume, which is handed the type by the same response it was read from.
 */
const stepsFor = (type) => (type === 'personal' ? PERSONAL_STEPS : BUSINESS_STEPS);

/**
 * The wizard renders OUTSIDE the app shell (see Shell.js), so it owns its own
 * viewport — `PageContainer` deliberately contributes no padding, and without
 * this the card would sit flush against the edge of the screen.
 *
 * It also owns the ONE control the shell would otherwise have provided: signing
 * out. Without the header there is no account menu, and an admin who opened the
 * wrong account — or a member with nothing to do here — would have no way out of
 * this page at all.
 */
function BarePage({ children }) {
  const router = useRouter();
  const signOut = async () => {
    await clientLogout();
    router.push('/login');
  };

  return (
    <main className="min-h-screen w-full page-gutter flex flex-col justify-center">
      <PageContainer width="compact">
        {children}
        <div className="mt-6 text-center">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={signOut}>
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </PageContainer>
    </main>
  );
}

// Footer primary action: full width and allowed to wrap on a phone, where the
// long disabled-state labels ("Add a company to continue") used to run off the card.
const FOOTER_NEXT = 'w-full h-auto min-h-10 whitespace-normal text-center sm:w-auto';

const STEP_LABELS = {
  [STEP_WELCOME]: 'Welcome',
  [STEP_STORAGE]: 'Storage',
  [STEP_COMPANIES]: 'Companies',
  [STEP_MEMBERS]: 'Members',
  [STEP_FINISH]: 'Finish',
};

export default function OnboardingWizard() {
  const router = useRouter();
  const [accountType, setAccountType] = useState('personal');
  const [companies, setCompanies] = useState([]);
  const [newCompany, setNewCompany] = useState('');
  const [isAddingCompany, setIsAddingCompany] = useState(false);
  /**
   * How many companies this plan includes, and how many already hold a slot —
   * from GET /api/companies, which reads the same allowance POST enforces.
   *
   * Null until it lands (and on a plan whose quota could not be read), which
   * `companySlots` treats as "show the form": the server is still the thing
   * enforcing the limit, and an admin with room left must not be locked out of
   * a step they cannot otherwise finish.
   */
  const [companyQuota, setCompanyQuota] = useState(null);
  /**
   * Whether the Companies step draws its "Add Company" form at all, and what it
   * says above it. The rule lives in `src/lib/companySlots.ts` because this
   * file is a .js page component and therefore untestable (vitest cannot parse
   * JSX out of a .js file); the decision it makes is worth a test.
   *
   * `companies.length` is only the FALLBACK count, for the moment before the
   * quota lands — the server's own `used` is authoritative, because a
   * deactivated company holds a slot and does not appear in this list.
   */
  const slots = companySlots(companyQuota?.used ?? companies.length, companyQuota?.limit);
  /**
   * What this account is called. Asked HERE rather than on the sign-up form,
   * where it used to be the very first question put to a stranger — and the one
   * answer they could never revise, since renaming a tenant is an operator-only
   * route. Seeded below from the row itself, which until now holds the name
   * derived from the admin's own at registration (src/lib/workspaceName.ts).
   */
  const [workspaceName, setWorkspaceName] = useState('');
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);
  /**
   * How the Welcome step ASKS for that name, which is not the same question on
   * every account type — see `workspaceNameCopy` in src/lib/workspaceName.ts.
   * A business admin used to be asked for a "workspace" over the placeholder
   * "e.g. Sharma Household", one step before being told companies exist and
   * are named separately.
   *
   * Derived rather than held in state: `accountType` lands from /api/auth/me
   * before this step can be submitted, and its 'personal' default is the same
   * one `steps` above already assumes.
   */
  const nameCopy = workspaceNameCopy(accountType);

  const steps = accountType === 'personal' ? PERSONAL_STEPS : BUSINESS_STEPS;

  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const goTo = (name) => setStepIndex(Math.max(0, steps.indexOf(name)));
  const [isCompleting, setIsCompleting] = useState(false);
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  /**
   * Why the last attempt to connect a Drive did not take — the whole result
   * object from `connectResult`, not just a flag, because the Storage step
   * renders its `detail` and colours itself by its `tone`.
   *
   * Kept until a live check says the Drive is genuinely connected. It is the
   * only thing on that step that can explain an unticked permission box: the
   * callback deliberately writes NOTHING on that path, so the tenant row looks
   * exactly as it did before the admin ever left for Google.
   */
  const [connectIssue, setConnectIssue] = useState(null);
  /** The same value, reachable from the async check that started before it. */
  const connectIssueRef = useRef(null);
  /**
   * Who is looking at this page. Only a TENANT_ADMIN can finish setup — the
   * complete endpoint 401s anyone else — but a member CAN exist before the
   * wizard is done, because the Members step creates them. Showing them the
   * steps would be showing them buttons that cannot work, so they get a short
   * "your admin is still setting up" panel instead.
   */
  const [role, setRole] = useState(null);
  const [isChecking, setIsChecking] = useState(true);


  // Members state
  const [members, setMembers] = useState([]);
  // `phoneNumber` is the mandatory one: it is what a member signs in with and
  // the only channel their verification code goes to. `email` is optional.
  const [newMember, setNewMember] = useState({ name: '', email: '', phoneNumber: '', password: '' });
  const [isAddingMember, setIsAddingMember] = useState(false);
  // Access at creation time — same matrix MembersScreen uses post-onboarding.
  // Left uninitialized here and seeded by the effect below, since the right
  // default depends on `chosenDestination.scope`, which isn't known yet.
  const [memberPermissions, setMemberPermissions] = useState(() => defaultPermissionsFor('personal'));
  const [showAccessEditor, setShowAccessEditor] = useState(false);
  /**
   * Whether the admin has actually touched the grid, as opposed to merely
   * having opened it. `showAccessEditor` used to gate the reseed below, which
   * meant opening "Customize access now" while Household was selected froze
   * the grid on personal modules even if the admin then switched to a
   * company — the panel being open looked identical to "already customizing"
   * even when nothing had been edited yet. This ref is the real signal.
   */
  const hasEditedPermissionsRef = useRef(false);
  /**
   * WHICH HALF OF THE ACCOUNT the next member joins — the household, or one of
   * the companies. Only an explicit pick lives here; the default is derived
   * below rather than synced into state, because the list this id points into
   * arrives in pieces (the account type from /api/auth/me, the companies from
   * /api/companies, and more of them from the Companies step itself). A useState
   * seeded from an empty list would hold a stale id every time.
   *
   * The step used to ask none of this, and the server used to write none of it:
   * every member the wizard created landed in the household whatever the admin
   * believed. See src/lib/memberDestinations.ts.
   */
  const [destinationId, setDestinationId] = useState(null);

  /**
   * Where the Members step can file somebody, and which of those is selected.
   * Both derived every render, so adding a company on the previous step shows
   * up here without anything having to notify anything.
   *
   * `chosenDestination` falls back to the default whenever `destinationId` is
   * not (yet) one of these — which is the state on first paint, and the state
   * after a company the admin had selected was somehow removed.
   */
  const destinations = memberDestinations(accountType, workspaceName, companies);
  const chosenDestination = findDestination(destinations, destinationId)
    ?? findDestination(destinations, defaultDestinationId(destinations));

  // Re-seed the default grant when the destination's scope changes (household
  // vs. a company have different module sets) — but only while the admin
  // hasn't actually edited the grid, so switching companies mid-edit doesn't
  // wipe their picks. Gated on the edit ref rather than `showAccessEditor`:
  // opening the panel isn't editing it, and the grid should keep following
  // the destination until a real change locks it.
  useEffect(() => {
    if (hasEditedPermissionsRef.current) return;
    setMemberPermissions(defaultPermissionsFor(chosenDestination?.scope === 'business' ? 'business' : 'personal'));
  }, [chosenDestination?.scope]);

  /**
   * The OAuth flow returns here as `?google=<status>` — including its failures.
   *
   * `cancelled` and `missing_drive_scope` were silent before this: the admin
   * came back to a Storage step that had simply stayed red, with the same
   * button, and no way to tell a mis-click from a broken integration.
   *
   * ── WHY THE TOAST IS NOT ENOUGH ───────────────────────────────────────────
   * It says its piece for four seconds on a page that has only just finished
   * loading, and the `router.replace` on the next line deletes the only other
   * trace. What is left afterwards is the Storage step, unchanged. So the
   * result is ALSO kept in state and rendered there until the connection
   * actually succeeds — see `connectIssue` on that step.
   *
   * The ref is for `checkDriveStatus` below: it is an async closure that
   * started before this state existed, and it needs to know whether to send the
   * admin back to the step that failed.
   */
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('google');
    const result = connectResult(status);
    if (!result) return;
    if (result.ok) {
      toast.success(result.message, { id: 'onboarding-drive' });
    } else {
      toast.error(result.message, { id: 'onboarding-drive' });
      setConnectIssue(result);
      connectIssueRef.current = result;
    }
    router.replace('/onboarding');
  }, [router]);

  /**
   * Is Drive REALLY connected — asked of Google, not of a column.
   *
   * `/api/auth/me` reports `googleDriveEnabled`, which only says a grant was
   * stored once. `/api/tenants/integrations/google` calls Google: it reports
   * whether the stored grant still carries `drive.file`, and it clears a
   * revoked one as a side effect. Trusting the column instead is how this step
   * showed a green tick over a dead connection.
   */
  useEffect(() => {
    const checkDriveStatus = async () => {
      try {
        const { json: data } = await apiCall('/api/auth/me'); // Fetch authenticated user and tenant info
        const type = data.user?.tenant?.accountType || 'personal';
        setAccountType(type);
        setRole(data.user?.role ?? null);
        // The name the row already carries, so a reload mid-wizard shows what
        // was saved rather than an empty box — and so the derived name is a
        // starting point to edit rather than something to retype.
        setWorkspaceName(data.user?.tenant?.name || '');
        // Already-created companies, so a reload mid-wizard does not look empty
        // and re-adding one does not 409.
        if (Array.isArray(data.companies)) setCompanies(data.companies);

        if (data.user?.role !== 'TENANT_ADMIN') return;

        /**
         * How many companies the plan includes. Asked of /api/companies rather
         * than read off `planDetails` above, which is the PERSONAL plan on a
         * `both` account and knows nothing about `max_companies` — and which
         * cannot see the "Additional company" add-ons either way.
         *
         * Business accounts only: the personal wizard never renders the step.
         * A failure is swallowed on purpose — the quota decides whether to draw
         * a form, not whether the wizard works, and a null one draws it.
         */
        if (type !== 'personal') {
          try {
            const { json: co } = await apiCall('/api/companies');
            if (Array.isArray(co?.companies)) setCompanies(co.companies);
            if (co?.quota) setCompanyQuota(co.quota);
          } catch (err) {
            console.error('[onboarding] company quota threw', err);
          }
        }

        const { json: drive } = await apiCall('/api/tenants/integrations/google');
        const live = drive?.integration;
        if (live?.connected && live?.enabled && live?.scopeOk) {
          setIsDriveConnected(true);
          // Whatever went wrong last time is over. Said here rather than on the
          // way in, because only this check knows the Drive is really there.
          setConnectIssue(null);
          connectIssueRef.current = null;
          // Returning from the OAuth round trip: skip past the step they just
          // completed. By NAME, because the index differs between account types.
          setStepIndex(stepsFor(type).indexOf(type === 'personal' ? STEP_MEMBERS : STEP_COMPANIES));
        } else if (connectIssueRef.current) {
          /**
           * The other half of that round trip, and the one that was missing.
           *
           * The wizard always starts at Welcome, so an admin who unticked the
           * Drive permission — or closed the consent screen — was returned to
           * the FIRST step of a wizard they were halfway through, which reads
           * as "it threw me back to the beginning" rather than as a step that
           * failed. Put them on the step that can actually be retried; the
           * alert it renders is what tells them why they are there.
           */
          setStepIndex(stepsFor(type).indexOf(STEP_STORAGE));
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsChecking(false);
      }
    };
    checkDriveStatus();
  }, [router]);

  const handleNext = () => {
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1));
  };

  /**
   * Saved on the way out of the Welcome step, not held until Finish.
   *
   * The wizard's state does not survive a reload — and it is reloaded often,
   * because the Storage step leaves for Google and comes back — so a name kept
   * only in this component would be lost by the step that follows it. Same
   * reasoning as `handleAddCompany` below: every answer this wizard collects is
   * written when it is given.
   */
  const handleSaveWorkspaceName = async () => {
    const name = workspaceName.trim();
    if (name.length < 2) {
      toast.error(`Give your ${nameCopy.noun} a name of at least two characters.`, { id: 'onboarding-workspace' });
      return;
    }

    setIsSavingWorkspace(true);
    try {
      const { json: data } = await apiCall('/api/onboarding/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (data.success) {
        setWorkspaceName(name);
        handleNext();
      } else {
        toast.error(data.error || 'Could not save that workspace name', { id: 'onboarding-workspace' });
      }
    } catch (err) {
      // Transport failures are values now, not throws — see handleComplete.
      console.error('[onboarding] save workspace name threw', err);
      toast.error('Something went wrong while saving the name. Please try again.', { id: 'onboarding-workspace' });
    } finally {
      setIsSavingWorkspace(false);
    }
  };

  /**
   * Creating a company is a real API call, not a local list.
   *
   * Members work the same way (`/api/onboarding/users`), and for the same
   * reason: the Finish button asks the SERVER whether setup is complete, so a
   * company that only existed in this component's state would leave the wizard
   * insisting nothing had been added.
   */
  const handleAddCompany = async () => {
    const name = newCompany.trim();
    if (!name) {
      toast.error('Enter a company name.', { id: 'onboarding-company' });
      return;
    }
    setIsAddingCompany(true);
    try {
      const { json: data } = await apiCall('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (data.success) {
        toast.success(`${name} added.`, { id: 'onboarding-company' });
        // The sidebar's business modules are built from a per-session cache
        // (usePermittedCategories) that never refetches on its own — without
        // this, the new company's modules stay invisible until a hard reload,
        // even though the server already grants them.
        invalidatePermittedCategories();
        setCompanies((prev) => [...prev, data.company]);
        // The slot it just took, so the form closes on the last one without a
        // second round trip. Tracked separately from the list because that is
        // what the server counts against the plan — see companySlots.ts.
        setCompanyQuota((prev) => (prev ? { ...prev, used: prev.used + 1 } : prev));
        setNewCompany('');
      } else {
        toast.error(data.error || 'Could not add that company', { id: 'onboarding-company' });
      }
    } catch (err) {
      console.error('[onboarding] add company threw', err);
      toast.error('Something went wrong while adding the company. Please try again.', { id: 'onboarding-company' });
    } finally {
      setIsAddingCompany(false);
    }
  };

  const handleConnectDrive = () => {
    window.location.href = '/api/auth/google?returnTo=/onboarding';
  };

  const handleAddMember = async () => {
    if (!newMember.name || !newMember.phoneNumber || !newMember.password) {
      toast.error('Name, Mobile Number and Temporary Password are required.', { id: 'onboarding-member' });
      return;
    }

    // A business account that reached this step with no company has nowhere to
    // put anyone. The form is not drawn in that case, so this is the belt to
    // that brace rather than a message anyone should normally see.
    if (!chosenDestination) {
      toast.error('Add a company first — a member has to work on one.', { id: 'onboarding-member' });
      return;
    }

    setIsAddingMember(true);
    try {
      const { json: data } = await apiCall('/api/onboarding/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The destination is a HINT. The route resolves the scope from the
        // tenant and re-resolves the company ids against it — see its header.
        // `permissions` is likewise only a starting point: the route merges it
        // onto its own server-resolved defaults rather than trusting it whole.
        body: JSON.stringify({ ...newMember, ...destinationPayload(chosenDestination), permissions: memberPermissions })
      });

      if (data.success) {
        toast.success(`${newMember.name} was added to ${chosenDestination.label}.`, { id: 'onboarding-member' });
        // The destination is kept on the row: "Added Members" was as silent
        // about where these people went as the form above it was.
        setMembers([...members, { ...newMember, destination: chosenDestination.label }]);
        setNewMember({ name: '', email: '', phoneNumber: '', password: '' });
        setMemberPermissions(defaultPermissionsFor(chosenDestination?.scope === 'business' ? 'business' : 'personal'));
        setShowAccessEditor(false);
        hasEditedPermissionsRef.current = false;
      } else {
        toast.error(data.error || 'Failed to add member', { id: 'onboarding-member' });
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[onboarding] handler threw', err);
      toast.error('Something went wrong while adding member. Please try again.', { id: 'onboarding-member' });
    } finally {
      setIsAddingMember(false);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      const { json: data } = await apiCall('/api/onboarding/complete', { method: 'POST' });
      if (data.success) {
        // Handed to the dashboard rather than fired at it. This already read
        // on that page — it was raised after the push — but only for whatever
        // was left of its four seconds, and underneath anything the dashboard
        // arrival had to say. See src/lib/flashToast.ts.
        setFlash({ message: 'Welcome to DocsNX!', type: 'success', pin: '/dashboard', tag: 'onboarding-done' });
        router.push('/dashboard');
      } else {
        /**
         * The server verifies the Drive grant against Google before it finishes,
         * so this button can legitimately be refused by a connection that looked
         * fine when the Storage step was passed — revoked since, or never
         * carrying `drive.file` at all. Say what happened and put them back on
         * the step that fixes it, rather than leaving them on a dead button.
         */
        if (data.status === 'DRIVE_NOT_CONNECTED' || data.status === 'DRIVE_AMBIGUOUS_ROOT') {
          setIsDriveConnected(false);
          // Carried onto the step rather than left in the toast, for the same
          // reason as a failed consent: the Storage step they are being sent to
          // otherwise looks untouched, and the sentence explaining the trip is
          // gone four seconds later.
          setConnectIssue({
            tone: 'error',
            detail:
              data.error ||
              'Your Google Drive connection is no longer usable, so setup cannot be finished. Connect it again below.',
          });
          goTo(STEP_STORAGE);
        } else if (data.status === 'NO_COMPANY') {
          goTo(STEP_COMPANIES);
        }
        // DRIVE_UNREACHABLE is Google being down, not the tenant being
        // unconnected — leave them on Finish so a retry is one click away.
        toast.error(data.error || 'Failed to complete onboarding', { id: 'onboarding-finish' });
        setIsCompleting(false);
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[onboarding] handler threw', err);
      toast.error('Something went wrong. Please try again.', { id: 'onboarding-finish' });
      setIsCompleting(false);
    }
  };

  if (isChecking) {
    return (
      <BarePage>
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      </BarePage>
    );
  }

  /**
   * ── A MEMBER WAITING ON THEIR ADMIN ───────────────────────────────────────
   *
   * The Members step creates real accounts, so a member can exist while setup
   * is unfinished — and Shell holds everyone in an un-onboarded tenant here,
   * not just the admin, because the API refuses them all the same way. They
   * cannot connect a Drive (that flow is admin-only) and cannot finish setup
   * (the complete endpoint 401s them), so showing them the wizard would be
   * showing them five steps of buttons that all fail. This is what they get.
   */
  if (role && role !== 'TENANT_ADMIN') {
    return (
      <BarePage>
        <Card className="border-border/40 shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="mx-auto bg-amber-500/10 w-16 h-16 rounded-full flex items-center justify-center mb-4">
              <Lock className="text-amber-500 w-8 h-8" />
            </div>
            <CardTitle className="text-2xl">Your workspace is still being set up</CardTitle>
            <CardDescription className="text-base mt-2">
              Your account administrator has to connect the workspace&apos;s Google Drive before
              anyone can add or open records. You will be able to sign in as normal once they do.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6 pb-8 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing to do here — check back shortly, or ask your administrator to finish setup.
            </p>
          </CardContent>
        </Card>
      </BarePage>
    );
  }

  return (
    <BarePage>
      {/* Progress Tracker */}
      <div className="mb-8 relative">
        <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-muted">
          <div
            style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }}
            className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-primary transition-all duration-500"
          />
        </div>
        <div className="flex justify-between gap-1 text-[11px] sm:text-xs font-medium text-muted-foreground px-1">
          {steps.map((name, idx) => (
            <span key={name} className={idx <= stepIndex ? 'text-primary' : ''}>
              {STEP_LABELS[name]}
            </span>
          ))}
        </div>
      </div>

      {/* Wizard Steps */}
      <Card className="border-border/40 shadow-lg">
        
        {/* Welcome */}
        {step === STEP_WELCOME && (
          <>
            <CardHeader className="text-center pb-2">
              <div className="mx-auto bg-primary/10 w-16 h-16 rounded-full flex items-center justify-center mb-4">
                <Play className="text-primary w-8 h-8 ml-1" />
              </div>
              <CardTitle className="text-3xl">Welcome to DocsNX</CardTitle>
              <CardDescription className="text-base mt-2">
                Your secure, centralized vault for your workspace&apos;s most important documents. Let&apos;s get your workspace set up in just a few clicks.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 pb-8">
              <div className="space-y-4 max-w-md mx-auto">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="text-emerald-500 mt-0.5" size={20} />
                  <p className="text-sm text-muted-foreground">Securely store and organize personal records.</p>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="text-emerald-500 mt-0.5" size={20} />
                  <p className="text-sm text-muted-foreground">Connect your own Google Drive for private storage.</p>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="text-emerald-500 mt-0.5" size={20} />
                  <p className="text-sm text-muted-foreground">Invite members to share access instantly.</p>
                </div>

                {/*
                  The only question this step asks. Prefilled with the name the
                  account already has, derived from the admin's own at sign-up,
                  so the work here is editing a sensible answer rather than
                  facing an empty required field.
                */}
                <div className="flex flex-col gap-1.5 pt-2">
                  <Label htmlFor="workspaceName">{nameCopy.label}</Label>
                  <Input
                    id="workspaceName"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSaveWorkspaceName();
                      }
                    }}
                    placeholder={nameCopy.placeholder}
                    disabled={isSavingWorkspace}
                    maxLength={255}
                  />
                  <p className="text-xs text-muted-foreground">
                    {nameCopy.helper}
                  </p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex justify-end border-t p-4 bg-muted/20 sm:p-6">
              <Button
                onClick={handleSaveWorkspaceName}
                disabled={isSavingWorkspace || workspaceName.trim().length < 2}
                className="w-full sm:w-auto"
              >
                {isSavingWorkspace ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>
                ) : (
                  <>Get Started <ArrowRight className="ml-2 h-4 w-4" /></>
                )}
              </Button>
            </CardFooter>
          </>
        )}

        {/* Google Drive */}
        {step === STEP_STORAGE && (
          <>
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-blue-500/10 p-2 rounded-lg text-blue-500">
                  <Cloud size={24} />
                </div>
                <CardTitle>Connect Cloud Storage (BYOD)</CardTitle>
              </div>
              <CardDescription>
                Bring Your Own Drive (BYOD): DocsNX stores your workspace records exclusively in your personal Google Drive using Zero-View Client-Side Encryption.
              </CardDescription>
            </CardHeader>
            <CardContent className="py-6 space-y-6">
              {/*
                ── WHY THE LAST ATTEMPT DID NOT TAKE ──────────────────────────
                First, above everything this step claims about encryption and
                sync: none of it is happening yet. This is the only surface that
                can say so — the callback refuses to store a permission-less
                grant, so the tenant row carries no trace of the attempt for the
                integration check to report. Destructive for a real failure,
                warning for a cancelled one, which is a choice and not a fault.
              */}
              {connectIssue && (
                <Alert variant={connectIssue.tone === 'info' ? 'warning' : 'destructive'}>
                  <AlertTriangle size={14} />
                  <AlertDescription className="text-xs">{connectIssue.detail}</AlertDescription>
                </Alert>
              )}

              {/* BYOD Zero-Knowledge Encryption Shield Badge */}
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-left space-y-3">
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold text-sm">
                  <ShieldCheck className="h-5 w-5 shrink-0" />
                  <span>BYOD Automated Zero-Knowledge Google Drive Sync</span>
                </div>
                <ul className="text-xs text-muted-foreground space-y-1.5 list-disc list-inside">
                  <li>
                    <strong className="text-foreground">Client-Side AES-256-GCM Encryption:</strong> All 18 vault modules are encrypted inside your browser before upload.
                  </li>
                  <li>
                    <strong className="text-foreground">100% Tenant Sovereignty:</strong> Files are stored separately under <code className="bg-muted px-1.5 py-0.5 rounded text-xs break-all">/DocsNX_Data/&lt;module&gt;.enc.json</code> in your Google account.
                  </li>
                  <li>
                    <strong className="text-foreground">Zero Backend Storage:</strong> Our servers never store unencrypted files or data copies. You hold the keys.
                  </li>
                </ul>
              </div>

              <div className="bg-muted/50 p-4 sm:p-6 rounded-lg border text-center space-y-4">
                {isDriveConnected ? (
                  <div className="flex flex-col items-center gap-2 text-emerald-500">
                    <CheckCircle2 size={48} />
                    <p className="font-medium">Google Drive is Connected!</p>
                    <p className="text-xs text-muted-foreground">Automated BYOD Zero-Knowledge Sync is active for all 18 modules.</p>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground mb-4">
                      By connecting your Drive, all documents and records uploaded to DocsNX are encrypted and organized directly in your Google account.
                    </p>
                    <Button onClick={handleConnectDrive} variant="default" className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white shadow-md">
                      <Cloud className="mr-2 h-4 w-4" />
                      {connectIssue ? 'Try connecting again' : 'Connect BYOD Google Drive'}
                    </Button>
                    {/*
                      Said BEFORE they leave, not only after they come back.
                      Google renders this permission as a tick box sitting above
                      the Continue button, and an admin who reads "Allow" as the
                      whole decision grants an account that can store nothing.
                    */}
                    <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                      On Google&rsquo;s screen, tick{' '}
                      <span className="font-semibold text-foreground">
                        &ldquo;{DRIVE_CHECKBOX_LABEL}&rdquo;
                      </span>{' '}
                      before you continue. It is optional there, and without it your records
                      have nowhere to be saved.
                    </p>
                  </>
                )}
              </div>
            </CardContent>
            <CardFooter className="flex flex-col-reverse gap-3 border-t p-4 bg-muted/20 sm:flex-row sm:justify-between sm:p-6">
              <Button variant="ghost" className="w-full sm:w-auto" onClick={() => goTo(STEP_WELCOME)}>Back</Button>
              {/*
                No skip. Google Drive is where every file is stored — DocsNX
                keeps only metadata — so an account without a grant has
                nowhere to put anything and every upload would fail.
              */}
              <Button onClick={handleNext} disabled={!isDriveConnected} className={FOOTER_NEXT}>
                {isDriveConnected ? 'Continue' : 'Connect Drive to continue'}{' '}
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </CardFooter>
          </>
        )}

        {/* Companies — business accounts only */}
        {step === STEP_COMPANIES && (
          <>
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-indigo-500/10 p-2 rounded-lg text-indigo-500">
                  <Building2 size={24} />
                </div>
                <CardTitle>Your Companies</CardTitle>
              </div>
              <CardDescription>{companyStepBlurb(slots)}</CardDescription>
            </CardHeader>
            <CardContent className="py-4">
              <div className="space-y-6">
                {/*
                  WHAT THEY ALREADY HAVE, FIRST.

                  The form used to open this step, so an account that named its
                  company on the sign-up form was greeted by an empty box — the
                  one thing it had done was below the fold of the one thing it
                  could not do. The list is the answer to "did that work?", so
                  it goes where the eye lands.
                */}
                {companies.length > 0 && (
                  <div className="space-y-3">
                    {/*
                      No "(1 of 1)" counter here. The number that matters is the
                      PLAN's, and the description above already carries it —
                      while this list is what the CALLER can reach and would
                      disagree with the quota over a deactivated company.
                    */}
                    <h4 className="text-sm font-medium">Added</h4>
                    <div className="space-y-2">
                      {companies.map((c) => (
                        <div key={c.id} className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                          <p className="font-medium text-sm">{c.name}</p>
                          <CheckCircle2 className="text-emerald-500 h-5 w-5" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/*
                  ── THE FORM IS NOT UNCONDITIONAL ──────────────────────────
                  A one-company plan has no second slot, so drawing this would
                  be offering a button whose only outcome is the 403 from POST
                  /api/companies. Shown only while a slot is genuinely free —
                  and while the limit is UNKNOWN, since a null quota must never
                  be the reason an admin cannot finish the wizard.
                */}
                {slots.canAdd && (
                  <div className="grid gap-4 p-4 border rounded-lg bg-background">
                    <div className="space-y-2">
                      <Label>Company Name</Label>
                      <Input
                        placeholder="e.g. Acme Trading Pvt Ltd"
                        value={newCompany}
                        onChange={(e) => setNewCompany(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCompany(); } }}
                      />
                    </div>
                    <Button onClick={handleAddCompany} disabled={isAddingCompany} className="w-full sm:w-auto">
                      {isAddingCompany ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                      {companies.length > 0 ? 'Add Another Company' : 'Add Company'}
                    </Button>
                  </div>
                )}

                {/*
                  The plan is full. Said plainly, with where to go for more —
                  otherwise the missing form reads as a step that failed to
                  load rather than one that is finished.
                */}
                {slots.atLimit && !slots.noAllowance && (
                  <p className="text-sm text-muted-foreground">
                    Your plan includes {slots.limit} {slots.limit === 1 ? 'company' : 'companies'}.
                    You can buy another from Billing once setup is done.
                  </p>
                )}

                {/*
                  No business allowance at all. Not a full plan — no plan, which
                  is a dead end here: /api/onboarding/complete refuses a business
                  account with no company, and POST /api/companies refuses to
                  create one. Say so rather than leave them on a blank step.

                  ── AND HAND THEM THE DOOR ─────────────────────────────────
                  The sentence said "choose a business plan from Billing" to
                  someone with no way of getting to Billing. This wizard renders
                  OUTSIDE the shell (see Shell.js), so there is no sidebar, no
                  header and no link anywhere on the page — and Continue is
                  disabled on this step. Naming a destination that can only be
                  reached by typing its URL is the same dead end with better
                  manners.

                  /billing is deliberately exempt from the onboarding gate, so
                  this button genuinely lands; and the way back is already
                  built, since every gated path there bounces to /onboarding.
                */}
                {slots.noAllowance && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="flex flex-col items-start gap-3">
                      <span>
                        Your plan does not include a business account, so no company can be
                        added. Choose a business plan from Billing, then come back to finish
                        setting up.
                      </span>
                      <Button variant="secondary" size="sm" onClick={() => router.push('/billing')}>
                        <CreditCard className="mr-2 size-4" /> Go to Billing
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </CardContent>
            <CardFooter className="flex flex-col-reverse gap-3 border-t p-4 bg-muted/20 sm:flex-row sm:justify-between sm:p-6">
              <Button variant="ghost" className="w-full sm:w-auto" onClick={() => goTo(STEP_STORAGE)}>Back</Button>
              {/*
                No skip, for the same reason the Drive step has none: a business
                account with no company has nowhere to file, and
                /api/onboarding/complete refuses to finish without one. Better to
                say so here than to let them reach Finish and be turned back.
              */}
              <Button onClick={handleNext} disabled={companies.length === 0} className={FOOTER_NEXT}>
                {companies.length > 0
                  ? 'Continue'
                  // "Add a company to continue" is an instruction they cannot
                  // follow when the plan has no slot to add one into.
                  : slots.noAllowance ? 'A business plan is needed to continue' : 'Add a company to continue'}
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </CardFooter>
          </>
        )}

        {/* Members */}
        {step === STEP_MEMBERS && (
          <>
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-purple-500/10 p-2 rounded-lg text-purple-500">
                  <Users size={24} />
                </div>
                <CardTitle>Invite Members</CardTitle>
              </div>
              {/*
                The one sentence that used to say nothing about WHERE. On a
                combo account this step has two real answers and named neither,
                which is the ambiguity the whole destination mechanism removes.
              */}
              <CardDescription>{membersStepBlurb(chosenDestination, destinations)}</CardDescription>
            </CardHeader>
            <CardContent className="py-4">
              <div className="space-y-6">
                {/*
                  ── WHO ARE YOU ADDING? ────────────────────────────────────
                  Drawn only when there is genuinely a choice. A personal
                  account has one household and a single-company business
                  account has one company — offering a list of one would be
                  asking a question with no second answer, and the description
                  above already names it.
                */}
                {destinations.length > 1 && (
                  <div className="space-y-3">
                    <Label id="onboardingMemberDestination">Who are you adding?</Label>
                    <div role="radiogroup" aria-labelledby="onboardingMemberDestination" className="space-y-2">
                      {destinations.map((d) => {
                        const selected = chosenDestination?.id === d.id;
                        return (
                          <button
                            key={d.id ?? 'household'}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setDestinationId(d.id)}
                            className={`flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                              selected ? 'border-primary bg-primary/5' : 'bg-muted/30 hover:bg-muted/50'
                            }`}
                          >
                            <span className="flex items-center gap-3">
                              {d.scope === 'business'
                                ? <Building2 className="size-4 shrink-0 text-indigo-500" />
                                : <Users className="size-4 shrink-0 text-purple-500" />}
                              <span>
                                <span className="block text-sm font-medium">{d.rowLabel}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {d.scope === 'business' ? 'Company' : 'Household'}
                                </span>
                              </span>
                            </span>
                            {selected && <CheckCircle2 className="size-5 shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/*
                  A business account with no company has nowhere to file a
                  member — `memberDestinations` returns an empty list rather
                  than inventing a household to hold them. Drawing the form
                  would be offering a button whose only outcome is the 400 from
                  the route, so send them back to the step that fixes it.
                */}
                {destinations.length === 0 && (
                  <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                    <p className="text-sm text-muted-foreground">
                      Every business member works on a company, and this account has none yet.
                    </p>
                    <Button variant="outline" size="sm" onClick={() => goTo(STEP_COMPANIES)}>
                      <Building2 className="mr-2 size-4" /> Add a company first
                    </Button>
                  </div>
                )}

                {/* Add Form */}
                {destinations.length > 0 && (
                <div className="grid gap-4 p-4 border rounded-lg bg-background">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Name</Label>
                      <Input placeholder="John Doe" value={newMember.name} onChange={e => setNewMember({...newMember, name: e.target.value})} />
                    </div>
                    <div className="space-y-2">
                      <PhoneInput
                        id="onboardingMemberPhone"
                        label="Mobile Number *"
                        value={newMember.phoneNumber}
                        onChange={(value) => setNewMember({...newMember, phoneNumber: value})}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Email <span className="text-muted-foreground font-normal">(optional)</span></Label>
                    <Input type="email" placeholder="john@example.com" value={newMember.email} onChange={e => setNewMember({...newMember, email: e.target.value})} />
                    <p className="text-xs text-muted-foreground">Not required, and not verified — the member signs in and verifies with their mobile number.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Temporary Password</Label>
                    <Input type="text" placeholder="Set a temporary password" value={newMember.password} onChange={e => setNewMember({...newMember, password: e.target.value})} />
                    <p className="text-xs text-muted-foreground">They will be forced to change this upon their first login.</p>
                  </div>

                  {/*
                    Access, set now or left for later. Collapsed by default —
                    a message rather than a silent default, so the admin sees
                    what a member can do before clicking Add, and an explicit
                    door to the same PermissionMatrix MembersScreen uses if
                    they'd rather set it at the same moment.
                  */}
                  {!showAccessEditor ? (
                    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
                      <div className="flex items-start gap-2">
                        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Added with <strong className="text-foreground">Contributor</strong> access
                          by default — they can view and add records in every module, but can&apos;t
                          edit, delete, or share until you grant it. You can change this anytime from
                          Manage Members.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowAccessEditor(true)}
                        className="self-start"
                      >
                        Customize access now
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 rounded-lg border bg-background p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Access</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setMemberPermissions(defaultPermissionsFor(chosenDestination?.scope === 'business' ? 'business' : 'personal'));
                            setShowAccessEditor(false);
                            hasEditedPermissionsRef.current = false;
                          }}
                        >
                          Use default access instead
                        </Button>
                      </div>
                      <PermissionMatrix
                        value={memberPermissions}
                        onChange={(next) => { hasEditedPermissionsRef.current = true; setMemberPermissions(next); }}
                        showPresets
                      />
                    </div>
                  )}

                  {/*
                    The destination on the button itself — the cheapest possible
                    confirmation of where the click lands, and the one place the
                    admin is actually looking when they commit.
                  */}
                  <Button onClick={handleAddMember} disabled={isAddingMember} className="w-full sm:w-auto mt-2">
                    {isAddingMember ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                    {destinations.length > 1 && chosenDestination
                      ? `Add Member to ${chosenDestination.label}`
                      : 'Add Member'}
                  </Button>
                </div>
                )}

                {/* List of added members */}
                {members.length > 0 && (
                  <div className="space-y-3 mt-6">
                    <h4 className="text-sm font-medium">Added Members</h4>
                    <div className="space-y-2">
                      {/*
                        Keyed by the number rather than the array index — it is
                        the member's identity, the server rejects a duplicate,
                        and an index key would reuse a row's state if this list
                        ever became removable.
                      */}
                      {members.map((fm) => (
                        <div key={fm.phoneNumber} className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                          <div>
                            <p className="font-medium text-sm">{fm.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {fm.phoneNumber || fm.email}
                              {/* Where they went. The list was as silent as the form was. */}
                              {fm.destination ? ` \u00b7 ${fm.destination}` : ''}
                            </p>
                          </div>
                          <CheckCircle2 className="text-emerald-500 h-5 w-5" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
            <CardFooter className="flex flex-col-reverse gap-3 border-t p-4 bg-muted/20 sm:flex-row sm:justify-between sm:p-6">
              <Button
                variant="ghost"
                className="w-full sm:w-auto"
                onClick={() => goTo(steps[Math.max(0, steps.indexOf(STEP_MEMBERS) - 1)])}
              >
                Back
              </Button>
              <Button onClick={handleNext} className={FOOTER_NEXT}>
                {members.length > 0 ? 'Continue' : 'Skip for now'} <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </CardFooter>
          </>
        )}

        {/* Finish */}
        {step === STEP_FINISH && (
          <>
            <CardHeader className="text-center pb-2">
              <div className="mx-auto bg-emerald-500/10 w-16 h-16 rounded-full flex items-center justify-center mb-4">
                <Check className="text-emerald-500 w-8 h-8" />
              </div>
              <CardTitle className="text-3xl">All Set!</CardTitle>
              <CardDescription className="text-base mt-2">
                Your tenant is configured and ready to go. You can always manage these settings later from the dashboard.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 pb-8 flex justify-center">
              <Button onClick={handleComplete} size="lg" className="px-8" disabled={isCompleting}>
                {isCompleting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                Go to Dashboard
              </Button>
            </CardContent>
          </>
        )}

      </Card>
    </BarePage>
  );
}
