import { describe, it, expect } from 'vitest';
import { jaroWinkler, wordScore, INITIAL_SCORE } from '@/lib/records/nameSimilarity';

describe('jaroWinkler', () => {
  it('is 1 for equal strings and 0 when nothing is shared', () => {
    expect(jaroWinkler('rai', 'rai')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('', 'rai')).toBe(0);
  });

  it('scores an OCR transposition high and a different name low', () => {
    expect(jaroWinkler('supriya', 'supirya')).toBeGreaterThan(0.95);
    expect(jaroWinkler('rai', 'rao')).toBeLessThan(0.88);
    expect(jaroWinkler('supriya', 'sunita')).toBeLessThan(0.88);
  });
});

describe('wordScore', () => {
  it('counts an initial as a near match only when the letter agrees', () => {
    expect(wordScore('r', 'rai')).toBe(INITIAL_SCORE);
    expect(wordScore('rai', 'r')).toBe(INITIAL_SCORE);
    expect(wordScore('s', 'rai')).toBe(0);
  });
});
