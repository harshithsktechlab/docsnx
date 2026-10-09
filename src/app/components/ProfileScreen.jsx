'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  User,
  GraduationCap,
  ShoppingBag,
  Scale,
  Save,
  Loader2,
  Building2,
  Landmark,
  MapPin,
  Phone,
  FileText,
  Upload,
  Eye,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import { clientGetMe, clientCan } from '@/lib/clientAuth';
import { postUpload, uploadErrorMessage } from '@/lib/records/uploadRequest';
import { prepareUploadFile } from '@/lib/records/fileSnapshot';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import { BLOOD_GROUPS, normaliseBloodGroup, parseBirthPlace } from '@/lib/profileValues';
import PlanQuotaMeters from '@/app/components/PlanQuotaMeters';
import { getInitials } from '@/lib/accountMenu';

/** The member form's four sections. At module scope so `openTabFrom` below can
 *  validate a deep link against the very list the strip renders. */
const MY_PROFILE_TABS = [
  { value: 'personal', label: 'Personal', icon: User },
  { value: 'education', label: 'Education', icon: GraduationCap },
  { value: 'shopping', label: 'Shopping', icon: ShoppingBag },
  { value: 'legal', label: 'Legal / ID', icon: Scale },
];

/**
 * The ID cards the Legal / ID tab links to the Document Manager. Mirrors
 * PROFILE_ID_DOCUMENTS in lib/profileUpdater.ts — the server answers under
 * these kinds, and the field key is the category's own.
 */
const ID_DOCUMENT_KINDS = {
  pan: { documentKey: 'pan_card', fieldKey: 'pan_number', legalKey: 'panNumber', title: 'PAN Card' },
  aadhaar: { documentKey: 'aadhaar_card', fieldKey: 'aadhaar_number', legalKey: 'aadhaarNumber', title: 'Aadhaar Card' },
  passport: { documentKey: 'passport', fieldKey: 'passport_number', legalKey: 'passportNumber', title: 'Passport' },
};

/**
 * The file half of one ID number: the card on file in the Document Manager, or
 * a button to file one. There is no profile-only copy — an upload here is an
 * ordinary `/api/documents` record, so it shows up in Document Management too.
 */
function IdDocumentControl({ kind, entry, busy, disabled, onPick }) {
  if (!entry) return null;
  const inputId = `id-doc-${kind}`;
  const doc = entry.document;
  const label = ID_DOCUMENT_KINDS[kind].title;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mt-1">
      {doc ? (
        <>
          <span className="flex items-center gap-1.5 text-muted-foreground min-w-0">
            <FileText size={13} className="text-primary shrink-0" />
            <span className="truncate max-w-[240px]" title={doc.fileName || doc.title}>
              On file in Document Management{doc.fileName ? ` \u2014 ${doc.fileName}` : ''}
            </span>
          </span>
          {doc.fileUrl && (
            <a
              href={doc.fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
            >
              <Eye size={13} /> View
            </a>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">No {label} file in Document Management yet.</span>
      )}
      {entry.canUpload && entry.categoryId && (
        <>
          <input
            id={inputId}
            type="file"
            accept={UPLOAD_ACCEPT_ATTRIBUTE}
            className="hidden"
            disabled={busy || disabled}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              // Synchronous, before any await: clearing `value` discards `files`.
              e.target.value = '';
              if (picked) onPick(kind, picked);
            }}
          />
          <label
            htmlFor={inputId}
            className={`inline-flex items-center gap-1 font-semibold text-primary ${busy || disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer hover:underline'}`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {busy ? 'Uploading\u2026' : doc ? 'Replace file' : `Upload ${label}`}
          </label>
        </>
      )}
    </div>
  );
}

/**
 * The City half of Place of Birth: type to search ~7,000 Indian cities and
 * towns, pick one, and its state comes with it. Names repeat across states, so
 * every row says which state it is in. With a state chosen, only that state's
 * cities are offered.
 */
function CityCombobox({ places, stateName, value, onSelect, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  const stateNameByCode = useMemo(
    () => new Map((places?.states || []).map((s) => [s.code, s.name])),
    [places],
  );
  const stateCode = useMemo(
    () => (places?.states || []).find((s) => s.name === stateName)?.code ?? null,
    [places, stateName],
  );

  const matches = useMemo(() => {
    if (!places) return [];
    const q = query.trim().toLowerCase();
    const pool = stateCode ? places.cities.filter(([, code]) => code === stateCode) : places.cities;
    if (!q) return pool.slice(0, 50);
    const starts = [];
    const contains = [];
    for (const entry of pool) {
      const name = entry[0].toLowerCase();
      if (name.startsWith(q)) starts.push(entry);
      else if (name.includes(q)) contains.push(entry);
      if (starts.length >= 50) break;
    }
    return starts.concat(contains).slice(0, 50);
  }, [places, query, stateCode]);

  const choose = (entry) => {
    onSelect(entry[0], stateNameByCode.get(entry[1]) || '');
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && matches[active]) {
        e.preventDefault();
        choose(matches[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery(value || '');
    }
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="relative">
      <Input
        id="birthCity"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="birthCity-list"
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={places ? 'Search city or town' : 'Loading cities\u2026'}
        value={open ? query : (value || '')}
        disabled={disabled || !places}
        onFocus={() => { setQuery(value || ''); setActive(0); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onBlur={() => {
          // Emptying the box and leaving it clears the city; anything else
          // that was not picked from the list reverts to the saved city.
          if (open && !query.trim() && value) onSelect('', stateName);
          setOpen(false);
        }}
        onKeyDown={onKeyDown}
      />
      {open && places && (
        <ul
          id="birthCity-list"
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-popover p-1 text-sm shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">No matching city{stateName ? ` in ${stateName}` : ''}</li>
          ) : matches.map((entry, i) => (
            <li
              key={`${entry[0]}|${entry[1]}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: the input's blur closes the list first.
              onMouseDown={(e) => { e.preventDefault(); choose(entry); }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 ${i === active ? 'bg-muted text-foreground' : 'text-foreground'}`}
            >
              <span className="truncate">{entry[0]}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{stateNameByCode.get(entry[1])}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The company form's four sections, for the same reason. */
const COMPANY_SECTIONS = [
  { value: 'identity', label: 'Identity', icon: Building2 },
  { value: 'tax', label: 'Tax & Registration', icon: Landmark },
  { value: 'address', label: 'Address', icon: MapPin },
  { value: 'contact', label: 'Contact', icon: Phone },
];

/**
 * Which section a link asked for, or `null` for "whatever the form opens with".
 *
 * The dashboard's setup checklist links straight at the form that fixes a row —
 * `/profile?tab=legal`, `/business/<id>/profile?section=tax`. Both tab strips
 * were local state, so those links landed on the first tab and left the reader
 * to find the field themselves.
 *
 * Read from `window.location` rather than `useSearchParams()`, which is the
 * same choice /settings makes for its `?google=` status: the hook forces every
 * page rendering this component behind a Suspense boundary, and there are two of
 * them. Callers run it in an effect, so `window` is always there.
 *
 * An unknown value is ignored rather than honoured — a typo must not render an
 * empty form with no tab lit.
 */
function openTabFrom(param, allowed) {
  const wanted = new URLSearchParams(window.location.search).get(param);
  return wanted && allowed.some((t) => t.value === wanted) ? wanted : null;
}

function MyProfileSection({ heading = true }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  
  const [activeTab, setActiveTab] = useState('personal');

  // Deep link: /profile?tab=legal opens the Legal / ID form. In an effect and
  // not a lazy initialiser, because this component is prerendered on the server
  // where there is no `window`, and a value that differs between the two
  // renders is a hydration mismatch.
  useEffect(() => {
    const wanted = openTabFrom('tab', MY_PROFILE_TABS);
    if (wanted) setActiveTab(wanted);
  }, []);

  // Personal Fields
  const [dob, setDob] = useState('');
  const [bloodGroup, setBloodGroup] = useState('');
  const [gender, setGender] = useState('');
  // Place of Birth: state and city from the India list. `legacyBirthPlace` is
  // a free-text value saved before the dropdowns, kept until it is replaced.
  const [birthState, setBirthState] = useState('');
  const [birthCity, setBirthCity] = useState('');
  const [legacyBirthPlace, setLegacyBirthPlace] = useState('');
  const [indiaPlaces, setIndiaPlaces] = useState(null);

  // Education Fields
  const [degree, setDegree] = useState('');
  const [college, setCollege] = useState('');
  const [yearOfPassing, setYearOfPassing] = useState('');

  // Shopping Fields
  const [clothingSize, setClothingSize] = useState('');
  const [shoeSize, setShoeSize] = useState('');
  const [brandPreferences, setBrandPreferences] = useState('');

  // Legal Fields
  const [panNumber, setPanNumber] = useState('');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [passportNumber, setPassportNumber] = useState('');

  const [saving, setSaving] = useState(false);

  // The Legal / ID tab's files — the Document Manager's identity records.
  const [idDocuments, setIdDocuments] = useState(null);
  const [uploadingKind, setUploadingKind] = useState(null);
  // A 409 from the upload, waiting on the duplicate prompt's answer.
  const [pendingDuplicate, setPendingDuplicate] = useState(null);

  useEffect(() => {
    async function loadProfile() {
      try {
        const { json } = await apiCall('/api/profiles');
        if (json.success && json.profile) {
          setProfile(json.profile);
          
          const personal = json.profile.personalDetails || {};
          setDob(personal.dob || '');
          setBloodGroup(normaliseBloodGroup(personal.bloodGroup));
          setGender(personal.gender || '');
          setBirthState(personal.birthState || '');
          setBirthCity(personal.birthCity || '');
          setLegacyBirthPlace(personal.birthState || personal.birthCity ? '' : (personal.birthPlace || ''));

          const edu = json.profile.educationDetails || {};
          setDegree(edu.degree || '');
          setCollege(edu.college || '');
          setYearOfPassing(edu.yearOfPassing || '');

          const shop = json.profile.shoppingDetails || {};
          setClothingSize(shop.clothingSize || '');
          setShoeSize(shop.shoeSize || '');
          setBrandPreferences(shop.brandPreferences || '');

          const legal = json.profile.legalDetails || {};
          setPanNumber(legal.panNumber || '');
          setAadhaarNumber(legal.aadhaarNumber || '');
          setPassportNumber(legal.passportNumber || '');
          setIdDocuments(json.idDocuments || null);
        } else {
          toast.error(json.error || 'Failed to load profile');
        }
      } catch (err) {
        // Transport failures are values now, not throws — `apiCall` and
        // `postUpload` return them. So reaching this catch means a bug in the
        // block above, and calling that a network error sent people to check
        // a connection that was working.
        console.error('[profile] handler threw', err);
        toast.error('Something went wrong loading profile. Please try again.');
      } finally {
        setLoading(false);
      }
    }
    loadProfile();
  }, []);

  // ~135 KB of places, fetched only once the Personal tab is open.
  useEffect(() => {
    if (activeTab !== 'personal' || indiaPlaces) return;
    let cancelled = false;
    import('@/data/indiaPlaces.json')
      .then((mod) => { if (!cancelled) setIndiaPlaces(mod.default || mod); })
      .catch((err) => console.error('[profile] could not load the city list', err));
    return () => { cancelled = true; };
  }, [activeTab, indiaPlaces]);

  // A place of birth typed before the dropdowns existed: matched onto the list
  // where it can be, otherwise left showing as a hint.
  useEffect(() => {
    if (!indiaPlaces || !legacyBirthPlace) return;
    const parsed = parseBirthPlace(legacyBirthPlace, indiaPlaces);
    if (parsed.state) setBirthState(parsed.state);
    if (parsed.city) {
      setBirthCity(parsed.city);
      setLegacyBirthPlace('');
    }
  }, [indiaPlaces, legacyBirthPlace]);

  const birthPlace = birthCity && birthState
    ? `${birthCity}, ${birthState}`
    : (birthCity || birthState || legacyBirthPlace);

  const idNumberState = {
    pan: [panNumber, setPanNumber],
    aadhaar: [aadhaarNumber, setAadhaarNumber],
    passport: [passportNumber, setPassportNumber],
  };

  /**
   * File an ID card from the profile. It goes through `/api/documents` — the
   * Document Manager's own upload — so encryption, duplicate checks, the audit
   * line and the profile sync are all that route's, and the card is listed in
   * Document Management like any other.
   *
   * The number is the one typed above; when that is blank it is read off the
   * card first, and the user is asked to type it only if that read fails.
   *
   * `answer` is the duplicate prompt's reply when this is a re-post of a 409.
   */
  const uploadIdDocument = async (kind, picked, answer = null) => {
    const def = ID_DOCUMENT_KINDS[kind];
    const entry = idDocuments?.[kind];
    if (!entry?.categoryId || !profile?.userId) return;

    setUploadingKind(kind);
    try {
      let file = picked;
      if (!answer) {
        const prepared = await prepareUploadFile(picked);
        if (!prepared.ok) {
          toast.error(prepared.error);
          return;
        }
        file = prepared.file;
      }

      const [typed, setTyped] = idNumberState[kind];
      let number = String(typed || '').trim();
      if (!number) {
        const body = new FormData();
        body.append('file', file);
        const read = await postUpload(`/api/modules/identity/${def.documentKey}/autofill`, body);
        number = String(read.json?.success ? (read.json.fields?.[def.fieldKey] ?? '') : '').trim();
        if (!number) {
          toast.error(`Could not read the number off this ${def.title}. Type it in above, then upload again.`);
          return;
        }
      }

      const formData = new FormData();
      formData.append('files', file);
      formData.append('title', def.title);
      formData.append('categoryId', entry.categoryId);
      formData.append('holderId', profile.userId);
      formData.append('taxonomyFields', 'true');
      formData.append('metadata', JSON.stringify({ [def.fieldKey]: number }));
      if (answer === 'replace' && pendingDuplicate?.match?.existingId) {
        formData.append('replaceId', pendingDuplicate.match.existingId);
      } else if (answer === 'keepBoth') {
        formData.append('keepBoth', 'true');
      } else if (entry.document?.id) {
        // "Replace file" on a card already on file writes onto that record.
        formData.append('replaceId', entry.document.id);
      }

      const upload = await postUpload('/api/documents', formData);
      if (upload.status === 409 && upload.json?.requiresConfirmation) {
        setPendingDuplicate({ kind, file, match: upload.json });
        return;
      }
      if (!upload.ok || !upload.json?.success) {
        const fieldError = upload.json?.fieldErrors?.[def.fieldKey];
        toast.error(fieldError || upload.json?.error || uploadErrorMessage(upload, 'document'));
        return;
      }

      setPendingDuplicate(null);
      setTyped(number);
      toast.success(`${def.title} saved \u2014 it is in Document Management too.`);

      // Refresh only the cards and the number the upload synced, so unsaved
      // edits elsewhere on the form are left alone.
      const { json } = await apiCall('/api/profiles');
      if (json?.success) {
        setIdDocuments(json.idDocuments || null);
        const synced = json.profile?.legalDetails?.[def.legalKey];
        if (synced) setTyped(synced);
      }
    } catch (err) {
      console.error('[profile] ID upload handler threw', err);
      toast.error('Something went wrong uploading this document. Please try again.');
    } finally {
      setUploadingKind(null);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();

    setSaving(true);

    const payload = {
      personalDetails: { dob, bloodGroup, gender, birthPlace, birthState, birthCity },
      educationDetails: { degree, college, yearOfPassing },
      shoppingDetails: { clothingSize, shoeSize, brandPreferences },
      legalDetails: { panNumber, aadhaarNumber, passportNumber },
    };

    try {
      const { json } = await apiCall('/api/profiles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (json.success) {
        toast.success('Profile updated successfully!');
      } else {
        toast.error(json.error || 'Failed to save profile');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[profile] handler threw', err);
      toast.error('Something went wrong saving profile. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-80 w-full rounded-2xl" />
      </>
    );
  }

  const tabs = MY_PROFILE_TABS;

  return (
    <>
      {/* Header. Suppressed inside a company, where the page already has one
          naming the company and the outer tab already says whose details these
          are — two headings there read as two pages stacked. */}
      {heading && (
        <div className="flex flex-col gap-1 mb-2 animate-fade-in">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">My Profile</h1>
          <p className="text-muted-foreground text-sm">Manage personal details and size configurations</p>
        </div>
      )}

      {/* Save status flags */}


      {/* Tabs Toolbar */}
      <div className="flex flex-wrap gap-2 p-1.5 rounded-xl bg-muted/40 border border-border/55 w-fit animate-fade-in stagger-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200 ${
                active 
                  ? 'bg-primary text-primary-foreground shadow' 
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <Icon size={14} /> 
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Form Content */}
      <form onSubmit={handleSave} className="animate-fade-in stagger-2">
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8">
          <CardContent className="p-0 flex flex-col gap-6">
            
            {/* Personal Details Tab */}
            {activeTab === 'personal' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <User size={18} className="text-primary" /> Personal Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dob">Date of Birth</Label>
                    <Input
                      id="dob"
                      type="date"
                      value={dob}
                      onChange={(e) => setDob(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="bloodGroup">Blood Group</Label>
                    <Select value={bloodGroup} onValueChange={(val) => setBloodGroup(val)} disabled={saving}>
                      <SelectTrigger id="bloodGroup">
                        <SelectValue placeholder="Select Blood Group" />
                      </SelectTrigger>
                      <SelectContent>
                        {BLOOD_GROUPS.map((g) => (
                          <SelectItem key={g} value={g}>{g}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="gender">Gender</Label>
                    <Select value={gender} onValueChange={(val) => setGender(val)} disabled={saving}>
                      <SelectTrigger id="gender">
                        <SelectValue placeholder="Select Gender" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="male">Male</SelectItem>
                        <SelectItem value="female">Female</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="birthState">Place of Birth — State</Label>
                    <Select
                      value={birthState}
                      onValueChange={(val) => {
                        setBirthState(val);
                        // A city from another state no longer fits.
                        const code = indiaPlaces?.states.find((s) => s.name === val)?.code;
                        if (birthCity && !indiaPlaces?.cities.some(([n, c]) => n === birthCity && c === code)) {
                          setBirthCity('');
                        }
                      }}
                      disabled={saving || !indiaPlaces}
                    >
                      <SelectTrigger id="birthState">
                        <SelectValue placeholder={indiaPlaces ? 'Select State' : 'Loading states\u2026'} />
                      </SelectTrigger>
                      <SelectContent>
                        {(indiaPlaces?.states || []).map((st) => (
                          <SelectItem key={st.code} value={st.name}>{st.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="birthCity">Place of Birth — City</Label>
                    <CityCombobox
                      places={indiaPlaces}
                      stateName={birthState}
                      value={birthCity}
                      disabled={saving}
                      onSelect={(city, stateName) => {
                        setBirthCity(city);
                        if (stateName) setBirthState(stateName);
                        setLegacyBirthPlace('');
                      }}
                    />
                  </div>
                  {legacyBirthPlace && !birthCity && (
                    <p className="text-xs text-muted-foreground md:col-span-2 -mt-2">
                      Previously saved: <span className="font-medium text-foreground">{legacyBirthPlace}</span> — pick the state and city above to replace it.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Education Details Tab */}
            {activeTab === 'education' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <GraduationCap size={18} className="text-primary" /> Education Details
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <Label htmlFor="degree">Highest Degree</Label>
                    <Input
                      id="degree"
                      type="text"
                      placeholder="e.g. Master of Business Administration"
                      value={degree}
                      onChange={(e) => setDegree(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="college">College / University</Label>
                    <Input
                      id="college"
                      type="text"
                      placeholder="e.g. Stanford University"
                      value={college}
                      onChange={(e) => setCollege(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="yearOfPassing">Year of Passing</Label>
                    <Input
                      id="yearOfPassing"
                      type="number"
                      placeholder="e.g. 2018"
                      value={yearOfPassing}
                      onChange={(e) => setYearOfPassing(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Shopping Details Tab */}
            {activeTab === 'shopping' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <ShoppingBag size={18} className="text-primary" /> Shopping Preferences
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="clothingSize">Clothing Size (Shirt / Top)</Label>
                    <Input
                      id="clothingSize"
                      type="text"
                      placeholder="e.g. M, L, 40, XL"
                      value={clothingSize}
                      onChange={(e) => setClothingSize(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="shoeSize">Shoe Size (UK/US/EU)</Label>
                    <Input
                      id="shoeSize"
                      type="text"
                      placeholder="e.g. UK 9"
                      value={shoeSize}
                      onChange={(e) => setShoeSize(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <Label htmlFor="brandPreferences">Preferred Brands / Shopping Notes</Label>
                    <Textarea
                      id="brandPreferences"
                      placeholder="e.g. Prefers Nike for shoes, Levi's for jeans. Prefers organic cotton."
                      value={brandPreferences}
                      onChange={(e) => setBrandPreferences(e.target.value)}
                      rows={4}
                      disabled={saving}
                      className="resize-none"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Legal Details Tab */}
            {activeTab === 'legal' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <Scale size={18} className="text-primary" /> Legal & ID Documents
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="panNumber">PAN Card Number</Label>
                    <Input
                      id="panNumber"
                      type="text"
                      placeholder="ABCDE1234F"
                      value={panNumber}
                      onChange={(e) => setPanNumber(e.target.value.toUpperCase())}
                      disabled={saving}
                      className="font-mono uppercase"
                    />
                    <IdDocumentControl kind="pan" entry={idDocuments?.pan} busy={uploadingKind === 'pan'} disabled={saving || !!uploadingKind} onPick={uploadIdDocument} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="aadhaarNumber">Aadhaar Card Number</Label>
                    <Input
                      id="aadhaarNumber"
                      type="text"
                      placeholder="1234 5678 9012"
                      value={aadhaarNumber}
                      onChange={(e) => setAadhaarNumber(e.target.value.replace(/[^0-9]/g, ''))}
                      disabled={saving}
                      className="font-mono"
                    />
                    <IdDocumentControl kind="aadhaar" entry={idDocuments?.aadhaar} busy={uploadingKind === 'aadhaar'} disabled={saving || !!uploadingKind} onPick={uploadIdDocument} />
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <Label htmlFor="passportNumber">Passport Number</Label>
                    <Input
                      id="passportNumber"
                      type="text"
                      placeholder="A1234567"
                      value={passportNumber}
                      onChange={(e) => setPassportNumber(e.target.value.toUpperCase())}
                      disabled={saving}
                      className="font-mono uppercase"
                    />
                    <IdDocumentControl kind="passport" entry={idDocuments?.passport} busy={uploadingKind === 'passport'} disabled={saving || !!uploadingKind} onPick={uploadIdDocument} />
                  </div>
                </div>
              </div>
            )}

            <Button type="submit" disabled={saving} className="w-full md:w-auto h-11 px-6 mt-4">
              {saving ? (
                <>
                  <Loader2 size={17} className="animate-spin" />
                  Saving changes...
                </>
              ) : (
                <>
                  <Save size={17} />
                  Save Profile Section
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </form>

      {/* An ID card uploaded here matched one already in Document Management. */}
      <DuplicateResolveDialog
        open={!!pendingDuplicate}
        match={pendingDuplicate?.match}
        newFile={pendingDuplicate?.file}
        newTitle={pendingDuplicate ? ID_DOCUMENT_KINDS[pendingDuplicate.kind].title : ''}
        busy={!!uploadingKind}
        onKeepExisting={() => setPendingDuplicate(null)}
        onKeepNew={() => uploadIdDocument(pendingDuplicate.kind, pendingDuplicate.file, 'replace')}
        onKeepBoth={() => uploadIdDocument(pendingDuplicate.kind, pendingDuplicate.file, 'keepBoth')}
      />
    </>
  );
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE COMPANY'S OWN IDENTITY                                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Four sections against `company_profiles`, mirroring the member form above.
 *
 * ── EACH SECTION SAVES ALONE ───────────────────────────────────────────────
 * The PUT is a patch: a section the page does not send is a section it is not
 * editing. So the save button sends only the tab in front of the user, and two
 * admins editing Contact and Tax at once do not overwrite each other's work
 * with a stale copy of the other's section.
 *
 * ── GST / PAN / TAN ARE CIPHERTEXT AT REST ─────────────────────────────────
 * Encrypted by the route on the way in and decrypted on the way out, so this
 * form only ever holds plaintext and needs to know nothing about it. See
 * src/lib/records/jsonFieldCrypto.ts.
 */
function CompanyProfileSection({ companyId, canEdit }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState('identity');

  // Deep link: ?section=tax opens Tax & Registration. See `openTabFrom`.
  useEffect(() => {
    const wanted = openTabFrom('section', COMPANY_SECTIONS);
    if (wanted) setSection(wanted);
  }, []);

  const [identity, setIdentity] = useState({
    legalName: '', entityType: '', registrationNumber: '', incorporatedOn: '',
  });
  const [tax, setTax] = useState({ gstNumber: '', panNumber: '', tanNumber: '' });
  const [address, setAddress] = useState({ registeredAddress: '', operatingAddress: '' });
  const [contact, setContact] = useState({ email: '', phone: '', website: '' });

  // Every field is optional and may be absent from the stored JSON, so each is
  // coalesced to '' — a controlled <Input> handed `undefined` switches to
  // uncontrolled and React warns once, then silently stops tracking it.
  const fill = (setter, stored, keys) =>
    setter(Object.fromEntries(keys.map((k) => [k, (stored || {})[k] || ''])));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { json } = await apiCall(`/api/companies/${companyId}/profile`);
        if (cancelled) return;
        if (json.success && json.profile) {
          const p = json.profile;
          fill(setIdentity, p.identityDetails, ['legalName', 'entityType', 'registrationNumber', 'incorporatedOn']);
          fill(setTax, p.taxDetails, ['gstNumber', 'panNumber', 'tanNumber']);
          fill(setAddress, p.addressDetails, ['registeredAddress', 'operatingAddress']);
          fill(setContact, p.contactDetails, ['email', 'phone', 'website']);
        } else {
          toast.error(json.error || 'Failed to load the company profile');
        }
      } catch (err) {
        // Transport failures are values, not throws — see the same note on the
        // member form above. Reaching here means a bug in the block, and
        // calling it a network error sends people to check a working connection.
        console.error('[company-profile] handler threw', err);
        toast.error('Something went wrong loading the company profile.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [companyId]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    // Only the section on screen. See the note above this component.
    const payload =
      section === 'identity' ? { identityDetails: identity }
      : section === 'tax' ? { taxDetails: tax }
      : section === 'address' ? { addressDetails: address }
      : { contactDetails: contact };
    try {
      const { json } = await apiCall(`/api/companies/${companyId}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (json.success) toast.success('Company profile updated');
      else toast.error(json.error || 'Failed to save the company profile');
    } catch (err) {
      console.error('[company-profile] handler threw', err);
      toast.error('Something went wrong saving the company profile.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <>
        <div className="flex gap-2">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-9 w-28 rounded-full" />)}
        </div>
        <Skeleton className="h-80 w-full rounded-2xl" />
      </>
    );
  }

  const sections = COMPANY_SECTIONS;

  const field = (id, label, value, onChange, props = {}) => (
    <div className="flex flex-col gap-1.5" key={id}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={saving || !canEdit} {...props} />
    </div>
  );

  return (
    <>
      <div className="flex flex-wrap gap-2 p-1.5 rounded-xl bg-muted/40 border border-border/55 w-fit animate-fade-in stagger-1">
        {sections.map((tab) => {
          const Icon = tab.icon;
          const active = section === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setSection(tab.value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200 ${
                active
                  ? 'bg-primary text-primary-foreground shadow'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <Icon size={14} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <form onSubmit={handleSave} className="animate-fade-in stagger-2">
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8">
          <CardContent className="p-0 flex flex-col gap-6">

            {section === 'identity' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <Building2 size={18} className="text-primary" /> Company Identity
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {field('legalName', 'Registered Legal Name', identity.legalName,
                    (v) => setIdentity({ ...identity, legalName: v }),
                    { placeholder: 'e.g. Acme Traders Private Limited' })}
                  {field('entityType', 'Entity Type', identity.entityType,
                    (v) => setIdentity({ ...identity, entityType: v }),
                    { placeholder: 'e.g. Private Limited, LLP, Sole Proprietorship' })}
                  {field('registrationNumber', 'CIN / LLPIN / Registration No.', identity.registrationNumber,
                    (v) => setIdentity({ ...identity, registrationNumber: v.toUpperCase() }),
                    { placeholder: 'U74999MH2015PTC123456', className: 'font-mono uppercase' })}
                  {field('incorporatedOn', 'Date of Incorporation', identity.incorporatedOn,
                    (v) => setIdentity({ ...identity, incorporatedOn: v }), { type: 'date' })}
                </div>
              </div>
            )}

            {section === 'tax' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <Landmark size={18} className="text-primary" /> Tax Registrations
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {field('gstNumber', 'GSTIN', tax.gstNumber,
                    (v) => setTax({ ...tax, gstNumber: v.toUpperCase() }),
                    { placeholder: '27ABCDE1234F1Z5', className: 'font-mono uppercase' })}
                  {field('panNumber', 'Company PAN', tax.panNumber,
                    (v) => setTax({ ...tax, panNumber: v.toUpperCase() }),
                    { placeholder: 'ABCDE1234F', className: 'font-mono uppercase' })}
                  {field('tanNumber', 'TAN', tax.tanNumber,
                    (v) => setTax({ ...tax, tanNumber: v.toUpperCase() }),
                    { placeholder: 'MUMA12345B', className: 'font-mono uppercase' })}
                </div>
                <p className="text-xs text-muted-foreground">
                  These three are stored encrypted and are never sent to the AI assistant.
                </p>
              </div>
            )}

            {section === 'address' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <MapPin size={18} className="text-primary" /> Addresses
                </h3>
                <div className="grid grid-cols-1 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="registeredAddress">Registered Address</Label>
                    <Textarea
                      id="registeredAddress"
                      rows={3}
                      className="resize-none"
                      value={address.registeredAddress}
                      onChange={(e) => setAddress({ ...address, registeredAddress: e.target.value })}
                      disabled={saving || !canEdit}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="operatingAddress">Operating / Correspondence Address</Label>
                    <Textarea
                      id="operatingAddress"
                      rows={3}
                      className="resize-none"
                      placeholder="Leave blank if the same as the registered address"
                      value={address.operatingAddress}
                      onChange={(e) => setAddress({ ...address, operatingAddress: e.target.value })}
                      disabled={saving || !canEdit}
                    />
                  </div>
                </div>
              </div>
            )}

            {section === 'contact' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-3">
                  <Phone size={18} className="text-primary" /> Company Contact
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {field('companyEmail', 'Email', contact.email,
                    (v) => setContact({ ...contact, email: v }),
                    { type: 'email', placeholder: 'accounts@acme.example' })}
                  {field('companyPhone', 'Phone', contact.phone,
                    (v) => setContact({ ...contact, phone: v }),
                    { placeholder: '+91 22 1234 5678' })}
                  {field('companyWebsite', 'Website', contact.website,
                    (v) => setContact({ ...contact, website: v }),
                    { placeholder: 'https://acme.example' })}
                </div>
              </div>
            )}

            {/* Hidden rather than disabled for a read-only member: a save button
                that only ever refuses is a control that lies about what the page
                is for. The API re-checks `profiles.edit` regardless. */}
            {canEdit ? (
              <Button type="submit" disabled={saving} className="w-full md:w-auto h-11 px-6 mt-4">
                {saving ? (
                  <><Loader2 size={17} className="animate-spin" />Saving changes...</>
                ) : (
                  <><Save size={17} />Save Company Section</>
                )}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground mt-4">
                You have read-only access to this company&apos;s profile.
              </p>
            )}
          </CardContent>
        </Card>
      </form>
    </>
  );
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PROFILE — one component, two workspaces                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Rendered by `/profile` (the household) and by `/business/<id>/profile` (one
 * company), the same way `MoreScreen` serves both.
 *
 * ── THE PERSONAL PAGE IS UNCHANGED, DELIBERATELY ───────────────────────────
 * With no `companyId` this is exactly the page it has always been: My Profile,
 * four sections, no outer tab strip. A member's own details are their own from
 * whichever workspace they are opened — `profiles` is keyed by `user_id` — so
 * there was nothing to split there.
 *
 * ── THE COMPANY PAGE ADDS A SECOND SUBJECT, NOT A SECOND PAGE ──────────────
 * A company has an identity of its own: legal name, entity type, CIN, GST,
 * registered address. That had nowhere to live. It appears here as an OUTER
 * tab beside the member's own details rather than as a page of its own, because
 * "Profile" inside Acme should answer both readings of the word — whose
 * profile, and which one — without the user having to guess which link means
 * which.
 *
 * ── WHO SEES THE COMPANY TAB ───────────────────────────────────────────────
 * `profiles` permission, checked here for the tab and re-checked by the API on
 * every request. A member without it gets one tab and a page indistinguishable
 * from `/profile`; the tab is hidden rather than disabled, because a control
 * that exists only to refuse is worse than no control. Editing is a second,
 * narrower check — a member may be allowed to read the company's GST number and
 * not to change it.
 *
 * `companyId` is untrusted, exactly as everywhere else it appears: it comes
 * from the address bar, and the API re-proves it with `hasCompanyAccess`.
 */
/**
 * Who is signed in and what the workspace has used — the block that used to sit
 * at the foot of the desktop sidebar, permanently taking space from the module
 * list. Same meters `/more` shows, from the same `clientGetMe()` answer.
 */
function AccountUsageCard({ user, planDetails, storageData }) {
  if (!user) return null;
  const showMeters = user.role !== 'SUPER_ADMIN' && planDetails;
  return (
    <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in">
      <CardContent className="flex flex-col gap-4 p-5 md:p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-primary to-orange-500 text-sm font-black text-white">
            {getInitials(user.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-foreground">{user.name || 'User'}</div>
            <div className="mt-0.5 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {user.role?.replace(/_/g, ' ') || 'Standard'}
            </div>
          </div>
        </div>
        {showMeters && (
          <PlanQuotaMeters
            planDetails={planDetails}
            storageData={storageData}
            aiCreditsBalance={user.tenant?.aiCreditsBalance}
            size="lg"
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function ProfileScreen({ companyId = null }) {
  const [user, setUser] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [planDetails, setPlanDetails] = useState(null);
  const [storageData, setStorageData] = useState(null);
  // `null` until /api/auth/me answers. Distinct from `false`: rendering the
  // one-tab layout while the answer is unknown makes the company tab appear a
  // moment later and shift the page under a click already in flight.
  const [tab, setTab] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await clientGetMe();
      if (cancelled || !data.success) return;
      setUser(data.user);
      setCompanies(Array.isArray(data.companies) ? data.companies : []);
      setPlanDetails(data.planDetails || null);
      setStorageData(data.storageData || null);
    })();
    return () => { cancelled = true; };
  }, []);

  // TENANT_ADMIN short-circuits both inside `clientCan`, so the admin who owns
  // the workspace always gets the company tab and always gets to edit it.
  const canViewCompany = Boolean(companyId) && clientCan(user, 'profiles', null, 'view');
  const canEditCompany = canViewCompany && clientCan(user, 'profiles', null, 'edit');
  const companyName = companies.find((c) => c.id === companyId)?.name || null;

  useEffect(() => {
    if (!user) return;
    // The company is what the user came here for when they can see it; their own
    // details are the fallback and the whole page in the personal workspace.
    setTab((prev) => prev ?? (canViewCompany ? 'company' : 'me'));
  }, [user, canViewCompany]);

  // The personal workspace, and a member without the permission inside a
  // company: one subject, so no strip. This is the page `/profile` has always
  // been, unchanged.
  const showTabs = canViewCompany;

  if (!companyId) {
    return (
      <PageContainer width="narrow">
        <AccountUsageCard user={user} planDetails={planDetails} storageData={storageData} />
        <MyProfileSection />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="narrow">
      {/* The heading names the workspace. Without it a phone user arriving from
          the bottom nav has nothing on screen saying which account these details
          belong to — and the two forms look alike at a glance. */}
      <div className="flex flex-col gap-1 mb-2 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Profile</h1>
        <p className="text-muted-foreground text-sm">
          {companyName || 'This company'} — company details and your own
        </p>
      </div>

      <AccountUsageCard user={user} planDetails={planDetails} storageData={storageData} />

      {showTabs && (
        <div className="flex flex-wrap gap-1 border-b border-border animate-fade-in">
          {[
            { value: 'company', label: 'Company Profile', icon: Building2 },
            { value: 'me', label: 'Personal Details', icon: User },
          ].map((t) => {
            const Icon = t.icon;
            const active = tab === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={`flex items-center gap-2 px-4 py-2.5 -mb-px border-b-2 text-sm font-bold transition-colors ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon size={15} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Both mounted only one at a time: the member form fetches on mount, and
          keeping it alive behind the company tab would make every tab switch a
          second request for data nobody is looking at. */}
      {tab === 'company' && canViewCompany && (
        <CompanyProfileSection companyId={companyId} canEdit={canEditCompany} />
      )}
      {tab === 'me' && <MyProfileSection heading={false} />}
    </PageContainer>
  );
}
