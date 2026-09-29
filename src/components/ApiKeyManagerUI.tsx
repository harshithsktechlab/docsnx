'use client';

import React, { useState, useEffect } from 'react';
import { Key, PlusCircle, Trash2, Activity, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { apiCall } from '@/lib/net/apiRequest';

export default function ApiKeyManagerUI() {
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newName, setNewName] = useState('');
  const [healthStatus, setHealthStatus] = useState<Record<string, any>>({});
  const [checkingHealth, setCheckingHealth] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchKeys();
  }, []);

  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║  THE SCREEN THAT DIAGNOSES AI FAILURES COULD NOT DIAGNOSE ITS OWN      ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   * Five handlers, and between them they managed:
   *
   *   · "Failed to fetch keys" for a 401, a 500 and a dropped connection alike
   *     — and ONLY on a throw, so a 500 that answered normally set no error at
   *     all and left the list silently empty.
   *   · `handleDelete` and `handleToggleActive` reported nothing whatsoever on
   *     failure. `if (res.ok) fetchKeys()` with no else: the row simply did not
   *     change, and the admin pressed it again.
   *   · "Network error" from `handleAddKey`, for a key the route rejected.
   *
   * This is the screen a super-admin opens when the AI has stopped working
   * everywhere else, so being unable to say why it itself failed is a
   * particularly poor place for it.
   */
  const fetchKeys = async () => {
    try {
      const { res, json } = await apiCall('/api/admin/ai-keys', {}, {
        subject: 'API keys', action: 'loading the API keys',
      });
      if (!res.ok) {
        setError(json.error);
        return;
      }
      setError(null);
      setKeys(json.keys || []);
    } finally {
      setLoading(false);
    }
  };

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey) return;
    const { res, json } = await apiCall('/api/admin/ai-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: newKey, name: newName, provider: 'GEMINI' }),
    }, { subject: 'API key', action: 'adding this API key' });
    if (!res.ok) {
      setError(json.error || 'Failed to add key');
      return;
    }
    setError(null);
    setNewKey('');
    setNewName('');
    fetchKeys();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this key?')) return;
    const { res, json } = await apiCall(`/api/admin/ai-keys?id=${id}`, { method: 'DELETE' }, {
      subject: 'API key', action: 'deleting this API key',
    });
    if (!res.ok) {
      setError(json.error || 'Failed to delete key');
      return;
    }
    setError(null);
    fetchKeys();
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    const { res, json } = await apiCall('/api/admin/ai-keys', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, isActive: !currentStatus }),
    }, { subject: 'API key', action: 'updating this API key' });
    if (!res.ok) {
      setError(json.error || 'Failed to update key status');
      return;
    }
    setError(null);
    fetchKeys();
  };

  const handleCheckHealth = async (id: string) => {
    setCheckingHealth(prev => ({ ...prev, [id]: true }));
    try {
      const { res, json: data } = await apiCall('/api/admin/ai-keys/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }, { subject: 'API key', action: 'checking this key' });
      if (res.ok && data.success) {
        setHealthStatus(prev => ({ ...prev, [id]: data.health }));
      } else {
        // `json.error` now holds the reason the check did not run — an expired
        // session, a 502, the provider unreachable — where it used to hold
        // "Network Error" for all three and, on a throw, nothing at all.
        setHealthStatus(prev => ({
          ...prev,
          [id]: { valid: false, reason: data.error || 'Failed to check health' },
        }));
      }
    } finally {
      setCheckingHealth(prev => ({ ...prev, [id]: false }));
    }
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Key className="w-6 h-6 text-indigo-600" />
          AI API Keys
        </h2>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-5 h-5" />
          {error}
        </div>
      )}

      <form onSubmit={handleAddKey} className="mb-8 grid grid-cols-1 md:grid-cols-3 gap-4 bg-gray-50 p-4 rounded-lg border border-gray-100">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Key Name / Identifier</label>
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g., Gemini Primary" className="w-full p-2 border rounded" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
          <input type="text" value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="AIzaSy..." className="w-full p-2 border rounded" required />
        </div>
        <div className="flex items-end">
          <button type="submit" className="w-full bg-indigo-600 text-white p-2 rounded hover:bg-indigo-700 flex items-center justify-center gap-2">
            <PlusCircle className="w-5 h-5" />
            Add Key
          </button>
        </div>
      </form>

      <div className="space-y-4">
        {keys.map(key => (
          <div key={key.id} className={`p-4 border rounded-lg flex items-center justify-between ${!key.isActive ? 'bg-gray-50 opacity-75' : 'bg-white'}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-gray-900">{key.name || 'Unnamed Key'}</h3>
                <span className={`text-xs px-2 py-1 rounded-full ${key.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                  {key.isActive ? 'Active' : 'Inactive'}
                </span>
                <span className="text-xs px-2 py-1 rounded-full bg-indigo-100 text-indigo-800">
                  {key.provider}
                </span>
              </div>
              <p className="text-sm text-gray-500 font-mono mt-1">
                {key.key.substring(0, 10)}...{key.key.substring(key.key.length - 4)}
              </p>
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <Activity className="w-3 h-3" />
                  Used {key.usageCount} times
                </span>
                {key.lastUsedAt && (
                  <span>Last used: {new Date(key.lastUsedAt).toLocaleString()}</span>
                )}
                {healthStatus[key.id] && (
                  <span className={`flex items-center gap-1 ${healthStatus[key.id].valid ? 'text-green-600' : 'text-red-600'}`}>
                    {healthStatus[key.id].valid ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                    {healthStatus[key.id].valid ? 'Healthy' : `Invalid: ${healthStatus[key.id].reason}`}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4 ml-4">
               <button
                onClick={() => handleCheckHealth(key.id)}
                disabled={checkingHealth[key.id]}
                className="text-sm px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md transition-colors flex items-center gap-1"
              >
                {checkingHealth[key.id] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                Health
              </button>
              <button
                onClick={() => handleToggleActive(key.id, key.isActive)}
                className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
                  key.isActive ? 'bg-orange-50 text-orange-600 hover:bg-orange-100' : 'bg-green-50 text-green-600 hover:bg-green-100'
                }`}
              >
                {key.isActive ? 'Deactivate' : 'Activate'}
              </button>
              <button
                onClick={() => handleDelete(key.id)}
                className="p-1.5 text-red-500 hover:bg-red-50 rounded-md transition-colors"
                title="Delete Key"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          </div>
        ))}
        {keys.length === 0 && (
          <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            No API keys added yet.
          </div>
        )}
      </div>
    </div>
  );
}
