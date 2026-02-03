import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  isDemoMode: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  loginWithOAuth: (provider: 'google' | 'github') => Promise<void>;
  logout: () => Promise<void>;
  getUserDisplayName: () => string;
  // Demo mode login
  demoLogin: (name: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

// Demo user for when Supabase isn't configured
interface DemoUser {
  name: string;
  email: string;
}

export const AuthProvider = ({ children }: AuthProviderProps) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [demoUser, setDemoUser] = useState<DemoUser | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      // Demo mode - check localStorage
      const stored = localStorage.getItem('demo_user');
      if (stored) {
        setDemoUser(JSON.parse(stored));
      }
      setIsLoading(false);
      return;
    }

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setIsLoading(false);
    }).catch(() => {
      setIsLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        setIsLoading(false);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const login = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      // Demo mode
      const demo = { name: email.split('@')[0], email };
      setDemoUser(demo);
      localStorage.setItem('demo_user', JSON.stringify(demo));
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
  };

  const register = async (name: string, email: string, password: string) => {
    if (!isSupabaseConfigured) {
      // Demo mode
      const demo = { name, email };
      setDemoUser(demo);
      localStorage.setItem('demo_user', JSON.stringify(demo));
      return;
    }
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
          name: name,
        },
      },
    });
    if (error) throw error;
  };

  const loginWithOAuth = async (provider: 'google' | 'github') => {
    if (!isSupabaseConfigured) {
      // Demo mode - simulate OAuth
      const demo = { name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} User`, email: `demo@${provider}.com` };
      setDemoUser(demo);
      localStorage.setItem('demo_user', JSON.stringify(demo));
      return;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: window.location.origin,
      },
    });
    if (error) throw error;
  };

  const logout = async () => {
    if (!isSupabaseConfigured) {
      setDemoUser(null);
      localStorage.removeItem('demo_user');
      return;
    }
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const demoLogin = (name: string) => {
    const demo = { name, email: `${name.toLowerCase().replace(/\s/g, '')}@demo.com` };
    setDemoUser(demo);
    localStorage.setItem('demo_user', JSON.stringify(demo));
  };

  // Helper to get user's display name
  const getUserDisplayName = (): string => {
    if (demoUser) return demoUser.name;
    if (!user) return '';
    return (
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.user_metadata?.preferred_username ||
      user.email?.split('@')[0] ||
      'User'
    );
  };

  const value: AuthContextType = {
    user,
    session,
    isLoggedIn: !!user || !!demoUser,
    isLoading,
    isDemoMode: !isSupabaseConfigured,
    login,
    register,
    loginWithOAuth,
    logout,
    getUserDisplayName,
    demoLogin,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
