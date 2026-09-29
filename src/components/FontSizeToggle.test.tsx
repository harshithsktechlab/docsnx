import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FontSizeToggle } from './FontSizeToggle';
import * as FontSizeProviderModule from './FontSizeProvider';

describe('FontSizeToggle', () => {
  it('renders buttons and calls context methods', () => {
    const increaseFontSize = vi.fn();
    const decreaseFontSize = vi.fn();
    
    vi.spyOn(FontSizeProviderModule, 'useFontSize').mockReturnValue({
      fontSize: 16,
      increaseFontSize,
      decreaseFontSize,
    });

    const { getByTitle } = render(<FontSizeToggle />);
    
    const decBtn = getByTitle('Decrease Font Size');
    const incBtn = getByTitle('Increase Font Size');

    expect(decBtn).not.toBeDisabled();
    expect(incBtn).not.toBeDisabled();

    fireEvent.click(decBtn);
    expect(decreaseFontSize).toHaveBeenCalledTimes(1);

    fireEvent.click(incBtn);
    expect(increaseFontSize).toHaveBeenCalledTimes(1);
  });

  it('disables decrease button when font size is at min limit', () => {
    vi.spyOn(FontSizeProviderModule, 'useFontSize').mockReturnValue({
      fontSize: 14,
      increaseFontSize: vi.fn(),
      decreaseFontSize: vi.fn(),
    });

    const { getByTitle } = render(<FontSizeToggle />);
    const decBtn = getByTitle('Decrease Font Size');
    expect(decBtn).toBeDisabled();
  });

  it('disables increase button when font size is at max limit', () => {
    vi.spyOn(FontSizeProviderModule, 'useFontSize').mockReturnValue({
      fontSize: 22,
      increaseFontSize: vi.fn(),
      decreaseFontSize: vi.fn(),
    });

    const { getByTitle } = render(<FontSizeToggle />);
    const incBtn = getByTitle('Increase Font Size');
    expect(incBtn).toBeDisabled();
  });
});
