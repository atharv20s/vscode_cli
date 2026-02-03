import { useState } from 'react';
import { Mail, Lock, User, Eye, EyeOff, Github, Chrome, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import GlassButton from './GlassButton';
import { useAuth } from '@/context/AuthContext';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: () => void;
}

const AuthModal = ({ isOpen, onClose, onAuthSuccess }: AuthModalProps) => {
  const { login, register, loginWithOAuth } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState('signin');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Form states
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [registerForm, setRegisterForm] = useState({ 
    name: '', 
    email: '', 
    password: '', 
    confirmPassword: '' 
  });
  const [signinForm, setSigninForm] = useState({ email: '', password: '' });

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await login(loginForm.email, loginForm.password);
      toast({ title: 'Welcome back!', description: 'Successfully logged in.' });
      onAuthSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (registerForm.password !== registerForm.confirmPassword) {
      setError("Passwords don't match!");
      return;
    }
    setIsLoading(true);
    try {
      await register(registerForm.name, registerForm.email, registerForm.password);
      toast({ title: 'Account created!', description: 'Welcome to AgenticCLI.' });
      onAuthSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await login(signinForm.email, signinForm.password);
      toast({ title: 'Welcome!', description: 'Successfully signed in.' });
      onAuthSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuthLogin = async (provider: 'google' | 'github') => {
    setError(null);
    setIsLoading(true);
    try {
      await loginWithOAuth(provider);
      toast({ title: 'Welcome!', description: `Signed in with ${provider}.` });
      onAuthSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OAuth login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[450px] p-0 overflow-hidden border-0 bg-transparent [&>button]:hidden">
        {/* Glassmorphic container */}
        <div className="relative rounded-2xl overflow-hidden">
          {/* Glass background */}
          <div 
            className="absolute inset-0 backdrop-blur-xl"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)',
              boxShadow: `
                0 8px 32px rgba(0, 0, 0, 0.6),
                0 1px 0 0 rgba(255, 255, 255, 0.1) inset,
                0 -1px 0 0 rgba(0, 0, 0, 0.3) inset
              `,
            }}
          />
          
          {/* Subtle border glow */}
          <div 
            className="absolute inset-0 rounded-2xl pointer-events-none"
            style={{
              border: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '0 0 40px rgba(255, 255, 255, 0.05) inset',
            }}
          />

          {/* Custom Close Button */}
          <button
            onClick={onClose}
            className="absolute right-4 top-4 z-20 p-1 rounded-lg bg-white/5 border border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-all duration-200"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Content */}
          <div className="relative z-10 p-6">
            <DialogHeader className="mb-6">
              <DialogTitle className="text-2xl font-bold text-center text-foreground">
                Welcome to <span className="text-gradient">AgenticCLI</span>
              </DialogTitle>
              <p className="text-center text-muted-foreground text-sm mt-2">
                Your AI-powered terminal assistant
              </p>
            </DialogHeader>

            {/* Error display */}
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
                {error}
              </div>
            )}

            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="grid w-full grid-cols-3 glass-strong rounded-xl p-1 mb-6">
                <TabsTrigger 
                  value="signin" 
                  className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-foreground transition-all"
                >
                  Sign In
                </TabsTrigger>
                <TabsTrigger 
                  value="login" 
                  className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-foreground transition-all"
                >
                  Login
                </TabsTrigger>
                <TabsTrigger 
                  value="register" 
                  className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-foreground transition-all"
                >
                  Register
                </TabsTrigger>
              </TabsList>

              {/* Sign In Tab - Quick access with OAuth */}
              <TabsContent value="signin" className="space-y-4">
                <form onSubmit={handleSignIn} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signin-email" className="text-foreground/80">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="signin-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-10 glass-input"
                        value={signinForm.email}
                        onChange={(e) => setSigninForm({ ...signinForm, email: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="signin-password" className="text-foreground/80">Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="signin-password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="••••••••"
                        className="pl-10 pr-10 glass-input"
                        value={signinForm.password}
                        onChange={(e) => setSigninForm({ ...signinForm, password: e.target.value })}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <GlassButton type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? 'Signing in...' : 'Sign In'}
                  </GlassButton>
                </form>

                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-white/10"></div>
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="px-2 text-muted-foreground bg-transparent">Or continue with</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <GlassButton 
                    variant="secondary" 
                    onClick={() => handleOAuthLogin('google')}
                    disabled={isLoading}
                    className="flex items-center gap-2"
                  >
                    <Chrome className="w-4 h-4" />
                    Google
                  </GlassButton>
                  <GlassButton 
                    variant="secondary" 
                    onClick={() => handleOAuthLogin('github')}
                    disabled={isLoading}
                    className="flex items-center gap-2"
                  >
                    <Github className="w-4 h-4" />
                    GitHub
                  </GlassButton>
                </div>
              </TabsContent>

              {/* Login Tab - Existing users */}
              <TabsContent value="login" className="space-y-4">
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email" className="text-foreground/80">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="login-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-10 glass-input"
                        value={loginForm.email}
                        onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="login-password" className="text-foreground/80">Password</Label>
                      <button 
                        type="button" 
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="••••••••"
                        className="pl-10 pr-10 glass-input"
                        value={loginForm.password}
                        onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <GlassButton type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? 'Logging in...' : 'Login'}
                  </GlassButton>
                </form>

                <p className="text-center text-sm text-muted-foreground">
                  Don't have an account?{' '}
                  <button 
                    onClick={() => setActiveTab('register')} 
                    className="text-foreground hover:underline"
                  >
                    Register
                  </button>
                </p>
              </TabsContent>

              {/* Register Tab - New users */}
              <TabsContent value="register" className="space-y-4">
                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="register-name" className="text-foreground/80">Full Name</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="register-name"
                        type="text"
                        placeholder="John Doe"
                        className="pl-10 glass-input"
                        value={registerForm.name}
                        onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-email" className="text-foreground/80">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="register-email"
                        type="email"
                        placeholder="you@example.com"
                        className="pl-10 glass-input"
                        value={registerForm.email}
                        onChange={(e) => setRegisterForm({ ...registerForm, email: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-password" className="text-foreground/80">Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="register-password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="••••••••"
                        className="pl-10 pr-10 glass-input"
                        value={registerForm.password}
                        onChange={(e) => setRegisterForm({ ...registerForm, password: e.target.value })}
                        required
                        minLength={8}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-confirm" className="text-foreground/80">Confirm Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="register-confirm"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="••••••••"
                        className="pl-10 glass-input"
                        value={registerForm.confirmPassword}
                        onChange={(e) => setRegisterForm({ ...registerForm, confirmPassword: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <GlassButton type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? 'Creating account...' : 'Create Account'}
                  </GlassButton>
                </form>

                <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{' '}
                  <button 
                    onClick={() => setActiveTab('login')} 
                    className="text-foreground hover:underline"
                  >
                    Login
                  </button>
                </p>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AuthModal;
