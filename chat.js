/**
 * Tati Voice AI Platform - chat.js
 * Kokoro-82M Local Neural TTS + Voice-to-Wake ("Hey Tati") + Web Speech API
 */

const getBaseUrl = () => {
  if (typeof process !== "undefined" && process.env) {
    if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
    if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
  }
  if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return "http://127.0.0.1:8000";
  }
  // Persistent LocalTunnel Endpoint Fallback
  return "https://tati-voice-ai-backend.loca.lt"; 
};

const API_BASE_URL = getBaseUrl();

const SUPPORTED_LANGUAGES = {
  EN: "en-US",
  FR: "fr-FR",
  PT: "pt-BR",
};

const SpeechRecognition = 
  typeof window !== "undefined" && 
  (window.SpeechRecognition || window.webkitSpeechRecognition);

window._currentAudio = null;
window._currentUtterance = null;
let activeWakeWordRecognition = null;

// --- Modal & UI Management ---

function hideWelcomeModal() {
  // 1. Target by explicit ID/class selectors
  const selectors = [
    '#welcome-overlay', '#welcome-modal', '#welcome-screen',
    '.welcome-modal', '[id*="welcome"]', '.fixed.inset-0', '[class*="z-50"]'
  ];
  selectors.forEach(selector => {
    const el = document.querySelector(selector);
    if (el) {
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    }
  });

  // 2. Target any container matching the "INITIALIZE TATI CONSOLE" overlay text
  const allElements = document.querySelectorAll('div, section, main, overlay');
  allElements.forEach(el => {
    if (el.textContent && el.textContent.includes('INITIALIZE TATI CONSOLE') && el.children.length > 0) {
      let topContainer = el;
      while (topContainer.parentElement && topContainer.parentElement !== document.body) {
        topContainer = topContainer.parentElement;
      }
      topContainer.style.setProperty('display', 'none', 'important');
      topContainer.style.setProperty('visibility', 'hidden', 'important');
      topContainer.style.setProperty('opacity', '0', 'important');
      topContainer.style.setProperty('pointer-events', 'none', 'important');
    }
  });
}

function updateStatusUI(statusText, visualState = '') {
  const statusLabel = document.getElementById('status-label') || document.querySelector('.status-text') || document.querySelector('[id*="status"]');
  const orb = document.getElementById('orb-button') || document.querySelector('.orb-container') || document.querySelector('[id*="orb"]');

  if (statusLabel) statusLabel.textContent = statusText;
  if (orb && visualState) {
    orb.setAttribute('data-state', visualState);
  }
}

// --- Audio & Prewarming ---

function prewarmAudio() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.resume();
      const silent = new SpeechSynthesisUtterance("");
      window.speechSynthesis.speak(silent);
    } catch (e) {}
  }
  
  // Unlock Web Audio Context for iOS Safari
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      if (!window._audioCtx) window._audioCtx = new AudioCtx();
      if (window._audioCtx.state === 'suspended') window._audioCtx.resume();
    }
  } catch (e) {}
}

function stopAudioPlayback() {
  if (window._currentAudio) {
    window._currentAudio.pause();
    window._currentAudio.currentTime = 0;
    window._currentAudio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

// --- Voice Recognition & Wake-Word Listener ---

function startWakeWordListener(onWakeCallback, targetWord = "tati", lang = "en-US") {
  if (!SpeechRecognition) return null;

  stopWakeWordListener();

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event) => {
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
      if (event.error !== "aborted" && activeWakeWordRecognition) {
        setTimeout(() => {
          if (activeWakeWordRecognition === recognition) {
            try { recognition.start(); } catch (e) {}
          }
        }, 1000);
      }
    };

    recognition.onend = () => {
      if (activeWakeWordRecognition === recognition) {
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

function stopWakeWordListener() {
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

async function speakResponse(
  text, 
  onEndCallback = null, 
  preferredVoiceName = "af_heart", 
  lang = "en-US",
  rate = 1.0
) {
  stopAudioPlayback();
  stopWakeWordListener();
  updateStatusUI("TATI SPEAKING", "speaking");

  const kokoroVoice = mapVoiceToKokoro(preferredVoiceName);

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
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);

    window._currentAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      window._currentAudio = null;
      if (onEndCallback) {
        onEndCallback();
      } else {
        startWakeWordListener();
      }
    };

    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      window._currentAudio = null;
      fallbackWebSpeech(text, onEndCallback || startWakeWordListener, lang, rate);
    };

    await audio.play();
  } catch (error) {
    console.warn("⚠️ Falling back to Web Speech synthesis:", error);
    fallbackWebSpeech(text, onEndCallback || startWakeWordListener, lang, rate);
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

function listenToVoice(onResultCallback, onErrorCallback, lang = "en-US") {
  if (!SpeechRecognition) {
    const errorMsg = "Speech recognition is not supported in this browser.";
    if (onErrorCallback) onErrorCallback(errorMsg);
    return null;
  }

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

async function sendVoiceQuery(
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

// --- Global Entry Point for Welcome Console Button ---

async function initiateWelcomeConsole() {
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

  startWakeWordListener();

  speakResponse(
    "Welcome to Tati Voice AI Console. Local Kokoro neural speech engine online. Say Hey Tati or tap the orb to begin."
  );
}

// Bind all functions to window for global access
window.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
window.prewarmAudio = prewarmAudio;
window.stopAudioPlayback = stopAudioPlayback;
window.startWakeWordListener = startWakeWordListener;
window.stopWakeWordListener = stopWakeWordListener;
window.speakResponse = speakResponse;
window.fallbackWebSpeech = fallbackWebSpeech;
window.listenToVoice = listenToVoice;
window.sendVoiceQuery = sendVoiceQuery;
window.initiateWelcomeConsole = initiateWelcomeConsole;
window.hideWelcomeModal = hideWelcomeModal;

// DOM Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('touchstart', prewarmAudio, { passive: true });
  document.addEventListener('click', prewarmAudio, { passive: true });

  const startButtons = document.querySelectorAll('button');
  startButtons.forEach(btn => {
    if (btn.textContent && btn.textContent.includes('START VOICE CONSOLE')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        initiateWelcomeConsole();
      });
    }
  });

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