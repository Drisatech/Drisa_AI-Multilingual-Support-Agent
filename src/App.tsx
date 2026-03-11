import { useState, useEffect, useRef } from 'react';
import { Product, FollowUp } from './types';
import { useLiveAgent } from './hooks/useLiveAgent';
import { Mic, MicOff, Phone, PhoneOff, Package, MessageSquare, Settings, Activity, Sun, Moon } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'agent' | 'catalog' | 'followups'>('agent');
  const [darkMode, setDarkMode] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  
  const { isConnected, isConnecting, transcript, error, connect, disconnect } = useLiveAgent();

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  useEffect(() => {
    if (activeTab === 'catalog') {
      fetch('/api/products').then(res => res.json()).then(setProducts);
    } else if (activeTab === 'followups') {
      fetch('/api/follow-ups').then(res => res.json()).then(setFollowUps);
    }
  }, [activeTab]);

  return (
    <div className={`min-h-screen flex flex-col md:flex-row font-sans transition-colors duration-300 ${darkMode ? 'bg-brand-secondary text-white' : 'bg-zinc-50 text-zinc-900'}`}>
      {/* Sidebar */}
      <aside className={`w-full md:w-64 flex flex-col transition-colors duration-300 ${darkMode ? 'bg-brand-secondary/90 border-r border-white/10' : 'bg-brand-primary text-white/80'}`}>
        <div className={`p-6 border-b ${darkMode ? 'border-white/10' : 'border-white/10'}`}>
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-xl font-semibold text-white flex items-center gap-2">
              <Activity className="w-6 h-6 text-brand-light" />
              Drisa_AI
            </h1>
            <button 
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors text-white"
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
          <p className={`text-xs mt-1 ${darkMode ? 'text-white/40' : 'text-white/50'}`}>Multilingual Voice Assistant</p>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <button 
            onClick={() => setActiveTab('agent')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'agent' ? (darkMode ? 'bg-brand-primary text-white' : 'bg-brand-secondary text-white') : 'hover:bg-white/10'}`}
          >
            <Phone className="w-5 h-5" />
            Live Agent
          </button>
          <button 
            onClick={() => setActiveTab('catalog')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'catalog' ? (darkMode ? 'bg-brand-primary text-white' : 'bg-brand-secondary text-white') : 'hover:bg-white/10'}`}
          >
            <Package className="w-5 h-5" />
            Product Catalog
          </button>
          <button 
            onClick={() => setActiveTab('followups')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'followups' ? (darkMode ? 'bg-brand-primary text-white' : 'bg-brand-secondary text-white') : 'hover:bg-white/10'}`}
          >
            <MessageSquare className="w-5 h-5" />
            Follow-ups
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 md:p-10 overflow-y-auto">
        {activeTab === 'agent' && (
          <div className="max-w-3xl mx-auto">
            <div className="mb-8">
              <h2 className={`text-3xl font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Live Voice Agent</h2>
            </div>

            <div className={`rounded-3xl shadow-sm border p-8 md:p-12 flex flex-col items-center justify-center min-h-[400px] transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
              
              <div className={`relative w-48 h-48 rounded-full flex items-center justify-center mb-8 transition-all duration-500 ${isConnected ? (darkMode ? 'bg-brand-primary/10' : 'bg-brand-secondary/5') : (darkMode ? 'bg-white/5' : 'bg-zinc-50')}`}>
                {isConnected && (
                  <>
                    <div className={`absolute inset-0 rounded-full border-4 animate-ping ${darkMode ? 'border-brand-primary/20' : 'border-brand-secondary/20'}`}></div>
                    <div className={`absolute inset-4 rounded-full border-4 animate-pulse ${darkMode ? 'border-brand-primary/40' : 'border-brand-secondary/40'}`}></div>
                  </>
                )}
                <div className={`relative z-10 w-40 h-40 rounded-full overflow-hidden shadow-lg transition-all duration-300 border-4 ${isConnected ? (darkMode ? 'border-brand-primary' : 'border-brand-secondary') : (darkMode ? 'border-white/10' : 'border-zinc-200')}`}>
                  <img 
                    src="https://lh3.googleusercontent.com/d/1xFSvnDSEVdbF2c9W0sng_OgDCO4sM2OO" 
                    alt="Customer Support Agent" 
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  {isConnected && (
                    <div className={`absolute inset-0 flex items-center justify-center ${darkMode ? 'bg-brand-primary/10' : 'bg-brand-secondary/10'}`}>
                      <div className={`w-4 h-4 rounded-full animate-pulse shadow-[0_0_15px_rgba(178,24,35,0.8)] ${darkMode ? 'bg-brand-primary' : 'bg-brand-secondary'}`}></div>
                    </div>
                  )}
                </div>
              </div>

              {error && (
                <div className="mb-6 px-4 py-3 bg-red-50 text-red-600 rounded-xl text-sm text-center">
                  {error}
                </div>
              )}

              <div className="text-center mb-8">
                <h3 className={`text-xl font-medium mb-2 ${darkMode ? 'text-white' : 'text-zinc-900'}`}>
                  {isConnected ? 'Agent is listening...' : 'Ready to connect'}
                </h3>
                <p className={`max-w-md mx-auto ${darkMode ? 'text-white/60' : 'text-zinc-500'}`}>
                  {isConnected 
                    ? 'Speak naturally in English, Hausa, Igbo, Yoruba, or Pidgin. The agent will respond in the same language.' 
                    : 'Click connect to start a voice conversation with the AI support agent.'}
                </p>
              </div>

              <button
                onClick={isConnected ? disconnect : connect}
                disabled={isConnecting}
                className={`flex items-center gap-2 px-8 py-4 rounded-full font-medium text-lg transition-all shadow-sm ${
                  isConnected 
                    ? 'bg-red-500 hover:bg-red-600 text-white' 
                    : (darkMode ? 'bg-brand-primary hover:bg-brand-primary/90 text-white' : 'bg-brand-secondary hover:bg-brand-secondary/90 text-white')
                } ${isConnecting ? 'opacity-70 cursor-not-allowed' : ''}`}
              >
                {isConnected ? (
                  <><PhoneOff className="w-5 h-5" /> End Call</>
                ) : isConnecting ? (
                  <><Activity className="w-5 h-5 animate-spin" /> Connecting...</>
                ) : (
                  <><Phone className="w-5 h-5" /> Connect Agent</>
                )}
              </button>
              
              <div className={`mt-4 text-sm font-medium animate-pulse ${darkMode ? 'text-white/40' : 'text-zinc-400'}`}>
                Call Us Here For Free
              </div>
            </div>

            {/* Conversation History */}
            {transcript.length > 0 && (
              <div className={`mt-8 rounded-3xl shadow-sm border overflow-hidden flex flex-col h-[400px] transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
                <div className={`p-4 border-b flex items-center justify-between ${darkMode ? 'border-white/10 bg-white/5' : 'border-zinc-100 bg-zinc-50'}`}>
                  <h3 className={`font-medium flex items-center gap-2 ${darkMode ? 'text-white' : 'text-zinc-900'}`}>
                    <MessageSquare className={`w-4 h-4 ${darkMode ? 'text-brand-primary' : 'text-brand-primary'}`} />
                    Conversation History
                  </h3>
                  <span className={`text-xs ${darkMode ? 'text-white/40' : 'text-zinc-400'}`}>{transcript.length} messages</span>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                  {transcript.map((msg, i) => (
                    <div 
                      key={i} 
                      className={`flex flex-col ${msg.role === 'AI' ? 'items-start' : 'items-end'}`}
                    >
                      <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                        msg.role === 'AI' 
                          ? (darkMode ? 'bg-white/10 text-white rounded-tl-none' : 'bg-brand-secondary text-white rounded-tl-none') 
                          : 'bg-brand-primary text-white rounded-tr-none'
                      }`}>
                        <div className="font-bold text-[10px] uppercase tracking-wider mb-1 opacity-70">
                          {msg.role}
                        </div>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
              </div>
            )}

          </div>
        )}

        {activeTab === 'catalog' && (
          <div className="max-w-5xl mx-auto">
            <div className="mb-8 flex justify-between items-end">
              <div>
                <h2 className={`text-3xl font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Product Catalog</h2>
                <p className={`${darkMode ? 'text-white/60' : 'text-zinc-500'} mt-2`}>Products the AI agent can recommend to customers.</p>
              </div>
            </div>

            <div className={`rounded-2xl shadow-sm border overflow-hidden transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className={`border-b ${darkMode ? 'bg-white/5 border-white/10' : 'bg-zinc-50 border-zinc-200'}`}>
                    <th className={`px-6 py-4 text-xs font-semibold uppercase tracking-wider ${darkMode ? 'text-white/40' : 'text-zinc-500'}`}>Product</th>
                    <th className={`px-6 py-4 text-xs font-semibold uppercase tracking-wider ${darkMode ? 'text-white/40' : 'text-zinc-500'}`}>Category</th>
                    <th className={`px-6 py-4 text-xs font-semibold uppercase tracking-wider ${darkMode ? 'text-white/40' : 'text-zinc-500'}`}>Price (₦)</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${darkMode ? 'divide-white/5' : 'divide-zinc-100'}`}>
                  {products.map(product => (
                    <tr key={product.id} className={`transition-colors ${darkMode ? 'hover:bg-white/5' : 'hover:bg-zinc-50'}`}>
                      <td className="px-6 py-4">
                        <div className={`font-medium ${darkMode ? 'text-white' : 'text-zinc-900'}`}>{product.name}</div>
                        <div className={`text-sm mt-1 ${darkMode ? 'text-white/40' : 'text-zinc-500'}`}>{product.description}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${darkMode ? 'bg-brand-primary/20 text-brand-primary' : 'bg-zinc-100 text-zinc-800'}`}>
                          {product.category}
                        </span>
                      </td>
                      <td className={`px-6 py-4 font-mono ${darkMode ? 'text-white' : 'text-zinc-900'}`}>
                        {product.price.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  {products.length === 0 && (
                    <tr>
                      <td colSpan={3} className={`px-6 py-12 text-center ${darkMode ? 'text-white/40' : 'text-zinc-500'}`}>
                        No products found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'followups' && (
          <div className="max-w-5xl mx-auto">
            <div className="mb-8">
              <h2 className={`text-3xl font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Follow-ups</h2>
              <p className={`${darkMode ? 'text-white/60' : 'text-zinc-500'} mt-2`}>Messages triggered by the AI agent during calls.</p>
            </div>

            <div className="space-y-4">
              {followUps.map(followUp => (
                <div key={followUp.id} className={`rounded-2xl p-6 shadow-sm border transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${
                        followUp.contact_type.toLowerCase() === 'whatsapp' 
                          ? (darkMode ? 'bg-brand-primary/20 text-brand-primary' : 'bg-brand-primary/10 text-brand-primary')
                          : (darkMode ? 'bg-white/10 text-white' : 'bg-brand-secondary/10 text-brand-secondary')
                      }`}>
                        {followUp.contact_type.toUpperCase()}
                      </span>
                      <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-zinc-900'}`}>{followUp.contact_address}</span>
                    </div>
                    <span className={`text-xs ${darkMode ? 'text-white/40' : 'text-zinc-400'}`}>
                      {new Date(followUp.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className={`rounded-xl p-4 text-sm whitespace-pre-wrap border transition-colors duration-300 ${darkMode ? 'bg-white/5 text-white/80 border-white/10' : 'bg-zinc-50 text-zinc-700 border-zinc-100'}`}>
                    {followUp.message}
                  </div>
                </div>
              ))}
              {followUps.length === 0 && (
                <div className={`rounded-2xl p-12 text-center border transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
                  <MessageSquare className={`w-12 h-12 mx-auto mb-4 ${darkMode ? 'text-white/20' : 'text-zinc-300'}`} />
                  <h3 className={`text-lg font-medium ${darkMode ? 'text-white' : 'text-zinc-900'}`}>No follow-ups yet</h3>
                  <p className={`${darkMode ? 'text-white/40' : 'text-zinc-500'} mt-1`}>When the AI agent sends a catalog to a customer, it will appear here.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
