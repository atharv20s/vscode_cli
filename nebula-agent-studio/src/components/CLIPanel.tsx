import { useState, useEffect, useRef } from 'react';
import { ChevronRight, Send } from 'lucide-react';
import GlassCard from './GlassCard';

interface Message {
  type: 'user' | 'agent';
  content: string;
}

const initialMessages: Message[] = [
  { type: 'agent', content: 'Welcome to Agentic CLI. How can I assist you today?' },
];

const sampleResponses = [
  "Analyzing your request... I'll help you with that.",
  "Running `npm install` and setting up your project structure...",
  "I've identified the issue. Let me fix that for you.",
  "Creating a new React component with TypeScript types...",
  "Optimizing your code for better performance...",
];

const CLIPanel = () => {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    // Add user message
    setMessages(prev => [...prev, { type: 'user', content: input }]);
    setInput('');
    setIsTyping(true);

    // Simulate agent response
    setTimeout(() => {
      const randomResponse = sampleResponses[Math.floor(Math.random() * sampleResponses.length)];
      setMessages(prev => [...prev, { type: 'agent', content: randomResponse }]);
      setIsTyping(false);
    }, 1000 + Math.random() * 1000);
  };

  return (
    <section className="py-10 px-6 animate-fade-in-up">
      <div className="max-w-4xl mx-auto">
        <GlassCard variant="neon" className="overflow-hidden">
          {/* Terminal Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 bg-muted/20">
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
            </div>
            <span className="text-sm text-muted-foreground ml-4 font-mono">
              agentic-cli — zsh
            </span>
          </div>

          {/* Messages Area */}
          <div className="h-80 overflow-y-auto p-4 space-y-4 font-mono text-sm">
            {messages.map((message, index) => (
              <div
                key={index}
                className={`flex items-start gap-3 ${
                  message.type === 'user' ? 'opacity-90' : ''
                }`}
              >
                {message.type === 'user' ? (
                  <>
                    <ChevronRight className="w-4 h-4 text-foreground/60 mt-0.5 flex-shrink-0" />
                    <span className="text-foreground">{message.content}</span>
                  </>
                ) : (
                  <>
                    <span className="text-foreground/50 font-bold flex-shrink-0">λ</span>
                    <span className="text-muted-foreground">{message.content}</span>
                  </>
                )}
              </div>
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div className="flex items-start gap-3">
                <span className="text-foreground/50 font-bold">λ</span>
                <span className="text-muted-foreground">
                  <span className="inline-flex gap-1">
                    <span className="animate-pulse">.</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>.</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>.</span>
                  </span>
                </span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <form onSubmit={handleSubmit} className="border-t border-border/30 p-4">
            <div className="flex items-center gap-3">
              <ChevronRight className="w-4 h-4 text-foreground/60 flex-shrink-0" />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Enter a command or ask a question..."
                className="flex-1 bg-transparent text-foreground font-mono text-sm placeholder:text-muted-foreground/50 focus:outline-none"
                disabled={isTyping}
              />
              <button
                type="submit"
                disabled={!input.trim() || isTyping}
                className="p-2 rounded-lg bg-white/10 text-foreground/80 hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <span className="ml-7 text-xs text-muted-foreground/50 mt-2 block">
              Press Enter to send
              <span className="cursor-blink ml-1">▋</span>
            </span>
          </form>
        </GlassCard>
      </div>
    </section>
  );
};

export default CLIPanel;
