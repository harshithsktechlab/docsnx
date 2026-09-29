'use client';
import { PasswordInput } from '@/components/ui/password-input';
import React, { useState } from 'react';
import { CreditCard, Plus, X, Trash2, Edit2 } from 'lucide-react';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { apiCall } from '@/lib/net/apiRequest';

export default function StandaloneCards({ creditCards, fetchBankInfos, canAdd, canEdit, canDelete }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  
  // Add Form State
  const [cardName, setCardName] = useState('');
  const [cardNetwork, setCardNetwork] = useState('');
  const [cardType, setCardType] = useState('Credit');
  const [cardHolder, setCardHolder] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');

  // ─── Closing the Add form ─────────────────────────────────────────────────
  // Every way out goes through these two, so "closed" has ONE definition and it
  // always clears. That mattered more here than anywhere else: the fields were
  // reset only on a successful save, so dismissing this form left a typed card
  // number and CVV sitting in component state.
  const resetAddForm = () => {
    setCardName('');
    setCardNetwork('');
    setCardType('Credit');
    setCardHolder('');
    setCardNumber('');
    setCardExpiry('');
    setCardCvv('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();
    if (!cardName || !cardNumber || !cardHolder || !cardExpiry || !cardCvv) {
      toast.error('Please fill in all required fields');
      return;
    }
    
    setSaving(true);
    const payload = {
      cardName,
      cardNetwork,
      cardType,
      cardHolder,
      cardNumber,
      cardExpiry,
      cardCvv
    };

    try {
      const { json } = await apiCall('/api/credit-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (json.success) {
        toast.success('Credit card saved successfully');
        closeAddForm();
        fetchBankInfos();
      } else {
        toast.error(json.error || 'Failed to save card');
      }
    } catch (error) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[bank-info/StandaloneCards] handler threw', error);
      toast.error('Something went wrong while saving. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this credit card?')) return;
    try {
      const { json } = await apiCall(`/api/credit-cards/${id}`, { method: 'DELETE' });
      if (json.success) {
        toast.success('Card deleted successfully');
        fetchBankInfos();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[bank-info/StandaloneCards] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-foreground">Standalone Credit/Forex Cards</h2>
        {canAdd && (
          <Button 
            onClick={() => (showAddForm ? closeAddForm() : setShowAddForm(true))}
            variant={showAddForm ? "destructive" : "default"}
            size="sm"
            className="rounded-full shadow"
          >
            {showAddForm ? <X size={16} className="mr-1"/> : <Plus size={16} className="mr-1"/>}
            {showAddForm ? "Cancel" : "Add Card"}
          </Button>
        )}
      </div>

      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6">
          <form onSubmit={handleAddSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Card Name / Identifier *</Label>
                <Input placeholder="e.g. HDFC Regalia" value={cardName} onChange={e => setCardName(e.target.value)} disabled={saving} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Cardholder Name *</Label>
                <Input placeholder="John Doe" value={cardHolder} onChange={e => setCardHolder(e.target.value)} disabled={saving} />
              </div>
            </div>
            
            <div className="flex flex-col gap-1.5">
              <Label>Card Number *</Label>
              <Input placeholder="XXXX XXXX XXXX XXXX" value={cardNumber} onChange={e => setCardNumber(e.target.value.replace(/[^0-9]/g, ''))} disabled={saving} className="font-mono" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Expiry (MM/YY) *</Label>
                <Input placeholder="12/28" value={cardExpiry} onChange={e => setCardExpiry(e.target.value)} disabled={saving} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>CVV *</Label>
                <PasswordInput autoComplete="new-password" placeholder="123" value={cardCvv} onChange={e => setCardCvv(e.target.value.replace(/[^0-9]/g, ''))} maxLength={4} disabled={saving} className="font-mono" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Card Network</Label>
                <Input placeholder="e.g. Visa, Mastercard, AMEX" value={cardNetwork} onChange={e => setCardNetwork(e.target.value)} disabled={saving} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Card Type</Label>
                <Input placeholder="e.g. Credit, Forex, Business" value={cardType} onChange={e => setCardType(e.target.value)} disabled={saving} />
              </div>
            </div>

            {/* Cancel sits WITH Save, at the foot of the form, because that is
                where someone who has changed their mind actually is — the toggle up
                in the page header has long since scrolled away. It discards whatever
                was typed; see closeAddForm. */}
            <div className="mt-2 flex gap-3">
              <Button type="button" variant="outline" onClick={closeAddForm} disabled={saving} className="h-11 px-6">
                Cancel
              </Button>
              <Button type="submit" disabled={saving} className="h-11 flex-1">
                {saving ? 'Encrypting & Saving Card...' : 'Save Credit Card'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {creditCards.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center">
          <CreditCard size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">
            No standalone cards stored yet
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {creditCards.map(card => (
            <Card key={card.id} className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5">
              <div className="flex justify-between items-start gap-2">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl border text-primary bg-primary-500/10 border-primary-500/20">
                    <CreditCard size={18} />
                  </div>
                  <div>
                    <span className="font-bold text-foreground text-sm block">{card.cardName}</span>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">
                        {card.cardNetwork || 'Card'} {card.cardType ? `· ${card.cardType}` : ''}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {canDelete && (
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10" onClick={() => handleDelete(card.id)}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              </div>
              
              <div className="mt-4 pt-4 border-t border-border/30">
                <div className="flex flex-col gap-2 text-sm text-foreground">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Cardholder</span>
                    <span className="font-medium">{card.cardHolder || '******'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Number</span>
                    <span className="font-mono font-medium">{card.cardNumber ? `${card.cardNumber.slice(0,4)} **** **** ${card.lastFour || card.cardNumber.slice(-4)}` : `**** **** **** ${card.lastFour || '****'}`}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Expiry</span>
                    <span className="font-medium">{card.cardExpiry || '**/**'}</span>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
