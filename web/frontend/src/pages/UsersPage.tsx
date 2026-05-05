import { useEffect, useRef, useState } from 'react'

type Role = 'admin' | 'user'

interface UserRow {
  username: string
  role: Role
  has_avatar: boolean
  created_at: string | null
  updated_at: string | null
}

interface Me {
  authenticated: boolean
  username?: string
  role?: Role
}

const fmtDate = (iso: string | null) => {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

export default function UsersPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [creating, setCreating] = useState(false)

  const load = async () => {
    setError('')
    try {
      const [meRes, usersRes] = await Promise.all([
        fetch('/api/auth/me').then((r) => r.json()),
        fetch('/api/users').then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      ])
      setMe(meRes)
      setUsers(usersRes)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) return <div className="text-gray-500 text-sm">Loading…</div>
  if (me && !me.authenticated) return <div className="text-amber-300">Not authenticated.</div>
  if (me && me.role !== 'admin') {
    return (
      <div className="bg-red-900/30 border border-red-800 rounded p-4 text-sm text-red-200">
        This page is for admins only. You're signed in as <span className="font-mono">{me.username}</span> with role <span className="font-mono">{me.role}</span>.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-gray-500 mt-1">
            Add, edit, and remove studio users. Each user gets a username, password, role, and optional avatar.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 text-white text-sm rounded font-medium"
        >
          + Add user
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded p-3 text-sm text-red-200">{error}</div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-950/60 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">User</th>
              <th className="text-left px-4 py-2">Role</th>
              <th className="text-left px-4 py-2">Created</th>
              <th className="text-left px-4 py-2">Updated</th>
              <th className="text-right px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {users.map((u) => (
              <tr key={u.username} className="hover:bg-gray-800/40">
                <td className="px-4 py-2.5 flex items-center gap-2.5">
                  <Avatar username={u.username} hasAvatar={u.has_avatar} />
                  <span className="font-mono text-gray-200">{u.username}</span>
                  {me?.username === u.username && (
                    <span className="text-[10px] text-jam-300 uppercase tracking-wider">you</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                    u.role === 'admin' ? 'bg-jam-700/40 text-jam-200' : 'bg-gray-800 text-gray-300'
                  }`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{fmtDate(u.created_at)}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{fmtDate(u.updated_at)}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => setEditing(u)}
                    className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-sm">No users.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load() }}
        />
      )}
      {editing && (
        <EditModal
          user={editing}
          isSelf={me?.username === editing.username}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function Avatar({ username, hasAvatar }: { username: string; hasAvatar: boolean }) {
  if (!hasAvatar) {
    return (
      <div className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-xs font-semibold text-gray-400">
        {username.slice(0, 2).toUpperCase()}
      </div>
    )
  }
  return (
    <img
      src={`/api/users/${encodeURIComponent(username)}/avatar`}
      alt=""
      className="w-8 h-8 rounded-full object-cover border border-gray-700"
    />
  )
}

function CreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError(''); setBusy(true)
    try {
      const fd = new FormData()
      fd.append('username', username.trim())
      fd.append('password', password)
      fd.append('role', role)
      const r = await fetch('/api/users', { method: 'POST', body: fd })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell title="Add user" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Username">
          <input
            value={username} onChange={(e) => setUsername(e.target.value)}
            autoFocus className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
            placeholder="alex"
          />
        </Field>
        <Field label="Password">
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
            placeholder="at least 4 characters"
          />
        </Field>
        <Field label="Role">
          <RoleToggle value={role} onChange={setRole} />
        </Field>
        {error && <ErrorBox text={error} />}
        <ModalActions
          onCancel={onClose}
          onConfirm={submit}
          confirmLabel={busy ? 'Saving…' : 'Create user'}
          confirmDisabled={busy || !username.trim() || !password}
        />
      </div>
    </ModalShell>
  )
}

function EditModal({
  user, isSelf, onClose, onSaved,
}: {
  user: UserRow; isSelf: boolean; onClose: () => void; onSaved: () => void
}) {
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>(user.role)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const save = async () => {
    setError(''); setBusy(true)
    try {
      const fd = new FormData()
      let any = false
      if (password) { fd.append('password', password); any = true }
      if (role !== user.role) { fd.append('role', role); any = true }
      if (any) {
        const r = await fetch(`/api/users/${encodeURIComponent(user.username)}`, { method: 'PUT', body: fd })
        if (!r.ok) {
          const e = await r.json().catch(() => ({}))
          throw new Error(e.detail || `HTTP ${r.status}`)
        }
      }
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const uploadAvatar = async (file: File) => {
    setError(''); setBusy(true)
    try {
      const fd = new FormData()
      fd.append('avatar', file)
      const r = await fetch(`/api/users/${encodeURIComponent(user.username)}/avatar`, { method: 'PUT', body: fd })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setError(''); setBusy(true)
    try {
      const r = await fetch(`/api/users/${encodeURIComponent(user.username)}`, { method: 'DELETE' })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <ModalShell title={`Edit ${user.username}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Avatar">
          <div className="flex items-center gap-3">
            <Avatar username={user.username} hasAvatar={user.has_avatar} />
            <input
              ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) uploadAvatar(f)
              }}
              className="text-xs text-gray-400 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-gray-800 file:text-gray-300 file:hover:bg-gray-700"
            />
          </div>
          <p className="text-[10px] text-gray-600 mt-1">PNG / JPG / WebP, up to 4 MB</p>
        </Field>
        <Field label="Username">
          <input value={user.username} disabled className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 opacity-60" />
          <p className="text-[10px] text-gray-600 mt-1">Username is the immutable key — delete and re-create to rename.</p>
        </Field>
        <Field label="New password (optional)">
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500" placeholder="leave blank to keep current"
          />
        </Field>
        <Field label="Role">
          <RoleToggle value={role} onChange={setRole} disabled={isSelf} />
          {isSelf && (
            <p className="text-[10px] text-gray-600 mt-1">You can't change your own role.</p>
          )}
        </Field>
        {error && <ErrorBox text={error} />}
        <div className="flex items-center gap-2 pt-2 border-t border-gray-800 justify-between">
          {!isSelf ? (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-300">Really delete?</span>
                <button onClick={remove} disabled={busy} className="px-2 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded">Yes, delete</button>
                <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="px-2 py-1 bg-red-900/40 hover:bg-red-800/60 text-red-200 text-xs rounded">Delete user</button>
            )
          ) : <span />}
          <ModalActions
            onCancel={onClose}
            onConfirm={save}
            confirmLabel={busy ? 'Saving…' : 'Save'}
            confirmDisabled={busy || (!password && role === user.role)}
          />
        </div>
      </div>
    </ModalShell>
  )
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-100">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

function RoleToggle({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-1">
      {(['user', 'admin'] as Role[]).map((r) => (
        <button
          key={r} disabled={disabled} onClick={() => onChange(r)}
          className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${
            value === r ? 'bg-jam-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {r}
        </button>
      ))}
    </div>
  )
}

function ErrorBox({ text }: { text: string }) {
  return <div className="bg-red-900/30 border border-red-800 rounded p-2 text-xs text-red-200">{text}</div>
}

function ModalActions({
  onCancel, onConfirm, confirmLabel, confirmDisabled,
}: {
  onCancel: () => void; onConfirm: () => void; confirmLabel: string; confirmDisabled?: boolean
}) {
  return (
    <div className="flex justify-end gap-2">
      <button onClick={onCancel} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded">
        Cancel
      </button>
      <button
        onClick={onConfirm} disabled={confirmDisabled}
        className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded font-medium"
      >
        {confirmLabel}
      </button>
    </div>
  )
}
