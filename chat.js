/**
 * Tati Voice AI Platform - chat.js
 * Kokoro-82M Local Neural TTS + Voice-to-Wake ("Hey Tati") + Web Speech API
 */

const getBaseUrl = () => {
  if (typeof process !== "undefined" && process.env) {
    if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
    if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
  }
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return "http://localhost:8000";
  }
  // Updated with the new Cloudflare Quick Tunnel URL
  return "https://jake-genuine-indirect-minus.trycloudflare.com"; 
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

window._currentAudio = null;
window._currentUtterance = null;
let activeWakeWordRecognition = null;

export function prewarmAudio() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.resume();
    const silent = new SpeechSynthesisUtterance("");
    window.speechSynthesis.speak(silent);
  }
}

export function stopAudioPlayback() {
  if (window._currentAudio) {
    window._currentAudio.pause();
    window._currentAudio.currentTime = 0;
    window._currentAudio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Background Voice-to-Wake Listener ("Hey Tati" / "Tati")
 */
export function startWakeWordListener(onWakeCallback, targetWord = "tati", lang = "en-US") {
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
          if (onWakeCallback) onWakeCallback(transcript);
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

export async function speakResponse(
  text, 
  onEndCallback = null, 
  preferredVoiceName = "af_heart", 
  lang = "en-US",
  rate = 1.0
) {
  stopAudioPlayback();
  stopWakeWordListener();

  const kokoroVoice = mapVoiceToKokoro(preferredVoiceName);

  try {
    const response = await fetch(`${API_BASE_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      if (onEndCallback) onEndCallback();
    };

    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      window._currentAudio = null;
      fallbackWebSpeech(text, onEndCallback, lang, rate);
    };

    await audio.play();
  } catch (error) {
    console.warn("⚠️ Falling back to Web Speech synthesis:", error);
    fallbackWebSpeech(text, onEndCallback, lang, rate);
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

export async function sendVoiceQuery(transcript, autoSpeak = true, preferredVoiceName = "af_heart", lang = "en-US", rate = 1.0) {
  if (!transcript || !transcript.trim()) {
    throw new Error("Voice transcript cannot be empty.");
  }

  if (autoSpeak) prewarmAudio();

  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcript.trim(), language: lang }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `Server error code ${response.status}`);
    }

    const data = await response.json();

    if (autoSpeak && data.response_text) {
      speakResponse(data.response_text, null, preferredVoiceName, lang, rate);
    }

    return {
      responseText: data.response_text,
      databaseHits: data.database_hits,
      hits: data.hits || [],
    };
  } catch (error) {
    console.error("Error connecting to Tati Backend:", error);
    throw error;
  }
}