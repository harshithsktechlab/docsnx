/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE COMMA-SEPARATED PARAM, ONE MEANING                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The multi-select filters send `?moduleKey=vehicle,insurance` — one param, not
 * a repeated key, because `parseQueryParams` folds repeats with last-wins and
 * would silently drop every value but the final one.
 *
 * That makes the split the contract between the dropdown and the route, and
 * `splitFilterValues` the single place it is decided. A blank slipping through
 * would reach `inArray` and match nothing, which reads as a broken filter
 * rather than as the trailing comma it actually was.
 */
import { describe, it, expect } from 'vitest';
import { splitFilterValues } from '@/lib/listFilters';

describe('splitFilterValues', () => {
  it('reads a single value as a list of one', () => {
    expect(splitFilterValues('vehicle')).toEqual(['vehicle']);
  });

  it('splits several values in the order they were sent', () => {
    expect(splitFilterValues('vehicle,insurance,identity'))
      .toEqual(['vehicle', 'insurance', 'identity']);
  });

  it('drops blanks from a trailing or doubled comma', () => {
    // A dropdown that joined an empty selection, or a hand-edited URL.
    expect(splitFilterValues('vehicle,')).toEqual(['vehicle']);
    expect(splitFilterValues('vehicle,,insurance')).toEqual(['vehicle', 'insurance']);
    expect(splitFilterValues(',')).toEqual([]);
  });

  it('trims whitespace around a value', () => {
    expect(splitFilterValues(' vehicle , insurance ')).toEqual(['vehicle', 'insurance']);
  });

  it('de-duplicates', () => {
    // Two selections of the same option would otherwise widen an IN list with
    // a value already in it.
    expect(splitFilterValues('vehicle,vehicle')).toEqual(['vehicle']);
  });

  it('treats absent, empty and null alike', () => {
    expect(splitFilterValues('')).toEqual([]);
    expect(splitFilterValues(null)).toEqual([]);
    expect(splitFilterValues(undefined)).toEqual([]);
  });
});
