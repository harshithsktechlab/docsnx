'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { registerBorrowPrompt } from '@/lib/net/creditBorrow';

const LABEL = { personal: 'Personal', business: 'Business' };
const OTHER = { personal: 'business', business: 'personal' };
const MINUTES = 10;

/**
 * The one question behind every AI action whose own credit pool ran out while
 * the other pool could pay: "use those instead?".
 *
 * Mounted once in the root layout, beside the Toaster — any page may need it and
 * none should host it. It renders nothing until `askToBorrow` is called by the
 * request helpers (src/lib/net/creditBorrow.ts), which then wait on the answer.
 * Closing it any way other than "Use" is a no.
 */
export default function CreditBorrowDialog() {
  const [offer, setOffer] = useState(null);
  const answerRef = useRef(null);

  useEffect(() => registerBorrowPrompt((next, answer) => {
    answerRef.current = answer;
    setOffer(next);
  }), []);

  const finish = (yes) => {
    const answer = answerRef.current;
    answerRef.current = null;
    setOffer(null);
    answer?.(yes);
  };

  const from = offer?.from;
  const own = from ? OTHER[from] : null;

  return (
    <Dialog open={!!offer} onOpenChange={(open) => { if (!open) finish(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap size={17} /> Use {from ? LABEL[from] : ''} credits?
          </DialogTitle>
          <DialogDescription>
            Your {own ? LABEL[own] : ''} AI credits for this workspace are used up.
            {offer?.required ? ` This action needs ${offer.required.toLocaleString()}.` : ''}
            {' '}You have {typeof offer?.otherBalance === 'number' ? `${offer.otherBalance.toLocaleString()} ` : ''}
            {from ? LABEL[from] : ''} credits available. Use them for your AI actions for the next {MINUTES} minutes?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => finish(false)}>Not now</Button>
          <Button type="button" onClick={() => finish(true)}>Use {from ? LABEL[from] : ''} credits</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
