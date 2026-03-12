import { useState, useEffect, useRef } from 'react';
import { Product, FollowUp } from './types';
import { useLiveAgent } from './hooks/useLiveAgent';
import { Mic, MicOff, Phone, PhoneOff, Package, MessageSquare, Settings, Activity, Sun, Moon, BookOpen, LogIn, LogOut, Globe, FileText, Plus, Trash2 } from 'lucide-react';
import { auth, signInWithGoogle, db as fdb } from './firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, updateDoc } from 'firebase/firestore';

export default function App() {
  const [activeTab, setActiveTab] = useState<'agent' | 'kb' | 'sessions'>('agent');
  const [darkMode, setDarkMode] = useState(false);
  const [isWidgetMode, setIsWidgetMode] = useState(false);
  const [preferredLanguage, setPreferredLanguage] = useState('English');
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  
  // Sessions State
  const [sessions, setSessions] = useState<any[]>([]);
  
  // Knowledge Base State
  const [kbSources, setKbSources] = useState<any[]>([]);
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [newSourceArticle, setNewSourceArticle] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const { isConnected, isConnecting, error, connect, disconnect } = useLiveAgent();

  useEffect(() => {
    // Check for widget mode
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'widget') {
      setIsWidgetMode(true);
    }

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAdmin(u?.email === 'drisatech@gmail.com');
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (isAdmin && activeTab === 'kb') {
      const q = query(collection(fdb, 'knowledge_sources'), orderBy('createdAt', 'desc'));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        setKbSources(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      });
      return () => unsubscribe();
    } else if (isAdmin && activeTab === 'sessions') {
      const q = query(collection(fdb, 'sessions'), orderBy('createdAt', 'desc'));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        setSessions(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      });
      return () => unsubscribe();
    }
  }, [isAdmin, activeTab]);

  const handleAddSource = async (type: 'url' | 'article') => {
    if (!isAdmin) return;
    setIsProcessing(true);
    try {
      const content = type === 'url' ? newSourceUrl : newSourceArticle;
      if (!content) return;

      await addDoc(collection(fdb, 'knowledge_sources'), {
        type,
        content,
        status: 'pending',
        createdAt: serverTimestamp()
      });

      // In a real app, a cloud function would trigger here to process the URL/Article
      // For this demo, we'll simulate processing by calling a backend route
      const response = await fetch('/api/kb/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, content })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to process source');
      }
      
      setNewSourceUrl('');
      setNewSourceArticle('');
    } catch (err: any) {
      console.error(err);
      alert(`Error: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className={`min-h-screen flex flex-col md:flex-row font-sans transition-colors duration-300 ${darkMode ? 'bg-brand-secondary text-white' : 'bg-zinc-50 text-zinc-900'}`}>
      {/* Sidebar - Hidden in widget mode */}
      {!isWidgetMode && (
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
            
            {isAdmin && (
              <>
                <button 
                  onClick={() => setActiveTab('kb')}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'kb' ? (darkMode ? 'bg-brand-primary text-white' : 'bg-brand-secondary text-white') : 'hover:bg-white/10'}`}
                >
                  <BookOpen className="w-5 h-5" />
                  Knowledge Base
                </button>
                <button 
                  onClick={() => setActiveTab('sessions')}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'sessions' ? (darkMode ? 'bg-brand-primary text-white' : 'bg-brand-secondary text-white') : 'hover:bg-white/10'}`}
                >
                  <Activity className="w-5 h-5" />
                  Call Sessions
                </button>
              </>
            )}
          </nav>

          <div className="p-4 border-t border-white/10">
            {user ? (
              <button 
                onClick={() => signOut(auth)}
                className="w-full flex items-center gap-3 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors text-white/70 text-sm"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            ) : (
              <button 
                onClick={signInWithGoogle}
                className="w-full flex items-center gap-3 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white text-sm"
              >
                <LogIn className="w-4 h-4" />
                Admin Login
              </button>
            )}
          </div>
        </aside>
      )}

      {/* Main Content */}
      <main className={`flex-1 overflow-y-auto ${isWidgetMode ? 'p-4' : 'p-6 md:p-10'}`}>
        {isWidgetMode && (
          <div className="flex justify-end mb-4">
             <button 
              onClick={() => setDarkMode(!darkMode)}
              className={`p-2 rounded-lg transition-colors ${darkMode ? 'bg-white/10 text-white' : 'bg-brand-primary text-white shadow-md'}`}
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        )}
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
                
                {!isConnected && !isConnecting && (
                  <div className="mb-6 max-w-xs mx-auto">
                    <label className={`block text-xs font-semibold uppercase tracking-wider mb-2 ${darkMode ? 'text-white/40' : 'text-zinc-500'}`}>
                      Preferred Language
                    </label>
                    <select 
                      value={preferredLanguage}
                      onChange={(e) => setPreferredLanguage(e.target.value)}
                      className={`w-full px-4 py-2 rounded-xl border transition-colors ${darkMode ? 'bg-white/5 border-white/10 text-white' : 'bg-zinc-50 border-zinc-200 text-zinc-900'}`}
                    >
                      <option>English</option>
                      <option>Hausa</option>
                      <option>Igbo</option>
                      <option>Yoruba</option>
                      <option>Nigerian Pidgin</option>
                    </select>
                  </div>
                )}

                <p className={`max-w-md mx-auto ${darkMode ? 'text-white/60' : 'text-zinc-500'}`}>
                  {isConnected 
                    ? `Speaking in ${preferredLanguage}. The agent will automatically detect if you switch languages.` 
                    : 'Select your preferred language and click connect to start a voice conversation.'}
                </p>
              </div>

              <button
                onClick={isConnected ? disconnect : () => connect(preferredLanguage)}
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
          </div>
        )}

        {activeTab === 'kb' && isAdmin && (
          <div className="max-w-5xl mx-auto">
            <div className="mb-8">
              <h2 className={`text-3xl font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Knowledge Base</h2>
              <p className={`${darkMode ? 'text-white/60' : 'text-zinc-500'} mt-2`}>Update your product catalog by providing website links or articles.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
              {/* Add URL */}
              <div className={`p-6 rounded-2xl border transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
                <div className="flex items-center gap-3 mb-4">
                  <Globe className="w-5 h-5 text-brand-primary" />
                  <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Import from Website</h3>
                </div>
                <input 
                  type="url" 
                  placeholder="https://example.com/products"
                  value={newSourceUrl}
                  onChange={(e) => setNewSourceUrl(e.target.value)}
                  className={`w-full px-4 py-2 rounded-xl border mb-4 transition-colors ${darkMode ? 'bg-white/5 border-white/10 text-white' : 'bg-zinc-50 border-zinc-200 text-zinc-900'}`}
                />
                <button 
                  onClick={() => handleAddSource('url')}
                  disabled={isProcessing || !newSourceUrl}
                  className="w-full py-2 bg-brand-primary text-white rounded-xl font-medium hover:bg-brand-primary/90 disabled:opacity-50 transition-all mb-3"
                >
                  {isProcessing ? 'Processing...' : 'Process URL'}
                </button>
                <button 
                  onClick={() => {
                    setNewSourceUrl('https://drisatech.com.ng');
                    // We don't trigger automatically to let user confirm, or we could.
                  }}
                  className={`w-full py-2 border rounded-xl text-xs font-semibold uppercase tracking-wider transition-colors ${darkMode ? 'border-white/10 text-white/40 hover:text-white hover:border-white/30' : 'border-zinc-200 text-zinc-400 hover:text-zinc-600 hover:border-zinc-300'}`}
                >
                  Load Production URL
                </button>
              </div>

              {/* Add Article */}
              <div className={`p-6 rounded-2xl border transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
                <div className="flex items-center gap-3 mb-4">
                  <FileText className="w-5 h-5 text-brand-primary" />
                  <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Paste Article</h3>
                </div>
                <textarea 
                  placeholder="Paste product descriptions or articles here..."
                  value={newSourceArticle}
                  onChange={(e) => setNewSourceArticle(e.target.value)}
                  rows={3}
                  className={`w-full px-4 py-2 rounded-xl border mb-4 transition-colors ${darkMode ? 'bg-white/5 border-white/10 text-white' : 'bg-zinc-50 border-zinc-200 text-zinc-900'}`}
                />
                <button 
                  onClick={() => handleAddSource('article')}
                  disabled={isProcessing || !newSourceArticle}
                  className="w-full py-2 bg-brand-secondary text-white rounded-xl font-medium hover:bg-brand-secondary/90 disabled:opacity-50 transition-all"
                >
                  {isProcessing ? 'Processing...' : 'Process Article'}
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Recent Sources</h3>
              {kbSources.map(source => (
                <div key={source.id} className={`p-4 rounded-xl border flex items-center justify-between transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
                  <div className="flex items-center gap-4 overflow-hidden">
                    {source.type === 'url' ? <Globe className="w-5 h-5 text-zinc-400 shrink-0" /> : <FileText className="w-5 h-5 text-zinc-400 shrink-0" />}
                    <div className="overflow-hidden">
                      <div className={`text-sm font-medium truncate ${darkMode ? 'text-white' : 'text-zinc-900'}`}>{source.content}</div>
                      <div className="text-[10px] text-zinc-400 uppercase tracking-wider mt-1">
                        {new Date(source.createdAt?.toDate()).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                      source.status === 'processed' ? 'border-emerald-500/50 text-emerald-500 bg-emerald-500/10' : 
                      source.status === 'failed' ? 'border-red-500/50 text-red-500 bg-red-500/10' : 
                      'border-amber-500/50 text-amber-500 bg-amber-500/10'
                    }`}>
                      {source.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {activeTab === 'sessions' && isAdmin && (
          <div className="max-w-5xl mx-auto">
            <div className="mb-8">
              <h2 className={`text-3xl font-semibold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>Call Sessions</h2>
              <p className={`${darkMode ? 'text-white/60' : 'text-zinc-500'} mt-2`}>Detailed logs of every conversation with the AI agent.</p>
            </div>

            <div className="space-y-6">
              {sessions.map(session => (
                <div key={session.id} className={`rounded-2xl p-6 shadow-sm border transition-colors duration-300 ${darkMode ? 'bg-brand-secondary border-white/10' : 'bg-white border-zinc-200'}`}>
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <span className={`text-sm font-bold ${darkMode ? 'text-white' : 'text-zinc-900'}`}>{session.callerId}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          session.outcome === 'sale' ? 'bg-emerald-500/10 text-emerald-500' :
                          session.outcome === 'lead' ? 'bg-blue-500/10 text-blue-500' :
                          'bg-zinc-500/10 text-zinc-500'
                        }`}>
                          {session.outcome}
                        </span>
                      </div>
                      <div className="text-xs text-zinc-400">
                        {new Date(session.startTime).toLocaleString()} • {session.preferredLanguage}
                      </div>
                    </div>
                  </div>
                  
                  <div className={`mb-4 p-4 rounded-xl border ${darkMode ? 'bg-white/5 border-white/10' : 'bg-zinc-50 border-zinc-100'}`}>
                    <h4 className={`text-xs font-bold uppercase tracking-wider mb-2 ${darkMode ? 'text-white/40' : 'text-zinc-500'}`}>Summary</h4>
                    <p className={`text-sm ${darkMode ? 'text-white/80' : 'text-zinc-700'}`}>{session.summary}</p>
                  </div>

                  <details className="group">
                    <summary className={`text-xs font-bold uppercase tracking-wider cursor-pointer list-none flex items-center gap-2 ${darkMode ? 'text-brand-primary' : 'text-brand-primary'}`}>
                      <span>View Full Transcript</span>
                      <Plus className="w-3 h-3 group-open:rotate-45 transition-transform" />
                    </summary>
                    <div className="mt-4 space-y-3 pl-2 border-l-2 border-zinc-100">
                      {session.transcript?.map((t: any, i: number) => (
                        <div key={i} className="text-sm">
                          <span className={`font-bold mr-2 ${t.role === 'AI' ? 'text-brand-primary' : 'text-zinc-400'}`}>{t.role}:</span>
                          <span className={`${darkMode ? 'text-white/70' : 'text-zinc-600'}`}>{t.text}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              ))}
              {sessions.length === 0 && (
                <div className="text-center py-12 text-zinc-400">No sessions logged yet.</div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
