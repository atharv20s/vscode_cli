import { Terminal, User, LogOut } from 'lucide-react';
import GlassButton from './GlassButton';

interface NavbarProps {
  isLoggedIn: boolean;
  userName?: string;
  onLoginClick: () => void;
}

const Navbar = ({ isLoggedIn, userName, onLoginClick }: NavbarProps) => {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 px-6 py-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl glass-strong flex items-center justify-center">
            <Terminal className="w-5 h-5 text-foreground/80" />
          </div>
          <span className="text-xl font-semibold text-foreground">
            Agentic<span className="text-foreground/70">CLI</span>
          </span>
        </div>

        {/* User Info & Login Button */}
        <div className="flex items-center gap-3">
          {isLoggedIn && userName && (
            <span className="text-sm text-muted-foreground hidden sm:block">
              Welcome, <span className="text-foreground">{userName}</span>
            </span>
          )}
          <GlassButton
            variant={isLoggedIn ? 'secondary' : 'default'}
            size="sm"
            onClick={onLoginClick}
          >
            {isLoggedIn ? (
              <>
                <LogOut className="w-4 h-4" />
                Logout
              </>
            ) : (
              <>
                <User className="w-4 h-4" />
                Login
              </>
            )}
          </GlassButton>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
