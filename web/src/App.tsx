import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Spin } from 'antd'

import { useAuth } from './auth/AuthContext'
import Login from './pages/Login'

// The console lives in its own chunk, fetched only once a session exists.
const AuthenticatedApp = lazy(() => import('./AuthenticatedApp'))

/**
 * Shown while the session is being restored, and again while the console chunk
 * downloads. Unbranded: it renders before we know whether the visitor is
 * signed in, so it must not say what the site is.
 */
function Booting() {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100vh',
        background: 'var(--app-bg)',
      }}
    >
      {/* Session restore usually settles in milliseconds; the delay keeps the
          spinner from flashing on every open. */}
      <Spin delay={200} spinning />
    </div>
  )
}

/** Remembers where the visitor was headed, so signing in can return there. */
function RedirectToLogin() {
  const location = useLocation()
  return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
}

export default function App() {
  const { user, loading } = useAuth()

  if (loading) return <Booting />

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<RedirectToLogin />} />
      </Routes>
    )
  }

  return (
    <Suspense fallback={<Booting />}>
      <AuthenticatedApp />
    </Suspense>
  )
}
