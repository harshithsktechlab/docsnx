'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

type FontSize = 14 | 16 | 18 | 20 | 22;

interface FontSizeContextType {
  fontSize: FontSize;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
}

const FontSizeContext = createContext<FontSizeContextType | undefined>(undefined);

const FONT_SIZES: FontSize[] = [14, 16, 18, 20, 22];

export function FontSizeProvider({ children }: { children: React.ReactNode }) {
  const [fontSize, setFontSizeState] = useState<FontSize>(16);

  useEffect(() => {
    // Load from local storage
    const saved = localStorage.getItem('app-font-size');
    const parsed = saved ? parseInt(saved, 10) as FontSize : 16;
    if (FONT_SIZES.includes(parsed)) {
      setFontSizeState(parsed);
      document.documentElement.style.fontSize = `${parsed}px`;
    } else {
      document.documentElement.style.fontSize = '16px';
    }
  }, []);

  const setFontSize = (size: FontSize) => {
    setFontSizeState(size);
    localStorage.setItem('app-font-size', size.toString());
    document.documentElement.style.fontSize = `${size}px`;
  };

  const increaseFontSize = () => {
    const currentIndex = FONT_SIZES.indexOf(fontSize);
    if (currentIndex < FONT_SIZES.length - 1) {
      setFontSize(FONT_SIZES[currentIndex + 1]);
    }
  };

  const decreaseFontSize = () => {
    const currentIndex = FONT_SIZES.indexOf(fontSize);
    if (currentIndex > 0) {
      setFontSize(FONT_SIZES[currentIndex - 1]);
    }
  };

  return (
    <FontSizeContext.Provider value={{ fontSize, increaseFontSize, decreaseFontSize }}>
      {children}
    </FontSizeContext.Provider>
  );
}

export function useFontSize() {
  const context = useContext(FontSizeContext);
  if (!context) {
    throw new Error('useFontSize must be used within a FontSizeProvider');
  }
  return context;
}
