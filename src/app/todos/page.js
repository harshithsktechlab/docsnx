'use client';

import React, { useEffect, useState } from 'react';
import {
  ListTodo,
  Plus,
  X,
  Search,
  Trash2,
  Calendar,
  User,
  Share2,
  Printer,
  Download,
  Pencil,
  CheckCircle2,
  Clock,
  CheckCircle,
  Bell,
  Sparkles,
  Upload,
  Info,
  Eye,
  FileDown
} from 'lucide-react';
import { toast } from 'sonner';
import { acceptedFileFrom } from '@/app/components/acceptFile';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import { shareRecord, printRecord, getFileUrl, downloadRecord } from '@/lib/sharePrintHelper';
import { reportShareResult } from '@/lib/shareToast';
import { clientGetMe } from '@/lib/clientAuth';
import { formatDate } from '@/lib/dateHelper';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { postUpload } from '@/lib/records/uploadRequest';
import { toastApiError } from '@/lib/net/toastApiError';


export default function TodosPage() {
  // Every request this page makes is scoped to the workspace in the URL:
  // the household at `/todos`, one company at `/business/<id>/todos`. See
  // useWorkspaceApi — `api` is `apiCall` with that already bound.
  const { api } = useWorkspaceApi();
  const [todos, setTodos] = useState([]);
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const [canShare, setCanShare] = useState(false);
  // `todos:edit`. The tick-circle needs it OR ownership of the task — see
  // `canStrike` below and the header of api/todos/[id]/route.ts.
  const [canEdit, setCanEdit] = useState(false);

  // Search & Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all', 'PENDING', 'COMPLETED'

  // Add Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [task, setTask] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState('none');
  const [pushNotification, setPushNotification] = useState(false);
  const [saving, setSaving] = useState(false);


  // Edit Form State
  const [editingTodo, setEditingTodo] = useState(null);
  const [editTask, setEditTask] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editAssigneeId, setEditAssigneeId] = useState('none');
  const [editStatus, setEditStatus] = useState('PENDING');
  const [editPushNotification, setEditPushNotification] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  
  // AI scanning states
  const [file, setFile] = useState(null);
  const [editFile, setEditFile] = useState(null);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');

  const fetchTodos = async () => {
    try {
      const { json } = await api('/api/todos');
      if (json.success) {
        setTodos(json.todos || []);
      } else {
        toast.error(json.error || 'Failed to fetch to-dos');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[todos] handler threw', err);
      toast.error('Something went wrong fetching to-dos. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Who a to-do can be assigned to, in THIS workspace.
   *
   * Two things were wrong with the `/api/users` call this replaces:
   *
   *  · That route is TENANT_ADMIN-only, so for a STANDARD user it 403'd and the
   *    `catch` swallowed it — the assignee dropdown fell back to a list of one
   *    (themselves) and looked like a feature nobody had finished. That is the
   *    exact bug /api/members was created to fix, and this page was never moved.
   *  · It was tenant-wide, so inside a company the picker offered household
   *    members. A company's task assigned to somebody's spouse is the blur the
   *    business account exists to remove.
   *
   * `api` is `apiCall` with the workspace already bound, so the company on the
   * URL rides along and the route answers with that company's members.
   */
  const fetchUsers = async () => {
    try {
      const { json } = await api('/api/members');
      if (json?.success) setUsers(json.members || []);
    } catch (err) {
      console.warn('Failed to fetch members list:', err);
    }
  };

  useEffect(() => {
    async function initPage() {
      setLoading(true);
      await fetchTodos();
      
      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          setCurrentUser(u);
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanShare(true);
            setCanEdit(true);
          } else {
            const perm = u.permissions?.find(p => p.module === 'todos' && !p.documentKey);
            setCanShare(!!perm?.canShare);
            setCanEdit(!!perm?.canEdit);
          }
          // For every role now, not only the admin. `/api/members` deliberately
          // has no permission gate — knowing who is in your own workspace is
          // what every assignee picker needs — so the fallback that used to
          // hand a standard user a list containing only themselves is gone.
          await fetchUsers();
        }
      } catch (err) {
        console.error('Error loading permissions:', err);
      }
    }
    initPage();
  }, []);

  const handleFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setFile(chosen);
  };

  const handleEditFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setEditFile(chosen);
  };

  const formatDateToInput = (dateStr) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      return d.toISOString().substring(0, 10);
    } catch (e) {
      return '';
    }
  };

  const handleAiScan = async () => {
    const selectedFile = editingTodo ? editFile : file;
    if (!selectedFile) {
      toast.info('Please select or upload a document file first to use AI Auto-fill.');
      return;
    }

    setAiScanning(true);
    setAiMessage('Uploading & scanning document page contents with AI...');

    try {
      const formData = new FormData();
      formData.append('files', selectedFile);

      /**
       * `postUpload`, not `fetch`: this sends a file, so nginx answers an
       * oversized one with a 413 HTML page — and `res.json()` threw a
       * SyntaxError on it, which landed in the catch below and was reported as
       * "Network error calling AI Scan endpoint". The user went and checked a
       * connection that was working perfectly.
       */
      const outcome = await postUpload('/api/ai/scan', formData);
      if (!outcome.ok) {
        // Names the actual cause. An empty credit balance, a model the provider
        // retired, a file over the size limit and a dropped connection all used
        // to arrive as "AI could not detect structured values. Try filling
        // manually." — which describes a model that read the document and found
        // nothing in it, and is true for none of them.
        toastApiError(outcome, { subject: 'document', action: 'reading this document' });
        setAiMessage('');
        return;
      }
      const json = outcome.json;
      if (json.success && json.proposedRecords?.length > 0) {
        const proposed = json.proposedRecords[0];
        const data = proposed.extractedData;
        const title = proposed.title || '';

        // Safely extract proposed values
        const extractedTask = data.task || title || '';
        const extractedDueDate = formatDateToInput(data.dueDate);

        if (editingTodo) {
          if (extractedTask) setEditTask(extractedTask);
          if (extractedDueDate) setEditDueDate(extractedDueDate);
        } else {
          if (extractedTask) setTask(extractedTask);
          if (extractedDueDate) setDueDate(extractedDueDate);
        }

        setAiMessage('AI Auto-fill successful! Form fields updated.');
        setTimeout(() => setAiMessage(''), 3000);
      } else {
        // Reached only when the scan genuinely came back with nothing to fill
        // in — every other cause returned above with its own sentence.
        toast.error(json.error
          || 'The scan did not find these fields on this document — fill them in below.');
        setAiMessage('');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[todos] handler threw', err);
      toast.error('Something went wrong calling AI Scan endpoint. Please try again.');
      setAiMessage('');
    } finally {
      setAiScanning(false);
    }
  };

  // ─── Closing the Add form ─────────────────────────────────────────────────
  // Every way out goes through these two, so "closed" has ONE definition and it
  // always clears. Before, the fields were reset only inside the success branch
  // of handleSubmit, so dismissing a half-typed entry left it sitting in state
  // to reappear whole the next time the form was opened.
  const resetAddForm = () => {
    setTask('');
    setDueDate('');
    setAssigneeId('none');
    setPushNotification(false);
    setFile(null);
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!task.trim()) {
      toast.error('Task description is required');
      return;
    }

    setSaving(true);

    try {
      const { json } = await api('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        task: task.trim(),
        dueDate: dueDate || null,
        assigneeId: assigneeId === 'none' ? null : assigneeId,
        status: 'PENDING',
        pushNotification
        })
      });
      if (json.success) {
        closeAddForm();
        fetchTodos();
      } else {
        toast.error(json.error || 'Failed to create task');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[todos] handler threw', err);
      toast.error('Something went wrong creating task. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (todo) => {
    const nextStatus = todo.status === 'COMPLETED' ? 'PENDING' : 'COMPLETED';
    try {
      const { json } = await api(`/api/todos/${todo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus })
      });
      if (json.success) {
        fetchTodos();
      } else {
        toast.error(json.error || 'Failed to update status');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[todos] handler threw', err);
      toast.error('Something went wrong updating status. Please try again.');
    }
  };

  const openEditModal = (todo) => {
    setEditingTodo(todo);
    setEditTask(todo.task || '');
    setEditDueDate(todo.dueDate ? todo.dueDate.substring(0, 10) : '');
    setEditAssigneeId(todo.assigneeId || 'none');
    setEditStatus(todo.status || 'PENDING');
    setEditPushNotification(todo.pushNotification || false);
    setEditFile(null);

  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingTodo) return;
    if (!editTask.trim()) {
      toast.error('Task description is required');
      return;
    }
    setEditSaving(true);


    try {
      const { json } = await api(`/api/todos/${editingTodo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        task: editTask.trim(),
        dueDate: editDueDate || null,
        assigneeId: editAssigneeId === 'none' ? null : editAssigneeId,
        status: editStatus,
        pushNotification: editPushNotification
        })
      });
      if (json.success) {
        setEditingTodo(null);
        setEditFile(null);
        fetchTodos();
      } else {
        toast.error(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[todos] handler threw', err);
      toast.error('Something went wrong updating task. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this task?')) return;
    try {
      const { json } = await api(`/api/todos/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchTodos();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[todos] handler threw', err);
      toast.error('Something went wrong deleting task. Please try again.');
    }
  };

  const handleShare = async (todo) => {
    const fields = [
      { label: 'Task', value: todo.task },
      { label: 'Due Date', value: todo.dueDate ? formatDate(todo.dueDate) : 'No due date' },
      { label: 'Assignee', value: todo.assignee?.name || 'Unassigned' },
      { label: 'Status', value: todo.status }
    ];
    const res = await shareRecord(`To-Do Task: ${todo.task}`, fields, `Assigned to: ${todo.assignee?.name || 'Unassigned'}`);
    reportShareResult(res);
  };

  const handlePrint = (todo) => {
    const fields = [
      { label: 'Task', value: todo.task },
      { label: 'Due Date', value: todo.dueDate ? formatDate(todo.dueDate) : 'No due date' },
      { label: 'Assignee', value: todo.assignee?.name || 'Unassigned' },
      { label: 'Status', value: todo.status }
    ];
    printRecord(`To-Do Task`, fields, `Status: ${todo.status}`);
  };

  /**
   * Who may tick a task off: anyone with `todos:edit`, and otherwise the task's
   * own assignee or creator. The server decides the same way — this only keeps
   * the circle from promising a click it will refuse.
   */
  const canStrike = (todo) =>
    canEdit
    || (!!currentUser && (todo.assigneeId === currentUser.id || todo.creatorId === currentUser.id));

  const filteredTodos = todos.filter(todo => {
    const matchesSearch = todo.task.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (todo.assignee?.name && todo.assignee.name.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = statusFilter === 'all' || todo.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getDueDateLabel = (dateStr) => {
    if (!dateStr) return 'No due date';
    const date = new Date(dateStr);
    const formatted = formatDate(date); // dd/mm/yyyy
    
    // Check if overdue
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dateStr);
    due.setHours(0, 0, 0, 0);
    
    if (due < today) {
      return <span className="text-red-400 font-semibold">{formatted} (Overdue)</span>;
    }
    return <span>{formatted}</span>;
  };

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="grid grid-cols-1 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between gap-4 animate-fade-in">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">To-Dos & Tasks</h1>
          <p className="text-muted-foreground text-sm">Organize daily chores, tasks, and assignments</p>
        </div>
        <Button 
          onClick={() => (showAddForm ? closeAddForm() : setShowAddForm(true))}
          variant={showAddForm ? "destructive" : "default"}
          size="icon"
          className="h-10 w-10 rounded-full shadow-lg"
        >
          {showAddForm ? <X size={20} /> : <Plus size={20} />}
        </Button>
      </div>



      {/* Add Task Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <ListTodo className="text-sky-400" size={20} />
              <span>Add New Task</span>
            </h2>
          </CardHeader>



          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task">Task Description *</Label>
              <Input
                id="task"
                placeholder="e.g. Buy groceries, pay electricity bill..."
                value={task}
                onChange={(e) => setTask(e.target.value)}
                disabled={saving}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dueDate">Due Date</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="assigneeId">Assign To</Label>
                <Select value={assigneeId} onValueChange={(val) => setAssigneeId(val)} disabled={saving}>
                  <SelectTrigger id="assigneeId">
                    <SelectValue placeholder="Select Member" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned / All</SelectItem>
                    {users.map(u => (
                      <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="pushNotification"
                checked={pushNotification}
                onChange={(e) => setPushNotification(e.target.checked)}
                className="w-4 h-4 rounded border-border bg-card text-primary focus:ring-primary"
                disabled={saving}
              />
              <Label htmlFor="pushNotification" className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <Bell size={13} className="text-muted-foreground" />
                <span>Send FCM Push Notification Alert</span>
              </Label>
            </div>

            {/* Document Upload with AI Auto-fill visual button */}
            <div className="flex flex-col gap-2.5 border-t border-border/30 pt-4 mt-2">
              <Label>Attach/Scan document to auto-fill details</Label>
              <div className="flex flex-col sm:flex-row gap-3 items-center">
                <div className="border-2 border-dashed border-border/50 rounded-xl p-4 text-center bg-card hover:bg-card transition-colors relative cursor-pointer flex-1 w-full">
                  <input
                    type="file"
                    accept={UPLOAD_ACCEPT_ATTRIBUTE}
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={saving || aiScanning}
                  />
                  <Upload size={18} className="mx-auto text-muted-foreground mb-1" />
                  <p className="text-xs font-semibold text-foreground truncate max-w-[280px] mx-auto">
                    {file ? file.name : 'Select file to scan'}
                  </p>
                </div>

                <Button 
                  type="button" 
                  variant="outline"
                  onClick={handleAiScan}
                  disabled={aiScanning || saving}
                  className="h-12 w-full sm:w-auto px-4 bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 font-bold flex gap-2 shrink-0 shadow-sm"
                >
                  <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                  <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                </Button>
              </div>
              {aiMessage && (
                <div className="flex items-center gap-1.5 text-xs text-sky-400 font-medium">
                  <Info size={13} />
                  <span>{aiMessage}</span>
                </div>
              )}
            </div>

            {/* Cancel sits WITH Save, at the foot of the form, because that is
                where someone who has changed their mind actually is — the toggle up
                in the page header has long since scrolled away. It discards whatever
                was typed; see closeAddForm. */}
            <div className="mt-2 flex gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={closeAddForm}
                disabled={saving}
                className="h-11 px-6"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving}
                className="h-11 flex-1"
              >
                {saving ? 'Adding task...' : 'Add Task'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col md:flex-row gap-4 animate-fade-in">
        <div className="relative flex-grow">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input
            placeholder="Search by task description, assignee..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        <div className="flex gap-2">
          {['all', 'PENDING', 'COMPLETED'].map((status) => (
            <Button
              key={status}
              variant={statusFilter === status ? "default" : "outline"}
              onClick={() => setStatusFilter(status)}
              className="h-11 px-5 text-xs font-semibold rounded-lg shrink-0"
            >
              {status === 'all' ? 'All Tasks' : status === 'PENDING' ? 'Pending' : 'Completed'}
            </Button>
          ))}
        </div>
      </div>

      {/* Task List */}
      {filteredTodos.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <ListTodo size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No tasks found</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filteredTodos.map((todo) => {
            const isCompleted = todo.status === 'COMPLETED';
            const strikeable = canStrike(todo);
            return (
              <Card 
                key={todo.id}
                className={`border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 animate-fade-in ${
                  isCompleted ? 'opacity-70 line-through' : ''
                }`}
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <button 
                    onClick={() => handleToggleStatus(todo)}
                    disabled={!strikeable}
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors focus:outline-none disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
                    title={
                      !strikeable
                        ? 'Only the assignee or the creator can complete this task'
                        : isCompleted ? 'Mark as pending' : 'Mark as completed'
                    }
                  >
                    {isCompleted ? (
                      <CheckCircle2 size={22} className="text-emerald-400" />
                    ) : (
                      <div className={`w-[22px] h-[22px] rounded-full border-2 border-muted-foreground/60 transition-colors ${strikeable ? 'hover:border-primary' : 'opacity-50'}`} />
                    )}
                  </button>

                  <div className="flex flex-col min-w-0">
                    <span className={`font-bold text-foreground text-sm leading-snug break-words ${isCompleted ? 'text-muted-foreground' : ''}`}>
                      {todo.task}
                    </span>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-1.5">
                      <div className="flex items-center gap-1">
                        <Calendar size={12} className="text-muted-foreground" />
                        {getDueDateLabel(todo.dueDate)}
                      </div>
                      <div className="flex min-w-0 items-center gap-1 font-medium">
                        <User size={12} className="shrink-0 text-sky-400" />
                        {/* A long assignee name is the one thing here that can
                            outgrow the card; truncate rather than spill. */}
                        <span className="truncate">Assignee: {todo.assignee?.name || 'Unassigned'}</span>
                      </div>
                      {todo.creator?.name && (
                        <div className="text-xs text-faint">
                          (Created by {todo.creator.name})
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="relative flex items-center justify-end gap-1.5 shrink-0 border-t md:border-t-0 pt-3 md:pt-0 border-border/30">
                  <Button 
                    onClick={() => handleShare(todo)}
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-sky-400 hover:bg-sky-500/10 hover:text-sky-300 rounded-lg"
                    title="Share"
                  >
                    <Share2 size={14} />
                  </Button>
                  <Button 
                    onClick={() => handlePrint(todo)}
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-pink-400 hover:bg-pink-500/10 hover:text-pink-300 rounded-lg"
                    title="Download as PDF"
                  >
                    <FileDown size={14} />
                  </Button>

                  <RowActionsMenu
                    variant="ghost"
                    iconSize={14}
                    triggerClassName="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted/10"
                    items={[
                      {
                        key: 'edit',
                        icon: <Pencil size={12} />,
                        label: 'Edit',
                        onClick: () => openEditModal(todo),
                      },
                      {
                        key: 'delete',
                        icon: <Trash2 size={12} />,
                        label: 'Delete',
                        destructive: true,
                        onClick: () => handleDelete(todo.id),
                      },
                    ]}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit Task Modal */}
      <Dialog open={!!editingTodo} onOpenChange={(open) => !open && setEditingTodo(null)}>
        {editingTodo && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Task Details</DialogTitle>
            </DialogHeader>



            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editTask">Task Description *</Label>
                <Input
                  id="editTask"
                  value={editTask}
                  onChange={(e) => setEditTask(e.target.value)}
                  disabled={editSaving}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editDueDate">Due Date</Label>
                  <Input
                    id="editDueDate"
                    type="date"
                    value={editDueDate}
                    onChange={(e) => setEditDueDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editAssigneeId">Assign To</Label>
                  <Select value={editAssigneeId} onValueChange={(val) => setEditAssigneeId(val)} disabled={editSaving}>
                    <SelectTrigger id="editAssigneeId">
                      <SelectValue placeholder="Select Member" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned / All</SelectItem>
                      {users.map(u => (
                        <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editStatus">Status</Label>
                  <Select value={editStatus} onValueChange={(val) => setEditStatus(val)} disabled={editSaving}>
                    <SelectTrigger id="editStatus">
                      <SelectValue placeholder="Select Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="COMPLETED">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2 pt-6">
                  <input
                    type="checkbox"
                    id="editPushNotification"
                    checked={editPushNotification}
                    onChange={(e) => setEditPushNotification(e.target.checked)}
                    className="w-4 h-4 rounded border-border bg-card text-primary focus:ring-primary"
                    disabled={editSaving}
                  />
                  <Label htmlFor="editPushNotification" className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                    <Bell size={13} className="text-muted-foreground" />
                    <span>Send FCM Alert</span>
                  </Label>
                </div>

                <div className="flex flex-col gap-2.5 border-t border-border/30 pt-4 mt-2">
                  <Label>Attach/Scan document to auto-fill details</Label>
                  <div className="flex flex-col sm:flex-row gap-3 items-center">
                    <div className="border-2 border-dashed border-border/50 rounded-xl p-4 text-center bg-card hover:bg-card transition-colors relative cursor-pointer flex-1 w-full">
                      <input
                        type="file"
                        accept={UPLOAD_ACCEPT_ATTRIBUTE}
                        onChange={handleEditFileChange}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        disabled={editSaving || aiScanning}
                      />
                      <Upload size={18} className="mx-auto text-muted-foreground mb-1" />
                      <p className="text-xs font-semibold text-foreground truncate max-w-[280px] mx-auto">
                        {editFile ? editFile.name : 'Select file to scan'}
                      </p>
                    </div>

                    <Button 
                      type="button" 
                      variant="outline"
                      onClick={handleAiScan}
                      disabled={aiScanning || editSaving}
                      className="h-12 w-full sm:w-auto px-4 bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 font-bold flex gap-2 shrink-0 shadow-sm"
                    >
                      <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                      <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                    </Button>
                  </div>
                  {aiMessage && (
                    <div className="flex items-center gap-1.5 text-xs text-sky-400 font-medium">
                      <Info size={13} />
                      <span>{aiMessage}</span>
                    </div>
                  )}
                </div>
              </div>

              <Button 
                type="submit" 
                disabled={editSaving}
                className="mt-2 w-full h-11"
              >
                {editSaving ? 'Updating task...' : 'Save Changes'}
              </Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </PageContainer>
  );
}
