import { Terminal, Github, Twitter } from 'lucide-react';

const Footer = () => {
  return (
    <footer className="mt-20 border-t border-border/30">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col items-center justify-center gap-6">
          {/* Brand */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg glass-strong flex items-center justify-center">
              <Terminal className="w-4 h-4 text-foreground/80" />
            </div>
            <span className="font-semibold text-foreground">
              Agentic<span className="text-foreground/70">CLI</span>
            </span>
          </div>
          <p className="text-sm text-muted-foreground text-center">
            AI-powered command line for modern developers.
          </p>
          <div className="flex gap-4">
            <a 
              href="https://github.com/atharv20s" 
              target="_blank" 
              rel="noopener noreferrer"
              className="p-2 rounded-lg glass hover:bg-muted/40 transition-colors"
            >
              <Github className="w-5 h-5 text-muted-foreground hover:text-foreground" />
            </a>
            <a 
              href="https://x.com/AtharvShuk43490" 
              target="_blank" 
              rel="noopener noreferrer"
              className="p-2 rounded-lg glass hover:bg-muted/40 transition-colors"
            >
              <Twitter className="w-5 h-5 text-muted-foreground hover:text-foreground" />
            </a>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-8 pt-6 border-t border-border/30 flex flex-col items-center gap-2">
          <p className="text-sm text-muted-foreground">
            © 2026 AgenticCLI. All rights reserved.
          </p>
          <p className="text-sm text-muted-foreground">
            Built with ♥ by <a href="https://github.com/atharv20s" target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">Atharv</a>
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
