'use client';

/**
 * The inputs for the two pointer types (0069) — `member` and `record_link`.
 * Rendered by <FieldInput> in ./CategoryFieldInputs.jsx; split out because each
 * fetches its own choices, which no other input does.
 *
 * Both hold the same STRING the rest of the form holds — see
 * src/lib/records/fieldRefs.ts for what that string means.
 */
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useMembers } from '@/hooks/useMembers';
import { encodeMemberRef, MEMBER_NAME_MAX, parseMemberRef } from '@/lib/records/fieldRefs';
import { linkedRecordLabel, useLinkedRecords } from './useLinkedRecords';

// Radix Select refuses an empty-string item value, so "nothing" and "someone
// outside the app" each need a sentinel.
const NONE = '__none__';
const OTHER = '__other__';

/**
 * A workspace member, or — via "Other" — a name typed for someone who is not
 * one. The typed name is stored as plain text; picking a member stores
 * `member:<uuid>`.
 */
export function MemberRefInput({
  spec, value, disabled, invalid, onChange, onBlur, registerRef,
}) {
  const { fieldKey } = spec;
  const { members } = useMembers();
  const ref = parseMemberRef(value);
  // "Other" with nothing typed yet has no stored value to recognise it by, so
  // the mode is remembered here.
  const [typing, setTyping] = useState(Boolean(ref && 'name' in ref));
  useEffect(() => {
    if (ref && 'name' in ref) setTyping(true);
    if (ref && 'memberId' in ref) setTyping(false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = typing ? OTHER : ref && 'memberId' in ref ? ref.memberId : NONE;
  const known = ref && 'memberId' in ref && members.some((m) => m.id === ref.memberId);

  return (
    <div className="flex flex-col gap-2">
      <Select
        value={selected}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === OTHER) { setTyping(true); onChange(fieldKey, ''); return; }
          setTyping(false);
          onChange(fieldKey, next === NONE ? '' : encodeMemberRef(next));
        }}
      >
        <SelectTrigger
          id={fieldKey}
          ref={(element) => registerRef?.(fieldKey, element)}
          aria-invalid={invalid}
          className={cn('text-base sm:text-sm', invalid && 'border-destructive')}
          onBlur={() => onBlur?.(spec)}
        >
          <SelectValue placeholder="Choose a member" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— Not set —</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
          ))}
          {/* A stored member who has since left the workspace still shows. */}
          {ref && 'memberId' in ref && !known && (
            <SelectItem value={ref.memberId}>Former member</SelectItem>
          )}
          <SelectItem value={OTHER}>Other (type a name)…</SelectItem>
        </SelectContent>
      </Select>
      {typing && (
        <Input
          aria-label={`${spec.fieldLabel} — name`}
          className={cn('text-base sm:text-sm', invalid && 'border-destructive')}
          value={ref && 'name' in ref ? ref.name : ''}
          maxLength={MEMBER_NAME_MAX}
          disabled={disabled}
          placeholder="e.g. Grandmother (Kamla Devi)"
          onChange={(e) => onChange(fieldKey, e.target.value)}
          onBlur={() => onBlur?.(spec)}
        />
      )}
    </div>
  );
}

/** A record of the category the spec's `linkTarget` names. */
export function RecordLinkInput({
  spec, value, disabled, invalid, onChange, onBlur, registerRef,
}) {
  const { fieldKey, linkTarget } = spec;
  const { records, loaded, forbidden } = useLinkedRecords(linkTarget);
  const current = value ? String(value) : '';
  const known = records.some((r) => r.id === current);

  if (!linkTarget) {
    // A shipped link always has a target; this is a misconfigured override.
    return <p className="text-xs text-muted-foreground">This field has nothing to link to.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <Select
        value={current || NONE}
        disabled={disabled || forbidden}
        onValueChange={(next) => onChange(fieldKey, next === NONE ? '' : next)}
      >
        <SelectTrigger
          id={fieldKey}
          ref={(element) => registerRef?.(fieldKey, element)}
          aria-invalid={invalid}
          className={cn('text-base sm:text-sm', invalid && 'border-destructive')}
          onBlur={() => onBlur?.(spec)}
        >
          <SelectValue placeholder={loaded ? 'Choose…' : 'Loading…'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— Not set —</SelectItem>
          {records.map((r) => (
            <SelectItem key={r.id} value={r.id}>{linkedRecordLabel(r)}</SelectItem>
          ))}
          {current && loaded && !known && (
            <SelectItem value={current}>Record removed</SelectItem>
          )}
        </SelectContent>
      </Select>
      {forbidden && (
        <p className="text-xs text-muted-foreground">You don&apos;t have access to the records this links to.</p>
      )}
      {loaded && !forbidden && records.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing to link to yet — add one first.</p>
      )}
    </div>
  );
}
