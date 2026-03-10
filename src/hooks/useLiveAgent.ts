import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_INSTRUCTION = `You are a professional multilingual AI Support Agent as a Sales and Customer Care Representative for a business.

Your responsibilities:
1. Automatically detect the customer's language and respond in the same language.
Supported languages: English, Hausa, Igbo, Yoruba, Nigerian Pidgin.
2. Be polite, professional, warm, and helpful.
3. Understand whether the customer is: Making an inquiry, Requesting support, Asking for price, Asking for recommendation, or Asking for recent products.
4. When customer describes a need: Ask clarifying questions if necessary, Suggest suitable products from the catalog, Mention benefits, pricing, and availability.
5. During the conversation: Offer to send product details via WhatsApp or Email. Ask customer to provide preferred contact and confirm it clearly.
6. After collecting contact: Summarize what will be sent, Thank the customer, End conversation professionally.
7. When suggesting products: Use persuasive but honest sales tone. Focus on solving customer's problem.
8. If the customer is unsure: Offer 2-3 options based on budget or use case.
9. Never hallucinate product data. Only use catalog data provided via function call.
10. Always keep responses short enough for natural phone conversation.

Tone: Professional, Friendly, Solution-focused, Trust-building.
Goal: Convert inquiry into qualified lead or sale.`;

class AudioStreamer {
  audioContext: AudioContext;
  nextStartTime: number;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    this.nextStartTime = this.audioContext.currentTime;
  }

  addPCM16(base64Audio: string) {
    const binaryString = window.atob(base64Audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }
    const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);
    
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    
    const currentTime = this.audioContext.currentTime;
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }
  
  stop() {
    this.audioContext.close();
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    this.nextStartTime = this.audioContext.currentTime;
  }
}

export function useLiveAgent() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState<{role: string, text: string}[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const streamerRef = useRef<AudioStreamer | null>(null);

  const connect = async () => {
    try {
      setIsConnecting(true);
      setError(null);
      setTranscript([]);

      streamerRef.current = new AudioStreamer();

      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
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
          onopen: async () => {
            setIsConnected(true);
            setIsConnecting(false);
            
            // Setup microphone
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            audioContextRef.current = audioContext;
            
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;
            
            source.connect(processor);
            processor.connect(audioContext.destination);
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
              }
              
              let binary = '';
              const bytes = new Uint8Array(pcm16.buffer);
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              const base64Data = window.btoa(binary);
              
              sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle transcriptions
            if (message.serverContent?.modelTurn) {
              const text = message.serverContent.modelTurn.parts.find(p => p.text)?.text;
              if (text) {
                setTranscript(prev => [...prev, { role: 'AI', text }]);
              }
            }
            const userTurn = (message.serverContent as any)?.userTurn;
            if (userTurn) {
              const text = (userTurn.parts as any[]).find(p => p.text)?.text;
              if (text) {
                setTranscript(prev => [...prev, { role: 'Customer', text }]);
              }
            }

            // Handle audio output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && streamerRef.current) {
              streamerRef.current.addPCM16(base64Audio);
            }
            
            // Handle interruption
            if (message.serverContent?.interrupted && streamerRef.current) {
              streamerRef.current.stop();
            }

            // Handle tool calls
            if (message.toolCall) {
              const functionCalls = message.toolCall.functionCalls;
              if (functionCalls) {
                const responses = await Promise.all(functionCalls.map(async (call) => {
                  if (call.name === 'lookupCatalog') {
                    const query = call.args?.query || '';
                    try {
                      const res = await fetch(`/api/products?q=${encodeURIComponent(query as string)}`);
                      const data = await res.json();
                      return {
                        id: call.id,
                        name: call.name,
                        response: { result: data }
                      };
                    } catch (e) {
                      return {
                        id: call.id,
                        name: call.name,
                        response: { error: "Failed to fetch catalog" }
                      };
                    }
                  } else if (call.name === 'sendFollowUp') {
                    try {
                      const res = await fetch('/api/follow-ups', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(call.args)
                      });
                      const data = await res.json();
                      return {
                        id: call.id,
                        name: call.name,
                        response: { result: "Follow-up scheduled successfully", details: data }
                      };
                    } catch (e) {
                      return {
                        id: call.id,
                        name: call.name,
                        response: { error: "Failed to schedule follow-up" }
                      };
                    }
                  }
                  return { id: call.id, name: call.name, response: { error: "Unknown function" } };
                }));
                
                sessionPromise.then(session => {
                  session.sendToolResponse({ functionResponses: responses });
                });
              }
            }
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError("Connection error. Please try again.");
            disconnect();
          },
          onclose: () => {
            disconnect();
          }
        }
      });
      
      sessionRef.current = sessionPromise;
      
    } catch (err: any) {
      console.error("Failed to connect:", err);
      setError(err.message || "Failed to connect to AI Agent");
      setIsConnecting(false);
    }
  };

  const disconnect = () => {
    if (processorRef.current && audioContextRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (streamerRef.current) {
      streamerRef.current.stop();
      streamerRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.then((session: any) => session.close()).catch(console.error);
      sessionRef.current = null;
    }
    setIsConnected(false);
    setIsConnecting(false);
  };

  return {
    isConnected,
    isConnecting,
    transcript,
    error,
    connect,
    disconnect
  };
}
