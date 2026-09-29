'use client';

import React, { useEffect, useState } from 'react';
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
  Phone
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

/** The member form's four sections. At module scope so `openTabFrom` below can
 *  validate a deep link against the very list the strip renders. */
const MY_PROFILE_TABS = [
  { value: 'personal', label: 'Personal', icon: User },
  { value: 'education', label: 'Education', icon: GraduationCap },
  { value: 'shopping', label: 'Shopping', icon: ShoppingBag },
  { value: 'legal', label: 'Legal / ID', icon: Scale },
];

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
  const [birthPlace, setBirthPlace] = useState('');

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

  useEffect(() => {
    async function loadProfile() {
      try {
        const { json } = await apiCall('/api/profiles');
        if (json.success && json.profile) {
          setProfile(json.profile);
          
          const personal = json.profile.personalDetails || {};
          setDob(personal.dob || '');
          setBloodGroup(personal.bloodGroup || '');
          setGender(personal.gender || '');
          setBirthPlace(personal.birthPlace || '');

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

  const handleSave = async (e) => {
    e.preventDefault();

    setSaving(true);

    const payload = {
      personalDetails: { dob, bloodGroup, gender, birthPlace },
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
                    <Input
                      id="bloodGroup"
                      type="text"
                      placeholder="e.g. O+ve"
                      value={bloodGroup}
                      onChange={(e) => setBloodGroup(e.target.value)}
                      disabled={saving}
                    />
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
                    <Label htmlFor="birthPlace">Place of Birth</Label>
                    <Input
                      id="birthPlace"
                      type="text"
                      placeholder="e.g. Mumbai, India"
                      value={birthPlace}
                      onChange={(e) => setBirthPlace(e.target.value)}
                      disabled={saving}
                    />
                  </div>
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
export default function ProfileScreen({ companyId = null }) {
  const [user, setUser] = useState(null);
  const [companies, setCompanies] = useState([]);
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
