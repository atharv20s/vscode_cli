import { Zap, Shield, Code2 } from 'lucide-react';
import GlassCard from './GlassCard';

const features = [
  {
    icon: Zap,
    title: 'Lightning Fast',
    description: 'Execute commands and get AI-powered responses in milliseconds. No waiting, just results.',
  },
  {
    icon: Shield,
    title: 'Secure by Design',
    description: 'Your commands stay local. API calls are encrypted end-to-end with zero data retention.',
  },
  {
    icon: Code2,
    title: 'Context Aware',
    description: 'Understands your project structure, git history, and environment for smarter suggestions.',
  },
];

const FeaturesSection = () => {
  return (
    <section className="py-20 px-6">
      <div className="max-w-6xl mx-auto">
        {/* Section Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Built for the <span className="text-gradient">Modern Developer</span>
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Everything you need to supercharge your terminal workflow with AI assistance.
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <GlassCard
              key={feature.title}
              variant="strong"
              className="p-8 hover:scale-[1.02] transition-transform duration-300 animate-fade-in-up"
              style={{ animationDelay: `${index * 0.1}s` } as React.CSSProperties}
            >
              {/* Icon */}
              <div className="w-12 h-12 rounded-xl glass-strong flex items-center justify-center mb-6 text-foreground/80">
                <feature.icon className="w-6 h-6" />
              </div>

              {/* Content */}
              <h3 className="text-xl font-semibold mb-3 text-foreground">
                {feature.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </GlassCard>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;
