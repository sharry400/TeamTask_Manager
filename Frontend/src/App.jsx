import { useEffect, useMemo, useState } from 'react'

const API = import.meta.env.VITE_API_URL || '/api'
async function request(path, options = {}) {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API}${path}`, {
    credentials: 'include',
    ...options,
    headers
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong')
    error.status = response.status
    throw error
  }
  return data
}
const blankTask = { title: '', description: '', teamId: '', assignedTo: '', status: 'todo', dueDate: '' }

export default function App() {
  const [user, setUser] = useState(null)
  const [authMode, setAuthMode] = useState('login')
  const [auth, setAuth] = useState({ name: '', email: '', password: '' })
  const [teams, setTeams] = useState([])
  const [membersByTeam, setMembersByTeam] = useState({})
  const [tasks, setTasks] = useState([])
  const [selectedTeam, setSelectedTeam] = useState('all')
  const [assignee, setAssignee] = useState('all')
  const [search, setSearch] = useState('')
  const [showTeamForm, setShowTeamForm] = useState(false)
  const [teamForm, setTeamForm] = useState({ name: '', description: '' })
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [taskForm, setTaskForm] = useState(blankTask)
  const [inviteEmail, setInviteEmail] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const flashError = e => { setError(e.message || 'Request failed'); setNotice('') }
  const flashNotice = message => { setNotice(message); setError('') }

  async function loadDashboard() {
    const [teamData, taskData] = await Promise.all([request('/teams'), request('/tasks')])
    const memberships = await Promise.all(teamData.teams.map(async team => {
      const data = await request(`/teams/${team.id}/members`)
      return [String(team.id), data.members]
    }))
    setTeams(teamData.teams)
    setTasks(taskData.tasks)
    setMembersByTeam(Object.fromEntries(memberships))
  }
  useEffect(() => {
    request('/auth/me').then(data => { setUser(data.user); return loadDashboard() })
      .catch(error => { if (error.status !== 401) flashError(error) })
      .finally(() => setLoading(false))
  }, [])

  async function submitAuth(e) {
    e.preventDefault(); setError(''); setNotice('')
    try {
      const path = authMode === 'login' ? '/auth/login' : '/auth/register'
      const data = await request(path, { method: 'POST', body: JSON.stringify(auth) })
      if (authMode === 'register') {
        setAuth({ name: '', email: auth.email, password: '' })
        setAuthMode('login')
        flashNotice('Account created successfully. Please log in.')
        return
      }
      setUser(data.user)
      setAuth({ name: '', email: auth.email, password: '' })
      await loadDashboard()
      flashNotice(`Welcome${data.user.name ? `, ${data.user.name}` : ''}!`)
    } catch (e) {
      flashError(e instanceof TypeError
        ? new Error(`Backend se connection nahi ho saka. Backend running hona chahiye (npm.cmd start); API: ${API}`)
        : e)
    }
  }
  async function logout() {
    try {
      await request('/auth/logout', { method: 'POST' })
      setUser(null); setTeams([]); setTasks([]); setMembersByTeam({})
      setSelectedTeam('all'); setAssignee('all')
      setAuthMode('login')
      setAuth(current => ({ name: '', email: current.email, password: '' }))
      flashNotice('You have logged out.')
    }
    catch (e) { flashError(e) }
  }
  async function createTeam(e) {
    e.preventDefault()
    try {
      await request('/teams', { method: 'POST', body: JSON.stringify(teamForm) })
      setTeamForm({ name: '', description: '' }); setShowTeamForm(false); await loadDashboard(); flashNotice('Team created.')
    } catch (e) { flashError(e) }
  }
  async function addMember(e) {
    e.preventDefault()
    try {
      await request(`/teams/${selectedTeam}/members`, { method: 'POST', body: JSON.stringify({ email: inviteEmail }) })
      setInviteEmail('')
      await loadDashboard()
      flashNotice('Member added.')
    } catch (e) { flashError(e) }
  }
  async function saveTask(e) {
    e.preventDefault()
    const body = { ...taskForm, teamId: Number(taskForm.teamId), assignedTo: taskForm.assignedTo ? Number(taskForm.assignedTo) : null, dueDate: taskForm.dueDate || null }
    try {
      if (editing) await request(`/tasks/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      else await request('/tasks', { method: 'POST', body: JSON.stringify(body) })
      setShowTaskForm(false); setEditing(null); setTaskForm(blankTask); await loadDashboard(); flashNotice(editing ? 'Task updated.' : 'Task created.')
    } catch (e) { flashError(e) }
  }
  async function deleteTask(task) {
    if (!confirm(`Delete "${task.title}"?`)) return
    try { await request(`/tasks/${task.id}`, { method: 'DELETE' }); await loadDashboard(); flashNotice('Task deleted.') }
    catch (e) { flashError(e) }
  }
  function editTask(task) {
    setEditing(task)
    setTaskForm({ title: task.title, description: task.description || '', teamId: String(task.team_id), assignedTo: task.assigned_to ? String(task.assigned_to) : '', status: task.status, dueDate: task.due_date ? String(task.due_date).slice(0, 10) : '' })
    setShowTaskForm(true)
  }

  const visibleTasks = useMemo(() => tasks.filter(t =>
    (selectedTeam === 'all' || String(t.team_id) === selectedTeam) &&
    (assignee === 'all' || String(t.assigned_to || '') === assignee) &&
    `${t.title} ${t.description} ${t.team_name || ''}`.toLowerCase().includes(search.toLowerCase())
  ), [tasks, selectedTeam, assignee, search])

  const members = membersByTeam[selectedTeam] || []
  const taskMembers = membersByTeam[taskForm.teamId] || []
  const allMembers = [...new Map(
    Object.values(membersByTeam).flat().map(member => [member.id, member])
  ).values()]
  if (loading) return <div className="center-screen"><div className="spinner" /><p>Preparing your workspace…</p></div>
  if (!user) return <main className="auth-layout">
    <section className="auth-visual">
      <div className="brand"><span className="brand-mark">T</span> TeamFlow</div>
      <div className="hero-copy"><span className="eyebrow">WORK BETTER, TOGETHER</span><h1>Great work happens when teams move as one.</h1><p>Bring your people, projects, and priorities into one focused workspace.</p></div>
      <div className="visual-footer"><span className="dot" /> A clearer way to work together</div>
    </section>
    <section className="auth-panel"><form className="auth-card" onSubmit={submitAuth}>
      <span className="eyebrow">{authMode === 'login' ? 'WELCOME BACK' : 'GET STARTED'}</span>
      <h2>{authMode === 'login' ? 'Sign in to TeamFlow' : 'Create your account'}</h2>
      <p className="muted">{authMode === 'login' ? 'Your team is waiting for you.' : 'Set up your workspace in a few seconds.'}</p>
      {authMode === 'register' && <label>Full name<input required minLength="2" value={auth.name} onChange={e => setAuth({ ...auth, name: e.target.value })} placeholder="Alex Morgan" /></label>}
      <label>Email address<input type="email" required value={auth.email} onChange={e => setAuth({ ...auth, email: e.target.value })} placeholder="you@company.com" /></label>
      <label>Password<input type="password" required minLength="8" value={auth.password} onChange={e => setAuth({ ...auth, password: e.target.value })} placeholder="At least 8 characters" /></label>
      {(error || notice) && <div className={`alert ${error ? 'error' : 'success'}`}>{error || notice}</div>}
      <button className="primary full">{authMode === 'login' ? 'Sign in' : 'Create account'} <span>→</span></button>
      <p className="switch-auth">{authMode === 'login' ? 'New to TeamFlow?' : 'Already have an account?'} <button type="button" className="text-button" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setError('') }}>{authMode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
    </form></section>
  </main>

  const chosenTeam = teams.find(t => String(t.id) === selectedTeam)
  const myTasks = tasks.filter(t => Number(t.assigned_to) === user.id)
  const doneTasks = tasks.filter(t => t.status === 'done').length
  const openTasks = tasks.filter(t => t.status !== 'done').length

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">T</span> TeamFlow</div>
      <div className="side-label">WORKSPACE</div>
      <button className={`nav-item ${selectedTeam === 'all' ? 'active' : ''}`} onClick={() => { setSelectedTeam('all'); setAssignee('all') }}><span>▦</span> All tasks <span className="nav-count">{tasks.length}</span></button>
      <div className="side-heading"><span>YOUR TEAMS</span><button className="icon-button" onClick={() => setShowTeamForm(true)} title="Create team">＋</button></div>
      {teams.map(team => <button key={team.id} className={`nav-item ${selectedTeam === String(team.id) ? 'active' : ''}`} onClick={() => { setSelectedTeam(String(team.id)); setAssignee('all') }}><span className="team-avatar">{team.name.slice(0, 1).toUpperCase()}</span><span className="team-name">{team.name}</span></button>)}
      {!teams.length && <p className="side-empty">Create your first team to get started.</p>}
      <div className="sidebar-bottom"><div className="profile"><div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div><div className="profile-copy"><strong>{user.name}</strong><small>{user.email}</small></div><button className="icon-button" onClick={logout} title="Log out">↗</button></div></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">TEAM WORKSPACE</span><h1>{chosenTeam ? chosenTeam.name : 'Overview'}</h1></div><div className="top-actions"><span className="today-label">{new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span><button className="primary" onClick={() => { setEditing(null); setTaskForm({ ...blankTask, teamId: selectedTeam === 'all' ? (teams[0] ? String(teams[0].id) : '') : selectedTeam }); setShowTaskForm(true) }} disabled={!teams.length}>＋ New task</button></div></header>
      {(error || notice) && <div className={`alert ${error ? 'error' : 'success'}`}>{error || notice}<button onClick={() => { setError(''); setNotice('') }}>×</button></div>}
      <section className="welcome-row"><div><h2>Good to see you, {user.name.split(' ')[0]}.</h2><p>Here's what's happening with your team's work today.</p></div><button className="secondary" onClick={() => setShowTeamForm(true)}>＋ Create team</button></section>
      <section className="stats-grid">
        <article className="stat-card"><div className="stat-icon purple">▦</div><span>Tasks in workspace</span><strong>{tasks.length}</strong><small>Across your teams</small></article>
        <article className="stat-card"><div className="stat-icon amber">◷</div><span>Open tasks</span><strong>{openTasks}</strong><small>Still in progress</small></article>
        <article className="stat-card"><div className="stat-icon green">✓</div><span>Completed</span><strong>{doneTasks}</strong><small>Nice work, team</small></article>
        <article className="stat-card"><div className="stat-icon blue">♙</div><span>Assigned to me</span><strong>{myTasks.length}</strong><small>Your responsibilities</small></article>
      </section>
      <section className="tasks-panel">
        <div className="panel-heading"><div><h2>Tasks</h2><p>Manage priorities and keep everyone aligned.</p></div><span className="task-total">{visibleTasks.length} tasks</span></div>
        <div className="filters"><div className="search-box"><span>⌕</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…" /></div>
          <select value={selectedTeam} onChange={e => { setSelectedTeam(e.target.value); setAssignee('all') }}><option value="all">All teams</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select value={assignee} onChange={e => setAssignee(e.target.value)}><option value="all">All assignees</option>{allMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        </div>
        {visibleTasks.length ? <div className="task-list">{visibleTasks.map(task => <article className="task-row" key={task.id}>
          <div className={`status-mark ${task.status}`} />
          <div className="task-main"><h3>{task.title}</h3><p>{task.description || 'No description added.'}</p><div className="task-meta"><span className="team-chip">{task.team_name}</span>{task.due_date && <span>◷ Due {new Date(`${String(task.due_date).slice(0, 10)}T00:00:00`).toLocaleDateString()}</span>}{task.assignee_name && <span>Assigned to {task.assignee_name}</span>}</div></div>
          <span className={`status-pill ${task.status}`}>{task.status.replace('_', ' ')}</span>
          <div className="task-actions"><button className="icon-button" title="Edit task" onClick={() => editTask(task)}>✎</button><button className="icon-button danger-text" title="Delete task" onClick={() => deleteTask(task)}>×</button></div>
        </article>)}</div> : <div className="empty-state"><div className="empty-icon">✓</div><h3>No tasks to show</h3><p>Create a task or change your filters to see work here.</p><button className="primary" disabled={!teams.length} onClick={() => { setEditing(null); setTaskForm({ ...blankTask, teamId: teams[0] ? String(teams[0].id) : '' }); setShowTaskForm(true) }}>＋ Create first task</button></div>}
      </section>
      {chosenTeam && <section className="members-panel"><div className="panel-heading"><div><h2>Team members</h2><p>People working in {chosenTeam.name}.</p></div><span className="task-total">{members.length} members</span></div>
        {chosenTeam.created_by === user.id && <form className="invite-form" onSubmit={addMember}><input type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="Add registered member by email" /><button className="secondary">Add member</button></form>}
        <div className="member-list">{members.map(m => <div className="member-row" key={m.id}><div className="avatar">{m.name.slice(0, 1).toUpperCase()}</div><div><strong>{m.name}</strong><small>{m.email}</small></div><span className="role-pill">{m.role}</span></div>)}</div>
      </section>}
    </main>

    {showTeamForm && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowTeamForm(false) }}><form className="modal" onSubmit={createTeam}><div className="modal-title"><div><span className="eyebrow">NEW WORKSPACE</span><h2>Create a team</h2></div><button type="button" className="icon-button" onClick={() => setShowTeamForm(false)}>×</button></div><label>Team name<input required minLength="2" maxLength="120" value={teamForm.name} onChange={e => setTeamForm({ ...teamForm, name: e.target.value })} placeholder="e.g. Product Design" /></label><label>Description<textarea maxLength="1000" value={teamForm.description} onChange={e => setTeamForm({ ...teamForm, description: e.target.value })} placeholder="What will this team work on?" /></label><div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowTeamForm(false)}>Cancel</button><button className="primary">Create team</button></div></form></div>}
    {showTaskForm && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowTaskForm(false) }}><form className="modal" onSubmit={saveTask}><div className="modal-title"><div><span className="eyebrow">{editing ? 'UPDATE TASK' : 'TASK DETAILS'}</span><h2>{editing ? 'Edit task' : 'Create a task'}</h2></div><button type="button" className="icon-button" onClick={() => setShowTaskForm(false)}>×</button></div>
      <label>Task title<input required minLength="2" maxLength="180" value={taskForm.title} onChange={e => setTaskForm({ ...taskForm, title: e.target.value })} placeholder="What needs to get done?" /></label>
      <label>Description<textarea value={taskForm.description} onChange={e => setTaskForm({ ...taskForm, description: e.target.value })} placeholder="Add more context…" /></label>
      <div className="form-grid"><label>Team<select required value={taskForm.teamId} onChange={e => setTaskForm({ ...taskForm, teamId: e.target.value, assignedTo: '' })}><option value="">Choose team</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>Status<select value={taskForm.status} onChange={e => setTaskForm({ ...taskForm, status: e.target.value })}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label></div>
      <div className="form-grid"><label>Assignee<select value={taskForm.assignedTo} onChange={e => setTaskForm({ ...taskForm, assignedTo: e.target.value })}><option value="">Unassigned</option>{taskMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Due date<input type="date" value={taskForm.dueDate} onChange={e => setTaskForm({ ...taskForm, dueDate: e.target.value })} /></label></div>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowTaskForm(false)}>Cancel</button><button className="primary">{editing ? 'Save changes' : 'Create task'}</button></div>
    </form></div>}
  </div>
}
