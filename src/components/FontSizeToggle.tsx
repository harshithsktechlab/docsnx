'use client';

import React from 'react';
import { useFontSize } from './FontSizeProvider';
import { Minus, Plus, Glasses } from 'lucide-react';

export function FontSizeToggle() {
  const { fontSize, increaseFontSize, decreaseFontSize } = useFontSize();

  return (
    <div className="flex items-center bg-muted/50 rounded-full p-1 border border-border/50 h-[34px]">
      <div className="px-1.5 pl-2 text-muted-foreground flex items-center justify-center border-r border-border/50 mr-1" title="Text Size">
        <Glasses size={15} strokeWidth={2.5} />
      </div>
      <button
        onClick={decreaseFontSize}
        disabled={fontSize <= 14}
        className={`px-2.5 h-full rounded-full transition-colors flex items-center justify-center ${
          fontSize <= 14 ? 'opacity-40 cursor-not-allowed text-muted-foreground' : 'text-foreground hover:bg-background shadow-sm'
        }`}
        title="Decrease Font Size"
      >
        <Minus size={15} strokeWidth={2.5} />
      </button>
      <button
        onClick={increaseFontSize}
        disabled={fontSize >= 22}
        className={`px-2.5 h-full rounded-full transition-colors flex items-center justify-center ${
          fontSize >= 22 ? 'opacity-40 cursor-not-allowed text-muted-foreground' : 'text-foreground hover:bg-background shadow-sm'
        }`}
        title="Increase Font Size"
      >
        <Plus size={15} strokeWidth={2.5} />
      </button>
    </div>
  );
}
