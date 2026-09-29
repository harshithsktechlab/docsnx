import re

with open('src/app/bank-info/page.js', 'r', encoding='utf-8') as f:
    content = f.read()

# We need to replace from:
#     // Parse cards list if present in DB
# down to the end of handleSubmit:
#     } finally {
#       setSaving(false);
#     }
#   };

start_marker = "    // Parse cards list if present in DB"
end_marker = "  const handleDelete = async (id) => {"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

new_block = '''    // Parse cards list if present in DB
    let initialCards = [];
    if (bank.cards) {
      if (Array.isArray(bank.cards)) {
        initialCards = [...bank.cards];
      } else if (Array.isArray(bank.cards.cards)) {
        initialCards = [...bank.cards.cards];
      }
    }
    setEditCards(initialCards);
    setEditCardHolder('');
    setEditCardNumber('');
    setEditCardExpiry('');
    setEditCardCvv('');
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingBank) return;
    if (!editBankName || !editAccountNumber || !editIfscCode) {
      setEditError('Bank Name, Account Number, and IFSC Code are required');
      return;
    }
    
    let finalEditCards = [...editCards];
    if (editCardHolder || editCardNumber || editCardExpiry || editCardCvv) {
      if (!editCardHolder || !editCardNumber || !editCardExpiry || !editCardCvv) {
        setEditError('Please complete all card details or clear them before saving.');
        return;
      }
      finalEditCards.push({
        id: 	emp_,
        cardHolder: editCardHolder,
        cardNumber: editCardNumber,
        cardExpiry: editCardExpiry,
        cardCvv: editCardCvv
      });
    }

    setEditSaving(true);
    setEditError('');

    try {
      const res = await fetch(/api/bank-info/, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankName: editBankName,
          accountNumber: editAccountNumber,
          accountType: editAccountType,
          ifscCode: editIfscCode,
          branch: editBranch,
          customerId: editCustomerId,
          netBankingUsername: editNetBankingUsername,
          customFields: editCustomFields,
          cards: finalEditCards
        })
      });
      const json = await res.json();
      if (json.success) {
        setEditingBank(null);
        fetchBankInfos();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      setEditError('Network error updating bank details');
    } finally {
      setEditSaving(false);
    }
  };

  // UI state
  const [visibleCards, setVisibleCards] = useState({});
  const [copiedId, setCopiedId] = useState(null);

  const fetchBankInfos = async () => {
    try {
      const res = await fetch('/api/bank-info');
      const json = await res.json();
      if (json.success) {
        setBankInfos(json.bankInfos);
      } else {
        setError(json.error || 'Failed to fetch bank details');
      }
    } catch (err) {
      setError('Network error fetching bank details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBankInfos();
    async function checkSharePermission() {
      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanShare(true);
          } else {
            const perm = u.permissions?.find(p => p.module === 'bank_info');
            setCanShare(!!perm?.canShare);
          }
        }
      } catch (err) {
        console.error('Error loading permissions:', err);
      }
    }
    checkSharePermission();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('search');
      if (q) setSearchTerm(q);
    }
  }, []);

  const handleAddCard = () => {
    if (!cardHolder || !cardNumber || !cardExpiry || !cardCvv) {
      toast.error('Please fill in all card details first.');
      return;
    }
    const newCard = {
      id: 	emp_,
      cardHolder,
      cardNumber,
      cardExpiry,
      cardCvv
    };
    setCards([...cards, newCard]);
    // Reset Card fields
    setCardHolder('');
    setCardNumber('');
    setCardExpiry('');
    setCardCvv('');
  };

  const handleRemoveCard = (tempId) => {
    setCards(cards.filter(c => c.id !== tempId));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!bankName || !accountNumber || !ifscCode) {
      setFormError('Please fill in required fields (Bank Name, Account Number, and IFSC)');
      return;
    }
    
    let finalCards = [...cards];
    if (cardHolder || cardNumber || cardExpiry || cardCvv) {
      if (!cardHolder || !cardNumber || !cardExpiry || !cardCvv) {
        setFormError('Please complete all card details or clear them before saving.');
        return;
      }
      finalCards.push({
        id: 	emp_,
        cardHolder,
        cardNumber,
        cardExpiry,
        cardCvv
      });
    }

    setFormError('');
    setSaving(true);

    const payload = {
      bankName,
      accountNumber,
      accountType,
      ifscCode,
      branch,
      customerId,
      netBankingUsername,
      customFields,
      cards: finalCards.map(({ cardHolder, cardNumber, cardExpiry, cardCvv }) => ({
        cardHolder,
        cardNumber,
        cardExpiry,
        cardCvv
      }))
    };

    try {
      const res = await fetch('/api/bank-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.success) {
        // Reset form
        setBankName('');
        setAccountNumber('');
        setAccountType('savings');
        setIfscCode('');
        setBranch('');
        setCustomerId('');
        setNetBankingUsername('');
        setCards([]);
        setCustomFields([]);
        setShowAddForm(false);
        // Refresh list
        fetchBankInfos();
      } else {
        setFormError(json.error || 'Save failed');
      }
    } catch (err) {
      setFormError('Network error saving bank details');
    } finally {
      setSaving(false);
    }
  };

'''

new_content = content[:start_idx] + new_block + content[end_idx:]

with open('src/app/bank-info/page.js', 'w', encoding='utf-8') as f:
    f.write(new_content)

print('File repaired successfully')
