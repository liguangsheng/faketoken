import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api, session, setUnauthorizedHandler, type User } from '../api/client'

interface AuthValue {
  user: User | null
  loading: boolean
  isAdmin: boolean
  signIn: (username: string, password: string) => Promise<void>
  signUp: (username: string, password: string, inviteCode?: string) => Promise<void>
  signOut: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!session.get()) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      setUser(await api.me())
    } catch (error) {
      // Only a rejected session should sign the user out — the balance poller
      // runs every minute and a flaky network must not bounce them to /login.
      if (error instanceof ApiError && error.status === 401) setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null))
    void refresh()
  }, [refresh])

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      isAdmin: (user?.role ?? 0) >= 100,
      signIn: async (username, password) => {
        const result = await api.login(username, password)
        session.set(result.token)
        setUser(result.user)
      },
      signUp: async (username, password, inviteCode) => {
        const result = await api.register(username, password, inviteCode)
        session.set(result.token)
        setUser(result.user)
      },
      signOut: () => {
        session.clear()
        setUser(null)
      },
      refresh,
    }),
    [user, loading, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return context
}
