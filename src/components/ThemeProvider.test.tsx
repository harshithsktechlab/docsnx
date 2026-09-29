import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ThemeProvider } from './ThemeProvider';

vi.mock('next-themes', () => ({
  ThemeProvider: ({ children, attribute, defaultTheme, enableSystem }: any) => (
    <div 
      data-testid="next-themes-provider" 
      data-attribute={attribute} 
      data-defaulttheme={defaultTheme} 
      data-enablesystem={enableSystem}
    >
      {children}
    </div>
  )
}));

describe('ThemeProvider', () => {
  it('renders children correctly', () => {
    const { getByText, getByTestId } = render(
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <div>Test Child</div>
      </ThemeProvider>
    );

    expect(getByText('Test Child')).toBeInTheDocument();
    const provider = getByTestId('next-themes-provider');
    expect(provider).toBeInTheDocument();
    expect(provider).toHaveAttribute('data-attribute', 'class');
  });
});
