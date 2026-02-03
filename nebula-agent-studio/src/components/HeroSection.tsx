import { ArrowRight } from 'lucide-react';
import GlassButton from './GlassButton';

interface HeroSectionProps {
  onCtaClick: () => void;
}

const HeroSection = ({ onCtaClick }: HeroSectionProps) => {
  return (
    <section className="relative pt-32 pb-20 px-6">
      <div className="max-w-4xl mx-auto text-center">
        {/* Headline */}
        <h1 
          className="text-5xl md:text-7xl font-bold mb-6 leading-tight animate-fade-in-up"
          style={{ animationDelay: '0.1s' }}
        >
          Your Terminal,{' '}
          <span className="text-gradient">Supercharged</span>{' '}
          with AI
        </h1>

        {/* Description */}
        <p 
          className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed animate-fade-in-up"
          style={{ animationDelay: '0.2s' }}
        >
          Agentic CLI brings the power of Claude directly to your command line. 
          Execute complex tasks, automate workflows, and interact with an intelligent 
          agent that understands your intent—all from your terminal.
        </p>

        {/* CTA Button */}
        <div 
          className="animate-fade-in-up"
          style={{ animationDelay: '0.3s' }}
        >
          <GlassButton
            variant="primary"
            size="lg"
            onClick={onCtaClick}
          >
            Try the Agent
            <ArrowRight className="w-5 h-5" />
          </GlassButton>
        </div>

        {/* Stats or trust signals */}
        <div 
          className="flex flex-wrap items-center justify-center gap-8 mt-16 animate-fade-in-up"
          style={{ animationDelay: '0.4s' }}
        >
          {[
            { value: '10K+', label: 'Developers' },
            { value: '1M+', label: 'Commands Run' },
            { value: '99.9%', label: 'Uptime' },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-2xl md:text-3xl font-bold text-foreground">
                {stat.value}
              </div>
              <div className="text-sm text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
