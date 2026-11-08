// Dynamic Base URL: Prioritizes environment variables (Vercel/Next.js/CRA), 
// falling back to your current active Cloudflare Tunnel endpoint.
const API_BASE_URL = 
  (typeof process !== "undefined" && process.env && (process.env.NEXT_PUBLIC_API_URL || process.env.REACT_APP_API_URL)) ||
  "https://goat-tsunami-give-putting.trycloudflare.com";

// Initialize browser Speech Recognition (Web Speech API)
const SpeechRecognition = 
  typeof window !== "undefined" && 
  (window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * 1. Web Speech API - Text-to-Speech (Voice Output)
 * Speaks the response back to the user via browser speech synthesis.
 * @param {string} text - The response text to synthesize into speech.
 */
export function speakResponse(text) {
  if (typeof window === "undefined" || !('speechSynthesis' in window)) {
    console.warn("Text-to-speech is not supported in this browser environment.");
    return;
  }

  // Cancel any active speech output before starting a new utterance
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.lang = 'en-US';

  window.speechSynthesis.speak(utterance);
}

/**
 * 2. Web Speech API - Speech-to-Text Listener
 * Captures user speech via microphone and converts it to text.
 * @param {Function} onResultCallback - Called with the transcribed text string.
 * @param {Function} onErrorCallback - Called if speech recognition encounters an error.
 * @returns {Object|null} Control object with start() and stop() methods, or null if unsupported.
 */
export function listenToVoice(onResultCallback, onErrorCallback) {
  if (!SpeechRecognition) {
    const errorMsg = "Speech recognition is not supported in this browser.";
    console.warn(errorMsg);
    if (onErrorCallback) onErrorCallback(errorMsg);
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

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
 * 3. Voice RAG Pipeline Request
 * Sends transcribed voice input to your FastAPI backend via Cloudflare Tunnel.
 * @param {string} transcript - The user's spoken or typed transcript query.
 * @param {boolean} autoSpeak - Whether to automatically trigger TTS for the LLM answer.
 * @returns {Promise<Object>} Server response object containing responseText and databaseHits.
 */
export async function sendVoiceQuery(transcript, autoSpeak = true) {
  if (!transcript || !transcript.trim()) {
    throw new Error("Voice transcript cannot be empty.");
  }

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

    // Automatically speak Llama 3's synthesized answer if autoSpeak is enabled
    if (autoSpeak && data.response_text) {
      speakResponse(data.response_text);
    }

    return {
      responseText: data.response_text,
      databaseHits: data.database_hits,
    };
  } catch (error) {
    console.error("Error connecting to Tati Voice RAG Backend:", error);
    throw error;
  }
}

/**
 * 4. Raw Database Search Request
 * Queries Meilisearch index directly via FastAPI /search endpoint.
 * @param {string} query - The search query term.
 * @param {number} limit - Maximum number of matching records to retrieve.
 * @returns {Promise<Object>} Raw JSON search results from Meilisearch.
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