import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ToasterProvider } from './ToasterProvider';

vi.mock('sonner', () => ({
  Toaster: ({ position }: any) => <div data-testid="sonner-toaster" data-position={position} />
}));

describe('ToasterProvider', () => {
  it('renders Sonner toaster with correct props', () => {
    const { getByTestId } = render(<ToasterProvider />);
    
    const toaster = getByTestId('sonner-toaster');
    expect(toaster).toBeInTheDocument();
    expect(toaster).toHaveAttribute('data-position', 'top-right');
  });
});
