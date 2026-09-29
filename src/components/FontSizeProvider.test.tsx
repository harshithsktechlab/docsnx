import React from 'react';
import { render, act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FontSizeProvider, useFontSize } from './FontSizeProvider';

describe('FontSizeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.fontSize = '';
  });

  it('provides default font size of 16px if no localStorage', () => {
    let contextValue: any;
    const TestComponent = () => {
      contextValue = useFontSize();
      return <div>Test</div>;
    };

    render(
      <FontSizeProvider>
        <TestComponent />
      </FontSizeProvider>
    );

    expect(contextValue.fontSize).toBe(16);
    expect(document.documentElement.style.fontSize).toBe('16px');
  });

  it('loads font size from localStorage if valid', () => {
    localStorage.setItem('app-font-size', '18');
    let contextValue: any;
    const TestComponent = () => {
      contextValue = useFontSize();
      return <div>Test</div>;
    };

    render(
      <FontSizeProvider>
        <TestComponent />
      </FontSizeProvider>
    );

    expect(contextValue.fontSize).toBe(18);
    expect(document.documentElement.style.fontSize).toBe('18px');
  });

  it('falls back to 16px if localStorage is invalid', () => {
    localStorage.setItem('app-font-size', '99');
    let contextValue: any;
    const TestComponent = () => {
      contextValue = useFontSize();
      return <div>Test</div>;
    };

    render(
      <FontSizeProvider>
        <TestComponent />
      </FontSizeProvider>
    );

    expect(contextValue.fontSize).toBe(16);
    expect(document.documentElement.style.fontSize).toBe('16px');
  });

  it('allows increasing font size', () => {
    let contextValue: any;
    const TestComponent = () => {
      contextValue = useFontSize();
      return <div>Test</div>;
    };

    render(
      <FontSizeProvider>
        <TestComponent />
      </FontSizeProvider>
    );

    act(() => {
      contextValue.increaseFontSize();
    });

    expect(contextValue.fontSize).toBe(18);
    expect(localStorage.getItem('app-font-size')).toBe('18');
    expect(document.documentElement.style.fontSize).toBe('18px');
  });

  it('allows decreasing font size', () => {
    let contextValue: any;
    const TestComponent = () => {
      contextValue = useFontSize();
      return <div>Test</div>;
    };

    render(
      <FontSizeProvider>
        <TestComponent />
      </FontSizeProvider>
    );

    act(() => {
      contextValue.decreaseFontSize();
    });

    expect(contextValue.fontSize).toBe(14);
    expect(localStorage.getItem('app-font-size')).toBe('14');
    expect(document.documentElement.style.fontSize).toBe('14px');
  });

  it('does not increase past max size 22', () => {
    localStorage.setItem('app-font-size', '22');
    let contextValue: any;
    const TestComponent = () => {
      contextValue = useFontSize();
      return <div>Test</div>;
    };

    render(
      <FontSizeProvider>
        <TestComponent />
      </FontSizeProvider>
    );

    act(() => {
      contextValue.increaseFontSize();
    });

    expect(contextValue.fontSize).toBe(22);
  });

  it('does not decrease past min size 14', () => {
    localStorage.setItem('app-font-size', '14');
    let contextValue: any;
    const TestComponent = () => {
      contextValue = useFontSize();
      return <div>Test</div>;
    };

    render(
      <FontSizeProvider>
        <TestComponent />
      </FontSizeProvider>
    );

    act(() => {
      contextValue.decreaseFontSize();
    });

    expect(contextValue.fontSize).toBe(14);
  });

  it('throws error if useFontSize is used outside provider', () => {
    expect(() => renderHook(() => useFontSize())).toThrow('useFontSize must be used within a FontSizeProvider');
  });
});
