'use client';

/**
 * "Belongs to" — the one holder picker, used by every record module.
 *
 * ── WHY ONE COMPONENT ──────────────────────────────────────────────────────
 * Three pages had a picker and twelve did not, and the three that did each
 * inlined their own <Select> over their own users fetch, with their own
 * sentinel. Two of them fetched from /api/users, which is gated to
 * TENANT_ADMIN — so for a STANDARD user the dropdown rendered empty and the
 * feature simply appeared broken. This fetches /api/members, which every
 * role can call.
 *
 * ── ONE CONTROL, NOT TWO ───────────────────────────────────────────────────
 * `is_global` is DERIVED from this choice on the server (resolveHolder, in
 * src/lib/records/handler.ts): "All members" means no holder and global; a
 * member means that holder and not global. There is deliberately no separate
 * "Global" checkbox any more — warranty and rentals had one, and nothing stopped
 * it from contradicting the picker sitting next to it.
 *
 * ── THE "+" ────────────────────────────────────────────────────────────────
 * A picker whose answer is not in its own list is a dead end, and the scan
 * surfaces hit it constantly: the document plainly names someone who was never
 * added as a member, and the only way out was to abandon the half-filled
 * upload, walk to the Members screen, and start the document again.
 *
 * So the picker carries the way out. "+" opens the Members screen's add dialog
 * in a NEW TAB — deliberately not a navigation and deliberately not an
 * embedded quick-add form:
 *
 *   • a new tab because this form is never unmounted, so the attached file, the
 *     scan results and every typed field are still there when the user gets
 *     back. A same-tab navigation loses the file, and a File cannot be stashed
 *     and restored.
 *   • the real dialog rather than a cut-down copy because adding a member means
 *     a temporary password and a permission matrix, and a second, simpler,
 *     subtly-different add form is how those two drift apart.
 *
 * Admins only: `POST /api/users` is TENANT_ADMIN-gated, so for anyone else the
 * button is a promise the server would refuse. `canAddMembers` comes from
 * /api/members, which already knows who is asking.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * A label, not a permission. Who may see a record is decided by
 * `hasPermission(user, module, action)`. Assigning a holder does not hide a
 * record from anyone.
 */
import { useEffect, useRef, useState } from 'react';
import { Building2, Check, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useParams } from 'next/navigation';
import { useMembers } from '@/hooks/useMembers';
import { apiCall } from '@/lib/net/apiRequest';
import { indexMembers, normalizeName } from '@/lib/records/holderMatch';
import { companyNameMismatch, COMPANY_HOLDER } from '@/lib/records/holderScope';

/** The "no particular member" sentinel. `<Select>` cannot hold an empty value. */
export const ALL_MEMBERS = 'all';

/**
 * Normalise a record's stored holder into a value this control can show.
 * A null/absent `holder_id` is "All members".
 */
export function holderValue(holderId) {
  return holderId || ALL_MEMBERS;
}

/** Turn the control's value into what the API expects. */
export function holderPayload(value) {
  return value === ALL_MEMBERS ? '' : value;
}

/** Said when the control is empty and the form has been asked to save. */
export const HOLDER_REQUIRED_MESSAGE = 'Choose who this record belongs to';

/**
 * What a scan that could not fill this in should say.
 *
 * `/api/ai/scan` and `/autofill` both answer with the name they READ alongside
 * the member they matched it to, precisely so this can name it. "No member
 * is called Rajesh Kumar" tells the user what happened and what to do;
 * an unexplained red box tells them neither, and the three surfaces that show
 * it should not each invent their own wording.
 *
 * @param scannedName The name the scan read, or '' when it read none.
 * @param compact Short enough for a review-grid cell. The full sentence is
 *   right under a form field with a column to itself; in the bulk-scan grid the
 *   picker is 11rem wide and the same sentence wraps to four lines, pushing the
 *   row it is warning about off screen.
 */
export function unmatchedHolderError(scannedName, { compact = false } = {}) {
  const name = typeof scannedName === 'string' ? scannedName.trim() : '';
  if (compact) {
    return name ? `“${name}” is not a member` : 'Pick who this belongs to';
  }
  return name
    ? `The scan read “${name}” — no member by that name. Choose one, or + to add them.`
    : `${HOLDER_REQUIRED_MESSAGE} — the scan found no name.`;
}

export default function HolderSelect({
  value,
  onChange,
  disabled = false,
  id = 'holderId',
  label = 'Belongs to',
  className = '',
  /**
   * Force an explicit choice: no value is preselected, and the trigger shows a
   * prompt until the user picks a member or "All members".
   *
   * Off by default, which keeps the EDIT forms exactly as they were — there a
   * stored null genuinely means all members, and demanding a re-choice
   * would reassign records on save. Every ADD-with-a-scan surface opts IN
   * (the sub-category form, /documents, the Power Scan grid), because
   * defaulting a person's document to the whole household is the kind of wrong
   * that nobody notices until they go looking for it.
   *
   * "All members" is not taken away by this — it stays the first item in the
   * list. It just has to be chosen rather than assumed.
   */
  required = false,
  /** Server- or client-side error for this control. */
  error = '',
  /**
   * The name a scan READ but could not place — `holderNameFromScan` on the
   * bulk-scan row, `holderName` off /autofill, and the same on /api/ai/scan.
   *
   * It does two things, and only on the surfaces that have one: it pre-fills
   * the add dialog so the admin is not retyping a name that is already on
   * screen, and it lets this control finish the job by itself when the member
   * comes back — see the auto-select effect below. A hand-typed record has no
   * scanned name, so its "+" opens an empty dialog, which is the same outcome
   * one field later.
   */
  suggestedName = '',
  /**
   * The Power Scan grid's 11rem cell. The company rename opens in a dialog
   * there rather than inline — an inline input that narrow shows six letters
   * of the name being corrected — and the scan hint uses its short form.
   */
  compact = false,
}) {
  const { members, canAddMembers } = useMembers();
  /**
   * ── "BELONGS TO" MEANS SOMETHING ELSE IN A COMPANY ───────────────────────
   *
   * In the personal vault a record belongs to a MEMBER. In a company workspace
   * it belongs to the COMPANY — that is the whole of the business ownership
   * axis, and it is already decided by the URL the user is standing in.
   *
   * So the picker DEFAULTS to the company — `documents.company_id` is set from
   * the gated request whatever is chosen here — and offers that company's own
   * members as a refinement: a director's PAN, an employee's offer letter. The
   * list is the company's (`useMembers` keys by the same path id), "+" adds a
   * member TO THIS COMPANY, and the write refuses anyone else
   * (records/workspaceMembers.ts). Nothing is required: an untouched picker
   * files the record under the company, exactly as before.
   *
   * The company's NAME is correctable here too (the pencil), because the name
   * typed at sign-up is often not the one on the documents.
   *
   * Read from the path rather than passed as a prop because every one of this
   * control's call sites — the sub-category form, the manager, the scan grid —
   * already renders inside the workspace that decides it.
   */
  const { companyId } = useParams() || {};
  const [companyName, setCompanyName] = useState('');
  /**
   * The inline rename. `null` when not editing, else the draft name.
   *
   * Inline for the same reason "+" opens a new tab rather than navigating: this
   * form is never unmounted, and the attached file and scan results must still
   * be here when the name is fixed. The name typed at sign-up is often not the
   * one on the documents ("Acme" vs "Acme Pvt Ltd"), and before this there was
   * no screen that could change it — only `PUT /api/companies/<id>`.
   */
  const [renameDraft, setRenameDraft] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  // Bumped when ANY picker renames the company: the Power Scan grid renders one
  // of these per row, and each holds its own copy of the name.
  const [companyVersion, setCompanyVersion] = useState(0);

  useEffect(() => {
    if (!companyId) return;
    const bump = () => setCompanyVersion((v) => v + 1);
    window.addEventListener('docsnx:companies-changed', bump);
    return () => window.removeEventListener('docsnx:companies-changed', bump);
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const { json } = await apiCall('/api/companies');
        if (cancelled || !json?.success) return;
        const hit = (json.companies || []).find((c) => c.id === companyId);
        // Falls back to nothing rather than to the raw id: a UUID under
        // "Belongs to" is noise, and the field is not load-bearing here.
        if (hit) setCompanyName(hit.name);
      } catch {
        // A failed lookup costs a label, not the form.
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, companyVersion]);

  // Held in a ref because callers pass an inline arrow, so `onChange` is a new
  // function on every render and would otherwise re-run the effect below.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /**
   * Adopt the member the scan named, once they exist.
   *
   * `useMembers` re-fetches when this tab regains focus, which is exactly the
   * moment the admin comes back from having added them — so the picker that
   * sent them there is the one that fills itself in. Guarded on an EMPTY value:
   * a choice already made, by hand or by the scan, is never overwritten.
   *
   * `indexMembers` maps a name two members share to `null`, and that is the
   * right answer to act on — pick nobody rather than file a passport under the
   * wrong sibling.
   */
  useEffect(() => {
    if (!suggestedName || value) return;
    const key = normalizeName(suggestedName);
    if (!key) return;
    const matched = indexMembers(members).get(key);
    if (matched) onChangeRef.current(matched);
  }, [members, suggestedName, value]);

  const openAddMember = () => {
    const params = new URLSearchParams({ add: '1', close: '1' });
    if (suggestedName) params.set('name', suggestedName);
    // In a company, ITS Members screen: that is what adds the person to this
    // company rather than to the household.
    const path = companyId ? `/business/${companyId}/users` : '/users';
    // window.open, not <a target="_blank">: the Members tab closes ITSELF once
    // the member is added, and window.close() is only reliable for a window
    // that a script opened. Called straight from the click, so it counts as a
    // user gesture and is not treated as a pop-up.
    const opened = window.open(`${path}?${params.toString()}`, '_blank');
    // Blocked anyway? Then a same-tab navigation, which costs this form but
    // does not strand the user with a button that does nothing.
    if (!opened) window.location.assign(`${path}?${params.toString()}`);
  };

  const startRename = (name) => {
    setRenameError('');
    setRenameDraft(name);
  };

  const saveRename = async () => {
    const name = (renameDraft || '').trim();
    if (!name) {
      setRenameError('A company name is required');
      return;
    }
    if (name === companyName) {
      setRenameDraft(null);
      return;
    }
    setRenaming(true);
    try {
      const { json } = await apiCall(`/api/companies/${companyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!json?.success) {
        setRenameError(json?.error || 'Could not rename the company');
        return;
      }
      setCompanyName(json.company?.name || name);
      setRenameDraft(null);
      toast.success('Company renamed');
      // The sidebar, switcher and tabs hold their own copy of the name, read
      // from /api/auth/me — Shell listens for this and re-reads it.
      window.dispatchEvent(new Event('docsnx:companies-changed'));
    } finally {
      setRenaming(false);
    }
  };

  const addMemberButton = canAddMembers && (
    <Button
      // type="button" is load-bearing: this control sits inside <form>s
      // whose submit handler saves the record, and a bare <button>
      // defaults to type="submit".
      type="button"
      variant="outline"
      size="icon"
      className="h-10 w-10 shrink-0"
      onClick={openAddMember}
      disabled={disabled}
      aria-label="Add a member"
      title="Add a member"
    >
      <Plus size={16} />
    </Button>
  );

  if (companyId) {
    // `canAddMembers` is `role === 'TENANT_ADMIN'` — the same gate the rename
    // route enforces, so a non-admin is never offered a 403.
    const canRename = canAddMembers && !disabled;
    const memberChosen = Boolean(value) && value !== COMPANY_HOLDER && value !== ALL_MEMBERS;
    // Only worth saying while nothing explains the name: once a member is
    // picked (or auto-adopted), the name on the document is accounted for.
    const scannedOther = memberChosen ? null : companyNameMismatch(companyName, suggestedName);
    const shownError = renameError || error;
    const companyLabel = companyName || 'This company';
    const editingInline = renameDraft !== null && !compact;

    const renameControls = (
      <Input
        id={compact ? `${id}-rename` : id}
        value={renameDraft ?? ''}
        autoFocus
        maxLength={255}
        disabled={renaming}
        aria-label="Company name"
        className={`flex-1 min-w-0 ${renameError ? 'border-destructive' : ''}`}
        onChange={(e) => { setRenameDraft(e.target.value); setRenameError(''); }}
        onKeyDown={(e) => {
          // Enter must not submit the record form this sits inside.
          if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
          if (e.key === 'Escape') { e.preventDefault(); setRenameDraft(null); }
        }}
      />
    );

    return (
      <div className={`flex flex-col gap-1.5 ${className}`}>
        {label ? <Label htmlFor={id}>{label}</Label> : null}
        {editingInline ? (
          <div className="flex items-center gap-1.5">
            {renameControls}
            <Button
              type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0"
              onClick={saveRename} disabled={renaming}
              aria-label="Save company name" title="Save company name"
            >
              <Check size={16} />
            </Button>
            <Button
              type="button" variant="ghost" size="icon" className="h-10 w-10 shrink-0"
              onClick={() => { setRenameDraft(null); setRenameError(''); }} disabled={renaming}
              aria-label="Cancel rename" title="Cancel"
            >
              <X size={16} />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Select
              // Empty — an untouched add form — shows the company, which is
              // what an untouched picker files the record under. 'all' is what
              // an edit form seeds for a null holder; in a company that is the
              // company too.
              value={memberChosen ? value : COMPANY_HOLDER}
              onValueChange={onChange}
              disabled={disabled}
            >
              {/* [&>span]:min-w-0 + the inner `truncate`: the trigger's own
                  line-clamp stops at its direct child, and the company item is
                  a flex row, so a long company name wrapped to three lines in
                  the h-10 trigger and spilled over the scan hint below it. */}
              <SelectTrigger
                id={id}
                title={memberChosen ? undefined : companyLabel}
                className={`flex-1 min-w-0 text-left [&>span]:min-w-0 ${shownError ? 'border-destructive' : ''}`}
              >
                <SelectValue placeholder={companyLabel} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={COMPANY_HOLDER}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Building2 size={14} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{companyLabel}</span>
                  </span>
                </SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {/* Still offered: sign-in off is when the admin files for them. */}
                    <span className="block truncate">
                      {m.name}{m.signInDisabled ? ' (sign-in off)' : ''}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {addMemberButton}
            {canRename && companyName && !compact && (
              <Button
                type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0"
                onClick={() => startRename(companyName)}
                aria-label="Rename company" title="Rename company"
              >
                <Pencil size={16} />
              </Button>
            )}
          </div>
        )}
        {scannedOther && !editingInline ? (
          <div className="text-xs text-muted-foreground break-words">
            {compact ? <>“{scannedOther}” on document</> : <>The document reads “{scannedOther}”.</>}
            {canRename ? (
              <span className="flex flex-wrap gap-x-3">
                <Button
                  type="button" variant="link" className="h-auto p-0 text-xs font-medium"
                  onClick={() => startRename(scannedOther)}
                >
                  Use as company name
                </Button>
                <Button
                  type="button" variant="link" className="h-auto p-0 text-xs font-medium"
                  onClick={openAddMember}
                >
                  Add as member
                </Button>
              </span>
            ) : null}
          </div>
        ) : null}
        {shownError && !(compact && renameDraft !== null) ? (
          <p className="text-xs font-medium text-danger-text">{shownError}</p>
        ) : null}
        {compact ? (
          <Dialog
            open={renameDraft !== null}
            onOpenChange={(open) => { if (!open) { setRenameDraft(null); setRenameError(''); } }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Rename company</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                {renameControls}
                {renameError ? <p className="text-xs font-medium text-danger-text">{renameError}</p> : null}
              </div>
              <DialogFooter>
                <Button
                  type="button" variant="outline"
                  onClick={() => { setRenameDraft(null); setRenameError(''); }} disabled={renaming}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={saveRename} disabled={renaming}>
                  Save company name
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label ? (
        <Label htmlFor={id}>
          {label}
          {required && <span className="text-danger-text ml-0.5">*</span>}
        </Label>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Select
          /**
           * `''`, never `undefined`, for the required case.
           *
           * Radix reads `undefined` as UNCONTROLLED, so a row the scan could
           * not place started uncontrolled and flipped to controlled the moment
           * anyone picked a member — one "Select is changing from uncontrolled
           * to controlled" per unplaced row in the Power Scan grid, which is
           * every row of a batch whose names did not match a member exactly.
           *
           * `''` is defined, so the control is controlled for its whole life,
           * and Radix shows the placeholder for it exactly as it did for
           * `undefined` (`shouldShowPlaceholder` accepts both).
           */
          value={required ? (value || '') : (value || ALL_MEMBERS)}
          onValueChange={onChange}
          disabled={disabled}
        >
          {/* flex-1 min-w-0 rather than the trigger's own w-full: this sits in
              the Power Scan grid inside an 11rem cell, and the trigger has to
              be allowed to shrink so the button beside it is not pushed out. */}
          <SelectTrigger
            id={id}
            className={`flex-1 min-w-0 ${error ? 'border-destructive' : ''}`}
          >
            <SelectValue placeholder={required ? 'Select a member' : 'All members'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_MEMBERS}>All members</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {addMemberButton}
      </div>
      {error ? <p className="text-xs font-medium text-danger-text">{error}</p> : null}
    </div>
  );
}
