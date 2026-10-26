import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Skeleton } from 'antd'

import { useAuth } from './auth/AuthContext'
import { SettingsProvider, useSettings } from './settings/SettingsContext'
import { ImageJobsProvider } from './imageJobs/ImageJobsContext'
import ErrorBoundary from './components/ErrorBoundary'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Tokens from './pages/Tokens'
import Logs from './pages/Logs'
import Profile from './pages/Profile'
import NotFound from './pages/NotFound'

// Split out of the authenticated chunk too: the playground is rarely the entry
// point and the admin section is dead weight for regular users.
const Playground = lazy(() => import('./pages/Playground'))
const ImagePlayground = lazy(() => import('./pages/ImagePlayground'))
const Plaza = lazy(() => import('./pages/Plaza'))
const Channels = lazy(() => import('./pages/admin/Channels'))
const Users = lazy(() => import('./pages/admin/Users'))
const Prices = lazy(() => import('./pages/admin/Prices'))
const Groups = lazy(() => import('./pages/admin/Groups'))
const AdminLogs = lazy(() => import('./pages/admin/AdminLogs'))
const Sessions = lazy(() => import('./pages/admin/Sessions'))
const SessionDetail = lazy(() => import('./pages/admin/SessionDetail'))
const Settings = lazy(() => import('./pages/admin/Settings'))
const Redemptions = lazy(() => import('./pages/admin/Redemptions'))
const Invites = lazy(() => import('./pages/admin/Invites'))

/**
 * Everything behind the login form. This module is loaded on demand so that an
 * anonymous visitor never downloads the console's navigation, page copy or
 * endpoint examples — reading the JS bundle would otherwise reveal exactly what
 * this deployment is.
 */
export default function AuthenticatedApp() {
  return (
    <SettingsProvider>
      {/* Above the routes: an image job takes a minute and must outlive the
          page that started it. */}
      <ImageJobsProvider>
        <Console />
      </ImageJobsProvider>
    </SettingsProvider>
  )
}

/** After signing in, land where the interrupted visit was headed. */
function LoginLanding() {
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  return <Navigate to={from && from !== '/login' ? from : '/'} replace />
}

function Console() {
  const { isAdmin } = useAuth()
  // Wait for the console preferences before mounting any page: the tables read
  // the default page size as their initial state, so arriving late would make
  // them load once at the wrong size and then reload.
  const { ready } = useSettings()
  const adminOnly = (element: JSX.Element) => (isAdmin ? element : <NotFound forbidden />)

  if (!ready) {
    return (
      <Layout>
        <Skeleton active paragraph={{ rows: 8 }} />
      </Layout>
    )
  }

  return (
    <Layout>
      <ErrorBoundary>
        <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
          <Routes>
            <Route path="/login" element={<LoginLanding />} />
            <Route path="/" element={<Dashboard />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route path="/models" element={<Plaza />} />
            <Route path="/logs" element={<Logs />} />
            {/* The old addresses, so a bookmark still lands. */}
            <Route path="/playground" element={<Navigate to="/admin/playground" replace />} />
            <Route
              path="/playground/images"
              element={<Navigate to="/admin/playground/images" replace />}
            />
            <Route path="/profile" element={<Profile />} />
            <Route path="/admin/channels" element={adminOnly(<Channels />)} />
            <Route path="/admin/playground" element={adminOnly(<Playground />)} />
            <Route path="/admin/playground/images" element={adminOnly(<ImagePlayground />)} />
            <Route path="/admin/users" element={adminOnly(<Users />)} />
            <Route path="/admin/groups" element={adminOnly(<Groups />)} />
            <Route path="/admin/prices" element={adminOnly(<Prices />)} />
            <Route path="/admin/logs" element={adminOnly(<AdminLogs />)} />
            <Route path="/admin/sessions" element={adminOnly(<Sessions />)} />
            <Route path="/admin/sessions/:id" element={adminOnly(<SessionDetail />)} />
            <Route path="/admin/redemptions" element={adminOnly(<Redemptions />)} />
            <Route path="/admin/invites" element={adminOnly(<Invites />)} />
            <Route path="/admin/settings" element={adminOnly(<Settings />)} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  )
}
