import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, Type } from "@google/genai";

class AudioStreamer {
  audioContext: AudioContext;
  nextStartTime: number;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    this.nextStartTime = this.audioContext.currentTime;
  }

  async resume() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async addPCM16(base64Audio: string) {
    await this.resume();
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
    if (this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }
}

const SYSTEM_INSTRUCTION = `You are Drisa, a professional Nigerian AI Sales & Support Agent for DrisaTech (https://drisatech.com.ng).

LANGUAGE & MULTILINGUAL RULES:
- You are fluent in English, Hausa, Igbo, Yoruba, and Nigerian Pidgin.
- CRITICAL: You MUST respond in the EXACT SAME language the user is speaking.
- You have a native-level understanding of Nigerian accents and dialects.
- If the user switches languages mid-conversation, you MUST switch with them immediately.

TONE & VOICE:
- Speak with a warm, respectful, and rhythmic Nigerian professional tone.
- Use polite Nigerian English honorifics like "Sir" or "Ma" when appropriate.

CONVERSATION RULES:
1. Keep responses VERY CONCISE (1-2 sentences).
2. Use 'lookupCatalog' for product inquiries.
3. Use 'sendFollowUp' to capture contact details and send real messages.
4. Use 'checkServiceStatus' to see if the system is configured correctly.
5. Use 'bookAppointment' to schedule meetings or site visits.

Goal: Provide expert advice on DrisaTech products with a rhythmic Nigerian flair.`;

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
  const startTimeRef = useRef<string>(new Date().toISOString());

  const connect = async (preferredLanguage: string = 'English') => {
    try {
      setIsConnecting(true);
      setError(null);
      setTranscript([]);
      startTimeRef.current = new Date().toISOString();

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API Key is missing. Please configure it in the Secrets panel.");
      }

      const ai = new GoogleGenAI({ apiKey });
      streamerRef.current = new AudioStreamer();

      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
          },
          systemInstruction: `${SYSTEM_INSTRUCTION}\n\nUser's initial preferred language: ${preferredLanguage}`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{
            functionDeclarations: [
              {
                name: "lookupCatalog",
                description: "Search the product catalog.",
                parameters: {
                  type: Type.OBJECT,
                  properties: { query: { type: Type.STRING } }
                }
              },
              {
                name: "sendFollowUp",
                description: "Send a follow-up message.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    contactType: { type: Type.STRING },
                    contactAddress: { type: Type.STRING },
                    message: { type: Type.STRING }
                  },
                  required: ["contactType", "contactAddress", "message"]
                }
              },
              {
                name: "checkServiceStatus",
                description: "Check service configuration.",
                parameters: { type: Type.OBJECT, properties: {} }
              },
              {
                name: "bookAppointment",
                description: "Schedule a meeting.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    summary: { type: Type.STRING },
                    description: { type: Type.STRING },
                    startTime: { type: Type.STRING },
                    endTime: { type: Type.STRING }
                  },
                  required: ["summary", "startTime", "endTime"]
                }
              }
            ]
          }]
        },
        callbacks: {
          onopen: async () => {
            console.log('[Gemini] Connected');
            setIsConnected(true);
            setIsConnecting(false);

            // Setup microphone
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            audioContextRef.current = audioContext;
            
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(2048, 1, 1);
            processorRef.current = processor;
            
            source.connect(processor);
            processor.connect(audioContext.destination);
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
              }
              
              const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
              sessionRef.current?.sendRealtimeInput({
                media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
              });
            };

            // Initial greeting
            sessionRef.current?.sendRealtimeInput({
              parts: [{ text: "Introduce yourself briefly as the DrisaTech AI Support Agent and ask how you can help." }]
            });
          },
          onmessage: async (message) => {
            if (message.serverContent?.modelTurn) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                  setTranscript(prev => [...prev, { role: 'AI', text: part.text }]);
                }
                if (part.inlineData?.data) {
                  streamerRef.current?.addPCM16(part.inlineData.data);
                }
              }
            }

            if (message.serverContent?.interrupted) {
              // Handle interruption if needed
            }

            if (message.toolCall?.functionCalls) {
              const responses = await Promise.all(message.toolCall.functionCalls.map(async (call) => {
                try {
                  const response = await fetch(`/api/tools/${call.name}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(call.args)
                  });
                  const result = await response.json();
                  return { id: call.id, name: call.name, response: result };
                } catch (err) {
                  return { id: call.id, name: call.name, response: { error: "Tool execution failed" } };
                }
              }));
              sessionRef.current?.sendToolResponse({ functionResponses: responses });
            }
          },
          onerror: (err) => {
            console.error('[Gemini] Error:', err);
            setError("Connection error. Please try again.");
            disconnect();
          },
          onclose: () => {
            console.log('[Gemini] Closed');
            disconnect();
          }
        }
      });

      sessionRef.current = await sessionPromise;
      
    } catch (err: any) {
      console.error("Failed to connect:", err);
      setError(err.message || "Failed to connect to AI Agent");
      setIsConnecting(false);
    }
  };

  const disconnect = () => {
    if (processorRef.current) processorRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();
    if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(t => t.stop());
    if (streamerRef.current) streamerRef.current.stop();
    if (sessionRef.current) sessionRef.current.close();

    // Log session to backend
    if (transcript.length > 0) {
      fetch('/api/sessions/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          startTime: startTimeRef.current,
          endTime: new Date().toISOString(),
          preferredLanguage: 'English' // Simplified
        })
      }).catch(console.error);
    }

    setIsConnected(false);
    setIsConnecting(false);
    sessionRef.current = null;
  };

  const sendMessage = (text: string) => {
    if (sessionRef.current) {
      sessionRef.current.sendRealtimeInput({ parts: [{ text }] });
      setTranscript(prev => [...prev, { role: 'user', text }]);
    }
  };

  return {
    isConnected,
    isConnecting,
    transcript,
    error,
    connect,
    disconnect,
    sendMessage
  };
}
