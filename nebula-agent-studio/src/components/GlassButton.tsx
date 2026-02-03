import { cn } from '@/lib/utils';
import { ReactNode, ButtonHTMLAttributes } from 'react';

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

const GlassButton = ({ 
  children, 
  className, 
  variant = 'default',
  size = 'md',
  disabled,
  ...props
}: GlassButtonProps) => {
  return (
    <button
      disabled={disabled}
      {...props}
      className={cn(
        'relative inline-flex items-center justify-center font-medium transition-all duration-300',
        'rounded-full overflow-hidden',
        // Glass effect base
        'backdrop-blur-md border',
        // Size variants
        size === 'sm' && 'px-4 py-2 text-sm',
        size === 'md' && 'px-6 py-3 text-base',
        size === 'lg' && 'px-8 py-4 text-lg',
        // Style variants
        variant === 'default' && [
          'bg-white/5 border-white/10 text-foreground',
          'hover:bg-white/10 hover:border-white/20',
          'hover:shadow-glass',
        ],
        variant === 'primary' && [
          'bg-white/10 border-white/15 text-foreground',
          'hover:bg-white/15 hover:border-white/25',
          'hover:shadow-glow',
        ],
        variant === 'secondary' && [
          'bg-white/5 border-white/10 text-foreground/80',
          'hover:bg-white/10 hover:border-white/15',
          'hover:shadow-glow-soft',
        ],
        variant === 'ghost' && [
          'bg-transparent border-transparent text-muted-foreground',
          'hover:bg-muted/20 hover:text-foreground',
        ],
        // Disabled state
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
        className
      )}
    >
      {/* Inner highlight */}
      <span className="absolute inset-0 rounded-full bg-gradient-to-b from-white/10 to-transparent pointer-events-none" />
      
      {/* Content */}
      <span className="relative z-10 flex items-center gap-2">
        {children}
      </span>
    </button>
  );
};

export default GlassButton;
