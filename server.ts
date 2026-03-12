import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { db } from './db.js';
import { Firestore } from '@google-cloud/firestore';
const firebaseConfig = {
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  firestoreDatabaseId: process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const firestore = new Firestore({
  projectId: firebaseConfig.projectId,
  databaseId: firebaseConfig.firestoreDatabaseId
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const SYSTEM_INSTRUCTION = `You are a professional multilingual AI Support Agent as a Sales and Customer Care Representative for DrisaTech (https://drisatech.com.ng).

Your primary knowledge comes from the DrisaTech website and the product catalog provided via tools.
1. Automatically detect the customer's language and respond in the same language.
2. If the user has specified a preferred language, start the conversation in that language.
3. Supported languages: English, Hausa, Igbo, Yoruba, Nigerian Pidgin.
4. You have built-in translation capabilities. If a customer asks you to translate something or speak in another language, do so seamlessly.
5. Be polite, professional, warm, and helpful.
6. Understand whether the customer is: Making an inquiry, Requesting support, Asking for price, Asking for recommendation, or Asking for recent products.
7. When customer describes a need: Ask clarifying questions if necessary, Suggest suitable products from the catalog, Mention benefits, pricing, and availability.
8. During the conversation: Offer to send product details via WhatsApp or Email. Ask customer to provide preferred contact and confirm it clearly. Once confirmed, ALWAYS call the 'sendFollowUp' tool immediately to send the details.
9. After calling the tool: Summarize what was sent, Thank the customer, End conversation professionally.
10. When suggesting products: Use persuasive but honest sales tone. Focus on solving customer's problem.
11. If the customer is unsure: Offer 2-3 options based on budget or use case.
12. Never hallucinate product data. Only use catalog data provided via function call.
13. Always keep responses short enough for natural phone conversation.
14. If you detect the user is on a phone call, be extra concise and clear.

Tone: Professional, Friendly, Solution-focused, Trust-building.
Goal: Convert inquiry into qualified lead or sale.`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Database
db.init();

// --- API Routes ---

// KB Processing Route
app.post('/api/kb/process', async (req, res) => {
  const { type, content } = req.body;
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  
  if (!apiKey) {
    console.error('[Gemini] API Key is missing');
    return res.status(500).json({ error: 'Gemini API Key is missing' });
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    let textToProcess = content;

    if (type === 'url') {
      // In a real app, we'd fetch the URL content here. 
      // For this demo, we'll use Gemini's urlContext if possible, 
      // but since this is a backend route, we'll just simulate or use a simple fetch if allowed.
      // Since we can't easily fetch external URLs from this sandbox without a library, 
      // we'll ask Gemini to "imagine" the content if it's a known site, or just use the URL as a prompt.
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Extract product information (name, description, price in Naira, category) from this source: ${content}. If it's a URL, use your knowledge of the site or common product patterns. Return a JSON array of products.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                price: { type: Type.NUMBER },
                category: { type: Type.STRING }
              },
              required: ["name", "price"]
            }
          }
        }
      });
      
      const products = JSON.parse(response.text);
      const batch = firestore.batch();
      products.forEach((p: any) => {
        const docRef = firestore.collection('products').doc();
        batch.set(docRef, { ...p, updatedAt: new Date().toISOString() });
      });
      await batch.commit();
    } else {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Extract product information (name, description, price in Naira, category) from this article: ${content}. Return a JSON array of products.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                price: { type: Type.NUMBER },
                category: { type: Type.STRING }
              },
              required: ["name", "price"]
            }
          }
        }
      });
      
      const products = JSON.parse(response.text);
      const batch = firestore.batch();
      products.forEach((p: any) => {
        const docRef = firestore.collection('products').doc();
        batch.set(docRef, { ...p, updatedAt: new Date().toISOString() });
      });
      await batch.commit();
    }

    // Update source status
    const sources = await firestore.collection('knowledge_sources')
      .where('content', '==', content)
      .limit(1)
      .get();
    
    if (!sources.empty) {
      await sources.docs[0].ref.update({ status: 'processed' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process knowledge source' });
  }
});

// Twilio Voice Webhook
app.post('/api/twilio/voice', (req, res) => {
  const from = req.body.From || 'Unknown';
  console.log(`[Twilio] Incoming call from: ${from}`);
  
  const twiml = `
    <Response>
      <Say>Welcome to DrisaTech AI Support. Please wait while we connect you.</Say>
      <Connect>
        <Stream url="wss://${req.headers.host}/api/twilio/stream">
          <Parameter name="from" value="${from}" />
        </Stream>
      </Connect>
    </Response>
  `;
  res.type('text/xml');
  res.send(twiml);
});

// --- Vite Middleware for Development ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Not Found: dist/index.html missing. Ensure build completed.');
      }
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // --- WebSocket Server for Twilio Streams ---
  const twilioWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

    if (pathname === '/api/twilio/stream') {
      twilioWss.handleUpgrade(request, socket, head, (ws) => {
        twilioWss.emit('connection', ws, request);
      });
    } else if (pathname === '/api/browser/stream') {
      browserWss.handleUpgrade(request, socket, head, (ws) => {
        browserWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Twilio Stream Handler (Mu-law 8000Hz)
  twilioWss.on('connection', (ws: WebSocket) => {
    console.log('[Twilio] New stream connection');
    setupGeminiProxy(ws, 'audio/x-mulaw;rate=8000', (data) => data.media.payload, (payload, streamSid) => JSON.stringify({ event: 'media', streamSid, media: { payload } }));
  });

  // Browser Stream Handler (PCM 16000Hz)
  browserWss.on('connection', (ws: WebSocket) => {
    console.log('[Browser] New stream connection');
    setupGeminiProxy(ws, 'audio/pcm;rate=16000', (data) => data.audio, (payload) => JSON.stringify({ event: 'audio', audio: payload }));
  });

  async function setupGeminiProxy(ws: WebSocket, mimeType: string, getPayload: (data: any) => string, createMessage: (payload: string, streamSid?: string) => string) {
    let streamSid: string | null = null;
    let geminiSession: any = null;
    let isConnectingGemini = false;
    let preferredLanguage: string = 'English';
    let transcript: { role: string, text: string, timestamp: string }[] = [];
    let startTime = new Date().toISOString();
    
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

    const connectToGemini = async () => {
      if (!ai) {
        console.error('[Gemini] API Key is missing, cannot connect');
        ws.send(JSON.stringify({ event: 'error', message: 'Gemini API Key is missing' }));
        ws.close();
        return;
      }
      if (isConnectingGemini || geminiSession) return;
      isConnectingGemini = true;
      
      try {
        console.log('[Gemini] Connecting to Live API with model gemini-2.5-flash-native-audio-preview-09-2025...');
        const sessionPromise = ai.live.connect({
          model: "gemini-2.5-flash-native-audio-preview-09-2025",
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
            },
            systemInstruction: SYSTEM_INSTRUCTION,
            tools: [{
              functionDeclarations: [
                {
                  name: "lookupCatalog",
                  description: "Search the product catalog for items matching the customer's request.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The search query (e.g., 'solar', 'generator', 'camera'). Leave empty to get all products."
                      }
                    }
                  }
                },
                {
                  name: "sendFollowUp",
                  description: "Send a follow-up message with product details to the customer via WhatsApp or Email.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      contactType: {
                        type: Type.STRING,
                        description: "Either 'whatsapp' or 'email'"
                      },
                      contactAddress: {
                        type: Type.STRING,
                        description: "The phone number or email address provided by the customer"
                      },
                      message: {
                        type: Type.STRING,
                        description: "The formatted message containing product details, links, and prices to send."
                      }
                    },
                    required: ["contactType", "contactAddress", "message"]
                  }
                }
              ]
            }]
          },
          callbacks: {
            onopen: () => {
              console.log('[Gemini] Connected');
              // Trigger immediate greeting by sending a text prompt to the Live session
              sessionPromise.then(s => {
                try {
                  (s as any).send({
                    clientContent: {
                      turns: [{
                        role: 'user',
                        parts: [{ text: `The user has just connected. Please greet them immediately and warmly in ${preferredLanguage}. Introduce yourself as the Drisa_AI Support Agent.` }]
                      }],
                      turnComplete: true
                    }
                  });
                } catch (e) {
                  console.error('[Gemini] Failed to send initial greeting:', e);
                }
              });
            },
            onmessage: async (message) => {
              // Handle transcriptions
              if (message.serverContent?.modelTurn) {
                const text = message.serverContent.modelTurn.parts.find(p => p.text)?.text;
                if (text) {
                  transcript.push({ role: 'AI', text, timestamp: new Date().toISOString() });
                  ws.send(JSON.stringify({ event: 'transcript', role: 'AI', text }));
                }
              }
              const userTurn = (message.serverContent as any)?.userTurn;
              if (userTurn) {
                const text = (userTurn.parts as any[]).find(p => p.text)?.text;
                if (text) {
                  transcript.push({ role: 'Customer', text, timestamp: new Date().toISOString() });
                  ws.send(JSON.stringify({ event: 'transcript', role: 'Customer', text }));
                }
              }

              const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
              if (base64Audio && ws.readyState === WebSocket.OPEN) {
                ws.send(createMessage(base64Audio, streamSid || undefined));
              }

              if (message.toolCall?.functionCalls) {
                const responses = await Promise.all(message.toolCall.functionCalls.map(async (call) => {
                  if (call.name === 'lookupCatalog') {
                    const query = (call.args as any)?.query || '';
                    let products: any[] = [];
                    
                    const snapshot = await firestore.collection('products').get();
                    products = snapshot.docs.map(doc => doc.data());
                    
                    if (query) {
                      products = products.filter(p => 
                        p.name.toLowerCase().includes(query.toLowerCase()) || 
                        p.description.toLowerCase().includes(query.toLowerCase())
                      );
                    }
                    
                    return { id: call.id, name: call.name, response: { result: products } };
                  } else if (call.name === 'sendFollowUp') {
                    const args = call.args as any;
                    const contactType = args.contactType || args.contact_type;
                    const contactAddress = args.contactAddress || args.contact_address;
                    const msg = args.message || args.msg;
                    
                    console.log(`[Follow-up] Sending ${contactType} to ${contactAddress}`);
                    console.log(`[Follow-up] Message: ${msg}`);
                    
                    if (!contactType || !contactAddress || !msg) {
                      return { id: call.id, name: call.name, response: { error: "Missing required arguments: contactType, contactAddress, or message" } };
                    }

                    const followUp = await db.addFollowUp({ contactType, contactAddress, message: msg });
                    return { id: call.id, name: call.name, response: { result: "Follow-up sent successfully via " + contactType, id: followUp.id } };
                  }
                  return { id: call.id, name: call.name, response: { error: "Unknown function" } };
                }));
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
              }
            },
            onerror: (err) => { 
              console.error('[Gemini] Error:', err); 
              ws.send(JSON.stringify({ event: 'error', message: 'Gemini connection error' }));
              ws.close(); 
            },
            onclose: () => { console.log('[Gemini] Closed'); ws.close(); }
          }
        });
        geminiSession = await sessionPromise;
      } catch (err) {
        console.error('[Gemini] Connection failed:', err);
        ws.send(JSON.stringify({ event: 'error', message: 'Failed to connect to Gemini' }));
        ws.close();
      } finally {
        isConnectingGemini = false;
      }
    };

    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message);
        if (data.event === 'start') {
          streamSid = data.start?.streamSid || data.streamSid || null;
          const from = data.start?.customParameters?.from;
          if (from) streamSid = from; // Use phone number as callerId if available
          
          preferredLanguage = data.preferredLanguage || 'English';
          connectToGemini();
        } else if (data.event === 'media' || data.event === 'audio') {
          const payload = getPayload(data);
          if (geminiSession && payload) {
            geminiSession.sendRealtimeInput({ media: { data: payload, mimeType } });
          } else if (!geminiSession && !streamSid) {
            // For browser, we might not have a 'start' event, so connect on first audio
            connectToGemini().then(() => {
              if (geminiSession) geminiSession.sendRealtimeInput({ media: { data: payload, mimeType } });
            });
          }
        } else if (data.event === 'stop') {
          if (geminiSession) geminiSession.close();
        }
      } catch (e) {
        console.error('[WS] Message error:', e);
      }
    });

    ws.on('close', async () => {
      if (geminiSession) geminiSession.close();
      
      // Log session to Firestore
      if (transcript.length > 0) {
        try {
          const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
          if (!apiKey) throw new Error('Gemini API Key is missing');
          
          const ai = new GoogleGenAI({ apiKey });
          const summaryResponse = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: `Summarize this conversation and determine the outcome (inquiry, support, sale, lead, other): ${JSON.stringify(transcript)}`,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  summary: { type: Type.STRING },
                  outcome: { type: Type.STRING, enum: ["inquiry", "support", "sale", "lead", "other"] }
                },
                required: ["summary", "outcome"]
              }
            }
          });
          
          const { summary, outcome } = JSON.parse(summaryResponse.text);
          
          await firestore.collection('sessions').add({
            startTime,
            endTime: new Date().toISOString(),
            callerId: streamSid || 'browser-user',
            preferredLanguage,
            transcript,
            summary,
            outcome,
            createdAt: new Date().toISOString()
          });
          console.log('[Firestore] Session logged');
        } catch (err) {
          console.error('[Firestore] Failed to log session:', err);
        }
      }
    });
  }
}

startServer();
