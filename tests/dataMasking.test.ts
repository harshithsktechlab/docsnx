import { describe, it, expect } from 'vitest';
import {
  maskTail,
  maskCard,
  maskCvv,
  maskUsername,
  maskEmail,
  maskPhone,
  maskDocId,
  maskFields,
} from '@/lib/dataMasking';

describe('dataMasking', () => {
  it('maskTail shows only the last N characters', () => {
    expect(maskTail('1234567890')).toBe('••••7890');
    expect(maskTail('1234567890', 2)).toBe('••••90');
    expect(maskTail('')).toBe('');
    expect(maskTail(null)).toBe('');
  });

  it('maskCard shows only the last 4 digits', () => {
    expect(maskCard('4111 1111 1111 1234')).toBe('•••• •••• •••• 1234');
    expect(maskCard('4111111111111234')).toBe('•••• •••• •••• 1234');
  });

  it('maskCvv never reveals digits', () => {
    expect(maskCvv()).toBe('•••');
  });

  it('maskUsername keeps the first two characters', () => {
    expect(maskUsername('raghav')).toBe('ra••••');
    expect(maskUsername('ab')).toBe('••••');
  });

  it('maskEmail masks the local part but keeps the domain', () => {
    expect(maskEmail('raghav@gmail.com')).toBe('ra••••@gmail.com');
    expect(maskEmail('a@b.com')).toBe('a••••@b.com');
  });

  it('maskPhone keeps the last four digits', () => {
    expect(maskPhone('+91 98765 43210')).toBe('••••3210');
  });

  it('maskDocId keeps the last four', () => {
    expect(maskDocId('ABCDE1234F')).toBe('••••234F');
  });

  it('maskFields applies maskers only to present keys and skips null/undefined', () => {
    const out = maskFields(
      { accountNumber: '9876543210', name: 'Rahul', customerId: null },
      { accountNumber: (v) => maskTail(v), customerId: (v) => maskTail(v) }
    );
    expect(out.accountNumber).toBe('••••3210');
    expect(out.name).toBe('Rahul');
    expect(out.customerId).toBeNull();
  });
});
