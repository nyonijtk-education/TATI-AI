/**
 * Tati Voice AI Platform - chat.js
 * Kokoro-82M Local Neural TTS + Voice-to-Wake ("Hey Tati") + Web Speech API
 * Mobile Safari WebKit Compatible, Echo-Free & Gain-Amplified Architecture
 */

const getBaseUrl = () => {
  if (typeof process !== "undefined" && process.env) {
    if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
    if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
  }
  if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return "http://127.0.0.1:8000";
  }
  return "https://tati-voice-ai-backend.loca.lt"; 
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

// Global persistent audio objects to prevent mobile locks, double playback, and volume throttling
window._currentAudio = null;
window._currentAudioSource = null;
window._currentUtterance = null;
window._persistentAudio = (typeof window !== "undefined") ? new Audio() : null;
window._audioUnlocked = false;

let activeWakeWordRecognition = null;
let isSpeakingState = false;

// --- Modal Overlay & UI Management ---

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

// --- Mobile Safari Audio Unlocking & Cleanup ---

export function prewarmAudio() {
  if (typeof window === "undefined") return;

  // 1. Cancel ongoing web speech synthesis
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
    } catch (e) {}
  }

  // 2. Prime persistent audio element for iOS Safari (requires touch context)
  if (window._persistentAudio && !window._audioUnlocked) {
    try {
      window._persistentAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
      const playPromise = window._persistentAudio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          window._persistentAudio.pause();
          window._audioUnlocked = true;
          console.log("🔊 iOS AudioContext successfully unlocked.");
        }).catch(() => {});
      }
    } catch (e) {}
  }

  // 3. Resume Web Audio Context
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
  if (!SpeechRecognition || isSpeakingState) return null;

  stopWakeWordListener();

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event) => {
      if (isSpeakingState) return;

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
            }
          }
          break;
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error !== "aborted" && activeWakeWordRecognition && !isSpeakingState) {
        setTimeout(() => {
          if (activeWakeWordRecognition === recognition && !isSpeakingState) {
            try { recognition.start(); } catch (e) {}
          }
        }, 1000);
      }
    };

    recognition.onend = () => {
      if (activeWakeWordRecognition === recognition && !isSpeakingState) {
        try { recognition.start(); } catch (e) {}
      }
    };

    recognition.start();
    activeWakeWordRecognition = recognition;
    console.log(`👂 Voice-to-Wake active. Listening for "Hey ${targetWord}"...`);
    updateStatusUI("LISTENING", "listening");

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

// --- Speech Output Pipeline (Volume Amplified & Mobile Safe) ---

export async function speakResponse(
  text, 
  onEndCallback = null, 
  preferredVoiceName = "af_heart", 
  lang = "en-US",
  rate = 1.0
) {
  // 1. Immediately kill existing speech and release microphone channel for iOS
  stopAudioPlayback();
  stopWakeWordListener();
  isSpeakingState = true;
  updateStatusUI("TATI SPEAKING", "speaking");

  const kokoroVoice = mapVoiceToKokoro(preferredVoiceName);

  const handleSpeechCompletion = () => {
    isSpeakingState = false;
    if (onEndCallback) {
      onEndCallback();
    } else {
      startWakeWordListener();
    }
  };

  try {
    const response = await fetch(`${API_BASE_URL}/api/tts`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Bypass-Tunnel-Reminder": "true"
      },
      body: JSON.stringify({ text, voice: kokoroVoice, speed: rate }),
    });

    if (!response.ok) throw new Error(`Kokoro TTS error ${response.status}`);

    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();

    // Ensure AudioContext is active
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!window._audioCtx) {
      window._audioCtx = new AudioCtxClass();
    }
    if (window._audioCtx.state === 'suspended') {
      await window._audioCtx.resume();
    }

    // Decode PCM stream to Web Audio buffer
    const audioBuffer = await window._audioCtx.decodeAudioData(arrayBuffer);
    const source = window._audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    // --- MOBILE VOLUME AMPLIFIER (GAIN NODE) ---
    const gainNode = window._audioCtx.createGain();
    gainNode.gain.value = 1.6; // 1.6x Volume Boost (+60% loudness amplification)

    // Route: Source -> Gain Node -> Device Speakers
    source.connect(gainNode);
    gainNode.connect(window._audioCtx.destination);

    window._currentAudioSource = source;

    source.onended = () => {
      window._currentAudioSource = null;
      handleSpeechCompletion();
    };

    source.start(0);

  } catch (error) {
    console.warn("⚠️ Web Audio amplification failed, falling back to Web Speech synthesis:", error);
    fallbackWebSpeech(text, handleSpeechCompletion, lang, rate);
  }
}

function fallbackWebSpeech(text, onEndCallback, lang, rate) {
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

  utterance.onend = () => { if (onEndCallback) onEndCallback(); };
  utterance.onerror = () => { if (onEndCallback) onEndCallback(); };

  window._currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function listenToVoice(onResultCallback, onErrorCallback, lang = "en-US") {
  if (!SpeechRecognition) {
    const errorMsg = "Speech recognition is not supported in this browser.";
    if (onErrorCallback) onErrorCallback(errorMsg);
    return null;
  }

  stopAudioPlayback();
  stopWakeWordListener();
  prewarmAudio();

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = lang;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    if (onResultCallback) onResultCallback(transcript);
  };

  recognition.onerror = (event) => {
    console.error(`Speech recognition error (${lang}):`, event.error);
    if (onErrorCallback) onErrorCallback(event.error);
  };

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
  };
}

export async function sendVoiceQuery(
  transcript, 
  autoSpeak = true, 
  preferredVoiceName = "af_heart", 
  lang = "en-US", 
  rate = 1.0
) {
  if (!transcript || !transcript.trim()) {
    throw new Error("Voice transcript cannot be empty.");
  }

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
      throw new Error(errorData.detail || `Server error code ${response.status}`);
    }

    const data = await response.json();
    const responseText = data.response_text || data.response || data.reply || "";

    if (data.provider === "groq_cloud") {
      console.log("⚡ Fallback Active: Query processed via Groq Cloud.");
    } else if (data.provider === "ollama_local") {
      console.log("🟢 Primary Active: Query processed locally via Ollama.");
    }

    if (autoSpeak && responseText) {
      speakResponse(responseText, null, preferredVoiceName, lang, rate);
    }

    return {
      responseText: responseText,
      databaseHits: data.database_hits,
      hits: data.hits || [],
      provider: data.provider || "unknown"
    };
  } catch (error) {
    console.error("Error connecting to Tati Backend:", error);
    updateStatusUI("ERROR OCCURRED", "error");
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

// Global window bindings for legacy inline HTML event handlers
window.prewarmAudio = prewarmAudio;
window.stopAudioPlayback = stopAudioPlayback;
window.startWakeWordListener = startWakeWordListener;
window.stopWakeWordListener = stopWakeWordListener;
window.speakResponse = speakResponse;
window.listenToVoice = listenToVoice;
window.sendVoiceQuery = sendVoiceQuery;
window.initiateWelcomeConsole = initiateWelcomeConsole;
window.hideWelcomeModal = hideWelcomeModal;

// Single-execution touch & click binder
if (typeof window !== "undefined") {
  const unlockEvents = ['touchstart', 'click'];
  unlockEvents.forEach(evt => {
    document.addEventListener(evt, () => prewarmAudio(), { passive: true, once: false });
  });

  document.addEventListener('DOMContentLoaded', () => {
    const orb = document.getElementById('orb-button') || document.querySelector('.orb-container');
    if (orb) {
      orb.addEventListener('click', () => {
        hideWelcomeModal();
        prewarmAudio();
        const listener = listenToVoice((transcript) => {
          sendVoiceQuery(transcript);
        });
        if (listener) listener.start();
      });
    }
  });
}