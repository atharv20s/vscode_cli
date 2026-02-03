import { cn } from '@/lib/utils';
import { ReactNode, CSSProperties } from 'react';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'strong' | 'neon';
  glow?: 'primary' | 'secondary' | 'accent' | 'none';
  style?: CSSProperties;
}

const GlassCard = ({ 
  children, 
  className, 
  variant = 'default',
  glow = 'none',
  style
}: GlassCardProps) => {
  return (
    <div
      style={style}
      className={cn(
        'relative rounded-2xl overflow-hidden transition-all duration-300',
        variant === 'default' && 'glass noise',
        variant === 'strong' && 'glass-strong noise',
        variant === 'neon' && 'glass-strong noise glow-border',
        glow === 'primary' && 'glow-primary',
        glow === 'secondary' && 'glow-secondary',
        glow === 'accent' && 'glow-accent',
        className
      )}
    >
      {children}
    </div>
  );
};

export default GlassCard;
