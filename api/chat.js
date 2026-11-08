// Dynamic Base URL Resolution:
// Uses localhost:8000 when developing locally on localhost:3000, 
// or falls back to Cloudflare Tunnel / Vercel Environment Variables in production.
const getBaseUrl = () => {
  if (typeof process !== "undefined" && process.env) {
    if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
    if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
  }
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return "http://localhost:8000";
  }
  return "https://goat-tsunami-give-putting.trycloudflare.com";
};

const API_BASE_URL = getBaseUrl();

// Initialize Speech Recognition API across browsers
const SpeechRecognition = 
  typeof window !== "undefined" && 
  (window.SpeechRecognition || window.webkitSpeechRecognition);

// Prevent Chrome Garbage Collection from dropping audio mid-speech
window._currentUtterance = null;

/**
 * Pre-warms browser audio context synchronously on user interaction
 */
export function prewarmAudio() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.resume();
    const silent = new SpeechSynthesisUtterance("");
    window.speechSynthesis.speak(silent);
  }
}

/**
 * Web Speech API - Native Browser Text-to-Speech
 * @param {string} text - Response text to speak
 */
export function speakResponse(text) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    console.warn("Text-to-speech is not supported in this browser.");
    return;
  }

  // Clear existing queue and unpause engine
  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();

  const speak = () => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.lang = "en-US";

    // Set voice if available
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      utterance.voice = voices.find((v) => v.lang.includes("en")) || voices[0];
    }

    utterance.onstart = () => console.log("🔊 Tati Voice AI is speaking...");
    utterance.onend = () => console.log("✅ Speech playback finished.");
    utterance.onerror = (e) => console.error("❌ Audio synthesis error:", e);

    // Retain global reference
    window._currentUtterance = utterance;
    window.speechSynthesis.speak(utterance);
  };

  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.onvoiceschanged = speak;
  } else {
    speak();
  }
}

/**
 * Web Speech API - Speech-to-Text Recognition
 * @param {Function} onResultCallback - Receives transcribed text
 * @param {Function} onErrorCallback - Receives recognition error
 */
export function listenToVoice(onResultCallback, onErrorCallback) {
  if (!SpeechRecognition) {
    const errorMsg = "Speech recognition is not supported in this browser.";
    console.warn(errorMsg);
    if (onErrorCallback) onErrorCallback(errorMsg);
    return null;
  }

  prewarmAudio();

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    if (onResultCallback) onResultCallback(transcript);
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    if (onErrorCallback) onErrorCallback(event.error);
  };

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
  };
}

/**
 * Sends spoken query to FastAPI RAG backend (/api/chat)
 * @param {string} transcript - Spoken user query
 * @param {boolean} autoSpeak - Automatically trigger TTS upon response
 */
export async function sendVoiceQuery(transcript, autoSpeak = true) {
  if (!transcript || !transcript.trim()) {
    throw new Error("Voice transcript cannot be empty.");
  }

  if (autoSpeak) prewarmAudio();

  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transcript: transcript.trim(),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `Server error with status code ${response.status}`);
    }

    const data = await response.json();

    if (autoSpeak && data.response_text) {
      speakResponse(data.response_text);
    }

    return {
      responseText: data.response_text,
      databaseHits: data.database_hits,
      hits: data.hits || [],
    };
  } catch (error) {
    console.error("Error connecting to Tati RAG Voice Backend:", error);
    throw error;
  }
}

/**
 * Direct Meilisearch search helper
 */
export async function searchAcademicRecords(query, limit = 20) {
  if (!query || !query.trim()) {
    throw new Error("Search query cannot be empty.");
  }

  try {
    const response = await fetch(`${API_BASE_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query.trim(),
        limit: limit,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `Search failed with status code ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error querying academic database:", error);
    throw error;
  }
}