import { useState, useEffect } from 'react';
import StarField from '@/components/StarField';
import Navbar from '@/components/Navbar';
import HeroSection from '@/components/HeroSection';
import FeaturesSection from '@/components/FeaturesSection';
import CLIPanel from '@/components/CLIPanel';
import Footer from '@/components/Footer';
import AuthModal from '@/components/AuthModal';
import { useAuth } from '@/context/AuthContext';

const Index = () => {
  const { isLoggedIn, logout, getUserDisplayName } = useAuth();
  const [showCLI, setShowCLI] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  // Show CLI when user logs in
  useEffect(() => {
    if (isLoggedIn) {
      setShowCLI(true);
    }
  }, [isLoggedIn]);

  const handleLoginClick = async () => {
    if (isLoggedIn) {
      // Logout
      await logout();
      setShowCLI(false);
    } else {
      // Show auth modal
      setShowAuthModal(true);
    }
  };

  const handleAuthSuccess = () => {
    setShowCLI(true);
    setShowAuthModal(false);
    
    // Smooth scroll to CLI panel
    setTimeout(() => {
      document.getElementById('cli-panel')?.scrollIntoView({ 
        behavior: 'smooth',
        block: 'center'
      });
    }, 100);
  };

  const handleCtaClick = () => {
    if (!isLoggedIn) {
      setShowAuthModal(true);
    } else {
      setShowCLI(true);
      // Smooth scroll to CLI panel
      setTimeout(() => {
        document.getElementById('cli-panel')?.scrollIntoView({ 
          behavior: 'smooth',
          block: 'center'
        });
      }, 100);
    }
  };

  return (
    <div className="min-h-screen relative overflow-x-hidden">
      {/* Animated star background */}
      <StarField />

      {/* Gradient overlays for depth */}
      <div className="fixed inset-0 pointer-events-none z-0">
        {/* Top gradient */}
        <div className="absolute top-0 left-0 right-0 h-96 bg-gradient-to-b from-primary/5 to-transparent" />
        
        {/* Bottom gradient */}
        <div className="absolute bottom-0 left-0 right-0 h-96 bg-gradient-to-t from-background to-transparent" />
        
        {/* Side accents */}
        <div className="absolute top-1/4 -left-48 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -right-48 w-96 h-96 bg-secondary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/4 w-64 h-64 bg-accent/5 rounded-full blur-3xl" />
      </div>

      {/* Content */}
      <div className="relative z-10">
        <Navbar isLoggedIn={isLoggedIn} userName={getUserDisplayName()} onLoginClick={handleLoginClick} />
        
        <main>
          <HeroSection onCtaClick={handleCtaClick} />
          
          <FeaturesSection />

          {/* CLI Panel - shown after login */}
          {showCLI && (
            <div id="cli-panel">
              <div className="text-center mb-8">
                <h2 className="text-2xl md:text-3xl font-bold mb-2">
                  Start <span className="text-gradient">Chatting</span> with your Agent
                </h2>
                <p className="text-muted-foreground">
                  Try asking anything—code generation, file operations, or just chat.
                </p>
              </div>
              <CLIPanel />
            </div>
          )}
        </main>

        <Footer />
      </div>

      {/* Auth Modal */}
      <AuthModal 
        isOpen={showAuthModal} 
        onClose={() => setShowAuthModal(false)}
        onAuthSuccess={handleAuthSuccess}
      />
    </div>
  );
};

export default Index;
