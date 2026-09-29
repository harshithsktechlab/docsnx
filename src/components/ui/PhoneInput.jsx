import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

const COUNTRIES = [
  { code: '+91', name: 'IN', maxLen: 10 },
  { code: '+1', name: 'US/CA', maxLen: 10 },
  { code: '+44', name: 'UK', maxLen: 10 },
  { code: '+61', name: 'AU', maxLen: 9 },
  { code: '+971', name: 'UAE', maxLen: 9 },
  { code: '+65', name: 'SG', maxLen: 8 },
  { code: '+81', name: 'JP', maxLen: 10 },
  { code: '+49', name: 'DE', maxLen: 11 },
  { code: '+33', name: 'FR', maxLen: 9 },
  { code: '+39', name: 'IT', maxLen: 10 },
];

export const PhoneInput = ({
  value,
  onChange,
  className = '',
  label,
  required = false,
  error,
  hint,
  disabled = false,
  id,
  ...props
}) => {
  const [selectedCountry, setSelectedCountry] = useState(COUNTRIES[0]);
  const [numberPart, setNumberPart] = useState('');

  // Parse external value on mount or change
  useEffect(() => {
    if (!value) {
      onChange(selectedCountry.code);
      return;
    }

    // Find if the value starts with any of our known country codes
    const matchedCountry = COUNTRIES.find(c => value.startsWith(c.code));
    if (matchedCountry) {
      if (selectedCountry.code !== matchedCountry.code) {
        setSelectedCountry(matchedCountry);
      }
      const rawNumber = value.slice(matchedCountry.code.length).replace(/\D/g, '');
      setNumberPart(rawNumber);
    } else {
      // Fallback to default if no valid country code is found
      const digits = value.replace(/\D/g, '');
      const defaultCode = COUNTRIES[0].code;
      setNumberPart(digits);
      onChange(defaultCode + digits);
    }
  }, [value, onChange]);

  const handleCountryChange = (e) => {
    const newCode = e.target.value;
    const newCountry = COUNTRIES.find(c => c.code === newCode) || COUNTRIES[0];
    setSelectedCountry(newCountry);
    
    // Truncate number if it exceeds the new country's max length
    let newNumber = numberPart;
    if (newNumber.length > newCountry.maxLen) {
      newNumber = newNumber.slice(0, newCountry.maxLen);
    }
    
    onChange(newCountry.code + newNumber);
  };

  const handleNumberChange = (e) => {
    let inputDigits = e.target.value.replace(/\D/g, '');
    
    if (inputDigits.length > selectedCountry.maxLen) {
      inputDigits = inputDigits.slice(0, selectedCountry.maxLen);
    }
    
    onChange(selectedCountry.code + inputDigits);
  };

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {label && (
        <label htmlFor={id} className="block text-xs font-semibold text-muted-foreground select-none">
          {label} {required && <span className="text-red-500 font-bold">*</span>}
        </label>
      )}
      
      <div className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
        error ? "border-red-500 focus-within:ring-red-500" : "",
        disabled ? "opacity-50 cursor-not-allowed" : "",
        className
      )}>
        <div className="relative flex items-center h-full border-r border-input bg-muted/20 hover:bg-muted/30 transition-colors rounded-l-md">
          <select
            disabled={disabled}
            value={selectedCountry.code}
            onChange={handleCountryChange}
            className="h-full pl-2 pr-6 appearance-none bg-transparent outline-none text-sm font-medium cursor-pointer disabled:cursor-not-allowed z-10"
            title="Select Country Code"
          >
            {COUNTRIES.map(c => (
              <option key={c.code} value={c.code} className="bg-background text-foreground">
                {c.name} ({c.code})
              </option>
            ))}
          </select>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </div>
        </div>
        <input
          id={id}
          type="tel"
          disabled={disabled}
          value={numberPart}
          onChange={handleNumberChange}
          placeholder="Phone number"
          className="flex-1 h-full bg-transparent px-3 py-1 text-base file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed md:text-sm"
          {...props}
        />
      </div>

      {error ? (
        <p className="text-xs font-semibold text-red-500 mt-0.5 leading-tight">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground mt-0.5 leading-tight">
          {hint}
        </p>
      ) : null}
    </div>
  );
};
