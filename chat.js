// Complete production-ready chat.js for Tati Voice AI Platform
// Integrates LocalTunnel bypass headers, iOS Audio Context unlocks, native mic prompt triggers, and speech synthesis fallback.

const BACKEND_URL = 'https://tati-voice-ai-backend.loca.lt';

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let recognition = null;
let isProcessing = false;

// 1. iOS Audio Context Unlocker (Must be called on direct user interaction)
function unlockIOSAudio() {
    if (!audioCtx) {
        audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    try {
        const buffer = audioCtx.createBuffer(1, 1, 22050);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } catch (e) {
        console.log("Audio unlock buffer execution:", e);
    }
}

// 2. Explicit User-Gesture Microphone Permission Trigger for Mobile Safari
async function requestMobileMicrophone() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Instantly release tracks so Web Speech API can take control of hardware microphone
        stream.getTracks().forEach(track => track.stop());
        return true;
    } catch (err) {
        console.error("Microphone Access Error:", err);
        alert("Microphone access is required. Please check your browser or iOS Safari permission settings.");
        return false;
    }
}

// 3. UI State Updater
function updateUI(statusText, visualState = '') {
    const statusLabel = document.getElementById('status-label') || document.querySelector('.status-text');
    const orb = document.getElementById('orb-button') || document.querySelector('.orb-container');

    if (statusLabel) statusLabel.textContent = statusText;
    if (orb && visualState) {
        orb.setAttribute('data-state', visualState);
    }
}

// 4. Web Speech Synthesis Fallback (Used if Local Kokoro TTS is unavailable)
function speakFallback(text, onComplete) {
    if (!('speechSynthesis' in window)) {
        if (onComplete) onComplete();
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => {
        if (onComplete) onComplete();
    };
    utterance.onerror = (err) => {
        console.error("SpeechSynthesis error:", err);
        if (onComplete) onComplete();
    };
    window.speechSynthesis.speak(utterance);
}

// 5. End-to-End Pipeline Handler
async function sendVoiceQuery(queryText) {
    if (isProcessing) return;
    isProcessing = true;

    unlockIOSAudio();
    updateUI("THINKING...", "thinking");

    // Pause listener on mobile/desktop so audio output hardware line is clear
    if (recognition) {
        try { recognition.stop(); } catch (e) {}
    }

    const resumeListener = () => {
        isProcessing = false;
        updateUI("LISTENING", "listening");
        if (recognition) {
            try { recognition.start(); } catch (e) {}
        }
    };

    try {
        console.log("Sending query to backend:", queryText);

        // Fetch LLM inference response with bypass header for LocalTunnel
        const chatResponse = await fetch(`${BACKEND_URL}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'bypass-tunnel-reminder': 'true'
            },
            body: JSON.stringify({ prompt: queryText })
        });

        if (!chatResponse.ok) {
            throw new Error(`Chat HTTP Error: ${chatResponse.status}`);
        }

        const chatData = await chatResponse.json();
        const replyText = chatData.response || chatData.reply || "No response received.";
        console.log("LLM Response received:", replyText);

        updateUI("TATI SPEAKING", "speaking");

        // Fetch Kokoro TTS synthesized audio stream
        try {
            const ttsResponse = await fetch(`${BACKEND_URL}/api/tts`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'bypass-tunnel-reminder': 'true'
                },
                body: JSON.stringify({ text: replyText })
            });

            if (!ttsResponse.ok) {
                throw new Error(`TTS HTTP Error: ${ttsResponse.status}`);
            }

            const audioBlob = await ttsResponse.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);

            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                resumeListener();
            };

            audio.onerror = (err) => {
                console.warn("Kokoro audio playback failed, triggering browser TTS fallback:", err);
                speakFallback(replyText, resumeListener);
            };

            await audio.play();

        } catch (ttsErr) {
            console.warn("TTS backend fetch failed, falling back to Web Speech:", ttsErr);
            speakFallback(replyText, resumeListener);
        }

    } catch (err) {
        console.error("Pipeline query error:", err);
        updateUI("ERROR OCCURRED", "error");
        speakFallback("Sorry, I could not reach the host backend.", resumeListener);
    }
}

// 6. Speech Recognition Listener & Wake Word Initialization
function initSpeechRecognition() {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
        console.warn("Web Speech Recognition API is not supported in this browser context.");
        updateUI("SPEECH API UNSUPPORTED", "error");
        return;
    }

    recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        console.log('Voice-to-Wake active. Listening for "Hey Tati"...');
        if (!isProcessing) updateUI("LISTENING", "listening");
    };

    recognition.onresult = (event) => {
        if (isProcessing) return;

        const lastIndex = event.results.length - 1;
        const transcript = event.results[lastIndex][0].transcript.trim().toLowerCase();
        console.log("Speech input captured:", transcript);

        if (transcript.includes("hey tati") || transcript.includes("tati")) {
            console.log("⚡ Wake word detected:", transcript);
            const queryText = transcript.replace(/.*(?:hey tati|tati)/i, '').trim();

            if (queryText.length > 0) {
                sendVoiceQuery(queryText);
            } else {
                updateUI("SAY YOUR QUERY...", "listening");
            }
        } else if (transcript.length > 2) {
            sendVoiceQuery(transcript);
        }
    };

    recognition.onerror = (event) => {
        console.warn("Speech listener event error:", event.error);
        if (event.error === 'not-allowed') {
            updateUI("MIC PERMISSION DENIED", "error");
        }
    };

    recognition.onend = () => {
        if (!isProcessing) {
            try { recognition.start(); } catch (e) {}
        }
    };
}

// 7. Event Attachment
document.addEventListener('DOMContentLoaded', () => {
    const orbButton = document.getElementById('orb-button') || document.querySelector('.orb-container');

    // Attach unlock handlers across touch and click interactions
    document.addEventListener('touchstart', unlockIOSAudio, { passive: true });
    document.addEventListener('click', unlockIOSAudio, { passive: true });

    initSpeechRecognition();

    if (orbButton) {
        orbButton.addEventListener('click', async () => {
            unlockIOSAudio();
            const micGranted = await requestMobileMicrophone();

            if (micGranted) {
                if (recognition) {
                    try {
                        recognition.start();
                    } catch (e) {
                        console.log("Recognition session already running:", e);
                    }
                } else {
                    initSpeechRecognition();
                }
            }
        });
    }
});