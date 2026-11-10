/**
 * Tati Voice AI Platform - chat.js (Complete Engine & Low-Latency Streaming)
 * 100% Syntax Verified + Full Export Compatibility for index.html
 */

const getBaseUrl = () => {
  if (typeof process !== "undefined" && process.env) {
    if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
    if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
  }
  if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return "http://127.0.0.1:8000";
  }
  return ""; 
};

const API_BASE_URL = getBaseUrl();

export const SUPPORTED_LANGUAGES = {
  EN: "en-US",
  FR: "fr-FR",
  PT: "pt-BR",
};

const SpeechRecognition = 
  typeof window !== "undefined" && 
  (window.SpeechRecognition || window.webkitSpeechRecognition);

// Global persistent state
window._currentAudio = null;
window._currentAudioSource = null;
window._currentUtterance = null;
window._persistentAudio = (typeof window !== "undefined") ? new Audio() : null;
window._audioUnlocked = false;

let activeWakeWordRecognition = null;
let isSpeakingState = false;
let isRecordingState = false;
let activeMediaRecorder = null;
let recordedChunks = [];
let recordingTimeout = null;

// Audio VAD (Voice Activity Detection) State
let vadAudioCtx = null;
let vadAnalyser = null;
let vadCheckInterval = null;

// Sequential Audio Queue Manager for Sentence-Level Streaming TTS
class SpeechQueue {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
  }

  enqueue(text, preferredVoiceName = "af_heart", lang = "en-US", rate = 1.0) {
    if (!text || !text.trim()) return;
    this.queue.push({ text: text.trim(), preferredVoiceName, lang, rate });
    if (!this.isPlaying) {
      this.processNext();
    }
  }

  async processNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      isSpeakingState = false;
      updateStatusUI("SAY 'HEY TATI'", "idle");
      startWakeWordListener();
      return;
    }

    this.isPlaying = true;
    isSpeakingState = true;
    updateStatusUI("TATI SPEAKING", "speaking");

    const item = this.queue.shift();
    try {
      await speakSentenceChunk(item.text, item.preferredVoiceName, item.lang, item.rate);
    } catch (e) {
      console.warn("Sentence TTS error, falling back to WebSpeech chunk:", e);
      await fallbackWebSpeechPromise(item.text, item.lang, item.rate);
    }

    this.processNext();
  }

  clear() {
    this.queue = [];
    this.isPlaying = false;
  }
}

const audioQueue = new SpeechQueue();

function cleanupVAD() {
  if (vadCheckInterval) {
    clearInterval(vadCheckInterval);
    vadCheckInterval = null;
  }
  if (vadAudioCtx) {
    try { vadAudioCtx.close(); } catch (e) {}
    vadAudioCtx = null;
  }
  vadAnalyser = null;
}

// --- Modal Overlay & UI ---

export function hideWelcomeModal() {
  const initOverlay = document.getElementById('init-overlay');
  if (initOverlay) {
    initOverlay.style.setProperty('display', 'none', 'important');
  }

  const selectors = ['#welcome-overlay', '#welcome-modal', '.welcome-modal'];
  selectors.forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.setProperty('display', 'none', 'important');
  });
}

function updateStatusUI(statusText, visualState = '') {
  const statusLabel = document.getElementById('status-label') || document.querySelector('.status-text');
  const orb = document.getElementById('orb-button') || document.querySelector('.orb-container');

  if (statusLabel) statusLabel.textContent = statusText;
  if (orb && visualState) {
    orb.setAttribute('data-state', visualState);
  }
}

// --- Audio Unlocking & Cleanup ---

export function prewarmAudio() {
  if (typeof window === "undefined") return;

  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
    } catch (e) {}
  }

  if (window._persistentAudio && !window._audioUnlocked) {
    try {
      window._persistentAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
      const playPromise = window._persistentAudio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          window._persistentAudio.pause();
          window._audioUnlocked = true;
          console.log("🔊 AudioContext successfully unlocked.");
        }).catch(() => {});
      }
    } catch (e) {}
  }

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      if (!window._audioCtx) window._audioCtx = new AudioCtx();
      if (window._audioCtx.state === 'suspended') window._audioCtx.resume();
    }
  } catch (e) {}
}

export function stopAudioPlayback() {
  isSpeakingState = false;
  audioQueue.clear();

  if (window._currentAudioSource) {
    try {
      window._currentAudioSource.stop();
      window._currentAudioSource.disconnect();
    } catch (e) {}
    window._currentAudioSource = null;
  }
  if (window._persistentAudio) {
    try {
      window._persistentAudio.pause();
      window._persistentAudio.currentTime = 0;
    } catch (e) {}
  }
  if (window._currentAudio) {
    try {
      window._currentAudio.pause();
      window._currentAudio.currentTime = 0;
    } catch (e) {}
    window._currentAudio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
}

// --- Voice Recognition Engine ---

export function startWakeWordListener(onWakeCallback, targetWord = "tati", lang = "en-US") {
  if (!SpeechRecognition || isSpeakingState || isRecordingState) return null;

  stopWakeWordListener();

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event) => {
      if (isSpeakingState || isRecordingState) return;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase();
        if (
          transcript.includes(targetWord.toLowerCase()) || 
          transcript.includes("hey tati") || 
          transcript.includes("ok tati") ||
          transcript.includes("tati")
        ) {
          console.log("⚡ Wake word detected:", transcript);
          stopWakeWordListener();
          if (onWakeCallback) {
            onWakeCallback(transcript);
          } else {
            const queryText = transcript.replace(/.*(?:hey tati|ok tati|tati)/i, '').trim();
            if (queryText.length > 0) {
              sendVoiceQuery(queryText);
            } else {
              listenToVoice((text) => sendVoiceQuery(text));
            }
          }
          break;
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "network") {
        console.warn("⚠️ Cloud SpeechRecognition unavailable. Tap orb for local Whisper STT.");
        stopWakeWordListener();
        updateStatusUI("OFFLINE - TAP ORB TO TALK", "idle");
        return;
      }
      if (event.error !== "aborted" && activeWakeWordRecognition && !isSpeakingState) {
        setTimeout(() => {
          if (activeWakeWordRecognition === recognition && !isSpeakingState) {
            try { recognition.start(); } catch (e) {}
          }
        }, 1500);
      }
    };

    recognition.onend = () => {
      if (activeWakeWordRecognition === recognition && !isSpeakingState && !isRecordingState) {
        try { recognition.start(); } catch (e) {}
      }
    };

    recognition.start();
    activeWakeWordRecognition = recognition;
    console.log(`👂 Voice-to-Wake active. Listening for "Hey ${targetWord}"...`);
    updateStatusUI("SAY 'HEY TATI'", "idle");

    return { stop: stopWakeWordListener };
  } catch (err) {
    console.warn("Could not start Voice-to-Wake engine:", err);
    return null;
  }
}

export function stopWakeWordListener() {
  if (activeWakeWordRecognition) {
    const rec = activeWakeWordRecognition;
    activeWakeWordRecognition = null;
    try { rec.stop(); } catch (e) {}
  }
}

// --- 350ms Low-Latency VAD Local Whisper STT ---

export function stopLocalWhisperRecording() {
  cleanupVAD();
  if (activeMediaRecorder && activeMediaRecorder.state === "recording") {
    console.log("🛑 Stopping microphone recording...");
    if (recordingTimeout) clearTimeout(recordingTimeout);
    try { activeMediaRecorder.requestData(); } catch (e) {}
    activeMediaRecorder.stop();
    return true;
  }
  return false;
}

async function startLocalWhisperRecording(onResultCallback, onErrorCallback) {
  if (stopLocalWhisperRecording()) return;

  try {
    isRecordingState = true;
    updateStatusUI("LISTENING...", "listening");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeMediaRecorder = new MediaRecorder(stream);
    recordedChunks = [];

    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    vadAudioCtx = new AudioCtxClass();
    const sourceNode = vadAudioCtx.createMediaStreamSource(stream);
    vadAnalyser = vadAudioCtx.createAnalyser();
    vadAnalyser.fftSize = 1024;
    sourceNode.connect(vadAnalyser);

    const timeDomainData = new Float32Array(vadAnalyser.fftSize);
    let speechDetected = false;
    let silenceStart = null;
    const RMS_SPEECH_THRESHOLD = 0.02; 
    const ULTRA_FAST_SILENCE_MS = 350;

    vadCheckInterval = setInterval(() => {
      if (!isRecordingState || !vadAnalyser) return;
      
      vadAnalyser.getFloatTimeDomainData(timeDomainData);
      let sumSquares = 0;
      for (let i = 0; i < timeDomainData.length; i++) {
        sumSquares += timeDomainData[i] * timeDomainData[i];
      }
      const rms = Math.sqrt(sumSquares / timeDomainData.length);

      if (rms > RMS_SPEECH_THRESHOLD) {
        if (!speechDetected) {
          speechDetected = true;
          updateStatusUI("RECORDING SPEECH...", "listening");
        }
        silenceStart = null;
      } else if (speechDetected) {
        if (!silenceStart) {
          silenceStart = Date.now();
        } else if (Date.now() - silenceStart > ULTRA_FAST_SILENCE_MS) {
          console.log("⚡ Low-latency VAD (350ms silence). Transcribing immediately...");
          stopLocalWhisperRecording();
        }
      }
    }, 25);

    activeMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    activeMediaRecorder.onstop = async () => {
      isRecordingState = false;
      cleanupVAD();
      if (recordingTimeout) clearTimeout(recordingTimeout);
      stream.getTracks().forEach(t => t.stop());

      if (recordedChunks.length === 0) {
        updateStatusUI("SAY 'HEY TATI'", "idle");
        return;
      }

      const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('file', audioBlob, 'speech.webm');

      updateStatusUI("TRANSCRIBING...", "thinking");

      try {
        const response = await fetch(`${API_BASE_URL}/api/stt`, {
          method: "POST",
          headers: { "Bypass-Tunnel-Reminder": "true" },
          body: formData
        });

        if (!response.ok) throw new Error(`STT Status ${response.status}`);

        const data = await response.json();
        const transcript = (data.transcript || "").trim();

        if (transcript) {
          console.log("📝 STT Transcript:", transcript);
          updateStatusUI("THINKING...", "thinking");
          if (onResultCallback) onResultCallback(transcript);
        } else {
          console.warn("⚠️ Empty transcript returned from local Whisper STT.");
          if (onErrorCallback) onErrorCallback("No speech detected.");
          updateStatusUI("SAY 'HEY TATI'", "idle");
        }
      } catch (err) {
        console.error("Whisper STT error:", err);
        if (onErrorCallback) onErrorCallback("STT failed.");
        updateStatusUI("SAY 'HEY TATI'", "idle");
      }
    };

    activeMediaRecorder.start(50);
    recordingTimeout = setTimeout(() => stopLocalWhisperRecording(), 10000);

  } catch (err) {
    console.error("Microphone recording error:", err);
    isRecordingState = false;
    cleanupVAD();
    if (onErrorCallback) onErrorCallback("Microphone permission required.");
    updateStatusUI("MIC ERROR", "error");
  }
}

export function listenToVoice(onResultCallback, onErrorCallback, lang = "en-US") {
  stopAudioPlayback();
  stopWakeWordListener();
  prewarmAudio();

  const localStop = () => stopLocalWhisperRecording();

  if (isRecordingState) {
    stopLocalWhisperRecording();
    return { start: () => {}, stop: localStop };
  }

  if (!navigator.onLine || !SpeechRecognition) {
    startLocalWhisperRecording(onResultCallback, onErrorCallback);
    return { start: () => {}, stop: localStop };
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = lang;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    if (transcript && transcript.trim()) {
      updateStatusUI("THINKING...", "thinking");
      if (onResultCallback) onResultCallback(transcript.trim());
    } else {
      updateStatusUI("SAY 'HEY TATI'", "idle");
    }
  };

  recognition.onerror = (event) => {
    console.warn(`Speech recognition error (${event.error}). Switching to local Whisper STT...`);
    startLocalWhisperRecording(onResultCallback, onErrorCallback);
  };

  try {
    recognition.start();
    updateStatusUI("LISTENING...", "listening");
  } catch (e) {
    startLocalWhisperRecording(onResultCallback, onErrorCallback);
  }

  return {
    start: () => { try { recognition.start(); } catch (e) {} },
    stop: () => { 
      try { recognition.stop(); } catch (e) {} 
      stopLocalWhisperRecording();
    }
  };
}

// --- Speech Output Pipeline ---

function mapVoiceToKokoro(presetName) {
  switch (presetName) {
    case "samantha":
    case "af_heart":
      return "af_heart";
    case "af_bella":
      return "af_bella";
    case "af_sarah":
    case "female_uk":
      return "af_sarah";
    case "am_adam":
    case "male_us":
      return "am_adam";
    case "am_michael":
      return "am_michael";
    default:
      return "af_heart";
  }
}

async function speakSentenceChunk(text, preferredVoiceName = "af_heart", lang = "en-US", rate = 1.0) {
  const kokoroVoice = mapVoiceToKokoro(preferredVoiceName);
  const response = await fetch(`${API_BASE_URL}/api/tts`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Bypass-Tunnel-Reminder": "true"
    },
    body: JSON.stringify({ text, voice: kokoroVoice, speed: rate }),
  });

  if (!response.ok) throw new Error(`Kokoro TTS error ${response.status}`);

  const arrayBuffer = await response.arrayBuffer();
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  if (!window._audioCtx) window._audioCtx = new AudioCtxClass();
  if (window._audioCtx.state === 'suspended') await window._audioCtx.resume();

  const audioBuffer = await window._audioCtx.decodeAudioData(arrayBuffer);
  
  return new Promise((resolve) => {
    const source = window._audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    const gainNode = window._audioCtx.createGain();
    gainNode.gain.value = 1.6;

    source.connect(gainNode);
    gainNode.connect(window._audioCtx.destination);
    window._currentAudioSource = source;

    source.onended = () => {
      window._currentAudioSource = null;
      resolve();
    };

    source.start(0);
  });
}

function fallbackWebSpeech(text, onEndCallback, lang = "en-US", rate = 1.0) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    if (onEndCallback) onEndCallback();
    return;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  utterance.lang = lang;

  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    utterance.voice = voices.find(v => v.lang.startsWith(lang.split('-')[0])) || voices[0];
  }

  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      if (onEndCallback) onEndCallback();
    }
  };

  utterance.onend = finish;
  utterance.onerror = finish;

  // Fallback safety timeout for Chrome SpeechSynthesis freeze issues
  setTimeout(finish, 15000);

  window._currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

function fallbackWebSpeechPromise(text, lang = "en-US", rate = 1.0) {
  return new Promise((resolve) => {
    fallbackWebSpeech(text, () => resolve(), lang, rate);
  });
}

export async function speakResponse(
  text, 
  onEndCallback = null, 
  preferredVoiceName = "af_heart", 
  lang = "en-US",
  rate = 1.0
) {
  stopAudioPlayback();
  stopWakeWordListener();
  isSpeakingState = true;
  updateStatusUI("TATI SPEAKING", "speaking");

  const handleSpeechCompletion = () => {
    isSpeakingState = false;
    updateStatusUI("SAY 'HEY TATI'", "idle");
    if (onEndCallback) {
      onEndCallback();
    } else {
      startWakeWordListener();
    }
  };

  if (!text || !text.trim()) {
    handleSpeechCompletion();
    return;
  }

  // Chunk long text into individual sentences to prevent /api/tts 504 timeouts
  const sentences = text.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [text];

  try {
    for (const sentence of sentences) {
      const cleanSentence = sentence.trim();
      if (cleanSentence) {
        await speakSentenceChunk(cleanSentence, preferredVoiceName, lang, rate);
      }
    }
    handleSpeechCompletion();
  } catch (error) {
    console.warn("⚠️ Web Audio synthesis error, falling back to Web Speech synthesis:", error);
    fallbackWebSpeech(text, handleSpeechCompletion, lang, rate);
  }
}

// --- Query Pipeline with Token Streaming ---

export async function sendVoiceQuery(
  transcript, 
  autoSpeak = true, 
  preferredVoiceName = "af_heart", 
  lang = "en-US", 
  rate = 1.0
) {
  if (!transcript || !transcript.trim()) {
    updateStatusUI("SAY 'HEY TATI'", "idle");
    throw new Error("Voice transcript cannot be empty.");
  }

  stopAudioPlayback();
  if (autoSpeak) prewarmAudio();
  updateStatusUI("THINKING...", "thinking");

  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Bypass-Tunnel-Reminder": "true"
      },
      body: JSON.stringify({ 
        prompt: transcript.trim(),
        transcript: transcript.trim(), 
        language: lang 
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || errorData.error || `Server error code ${response.status}`);
    }

    if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sentenceBuffer = "";
      let fullResponseText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        sentenceBuffer += chunk;
        fullResponseText += chunk;

        const match = sentenceBuffer.match(/(.*?[.!?])(?:\s+|$)/);
        if (match) {
          const completedSentence = match[1].trim();
          sentenceBuffer = sentenceBuffer.slice(match[0].length);

          if (autoSpeak && completedSentence) {
            console.log("⚡ Streaming Sentence to TTS Queue:", completedSentence);
            audioQueue.enqueue(completedSentence, preferredVoiceName, lang, rate);
          }
        }
      }

      if (autoSpeak && sentenceBuffer.trim()) {
        audioQueue.enqueue(sentenceBuffer.trim(), preferredVoiceName, lang, rate);
      }

      return { responseText: fullResponseText };
    } else {
      const data = await response.json();
      const responseText = data.response_text || data.response || data.reply || "";

      if (autoSpeak && responseText) {
        speakResponse(responseText, null, preferredVoiceName, lang, rate);
      } else {
        updateStatusUI("SAY 'HEY TATI'", "idle");
      }

      return {
        responseText: responseText,
        databaseHits: data.database_hits,
        hits: data.hits || [],
        provider: data.provider || "unknown"
      };
    }

  } catch (error) {
    console.error("Error connecting to Tati Backend:", error);
    updateStatusUI("SAY 'HEY TATI'", "idle");
    if (autoSpeak) {
      speakResponse("Sorry, I could not reach the Tati backend server.", null, preferredVoiceName, lang, rate);
    }
    throw error;
  }
}

export async function initiateWelcomeConsole() {
  hideWelcomeModal();
  prewarmAudio();

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    } catch (e) {
      console.warn("Microphone access prompt error:", e);
    }
  }

  speakResponse(
    "Welcome to Tati Voice AI Console. Local Kokoro neural speech engine online. Say Hey Tati or tap the orb to begin."
  );
}

// Global window bindings
window.prewarmAudio = prewarmAudio;
window.stopAudioPlayback = stopAudioPlayback;
window.startWakeWordListener = startWakeWordListener;
window.stopWakeWordListener = stopWakeWordListener;
window.stopLocalWhisperRecording = stopLocalWhisperRecording;
window.speakResponse = speakResponse;
window.listenToVoice = listenToVoice;
window.sendVoiceQuery = sendVoiceQuery;
window.initiateWelcomeConsole = initiateWelcomeConsole;
window.hideWelcomeModal = hideWelcomeModal;

function bindUIListeners() {
  const startBtn = document.getElementById('start-btn') || 
                   document.querySelector('button') || 
                   document.getElementById('orb-button');

  if (startBtn) {
    startBtn.addEventListener('click', () => {
      hideWelcomeModal();
      prewarmAudio();

      if (isRecordingState) {
        stopLocalWhisperRecording();
      } else {
        listenToVoice((transcript) => {
          sendVoiceQuery(transcript);
        });
      }
    });
  }

  const orb = document.getElementById('orb-button') || document.querySelector('.orb-container');
  if (orb && orb !== startBtn) {
    orb.addEventListener('click', () => {
      hideWelcomeModal();
      prewarmAudio();

      if (isRecordingState) {
        stopLocalWhisperRecording();
      } else {
        listenToVoice((transcript) => {
          sendVoiceQuery(transcript);
        });
      }
    });
  }
}

if (typeof window !== "undefined") {
  const unlockEvents = ['touchstart', 'click'];
  unlockEvents.forEach(evt => {
    document.addEventListener(evt, () => prewarmAudio(), { passive: true, once: false });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUIListeners);
  } else {
    bindUIListeners();
  }
}