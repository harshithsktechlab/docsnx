"use client";

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Menu, X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { FontSizeToggle } from '@/components/FontSizeToggle';
import { APP_MARK, APP_NAME } from '@/lib/brand';
import BrandWordmark from '@/app/components/BrandWordmark';

export default function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // `resolvedTheme`, not `theme`: with enableSystem a visitor who never picked a
  // theme has theme === 'system', which fell to the light branch and rendered an
  // inverted toggle label on a dark page.
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <nav className={`fixed top-0 w-full z-50 transition-all duration-300 border-b ${scrolled ? 'bg-background/80 backdrop-blur-glass border-border shadow-sm' : 'bg-transparent border-transparent'}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          <div className="flex items-center gap-3">
            {/* Neither the mark nor the wordmark depends on the theme any
                more, so the brand no longer waits for `mounted` — it is in
                the server HTML and there is no blank corner on first paint. */}
            <Link href="/" className="flex items-center gap-2">
              <Image
                src={APP_MARK}
                alt={APP_NAME}
                width={40}
                height={40}
                className="object-contain w-auto h-auto rounded-lg border border-border/50 p-0.5 bg-background/50 shadow-sm"
              />
              <BrandWordmark className="text-2xl font-black tracking-tight" />
            </Link>
          </div>
          
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Features</a>
            <a href="#security" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Security</a>
            <a href="#pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Pricing</a>
            
            <div className="flex items-center gap-4 ml-4 pl-4 border-l border-border/50">
              <Link href="/login" className="text-sm font-bold text-foreground hover:text-primary transition-colors">
                Log in
              </Link>
              <Link href="/register" className="text-sm font-bold bg-primary text-primary-foreground px-5 py-2.5 rounded-full hover:bg-primary/90 transition-all shadow-glow hover:shadow-none hover:scale-105 active:scale-95">
                Get Started
              </Link>
              {/* Controls */}
              {mounted && (
                <div className="flex items-center gap-3">
                  <FontSizeToggle />
                  <button 
                    onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                    className="p-2 rounded-full bg-muted/50 text-muted-foreground hover:text-foreground transition-colors h-[34px] w-[34px] flex items-center justify-center"
                  >
                    {resolvedTheme === 'dark' ? '☀️' : '🌙'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="md:hidden flex items-center gap-4">
            <Link href="/login" className="text-sm font-bold text-foreground hover:text-primary transition-colors">
              Log in
            </Link>
            <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="text-foreground p-2">
              {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-border bg-background/95 backdrop-blur-glass p-4 flex flex-col gap-4 shadow-xl absolute w-full top-20 left-0">
          <a href="#features" onClick={() => setMobileMenuOpen(false)} className="text-base font-medium text-foreground p-3 rounded-md hover:bg-muted/50 transition-colors">Features</a>
          <a href="#security" onClick={() => setMobileMenuOpen(false)} className="text-base font-medium text-foreground p-3 rounded-md hover:bg-muted/50 transition-colors">Security</a>
          <a href="#pricing" onClick={() => setMobileMenuOpen(false)} className="text-base font-medium text-foreground p-3 rounded-md hover:bg-muted/50 transition-colors">Pricing</a>
          
          <div className="border-t border-border/50 pt-4 mt-2 flex flex-col gap-3">
            <Link href="/register" onClick={() => setMobileMenuOpen(false)} className="text-base font-bold bg-primary text-primary-foreground px-5 py-3 rounded-full text-center shadow-lg hover:bg-primary/90 active:scale-95 transition-all">
              Get Started
            </Link>
          </div>
          {mounted && (
            <div className="flex flex-col gap-3 mt-2 border-t border-border/50 pt-4 pb-2">
              <div className="flex justify-center">
                <FontSizeToggle />
              </div>
              <button 
                onClick={() => {
                  setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
                }}
                className="p-3 rounded-full bg-muted/50 text-foreground flex items-center gap-2 hover:bg-muted transition-colors w-full justify-center"
              >
                {resolvedTheme === 'dark' ? '☀️ Switch to Light Mode' : '🌙 Switch to Dark Mode'}
              </button>
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
