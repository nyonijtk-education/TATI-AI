/**
 * Tati Voice AI Platform - chat.js
 * Enforced Kokoro-82M TTS with Vercel Serverless Routing & STT Fallback
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

// Global persistent state
window._currentAudio = null;
window._currentAudioSource = null;
window._currentUtterance = null;
window._persistentAudio = (typeof window !== "undefined") ? new Audio() : null;
window._audioUnlocked = false;

let activeWakeWordRecognition = null;
let activeListeningRecognition = null;
let isSpeakingState = false;
let isRecordingState = false;
let activeMediaRecorder = null;
let recordedChunks = [];
let recordingTimeout = null;
let listeningTimeout = null;
let speakingSafetyTimer = null;

let vadAudioCtx = null;
let vadAnalyser = null;
let vadCheckInterval = null;

let inBrowserKokoroInstance = null;
let inBrowserKokoroLoading = false;
let isLocalBackendActiveCache = null;

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

function updateResponseTextUI(text) {
  if (typeof document === "undefined") return;

  const selectors = ['#subtitle-box', '#response-text', '.subtitle-text', '.welcome-text'];
  let updated = false;

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      el.textContent = text;
      updated = true;
      break;
    }
  }

  if (!updated) {
    const allDivs = document.querySelectorAll('div, p, span');
    for (const div of allDivs) {
      if (div.children.length === 0 && div.textContent && (div.textContent.includes('Welcome to Tati') || div.textContent.includes('I captured your query') || div.textContent.includes('Say Hey Tati'))) {
        div.textContent = text;
        break;
      }
    }
  }
}

function updateStatusUI(statusText, visualState = '') {
  const statusLabel = document.getElementById('status-label') || document.querySelector('.status-text');
  const orb = document.getElementById('orb-button') || document.querySelector('.orb-container');

  if (statusLabel) statusLabel.textContent = statusText;
  if (orb && visualState) {
    orb.setAttribute('data-state', visualState);
  }
}

// --- In-Browser Kokoro Loader with 45s Initial Download Allowance ---
async function getInBrowserKokoroWithTimeout(timeoutMs = 45000) {
  if (inBrowserKokoroInstance) return inBrowserKokoroInstance;
  
  if (inBrowserKokoroLoading) {
    let checkCount = 0;
    while (inBrowserKokoroLoading && checkCount < 150) {
      await new Promise(r => setTimeout(r, 200));
      if (inBrowserKokoroInstance) return inBrowserKokoroInstance;
      checkCount++;
    }
  }

  inBrowserKokoroLoading = true;
  updateStatusUI("DOWNLOADING KOKORO (45MB)...", "thinking");

  const loadPromise = (async () => {
    console.log("⚡ Fetching Kokoro ONNX model weights into browser storage...");
    const { KokoroTTS } = await import("https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm");
    const tts = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-ONNX",
      { dtype: "q4", device: "wasm" }
    );
    inBrowserKokoroInstance = tts;
    inBrowserKokoroLoading = false;
    return tts;
  })();

  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error("Kokoro ONNX download timed out")), timeoutMs)
  );

  try {
    return await Promise.race([loadPromise, timeoutPromise]);
  } catch (err) {
    inBrowserKokoroLoading = false;
    console.warn("⚠️ Kokoro ONNX load failed or timed out:", err.message);
    throw err;
  }
}

// --- HTTPS Mixed Content Backend Guard ---
async function isLocalBackendAlive() {
  if (typeof window !== "undefined" && window.location.protocol === "https:" && (!API_BASE_URL || API_BASE_URL.startsWith("http://"))) {
    isLocalBackendActiveCache = false;
    return false;
  }

  if (isLocalBackendActiveCache !== null) return isLocalBackendActiveCache;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300);
    const res = await fetch(`${API_BASE_URL}/`, { 
      method: "GET", 
      headers: { "Bypass-Tunnel-Reminder": "true" },
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    isLocalBackendActiveCache = res.ok;
    return res.ok;
  } catch (e) {
    isLocalBackendActiveCache = false;
    return false;
  }
}

export function hideWelcomeModal() {
  const initOverlay = document.getElementById('init-overlay');
  if (initOverlay) initOverlay.style.setProperty('display', 'none', 'important');

  const selectors = ['#welcome-overlay', '#welcome-modal', '.welcome-modal'];
  selectors.forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.setProperty('display', 'none', 'important');
  });
}

export function prewarmAudio() {
  if (typeof window === "undefined") return;

  try {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (AudioCtxClass) {
      if (!window._audioCtx) window._audioCtx = new AudioCtxClass();
      if (window._audioCtx.state === 'suspended') {
        window._audioCtx.resume();
      }
    }
  } catch (e) {}

  if (window._persistentAudio && !window._audioUnlocked) {
    try {
      window._persistentAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
      const playPromise = window._persistentAudio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          window._persistentAudio.pause();
          window._audioUnlocked = true;
        }).catch(() => {});
      }
    } catch (e) {}
  }
}

export function stopAudioPlayback() {
  isSpeakingState = false;

  if (speakingSafetyTimer) {
    clearTimeout(speakingSafetyTimer);
    speakingSafetyTimer = null;
  }

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
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
}

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
        stopWakeWordListener();
        updateStatusUI("TAP ORB TO TALK", "idle");
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
    updateStatusUI("LISTENING", "listening");

    return { stop: stopWakeWordListener };
  } catch (err) {
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

export function stopLocalWhisperRecording() {
  cleanupVAD();
  if (activeMediaRecorder && activeMediaRecorder.state === "recording") {
    if (recordingTimeout) clearTimeout(recordingTimeout);
    try { activeMediaRecorder.requestData(); } catch (e) {}
    activeMediaRecorder.stop();
    return true;
  }
  return false;
}

async function startLocalWhisperRecording(onResultCallback, onErrorCallback) {
  if (stopLocalWhisperRecording()) return;

  const backendAvailable = await isLocalBackendAlive();

  if (!backendAvailable) {
    if (onErrorCallback) onErrorCallback("Online mode requires Web Speech API supported browser.");
    updateStatusUI("SPEECH NOT SUPPORTED", "error");
    return;
  }

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

    vadCheckInterval = setInterval(() => {
      if (!isRecordingState || !vadAnalyser) return;
      
      vadAnalyser.getFloatTimeDomainData(timeDomainData);
      let sumSquares = 0;
      for (let i = 0; i < timeDomainData.length; i++) {
        sumSquares += timeDomainData[i] * timeDomainData[i];
      }
      const rms = Math.sqrt(sumSquares / timeDomainData.length);

      if (rms > 0.025) {
        if (!speechDetected) {
          speechDetected = true;
          updateStatusUI("RECORDING SPEECH...", "listening");
        }
        silenceStart = null;
      } else if (speechDetected) {
        if (!silenceStart) {
          silenceStart = Date.now();
        } else if (Date.now() - silenceStart > 800) {
          stopLocalWhisperRecording();
        }
      }
    }, 40);

    activeMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    activeMediaRecorder.onstop = async () => {
      isRecordingState = false;
      cleanupVAD();
      if (recordingTimeout) clearTimeout(recordingTimeout);
      stream.getTracks().forEach(t => t.stop());

      if (recordedChunks.length === 0) {
        updateStatusUI("NO AUDIO DETECTED", "idle");
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

        if (!response.ok) throw new Error(`Offline STT Status ${response.status}`);

        const data = await response.json();
        if (data.transcript && data.transcript.trim()) {
          if (onResultCallback) onResultCallback(data.transcript);
        } else {
          if (onErrorCallback) onErrorCallback("No speech detected.");
          updateStatusUI("NO SPEECH DETECTED", "idle");
        }
      } catch (err) {
        if (onErrorCallback) onErrorCallback("Offline STT failed.");
        updateStatusUI("STT ERROR", "error");
      }
    };

    activeMediaRecorder.start(100);
    recordingTimeout = setTimeout(() => stopLocalWhisperRecording(), 10000);

  } catch (err) {
    isRecordingState = false;
    cleanupVAD();
    if (onErrorCallback) onErrorCallback("Microphone permission required.");
    updateStatusUI("MIC ERROR", "error");
  }
}

export function listenToVoice(onResultCallback, onErrorCallback, lang = "en-US") {
  // Toggle off if already actively recording/listening
  if (isRecordingState || activeListeningRecognition) {
    if (listeningTimeout) clearTimeout(listeningTimeout);
    if (activeListeningRecognition) {
      try { activeListeningRecognition.stop(); } catch (e) {}
      activeListeningRecognition = null;
    }
    stopLocalWhisperRecording();
    isRecordingState = false;
    updateStatusUI("READY", "idle");
    return { start: () => {}, stop: () => {} };
  }

  stopAudioPlayback();
  stopWakeWordListener();
  prewarmAudio();

  const localStop = () => stopLocalWhisperRecording();

  if (!navigator.onLine || !SpeechRecognition) {
    startLocalWhisperRecording(onResultCallback, onErrorCallback);
    return { start: () => {}, stop: localStop };
  }

  try {
    isRecordingState = true;
    updateStatusUI("LISTENING...", "listening");

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = lang;

    activeListeningRecognition = recognition;

    // 7-Second Safety Timeout Guard to prevent hanging on "LISTENING..."
    listeningTimeout = setTimeout(() => {
      if (isRecordingState && activeListeningRecognition === recognition) {
        console.warn("⚠️ Speech recognition safety timeout triggered.");
        try { recognition.stop(); } catch (e) {}
        activeListeningRecognition = null;
        isRecordingState = false;
        updateStatusUI("NO SPEECH DETECTED", "idle");
        setTimeout(() => updateStatusUI("READY", "idle"), 1500);
      }
    }, 7000);

    recognition.onresult = (event) => {
      if (listeningTimeout) clearTimeout(listeningTimeout);
      isRecordingState = false;
      activeListeningRecognition = null;
      const transcript = event.results[0][0].transcript;
      if (onResultCallback) onResultCallback(transcript);
    };

    recognition.onerror = () => {
      if (listeningTimeout) clearTimeout(listeningTimeout);
      activeListeningRecognition = null;
      startLocalWhisperRecording(onResultCallback, onErrorCallback);
    };

    recognition.onend = () => {
      if (listeningTimeout) clearTimeout(listeningTimeout);
      if (isRecordingState && activeListeningRecognition === recognition) {
        isRecordingState = false;
        activeListeningRecognition = null;
        updateStatusUI("READY", "idle");
      }
    };

    recognition.start();

    return {
      start: () => { try { recognition.start(); } catch (e) {} },
      stop: () => { 
        if (listeningTimeout) clearTimeout(listeningTimeout);
        try { recognition.stop(); } catch (e) {} 
        activeListeningRecognition = null;
        isRecordingState = false;
        stopLocalWhisperRecording();
        updateStatusUI("READY", "idle");
      }
    };
  } catch (e) {
    if (listeningTimeout) clearTimeout(listeningTimeout);
    activeListeningRecognition = null;
    startLocalWhisperRecording(onResultCallback, onErrorCallback);
    return { start: () => {}, stop: localStop };
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

  utterance.onend = () => { 
    isSpeakingState = false;
    updateStatusUI("READY", "idle");
    if (onEndCallback) onEndCallback(); 
  };
  utterance.onerror = () => { 
    isSpeakingState = false;
    updateStatusUI("READY", "idle");
    if (onEndCallback) onEndCallback(); 
  };

  window._currentUtterance = utterance;
  isSpeakingState = true;
  updateStatusUI("TATI SPEAKING", "speaking");
  window.speechSynthesis.speak(utterance);
}

// --- Fail-Safe Speech Output Pipeline ---
export async function speakResponse(
  text, 
  onEndCallback = null, 
  preferredVoiceName = "af_heart", 
  lang = "en-US",
  rate = 1.0
) {
  stopAudioPlayback();
  stopWakeWordListener();
  prewarmAudio();

  updateResponseTextUI(text);
  updateStatusUI("SYNTHESIZING VOICE...", "thinking");

  const handleSpeechCompletion = () => {
    if (speakingSafetyTimer) {
      clearTimeout(speakingSafetyTimer);
      speakingSafetyTimer = null;
    }
    isSpeakingState = false;
    updateStatusUI("READY", "idle");
    if (onEndCallback) {
      onEndCallback();
    } else {
      startWakeWordListener();
    }
  };

  speakingSafetyTimer = setTimeout(() => {
    if (isSpeakingState) {
      console.warn("⚠️ Audio playback timer safety reset triggered.");
      handleSpeechCompletion();
    }
  }, 12000);

  const backendAvailable = await isLocalBackendAlive();

  // 1. LOCAL MAC BACKEND MODE: Python FastAPI Kokoro-82M
  if (backendAvailable) {
    try {
      const kokoroVoice = mapVoiceToKokoro(preferredVoiceName);
      const response = await fetch(`${API_BASE_URL}/api/tts`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Bypass-Tunnel-Reminder": "true"
        },
        body: JSON.stringify({ text, voice: kokoroVoice, speed: rate }),
      });

      if (!response.ok) throw new Error(`Kokoro server status ${response.status}`);

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();

      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!window._audioCtx) window._audioCtx = new AudioCtxClass();
      if (window._audioCtx.state === 'suspended') await window._audioCtx.resume();

      const audioBuffer = await window._audioCtx.decodeAudioData(arrayBuffer);
      const source = window._audioCtx.createBufferSource();
      source.buffer = audioBuffer;

      const gainNode = window._audioCtx.createGain();
      gainNode.gain.value = 1.6;

      source.connect(gainNode);
      gainNode.connect(window._audioCtx.destination);
      window._currentAudioSource = source;

      source.onended = () => {
        window._currentAudioSource = null;
        handleSpeechCompletion();
      };

      isSpeakingState = true;
      updateStatusUI("TATI SPEAKING", "speaking");
      source.start(0);
      return;
    } catch (error) {
      console.warn("⚠️ Local Kokoro backend unreachable. Trying Browser Kokoro ONNX...", error);
    }
  }

  // 2. VERCEL ONLINE / LAPTOP-OFF MODE: In-Browser Kokoro ONNX
  try {
    const tts = await getInBrowserKokoroWithTimeout(45000);
    const kokoroVoice = mapVoiceToKokoro(preferredVoiceName);
    
    const audioResult = await tts.generate(text, { voice: kokoroVoice });
    
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!window._audioCtx) window._audioCtx = new AudioCtxClass();
    if (window._audioCtx.state === 'suspended') await window._audioCtx.resume();

    const sampleRate = audioResult.sampling_rate || 24000;
    const buffer = window._audioCtx.createBuffer(1, audioResult.audio.length, sampleRate);
    buffer.getChannelData(0).set(audioResult.audio);

    const source = window._audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(window._audioCtx.destination);
    window._currentAudioSource = source;

    source.onended = () => {
      window._currentAudioSource = null;
      handleSpeechCompletion();
    };

    isSpeakingState = true;
    updateStatusUI("TATI SPEAKING", "speaking");
    source.start(0);

  } catch (browserKokoroErr) {
    console.warn("❌ Browser Kokoro ONNX fallback to native browser speech:", browserKokoroErr.message);
    fallbackWebSpeech(text, handleSpeechCompletion, lang, rate);
  }
}

// --- Dual-Engine LLM Query Pipeline ---
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
  updateResponseTextUI(`" ${transcript.trim()} "`);

  const backendAvailable = await isLocalBackendAlive();

  // 1. LOCAL MODE (Laptop Open): FastAPI -> Ollama
  if (backendAvailable) {
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

      if (response.ok) {
        const data = await response.json();
        const responseText = data.response_text || data.response || data.reply || "";
        if (autoSpeak && responseText) {
          speakResponse(responseText, null, preferredVoiceName, lang, rate);
        }
        return {
          responseText: responseText,
          databaseHits: data.database_hits || 0,
          hits: data.hits || [],
          provider: data.provider || "ollama_local"
        };
      }
    } catch (err) {
      console.warn("⚠️ Local chat endpoint unreachable, using Vercel serverless cloud...");
    }
  }

  // 2. ONLINE MODE (Vercel Cloud): Route query via Vercel Serverless Function `/api/chat`
  try {
    const cloudRes = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: transcript.trim() })
    });

    if (!cloudRes.ok) {
      const errJson = await cloudRes.json().catch(() => ({}));
      throw new Error(errJson.error || `Vercel Cloud Chat status ${cloudRes.status}`);
    }

    const cloudData = await cloudRes.json();
    const responseText = cloudData.response_text || "No response received.";

    if (autoSpeak && responseText) {
      speakResponse(responseText, null, preferredVoiceName, lang, rate);
    }

    return {
      responseText: responseText,
      databaseHits: 0,
      hits: [],
      provider: cloudData.provider || "groq_vercel_cloud"
    };

  } catch (error) {
    console.error("Online Query error:", error);
    updateStatusUI("ERROR OCCURRED", "error");
    updateResponseTextUI(`Error: ${error.message}`);
    setTimeout(() => updateStatusUI("READY", "idle"), 3000);
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
    } catch (e) {}
  }

  speakResponse(
    "Welcome to Tati Voice AI Console. Say Hey Tati or tap the orb to begin."
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

        if (isRecordingState) {
          stopLocalWhisperRecording();
        } else {
          listenToVoice((transcript) => {
            sendVoiceQuery(transcript);
          });
        }
      });
    }
  });
}